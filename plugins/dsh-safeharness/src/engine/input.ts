/**
 * Input-surface judgement: prompt-injection regex rules + dangerous SQL over the
 * concatenated user text of one step (§6.4, plan §8.2).
 *
 * The engine always reports what it *found*; whether a hit becomes an actual
 * denial is the caller's mode business (`applyMode` in `engine/index.ts`). A
 * truncation is likewise only a WARN-only signal: it is surfaced through
 * {@link InputEvaluation.truncated} and never turns into a denial by itself.
 *
 * Purity: no IO, no console output, no hidden state. The same rule set + text
 * always produce the same evaluation.
 * @module
 */
import { inspectSql } from './sql.js'
import type { CompiledRule, Decision, RuleSet, Severity } from './types.js'
import { ReasonCode } from './types.js'

/**
 * Synthetic rule id recorded when the hit came from dangerous SQL rather than
 * from a compiled regex rule (mirrors the Python `dangerous_sql` risk tag).
 */
export const SQL_RULE_ID = 'dangerous_sql'

/**
 * Severity attached to a dangerous-SQL hit. The Python `SqlGuardPolicy` votes
 * `RiskAssessment(0.9, Severity.HIGH, ...)` for both content and tool arguments,
 * so SQL never outranks a `critical` regex rule on its own.
 */
export const SQL_SEVERITY: Severity = 'high'

/** Category reported for a SQL-only hit (Python risk tag vocabulary). */
export const SQL_CATEGORY = 'dangerous_sql'

/**
 * The single model-facing denial sentence (§6.4).
 *
 * Deliberately generic: it must not name a rule, a pattern, a rule count or a
 * threshold — telling the model what tripped the guard is telling an attacker how
 * to phrase the next attempt. 29 characters, Chinese, no numbers. Identical to
 * `DENIAL_TEXT` in `src/runtime.ts`, which the hook layer also uses.
 */
export const genericDenialText = '该请求触发平台安全策略，无法执行。请调整表述或联系管理员。'

/** Severity ordering, highest wins. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
}

/** Outcome of judging one step's user text. */
export interface InputEvaluation {
  readonly decision: Decision
  /** True when the text was cut at `opts.maxChars` before matching. */
  readonly truncated: boolean
  /** Number of characters actually matched against (== decision input length). */
  readonly scannedChars: number
}

/**
 * What an engine observed about one input text, before policy is composed.
 *
 * This is the seam the optional Python sidecar reports through: the child returns
 * *facts* (which rule names matched, whether the canonical SQL inspector called the
 * text dangerous), never a `Decision`. Composing the decision here keeps
 * severity/category/reason-code semantics in exactly one place, so switching
 * engines cannot silently change what a hit means in the ledger.
 */
export interface InputFacts {
  /** Compiled rule names that matched (any order; duplicates tolerated). */
  readonly matchedRuleNames: readonly string[]
  /** Whether the SQL inspector classified the text as dangerous. */
  readonly sqlDangerous: boolean
  /** Statement kinds from the inspector, for the operator-facing reason only. */
  readonly sqlKinds?: readonly string[]
  /** Whether the text was truncated before matching. */
  readonly truncated?: boolean
  /** Truncation bound, for the allow-path reason string. */
  readonly maxChars?: number
}

/**
 * Truncate text to the configured match bound.
 *
 * Both engines scan exactly this string: the sidecar is sent the already-truncated
 * text so `input.maxChars` is applied in one place.
 */
export function truncateForScan(text: unknown, maxChars: number): { scanned: string; truncated: boolean } {
  const raw = typeof text === 'string' ? text : ''
  const limit = normaliseMaxChars(maxChars)
  const scanned = raw.length > limit ? raw.slice(0, limit) : raw
  return { scanned, truncated: scanned.length < raw.length }
}

/**
 * Turn engine-observed facts into the one `Decision` both engines report.
 *
 * Matched names are resolved against the live rule set **in rule-set order**, so
 * "highest severity wins, ties keep the earlier rule" is identical for the built-in
 * engine and the sidecar (which reports a name set, not an order).
 *
 * @param ruleset - the compiled deny rules.
 * @param facts - what the engine found.
 * @returns the composed decision; `kind: 'deny'` means "found something".
 */
