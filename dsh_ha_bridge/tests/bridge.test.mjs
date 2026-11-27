/**
 * Standalone checks for dsh-ha-bridge.
 *
 * The plugin normally runs inside Harness, where a restart is the only way to
 * load new code. This harness mounts `apply` against a stub context instead, so
 * the token lifecycle, the loopback-only setup surface and the bearer check can
 * all be exercised before anything touches a live installation.
 *
 *   node dsh_ha_bridge/tests/bridge.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const { apply } = await import('../index.js')

const PORT = 43999
const BASE = `http://127.0.0.1:${PORT}`

function stubContext() {
  const notes = { info: [], warn: [], error: [] }
  return {
    notes,
    ctx: {
      logger: {
        info: (value) => notes.info.push(String(value)),
        warn: (value) => notes.warn.push(String(value)),
        error: (value) => notes.error.push(String(value)),
      },
      effect: (factory) => {
        factory()
        return () => {}
      },
      sessionController: {
        list: async () => ({
          items: [
            { sessionId: 's1', running: true, blank: false, cwd: '/work', updatedAt: 1_700_000_000_000 },
            { sessionId: 's2', running: false, blank: false, cwd: '/other', updatedAt: 1_600_000_000_000 },
          ],
        }),
        state: async ({ sessionId }) => ({ active: sessionId === 's1', pendingInput: [], queue: [] }),
        events: async () => ({
          cursor: 7,
          records: [
            { type: 'event', event: { type: 'user/message', seq: 1, time: 10, data: { content: [{ type: 'text', text: 'ping' }] } } },
            {
              type: 'event',
              event: {
                type: 'assistant/message',
                seq: 2,
                time: 11,
                data: { message: { content: [{ type: 'text', text: 'pong' }] } },
              },
            },
          ],
        }),
        prompt: async ({ sessionId }) => ({ accepted: true, sessionId }),
        cancel: () => ({ accepted: true }),
        wait: async () => ({ reason: 'idle', state: {}, output: { records: [], truncated: false } }),
      },
    },
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/setup/token`)
      if (response.ok) return
    } catch {
      /* not listening yet */
    }
    await sleep(50)
  }
  throw new Error('bridge did not start listening')
}

const results = []
async function check(label, run) {
  try {
    await run()
    results.push(['PASS', label])
  } catch (error) {
    results.push(['FAIL', label, error instanceof Error ? error.message : String(error)])
  }
}

// --- 1. first run mints and persists a token -------------------------------
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-ha-bridge-test-'))
const stateFile = join(stateDir, 'state.json')
process.env.DSH_HA_BRIDGE_STATE = stateFile

const first = stubContext()
apply(first.ctx, { host: '127.0.0.1', port: PORT, timeZone: 'Asia/Shanghai' })
await waitForServer()

let token = ''

await check('mints a token on first run and writes it to disk', () => {
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.match(saved.token, /^[0-9a-f]{32}$/)
  assert.equal(saved.plugin, 'dsh-ha-bridge')
  token = saved.token
})

await check('logs where to read the generated token', () => {
  assert.ok(first.notes.info.some((line) => line.includes('http://127.0.0.1')))
})

// --- 2. the setup surface ---------------------------------------------------
await check('setup page renders the token and the HA fields', async () => {
  const response = await fetch(`${BASE}/`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/)
  const html = await response.text()
  assert.ok(html.includes(token), 'page shows the token')
  assert.ok(html.includes('bridge-nonce'), 'page carries the rotation nonce')
  assert.ok(html.includes('43131') || html.includes(String(PORT)), 'page shows the port')
})

await check('setup token endpoint is plain text', async () => {
  const response = await fetch(`${BASE}/setup/token`)
  assert.equal(response.status, 200)
  assert.equal((await response.text()).trim(), token)
})

await check('setup page refuses a forwarded request', async () => {
  const response = await fetch(`${BASE}/setup/token`, { headers: { 'x-forwarded-for': '192.168.10.9' } })
  assert.equal(response.status, 403)
})

await check('rotation without the nonce is rejected', async () => {
  const response = await fetch(`${BASE}/setup/rotate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"confirm":true}',
  })
  assert.equal(response.status, 403)
})

// --- 3. the bearer surface --------------------------------------------------
await check('health requires the bearer token', async () => {
  const anonymous = await fetch(`${BASE}/api/health`)
  assert.equal(anonymous.status, 401)
  const wrong = await fetch(`${BASE}/api/health`, { headers: { authorization: 'Bearer nope' } })
  assert.equal(wrong.status, 401)
  const right = await fetch(`${BASE}/api/health`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(right.status, 200)
  const body = await right.json()
  assert.deepEqual(body, { ok: true, name: 'dsh-ha-bridge', version: 3, timeZone: 'Asia/Shanghai' })
})

await check('sessions project running/queued/pendingInput', async () => {
  const response = await fetch(`${BASE}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200)
  const { sessions } = await response.json()
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].id, 's1')
  assert.equal(sessions[0].running, true)
  assert.equal(sessions[0].queued, 0)
  assert.deepEqual(sessions[0].pendingInput, [])
})

