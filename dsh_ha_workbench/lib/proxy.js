/**
 * Reverse proxy for the DeepSeek Harness Web GUI.
 *
 * Why a prefix proxy: the Harness frontend is built to be relocatable. Its
 * `index.html` is served with `<base href="./">`, every app route is derived as
 * a document-relative path (`"/api/x".slice(1)`), and the WebSocket carrier
 * resolves against `document.baseURI`. So the whole single-page app works when
 * it is served under any path, and a proxy only has to strip that path again.
 *
 * Why it is needed at all: the browser carrier authenticates with a per-process
 * launch token (`?token=` -> `HttpOnly; SameSite=Strict` cookie). A page inside
 * another site's iframe never receives that cookie, and the WebSocket admission
 * also rejects a foreign `Origin`. This proxy owns both: it speaks the cookie
 * upstream (so the browser needs none) and presents the upstream authority as
 * `Host`/`Origin` (so admission passes). The browser authenticates against the
 * path prefix instead, which is the one credential a browser can carry without
 * cookies.
 *
 * The listener is plain node:http and streams both directions, so large
 * uploads and downloads do not pass through a buffer.
 *
 * @module dsh-ha-workbench/proxy
 */
import { createServer, request as httpRequest } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const PROXY_ROUTE = '/__health'
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
/** Response headers the proxy owns; the upstream's values would describe the wrong hop. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
])
/** Root-absolute references the upstream emits despite the relocatable build. */
const ABSOLUTE_REWRITES = [['"/dsh-desktop-logo.png"', '"dsh-desktop-logo.png"']]
/**
 * Root-absolute app routes that client plugins call, and how to make them relative.
 *
 * Both are third-party/desktop plugins that assume the page is served at the
 * origin root — the harness `fetch("/api/…")` family is document-relative by
 * design, these are not. Under a path prefix they escape to the hosting origin
 * (Home Assistant), which answers 404.
 *
 * `window.location.origin` as a URL base has the same problem: a relative path
 * against the origin is still the origin, not the prefix. `document.baseURI` is
 * the page's directory, which is exactly where the app lives.
 */
const BUNDLE_REWRITES = [
  ["'/api/desktop", "'api/desktop"],
  ['"/api/desktop', '"api/desktop'],
  ['"/remote-ssh/', '"remote-ssh/'],
  ["'/remote-ssh/", "'remote-ssh/"],
  [', window.location.origin)', ', document.baseURI)'],
]
/** A bundle is worth buffering only when it belongs to one of these plugins. */
const BUNDLE_MARKERS = ['dsh-desktop', 'remote-ssh']

/**
 * Client plugins the browser surface does not need.
 *
 * These plugins belong to the DSH Desktop shell: a workbench/market/onboarding
 * surface that has no meaning inside a framed browser page. `dsh-desktop-workbenches`
 * is also the one plugin that fetches a root-absolute route on load, so dropping it
 * removes both the dead weight and the 404 it produces under a path prefix.
 *
 * Both are leaves in the boot graph (nothing lists them in `inject`), so removing
 * them cannot strand another plugin waiting for a dependency.
 */
const DROPPED_CLIENT_PLUGINS = new Set(['dsh-desktop-workbenches', 'dsh-desktop-onboarding'])
const BOOT_MARKER = 'globalThis["__DSH_BOOT__"]'

/**
 * The phone layout: mount the shell's window-chrome controls on every platform.
 *
 * The sidebar has two seats for its toggle. One is the 56px icon rail inside the
 * sidebar column; the other is `shell.leading`, a seat in the frame's top-left
 * corner that holds "open sidebar" plus "new session". The frame mounts that seat
 * only on macOS (`darwin && sidebarCollapsed`), because there a collapsed sidebar
 * disappears instead of leaving the rail behind.
 *
 * That macOS arrangement is also the phone arrangement: on a 390px viewport the
 * rail costs 56px of conversation, and the two controls it carries are the only
 * ones a phone needs. A browser panel cannot ask the plugin for it, so the proxy
 * flips the single condition. Nothing else in the bundle is touched, and the
 * stylesheet that removes the rail is gated on the seat actually existing
 * (`:has([data-shell-leading])`), so if a harness upgrade rewrites this line the
 * panel degrades to today's rail instead of to a page with no navigation at all.
 */
