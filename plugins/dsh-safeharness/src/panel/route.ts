/**
 * The panel's Host half (T5.3): the HTTP endpoints the browser half calls.
 *
 *  - `status`        read: one payload (counters, events, sessions, rules).
 *  - `patrol`        runs one patrol (writes `patrol_report`, may notify).
 *  - `draft`         asks the configured drafting route for ONE candidate rule
 *                    (never applied; returns YAML + shape warnings).
 *  - `schedule`      arms/disarms the optional patrol timer (persisted).
 *  - `reload-rules`  re-reads the rule directory without restarting the host.
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
 * Every state-changing call is POST-only and body-gated: a navigation or an
 * `<img>` cannot reach it, and request bodies are bounded before parsing.
 * @module
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { LoggerLike, Runtime } from '../runtime.js'
import {
  PANEL_CHANNEL,
  PANEL_DRAFT_ENDPOINT,
  PANEL_PATROL_ENDPOINT,
  PANEL_RELOAD_ENDPOINT,
  PANEL_SCHEDULE_ENDPOINT,
  PANEL_SETTINGS_ENDPOINT,
  PANEL_STATUS_ENDPOINT,
} from './protocol.js'
import type {
  PanelDraftResult,
  PanelDraftValue,
  PanelPatrolReport,
  PanelPatrolResult,
  PanelProbeResult,
  PanelReloadResult,
  PanelResult,
  PanelScheduleResult,
  PanelSettingsPatch,
  PanelSettingsResult,
} from './protocol.js'
import type { DraftKind, DraftResult } from '../draft/rule.js'
import type { PatrolRunner } from './patrol-runner.js'
import { isScheduleInterval, type PatrolScheduler } from './schedule.js'
import type { PanelSettingsHost } from './settings.js'
import { PanelSettingsError } from './settings.js'
import { buildPanelPayload } from './status.js'
import type { PanelFacts } from './status.js'

/** Host names the fence accepts as "this machine". */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Hard cap on any request body the panel parses (never a content channel). */
export const PANEL_MAX_BODY_BYTES = 16 * 1024

/** Longest rule description the draft endpoint accepts. */
export const PANEL_DRAFT_MAX_DESCRIPTION = 2_000

/** Endpoint names in one place, for the method gate and tests. */
const WRITE_ENDPOINTS = new Set<string>([PANEL_PATROL_ENDPOINT, PANEL_DRAFT_ENDPOINT, PANEL_SCHEDULE_ENDPOINT, PANEL_RELOAD_ENDPOINT, PANEL_SETTINGS_ENDPOINT])

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

/** One drafting call, as the route sees it. */
export type PanelDraftRunner = (input: { description: string; kind: DraftKind }) => Promise<DraftResult>