await check('messages flatten text blocks and drop duplicates', async () => {
  const response = await fetch(`${BASE}/api/sessions/s1/messages?maxMessages=10`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(
    body.messages.map((row) => [row.role, row.text]),
    [
      ['user', 'ping'],
      ['assistant', 'pong'],
    ],
  )
})

await check('unknown routes stay 401 without a token and 404 with one', async () => {
  assert.equal((await fetch(`${BASE}/api/nope`)).status, 401)
  assert.equal((await fetch(`${BASE}/api/nope`, { headers: { authorization: `Bearer ${token}` } })).status, 404)
})

// --- 4. rotation ------------------------------------------------------------
let rotated = ''
await check('rotation with the nonce mints a new token', async () => {
  const page = await fetch(`${BASE}/`)
  const html = await page.text()
  const nonce = /<meta name="bridge-nonce" content="([^"]+)">/.exec(html)?.[1]
  assert.ok(nonce, 'nonce is in the page')
  const response = await fetch(`${BASE}/setup/rotate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-nonce': nonce },
    body: '{"confirm":true}',
  })
  assert.equal(response.status, 200)
  rotated = (await response.json()).token
  assert.match(rotated, /^[0-9a-f]{32}$/)
  assert.notEqual(rotated, token)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).token, rotated, 'rotation persisted')
})

await check('the old token stops working and the new one starts', async () => {
  assert.equal((await fetch(`${BASE}/api/health`, { headers: { authorization: `Bearer ${token}` } })).status, 401)
  assert.equal((await fetch(`${BASE}/api/health`, { headers: { authorization: `Bearer ${rotated}` } })).status, 200)
})

// --- 5. a configured token wins, and is not rotatable -----------------------
const configured = stubContext()
apply(configured.ctx, { host: '127.0.0.1', port: PORT + 1, token: 'configured-token-0123456789abcdef' })
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const probe = await fetch(`http://127.0.0.1:${PORT + 1}/setup/token`)
    if (probe.ok) break
  } catch {
    /* still binding */
  }
  await sleep(50)
}

await check('a configured token is used verbatim', async () => {
  const response = await fetch(`http://127.0.0.1:${PORT + 1}/setup/token`)
  assert.equal((await response.text()).trim(), 'configured-token-0123456789abcdef')
})

await check('a configured token refuses rotation', async () => {
  const page = await fetch(`http://127.0.0.1:${PORT + 1}/`)
  const nonce = /<meta name="bridge-nonce" content="([^"]+)">/.exec(await page.text())?.[1]
  const response = await fetch(`http://127.0.0.1:${PORT + 1}/setup/rotate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-nonce': nonce },
    body: '{"confirm":true}',
  })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error, 'token-from-config')
})

// --- 6. a restart reuses the persisted token --------------------------------
const second = stubContext()
apply(second.ctx, { host: '127.0.0.1', port: PORT + 2, timeZone: 'Asia/Shanghai' })
for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const probe = await fetch(`http://127.0.0.1:${PORT + 2}/setup/token`)
    if (probe.ok) break
  } catch {
    /* still binding */
  }
  await sleep(50)
}

await check('a restart reuses the persisted token instead of minting one', async () => {
  const response = await fetch(`http://127.0.0.1:${PORT + 2}/setup/token`)
  assert.equal((await response.text()).trim(), rotated)
})

await check('setupPage:false closes the setup surface', async () => {
  const silent = stubContext()
  apply(silent.ctx, { host: '127.0.0.1', port: PORT + 3, setupPage: false })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const probe = await fetch(`http://127.0.0.1:${PORT + 3}/setup/token`)
      assert.equal(probe.status, 404)
      break
    } catch {
      /* still binding */
    }
    await sleep(50)
  }
})

// ---------------------------------------------------------------------------
rmSync(stateDir, { recursive: true, force: true })

const failed = results.filter((row) => row[0] === 'FAIL')
for (const [status, label, detail] of results) {
  console.log(`${status}  ${label}${detail === undefined ? '' : `\n      ${detail}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length === 0 ? 0 : 1)