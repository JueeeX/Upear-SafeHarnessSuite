/**
 * Wire types shared by the panel's Host RPC handler and its browser half.
 *
 * Type-only by contract (T5.3): the client bundle imports these with
 * `import type`, so this module must not gain a runtime value — the browser
 * module table has exactly ten specifiers, and none of ours is among them.
 * @module
 */

/** Absolute logical RPC channel serving the panel (not `/api`, which is reserved). */
export const PANEL_CHANNEL = '/safeharness'

/** Endpoint on that channel that returns {@link PanelPayload}. */
export const PANEL_STATUS_ENDPOINT = 'status'

/** Endpoint that runs one patrol and returns its report. */
export const PANEL_PATROL_ENDPOINT = 'patrol'

/** Endpoint that asks the drafting route for one candidate rule. */
export const PANEL_DRAFT_ENDPOINT = 'draft'

/** Endpoint that arms/disarms the optional patrol timer. */
export const PANEL_SCHEDULE_ENDPOINT = 'schedule'

/** Endpoint that re-reads the rule directory. */
export const PANEL_RELOAD_ENDPOINT = 'reload-rules'

/** Endpoint that reads/saves the judge and drafting routes, and probes the judge. */
export const PANEL_SETTINGS_ENDPOINT = 'settings'

/**
 * One enforcement/approval event as the panel shows it. Deliberately a
 * projection, not the ledger record: the ledger may grow fields, and the GUI
 * must never be the reason a new field reaches a browser.
 */
export interface PanelEvent {
  /** ISO-8601 UTC timestamp of the record. */
  readonly ts: string
  /** Record kind (`input_denied`, `tool_denied`, `tool_result_flagged`, …). */
  readonly kind: string
  /** Disposition: `deny` / `warn` / `block` / `ask` / `asked` / `fail` / `error`. */
  readonly decision: string
  /** Stable reason code; empty when the record carried none. */
  readonly reasonCode: string
  /** Tool name, when the event is a tool-surface one. */
  readonly tool?: string
  /** Rule severity (`critical` … `info`), when a rule governed the decision. */
  readonly severity?: string
  /** Rule category, when known. */
  readonly category?: string
  /** Rule identifiers that fired (codes, never matched text). */
  readonly ruleIds: readonly string[]
  /** Number of rules that fired (never the rule text). */
  readonly rules: number
  /** First 8 characters of the session id, for telling conversations apart. */
  readonly session?: string
  /** Absolute project directory the session was created in, when known. */
  readonly workspace?: string
  /** Latest session title, when the host exposed one (display-only metadata). */
  readonly title?: string
  /** First 8 characters of the sha256 of the canonical tool arguments. */
  readonly argsHash?: string
}

/**
 * One tracked session, as the panel lists it. Built from the plugin's own state
 * (this process), so a live conversation is visible before its first denial.
 */
export interface PanelSession {
  /** First 8 characters of the session id. */
  readonly id: string
  /** Absolute project directory, when the host exposed one. */
  readonly workspace?: string
  /** Session creation time (epoch ms), when known. */
  readonly createdAt?: number
  /** Latest session title, when the host exposed one. */
  readonly title?: string
  /** Last time the session produced an event (epoch ms). */
  readonly lastSeenAt: number
  /** Tool calls observed for this session. */
  readonly calls: number
  /** Per-session decision counters. */
  readonly allow: number
  readonly warn: number
  readonly deny: number
  readonly ask: number
  /**
   * True when this row comes from the persisted session index and this process
   * has not seen a call yet: the counters are 0 because they are per process,
   * while the workspace/title come from the last session that used the id.
   */
  readonly historical?: boolean
}

/** How much of the ledger the event list was built from. */
export interface PanelWindow {
  /** Records read from the ledger tail. */
  readonly scanned: number
  /** Enforcement/approval events kept for display. */
  readonly kept: number
  /** Oldest displayed event, or null when none. */
  readonly since: string | null
}

/** Outcome counters, per process. */
export interface PanelCounters {
  readonly allow: number
  readonly warn: number
  readonly deny: number
  readonly ask: number
  readonly auditBlocked: number
  readonly internalErrors: number
}

/** Enforcement mode in force per seam. */
export interface PanelModes {
  readonly input: string
  readonly tools: string
  readonly results: string
  readonly output: string
  readonly approval: string
}