export function composeInputDecision(ruleset: RuleSet, facts: InputFacts): Decision {
  const matchedSet = new Set(facts.matchedRuleNames)
  const matchedRules = matchedSet.size === 0
    ? []
    : ruleset.rules.filter((rule) => matchedSet.has(rule.name))

  const sqlHit = facts.sqlDangerous
  if (matchedRules.length === 0 && !sqlHit) {
    return {
      kind: 'allow',
      reasonCode: ReasonCode.None,
      ruleIds: [],
      reason: facts.truncated === true ? `input truncated at ${facts.maxChars ?? 0} chars` : undefined,
    }
  }

  // Highest severity wins; ties keep the earlier rule (rule-set order).
  let severity: Severity | undefined = sqlHit ? SQL_SEVERITY : undefined
  let category: string | undefined = sqlHit ? SQL_CATEGORY : undefined
  for (const rule of matchedRules) {
    if (severity === undefined || SEVERITY_RANK[rule.severity] > SEVERITY_RANK[severity]) {
      severity = rule.severity
      category = rule.category
    }
  }

  const ids = matchedRules.map((rule) => rule.id)
  if (sqlHit) ids.push(SQL_RULE_ID)

  const kinds = facts.sqlKinds ?? []
  const detail = sqlHit ? `kinds=${kinds.join(',') || 'unknown'}` : 'rule'
  return {
    kind: 'deny',
    reasonCode: sqlHit ? ReasonCode.InputSql : ReasonCode.InputRule,
    ruleIds: sortedIds(ids),
    severity,
    category,
    // Operator-facing only (never shown verbatim to the model): names rules and
    // SQL statement kinds, never user content.
    reason: sqlHit
      ? `input contains dangerous SQL (${detail})`
      : `input matched deny rules: ${sortedIds(ids).join(',')}`,
  }
}

/**
 * Stateless regex test.
 *
 * Compiled rules never carry the `g` flag (rules.ts compiles with `iu`), but a
 * defensive reset keeps a stray global/sticky rule from making repeated
 * evaluations alternate (§9.9): a `lastIndex` left behind by another caller is
 * never allowed to hide a hit.
 */
function testRegex(regex: RegExp, text: string): boolean {
  if (regex.global || regex.sticky) regex.lastIndex = 0
  const hit = regex.test(text)
  if (regex.global || regex.sticky) regex.lastIndex = 0
  return hit
}

/** Coerce the configured bound into a sane slice length (never throws). */
function normaliseMaxChars(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

/** Deterministic, de-duplicated, sorted rule ids. */
function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

/**
 * Judge one step's user text.
 *
 * Every compiled rule is tested against the (truncated) text and **all** matching
 * ids are collected — a denial must never depend on rule order. Dangerous SQL is
 * treated as one extra hit carrying `ReasonCode.InputSql`.
 *
 * @param ruleset - the compiled deny rules (may be empty).
 * @param text - concatenated user text of this step.
 * @param opts - `maxChars` truncation bound; text beyond it is not scanned.
 * @returns the decision plus truncation metadata. `kind: 'deny'` means "found
 *   something"; the caller downgrades by mode. With no hit the decision is
 *   `kind: 'allow'`, `reasonCode: ReasonCode.None`.
 */
export function evaluateInput(
  ruleset: RuleSet,
  text: string,
  opts: { maxChars: number },
): InputEvaluation {
  const { scanned, truncated } = truncateForScan(text, opts.maxChars)

  /** Rule hits, in rule-set order (deterministic). */
  const matchedRuleNames: string[] = []
  if (scanned.length > 0) {
    for (const rule of ruleset.rules) {
      if (testRegex(rule.regex, scanned)) matchedRuleNames.push(rule.name)
    }
  }

  // `inspectSql` short-circuits empty text itself; call it unconditionally so the
  // SQL face is judged exactly once per evaluation.
  const sql = inspectSql(scanned)
  const decision = composeInputDecision(ruleset, {
    matchedRuleNames,
    sqlDangerous: sql.dangerous,
    sqlKinds: sql.statementKinds,
    truncated,
    maxChars: normaliseMaxChars(opts.maxChars),
  })
  return { decision, truncated, scannedChars: scanned.length }
}
