/**
 * The panel's Host half (T5.3): two read-only-or-bounded HTTP endpoints the
 * browser half calls — `status` (read) and `patrol` (runs one patrol, which
 * appends a `patrol_report` record and may notify).
 *
 * Why a plain `webServer` route and not a Connection RPC channel: a third-party
 * profile plugin cannot use `connection.rpc.handle()`. That helper mounts its
 * route through the *receiver* context Cordis binds to the service accessor, and
 * on the shipped 0.2.2 host that receiver has no `webServer` in its fiber chain
 * — the registration throws "cannot get property without inject" (measured; see
 * the evidence file). The route below therefore carries the same browser-trust
 * fence itself, mirroring `isTrustedApiRequest` for the loopback authority: Host
 * header must name a loopback authority, a cross-site marker is refused, and when
 * an Origin is present it must be exactly this authority.
 *
 * The route exists only when the profile composes `webServer` (the Web GUI
 * bundles do; headless profiles do not). `patrol` is the only state-changing
 * call: it is POST-only, single-flight, and rate-limited by a cooldown window.
 * @module
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { LoggerLike, Runtime } from '../runtime.js'
import { PANEL_CHANNEL, PANEL_PATROL_ENDPOINT, PANEL_STATUS_ENDPOINT } from './protocol.js'
import type { PanelPatrolReport, PanelPatrolResult, PanelResult } from './protocol.js'
import type { PatrolReport } from '../patrol/index.js'
import { buildPanelPayload } from './status.js'
import type { PanelFacts } from './status.js'

/** Host names the fence accepts as "this machine". */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Minimum gap between panel-triggered patrols (the endpoint is script-reachable). */
export const PANEL_PATROL_COOLDOWN_MS = 5_000

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
  /** Runs one patrol; absent (older wiring or tests) makes the endpoint report unavailability. */
  readonly patrol?: () => Promise<PatrolReport>
  /** Minimum gap between panel-triggered patrols, so a held Enter cannot spam the ledger. */
  readonly patrolCooldownMs?: number
  /** Plugin logger. */
  readonly logger: LoggerLike
}

/**
 * Project a patrol report onto the wire shape.
 *
 * The projection is deliberate: patrol already promises that findings carry
 * codes, severities and counts only, but the browser should see an explicit
 * field list rather than whatever the report grows next.
 *
 * @param report - the patrol run.
 * @returns the browser-facing report.
 */
export function toPanelPatrol(report: PatrolReport): PanelPatrolReport {
  return {
    ranAt: report.ranAt,
    exitCode: report.exitCode,
    summary: {
      fail: report.summary.fail,
      warn: report.summary.warn,
      ok: report.summary.ok,
      skip: report.summary.skip,
      clean: report.summary.clean,
    },
    findings: report.findings.map(finding => ({
      code: finding.code,
      severity: finding.severity,
      detail: finding.detail,
    })),
    notified: report.notified,
    ...(report.internalError === undefined ? {} : { internalError: report.internalError }),
  }
}

/** Answer one JSON envelope and own the response lifecycle. */
function send(res: ServerResponse, result: unknown): void {
  const body = JSON.stringify(result)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    // Counters and patrol results move between reads; nothing here is cacheable.
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Build the route handler.
 * @param options - runtime, start time, facts and the optional patrol runner.
 * @returns a Node HTTP handler owning the full response lifecycle.
 */
export function createPanelHandler(options: PanelRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { runtime, startedAt } = options
  const cooldownMs = options.patrolCooldownMs ?? PANEL_PATROL_COOLDOWN_MS
  // One patrol in flight at a time, and at most one per cooldown window: the
  // endpoint is reachable by any same-origin script in the GUI, so the guard
  // lives here rather than in the button that calls it.
  let patrolRunning = false
  let lastPatrolAt = 0

  /** Run the patrol endpoint with the guards; returns the envelope. */
  const patrolEnvelope = async (): Promise<PanelPatrolResult> => {
    const run = options.patrol
    if (run === undefined) {
      return { ok: false, error: { code: 'patrol_unavailable', message: 'patrol is not wired in this profile' } }
    }
    if (patrolRunning) {
      return { ok: false, error: { code: 'patrol_in_progress', message: 'a patrol is already running' } }
    }
    if (Date.now() - lastPatrolAt < cooldownMs) {
      return { ok: false, error: { code: 'patrol_cooldown', message: 'patrol ran moments ago; try again shortly' } }
    }
    patrolRunning = true
    try {
      return { ok: true, value: toPanelPatrol(await run()) }
    } catch (error) {
      // Patrol itself must never throw; if it does, the panel still answers with
      // a coded envelope and the ledger records the failure.
      runtime.internalError('panel-patrol', error)
      return { ok: false, error: { code: 'patrol_failed', message: 'patrol failed' } }
    } finally {
      patrolRunning = false
      lastPatrolAt = Date.now()
    }
  }

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
    let result: PanelResult | PanelPatrolResult
    if (endpoint === PANEL_PATROL_ENDPOINT) {
      // A state-changing call must not be reachable by a bare GET (a navigation
      // or an <img> src cannot run it).
      result = req.method === 'POST'
        ? await patrolEnvelope()
        : { ok: false, error: { code: 'method_not_allowed', message: 'patrol requires POST' } }
    } else if (endpoint !== PANEL_STATUS_ENDPOINT) {
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
    send(res, result)
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
 * @param options - runtime, start time, facts, patrol runner and logger.
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
