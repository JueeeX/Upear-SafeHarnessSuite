/**
 * Patrol (plan §6.10, T3.4): the external self-check that runs *outside* the
 * turn — denial-rate, health probes, posture drift, ledger reconciliation and
 * the optional Feishu notification.
 *
 * Design rules, in priority order:
 *
 *  1. **No content leaves the process.** Findings carry codes, severities and
 *     counts only: no URLs, no webhook, no paths, no thresholds from config.
 *     The notification body is the literal `Upear SafeHarness: N FAIL / M WARN`
 *     sentence and nothing else.
 *  2. **Every check is three-state.** A check that cannot observe its input is
 *     SKIP, never OK: "we did not look" must not read as "it was fine".
 *  3. **The patrol itself never throws.** A failing check is an internal error
 *     (exit 2) reported through the return value; a failing notification is a
 *     WARN, never a FAIL and never an exception. Patrol runs unattended, so an
 *     exception would simply vanish.
 *  4. **No I/O seams are hard-coded.** Network is injected through
 *     {@link PatrolProbe.fetchImpl} / {@link PatrolProbe.notifyImpl} and time
 *     through {@link PatrolProbe.now}, which is what makes the checks testable
 *     without touching the network (§T3.4).
 *
 * The report itself is recorded as a `patrol_report` audit record so an
 * external monitor can tell that patrol actually ran, and how it ended.
 * @module
 */
import type { LedgerRecord } from '../audit/types.js'
import type { Runtime } from '../runtime.js'

/** Process exit codes (tool return value / command status, plan §6.10 #6). */
export const PATROL_EXIT = { clean: 0, fail: 1, error: 2 } as const

/** One of {@link PATROL_EXIT}. */
export type PatrolExitCode = 0 | 1 | 2

/** Every check code this version can emit (also the legal `include` values). */
export const PATROL_CODES = [
  'audit_rate',
  'health_probe',
  'config_drift',
  'ledger_reconcile',
  'notify',
] as const

/** One known patrol code. */
export type PatrolCode = (typeof PATROL_CODES)[number]

/** Severity vocabulary shared with posture (plan §6.10). */
export type PatrolSeverity = 'FAIL' | 'WARN' | 'OK' | 'SKIP'

/** One patrol finding. `detail` never carries a configured value, a URL or a secret. */
export interface PatrolFinding {
  readonly code: string
  readonly severity: PatrolSeverity
  readonly detail: string
}

/** Counts over one report's findings plus the "nothing failed and nothing warned" flag. */
export interface PatrolSummary {
  readonly fail: number
  readonly warn: number
  readonly ok: number
  readonly skip: number
  /** True when there is no FAIL and no WARN (SKIP does not make a report dirty). */
  readonly clean: boolean
}

/** One completed patrol run. */
export interface PatrolReport {
  /** ISO-8601 UTC timestamp of the injected clock at run start. */
  readonly ranAt: string
  readonly findings: readonly PatrolFinding[]
  readonly summary: PatrolSummary
  readonly exitCode: PatrolExitCode
  /** Whether the Feishu notification was actually delivered. */
  readonly notified: boolean
  /** Set only when patrol itself failed (exit code 2); never raw error text. */
  readonly internalError?: string
}

/** Injected seams; absent probes degrade to SKIP (or the default implementation). */
export interface PatrolProbe {
  sandboxMode?(): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
  approvalPolicy?(): 'ask' | 'never' | undefined
  /** Current posture; the drift check compares it with the last recorded report. */
  posture?(): Promise<{ findings: readonly { code: string; severity: string }[] }>
  fetchImpl?(url: string, init: { method: 'GET'; signal: AbortSignal; redirect: 'manual' }): Promise<{ status: number }>
  notifyImpl?(webhook: string, text: string): Promise<void>
  now?(): number
}

/** Options for {@link runPatrol}. */
export interface PatrolOptions {
  /** Restrict the run to these codes; an unknown code is an internal error (exit 2). */
  readonly include?: readonly string[]
}

/** Tail of the ledger a patrol looks at: enough for a window plus its baselines. */
const QUERY_LIMIT = 500
/** Health probe deadline (plan §6.10 #2: "超时 = FAIL"). */
const HEALTH_TIMEOUT_MS = 3000
/** Notification deadline; a hung webhook must not hang the patrol. */
const NOTIFY_TIMEOUT_MS = 3000
/** Relative disagreement between the two ledger counters that is still "reconciled". */
const RECONCILE_TOLERANCE = 0.1

/** Build a finding. */
function finding(code: PatrolCode, severity: PatrolSeverity, detail: string): PatrolFinding {
  return { code, severity, detail }
}

