/**
 * Offline tests for the workbench proxy.
 *
 * Runs the real `lib/proxy.js` against a fake harness (plain node:http) so the
 * rewrite rules, the credential handling and the error paths are checked without
 * a running harness or a browser:
 *
 *   node --test tests/
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { createWorkbenchServer } from '../lib/proxy.js'

const TOKEN = 'test-token-0123456789'
const SEEN = []

/** A boot manifest shaped like the host's, including two desktop-only plugins. */
const BOOT = {
  rev: 'bootrev',
  release: { version: '0.0.0', commit: 'deadbeef' },
  entries: [
    { id: 'core-plugin', url: 'plugins/??core/client.js&rev=111aaa', rev: '111aaa', inject: [], immediately: true },
    { id: 'dsh-desktop-workbenches', url: 'plugins/??dsh-desktop-workbenches/client.js&rev=222bbb', rev: '222bbb', inject: ['core-plugin'] },
    { id: 'dsh-desktop-onboarding', url: 'plugins/??dsh-desktop-onboarding/client.js&rev=333ccc', rev: '333ccc', inject: [] },
  ],
  batches: [
    { phase: 'application', url: 'plugins/??core/client.js,dsh-desktop-workbenches/client.js&rev=444ddd', rev: '444ddd', entries: ['core-plugin', 'dsh-desktop-workbenches'] },
    { phase: 'application', url: 'plugins/??dsh-desktop-onboarding/client.js&rev=555eee', rev: '555eee', entries: ['dsh-desktop-onboarding'] },
  ],
}

const INDEX_HTML =
  '<!doctype html><html><head><base href="./"><link rel="icon" href="/dsh-desktop-logo.png">' +
  '<link rel="preload" as="script" href="plugins/??core/client.js&amp;rev=111aaa"></head><body>' +
  `<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(BOOT)}</script>` +
  '<div id="root"></div></body></html>'

/**
 * The two lines of the layout plugin the phone patch depends on, plus enough
 * surrounding bundle to tell a patched copy from an untouched one.
 */
const LAYOUT_BUNDLE = [
  'const darwin = document.documentElement.dataset.platform === "darwin";',
  'const collapsedWidth = darwin || document.documentElement.hasAttribute("data-windows-titlebar") ? 0 : 56;',
  'const leadingMounted = darwin && sidebarCollapsed;',
  'const frame = jsx("div", { "data-sidebar-collapsed": sidebarCollapsed || void 0 });',
  '',
].join('\n')

/** The same bundle after a harness upgrade renamed the seat flag. */
const LAYOUT_BUNDLE_DRIFTED = LAYOUT_BUNDLE.replace('leadingMounted', 'leadingSeatVisible')

function fakeHarness() {
  const server = createServer((request, response) => {
    SEEN.push({ url: request.url, headers: request.headers })
    const path = new URL(request.url, 'http://x').pathname
    // The plugin batch route puts every specifier into one query string, so the
    // layout bundle is recognised by URL rather than by path.
    if (request.url.includes('dsh-client-ui-layout/drifted')) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', etag: 'W/"drift"' })
      response.end(LAYOUT_BUNDLE_DRIFTED)
      return
    }
    if (request.url.includes('dsh-client-ui-layout')) {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', etag: 'W/"layout"' })
      response.end(LAYOUT_BUNDLE)
      return
    }
    if (path === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: 'W/"index"' })
      response.end(INDEX_HTML)
      return
    }
    if (path === '/plugins/dsh-desktop-workbenches.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end("const API = '/api/desktop-workbenches/state'\nfetch(API)\n")
      return
    }
    if (path === '/plugins/dsh-remote-ssh.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(
        'await fetch("/remote-ssh/api/" + method, { method: "POST" })\n' +
          'nativeFetch(new URL("/remote-ssh/write", window.location.origin).toString(), {})\n' +
          'const target = new URL("/remote-ssh/upload" + u.search, window.location.origin)\n',
      )
      return
    }
    if (path === '/plugins/plain.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end("const API = '/api/desktop-workbenches/state'\n")
      return
    }
    if (path === '/assets/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', etag: 'W/"1"' })
      response.end('console.log("asset")')
      return
    }
    if (path === '/api/echo') {
      const body = JSON.stringify({ forward: request.headers['x-forwarded-test'] ?? null })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return
    }
    if (path === '/api/unauthorized') {
      // First call: the token rotated. Second call: the re-minted cookie works.
      const rotated = SEEN.filter((entry) => new URL(entry.url, 'http://x').pathname === '/api/unauthorized').length > 1
      response.writeHead(rotated ? 200 : 401, { 'content-type': 'application/json' })
      response.end(rotated ? '{"ok":true}' : '{"error":"unauthorized"}')
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })
  return server
}

