/**
 * Optional Python engine over the sidecar transport (M5 T5.1, step 2).
 *
 * Wraps the built-in engine and adds **one** asynchronous surface: input
 * judgement. Everything else — tool name/tag/args, result scanning, output regex,
 * chain trails — stays in the built-in engine, because `tools.guard` is a
 * synchronous, IO-free contract (R3) that a child process can never satisfy.
 *
 * Fail-closed properties this module owns:
 *
 * - **The built-in engine is still the synchronous answer.** `evaluateInput()`
 *   keeps working if the child is dead; the hook decides whether that fallback is
 *   allowed (observe/balanced) or a denial (hardened).
 * - **Stale rules are not used.** After a rule reload the sidecar's accepted rule
 *   set is compared by hash; until the child accepts the new set, the async path
 *   rejects (`sidecar_rules_stale`). It never judges new input with old rules while
 *   the ledger stamps the new ruleset hash.
 * - **Unknown rule names are a hard failure.** A child that reports a rule this
 *   rule set does not contain is not producing this engine's decision; the call
 *   rejects instead of silently dropping the hit.
 * - **No content in errors.** Everything surfaced is a coarse code from
 *   {@link SidecarError}; request text and received names never appear.
 *
 * @module
 */
import type { ResolvedConfig } from '../config.js'
import type { Engine } from './index.js'
import { composeInputDecision, truncateForScan } from './input.js'
import { Sidecar, SidecarError, type SidecarStatus, type SidecarStats } from './sidecar.js'
import type { Decision, ResultFinding, RuleSet, SessionView, ToolResultView, ToolView } from './types.js'

/** What the child reports for `health`. */
interface HealthResult {
  readonly ok?: boolean
  /** Whether the canonical SQL inspector imported (the engine is unusable without it). */
  readonly sql?: boolean
}

/** What the child reports for `set_rules`. */
interface SetRulesResult {
  readonly accepted?: number
  readonly rejected?: readonly { readonly name?: string; readonly code?: string }[]
}

/** What the child reports for `evaluate_input`. */
interface EvaluateInputResult {
  readonly rules?: readonly string[]
  readonly sql?: { readonly dangerous?: boolean; readonly statement_kinds?: readonly string[] }
}

/** Dependencies: the built-in engine is both the delegate and the rule source. */
export interface SidecarEngineDeps {
  /** Built-in engine; authoritative for every non-input surface. */
  readonly builtin: Engine
  /** Transport to the child process. Call {@link SidecarEngine.prepare} once. */
  readonly sidecar: Sidecar
  /** Engine timeout for one input evaluation (ms). */
  readonly timeoutMs?: number
  /** Extra time allowed for the `set_rules` push after a reload (ms). */
  readonly rulesTimeoutMs?: number
  /** Optional logger; only coarse codes are ever passed to it. */
  readonly logger?: { error(message: string): void }
}

/** Default per-input deadline: a step boundary should not wait seconds. */
const DEFAULT_INPUT_TIMEOUT_MS = 1500
/** Pushing a few dozen rule sources is cheap; allow for a slow first import. */
const DEFAULT_RULES_TIMEOUT_MS = 5000

/**
 * The engine the plugin uses in `engine.kind: 'sidecar'` mode.
 *
 * Use {@link createSidecarEngine} rather than constructing it directly.
 */
export class SidecarEngine implements Engine {
  private readonly builtin: Engine
  private readonly client: Sidecar
  private readonly logger: { error(message: string): void } | undefined
  private timeoutMs: number
  private readonly rulesTimeoutMs: number
  /** Hash of the rule set the child confirmed; compared against the live one. */
  private pushedHash: string | undefined
  /** Root cause when {@link prepare} failed (coarse code only, never content). */
  private startupError: string | undefined
  /** Serializes rule pushes (a reload during a reload must not interleave). */
  private pushChain: Promise<void> = Promise.resolve()