/** Fold findings into counts plus a `clean` flag (same shape as posture). */
export function summarizePatrol(findings: readonly PatrolFinding[]): PatrolSummary {
  let fail = 0
  let warn = 0
  let ok = 0
  let skip = 0
  for (const item of findings) {
    if (item.severity === 'FAIL') fail += 1
    else if (item.severity === 'WARN') warn += 1
    else if (item.severity === 'OK') ok += 1
    else skip += 1
  }
  return { fail, warn, ok, skip, clean: fail === 0 && warn === 0 }
}

/** Default health probe: one GET, no redirects, 3s deadline, status only. */
async function defaultFetch(
  url: string,
  init: { method: 'GET'; signal: AbortSignal; redirect: 'manual' },
): Promise<{ status: number }> {
  const response = await fetch(url, init)
  return { status: response.status }
}

/**
 * Default notification sink: POST the Feishu text-message envelope, fail on
 * non-2xx. The only variable content is the counts-only sentence built by
 * {@link notificationText}; the envelope keys are a constant.
 */
async function defaultNotify(webhook: string, text: string): Promise<void> {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text } }),
    signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error('webhook rejected the notification')
}

/** Read the injected clock once, refusing a non-finite value. */
function readClock(probe: PatrolProbe): number {
  const value = probe.now === undefined ? Date.now() : probe.now()
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('patrol: clock probe failed')
  }
  return value
}

/** Validate the resolved patrol config; a broken one is an internal error, not a finding. */
function validateConfig(patrol: Runtime['config']['patrol']): void {
  const ok = Number.isFinite(patrol.windowMinutes) && patrol.windowMinutes > 0
    && Number.isFinite(patrol.baselineWindows) && patrol.baselineWindows >= 0
    && Number.isFinite(patrol.factor) && patrol.factor > 0
    && Number.isFinite(patrol.minCount) && patrol.minCount >= 0
  if (!ok) throw new Error('patrol: invalid configuration')
}

/** Resolve `include` to an ordered, de-duplicated set of known codes. */
function selectChecks(include: readonly string[] | undefined): readonly PatrolCode[] {
  if (include === undefined) return PATROL_CODES
  const wanted = new Set<PatrolCode>()
  for (const raw of include) {
    if (!isPatrolCode(raw)) {
      const name = typeof raw === 'string' ? ` ${raw.slice(0, 40)}` : ''
      throw new Error(`patrol: unknown check${name}`)
    }
    wanted.add(raw)
  }
  // Canonical order regardless of the caller's order: the summary must be stable.
  return PATROL_CODES.filter((code) => wanted.has(code))
}

/** Whether a caller-supplied value names a known check. */
function isPatrolCode(value: unknown): value is PatrolCode {
  return typeof value === 'string' && (PATROL_CODES as readonly string[]).includes(value)
}

/** State shared by the checks of one run. */
interface PatrolContext {
  readonly runtime: Runtime
  readonly probe: PatrolProbe
  /** Epoch ms from the injected clock. */
  readonly now: number
  /** `patrol.windowMinutes` in ms. */
  readonly windowMs: number
  readonly baselineWindows: number
  readonly factor: number
  readonly minCount: number
  /** Newest ≤{@link QUERY_LIMIT} ledger records, read at most once per run. */
  readonly tail: () => Promise<readonly LedgerRecord[]>
}

/**
 * Audit rate: denials in the current window against the mean of the baseline
 * windows before it (plan §6.10 #1).
 *
 * A deny is a record whose `decision` is `deny` (input denials, tool denials and
 * ask-without-approver denials all carry it); a warning-mode record does not
 * count. No records at all means SKIP: with an empty ledger there is no rate to
 * judge, and OK would overstate what was observed.
 */
function auditRate(ctx: PatrolContext, records: readonly LedgerRecord[]): PatrolFinding {
  if (records.length === 0) {
    return finding('audit_rate', 'SKIP', 'no ledger records; denial rate not computed')
  }
  const currentStart = ctx.now - ctx.windowMs
  const baselineStart = currentStart - ctx.baselineWindows * ctx.windowMs
  let current = 0
  let baseline = 0
  for (const record of records) {
    if (record.decision !== 'deny') continue
    const ts = Date.parse(record.ts)
    if (!Number.isFinite(ts) || ts > ctx.now) continue
    if (ts >= currentStart) current += 1
    else if (ctx.baselineWindows > 0 && ts >= baselineStart) baseline += 1
  }
  const baselineMean = ctx.baselineWindows > 0 ? baseline / ctx.baselineWindows : 0
  const threshold = Math.max(ctx.minCount, ctx.factor * baselineMean)
  // `current > 0` keeps `minCount: 0` from turning a quiet ledger into a FAIL.
  if (current > 0 && current >= threshold) {
    return finding('audit_rate', 'FAIL', `denial count ${current} reached the patrol threshold`)
  }
  return finding('audit_rate', 'OK', `denial count ${current} stayed below the patrol threshold`)
}

