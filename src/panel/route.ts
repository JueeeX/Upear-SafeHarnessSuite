/**
 * The panel's Host half (T5.3): one read-only HTTP route that serves the panel
 * payload to the browser.
 *
 * Why a plain `webServer` route and not a Connection RPC channel: a third-party
 * profile plugin cannot use `connection.rpc.handle()`. That helper mounts its
 * route through the *receiver* context Cordis binds to the service accessor, and
 * on the shipped 0.2.2 host that receiver has no `webServer` in its fiber chain
 * — the registration throws "cannot get property without inject" (measured; see
 * the 1.2.3 evidence file). The route below therefore carries the same
 * browser-trust fence itself, mirroring `isTrustedApiRequest` for the loopback
 * authority: Host header must name a loopback authority, a cross-site marker is
 * refused, and when an Origin is present it must be exactly this authority.
 *
 * The route exists only when the profile composes `webServer` (the Web GUI
 * bundles do; headless profiles do not), and it is read-only: `POST` only, no
 * body, and the response is a fixed projection of runtime counters.
 * @module
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { LoggerLike, Runtime } from '../runtime.js'
import { PANEL_CHANNEL, PANEL_STATUS_ENDPOINT } from './protocol.js'
import type { PanelResult } from './protocol.js'
import { buildPanelPayload } from './status.js'
import type { PanelFacts } from './status.js'

/** Host names the fence accepts as "this machine". */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * Whether one request may reach the panel.
 *
 * Same three questions the shared `/api` fence asks for its loopback authority,
 * minus deployment-specific `trustedHosts` (a plugin does not read that config):
 * the Host header must be loopback (DNS rebinding cannot forge it), a browser
 * cross-site marker is refused, and an Origin, when attached, must match.
 *
 * @param req - the incoming request.
 * @returns true when the request is same-origin loopback.
 */
export function isTrustedPanelRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return false
  let hostUrl: URL
  try {
    // `http:` is a WHATWG special scheme: parsing yields a non-empty hostname.
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const name = hostUrl.hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(name) && !name.startsWith('127.')) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** What the route needs from `apply()`. */
export interface PanelRouteOptions {
  /** The plugin runtime the payload is read from. */
  readonly runtime: Runtime
  /** Epoch ms recorded by `apply()`. */
  readonly startedAt: number
  /** Live facts (engine health). */
  readonly facts?: PanelFacts
  /** Plugin logger. */
  readonly logger: LoggerLike
}

/**
 * Build the route handler.
 * @param options - runtime, start time, facts.
 * @returns a Node HTTP handler owning the full response lifecycle.
 */
export function createPanelHandler(options: PanelRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { runtime, startedAt } = options
  return async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    if (!isTrustedPanelRequest(req)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const endpoint = pathname.slice(PANEL_CHANNEL.length).replace(/^\//u, '')
    let result: PanelResult
    if (endpoint !== PANEL_STATUS_ENDPOINT) {
      result = { ok: false, error: { code: 'unknown_endpoint', message: 'unknown panel endpoint' } }
    } else {
      try {
        result = { ok: true, value: await buildPanelPayload(runtime, startedAt, options.facts ?? {}) }
      } catch (error) {
        // Never leak a stack, a path or a message to the browser; the ledger
        // records the failure with the same coarse shape as every other one.
        runtime.internalError('panel', error)
        result = { ok: false, error: { code: 'panel_failed', message: 'panel payload unavailable' } }
      }
    }
    const body = JSON.stringify(result)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      // Counters move between reads and nothing here is cacheable.
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }
}

/** Structural read of the `webServer` service (its package is optional here). */
interface WebServerLike {
  register(route: {
    readonly kind: 'prefix' | 'exact'
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Register the panel route when this profile provides the Web GUI carrier.
 *
 * @param ctx - the plugin's Cordis context.
 * @param options - runtime, start time, facts and logger.
 */
export function registerPanelRoute(ctx: Context, options: PanelRouteOptions): void {
  const { runtime, logger } = options
  // Mount-time evidence: the panel is optional, so "which outcome happened" must
  // be answerable from the ledger alone (headless profiles have no webServer).
  const probe = (state: string, detail?: string): void => {
    try {
      runtime.audit('invariant_probe', {
        decision: 'info',
        reason_code: 'panel_route',
        labels: { state, ...(detail === undefined ? {} : { detail: detail.slice(0, 80) }) },
      })
    } catch {
      // Evidence must never be the reason the load fails.
    }
  }
  ctx.inject(['webServer'], (webCtx) => {
    let webServer: WebServerLike | undefined
    try {
      // `get()` first: it answers the service instance directly, while property
      // access is the receiver-bound path Cordis traces (and the one that can
      // throw for a third-party fiber).
      webServer = (webCtx.get('webServer') as WebServerLike | undefined)
        ?? (webCtx as unknown as { readonly webServer?: WebServerLike }).webServer
    } catch (error) {
      probe('web_server_unavailable', error instanceof Error ? error.message : String(error))
      return
    }
    if (webServer === undefined || typeof webServer.register !== 'function') {
      probe('web_server_unavailable')
      return
    }
    const server = webServer
    try {
      webCtx.effect(
        () => server.register({ kind: 'prefix', path: PANEL_CHANNEL, handler: createPanelHandler(options) }),
        'safeharness: panel route',
      )
      probe('route_registered')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(`safeharness: panel route registration failed: ${message}`)
      probe('route_failed', message)
    }
  })
}