async function start(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server.address().port
}

async function harness() {
  const upstream = fakeHarness()
  const upstreamPort = await start(upstream)
  let minted = 0
  const cookieSource = {
    async get() {
      minted += 1
      return `dsh-auth-test=v1.${minted}`
    },
    invalidate() {},
  }
  const workbench = createWorkbenchServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    upstreamHost: '127.0.0.1',
    upstreamPort,
    cookieSource,
    logger: { info() {}, warn() {}, error() {} },
  })
  const address = await workbench.listen()
  return {
    base: `http://127.0.0.1:${address.port}`,
    upstreamPort,
    workbench,
    upstream,
    async close() {
      await workbench.close()
      await new Promise((resolve) => upstream.close(resolve))
    },
  }
}

test('serves the app under the token prefix and keeps the relative base', async () => {
  const h = await harness()
  try {
    const response = await fetch(`${h.base}/${TOKEN}/`)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(body.includes('<base href="./">'), 'the document base must survive')
    assert.ok(body.includes('href="dsh-desktop-logo.png"'), 'the root-absolute icon must be rewritten')
    assert.ok(!body.includes('href="/dsh-desktop-logo.png"'))
  } finally {
    await h.close()
  }
})

test('rewrites a desktop bundle to document-relative app routes', async () => {
  const h = await harness()
  try {
    const response = await fetch(`${h.base}/${TOKEN}/plugins/dsh-desktop-workbenches.js`)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(body.includes("'api/desktop-workbenches/state'"), body)
    assert.ok(!body.includes("'/api/desktop-workbenches/state'"), 'the leading slash must be gone')
    assert.equal(response.headers.get('etag'), null, 'a rewritten body needs no stale validator')
  } finally {
    await h.close()
  }
})

test('rewrites the remote-ssh plugin routes to document-relative', async () => {
  const h = await harness()
  try {
    const response = await fetch(`${h.base}/${TOKEN}/plugins/dsh-remote-ssh.js`)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(body.includes('fetch("remote-ssh/api/"'), body)
    assert.ok(!body.includes('"/remote-ssh/'), 'no root-absolute route may survive')
    assert.ok(!body.includes('window.location.origin'), 'the origin base must become document.baseURI')
    assert.ok(body.includes('new URL("remote-ssh/write", document.baseURI)'), body)
  } finally {
    await h.close()
  }
})

test('leaves ordinary client bundles byte-identical', async () => {
  const h = await harness()
  try {
    const response = await fetch(`${h.base}/${TOKEN}/plugins/plain.js`)
    const body = await response.text()
    assert.equal(body, "const API = '/api/desktop-workbenches/state'\n")
  } finally {
    await h.close()
  }
})

test('mounts the window-chrome seat on every platform for the phone layout', async () => {
  const h = await harness()
  try {
    const response = await fetch(`${h.base}/${TOKEN}/plugins/??dsh-client-ui-layout/client.js&rev=aaa`)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(body.includes('const leadingMounted = sidebarCollapsed;'), body)
    assert.ok(!body.includes('darwin && sidebarCollapsed'), 'the platform guard must be gone')
    assert.ok(
      body.includes('const collapsedWidth = darwin || document.documentElement.hasAttribute("data-windows-titlebar") ? 0 : 56;'),
      'no other line of the bundle may change; the rail is removed by the stylesheet',
    )
    assert.ok(body.includes('"data-sidebar-collapsed": sidebarCollapsed || void 0'), 'the rest must survive')
    assert.equal(response.headers.get('etag'), null, 'a rewritten body needs no stale validator')
  } finally {
    await h.close()
  }
})

