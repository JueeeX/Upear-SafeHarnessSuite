/**
 * The engine-facing type vocabulary. Nothing in this file (nor anywhere under
 * `src/engine/`) may import a DSH type: hooks convert `ToolExecution` and friends
 * into the plain views declared here, which keeps the engine unit-testable and
 * lets v2 swap in a Python sidecar without touching hooks/audit/surface (§6.14).
 * @module
 */

/** Rule severity vocabulary, identical to the Python rules loader. */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

/** A decision's disposition. `ask` is only producible on the tool surface. */
export type DecisionKind = 'allow' | 'deny' | 'ask'

/** Stable, non-leaking reason codes written to the ledger and shown in status. */
export const ReasonCode = {
  // input surface
  InputRule: 'input_rule_hit',
  InputSql: 'input_sql_dangerous',
  InputTooLong: 'input_truncated',
  /** The configured input engine could not judge (sidecar down / stale rules). */
  InputEngineUnavailable: 'input_engine_unavailable',
  // tool surface
  ToolName: 'tool_denied_by_name',
  ToolTag: 'tool_denied_by_tag',
  ToolArgs: 'tool_denied_by_args',
  ToolChain: 'tool_denied_by_chain',
  ToolAsk: 'tool_ask_required',
  ToolArgsTooLarge: 'tool_args_too_large',
  GuardInternal: 'guard_internal_error',
  // result surface
  CredentialLeak: 'credential_leak',
  InjectionMarker: 'injection_marker',
  // output surface
  OutputRule: 'output_rule_hit',
  OutputJudgeBlocked: 'output_judge_blocked',
  OutputJudgeUnavailable: 'output_judge_unavailable',
  // generic
  None: 'none',
} as const

/** A value from {@link ReasonCode}. */
export type ReasonCodeValue = (typeof ReasonCode)[keyof typeof ReasonCode]

/**
 * One engine judgement. `reason` is an operator-only explanation and is NEVER
 * shown verbatim to the model (denials use the shared generic wording, §6.4):
 * it exists for the ledger and for status output.
 */
export interface Decision {
  readonly kind: DecisionKind
  readonly reasonCode: ReasonCodeValue | string
  readonly ruleIds: readonly string[]
  readonly severity?: Severity
  readonly category?: string
  /** Operator-facing explanation; may name rules, must not quote user content. */
  readonly reason?: string
}

/** A compile of one deny rule: the source string survives for reproducibility. */
export interface CompiledRule {
  readonly id: string
  readonly name: string
  /** The pattern exactly as authored (Python-compatible subset). */
  readonly source: string
  readonly regex: RegExp
  readonly severity: Severity
  readonly category: string
  readonly action: 'deny'
  readonly reason: string
  /** Where the rule came from: a file path (relative to the rules dir) or `inline`. */
  readonly origin: string
}

/** One compiled chain rule (tool N then tool N+k). */
export interface CompiledChainRule {
  readonly name: string
  /** Tool-name pattern for the first leg, when given. */
  readonly firstSource?: string
  readonly first?: RegExp
  /** Tool-name pattern for the second leg, when given. */
  readonly thenSource?: string
  readonly then?: RegExp
  readonly firstTags: readonly string[]
  readonly thenTags: readonly string[]
  /** 0 = any distance. Otherwise the second leg must be within this many calls. */
  readonly maxGap: number
  readonly severity: Severity
  readonly category: string
  readonly reason: string
}

/** The immutable, hashed result of loading and compiling the rule set. */
export interface RuleSet {
  /** sha256 over the canonical form of every rule + chain (stable across reloads). */
  readonly hash: string
  readonly rules: readonly CompiledRule[]
  readonly chains: readonly CompiledChainRule[]
  /** Number of deny rules (what `safeharness_status` reports). */
  readonly ruleCount: number
  /** Number of chain rules. */
  readonly chainCount: number
  /** Files (or `inline`) that contributed, for the posture report. */
  readonly sources: readonly string[]
  /** Epoch milliseconds of the load. */
  readonly loadedAt: number
}

/** A loaded rule before compilation: exactly what a YAML/inline object may say. */
export interface RawRule {
  readonly name: string
  readonly pattern: string
  readonly severity: Severity
  readonly category: string
  readonly action: 'deny'
  readonly reason: string
  readonly origin: string
}

/** A loaded chain rule before compilation. */
export interface RawChainRule {
  readonly name: string
  readonly first?: string
  readonly then?: string
  readonly firstTags: readonly string[]
  readonly thenTags: readonly string[]
  readonly maxGap: number
  readonly severity: Severity
  readonly category: string
  readonly reason: string
  readonly origin: string
}

/** A failed rule load, carrying every problem (fail-closed callers surface it). */
export class RuleLoadError extends Error {
  /** One message per offending rule/document, in load order. */
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`safeharness: rule loading failed: ${problems.join('; ')}`)
    this.name = 'RuleLoadError'
    this.problems = problems
  }
}