  constructor(deps: SidecarEngineDeps) {
    this.builtin = deps.builtin
    this.client = deps.sidecar
    this.logger = deps.logger
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS
    this.rulesTimeoutMs = deps.rulesTimeoutMs ?? DEFAULT_RULES_TIMEOUT_MS
  }

  /** Transport lifecycle, for posture/status (`ready` means input is served). */
  get sidecarStatus(): SidecarStatus {
    return this.client.status
  }

  /** Transport counters (counts only, never content). */
  get sidecarStats(): SidecarStats {
    return this.client.stats
  }

  /** Whether the child currently evaluates the live rule set. */
  get rulesStale(): boolean {
    return this.pushedHash !== this.builtin.ruleset.hash
  }

  /** Why the engine is not usable, when it is not (a coarse code, or undefined). */
  get lastError(): string | undefined {
    if (this.startupError !== undefined) return this.startupError
    if (this.client.status === 'failed') return 'sidecar_failed'
    if (this.rulesStale) return 'sidecar_rules_stale'
    return undefined
  }

  /** The live rule set (delegated: the built-in engine owns reloads). */
  get ruleset(): RuleSet {
    return this.builtin.ruleset
  }

  /** The live config (delegated). */
  get config(): ResolvedConfig {
    return this.builtin.config
  }

  get rulesetHash(): string {
    return this.builtin.rulesetHash
  }

  get ruleCount(): number {
    return this.builtin.ruleCount
  }

  get chainCount(): number {
    return this.builtin.chainCount
  }

  /**
   * Start the child, prove it is usable and hand it the rule set.
   *
   * @throws SidecarError when the child cannot start, answers an unhealthy
   *   handshake, or rejects the rule set — the caller records the failure and lets
   *   `posture.failOn` decide whether the plugin may load.
   */
  async prepare(): Promise<void> {
    try {
      await this.client.start()
      const health = await this.client.request<HealthResult>('health', {}, this.rulesTimeoutMs)
      if (health === null || typeof health !== 'object' || health.ok !== true) {
        throw new SidecarError('sidecar_unhealthy', 'the engine did not report a healthy handshake')
      }
      if (health.sql !== true) {
        throw new SidecarError('sidecar_no_sql', 'the engine has no SQL inspector')
      }
      await this.enqueuePush()
      this.startupError = undefined
    } catch (error) {
      // Keep the root cause so later input calls report "unavailable (spawn failed)"
      // instead of the generic "rules stale" that the hash comparison would imply.
      this.startupError = error instanceof SidecarError ? error.code : 'sidecar_error'
      throw error
    }
  }

  /** Synchronous input judgement: always the built-in engine. */
  evaluateInput(text: string): Decision {
    return this.builtin.evaluateInput(text)
  }

  /**
   * Asynchronous input judgement over the child process.
   *
   * @throws SidecarError on any transport failure, a stale rule set, an
   *   unexpected response shape, or a rule name this rule set does not contain.
   */
  async evaluateInputAsync(text: string): Promise<Decision> {
    const ruleset = this.builtin.ruleset
    if (this.pushedHash !== ruleset.hash) {
      // A failed start reports its root cause; a failed reload reports staleness.
      throw this.startupError === undefined
        ? new SidecarError('sidecar_rules_stale', 'the engine has not accepted the current rule set')
        : new SidecarError(this.startupError, 'the engine failed to start')
    }
    const maxChars = this.builtin.config.input.maxChars
    const { scanned, truncated } = truncateForScan(text, maxChars)
    if (scanned.length === 0) {
      // No round trip for empty input: the answer is the same allow.
      return composeInputDecision(ruleset, {
        matchedRuleNames: [],
        sqlDangerous: false,
        truncated,
        maxChars,
      })
    }

    const result = await this.client.request<EvaluateInputResult>(
      'evaluate_input',
      { text: scanned },
      this.timeoutMs,
    )
    if (result === null || typeof result !== 'object' || !Array.isArray(result.rules)) {
      throw new SidecarError('sidecar_bad_response', 'the engine response has the wrong shape')
    }
    const names: string[] = []
    for (const name of result.rules) {
      if (typeof name !== 'string') {
        throw new SidecarError('sidecar_bad_response', 'the engine response has the wrong shape')
      }
      names.push(name)
    }
    const known = new Set(ruleset.rules.map((rule) => rule.name))
    for (const name of names) {
      if (!known.has(name)) {
        throw new SidecarError('sidecar_unknown_rule', 'the engine reported a rule this rule set does not contain')
      }
    }
    const sql = result.sql
    if (sql === null || typeof sql !== 'object' || typeof sql.dangerous !== 'boolean') {
      throw new SidecarError('sidecar_bad_response', 'the engine response has the wrong shape')
    }
    const kinds = Array.isArray(sql.statement_kinds)
      ? sql.statement_kinds.filter((kind): kind is string => typeof kind === 'string')
      : []
    return composeInputDecision(ruleset, {
      matchedRuleNames: names,
      sqlDangerous: sql.dangerous,
      sqlKinds: kinds,
      truncated,
      maxChars,
    })
  }

