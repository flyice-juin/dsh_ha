/**
 * dsh-ha-bridge — a small, stable HTTP surface over the DeepSeek Harness
 * Session API so a Home Assistant custom integration can read sessions and
 * drive them from the LAN.
 *
 * Why this exists instead of reusing the Web GUI transport:
 * the browser carrier authenticates with a per-process launch token
 * (`?token=` -> `HttpOnly; SameSite=Strict` cookie), so the token changes on
 * every Harness restart and a cross-site iframe never receives the cookie.
 * This plugin therefore owns its own listener and its own long-lived bearer
 * token, and translates a deliberately small JSON contract into
 * `ctx.sessionController` calls. The Harness-side shapes stay in here; Home
 * Assistant only ever sees the contract documented below.
 *
 * Where the token comes from, in order:
 *   1. `config.token` — an explicit value in this row's cordis.patch.yml
 *      (backwards compatible; the setup page then only displays it);
 *   2. the token persisted by a previous run, under `$DSH_HOME/ha-bridge/
 *      state.json` (override with `$DSH_HA_BRIDGE_STATE`);
 *   3. a freshly generated 128-bit value, persisted before the listener binds,
 *      so installing this plugin produces a unique secret per machine and the
 *      package itself never carries one.
 *
 * The token is shown to the person at the keyboard by a setup page that only
 * answers loopback requests:
 *   GET  /                    HTML page: token, copy buttons, HA snippet
 *   GET  /setup/token         the token as text/plain (curl friendly)
 *   POST /setup/rotate        generate and persist a new token
 *
 * Endpoints (all JSON, all require `Authorization: Bearer <token>`):
 *   GET  /api/health
 *   GET  /api/sessions
 *   GET  /api/sessions/{id}
 *   GET  /api/sessions/{id}/messages?maxMessages=20
 *   POST /api/sessions/{id}/prompt   { text, mode?: 'queue'|'steer' }
 *   POST /api/sessions/{id}/cancel
 *   POST /api/sessions/{id}/wait     { timeoutMs?, maxMessages?, afterSeq? }
 *
 * @module dsh-ha-bridge
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'ha-bridge'
/** Services required before the listener may bind. */
export const inject = ['sessionController']

const VERSION = 3

const DEFAULTS = {
  host: '0.0.0.0',
  port: 43130,
  token: '',
  timeZone: 'Asia/Shanghai',
  maxSessions: 40,
  maxBodyBytes: 1024 * 1024,
  setupPage: true,
}

/** Records read per requested message, so a tool-heavy tail still yields rows. */
const RECORDS_PER_MESSAGE = 8

/** One HTTP error carrying the status and the machine-readable code. */
class BridgeError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function sendText(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Constant-time bearer check; a missing header is just a failed check. */
function authorized(request, token) {
  const header = request.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const given = Buffer.from(header.slice('Bearer '.length).trim(), 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

async function readJson(request, limit) {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new BridgeError(415, 'unsupported-media-type', 'content type must be application/json')
  }
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new BridgeError(413, 'body-too-large', 'request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BridgeError(400, 'invalid-json', 'request body is not JSON')
  }
}

// ---------------------------------------------------------------------------
// Token state: one file per machine, outside the package.
// ---------------------------------------------------------------------------

/** Where the persisted token lives, honouring an explicit override. */
function statePath() {
  const explicit = process.env.DSH_HA_BRIDGE_STATE?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = process.env.DSH_HOME?.trim()
  const root = home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
  return join(root, 'ha-bridge', 'state.json')
}

function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** Write through a sibling temp file so a crash cannot truncate the token. */
function writeState(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

function newToken() {
  return randomBytes(16).toString('hex')
}

/**
 * Pick the token for this process: configured, persisted, or minted now.
 * A configured token always wins so an existing installation keeps working.
 * Deliberately synchronous: this runs inside `apply`, before the listener
 * binds, so the token is known before any request can arrive.
 */
function resolveToken(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    return { token: configured.trim(), source: 'config', file: statePath() }
  }
  const file = statePath()
  const saved = readState(file)
  if (typeof saved.token === 'string' && saved.token.trim() !== '') {
    return { token: saved.token.trim(), source: 'file', file }
  }
  const token = newToken()
  writeState(file, { token, createdAt: new Date().toISOString(), plugin: 'dsh-ha-bridge' })
  return { token, source: 'generated', file }
}

/** Replace the token on disk and return the new value. */
function rotateToken(file) {
  const token = newToken()
  writeState(file, {
    ...readState(file),
    token,
    plugin: 'dsh-ha-bridge',
    rotatedAt: new Date().toISOString(),
  })
  return token
}

// ---------------------------------------------------------------------------
// Setup page: loopback only, because it displays the secret.
// ---------------------------------------------------------------------------

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** True when the request reached us without leaving the machine. */
function isLoopback(request) {
  if (request.headers['x-forwarded-for'] !== undefined) return false
  if (request.headers['forwarded'] !== undefined) return false
  const address = request.socket.remoteAddress
  return typeof address === 'string' && LOOPBACK.has(address)
}

/** LAN addresses this machine can be reached on, best candidates first. */
function lanAddresses() {
  const rows = []
  for (const [device, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      rows.push({ device, address: entry.address })
    }
  }
  const rank = (address) =>
    address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : address.startsWith('172.') ? 2 : 3
  return rows.sort((a, b) => rank(a.address) - rank(b.address))
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[character]
  })
}