/** Audit sink health. */
export interface PanelLedger {
  readonly enabled: boolean
  readonly writable: boolean
  readonly records: number
  readonly failures: number
  readonly lastWriteAt: number | null
  /** Absolute path of the active ledger file (an operator path, never content). */
  readonly path: string | null
}

/** Input engine state (built-in, or the optional Python sidecar). */
export interface PanelEngine {
  readonly kind: string
  readonly status: string
  readonly rulesStale: boolean
  readonly pending: number
  readonly badLines: number
}

/** One compiled rule (or chain) as the rules tab lists it. */
export interface PanelRule {
  /** `rule` for a deny/inform regex, `chain` for a two-leg tool sequence. */
  readonly kind: 'rule' | 'chain'
  /** Rule name (also the identifier the ledger records). */
  readonly name: string
  /** Severity label. */
  readonly severity: string
  /** Category label. */
  readonly category: string
  /** Source file (relative to the rules dir) or `inline`. */
  readonly origin: string
  /** Pattern for a rule; `first → then` summary for a chain. */
  readonly detail: string
  /** Hits inside the current event window (coarse activity, not a verdict). */
  readonly hits: number
}

/** Patrol schedule as the panel shows it. */
export interface PanelSchedule {
  /** Whether the timer is armed. */
  readonly enabled: boolean
  /** Interval in minutes; null when disabled. */
  readonly intervalMinutes: number | null
  /** Epoch ms of the next scheduled run, when enabled. */
  readonly nextAt: number | null
  /** Epoch ms of the last scheduled run, when any. */
  readonly lastRunAt: number | null
  /** False when the schedule could not be written to disk (memory-only). */
  readonly persisted: boolean
}

/** Rule-drafting availability (the panel's "AI 起草" form). */
export interface PanelDraft {
  readonly enabled: boolean
  readonly maxChars: number
}

/** Light judge facts the overview shows without loading the settings tab. */
export interface PanelJudgeFact {
  readonly enabled: boolean
  readonly scope: string
  readonly provider: string
  readonly model: string
  /** False when this profile composes no `llm` service to call. */
  readonly available: boolean
}

/** One selectable model on the settings tab. */
export interface PanelModelOption {
  readonly id: string
  readonly name: string
}

/** One provider route and the models its adapter advertises. */
export interface PanelProviderOption {
  readonly id: string
  readonly name: string
  readonly models: readonly PanelModelOption[]
}

/** Editable judge configuration plus why it may be read-only. */
export interface PanelJudgeSettings {
  readonly enabled: boolean
  /** `flagged` judges only structurally flagged output; `always` judges all. */
  readonly scope: 'flagged' | 'always'
  readonly provider: string
  readonly model: string
  readonly maxChars: number
  readonly timeoutMs: number
  /** False when this profile has no `llm` service. */
  readonly available: boolean
  /** False when the host exposes no settings service or no editable entry. */
  readonly configurable: boolean
}

/** Drafting route (empty provider/model means "reuse the judge route"). */
export interface PanelDraftSettings {
  readonly enabled: boolean
  readonly provider: string
  readonly model: string
}

/** Everything the settings tab renders (one `settings` call). */
export interface PanelSettingsValue {
  readonly preset: string
  readonly judge: PanelJudgeSettings
  readonly draft: PanelDraftSettings
  /** Provider/model catalog for the two route pickers (bounded). */
  readonly providers: readonly PanelProviderOption[]
  /** Absolute profile patch path, or null when the host cannot edit config. */
  readonly configPath: string | null
}

/** Fields one save may change; omitted fields keep their current value. */
export interface PanelSettingsPatch {
  readonly judge?: {
    readonly enabled?: boolean
    readonly scope?: 'flagged' | 'always'
    readonly provider?: string
    readonly model?: string
    readonly maxChars?: number
    readonly timeoutMs?: number
  }
  readonly draft?: {
    readonly enabled?: boolean
    readonly provider?: string
    readonly model?: string
  }
}

/** One judge connectivity probe: status and timing only, never the reply text. */
export interface PanelJudgeProbe {
  readonly status: string
  readonly verdict: string
  readonly blocked: boolean
  readonly route: string
  readonly elapsedMs: number
}

/** Successful settings read/save. */
export interface PanelSettingsOk {
  readonly ok: true
  readonly value: PanelSettingsValue
}

/** What a settings call resolves to. */
export type PanelSettingsResult = PanelSettingsOk | PanelError

/** Successful judge probe. */
export interface PanelProbeOk {
  readonly ok: true
  readonly value: PanelJudgeProbe
}

