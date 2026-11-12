/**
 * Shared runtime state for the hook layer: the engine, the ledger, the session
 * store and the counters that `safeharness_status` reports.
 *
 * Hooks are thin; everything they need to agree on (audit field shape, generic
 * denial wording, rule-set hash stamping) lives here so the ledger stays
 * consistent no matter which seam produced a record.
 * @module
 */
import type { ResolvedConfig } from './config.js'
import type { Engine } from './engine/index.js'
import type { Decision } from './engine/types.js'
import { ReasonCode } from './engine/types.js'
import type { AuditFields, AuditKind, Ledger } from './audit/types.js'
import { SessionStateStore } from './state.js'
import { BudgetGuard } from './budget.js'
import { VERSION } from './version.js'

/**
 * The one phrase every model-facing refusal carries so a user can tell *what*
 * refused them without learning *why*: the source marker names this plugin,
 * while the sentence stays generic about the rule, count or threshold (§6.4).
 */
const SOURCE_MARK = '（SafeHarness 安全插件）'

/**
 * The single model-facing denial sentence. Deliberately generic (§6.4): it must
 * not name a rule, a pattern, a count or a threshold — telling the model what
 * tripped the guard is telling an attacker how to phrase the next attempt.
 */
export const DENIAL_TEXT =
  `该请求触发平台安全策略，无法执行${SOURCE_MARK}。请调整表述或联系管理员。`

/** Tool-surface denial wording (same rationale, tool-shaped). */
export const TOOL_DENIAL_TEXT =
  `该操作不被平台安全策略允许${SOURCE_MARK}。请改用其他方式，或联系管理员。`

/** Result-block feedback wording, shown to the model instead of the blocked value. */
export const RESULT_BLOCK_TEXT =
  `该工具结果被平台安全策略拦截${SOURCE_MARK}，未向模型提供内容。请改用其他方式或联系管理员。`

/**
 * Answer-replacement wording for `output.mode: 'enforce-buffer'` (§6.6). The
 * buffered answer is discarded entirely and this single paragraph takes its place,
 * so the refusal must be understandable without the discarded text — and must not
 * say which rule fired.
 */
export const OUTPUT_BLOCK_TEXT =
  `该回答已被平台安全策略拦截${SOURCE_MARK}，未向用户显示内容。请调整问题或联系管理员。`

/** Logger seam: matches what Cordis hands a plugin, structurally. */
export interface LoggerLike {
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
}

/** Global counters (per-process, all sessions). */
export interface GlobalCounters {
  deny: number
  warn: number
  allow: number
  ask: number
  /** Enforcement attempts abandoned because the ledger was unavailable and required. */
  auditBlocked: number
  /** Engine exceptions caught by the fail-closed paths. */
  internalErrors: number
}

/** What a hook may rely on. */
export interface Runtime {
  readonly config: ResolvedConfig
  readonly engine: Engine
  readonly ledger: Ledger
  readonly state: SessionStateStore
  /** Per-turn token accounting for the advisory budget guard (T3.5). */
  readonly budget: BudgetGuard
  readonly counters: GlobalCounters
  readonly logger: LoggerLike
  /** Swap the resolved config after a settings change (hot reload, §6.2). */
  reconfigure(next: ResolvedConfig): void
  /** Append a record, tolerating sink failure (observation paths). */
  audit(kind: AuditKind, fields?: AuditFields): void
  /** Append a record and propagate sink failure (enforcement paths). */
  auditStrict(kind: AuditKind, fields?: AuditFields): Promise<void>
  /** Whether enforcement may proceed given ledger health (fail-closed when required). */
  ledgerPermitsEnforcement(): boolean
  /** Count one decision outcome globally and per session. */
  count(outcome: 'allow' | 'deny' | 'ask' | 'warn', sessionId?: string): void
  /** Build the fields every record of one session should carry. */
  sessionFields(sessionId?: string, agentId?: string): AuditFields
  /** Note a caught internal error (counted, logged once per kind). */
  internalError(where: string, error: unknown): void
}

