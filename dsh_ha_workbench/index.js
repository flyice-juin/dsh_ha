/**
 * dsh-ha-workbench — serve the DeepSeek Harness Web GUI to a Home Assistant
 * sidebar panel.
 *
 * The Harness browser surface cannot be embedded directly: it authenticates
 * with a per-process launch token that becomes an `HttpOnly; SameSite=Strict`
 * cookie, and a page inside another site's iframe never receives that cookie
 * (and the WebSocket admission rejects the foreign `Origin`). This plugin
 * mounts the GUI behind a path prefix instead — the prefix is the credential a
 * browser can carry without cookies — and holds the Harness cookie itself.
 *
 * The prefix must be the *bridge* token: Home Assistant builds the panel URL
 * from the token it stores in its config entry. Nothing is minted here — two
 * plugins inventing their own secrets would silently disagree. Resolution:
 *
 *   1. `config.token` (pin it only if the bridge pins one too);
 *   2. `$DSH_HA_BRIDGE_STATE`, else `$DSH_HOME/ha-bridge/state.json` — the file
 *      dsh-ha-bridge writes in its own `apply`, so a short wait bridges the gap
 *      when both plugins load in the same startup batch.
 *
 * Contract:
 *   GET /__health                      → { ok, name, version }   (no secret)
 *   *   /<token>/<any Harness path>    → proxied to the Harness web listener
 *   *   /<token>/api                   → WebSocket relay (remote stream mux)
 *
 * @module dsh-ha-workbench
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createConnectionCookieSource } from './lib/cookie.js'
import { createWorkbenchServer } from './lib/proxy.js'

/** Stable Cordis plugin name. */
export const name = 'ha-workbench'

const DEFAULTS = {
  host: '0.0.0.0',
  port: 43132,
  token: '',
  webHost: '127.0.0.1',
  /** 0 = follow the Harness web listener's own port. */
  webPort: 0,
  /** How long to wait for the bridge token when both plugins start together. */
  tokenWaitMs: 20000,
}

/** The bridge's token file — same lookup order as dsh-ha-bridge. */
function bridgeStatePath() {
  const explicit = process.env.DSH_HA_BRIDGE_STATE?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = process.env.DSH_HOME?.trim()
  const root = home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
  return join(root, 'ha-bridge', 'state.json')
}

function readBridgeToken(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const token = parsed !== null && typeof parsed === 'object' ? parsed.token : undefined
    return typeof token === 'string' && token.trim() !== '' ? token.trim() : undefined
  } catch {
    return undefined
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolve the shared token: configured, else the bridge's persisted one,
 * waiting up to `waitMs` for a file the bridge is about to write.
 */
async function resolveToken(configured, waitMs, logger) {
  const file = bridgeStatePath()
  if (typeof configured === 'string' && configured.trim() !== '') {
    return { token: configured.trim(), source: 'config', file }
  }
  const deadline = Date.now() + (waitMs > 0 ? waitMs : 0)
  let announced = false
  for (;;) {
    const token = readBridgeToken(file)
    if (token !== undefined) return { token, source: 'file', file }
    if (Date.now() >= deadline) return { token: null, source: 'missing', file }
    if (!announced) {
      logger?.info?.(`ha-workbench: waiting for the bridge token at ${file}`)
      announced = true
    }
    await sleep(500)
  }
}

export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }

  ctx.inject(['webServer'], (webCtx) => {
    const webPort = options.webPort > 0 ? options.webPort : webCtx.webServer.port
    if (typeof webPort !== 'number' || webPort <= 0) {
      ctx.logger.error('ha-workbench: the Harness web listener has no port; the workbench proxy did not start')
      return
    }

    const cookieSource = createConnectionCookieSource({
      connection: webCtx.get('connection'),
      upstreamOrigin: `http://${options.webHost}:${String(webPort)}`,
      logger: ctx.logger,
    })

    let disposed = false
    let workbench = null

    const starting = resolveToken(options.token, Number(options.tokenWaitMs), ctx.logger)
      .then(async (resolved) => {
        if (disposed) return
        if (resolved.token === null) {
          ctx.logger.error(
            `ha-workbench: no token yet — install and start dsh-ha-bridge first (it mints the token in ${resolved.file}), or pin token: in the plugin config. The workbench proxy did not start.`,
          )
          return
        }
        workbench = createWorkbenchServer({
          host: options.host,
          port: options.port,
          token: resolved.token,
          upstreamHost: options.webHost,
          upstreamPort: webPort,
          cookieSource,
          logger: ctx.logger,
        })
        const address = await workbench.listen()
        const bound = address !== null && typeof address === 'object' ? address.port : options.port
        // The prefix carries the credential, so log only what an operator needs
        // to diagnose binding.
        ctx.logger.info(
          `ha-workbench: serving the Harness web GUI at http://${options.host}:${String(bound)}/ (upstream ${workbench.upstreamOrigin}, token from ${resolved.source})`,
        )
      })
      .catch((error) => {
        ctx.logger.error(error instanceof Error ? error : new Error(String(error)))
      })

    webCtx.effect(
      () => {
        void starting
        return () => {
          disposed = true
          workbench?.close?.()
        }
      },
      'ha-workbench: listener',
    )
  })

  ctx.on('dispose', () => {
    ctx.logger.info('ha-workbench: stopped')
  })
}
