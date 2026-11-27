/**
 * Standalone runner for the workbench proxy.
 *
 * The plugin normally gets its upstream credential from `ctx.connection`, which
 * only exists inside the Harness process. This runner reproduces the same two
 * inputs from outside — the launch token printed by `dsh web` in the Harness
 * log — so the proxy can be exercised (or run as a fallback service) without
 * reloading the Host.
 *
 *   node tools/serve.mjs
 *   DSH_WEB_TOKEN=… DSH_WEB_PORT=43129 WORKBENCH_PORT=43132 node tools/serve.mjs
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createConnectionCookieSource } from '../lib/cookie.js'
import { createWorkbenchServer } from '../lib/proxy.js'

const LOG = process.env.DSH_HARNESS_LOG
  ?? join(process.env.APPDATA ?? '', 'dsh-desktop', 'logs', 'harness.log')
const WEB_HOST = process.env.DSH_WEB_HOST ?? '127.0.0.1'
const WEB_PORT = Number.parseInt(process.env.DSH_WEB_PORT ?? '43129', 10)
const PORT = Number.parseInt(process.env.WORKBENCH_PORT ?? '43132', 10)
const HOST = process.env.WORKBENCH_HOST ?? '0.0.0.0'
const TOKEN = process.env.WORKBENCH_TOKEN ?? 'devsecret'

/** Last launch token `dsh web` printed, which is the one the live process uses. */
async function launchTokenFromLog() {
  if (process.env.DSH_WEB_TOKEN) return process.env.DSH_WEB_TOKEN
  const text = await readFile(LOG, 'utf8')
  const matches = [...text.matchAll(/dsh web: https?:\/\/\S+\?token=([\w-]+)/g)]
  const token = matches.at(-1)?.[1]
  if (token === undefined) throw new Error(`no "dsh web:" token line in ${LOG}`)
  return token
}

/** The one method the cookie source needs, reproduced from the launch token. */
function connectionLike(token) {
  return {
    authenticatedUrl(baseUrl) {
      const url = new URL(baseUrl)
      url.searchParams.set('token', token)
      return url.href
    },
  }
}

const upstreamOrigin = `http://${WEB_HOST}:${WEB_PORT}`
const cookieSource = createConnectionCookieSource({
  // A provider, not a value: every credential refresh re-reads the launch token,
  // because a Harness restart rotates it while this process keeps running.
  connection: async () => connectionLike(await launchTokenFromLog()),
  upstreamOrigin,
})
const workbench = createWorkbenchServer({
  host: HOST,
  port: PORT,
  token: TOKEN,
  upstreamHost: WEB_HOST,
  upstreamPort: WEB_PORT,
  cookieSource,
})

const address = await workbench.listen()
console.log(`workbench listening on http://${HOST}:${address.port}/<token>/ -> ${upstreamOrigin}`)
console.log(`open http://127.0.0.1:${address.port}/${TOKEN}/`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await workbench.close()
    process.exit(0)
  })
}
