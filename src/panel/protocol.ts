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

/** Endpoint that lands one operator rule file in `rules.dir` and hot-reloads it. */
export const PANEL_RULE_WRITE_ENDPOINT = 'write-rule'

/** Endpoint that reads/saves the judge and drafting routes, and probes the judge. */
export const PANEL_SETTINGS_ENDPOINT = 'settings'

/** Endpoint that returns a bounded NDJSON slice of the redacted ledger. */
export const PANEL_EXPORT_ENDPOINT = 'export'

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

/** Input-guard knobs the panel may change (normalization + semantic judge). */
export interface PanelInputJudge {
  /** `off`, `flagged` (only when a structural rule hit) or `always`. */
  readonly mode: 'off' | 'flagged' | 'always'
  /** Deny when the judge returns no usable verdict. */
  readonly failClosed: boolean
  /** Clean the text (NFKC / zero-width / HTML comments) before matching and rewrite it. */
  readonly normalize: boolean
}

/**
 * Tool-surface detection knobs (1.12.0): the kernel-parity switches that are not
 * an enforcement level — descriptor scanning, the two trajectory thresholds and the
 * SQL table allowlist.
 *
 * Everything here except `allowedTables` is a `volatile` field, so a save takes
 * effect without remounting the plugin; `allowedTables` lives in the patch layer
 * and therefore reloads the entry (the panel says so next to the control).
 */
export interface PanelToolDetection {
  /** `off`, `warn` (record the hit, run the call) or `enforce` (deny the call). */
  readonly descriptorScan: 'off' | 'warn' | 'enforce'
  /** Deny a tool that already failed this many times this session; 0 disables. */
  readonly repeatedAttemptThreshold: number
  /** Shannon-entropy threshold for one string argument, bits/char; 0 disables. */
  readonly entropyThreshold: number
  /** Minimum argument length before the entropy check applies. */
  readonly entropyMinLength: number
  /** SQL table allowlist for scanned arguments; empty means no restriction. */
  readonly allowedTables: readonly string[]
}

/** Result-surface PII scan settings (kernel `memory/sanitizer.py` classes). */
export interface PanelResultPii {
  readonly enabled: boolean
  /** Enabled class names, in the kernel's declaration order. */
  readonly classes: readonly string[]
}

/** Everything the settings tab renders (one `settings` call). */
export interface PanelSettingsValue {
  readonly preset: string
  /** Per-surface enforcement levels currently in force (after preset expansion). */
  readonly surfaces: PanelSurfaceSettings
  /** Input normalization and semantic judge. */
  readonly inputJudge: PanelInputJudge
  /** Descriptor scan, trajectory thresholds and the SQL table allowlist. */
  readonly toolDetection: PanelToolDetection
  /** Tool-result PII scan. */
  readonly pii: PanelResultPii
  /** List/pattern settings (deny lists, tags, blockOn, allowOnce). */
  readonly lists: PanelListSettings
  /** Rule-source and patrol knobs. */
  readonly source: PanelSourceSettings
  /** Read-only facts: engine, rules, audit, posture, patrol destinations. */
  readonly facts: PanelConfigFacts
  readonly judge: PanelJudgeSettings
  readonly draft: PanelDraftSettings
  /** Provider/model catalog for the two route pickers (bounded). */
  readonly providers: readonly PanelProviderOption[]
  /** Routes added by this panel (no key material). */
  readonly customProviders: readonly PanelCustomProvider[]
  /** True when the pi-ai provider entry is editable here (add/delete routes). */
  readonly providerConfigurable: boolean
  /**
   * Revision of this plugin entry's raw config when the value was read, or null when
   * the host exposes none. Echoed back as {@link PanelSettingsPatch.expectedRevision}
   * so a stale form is refused instead of silently overwriting a concurrent change.
   */
  readonly revision: number | null
  /** Absolute profile patch path, or null when the host cannot edit config. */
  readonly configPath: string | null
}

/** Enforcement level a detection surface offers in the panel. */
export type PanelMode = 'off' | 'warn' | 'enforce'

/** Output surface mode; `enforce-buffer` trades streaming for a veto window. */
export type PanelOutputMode = 'off' | 'warn' | 'enforce-buffer'

/** Approval bridge mode: delegate everything, or apply the plugin's coarse policy. */
export type PanelApprovalMode = 'delegate' | 'policy'

/**
 * The five surfaces' live levels, as the settings tab shows them.
 *
 * These are the *resolved* values (preset expanded); writing one field stores an
 * explicit override and leaves `preset` in place.
 */
export interface PanelSurfaceSettings {
  readonly input: PanelMode
  readonly tools: PanelMode
  readonly results: PanelMode
  readonly output: PanelOutputMode
  readonly approval: PanelApprovalMode
}

/**
 * List/pattern settings the panel may edit (1.13.0).
 *
 * These are `patch`-layer fields, not `volatile` ones: a save rewrites the profile
 * patch and the loader remounts the entry, which the card says next to the buttons.
 */
