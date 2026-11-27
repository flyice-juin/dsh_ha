/**
 * Upstream credential for the workbench proxy.
 *
 * The Harness browser surface authenticates with a launch token that changes
 * every time the process starts: `GET /?token=…` answers 303 and mints an
 * `HttpOnly; SameSite=Strict` cookie whose payload is signed and bound to the
 * upstream authority. The proxy holds that cookie itself, so the browser needs
 * no cookie at all; it only has to notice the token rotating (a Harness
 * restart, which also restarts this plugin) and re-mint on a 401.
 *
 * @module dsh-ha-workbench/cookie
 */

const COOKIE_PREFIX = 'dsh-auth-'

/** Read the first `dsh-auth-*` cookie out of a Set-Cookie list, as `name=value`. */
export function pickAuthCookie(setCookieValues) {
  for (const value of setCookieValues ?? []) {
    const pair = String(value).split(';', 1)[0]?.trim()
    if (pair === undefined || !pair.startsWith(COOKIE_PREFIX)) continue
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    return pair
  }
  return undefined
}

/**
 * Build a cookie source from a connection service that can add the process
 * launch token to a URL (`connection.authenticatedUrl(baseUrl)`).
 *
 * @param options.connection - Harness connection service, or undefined when the
 *   composition has no browser surface (headless), in which case `get()`
 *   rejects with the reason.
 * @param options.upstreamOrigin - upstream origin, for example `http://127.0.0.1:43129`.
 * @param options.logger - optional log sink.
 * @returns `{ get, invalidate, describe }`.
 */
export function createConnectionCookieSource(options) {
  const { connection, upstreamOrigin } = options
  const logger = options.logger ?? console
  let cached
  let pending

  /**
   * The connection service, or whatever a provider resolves to it.
   *
   * The in-process plugin passes the service itself. The standalone runner has no
   * `ctx`, so it passes a provider that re-reads the launch token from the
   * Harness log: a Harness restart rotates the token, and the next 401 has to
   * pick up the new one rather than keep retrying a dead credential.
   */
  async function resolveConnection() {
    const resolved = typeof connection === 'function' ? await connection() : connection
    if (resolved === undefined || typeof resolved.authenticatedUrl !== 'function') {
      throw new Error('workbench: the Harness connection service is unavailable, so the browser surface cannot be authenticated')
    }
    return resolved
  }

  async function acquire() {
    const resolved = await resolveConnection()
    const authenticated = resolved.authenticatedUrl(`${upstreamOrigin}/`)
    const response = await fetch(authenticated, { redirect: 'manual' })
    const cookie = pickAuthCookie(response.headers.getSetCookie?.() ?? [])
    // Drain so the socket is reusable; the body is never interesting.
    await response.arrayBuffer().catch(() => undefined)
    if (cookie === undefined) {
      throw new Error(`workbench: the Harness launch token was not accepted (HTTP ${String(response.status)})`)
    }
    cached = cookie
    logger.info?.('workbench: acquired the Harness browser cookie')
    return cookie
  }

  return {
    async get() {
      if (cached !== undefined) return cached
      if (pending !== undefined) return pending
      pending = acquire().finally(() => {
        pending = undefined
      })
      return pending
    },
    invalidate() {
      cached = undefined
    },
    describe() {
      return cached === undefined ? 'missing' : 'cached'
    },
  }
}