/**
 * Health probe: any HTTP response below 500 (401/403 included) proves the
 * endpoint is alive; 5xx, a refused connection or the 3s timeout is a FAIL
 * (plan §6.10 #2). One dead endpoint fails the check; the detail never names it.
 */
async function healthProbe(ctx: PatrolContext): Promise<PatrolFinding> {
  const urls = ctx.runtime.config.patrol.healthUrls
  if (urls.length === 0) return finding('health_probe', 'SKIP', 'no health endpoint configured')
  const fetchImpl = ctx.probe.fetchImpl ?? defaultFetch
  let failed = 0
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
        redirect: 'manual',
      })
      if (!(response.status < 500)) failed += 1
    } catch {
      failed += 1
    }
  }
  if (failed > 0) {
    return finding('health_probe', 'FAIL', 'one or more health endpoints are unreachable or returned 5xx')
  }
  return finding('health_probe', 'OK', 'all health endpoints responded below 500')
}

/**
 * Config drift: the current posture's non-OK code set against the `rule_ids` of
 * the last `posture_report` record — the same set the posture report wrote
 * (plan §6.10 #3). Either direction of difference is drift; the detail carries
 * codes only, never a mode or a threshold value.
 */
async function configDrift(ctx: PatrolContext): Promise<PatrolFinding> {
  if (ctx.probe.posture === undefined) {
    return finding('config_drift', 'SKIP', 'posture probe not available')
  }
  const current = await ctx.probe.posture()
  const history = await ctx.runtime.ledger.query({ kind: 'posture_report', limit: 1 })
  const previousRecord = history[0]
  if (previousRecord === undefined) {
    return finding('config_drift', 'SKIP', 'no previous posture report in the ledger')
  }
  const previous = new Set<string>(previousRecord.rule_ids ?? [])
  const currentNonOk = new Set<string>()
  for (const item of current?.findings ?? []) {
    if (item.severity !== 'OK') currentNonOk.add(item.code)
  }
  const drift: string[] = []
  for (const code of new Set<string>([...previous, ...currentNonOk])) {
    if (previous.has(code) !== currentNonOk.has(code)) drift.push(code)
  }
  if (drift.length > 0) {
    drift.sort()
    return finding('config_drift', 'WARN', `posture drift on ${drift.join(', ')}`)
  }
  return finding('config_drift', 'OK', 'posture matches the last recorded report')
}

/**
 * Ledger reconciliation: the approval bridge records a pair for every ask —
 * `tool_asked` when the tool guard asks, then `approval_decided` once the ask is
 * answered — so the two counters should agree (plan §6.10 #4).
 *
 * D9 deviation: the plan says to read the DSH session log, but a session log is
 * only visible inside a turn, so this check uses our own ledger as the proxy.
 * The bridge records the pair in both modes (`delegate` and `policy`), so the
 * check is mode-independent. Both counters zero means there was nothing to
 * reconcile (SKIP); a relative disagreement above 10% is a WARN, never a FAIL.
 */
function ledgerReconcile(ctx: PatrolContext, records: readonly LedgerRecord[]): PatrolFinding {
  const currentStart = ctx.now - ctx.windowMs
  let asked = 0
  let decided = 0
  for (const record of records) {
    const ts = Date.parse(record.ts)
    if (!Number.isFinite(ts) || ts < currentStart || ts > ctx.now) continue
    if (record.kind === 'tool_asked') asked += 1
    else if (record.kind === 'approval_decided') decided += 1
  }
  if (asked === 0 && decided === 0) {
    return finding('ledger_reconcile', 'SKIP', 'no ask or approval-decision records in the window')
  }
  // Denominator is at least 1 so "asks without any decision" is a full drift.
  const ratio = Math.abs(asked - decided) / Math.max(1, asked, decided)
  if (ratio > RECONCILE_TOLERANCE) {
    return finding(
      'ledger_reconcile',
      'WARN',
      `approval asks and decisions disagree (${asked} vs ${decided})`,
    )
  }
  return finding(
    'ledger_reconcile',
    'OK',
    `approval asks and decisions agree (${asked} vs ${decided})`,
  )
}

/** The exact notification body: counts only, no payload, no path, no secret. */
function notificationText(summary: PatrolSummary): string {
  return `Upear SafeHarness: ${summary.fail} FAIL / ${summary.warn} WARN`
}

/** Build a report, deriving the summary from the findings. */
function buildReport(
  ranAt: string,
  findings: readonly PatrolFinding[],
  exitCode: PatrolExitCode,
  notified: boolean,
  internalError?: string,
): PatrolReport {
  return {
    ranAt,
    findings,
    summary: summarizePatrol(findings),
    exitCode,
    notified,
    ...(internalError === undefined ? {} : { internalError }),
  }
}