export interface PanelListSettings {
  /** Tool-name globs always denied. */
  readonly denyTools: readonly string[]
  /** Tool-name globs that require approval. */
  readonly askTools: readonly string[]
  /** Semantic tags denied outright. */
  readonly denyTags: readonly string[]
  /** Tool-name glob → semantic tags. */
  readonly tagOverrides: readonly { readonly pattern: string; readonly tags: readonly string[] }[]
  /** Result categories that block in `enforce` mode. */
  readonly blockOn: readonly string[]
  /** Tool-name globs granted once by the approval policy. */
  readonly allowOnce: readonly string[]
}

/** Rule-source and patrol knobs (patch layer; a save remounts the plugin). */
export interface PanelSourceSettings {
  /** Extra rule directory; empty means the packaged rules. */
  readonly rulesDir: string
  /** Recompile the rule set when a rule file changes. */
  readonly rulesWatch: boolean
  /** Patrol denial-rate window. */
  readonly patrolWindowMinutes: number
  /** Patrol rate multiplier that counts as anomalous. */
  readonly patrolFactor: number
  /** Patrol minimum denials before the rate can fail. */
  readonly patrolMinCount: number
}

/**
 * Read-only configuration facts (panel stage three: show, never edit).
 *
 * Two rules hold here: no credential ever appears (notification destinations are
 * reported by *type* only), and nothing in this block is writable from the panel —
 * an operator changes it in the profile patch, whose path the card copies.
 */
export interface PanelConfigFacts {
  readonly engine: { readonly kind: string; readonly command: string }
  readonly rules: { readonly inlineRules: number; readonly sources: number }
  readonly audit: {
    readonly format: string
    readonly dir: string
    readonly rotateMb: number
    readonly required: boolean
    readonly hashChain: boolean
  }
  readonly posture: { readonly onLoad: boolean; readonly failOn: readonly string[] }
  /** Notification channels by type only (`feishu`, `wecom`, ...), never their URLs. */
  readonly patrolNotify: { readonly channels: readonly string[]; readonly healthUrls: number }
}