/** What a judge probe resolves to. */
export type PanelProbeResult = PanelProbeOk | PanelError

/** One successful rule draft (already validated by the loader's own gate). */
export interface PanelDraftValue {
  readonly status: 'ok'
  readonly name: string
  readonly severity: string
  readonly category: string
  /** One-line human summary. */
  readonly summary: string
  /** Complete YAML file body, ready to paste into the rules dir. */
  readonly yaml: string
  /** Shape warnings (never a semantic verdict). */
  readonly warnings: readonly string[]
}

/** Successful draft envelope. */
export interface PanelDraftOk {
  readonly ok: true
  readonly value: PanelDraftValue
}

/** What a draft call resolves to. */
export type PanelDraftResult = PanelDraftOk | PanelError

/** Successful schedule update. */
export interface PanelScheduleOk {
  readonly ok: true
  readonly value: PanelSchedule
}

/** What a schedule call resolves to. */
export type PanelScheduleResult = PanelScheduleOk | PanelError

/** Successful rule reload. */
export interface PanelReloadOk {
  readonly ok: true
  readonly value: { readonly rules: number; readonly chains: number; readonly hash: string }
}

/** What a rule reload resolves to. */
export type PanelReloadResult = PanelReloadOk | PanelError

/** Everything the SafeHarness settings tab renders. */
export interface PanelPayload {
  /** When the Host produced the payload. */
  readonly generatedAt: string
  /** Plugin version that produced it. */
  readonly version: string
  /** Active preset. */
  readonly preset: string
  /** Milliseconds since `apply()`. */
  readonly uptimeMs: number
  /** Sessions the plugin has seen. */
  readonly sessions: number
  /** Tracked sessions, newest activity first (bounded page). */
  readonly sessionDetails: readonly PanelSession[]
  /** Compiled rule set identity (hash truncated for display). */
  readonly rules: { readonly hash: string; readonly count: number; readonly chains: number }
  /** Rules and chains for the rules tab, ordered as compiled. */
  readonly rulesDetail: readonly PanelRule[]
  /** Extra rule directory the loader reads (empty = packaged rules only). */
  readonly rulesDir: string
  /** Seam modes. */
  readonly modes: PanelModes
  /** Decision counters. */
  readonly counters: PanelCounters
  /** Audit sink health. */
  readonly ledger: PanelLedger
  /** Engine facts. */
  readonly engine: PanelEngine
  /** Rule-drafting availability. */
  readonly draft: PanelDraft
  /** Semantic-judge configuration facts (route, scope, availability). */
  readonly judge: PanelJudgeFact
  /** Patrol schedule. */
  readonly schedule: PanelSchedule
  /** Enforcement/approval events, oldest first. */
  readonly recentEvents: readonly PanelEvent[]
  /** How much of the ledger tail {@link recentEvents} was built from. */
  readonly eventWindow: PanelWindow
}

/** Successful RPC envelope. */
export interface PanelOk {
  readonly ok: true
  readonly value: PanelPayload
}

/** Failed RPC envelope (the Host's own result shape, structurally). */
export interface PanelError {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

/** One patrol finding (codes and counts only — patrol's own contract). */
export interface PanelFinding {
  /** Check code (`audit_rate`, `health_probe`, …). */
  readonly code: string
  /** FAIL / WARN / OK / SKIP. */
  readonly severity: string
  /** Short, non-configured detail. */
  readonly detail: string
}

/** One completed patrol, as the panel renders it. */
export interface PanelPatrolReport {
  /** ISO-8601 UTC timestamp of the run. */
  readonly ranAt: string
  /** Process-style exit code: 0 clean, 1 FAIL, 2 patrol itself errored. */
  readonly exitCode: 0 | 1 | 2
  /** Finding counts. */
  readonly summary: { readonly fail: number; readonly warn: number; readonly ok: number; readonly skip: number; readonly clean: boolean }
  /** Findings, in the order the checks ran. */
  readonly findings: readonly PanelFinding[]
  /** Whether every configured notification channel accepted the message. */
  readonly notified: boolean
  /** Set only when patrol itself failed (exit 2). */
  readonly internalError?: string
}

/** Successful patrol envelope. */
export interface PanelPatrolOk {
  readonly ok: true
  readonly value: PanelPatrolReport
}

/** What a patrol call resolves to. */
export type PanelPatrolResult = PanelPatrolOk | PanelError
/** What one panel RPC call resolves to. */
export type PanelResult = PanelOk | PanelError