const PAGE_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 28px 20px 48px; font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
       background: Canvas; color: CanvasText; }
main { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
h2 { margin: 0 0 8px; font-size: 14px; font-weight: 600; color: color-mix(in srgb, CanvasText 72%, Canvas); }
p { margin: 0; }
.card { border: 1px solid color-mix(in srgb, CanvasText 16%, Canvas); border-radius: 12px; padding: 16px; }
.muted { color: color-mix(in srgb, CanvasText 62%, Canvas); font-size: 13px; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 13px; }
.token { flex: 1 1 320px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, CanvasText 7%, Canvas);
         word-break: break-all; user-select: all; }
button { font: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer; white-space: nowrap;
         border: 1px solid color-mix(in srgb, CanvasText 22%, Canvas); background: Canvas; color: CanvasText; }
button:hover { background: color-mix(in srgb, CanvasText 8%, Canvas); }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.primary:hover { background: #1d4ed8; }
button:disabled { opacity: .5; cursor: not-allowed; }
table { border-collapse: collapse; width: 100%; }
td { padding: 6px 0; vertical-align: middle; }
td.key { width: 88px; color: color-mix(in srgb, CanvasText 62%, Canvas); }
pre { margin: 8px 0 0; padding: 10px; border-radius: 8px; background: color-mix(in srgb, CanvasText 7%, Canvas);
      white-space: pre-wrap; overflow-wrap: anywhere; }
.warn { border-left: 3px solid #d97706; padding-left: 12px; color: color-mix(in srgb, CanvasText 78%, Canvas); }
ol, ul { margin: 8px 0 0; padding-left: 22px; }
li { margin: 4px 0; }
code { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 13px; }
`

const PAGE_SCRIPT = `
const nonce = document.querySelector('meta[name="bridge-nonce"]').content;
function flash(button, text) {
  const before = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = before; }, 1200);
}
async function copyOf(id, button) {
  const element = document.getElementById(id);
  const text = element.dataset.value || element.textContent;
  try {
    await navigator.clipboard.writeText(text);
    flash(button, '已复制 / Copied');
    return;
  } catch (error) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    try { document.execCommand('copy'); flash(button, '已复制 / Copied'); }
    catch (ignored) { flash(button, '请手动复制 / Select + copy'); }
  }
}
async function rotate(button) {
  if (!window.confirm('生成新令牌后旧令牌立即失效，Home Assistant 里需要重新认证。继续？\\n\\nA new token invalidates the old one; re-authenticate the HA integration afterwards.')) return;
  button.disabled = true;
  try {
    const response = await fetch('setup/rotate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-nonce': nonce },
      body: '{"confirm":true}',
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || response.status);
    location.reload();
  } catch (error) {
    button.disabled = false;
    window.alert('生成失败 / Failed: ' + error.message);
  }
}
`

/**
 * Render the setup page. Everything is inline so the page works with no
 * assets, no build step, and no Home Assistant round trip.
 */
function renderSetupPage({ token, source, host, port, timeZone, nonce }) {
  const addresses = lanAddresses()
  const primary = addresses[0]?.address ?? '127.0.0.1'
  const otherAddresses = addresses.filter((row) => row.address !== primary)
  const sourceLabel =
    source === 'config'
      ? '来自插件配置 cordis.patch.yml（From the row config）'
      : source === 'file'
        ? '已保存到本机（Persisted on this machine）'
        : '本次启动新生成并已保存（Generated and persisted just now）'
  const curl = `curl -H "Authorization: Bearer ${token}" http://127.0.0.1:${port}/api/health`
  const rotateDisabled = source === 'config' ? ' disabled' : ''
  const rotateHint =
    source === 'config'
      ? `<p class="muted">令牌写在本插件的 <code>cordis.patch.yml</code> 里，插件不会覆盖它。想在这里轮换，请先删掉那一行 <code>token</code> 再重启 Harness。</p>`
      : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="bridge-nonce" content="${escapeHtml(nonce)}">