  evaluateTool(view: ToolView, session: SessionView): Decision {
    return this.builtin.evaluateTool(view, session)
  }

  evaluateToolResult(view: ToolResultView): readonly ResultFinding[] {
    return this.builtin.evaluateToolResult(view)
  }

  evaluateOutput(text: string): Decision {
    return this.builtin.evaluateOutput(text)
  }

  /**
   * Adopt a new rule set.
   *
   * The built-in engine switches immediately (so the ledger's hash is truthful for
   * every synchronous surface); the child is updated in the background and the
   * async input path refuses input until it confirms (`rulesStale`).
   */
  reloadRules(next: RuleSet): void {
    this.builtin.reloadRules(next)
    void this.enqueuePush().catch((error: unknown) => {
      const code = error instanceof SidecarError ? error.code : 'sidecar_error'
      // The failed push leaves `rulesStale` true, so the next input call fails
      // closed rather than judging with the old set.
      this.logger?.error(`safeharness: python engine did not accept the new rule set (${code})`)
    })
  }

  /** Adopt a hot-reloaded config (rules/command changes need a restart). */
  reconfigure(next: ResolvedConfig): void {
    this.builtin.reconfigure?.(next)
    this.timeoutMs = next.engine.timeoutMs
  }

  /** Stop the child. Never throws. */
  async stop(): Promise<void> {
    await this.client.stop()
  }

  /** Queue one rule push behind any in-flight push. */
  private enqueuePush(): Promise<void> {
    const next = this.pushChain.then(() => this.pushRulesNow())
    // The chain must survive failures; callers attach their own handling.
    this.pushChain = next.catch(() => {})
    return next
  }

  /** Send the live rule set and require the child to accept every rule. */
  private async pushRulesNow(): Promise<void> {
    const ruleset = this.builtin.ruleset
    const rules = ruleset.rules.map((rule) => ({
      name: rule.name,
      pattern: rule.source,
      severity: rule.severity,
      category: rule.category,
      action: rule.action,
      reason: rule.reason,
    }))
    const result = await this.client.request<SetRulesResult>('set_rules', { rules }, this.rulesTimeoutMs)
    if (result === null || typeof result !== 'object') {
      throw new SidecarError('sidecar_bad_response', 'the engine response has the wrong shape')
    }
    const rejected = Array.isArray(result.rejected) ? result.rejected : []
    if (rejected.length > 0 || result.accepted !== rules.length) {
      throw new SidecarError('sidecar_rules_rejected', 'the engine rejected the rule set')
    }
    this.pushedHash = ruleset.hash
  }
}

/**
 * Build the sidecar engine over a built-in engine.
 *
 * @param deps - built-in engine, transport and timeouts.
 * @returns the engine; the caller must `await prepare()` before relying on it.
 */
export function createSidecarEngine(deps: SidecarEngineDeps): SidecarEngine {
  return new SidecarEngine(deps)
}
