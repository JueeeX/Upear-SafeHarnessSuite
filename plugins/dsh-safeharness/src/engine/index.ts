/**
 * The engine composition root: binds a compiled rule set + resolved config to
 * the detector functions and exposes the {@link SecurityEngine} surface
 * (plan §6.14). Pure and synchronously usable; no DSH types, no IO.
 * @module
 */
import type { ResolvedConfig } from '../config.js'
import { evaluateInput } from './input.js'
import { inspectSql } from './sql.js'
import { evaluateToolCall, scanToolResult } from './tool.js'
import type {
  Decision,
  ResultFinding,
  RuleSet,
  SecurityEngine,
  SessionView,
  Severity,
  ToolResultView,
  ToolView,
} from './types.js'
import { ReasonCode } from './types.js'

/** Severity ordering for "highest severity wins" reductions. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
}

/** Return the more severe of two severities (undefined loses). */
export function maxSeverity(a: Severity | undefined, b: Severity | undefined): Severity | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b
}

/** A read-only allowance decision. */
export const ALLOW: Decision = { kind: 'allow', reasonCode: ReasonCode.None, ruleIds: [] }

/**
 * Apply an enforcement mode to a raw detection decision.
 *
 * The engine always reports what it *found*; whether that becomes an actual
 * denial is policy and belongs to the hook (§5.3). `warn`/`off` therefore keep
 * the finding (the ledger must record it) but turn the kind into `allow`; the
 * caller distinguishes "found but observed" from "clean" by `ruleIds`.
 */
export function applyMode(decision: Decision, mode: 'off' | 'warn' | 'enforce'): Decision {
  if (decision.kind !== 'deny') return decision
  if (mode === 'enforce') return decision
  return { ...decision, kind: 'allow' }
}

/** The engine plus a couple of extras hooks legitimately need. */
export interface Engine extends SecurityEngine {
  /** The live rule set (hooks quote its hash in every record). */
  readonly ruleset: RuleSet
  /** Full-text scan over model output (regex rules only in v1). */
  readonly config: ResolvedConfig
  /**
   * Adopt a hot-reloaded config. Optional: only the surfaces whose detection
   * depends on config (`input.maxChars`, `tools.*`, `results.*`) need it, and a
   * settings write must take effect without a restart.
   */
  reconfigure?(next: ResolvedConfig): void
}

/**
 * Build the engine over one compiled rule set.
 *
 * @param ruleset - compiled deny rules and chain rules.
 * @param config - resolved config; the engine consults only the fields that shape
 *   detection (`tools.*`, `results.*`, `input.maxChars`). Modes are the hooks' business.
 */
export function createEngine(ruleset: RuleSet, config: ResolvedConfig): Engine {
  let current = ruleset
  // Mutable so a settings hot-reload can move `input.maxChars` and the tool/result
  // thresholds without recreating the engine (the old capture made them stale).
  let currentConfig = config

  const engine: Engine = {
    get ruleset(): RuleSet {
      return current
    },
    get config(): ResolvedConfig {
      return currentConfig
    },
    get rulesetHash(): string {
      return current.hash
    },
    get ruleCount(): number {
      return current.ruleCount
    },
    get chainCount(): number {
      return current.chainCount
    },

    evaluateInput(text: string): Decision {
      const { decision } = evaluateInput(current, text, { maxChars: currentConfig.input.maxChars })
      return decision
    },

    evaluateTool(view: ToolView, session: SessionView): Decision {
      return evaluateToolCall(current, currentConfig.tools, view, session)
    },

    evaluateToolResult(view: ToolResultView): readonly ResultFinding[] {
      return scanToolResult(current, currentConfig.results, view)
    },

    /**
     * Regex-only output review. The optional semantic judge is invoked by the
     * `llm/stream` hook (M3), never here: keeping the engine pure means an output
     * decision is reproducible from the rule set hash alone.
     */
    evaluateOutput(text: string): Decision {
      if (text.length === 0) return ALLOW
      const ruleIds: string[] = []
      let severity: Severity | undefined
      let category: string | undefined
      for (const rule of current.rules) {
        if (rule.regex.test(text)) {
          ruleIds.push(rule.id)
          severity = maxSeverity(severity, rule.severity)
          if (category === undefined) category = rule.category
        }
      }
      if (ruleIds.length === 0) return ALLOW
      return {
        kind: 'deny',
        reasonCode: ReasonCode.OutputRule,
        ruleIds,
        severity,
        category,
        reason: 'model output matched a deny rule',
      }
    },

    reloadRules(next: RuleSet): void {
      current = next
    },

    reconfigure(next: ResolvedConfig): void {
      currentConfig = next
    },
  }
  return engine
}

/** Re-export the SQL inspector so hooks/tests import one module for detection. */
export { inspectSql }