/** Options for {@link createRuntime}. */
export interface RuntimeOptions {
  readonly config: ResolvedConfig
  readonly engine: Engine
  readonly ledger: Ledger
  readonly logger: LoggerLike
  readonly state?: SessionStateStore
  /** Pre-built budget guard (tests share one); defaults to the config's limit. */
  readonly budget?: BudgetGuard
}

/**
 * Create the shared runtime. Cheap and synchronous: `apply()` calls it once.
 *
 * @param options - resolved config, live engine, ledger sink and logger.
 * @returns the runtime hooks share.
 */
export function createRuntime(options: RuntimeOptions): Runtime {
  const counters: GlobalCounters = { deny: 0, warn: 0, allow: 0, ask: 0, auditBlocked: 0, internalErrors: 0 }
  const warned = new Set<string>()
  let currentConfig = options.config

  const runtime: Runtime = {
    get config(): ResolvedConfig {
      return currentConfig
    },
    engine: options.engine,
    ledger: options.ledger,
    state: options.state ?? new SessionStateStore(),
    budget: options.budget ?? new BudgetGuard({ limit: options.config.budget.maxTokensPerTurn }),
    counters,
    logger: options.logger,

    reconfigure(next: ResolvedConfig): void {
      currentConfig = next
      // Detection thresholds that live in config (input.maxChars, tool/result
      // limits) must follow a settings write; the engine ignores what it does not use.
      runtime.engine.reconfigure?.(next)
      // A hot update may change the per-turn limit without recreating the guard.
      runtime.budget.setLimit(next.budget.maxTokensPerTurn)
    },

    audit(kind: AuditKind, fields: AuditFields = {}): void {
      runtime.ledger.appendBestEffort(kind, decorate(fields))
    },

    auditStrict(kind: AuditKind, fields: AuditFields = {}): Promise<void> {
      return runtime.ledger.append(kind, decorate(fields))
    },

    ledgerPermitsEnforcement(): boolean {
      const stats = runtime.ledger.stats
      // `required: false` (the observe preset) never blocks on the ledger.
      if (!runtime.config.audit.required) return true
      // `format: 'off'` is an explicit operator choice to run without evidence;
      // it cannot silently disable enforcement, so it is reported by posture
      // (`ledger_writable` FAIL) rather than turned into a deny storm here.
      if (!stats.enabled) return true
      return stats.writable
    },

    count(outcome, sessionId): void {
      counters[outcome] += 1
      runtime.state.count(sessionId, outcome)
    },

    sessionFields(sessionId, agentId): AuditFields {
      const fields: AuditFields = {
        ruleset_hash: runtime.engine.rulesetHash,
        preset: runtime.config.preset,
      }
      if (sessionId !== undefined && sessionId.length > 0) fields.session = sessionId
      if (agentId !== undefined && agentId.length > 0) fields.agent = agentId
      return fields
    },

    internalError(where, error): void {
      counters.internalErrors += 1
      const key = `${where}:${error instanceof Error ? error.message : String(error)}`
      if (!warned.has(key)) {
        warned.add(key)
        const message = error instanceof Error ? error.message : String(error)
        options.logger.error(`safeharness: internal error in ${where}: ${message}`)
      }
      runtime.audit('error', { reason_code: 'internal_error', labels: { where }, metrics: { count: counters.internalErrors } })
    },
  }

  /** Stamp plugin version so every line is attributable without joining files. */
  function decorate(fields: AuditFields): AuditFields {
    return { plugin_version: VERSION, ...fields } as AuditFields
  }

  return runtime
}

/** Whether a decision actually found something, regardless of the mode applied. */
export function foundSomething(decision: Decision): boolean {
  return decision.ruleIds.length > 0 || decision.reasonCode !== ReasonCode.None
}