test('leaves a layout bundle it cannot recognise byte-identical', async () => {
  const h = await harness()
  try {
    const response = await fetch(`${h.base}/${TOKEN}/plugins/??dsh-client-ui-layout/drifted&rev=bbb`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), LAYOUT_BUNDLE_DRIFTED, 'an unknown layout must not be half-patched')
    assert.equal(response.headers.get('etag'), 'W/"drift"', 'an untouched body keeps its validator')
  } finally {
    await h.close()
  }
})

test('drops the desktop-only plugins from the boot manifest', async () => {
  const h = await harness()
  try {
    const response = await fetch(`${h.base}/${TOKEN}/`)
    const html = await response.text()
    const start = html.indexOf('globalThis["__DSH_BOOT__"]')
    const end = html.indexOf('</script>', start)
    const manifest = JSON.parse(html.slice(html.indexOf('=', start) + 1, end).trim())

    const ids = manifest.entries.map((entry) => entry.id)
    assert.deepEqual(ids, ['core-plugin'], 'only the surviving plugin may be listed')
    for (const batch of manifest.batches) {
      for (const id of batch.entries) {
        assert.ok(ids.includes(id), `batch names an entry that no longer exists: ${id}`)
      }
    }
    assert.equal(manifest.batches.length, 1, 'a batch whose only entries were dropped must go too')
  } finally {
    await h.close()
  }
})

test('leaves client module URLs untouched', async () => {
  const h = await harness()
  try {
    const html = await (await fetch(`${h.base}/${TOKEN}/`)).text()
    // The harness `plugins/??…` route matches its query exactly: an extra
    // parameter there answers 404 and the whole app fails to boot.
    assert.ok(html.includes('rev=111aaa'), 'the upstream rev must survive')
    assert.ok(!html.includes('&ha='), 'no extra query parameter may be appended')
  } finally {
    await h.close()
  }
})

test('serves the document uncached and never revalidates against the upstream', async () => {
  const h = await harness()
  try {
    SEEN.length = 0
    const response = await fetch(`${h.base}/${TOKEN}/`, {
      headers: { 'if-none-match': 'W/"index"', 'if-modified-since': 'Wed, 01 Jan 2025 00:00:00 GMT' },
    })
    assert.equal(response.status, 200, 'the upstream validator must not produce a 304')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const sent = SEEN.at(-1)
    assert.equal(sent.headers['if-none-match'], undefined)
    assert.equal(sent.headers['if-modified-since'], undefined)
  } finally {
    await h.close()
  }
})

test('passes assets through and keeps the upstream validators', async () => {
  const h = await harness()
  try {
    const response = await fetch(`${h.base}/${TOKEN}/assets/app.js`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'console.log("asset")')
    assert.equal(response.headers.get('etag'), 'W/"1"')
  } finally {
    await h.close()
  }
})

test('speaks for the upstream authority with its own credential', async () => {
  const h = await harness()
  try {
    SEEN.length = 0
    const response = await fetch(`${h.base}/${TOKEN}/api/echo`, {
      headers: { origin: 'http://home-assistant.local', cookie: 'ha-session=super-secret' },
    })
    assert.equal(response.status, 200)
    const sent = SEEN.at(-1)
    const authority = `127.0.0.1:${h.upstreamPort}`
    assert.equal(sent.headers.host, authority, 'the host header must name the upstream')
    assert.equal(sent.headers.origin, `http://${authority}`, 'the origin must name the upstream')
    assert.ok(sent.headers.cookie.startsWith('dsh-auth-test='), 'the harness cookie must be injected')
    assert.ok(!sent.headers.cookie.includes('ha-session'), 'a browser cookie must never leak upstream')
  } finally {
    await h.close()
  }
})

test('re-mints the cookie once when the harness answers 401', async () => {
  const h = await harness()
  try {
    const response = await fetch(`${h.base}/${TOKEN}/api/unauthorized`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), '{"ok":true}')
  } finally {
    await h.close()
  }
})

test('refuses an unknown token without touching the harness', async () => {
  const h = await harness()
  try {
    SEEN.length = 0
    const response = await fetch(`${h.base}/not-the-token/`)
    assert.equal(response.status, 404)
    assert.deepEqual(SEEN, [])
  } finally {
    await h.close()
  }
})

test('answers health without leaking the token', async () => {
  const h = await harness()
  try {
    const response = await fetch(`${h.base}/__health`)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(body.includes('"ok":true'))
    assert.ok(!body.includes(TOKEN))
  } finally {
    await h.close()
  }
})