const PHONE_BUNDLE = 'dsh-client-ui-layout/client.js'
const PHONE_EDITS = [
  ['const leadingMounted = darwin && sidebarCollapsed;', 'const leadingMounted = sidebarCollapsed;'],
]
let phonePatchGaveUp = false

/**
 * Apply the phone layout patch to the layout plugin's bundle.
 *
 * @param body - upstream bundle.
 * @param requestUrl - the proxied request URL, used to spot the layout bundle.
 * @param logger - warn sink, used once when the source no longer matches.
 * @returns the patched bundle, or the original buffer when nothing applies.
 */
function patchPhoneLayout(body, requestUrl, logger) {
  if (!requestUrl.includes(PHONE_BUNDLE)) return body
  const text = body.toString('utf8')
  let next = text
  for (const [from, to] of PHONE_EDITS) next = next.split(from).join(to)
  if (next !== text) return Buffer.from(next, 'utf8')
  if (!phonePatchGaveUp) {
    phonePatchGaveUp = true
    logger.warn(
      'workbench: the layout bundle no longer matches the phone patch; the panel keeps its sidebar rail',
    )
  }
  return body
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

/**
 * Constant-time check of one path segment. A missing or differently sized
 * segment is simply a failed check.
 */
function matchesToken(segment, token) {
  const given = Buffer.from(segment, 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Split `/<token>/rest?query` into its segment and the remainder. */
function splitTarget(url) {
  const parsed = new URL(url ?? '/', 'http://workbench.invalid')
  const segments = parsed.pathname.split('/')
  const first = segments[1] ?? ''
  const rest = `/${segments.slice(2).join('/')}${parsed.search}`
  return { first, rest }
}

function copyHeaders(source, dropped) {
  const out = {}
  for (const [name, value] of Object.entries(source)) {
    if (dropped.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

/**
 * Drop the desktop-only client plugins from the boot manifest.
 *
 * The host renders the manifest as one `globalThis["__DSH_BOOT__"] = {…}` script.
 * A batch may only name entries that still exist (`parseBootManifest` throws
 * otherwise), so the same ids are removed from every batch's entry list; a batch
 * that would end up empty is dropped with them. The modules themselves still
 * travel inside the batch bundle, but a registration the manifest never names is
 * never activated, so no code runs.
 *
 * @param html - upstream index document.
 * @returns the document with the manifest filtered, or the original when it does not apply.
 */
function filterBootManifest(html) {
  const marker = html.indexOf(BOOT_MARKER)
  if (marker === -1) return html
  const assign = html.indexOf('=', marker)
  const end = html.indexOf('</script>', assign)
  if (assign === -1 || end === -1) return html

  const raw = html.slice(assign + 1, end).trim().replace(/;$/, '')
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch {
    return html
  }
  if (!Array.isArray(manifest?.entries) || !Array.isArray(manifest?.batches)) return html

  const dropped = new Set(
    manifest.entries
      .map((entry) => entry?.id)
      .filter((id) => typeof id === 'string' && DROPPED_CLIENT_PLUGINS.has(id)),
  )
  if (dropped.size === 0) return html

  manifest.entries = manifest.entries.filter((entry) => !dropped.has(entry?.id))
  manifest.batches = manifest.batches
    .map((batch) => ({
      ...batch,
      entries: (batch.entries ?? []).filter((id) => !dropped.has(id)),
    }))
    .filter((batch) => (batch.entries ?? []).length > 0)

  return `${html.slice(0, assign + 1)} ${JSON.stringify(manifest)}${html.slice(end)}`
}

/**
 * Rewrite a served document so the prefix proxy can host it.
 *
 * Client module URLs are deliberately left untouched: the harness `plugins/??…`
 * route matches its query exactly and answers 404 for an extra parameter, so a
 * cache-busting suffix there breaks module loading. Freshness comes from the
 * document instead — it is served `no-store` and carries the filtered manifest.
 *
 * @param body - upstream response body.
 * @param contentType - upstream content type.
 * @returns the body to send, or the original buffer when nothing applies.
 */
function rewriteDocument(body, contentType) {
  const type = (contentType ?? '').toLowerCase()
  if (!type.includes('text/html') && !type.includes('application/manifest+json')) return body
  const text = body.toString('utf8')
  let next = text
  if (type.includes('text/html')) next = filterBootManifest(next)
  for (const [from, to] of ABSOLUTE_REWRITES) next = next.split(from).join(to)
  return next === text ? body : Buffer.from(next, 'utf8')
}

/**
 * Make a third-party client plugin's root-absolute app routes document-relative.
 *
 * The harness's own client plugins are document-relative by design; the desktop
 * shell plugins (`dsh-desktop-workbenches`, `dsh-desktop-onboarding`) and the
 * community `dsh-remote-ssh` plugin are not — they call `fetch("/api/desktop-…")`
 * and `fetch("/remote-ssh/api/…")` with a leading slash, and build upload URLs
 * with `new URL("/remote-ssh/…", window.location.origin)`.
 *
 * That works when the harness serves the page at the origin root, but under a path
 * prefix it escapes to the hosting origin — here Home Assistant answers
 * `404: Not Found`. The routes themselves exist in the harness, so only the base
 * is wrong; `document.baseURI` is the page's own directory, which stays inside the
 * prefix and therefore still reaches the harness route through this proxy.
 *
 * Only bundles whose URL names one of those plugins are touched, so the general
 * client bundles keep streaming through untouched.
 *
 * @param body - upstream response body.
 * @param requestUrl - the proxied request URL, used to spot the affected bundles.
 * @returns the body to send, or the original buffer when nothing applies.
 */
function rewriteScript(body, requestUrl) {
  if (!BUNDLE_MARKERS.some((marker) => requestUrl.includes(marker))) return body
  const text = body.toString('utf8')
  if (!text.includes('/remote-ssh/') && !text.includes('/api/desktop')) return body
  let next = text
  for (const [from, to] of BUNDLE_REWRITES) next = next.split(from).join(to)
  return next === text ? body : Buffer.from(next, 'utf8')
}

/**
 * Start the workbench proxy.
 *
 * @param options.host - bind address.
 * @param options.port - bind port.
 * @param options.token - path segment that authenticates the browser.
 * @param options.upstreamHost - Harness web listener host.
 * @param options.upstreamPort - Harness web listener port.
 * @param options.cookieSource - `{ get(): Promise<string>, invalidate(): void }`
 *   supplying the upstream `Cookie` header.
 * @param options.logger - optional `{ info, warn, error }` sink.
 * @returns `{ server, close, upstreamOrigin }`; the caller owns `listen`.
 */
export function createWorkbenchServer(options) {
  const { host, port, token, upstreamHost, upstreamPort, cookieSource } = options
  const logger = options.logger ?? console
  const upstreamOrigin = `http://${upstreamHost}:${upstreamPort}`
  const upstreamAuthority = `${upstreamHost}:${upstreamPort}`
  const prefix = `/${encodeURIComponent(token)}`

  if (typeof token !== 'string' || token === '') {
    throw new Error('workbench: a non-empty token is required')
  }

  /** Upstream request headers: authenticated, and speaking for the upstream authority. */
  async function upstreamHeaders(request, cookie, keepUpgrade = false) {
    const headers = copyHeaders(request.headers, keepUpgrade ? new Set([...HOP_BY_HOP].filter((name) => name !== 'connection' && name !== 'upgrade')) : HOP_BY_HOP)
    headers.host = upstreamAuthority
    headers.cookie = cookie
    if (headers.origin !== undefined) headers.origin = upstreamOrigin
    // The proxy streams decoded bytes itself, so it never negotiates a
    // content encoding it would then have to pass through untranslated.
    delete headers['accept-encoding']
    // A rewritten body no longer matches the upstream validator the browser still
    // holds, so a conditional request must not be answered with the upstream's
    // 304 — the browser would keep the un-rewritten copy forever.
    delete headers['if-none-match']
    delete headers['if-modified-since']
    return headers
  }

  function requestUpstream(method, path, headers) {
    return httpRequest({ host: upstreamHost, port: upstreamPort, method, path, headers })
  }

  /** Answer one buffered response, rewriting what the prefix would break. */
  function sendRewritten(response, upstream, chunks, requestUrl) {
    const original = Buffer.concat(chunks)
    let body = rewriteDocument(original, upstream.headers['content-type'])
    body = rewriteScript(body, requestUrl)
    body = patchPhoneLayout(body, requestUrl, logger)
    const headers = copyHeaders(upstream.headers, DROPPED_RESPONSE_HEADERS)
    headers['content-length'] = String(body.length)
    if (body.length !== original.length) {
      // A stale validator would let the browser keep the un-rewritten copy.
      delete headers.etag
      delete headers['last-modified']
    }
    if (String(upstream.headers['content-type'] ?? '').includes('text/html')) {
      // The document carries the proxy-filtered boot manifest; a cached copy would
      // resurrect the plugins that were dropped from it.
      headers['cache-control'] = 'no-store'
    }
    response.writeHead(upstream.statusCode ?? 502, headers)
    response.end(body)
  }

  async function forward(request, response, rest, attempt = 0) {
    const cookie = await cookieSource.get()
    const headers = await upstreamHeaders(request, cookie)
    const target = requestUpstream(request.method, rest, headers)

    target.on('error', (error) => {
      logger.warn(`workbench: upstream ${request.method} ${rest} failed: ${error.message}`)
      if (!response.headersSent) sendJson(response, 502, { error: 'upstream-unreachable', message: error.message })
      else response.destroy()
    })

    target.on('response', (upstream) => {
      // The launch token rotates when Harness restarts; re-mint once and retry.
      if (upstream.statusCode === 401 && attempt === 0) {
        upstream.resume()
        cookieSource.invalidate()
        forward(request, response, rest, attempt + 1).catch((error) => {
          if (!response.headersSent) sendJson(response, 502, { error: 'proxy-failed', message: String(error) })
        })
        return
      }
      const type = String(upstream.headers['content-type'] ?? '').toLowerCase()
      const buffered =
        type.includes('text/html') ||
        type.includes('application/manifest+json') ||
        (type.includes('javascript') &&
          (BUNDLE_MARKERS.some((marker) => request.url.includes(marker)) ||
            request.url.includes(PHONE_BUNDLE)))
      if (buffered) {
        const chunks = []
        upstream.on('data', (chunk) => chunks.push(chunk))
        upstream.on('end', () => sendRewritten(response, upstream, chunks, request.url))
        upstream.on('error', () => response.destroy())
        return
      }
      response.writeHead(upstream.statusCode ?? 502, copyHeaders(upstream.headers, DROPPED_RESPONSE_HEADERS))
      upstream.pipe(response)
    })

    request.pipe(target)
  }

  function handleUpgrade(request, socket, head, rest) {
    let closed = false
    const destroy = () => {
      if (closed) return
      closed = true
      socket.destroy()
    }
    cookieSource
      .get()
      .then(async (cookie) => {
        const headers = await upstreamHeaders(request, cookie, true)
        const target = requestUpstream('GET', rest, headers)
        target.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
          const lines = Object.entries(upstream.headers)
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join('')
          socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines}\r\n`)
          if (upstreamHead?.length) socket.write(upstreamHead)
          if (head?.length) upstreamSocket.write(head)
          upstreamSocket.pipe(socket)
          socket.pipe(upstreamSocket)
          upstreamSocket.on('error', destroy)
          socket.on('error', () => upstreamSocket.destroy())
        })
        target.on('response', (upstream) => {
          logger.warn(`workbench: upgrade ${rest} refused with ${upstream.statusCode}`)
          destroy()
        })
        target.on('error', destroy)
        target.end()
      })
      .catch((error) => {
        logger.warn(`workbench: upgrade ${rest} failed: ${error.message}`)
        destroy()
      })
  }

  const server = createServer((request, response) => {
    const { first, rest } = splitTarget(request.url)
    if (request.url === PROXY_ROUTE || request.url?.startsWith(`${PROXY_ROUTE}?`) === true) {
      sendJson(response, 200, { ok: true, name: 'dsh-ha-workbench', version: 2 })
      return
    }
    if (!matchesToken(first, token)) {
      sendJson(response, 404, { error: 'not-found', message: 'unknown route' })
      return
    }
    forward(request, response, rest === '/' ? '/' : rest).catch((error) => {
      logger.warn(`workbench: ${request.method} ${rest} failed: ${error.message}`)
      if (!response.headersSent) sendJson(response, 502, { error: 'proxy-failed', message: String(error) })
      else response.destroy()
    })
  })

  server.on('upgrade', (request, socket, head) => {
    const { first, rest } = splitTarget(request.url)
    if (!matchesToken(first, token)) {
      socket.destroy()
      return
    }
    handleUpgrade(request, socket, head, rest === '/' ? '/' : rest)
  })

  return {
    server,
    upstreamOrigin,
    prefix,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve(server.address())
        })
      })
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}