/** Record the report in the ledger (best effort) and return it unchanged. */
function record(runtime: Runtime, report: PatrolReport): PatrolReport {
  const { summary } = report
  runtime.audit('patrol_report', {
    decision: report.internalError !== undefined ? 'error' : summary.fail > 0 ? 'fail' : summary.warn > 0 ? 'warn' : 'ok',
    rule_ids: report.findings.filter((item) => item.severity !== 'OK').map((item) => item.code),
    metrics: { fail: summary.fail, warn: summary.warn, ok: summary.ok, skip: summary.skip },
    labels: { exit_code: String(report.exitCode), notified: String(report.notified) },
  })
  return report
}

/** A report for a patrol-level failure (exit 2), optionally carrying partial findings. */
function errorReport(
  ranAt: string,
  message: string,
  findings: readonly PatrolFinding[] = [],
): PatrolReport {
  return buildReport(ranAt, findings, PATROL_EXIT.error, false, message)
}

/** Fallback `ranAt` for failures that happen before the clock can be read. */
function wallClockIso(): string {
  try {
    return new Date().toISOString()
  } catch {
    return '1970-01-01T00:00:00.000Z'
  }
}

/**
 * Run one patrol.
 *
 * @param runtime - shared runtime (config, ledger, audit sink).
 * @param probe - injected seams; anything absent degrades to a default or SKIP.
 * @param options - `include` restricts the run to a subset of {@link PATROL_CODES}.
 * @returns the report; the function never rejects. Patrol-level failures are
 *   reported as `exitCode: 2` plus `internalError`, and still land in the ledger.
 */
export async function runPatrol(
  runtime: Runtime,
  probe: PatrolProbe,
  options: PatrolOptions = {},
): Promise<PatrolReport> {
  let selected: readonly PatrolCode[]
  try {
    validateConfig(runtime.config.patrol)
    selected = selectChecks(options.include)
  } catch (error) {
    return record(runtime, errorReport(wallClockIso(), messageOf(error)))
  }

  let now: number
  try {
    now = readClock(probe)
  } catch (error) {
    return record(runtime, errorReport(wallClockIso(), messageOf(error)))
  }
  const ranAt = new Date(now).toISOString()
  const patrol = runtime.config.patrol
  let tailPromise: Promise<readonly LedgerRecord[]> | undefined
  const tail = (): Promise<readonly LedgerRecord[]> => {
    tailPromise ??= runtime.ledger.query({ limit: QUERY_LIMIT })
    return tailPromise
  }
  const ctx: PatrolContext = {
    runtime,
    probe,
    now,
    windowMs: patrol.windowMinutes * 60_000,
    baselineWindows: patrol.baselineWindows,
    factor: patrol.factor,
    minCount: patrol.minCount,
    tail,
  }

  const findings: PatrolFinding[] = []
  for (const code of selected) {
    if (code === 'notify') continue // notification runs after the report is known
    try {
      switch (code) {
        case 'audit_rate':
          findings.push(auditRate(ctx, await tail()))
          break
        case 'health_probe':
          findings.push(await healthProbe(ctx))
          break
        case 'config_drift':
          findings.push(await configDrift(ctx))
          break
        case 'ledger_reconcile':
          findings.push(ledgerReconcile(ctx, await tail()))
          break
      }
    } catch {
      // A throwing check is a patrol bug/observability hole: exit 2, and the raw
      // error is not returned because it could quote a URL or a config value.
      return record(runtime, errorReport(ranAt, `patrol: ${code} check failed`, findings))
    }
  }

  // --- notification -----------------------------------------------------------
  // Only a dirty report is worth waking an operator for. Delivery failure is a
  // WARN by design: the evidence already exists in the report/ledger.
  let notified = false
  if (selected.includes('notify')) {
    const before = summarizePatrol(findings)
    const webhook = patrol.feishuWebhook.trim()
    if (webhook.length === 0) {
      findings.push(finding('notify', 'SKIP', 'no webhook configured'))
    } else if (before.clean) {
      findings.push(finding('notify', 'SKIP', 'report is clean; no notification sent'))
    } else {
      const notifyImpl = probe.notifyImpl ?? defaultNotify
      try {
        await notifyImpl(patrol.feishuWebhook, notificationText(before))
        notified = true
        findings.push(finding('notify', 'OK', 'notification sent'))
      } catch {
        findings.push(finding('notify', 'WARN', 'notify_failed: webhook delivery failed'))
      }
    }
  }

  const summary = summarizePatrol(findings)
  const exitCode: PatrolExitCode = summary.fail > 0 ? PATROL_EXIT.fail : PATROL_EXIT.clean
  return record(runtime, buildReport(ranAt, findings, exitCode, notified))
}

/** Message of a patrol-level input error (always our own wording, never raw). */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('patrol: ')) return error.message
  return 'patrol: internal error'
}