/** Why a rule-regex is unacceptable: Python-only syntax we refuse to guess at. */
export const PYTHON_ONLY_REGEX_PATTERNS: readonly { pattern: RegExp; feature: string }[] = [
  { pattern: /\(\?P[<=!]/, feature: 'Python named group / lookbehind (?P<...) / (?P=...)' },
  { pattern: /\(\?#/, feature: 'Python comment group (?#...)' },
  { pattern: /\\A/, feature: 'Python absolute start anchor \\A' },
  { pattern: /\\Z/, feature: 'Python absolute end anchor \\Z' },
  { pattern: /\(\?>/, feature: 'Python atomic group (?>...)' },
  { pattern: /\(\?\(/, feature: 'Python conditional group (?(...))' },
  { pattern: /\\g</, feature: 'Python backreference \\g<name>' },
]

/** A tool call as the engine sees it: no DSH types, no live objects. */
export interface ToolView {
  readonly name: string
  /** Parsed arguments (deep-frozen by the registry). Never logged. */
  readonly arguments: unknown
  /** Byte length of the canonical JSON form of `arguments`. */
  readonly argsBytes: number
  /** Semantic tags resolved from the name via the tag table. */
  readonly tags: readonly string[]
  /** Registered description, when the registry knows the tool. */
  readonly description?: string
  /** Call id, for correlating ledger rows with session events. */
  readonly callId?: string
}

/** One entry in a session's tool-call trail, used by chain rules. */
export interface ToolTrailEntry {
  readonly name: string
  readonly tags: readonly string[]
  /** Monotonic per-session sequence, so gaps are countable. */
  readonly seq: number
}

/**
 * The per-session state the engine may read. Hooks own the actual store; the
 * engine only gets this read-only projection so it stays pure.
 */
export interface SessionView {
  readonly sessionId: string
  /** Tool calls so far this session, oldest first (bounded by the store). */
  readonly trail: readonly ToolTrailEntry[]
  /** Number of tool calls observed (== trail length unless bounded). */
  readonly totalCalls: number
}

/** A tool result as the engine sees it: text projections only. */
export interface ToolResultView {
  readonly name: string
  /** Rendered content blocks joined as text, for pattern scanning. */
  readonly text: string
  /** Canonical value rendered as text when it is a string (else empty). */
  readonly valueText: string
  readonly isError: boolean
  readonly callId?: string
}

/** One detected problem in a tool result. */
export interface ResultFinding {
  readonly category: 'credential_leak' | 'injection_marker'
  readonly ruleIds: readonly string[]
  readonly severity: Severity
  /** Matched span descriptions (rule ids only, never the matched text). */
  readonly detail: string
}

/** Posture finding severity vocabulary (mirrors the Python patrol's FAIL/WARN/OK/SKIP). */
export type PostureSeverity = 'FAIL' | 'WARN' | 'OK' | 'SKIP'

/** One posture check result (code vocabulary in `posture/checks.ts`). */
export interface PostureFinding {
  readonly code: string
  readonly severity: PostureSeverity
  /** Short operator-facing explanation with no secret values. */
  readonly detail: string
}

/** The environment posture checks inspect. Supplied by hooks, not read directly. */
export interface PostureEnv {
  /** Sandbox mode resolved by `ctx.sandboxPolicy`, when the service exists. */
  readonly sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Approval policy in force (`ask` | `never`), when readable. */
  readonly approvalPolicy?: 'ask' | 'never'
  /** Whether the HMR plugin is composed into this profile. */
  readonly hmrEnabled?: boolean
  /** DSH package versions the plugin expects vs. the ones actually resolved. */
  readonly versionMismatch?: readonly string[]
  /** Configured input engine and its live status (1.2.0 optional Python sidecar). */
  readonly engine?: {
    readonly kind: 'builtin' | 'sidecar'
    /** Transport lifecycle when `kind` is `sidecar`; `idle`/`failed` are not usable. */
    readonly status: 'idle' | 'starting' | 'ready' | 'failed' | 'stopped'
    /** True when the child has not yet accepted the live rule set. */
    readonly rulesStale?: boolean
  }
  /** Ledger health snapshot. */
  readonly ledger?: {
    readonly writable: boolean
    readonly lastWriteAt?: number
    readonly chainOk: boolean
  }
  /** Rule set health. */
  readonly rules?: {
    readonly loaded: boolean
    readonly hash: string
    readonly ruleCount: number
  }
}

/**
 * The engine interface. v1 is the native TypeScript implementation;
 * `createEngine` returns it. A v2 Python-sidecar implementation must satisfy the
 * same surface, which is why no method takes a DSH type.
 */
export interface SecurityEngine {
  readonly rulesetHash: string
  readonly ruleCount: number
  readonly chainCount: number
  /** Judge input rules and dangerous SQL over concatenated user text. */
  evaluateInput(text: string): Decision
  /**
   * Optional asynchronous input judgement.
   *
   * Only an engine that talks to a child process (the Python sidecar) implements
   * this. The synchronous `evaluateInput` above stays the contract: `tools.guard`
   * must never do IO, and every caller that cannot await keeps the built-in path.
   * Rejections mean "the engine could not judge"; the hook decides fail-closed
   * semantics by preset.
   */
  evaluateInputAsync?(text: string): Promise<Decision>
  /** Judge one tool call against names, tags, argument shapes and the trail. */
  evaluateTool(view: ToolView, session: SessionView): Decision
  /** Judge one tool result for leaks / injection markers. */
  evaluateToolResult(view: ToolResultView): readonly ResultFinding[]
  /** Judge model output (regex-only in v1; the judge is wired by a hook). */
  evaluateOutput(text: string): Decision
  /** Replace the live rule set after a successful reload. */
  reloadRules(ruleset: RuleSet): void
}