/** Fields one save may change; omitted fields keep their current value. */
export interface PanelSettingsPatch {
  /**
   * The revision the form was rendered at (from {@link PanelSettingsValue.revision}).
   * Omitted by internal callers: the Host then reads the current revision itself.
   */
  readonly expectedRevision?: number
  /** Per-surface overrides: the switchboard ("关掉某一面" without leaving the preset). */
  readonly surfaces?: {
    readonly input?: PanelMode
    readonly tools?: PanelMode
    readonly results?: PanelMode
    readonly output?: PanelOutputMode
    readonly approval?: PanelApprovalMode
  }
  /** Input normalization and judge knobs. */
  readonly inputJudge?: {
    readonly mode?: 'off' | 'flagged' | 'always'
    readonly failClosed?: boolean
    readonly normalize?: boolean
  }
  /** Tool-surface detection knobs (descriptor scan, thresholds, table allowlist). */
  readonly toolDetection?: {
    readonly descriptorScan?: 'off' | 'warn' | 'enforce'
    readonly repeatedAttemptThreshold?: number
    readonly entropyThreshold?: number
    readonly entropyMinLength?: number
    readonly allowedTables?: readonly string[]
  }
  /** Tool-result PII scan (`enabled` plus an optional class subset). */
  readonly pii?: {
    readonly enabled?: boolean
    readonly classes?: readonly string[]
  }
  /** List/pattern settings; every list replaces the stored one as a whole. */
  readonly lists?: {
    readonly denyTools?: readonly string[]
    readonly askTools?: readonly string[]
    readonly denyTags?: readonly string[]
    readonly tagOverrides?: readonly { readonly pattern: string; readonly tags: readonly string[] }[]
    readonly blockOn?: readonly string[]
    readonly allowOnce?: readonly string[]
  }
  /** Rule-source and patrol knobs (patch layer: the save remounts the plugin). */
  readonly source?: {
    readonly rulesDir?: string
    readonly rulesWatch?: boolean
    readonly patrolWindowMinutes?: number
    readonly patrolFactor?: number
    readonly patrolMinCount?: number
  }
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

/** Wire protocols a hand-declared provider route may name (0.2.2 pi-ai). */
export type PanelProviderProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/** One custom provider route this plugin added (no key material). */
export interface PanelCustomProvider {
  /** Route id; also the config key under `providers`. */
  readonly id: string
  readonly displayName: string
  readonly api: PanelProviderProtocol
  readonly baseURL: string
  /** Model ids declared on the route. */
  readonly models: readonly string[]
  /** Epoch ms the route was added. */
  readonly addedAt: number
}

/** Input for adding one custom provider route. */
export interface PanelProviderInput {
  /** `[a-z][a-z0-9-]*`, 2–40 characters; must not collide with an existing route. */
  readonly id: string
  readonly displayName?: string
  readonly api: PanelProviderProtocol
  readonly baseURL: string
  /** Write-only secret; stored through the host credentials service, never echoed. */
  readonly apiKey: string
  readonly model: string
  readonly modelName?: string
  /** Also point the semantic judge at the new route (default true). */
  readonly useForJudge?: boolean
}

/** Result of adding one route: the route plus the refreshed settings. */
export interface PanelProviderAdded {
  readonly provider: PanelCustomProvider
  readonly settings: PanelSettingsValue
  /** False when the route was added but pointing the judge at it failed. */
  readonly judgeRouteApplied: boolean
}

/** Successful provider add/delete. */
export interface PanelProviderOk {
  readonly ok: true
  readonly value: PanelProviderAdded
}

/** What a provider add/delete resolves to. */
export type PanelProviderResult = PanelProviderOk | PanelError

/** A bounded, already-redacted ledger slice ready to save as `.ndjson`. */
export interface PanelExportValue {
  readonly filename: string
  readonly count: number
  /** NDJSON records exactly as the ledger stores them (hashes/lengths/codes). */
  readonly content: string
}

/** Successful ledger export. */
export interface PanelExportOk {
  readonly ok: true
  readonly value: PanelExportValue
}

/** What a ledger export resolves to. */
export type PanelExportResult = PanelExportOk | PanelError

/** One successful rule draft (already validated by the loader's own gate). */export interface PanelDraftValue {
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

/** One landed operator rule file (metadata only: no content, no absolute path). */
export interface PanelRuleWriteValue {
  /** File name inside `rules.dir` (whitelisted token). */
  readonly filename: string
  /** Bytes written (UTF-8). */
  readonly bytes: number
  /** Rules in force after the write. */
  readonly rules: number
  /** Chain rules in force after the write. */
  readonly chains: number
  /** Rule-set hash prefix in force after the write. */
  readonly hash: string
  /** False when an existing file was replaced. */
  readonly created: boolean
  /** False when the file landed but the hot reload kept the previous set. */
  readonly reloaded: boolean
  /** Snapshot taken before this write (1.14.0), when the history was writable. */
  readonly snapshot?: string
}

/** Successful rule write. */
export interface PanelRuleWriteOk {
  readonly ok: true
  readonly value: PanelRuleWriteValue
}

/** What a rule write resolves to. */
export type PanelRuleWriteResult = PanelRuleWriteOk | PanelError

/** One rule-directory snapshot (metadata only: no file content, no absolute path). */
export interface PanelRuleSnapshot {
  /** Opaque id (`YYYYMMDDTHHMMSSZ-<n>`), the rollback handle. */
  readonly id: string
  /** Epoch milliseconds the snapshot was taken. */
  readonly createdAt: number
  /** Why it exists: a rule write, a manual capture, or the undo point of a rollback. */
  readonly trigger: 'write' | 'manual' | 'pre-rollback'
  /** Number of `.yaml`/`.yml` files captured. */
  readonly files: number
  /** Total bytes captured. */
  readonly bytes: number
  /** True when the live `rules.dir` currently equals this snapshot. */
  readonly active: boolean
}

/** The snapshot list the rules tab renders. */
export interface PanelRuleHistoryValue {
  /** Number of snapshots retained (the oldest are pruned beyond it). */
  readonly limit: number
  /** Newest first. */
  readonly snapshots: readonly PanelRuleSnapshot[]
}

/** Successful history read. */
export interface PanelRuleHistoryOk {
  readonly ok: true
  readonly value: PanelRuleHistoryValue
}

/** What a history read resolves to. */
export type PanelRuleHistoryResult = PanelRuleHistoryOk | PanelError

/** Result of restoring one snapshot. */
export interface PanelRuleRollbackValue {
  /** The snapshot that was restored. */
  readonly snapshot: string
  /** The snapshot taken of the state being replaced (undo point), when there was one. */
  readonly preRollback: string | null
  /** Files restored. */
  readonly files: number
  /** Bytes restored. */
  readonly bytes: number
  /** Live files removed because the snapshot does not contain them. */
  readonly removed: readonly string[]
  /** Rules in force after the rollback. */
  readonly rules: number
  /** Chain rules in force after the rollback. */
  readonly chains: number
  /** Rule-set hash prefix in force after the rollback. */
  readonly hash: string
  /** False when the files were restored but the hot reload kept the previous set. */
  readonly reloaded: boolean
}

/** Successful rollback. */
export interface PanelRuleRollbackOk {
  readonly ok: true
  readonly value: PanelRuleRollbackValue
}

/** What a rollback resolves to. */
export type PanelRuleRollbackResult = PanelRuleRollbackOk | PanelError

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
  readonly error: {
    readonly code: string
    readonly message: string
    /**
     * Loader problems for a rejected rule file (the operator's own rule text, the
     * same vocabulary the rules tab already shows). Absent for every other endpoint.
     */
    readonly problems?: readonly string[]
  }
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