<title>DeepSeek Harness × Home Assistant</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
  <header>
    <h1>DeepSeek Harness × Home Assistant</h1>
    <p class="muted">桥接插件已启动 · Bridge is running on <code>${escapeHtml(host)}:${escapeHtml(port)}</code> · ${escapeHtml(timeZone)}</p>
  </header>

  <section class="card">
    <h2>令牌 Token</h2>
    <div class="row">
      <span class="token mono" id="token" data-value="${escapeHtml(token)}">${escapeHtml(token)}</span>
      <button type="button" onclick="copyOf('token', this)">复制 / Copy</button>
      <button type="button" class="primary" onclick="rotate(this)"${rotateDisabled}>生成新令牌 / Rotate</button>
    </div>
    <p class="muted" style="margin-top:8px">${escapeHtml(sourceLabel)}</p>
    ${rotateHint}
  </section>

  <section class="card">
    <h2>在 Home Assistant 里填这三项 / Add the integration</h2>
    <table>
      <tr>
        <td class="key">主机 Host</td>
        <td><span class="mono" id="host" data-value="${escapeHtml(primary)}">${escapeHtml(primary)}</span></td>
        <td style="width:1%"><button type="button" onclick="copyOf('host', this)">复制</button></td>
      </tr>
      <tr>
        <td class="key">端口 Port</td>
        <td><span class="mono" id="port" data-value="${escapeHtml(port)}">${escapeHtml(port)}</span></td>
        <td><button type="button" onclick="copyOf('port', this)">复制</button></td>
      </tr>
      <tr>
        <td class="key">令牌 Token</td>
        <td><span class="mono" id="token2" data-value="${escapeHtml(token)}">${escapeHtml(token)}</span></td>
        <td><button type="button" onclick="copyOf('token2', this)">复制</button></td>
      </tr>
    </table>
    <ol class="muted">
      <li>Home Assistant → 设置 → 设备与服务 → 添加集成 → 搜索 <b>DeepSeek Harness</b>。</li>
      <li>把上面三项填进去，提交即完成。</li>
      ${otherAddresses.length === 0 ? '' : `<li>这块网卡还有别的地址：${otherAddresses.map((row) => `<code>${escapeHtml(row.address)}</code>`).join('、')}（按 HA 所在网段挑一个）。</li>`}
    </ol>
  </section>

  <section class="card">
    <h2>自检 / Self-test</h2>
    <p class="muted">在这台电脑上执行，应返回 <code>{"ok":true,...}</code>：</p>
    <pre class="mono" id="curl" data-value="${escapeHtml(curl)}">${escapeHtml(curl)}</pre>
    <div class="row" style="margin-top:8px">
      <button type="button" onclick="copyOf('curl', this)">复制命令</button>
    </div>
  </section>

  <section class="card">
    <h2>安全 / Security</h2>
    <p class="warn">这个页面只在<strong>本机回环地址</strong>可访问，因为它在显示密钥。拿到令牌的人可以列出会话、下发指令、取消任务——等同于操作这台电脑上的 Harness。别把令牌贴到公开的地方，别把 ${escapeHtml(port)} 端口映射到公网。</p>
    <p class="muted" style="margin-top:8px">This page answers loopback requests only, because it shows the secret. Anyone holding the token can drive the Harness sessions on this computer.</p>
  </section>
</main>
<script>${PAGE_SCRIPT}</script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Session projection: the shapes Home Assistant sees.
// ---------------------------------------------------------------------------

/**
 * Join the visible text blocks of one message.
 *
 * Deliberately path-based, not a recursive scan: an `assistant/message` event
 * carries the same prose again inside `data.stream` (the replay buffer), so a
 * blanket walk over `data` duplicates every answer.
 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.trim()
    if (text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/** Project one wire event onto the message row Home Assistant displays. */
function toMessage(record) {
  if (record === null || typeof record !== 'object' || record.type !== 'event') return undefined
  const event = record.event
  if (event === null || typeof event !== 'object') return undefined
  const type = typeof event.type === 'string' ? event.type : ''
  const data = event.data ?? {}
  let role
  let text = ''
  if (type === 'user/message') {
    role = 'user'
    text = textOf(data.content)
  } else if (type === 'assistant/message') {
    role = 'assistant'
    text = textOf(data.message?.content)
  } else {
    return undefined
  }
  if (text === '') return undefined
  return {
    role,
    type,
    seq: typeof event.seq === 'number' ? event.seq : null,
    time: typeof event.time === 'number' ? event.time : null,
    text,
  }
}