/** What `apply()` may wire; every action is optional for headless profiles/tests. */
export interface PanelRouteOptions {
  /** The plugin runtime the payload is read from. */
  readonly runtime: Runtime
  /** Epoch ms recorded by `apply()`. */
  readonly startedAt: number
  /** Live facts (engine health, rules dir, draft availability, schedule). */
  readonly facts?: PanelFacts
  /** Shared patrol gate; absent makes the endpoint report unavailability. */
  readonly patrolRunner?: PatrolRunner
  /** Rule drafting; absent makes the endpoint report unavailability. */
  readonly draft?: PanelDraftRunner
  /** Patrol timer; absent makes the schedule endpoint report unavailability. */
  readonly schedule?: PatrolScheduler
  /** Re-read the rule directory; absent makes the reload endpoint unavailable. */
  readonly reloadRules?: () => { readonly rules: number; readonly chains: number; readonly hash: string }
  /** Judge/drafting settings; absent makes the settings endpoint unavailable. */
  readonly settings?: PanelSettingsHost
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
export function toPanelPatrol(report: import('../patrol/index.js').PatrolReport): PanelPatrolReport {
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

/** Read a bounded JSON body; `undefined` on too-large/invalid input. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > PANEL_MAX_BODY_BYTES) return undefined
      chunks.push(buffer)
    }
    if (chunks.length === 0) return {}
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** Project one successful draft onto the wire shape. */
function toPanelDraft(result: DraftResult): PanelDraftValue | { readonly code: string; readonly message: string } {
  if (result.status !== 'ok') {
    // Coarse code/field names only: the drafter promises no prompt/content echo.
    return { code: 'draft_unavailable', message: result.reason.slice(0, 200) }
  }
  return {
    status: 'ok',
    name: result.draft.name,
    severity: result.draft.severity,
    category: result.draft.category,
    summary: result.draft.summary,
    yaml: result.draft.yaml,
    warnings: [...result.draft.warnings],
  }
}

/**
 * Build the route handler.
 * @param options - runtime, start time, facts and the optional action runners.
 * @returns a Node HTTP handler owning the full response lifecycle.
 */
export function createPanelHandler(options: PanelRouteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { runtime, startedAt } = options
  let draftRunning = false

  /** One drafting attempt; POST-only, single-flight, availability-gated. */
  const draftEnvelope = async (body: Record<string, unknown>): Promise<PanelDraftResult> => {
    const run = options.draft
    if (run === undefined) {
      return { ok: false, error: { code: 'draft_unavailable', message: 'rule drafting is not wired in this profile' } }
    }
    if (!runtime.config.draft.enabled) {
      return { ok: false, error: { code: 'draft_disabled', message: 'rule drafting is disabled (config draft.enabled: false)' } }
    }
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    if (description.length === 0) {
      return { ok: false, error: { code: 'invalid_body', message: 'description is required' } }
    }
    if (description.length > PANEL_DRAFT_MAX_DESCRIPTION) {
      return { ok: false, error: { code: 'invalid_body', message: 'description is too long' } }
    }
    if (draftRunning) {
      return { ok: false, error: { code: 'draft_in_progress', message: 'a draft is already in progress' } }
    }
    const kind: DraftKind = body.kind === 'chain' ? 'chain' : 'inform'
    draftRunning = true
    try {
      const projected = toPanelDraft(await run({ description, kind }))
      return 'code' in projected
        ? { ok: false, error: { code: projected.code, message: projected.message } }
        : { ok: true, value: projected }
    } catch (error) {
      runtime.internalError('panel-draft', error)
      return { ok: false, error: { code: 'draft_failed', message: 'rule drafting failed' } }
    } finally {
      draftRunning = false
    }
  }

  /** Arm/disarm the timer; validated and persisted by the scheduler. */
  const scheduleEnvelope = async (body: Record<string, unknown>): Promise<PanelScheduleResult> => {
    const scheduler = options.schedule
    if (scheduler === undefined) {
      return { ok: false, error: { code: 'schedule_unavailable', message: 'the patrol timer is not wired in this profile' } }
    }
    if (typeof body.enabled !== 'boolean') {
      return { ok: false, error: { code: 'invalid_body', message: 'enabled must be a boolean' } }
    }
    if (body.enabled) {
      if (!isScheduleInterval(body.intervalMinutes)) {
        return {
          ok: false,
          error: { code: 'invalid_body', message: 'intervalMinutes must be an integer between 5 and 1440' },
        }
      }
      runtime.audit('invariant_probe', {
        decision: 'info',
        reason_code: 'panel_schedule',
        labels: { state: 'schedule_enabled', minutes: String(body.intervalMinutes) },
      })
      return { ok: true, value: scheduler.set(true, body.intervalMinutes) }
    }
    runtime.audit('invariant_probe', {
      decision: 'info',
      reason_code: 'panel_schedule',
      labels: { state: 'schedule_disabled' },
    })
    return { ok: true, value: scheduler.set(false, null) }
  }

  /** Re-read the rule directory; the loader's own gate decides what loads. */
  const reloadEnvelope = (): PanelReloadResult => {
    const reload = options.reloadRules
    if (reload === undefined) {
      return { ok: false, error: { code: 'reload_unavailable', message: 'rule reloading is not wired in this profile' } }
    }
    try {
      return { ok: true, value: reload() }
    } catch (error) {
      runtime.internalError('panel-reload', error)
      return { ok: false, error: { code: 'reload_failed', message: 'rule reload failed' } }
    }
  }

  /** Read, save or probe the judge/drafting routes. */
  const settingsEnvelope = async (body: Record<string, unknown>): Promise<PanelSettingsResult | PanelProbeResult> => {
    const host = options.settings
    if (host === undefined) {
      return { ok: false, error: { code: 'settings_unavailable', message: 'the settings surface is not wired in this profile' } }
    }
    const op = body.op
    try {
      if (op === 'read') return { ok: true, value: await host.read() }
      if (op === 'probe') return { ok: true, value: await host.probe() }
      if (op !== 'save') return { ok: false, error: { code: 'settings_invalid', message: 'op must be read, save or probe' } }
      const patch = body.patch
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, error: { code: 'settings_invalid', message: 'patch must be a JSON object' } }
      }
      return { ok: true, value: await host.save(patch as PanelSettingsPatch) }
    } catch (error) {
      if (error instanceof PanelSettingsError) {
        return { ok: false, error: { code: error.code, message: error.message.slice(0, 200) } }
      }
      runtime.internalError('panel-settings', error)
      return { ok: false, error: { code: 'settings_write_failed', message: 'the settings action failed' } }
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
    const isWrite = WRITE_ENDPOINTS.has(endpoint)
    if (isWrite && req.method !== 'POST') {
      // A state-changing call must not be reachable by a bare GET (a navigation
      // or an <img> src cannot run it).
      send(res, { ok: false, error: { code: 'method_not_allowed', message: `${endpoint} requires POST` } })
      return
    }

    let result: PanelResult | PanelPatrolResult | PanelDraftResult | PanelScheduleResult | PanelReloadResult | PanelSettingsResult | PanelProbeResult
    if (endpoint === PANEL_PATROL_ENDPOINT) {
      const runner = options.patrolRunner
      if (runner === undefined) {
        result = { ok: false, error: { code: 'patrol_unavailable', message: 'patrol is not wired in this profile' } }
      } else {
        const outcome = await runner.run()
        result = outcome.ok
          ? { ok: true, value: toPanelPatrol(outcome.report) }
          : { ok: false, error: { code: outcome.code, message: patrolMessage(outcome.code) } }
      }
    } else if (endpoint === PANEL_DRAFT_ENDPOINT) {
      const body = await readJsonBody(req)
      result = body === undefined
        ? { ok: false, error: { code: 'invalid_body', message: 'body must be a JSON object' } }
        : await draftEnvelope(body)
    } else if (endpoint === PANEL_SCHEDULE_ENDPOINT) {
      const body = await readJsonBody(req)
      result = body === undefined
        ? { ok: false, error: { code: 'invalid_body', message: 'body must be a JSON object' } }
        : await scheduleEnvelope(body)
    } else if (endpoint === PANEL_RELOAD_ENDPOINT) {
      result = reloadEnvelope()
    } else if (endpoint === PANEL_SETTINGS_ENDPOINT) {
      const body = await readJsonBody(req)
      result = body === undefined
        ? { ok: false, error: { code: 'invalid_body', message: 'body must be a JSON object' } }
        : await settingsEnvelope(body)
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

/** Stable, content-free message per patrol failure code. */
function patrolMessage(code: 'patrol_in_progress' | 'patrol_cooldown' | 'patrol_failed'): string {
  switch (code) {
    case 'patrol_in_progress': return 'a patrol is already running'
    case 'patrol_cooldown': return 'patrol ran moments ago; try again shortly'
    case 'patrol_failed': return 'patrol failed'
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
 * @param options - runtime, start time, facts, action runners and logger.
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