/** Map records to messages, dropping consecutive duplicates of the same prose. */
function toMessages(records) {
  const messages = []
  for (const record of records ?? []) {
    const message = toMessage(record)
    if (message === undefined) continue
    const previous = messages[messages.length - 1]
    if (previous !== undefined && previous.text === message.text && previous.role === message.role) continue
    messages.push(message)
  }
  return messages
}

function numberParam(value, fallback, minimum, maximum) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.trunc(parsed), minimum), maximum)
}

function titleOf(summary) {
  const title = summary?.projections?.values?.title
  return typeof title === 'string' && title !== '' ? title : null
}

export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const sessions = ctx.sessionController

  /** Mutable so a rotation takes effect for the next request, not the next boot. */
  const state = resolveToken(options.token)
  const nonce = randomUUID()

  if (state.source === 'generated') {
    ctx.logger.info(
      `ha-bridge: generated a new token and saved it to ${state.file}; open http://127.0.0.1:${options.port}/ on this machine to read it`,
    )
  }

  /** Passive state is best effort: a closed or sleeping Session has none. */
  async function readState_(sessionId) {
    try {
      return await sessions.state({ sessionId }, AbortSignal.timeout(5000))
    } catch {
      return undefined
    }
  }

  function rowOf(summary, state_) {
    return {
      id: summary.sessionId,
      title: titleOf(summary),
      running: summary.running === true,
      active: state_?.active === true,
      blank: summary.blank === true,
      cwd: typeof summary.cwd === 'string' ? summary.cwd : null,
      updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : null,
      agentAvailable: summary.agentAvailable !== false,
      pendingInput: Array.isArray(state_?.pendingInput) ? state_.pendingInput : [],
      queued: Array.isArray(state_?.queue) ? state_.queue.length : 0,
    }
  }

  async function listSessions() {
    const value = await sessions.list({}, AbortSignal.timeout(15000))
    const items = (value?.items ?? []).slice(0, options.maxSessions)
    const rows = []
    for (const summary of items) {
      rows.push(rowOf(summary, await readState_(summary.sessionId)))
    }
    return rows
  }

  async function sessionDetail(sessionId) {
    const rows = await listSessions()
    const row = rows.find((item) => item.id === sessionId)
    if (row === undefined) throw new BridgeError(404, 'session-not-found', `unknown session ${sessionId}`)
    return row
  }

  /**
   * The latest page is record-aligned, not message-aligned: a session parked in
   * a tool loop can have a tail of `tool/result` records and no messages. Ask
   * for a wider record window, then keep the last `maxMessages` message rows.
   */
  async function readMessages(sessionId, maxMessages) {
    const page = await sessions.events(
      {
        address: { kind: 'session', sessionId },
        maxMessages: Math.min(Math.max(maxMessages * RECORDS_PER_MESSAGE, 40), 400),
      },
      AbortSignal.timeout(30000),
    )
    const messages = toMessages(page?.records)
    return {
      messages: messages.slice(-maxMessages),
      cursor: typeof page?.cursor === 'number' ? page.cursor : null,
    }
  }

  async function prompt(sessionId, body) {
    const text = typeof body.text === 'string' ? body.text : ''
    if (text.trim() === '') throw new BridgeError(400, 'empty-prompt', 'text must be a non-empty string')
    const mode = body.mode === 'steer' ? 'steer' : 'queue'
    await sessions.prompt(
      {
        requestId: randomUUID(),
        sessionId,
        mode,
        content: [{ type: 'text', text }],
        clientTimeZone: options.timeZone,
      },
      AbortSignal.timeout(30000),
    )
    return { accepted: true, sessionId, mode }
  }

  async function wait(sessionId, body) {
    // The timer API rejects 0; 1ms is the shortest usable "do not wait" ask.
    const timeoutMs = numberParam(body.timeoutMs, 60000, 1, 300000)
    const maxMessages = numberParam(body.maxMessages, 20, 1, 100)
    const request = { sessionId, timeoutMs, maxMessages }
    if (typeof body.afterSeq === 'number') request.afterSeq = body.afterSeq
    const value = await sessions.wait(request, AbortSignal.timeout(timeoutMs + 15000))
    return {
      reason: value?.reason ?? 'timeout',
      state: value?.state ?? null,
      messages: toMessages(value?.output?.records),
      truncated: value?.output?.truncated === true,
    }
  }

  /** The setup surface: never proxied, never reachable off the machine. */
  async function routeSetup(request, response, path) {
    if (options.setupPage === false) throw new BridgeError(404, 'not-found', 'the setup page is disabled')
    if (!isLoopback(request)) {
      sendText(
        response,
        403,
        'Setup page is loopback-only.\nOpen http://127.0.0.1:%d/ on the computer running DeepSeek Harness.\n'
          .replace('%d', options.port),
      )
      return
    }
    if (path === '/setup/token') {
      sendText(response, 200, `${state.token}\n`)
      return
    }
    if (path === '/setup/rotate') {
      if (request.method !== 'POST') throw new BridgeError(405, 'method-not-allowed', 'use POST')
      if (state.source === 'config') {
        throw new BridgeError(409, 'token-from-config', 'the token comes from cordis.patch.yml; edit it there')
      }
      if (request.headers['x-bridge-nonce'] !== nonce) {
        throw new BridgeError(403, 'bad-nonce', 'reload the setup page and try again')
      }
      await readJson(request, 64 * 1024)
      state.token = rotateToken(state.file)
      state.source = 'file'
      ctx.logger.info('ha-bridge: token rotated from the setup page')
      sendJson(response, 200, { ok: true, token: state.token })
      return
    }
    if (request.method !== 'GET') throw new BridgeError(405, 'method-not-allowed', 'use GET')
    sendText(
      response,
      200,
      renderSetupPage({
        token: state.token,
        source: state.source,
        host: options.host,
        port: options.port,
        timeZone: options.timeZone,
        nonce,
      }),
      'text/html; charset=utf-8',
    )
  }

  async function route(request, response) {
    const url = new URL(request.url ?? '/', 'http://bridge.invalid')
    const path = url.pathname

    if (path === '/' || path === '/setup' || path === '/setup/token' || path === '/setup/rotate') {
      await routeSetup(request, response, path === '/' ? '/setup' : path)
      return
    }

    if (!authorized(request, state.token)) {
      sendJson(response, 401, { error: 'unauthorized', message: 'missing or invalid bearer token' })
      return
    }

    const parts = path.split('/').filter((part) => part !== '')
    if (parts[0] !== 'api') throw new BridgeError(404, 'not-found', 'unknown route')

    if (parts.length === 2 && parts[1] === 'health') {
      sendJson(response, 200, { ok: true, name: 'dsh-ha-bridge', version: VERSION, timeZone: options.timeZone })
      return
    }
    if (parts.length === 2 && parts[1] === 'sessions') {
      if (request.method !== 'GET') throw new BridgeError(405, 'method-not-allowed', 'use GET')
      sendJson(response, 200, { sessions: await listSessions() })
      return
    }
    if (parts[1] !== 'sessions' || parts.length < 3) {
      throw new BridgeError(404, 'not-found', 'unknown route')
    }

    const sessionId = decodeURIComponent(parts[2])
    const action = parts[3]

    if (action === undefined) {
      if (request.method !== 'GET') throw new BridgeError(405, 'method-not-allowed', 'use GET')
      sendJson(response, 200, { session: await sessionDetail(sessionId) })
      return
    }
    if (action === 'messages') {
      if (request.method !== 'GET') throw new BridgeError(405, 'method-not-allowed', 'use GET')
      const maxMessages = numberParam(url.searchParams.get('maxMessages'), 20, 1, 200)
      sendJson(response, 200, { sessionId, ...(await readMessages(sessionId, maxMessages)) })
      return
    }
    if (request.method !== 'POST') throw new BridgeError(405, 'method-not-allowed', 'use POST')
    const body = await readJson(request, options.maxBodyBytes)

    if (action === 'prompt') {
      sendJson(response, 200, await prompt(sessionId, body))
      return
    }
    if (action === 'cancel') {
      const value = sessions.cancel({ sessionId })
      sendJson(response, 200, value ?? { accepted: true })
      return
    }
    if (action === 'wait') {
      sendJson(response, 200, await wait(sessionId, body))
      return
    }
    throw new BridgeError(404, 'not-found', 'unknown route')
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error) => {
      if (error instanceof BridgeError) {
        sendJson(response, error.status, { error: error.code, message: error.message })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(new Error(`ha-bridge: ${message}`))
      if (!response.headersSent) sendJson(response, 500, { error: 'internal', message })
      else response.destroy()
    })
  })

  ctx.effect(() => {
    server.listen(options.port, options.host, () => {
      ctx.logger.info(`ha-bridge: listening on http://${options.host}:${String(options.port)}`)
    })
    server.on('error', (error) => {
      ctx.logger.error(new Error(`ha-bridge: listen failed: ${error instanceof Error ? error.message : String(error)}`))
    })
    return () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      })
  }, 'ha-bridge: listener')
}