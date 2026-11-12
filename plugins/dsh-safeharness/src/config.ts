/**
 * Configuration surface of `@upear/dsh-safeharness`.
 *
 * Two-layer design:
 *
 *  1. `Config` — the schemastery schema DSH validates a profile's entry config
 *     with, and the schema a deployed settings namespace resolves through. Every
 *     field is OPTIONAL here: a preset must be able to supply the value, so the
 *     schema must not silently inject a `balanced` default before `preset` has been
 *     read. Validating "present at all" is `resolveConfig`'s job, not schemastery's.
 *  2. `resolveConfig(raw)` — pure, total, fail-loud: base defaults, then the
 *     selected preset's override table, then the operator's own fields, then
 *     validation. The result is a fully-populated, deep-frozen `ResolvedConfig`.
 *
 * Precedence is therefore: explicit operator field > preset table > base default.
 * `apply()` calls {@link resolveConfig} exactly once; nothing re-reads the preset
 * tables at runtime.
 * @module
 */
import z from '@deepseek-ai/schemastery'
import type { NotifyChannel, NotifyChannelType } from './notify/channels.js'

/** Deployment posture preset. */
export type PresetId = 'observe' | 'balanced' | 'hardened'

/**
 * Which implementation judges the input surface.
 *
 * `builtin` (the default) is the pure TypeScript engine. `sidecar` adds an
 * asynchronous decision path served by a Python child process; it never changes
 * the synchronous surfaces (`tools.guard` stays IO-free).
 */
export type EngineKind = 'builtin' | 'sidecar'
/** Enforcement mode for one detection surface. */
export type EnforcementMode = 'off' | 'warn' | 'enforce'
/** Output surface mode; `enforce-buffer` trades streaming for a veto window. */
export type OutputMode = 'off' | 'warn' | 'enforce-buffer'
/** Approval bridge mode: delegate everything, or apply our coarse policy. */
export type ApprovalMode = 'delegate' | 'policy'
/** When the semantic judge runs: only on structurally flagged output, or always. */
export type JudgeScope = 'flagged' | 'always'
/**
 * Which tool arguments are inspected for dangerous SQL (R42).
 *
 * `execution` (default since 1.2.2) scans only tools that can execute what they
 * receive, plus tools this plugin cannot positively classify; `all` restores the
 * pre-1.2.2 "every string argument of every tool" behaviour.
 */
export type SqlScanScope = 'execution' | 'all'

/**
 * One operator-written notification destination.
 *
 * Every field is optional at the schema layer so `resolveConfig` can report every
 * problem at once; the resolved form (`NotifyChannel`) always has a type and a
 * non-empty webhook.
 */
export interface NotifyChannelConfig {
  type?: NotifyChannelType
  webhook?: string
  /** DingTalk signing secret; never logged. */
  secret?: string
  /** Extra request headers (a value here is treated as a credential). */
  headers?: Record<string, string>
  /** `generic` body template; `{{text}}` is replaced by the JSON-escaped sentence. */
  body?: string
  /** `onebot` group id. */
  groupId?: string
  /** `onebot` bearer token, when the bridge requires one. */
  accessToken?: string
}

/** Raw (operator-supplied) config: every field optional, presets fill the rest. */
export interface SafeHarnessConfig {
  preset?: PresetId
  /**
   * Optional Python input engine. Absent means `builtin`, i.e. the behaviour of
   * every release before 1.2.0 is unchanged.
   */
  engine?: {
    kind?: EngineKind
    /** Executable to spawn (required for `sidecar`, e.g. `C:/Python314/python.exe`). */
    command?: string
    /** Arguments (e.g. `['-u','scripts/safeharness_sidecar.py']`). */
    args?: string[]
    /** Working directory of the child. */
    cwd?: string
    /** Per-input deadline in milliseconds. */
    timeoutMs?: number
    /** Handshake deadline in milliseconds. */
    startTimeoutMs?: number
  }
  rules?: {
    /** Extra rule directory. Empty means "the rules shipped inside the package". */
    dir?: string
    /** Recompile on rule-file mtime change. */
    watch?: boolean
    /** Inline rule objects; highest precedence, override files of the same name. */
    inline?: unknown[]
  }
  input?: {
    mode?: EnforcementMode
    /** User text longer than this is truncated before matching (and reported). */
    maxChars?: number
  }
  tools?: {
    mode?: EnforcementMode
    denyTools?: string[]
    askTools?: string[]
    denyTags?: string[]
    maxArgsBytes?: number
    /**
     * Which tool arguments get the dangerous-SQL scan (R42). Absent means
     * `execution`; `all` restores the pre-1.2.2 behaviour.
     */
    sqlScan?: SqlScanScope
    trajectory?: boolean
    /** Tool-name pattern → semantic tags, for chain rules (`bash*` → `shell`). */
    tagOverrides?: { pattern: string; tags: string[] }[]
  }
  results?: {
    mode?: EnforcementMode
    /** Finding categories that block when `mode: 'enforce'`. */
    blockOn?: string[]
  }
  output?: {
    mode?: OutputMode
    /** Wall-clock cap on buffering in `enforce-buffer`; past it the stream degrades. */
    bufferTimeoutMs?: number
    /** Character cap on buffered text; past it the stream degrades to pass-through. */
    bufferMaxChars?: number
    judge?: {
      enabled?: boolean
      /**
       * When the judge runs: only for outputs the structural rules already flagged
       * (`flagged`, the default — a precision control, bounded cost) or for every
       * reviewed output (`always`).
       */
      scope?: JudgeScope
      provider?: string
      model?: string
      maxChars?: number
      timeoutMs?: number
    }
  }
  approval?: {
    mode?: ApprovalMode
    allowOnce?: string[]
  }
  audit?: {
    format?: 'ndjson' | 'off'
    /** Ledger directory. Empty = `$DSH_HOME/safeharness/audit`. */
    dir?: string
    redact?: boolean
    hashChain?: boolean
    required?: boolean
    rotateMb?: number
  }
  posture?: {
    onLoad?: boolean
    /** Posture codes that refuse plugin load when they FAIL (intended for hardened). */
    failOn?: string[]
  }
  patrol?: {
    windowMinutes?: number
    baselineWindows?: number
    factor?: number
    minCount?: number
    healthUrls?: string[]
    /** Deprecated single-channel alias: one Feishu webhook. */
    feishuWebhook?: string
    /** Notification destinations; overrides {@link feishuWebhook} when non-empty. */
    notify?: NotifyChannelConfig[]
  }
  budget?: {
    maxTokensPerTurn?: number
  }
  draft?: {
    /** Enable the drafting tool and `/safeharness draft`. Drafts are never applied. */
    enabled?: boolean
    /** Drafting provider route; empty reuses `output.judge.provider`. */
    provider?: string
    /** Drafting model id; empty reuses `output.judge.model`. */
    model?: string
    /** Description characters sent to the model. */
    maxChars?: number
    /** Drafting deadline in milliseconds. */
    timeoutMs?: number
    /** Completion budget for one draft. */
    maxTokens?: number
  }
}

/**
 * Keep a missing array *missing* through schemastery validation.
 *
 * Measured on a real host: a bare `z.array(...)` materializes `[]` for an absent key,
 * so the host handed `apply()` a validated config where `posture.failOn` and
 * `results.blockOn` were already `[]` — and `resolveConfig` then treated those as
 * operator overrides, silently defeating the preset tables on every real host.
 * `z.transform(inner, identity)` preserves absence (validated `{}` stays `{}`) while
 * still passing explicit values through unchanged, so "absent" and "explicitly
 * empty" stay distinguishable.
 */
function keepAbsent<S>(inner: S): S {
  return z.transform(inner as never, (value: unknown) => value) as unknown as S
}

/**
 * Cross-copy identity of a schemastery `.volatile()` reference.
 *
 * A volatile field resolves to a `Volatile<T>` box (cosmokit), not to `T`: the
 * DSH settings surface updates that box in place when the profile patch changes,
 * so a plugin that snapshots the box value on the next restart would go stale.
 * The symbol is shared process-wide, so a duck-typed check needs no runtime
 * dependency on cosmokit (this package does not import it).
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** True for a schemastery volatile reference (a cosmokit `Volatile<T>`). */
function isVolatileRef(value: unknown): value is { get: () => unknown } {
  return value !== null && typeof value === 'object' && VOLATILE_WRITE in value
}

/**
 * Deep-unwrap every volatile reference into its current plain value.
 *
 * The host validates a plugin entry through {@link Config}, so `apply()` receives
 * `.volatile()` fields as boxes; every consumer in this package wants plain data.
 * Callers that need live values read {@link Config} through the loader's
 * `loader/volatile-update` event and call `applyHotConfig()` again.
 *
 * @param value - a resolved config value that may contain volatile references.
 * @returns the same shape with every volatile reference replaced by `.get()`.
 */
export function unwrapVolatile(value: unknown): unknown {
  if (isVolatileRef(value)) return unwrapVolatile(value.get())
  if (Array.isArray(value)) return value.map((item) => unwrapVolatile(item))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = unwrapVolatile(item)
    return out
  }
  return value
}

/**
 * Schemastery schema for the entry config. Deliberately defaultless: see the
 * module comment. `.description()` strings are what a configuration UI renders.
 *
 * Fields marked `.volatile()` are the subset the DSH settings page may edit live:
 * values the plugin can apply without remounting its fiber. Everything else
 * (preset, engine/rules/audit/rules paths, credential-bearing notification
 * destinations) stays patch-only: a settings write to those remounts the entry,
 * and a rejected value is rolled back by the host's configuration editor.
 *
 * The declared type stays the plain shape: `apply()` receives live boxes for the
 * volatile fields but {@link resolveConfig} unwraps them before any consumer sees
 * the value.
 */
export const Config = z.object({
  preset: z.union(['observe', 'balanced', 'hardened'] as const)
    .description('Deployment posture preset: observe / balanced / hardened.'),
  engine: z.object({
    kind: z.union(['builtin', 'sidecar'] as const)
      .description('Input engine: built-in TypeScript (default) or the optional Python sidecar.'),
    command: z.string().description('Executable to spawn; required when kind is sidecar.'),
    args: keepAbsent(z.array(z.string())).description('Arguments for the sidecar command.'),
    cwd: z.string().description('Working directory for the sidecar process.'),
    timeoutMs: z.number().description('Per-input deadline in milliseconds.'),
    startTimeoutMs: z.number().description('Handshake deadline in milliseconds.'),
  }).description('Optional Python input engine (async input path only).'),
  rules: z.object({
    dir: z.string().description('Extra rule directory; empty means the packaged rules.'),
    watch: z.boolean().description('Recompile rules when a rule file changes.'),
    inline: keepAbsent(z.array(z.any())).description('Inline rule objects (highest precedence).'),
  }).description('Rule loading.'),

  input: z.object({
    mode: z.union(['off', 'warn', 'enforce'] as const).volatile().description('Input guard mode.'),
    maxChars: z.number().min(1).volatile().description('Truncate user text beyond this many characters.'),
  }).description('Input guard (agent/pre-step).'),

  tools: z.object({
    mode: z.union(['off', 'warn', 'enforce'] as const).volatile().description('Tool guard mode.'),
    denyTools: keepAbsent(z.array(z.string())).description('Tool name patterns always denied.'),
    askTools: keepAbsent(z.array(z.string())).description('Tool name patterns that require approval.'),
    denyTags: keepAbsent(z.array(z.string())).description('Semantic tags denied outright.'),
    maxArgsBytes: z.number().min(1).volatile().description('Maximum serialized argument size in bytes.'),
    sqlScan: z.union(['execution', 'all'] as const)
      .description('Dangerous-SQL scan scope: only execution-facing tools (default) or every tool argument.'),
    trajectory: z.boolean().volatile().description('Track per-session tool sequence for chain rules.'),
    tagOverrides: keepAbsent(z.array(z.object({
      pattern: z.string().description('Tool name glob.'),
      tags: keepAbsent(z.array(z.string())).description('Tags applied when the glob matches.'),
    }))).description('Tool name → semantic tag mapping.'),
  }).description('Tool guard (pre-execute / guard).'),

  results: z.object({
    mode: z.union(['off', 'warn', 'enforce'] as const).volatile().description('Tool result scan mode.'),
    blockOn: keepAbsent(z.array(z.string())).description('Finding categories blocked in enforce mode.'),
  }).description('Tool result guard (post-execute).'),

  output: z.object({
    mode: z.union(['off', 'warn', 'enforce-buffer'] as const).volatile().description('Output review mode.'),
    bufferTimeoutMs: z.number().min(1).volatile().description('Wall-clock cap on buffering in enforce-buffer mode.'),
    bufferMaxChars: z.number().min(1).volatile().description('Character cap on buffered output before degrading to warn.'),
    judge: z.object({
      enabled: z.boolean().volatile().description('Enable the optional semantic judge.'),
      scope: z.union(['flagged', 'always'] as const).volatile().description('Judge only structurally flagged output, or all output.'),
      provider: z.string().volatile().description('Judge provider route.'),
      model: z.string().volatile().description('Judge model id.'),
      maxChars: z.number().min(1).volatile().description('Output characters fed to the judge.'),
      timeoutMs: z.number().min(1).volatile().description('Judge deadline.'),
    }).description('Semantic judge.'),
  }).description('Output review (llm/stream).'),

  approval: z.object({
    mode: z.union(['delegate', 'policy'] as const).volatile().description('Approval bridge mode.'),
    allowOnce: keepAbsent(z.array(z.string())).description('Tool name patterns granted once.'),
  }).description('Approval bridge.'),

  audit: z.object({
    format: z.union(['ndjson', 'off'] as const).description('Ledger format.'),
    dir: z.string().description('Ledger directory; empty means $DSH_HOME/safeharness/audit.'),
    redact: z.boolean().description('Store hashes and lengths only, never raw content.'),
    hashChain: z.boolean().description('Chain every record to its predecessor.'),
    required: z.boolean().description('Refuse enforcement when the ledger cannot be written.'),
    rotateMb: z.number().description('Rotate the ledger file at this size.'),
  }).description('Audit ledger.'),

  posture: z.object({
    onLoad: z.boolean().description('Run posture checks at plugin load.'),
    failOn: keepAbsent(z.array(z.string())).description('Posture codes that refuse plugin load.'),
  }).description('Posture self-check.'),

  patrol: z.object({
    windowMinutes: z.number().description('Denial-rate window.'),
    baselineWindows: z.number().description('Baseline windows for the rate comparison.'),
    factor: z.number().description('Rate multiplier that counts as anomalous.'),
    minCount: z.number().description('Minimum denials before the rate can fail.'),
    healthUrls: keepAbsent(z.array(z.string())).description('HTTP endpoints probed by patrol.'),
    feishuWebhook: z.string().description('Deprecated: one Feishu webhook; prefer patrol.notify. Never logged.'),
    notify: keepAbsent(z.array(z.object({
      type: z.union(['feishu', 'dingtalk', 'wecom', 'onebot', 'generic'] as const)
        .description('Envelope family: feishu / dingtalk / wecom / onebot (QQ bridge) / generic.'),
      webhook: z.string().description('Destination URL. Treated as a credential: never logged or printed.'),
      secret: z.string().description('DingTalk signing secret. Never logged.'),
      headers: z.any().description('Extra request headers for this channel (values are credentials).'),
      body: z.string().description('generic: JSON body template; {{text}} is replaced by the sentence.'),
      groupId: z.string().description('onebot: group id to post into.'),
      accessToken: z.string().description('onebot: bearer token. Never logged.'),
    }))).description('Notification destinations (one or more); overrides feishuWebhook.'),
  }).description('Patrol.'),

  budget: z.object({
    maxTokensPerTurn: z.number().min(0).step(1).volatile().description('Per-turn token budget; 0 disables.'),
  }).description('Budget guard.'),

  draft: z.object({
    enabled: z.boolean().volatile().description('Enable LLM-assisted rule drafting (tool + command); drafts are never applied.'),
    provider: z.string().volatile().description('Drafting provider route; empty reuses the judge route.'),
    model: z.string().volatile().description('Drafting model id; empty reuses the judge route.'),
    maxChars: z.number().min(1).volatile().description('Description characters sent to the drafting model.'),
    timeoutMs: z.number().min(1).volatile().description('Drafting deadline; on expiry the draft fails, nothing is applied.'),
    maxTokens: z.number().min(1).volatile().description('Completion budget for one draft.'),
  }).description('LLM-assisted rule drafting (draft only).'),
}) as unknown as z<SafeHarnessConfig>

/** One posture finding's severity vocabulary (mirrors the Python patrol). */
export type { PostureSeverity } from './engine/types.js'

/** Fully resolved config: every field present, deep-frozen, safe to share. */
export interface ResolvedConfig {
  readonly preset: PresetId
  readonly engine: {
    readonly kind: EngineKind
    readonly command: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly timeoutMs: number
    readonly startTimeoutMs: number
  }
  readonly rules: {
    readonly dir: string
    readonly watch: boolean
    readonly inline: readonly unknown[]
  }
  readonly input: { readonly mode: EnforcementMode; readonly maxChars: number }
  readonly tools: {
    readonly mode: EnforcementMode
    readonly denyTools: readonly string[]
    readonly askTools: readonly string[]
    readonly denyTags: readonly string[]
    readonly maxArgsBytes: number
    /** Dangerous-SQL scan scope (R42); see {@link SqlScanScope}. */
    readonly sqlScan: SqlScanScope
    readonly trajectory: boolean
    readonly tagOverrides: readonly { readonly pattern: string; readonly tags: readonly string[] }[]
  }
  readonly results: { readonly mode: EnforcementMode; readonly blockOn: readonly string[] }
  readonly output: {
    readonly mode: OutputMode
    readonly bufferTimeoutMs: number
    readonly bufferMaxChars: number
    readonly judge: {
      readonly enabled: boolean
      readonly scope: JudgeScope
      readonly provider: string
      readonly model: string
      readonly maxChars: number
      readonly timeoutMs: number
    }
  }
  readonly approval: { readonly mode: ApprovalMode; readonly allowOnce: readonly string[] }
  readonly audit: {
    readonly format: 'ndjson' | 'off'
    readonly dir: string
    readonly redact: boolean
    readonly hashChain: boolean
    readonly required: boolean
    readonly rotateMb: number
  }
  readonly posture: { readonly onLoad: boolean; readonly failOn: readonly string[] }
  readonly patrol: {
    readonly windowMinutes: number
    readonly baselineWindows: number
    readonly factor: number
    readonly minCount: number
    readonly healthUrls: readonly string[]
    /** Kept for compatibility: the first Feishu route, or the resolved single channel. */
    readonly feishuWebhook: string
    /** Normalised destinations (legacy `feishuWebhook` becomes one Feishu channel). */
    readonly notify: readonly NotifyChannel[]
  }
  readonly budget: { readonly maxTokensPerTurn: number }
  readonly draft: {
    readonly enabled: boolean
    /** Empty means "reuse `output.judge.provider`". */
    readonly provider: string
    /** Empty means "reuse `output.judge.model`". */
    readonly model: string
    readonly maxChars: number
    readonly timeoutMs: number
    readonly maxTokens: number
  }
}

/**
 * Preset override tables (see the README's presets section). Only the dimensions a preset actually changes
 * appear here; everything else comes from {@link BASE_DEFAULTS}. A deployment may
 * override any single field in its patch layer without switching preset.
 */
const PRESET_OVERRIDES: Record<PresetId, DeepPartial<SafeHarnessConfig>> = {
  observe: {
    input: { mode: 'warn' },
    tools: { mode: 'warn' },
    results: { mode: 'warn', blockOn: [] },
    output: { mode: 'warn' },
    approval: { mode: 'delegate' },
    audit: { required: false },
    posture: { failOn: [] },
  },
  balanced: {
    input: { mode: 'enforce' },
    tools: { mode: 'enforce' },
    results: { mode: 'warn', blockOn: ['credential_leak'] },
    output: { mode: 'warn' },
    approval: { mode: 'delegate' },
    audit: { required: true },
    posture: { failOn: [] },
  },
  hardened: {
    input: { mode: 'enforce' },
    tools: { mode: 'enforce' },
    results: { mode: 'enforce', blockOn: ['credential_leak', 'injection_marker'] },
    output: { mode: 'warn' },
    approval: { mode: 'policy' },
    audit: { required: true },
    // The failure matrix requires a hardened deployment to REFUSE the load on a host
    // version mismatch; the gate is `posture.failOn`, so the code must be in this list
    // even though the preset table only lists the deployment-posture codes.
    posture: {
      failOn: [
        'sandbox_danger_full_access',
        'approval_never',
        'hmr_enabled',
        'plugin_version_mismatch',
        // Opt-in sidecar only: when the operator configured the Python engine it
        // must be running, otherwise the hardened load gate refuses.
        'engine_sidecar_unavailable',
      ],
    },
  },
}

/**
 * Defaults shared by every preset. A preset never overrides these unless its
 * table above names the field.
 */
const BASE_DEFAULTS: SafeHarnessConfig & Record<string, unknown> = {
  preset: 'balanced',
  // 1.2.0 keeps `builtin` as the factory default: enabling the sidecar is an
  // explicit operator choice that adds a Python dependency.
  engine: { kind: 'builtin', command: '', args: [], cwd: '', timeoutMs: 1500, startTimeoutMs: 10000 },
  rules: { dir: '', watch: true, inline: [] },
  input: { mode: 'enforce', maxChars: 60000 },
  tools: {
    mode: 'enforce',
    denyTools: [],
    askTools: [],
    denyTags: [],
    maxArgsBytes: 65536,
    // R42: an SQL example in a document is data, not intent. Only tools that can
    // execute what they receive are scanned; `all` restores the old behaviour.
    sqlScan: 'execution',
    trajectory: true,
    tagOverrides: [],
  },
  results: { mode: 'warn', blockOn: ['credential_leak'] },
  output: {
    mode: 'warn',
    bufferTimeoutMs: 15000,
    bufferMaxChars: 512000,
    judge: { enabled: false, scope: 'flagged', provider: '', model: '', maxChars: 12000, timeoutMs: 4000 },
  },
  approval: { mode: 'delegate', allowOnce: [] },
  audit: { format: 'ndjson', dir: '', redact: true, hashChain: true, required: true, rotateMb: 64 },
  posture: { onLoad: true, failOn: [] },
  patrol: {
    windowMinutes: 10,
    baselineWindows: 6,
    factor: 5,
    minCount: 10,
    healthUrls: [],
    feishuWebhook: '',
    notify: [],
  },
  budget: { maxTokensPerTurn: 0 },
  // Drafting is opt-in per invocation (a tool call or `/safeharness draft`), so it can
  // stay enabled by default without spending anything at load time. The route falls
  // back to the judge's provider/model when left empty.
  draft: { enabled: true, provider: '', model: '', maxChars: 500, timeoutMs: 20000, maxTokens: 400 },
}

/** Recursively-partial helper for the override tables. */
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer _U)[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/** True for a plain object we should recurse into (arrays are values, not maps). */
function isMergeableObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Deep-merge `patch` over `base`, returning a fresh plain object. */
function mergeDeep(base: unknown, patch: unknown): unknown {
  if (!isMergeableObject(base) || !isMergeableObject(patch)) return patch === undefined ? base : patch
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = isMergeableObject(value) && isMergeableObject(out[key])
      ? mergeDeep(out[key], value)
      : value
  }
  return out
}

/** Fail-loud config rejection; carries every problem found, not just the first. */
export class ConfigError extends Error {
  /** Human-readable validation problems, in discovery order. */
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`safeharness: invalid configuration: ${problems.join('; ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

/** Assert a value is one of `allowed`, returning it narrowed. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string, problems: string[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  problems.push(`${path} must be one of ${allowed.join('|')} (got ${describeValue(value)})`)
  return allowed[0] as T
}

/** Bounded non-negative number, or a recorded problem. */
function nonNegative(value: unknown, path: string, problems: string[], fallback: number, { integer = false } = {}): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isInteger(value))) {
    return value
  }
  problems.push(`${path} must be a ${integer ? 'non-negative integer' : 'non-negative number'} (got ${describeValue(value)})`)
  return fallback
}

/** Positive number, or a recorded problem. */
function positive(value: unknown, path: string, problems: string[], fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  problems.push(`${path} must be a positive number (got ${describeValue(value)})`)
  return fallback
}

/** String list, or a recorded problem. */
function stringList(value: unknown, path: string, problems: string[]): string[] {
  if (value === undefined) return []
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return [...value] as string[]
  problems.push(`${path} must be an array of strings`)
  return []
}

/** Compact, safe description of a bad value for an error message (never a secret dump). */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  const kind = typeof value
  if (kind === 'string') return `string(${(value as string).length})`
  if (kind === 'number' || kind === 'boolean') return String(value)
  if (Array.isArray(value)) return `array(${value.length})`
  return kind
}

/** Deep-freeze a resolved config so no consumer can mutate shared state. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
  }
  return value
}

/**
 * Expand a preset and validate an operator config into a {@link ResolvedConfig}.
 *
 * @param raw - the (possibly partial) config a profile passed to the plugin.
 *   `.volatile()` fields may be live boxes; they are unwrapped at entry.
 * @returns the fully populated, frozen config.
 * @throws ConfigError listing every problem when a field is unacceptable. Presets
 *   and base defaults guarantee presence, so problems are only ever wrong types,
 *   out-of-range numbers or unknown enum values.
 */
export function resolveConfig(raw: SafeHarnessConfig = {}): ResolvedConfig {
  const problems: string[] = []
  // `apply()` may receive `.volatile()` fields as live boxes (the host validates
  // through {@link Config}); this package only ever consumes plain values.
  const plain = unwrapVolatile(raw) as SafeHarnessConfig
  // `preset` is read before any other default is applied: an absent preset means
  // the factory default (`balanced`), never the first member of the enum (which
  // would silently turn a defaultless config into `observe`).
  const preset = plain.preset === undefined
    ? (BASE_DEFAULTS.preset as PresetId)
    : oneOf(plain.preset, ['observe', 'balanced', 'hardened'] as const, 'preset', problems)
  const merged = mergeDeep(
    mergeDeep(BASE_DEFAULTS, PRESET_OVERRIDES[preset]),
    plain,
  ) as SafeHarnessConfig

  const engine = merged.engine ?? {}
  const rules = merged.rules ?? {}
  if (typeof rules.dir !== 'string') problems.push('rules.dir must be a string')
  const inline = rules.inline ?? []
  if (!Array.isArray(inline)) problems.push('rules.inline must be an array')

  const input = merged.input ?? {}
  const tools = merged.tools ?? {}
  const results = merged.results ?? {}
  const output = merged.output ?? {}
  const judge = output.judge ?? {}
  const approval = merged.approval ?? {}
  const audit = merged.audit ?? {}
  const posture = merged.posture ?? {}
  const patrol = merged.patrol ?? {}
  const budget = merged.budget ?? {}
  const draft = merged.draft ?? {}

  const tagOverrides = Array.isArray(tools.tagOverrides)
    ? tools.tagOverrides.filter((item): item is { pattern: string; tags: string[] } => {
      const ok = item !== null && typeof item === 'object'
        && typeof (item as { pattern?: unknown }).pattern === 'string'
        && Array.isArray((item as { tags?: unknown }).tags)
      if (!ok) problems.push('tools.tagOverrides entries need { pattern: string, tags: string[] }')
      return ok
    }).map((item) => ({ pattern: item.pattern, tags: stringList(item.tags, 'tools.tagOverrides[].tags', problems) }))
    : (problems.push('tools.tagOverrides must be an array'), [])

  const engineKind = oneOf(engine.kind, ['builtin', 'sidecar'] as const, 'engine.kind', problems)
  const engineCommand = typeof engine.command === 'string' ? engine.command.trim() : ''
  // Refuse a half-configured engine at load time: `kind: sidecar` with no command
  // would otherwise only surface as a dead engine on the first user turn.
  if (engineKind === 'sidecar' && engineCommand === '') {
    problems.push('engine.command is required when engine.kind is sidecar')
  }

  const resolved: ResolvedConfig = {
    preset,
    engine: {
      kind: engineKind,
      command: engineCommand,
      args: stringList(engine.args, 'engine.args', problems),
      cwd: typeof engine.cwd === 'string' ? engine.cwd : '',
      timeoutMs: positive(engine.timeoutMs, 'engine.timeoutMs', problems, 1500),
      startTimeoutMs: positive(engine.startTimeoutMs, 'engine.startTimeoutMs', problems, 10000),
    },
    rules: {
      dir: typeof rules.dir === 'string' ? rules.dir : '',
      watch: typeof rules.watch === 'boolean' ? rules.watch : true,
      inline: Array.isArray(inline) ? [...inline] : [],
    },
    input: {
      mode: oneOf(input.mode, ['off', 'warn', 'enforce'] as const, 'input.mode', problems),
      maxChars: positive(input.maxChars, 'input.maxChars', problems, 60000),
    },
    tools: {
      mode: oneOf(tools.mode, ['off', 'warn', 'enforce'] as const, 'tools.mode', problems),
      denyTools: stringList(tools.denyTools, 'tools.denyTools', problems),
      askTools: stringList(tools.askTools, 'tools.askTools', problems),
      denyTags: stringList(tools.denyTags, 'tools.denyTags', problems),
      maxArgsBytes: positive(tools.maxArgsBytes, 'tools.maxArgsBytes', problems, 65536),
      sqlScan: oneOf(tools.sqlScan ?? 'execution', ['execution', 'all'] as const, 'tools.sqlScan', problems),
      trajectory: typeof tools.trajectory === 'boolean' ? tools.trajectory : true,
      tagOverrides,
    },
    results: {
      mode: oneOf(results.mode, ['off', 'warn', 'enforce'] as const, 'results.mode', problems),
      blockOn: stringList(results.blockOn, 'results.blockOn', problems),
    },
    output: {
      mode: oneOf(output.mode, ['off', 'warn', 'enforce-buffer'] as const, 'output.mode', problems),
      bufferTimeoutMs: positive(output.bufferTimeoutMs, 'output.bufferTimeoutMs', problems, 15000),
      bufferMaxChars: positive(output.bufferMaxChars, 'output.bufferMaxChars', problems, 512000),
      judge: {
        enabled: typeof judge.enabled === 'boolean' ? judge.enabled : false,
        scope: oneOf(judge.scope, ['flagged', 'always'] as const, 'output.judge.scope', problems),
        provider: typeof judge.provider === 'string' ? judge.provider : '',
        model: typeof judge.model === 'string' ? judge.model : '',
        maxChars: positive(judge.maxChars, 'output.judge.maxChars', problems, 12000),
        timeoutMs: positive(judge.timeoutMs, 'output.judge.timeoutMs', problems, 4000),
      },
    },
    approval: {
      mode: oneOf(approval.mode, ['delegate', 'policy'] as const, 'approval.mode', problems),
      allowOnce: stringList(approval.allowOnce, 'approval.allowOnce', problems),
    },
    audit: {
      format: oneOf(audit.format, ['ndjson', 'off'] as const, 'audit.format', problems),
      dir: typeof audit.dir === 'string' ? audit.dir : '',
      redact: typeof audit.redact === 'boolean' ? audit.redact : true,
      hashChain: typeof audit.hashChain === 'boolean' ? audit.hashChain : true,
      required: typeof audit.required === 'boolean' ? audit.required : true,
      rotateMb: positive(audit.rotateMb, 'audit.rotateMb', problems, 64),
    },
    posture: {
      onLoad: typeof posture.onLoad === 'boolean' ? posture.onLoad : true,
      failOn: stringList(posture.failOn, 'posture.failOn', problems),
    },
    patrol: {
      windowMinutes: positive(patrol.windowMinutes, 'patrol.windowMinutes', problems, 10),
      baselineWindows: nonNegative(patrol.baselineWindows, 'patrol.baselineWindows', problems, 6, { integer: true }),
      factor: positive(patrol.factor, 'patrol.factor', problems, 5),
      minCount: nonNegative(patrol.minCount, 'patrol.minCount', problems, 10, { integer: true }),
      healthUrls: stringList(patrol.healthUrls, 'patrol.healthUrls', problems),
      feishuWebhook: typeof patrol.feishuWebhook === 'string' ? patrol.feishuWebhook : '',
      notify: resolveNotifyChannels(patrol, problems),
    },
    budget: {
      maxTokensPerTurn: nonNegative(budget.maxTokensPerTurn, 'budget.maxTokensPerTurn', problems, 0, { integer: true }),
    },
    draft: {
      enabled: typeof draft.enabled === 'boolean' ? draft.enabled : true,
      provider: typeof draft.provider === 'string' ? draft.provider : '',
      model: typeof draft.model === 'string' ? draft.model : '',
      maxChars: positive(draft.maxChars, 'draft.maxChars', problems, 500),
      timeoutMs: positive(draft.timeoutMs, 'draft.timeoutMs', problems, 20000),
      maxTokens: positive(draft.maxTokens, 'draft.maxTokens', problems, 400),
    },
  }

  if (resolved.output.judge.enabled && (resolved.output.judge.provider === '' || resolved.output.judge.model === '')) {
    // Not fatal on its own: the posture check reports `judge_unavailable` and the
    // output hook degrades by preset (see the failure matrix). Hardened refuses to load on it.
    // Kept as a problem only in hardened, where the judge is a stated requirement.
    if (preset === 'hardened') {
      problems.push('output.judge.enabled requires output.judge.provider and output.judge.model under hardened')
    }
  }

  if (problems.length > 0) throw new ConfigError(problems)
  return deepFreeze(resolved)
}

/** Whether a mode actually enforces (denies) rather than only observing. */
export function isEnforcing(mode: EnforcementMode | OutputMode): boolean {
  return mode === 'enforce' || mode === 'enforce-buffer'
}

/** Whether a mode is disabled entirely. */
export function isOff(mode: EnforcementMode | OutputMode): boolean {
  return mode === 'off'
}

/**
 * Normalise `patrol.notify` into channels, falling back to the legacy single
 * `feishuWebhook`.
 *
 * Validation never quotes a webhook: the problem text names the index and the field,
 * so an invalid config cannot leak a bot token through an error message or a log.
 */
function resolveNotifyChannels(
  patrol: { notify?: unknown; feishuWebhook?: unknown },
  problems: string[],
): readonly NotifyChannel[] {
  const channels: NotifyChannel[] = []
  const raw = patrol.notify
  if (raw !== undefined && !Array.isArray(raw)) {
    problems.push('patrol.notify must be an array of channel objects')
  } else if (Array.isArray(raw)) {
    raw.forEach((entry, index) => {
      if (!isMergeableObject(entry)) {
        problems.push(`patrol.notify[${index}] must be an object`)
        return
      }
      const type = oneOf(
        entry.type,
        ['feishu', 'dingtalk', 'wecom', 'onebot', 'generic'] as const,
        `patrol.notify[${index}].type`,
        problems,
      )
      const webhook = typeof entry.webhook === 'string' ? entry.webhook.trim() : ''
      if (webhook.length === 0) problems.push(`patrol.notify[${index}].webhook must be a non-empty URL`)
      const secret = optionalString(entry.secret, `patrol.notify[${index}].secret`, problems)
      const body = optionalString(entry.body, `patrol.notify[${index}].body`, problems)
      const groupId = optionalString(entry.groupId, `patrol.notify[${index}].groupId`, problems)
      const accessToken = optionalString(entry.accessToken, `patrol.notify[${index}].accessToken`, problems)
      if (type === 'onebot' && (groupId === undefined || groupId.trim().length === 0)) {
        problems.push(`patrol.notify[${index}].groupId is required for the onebot channel`)
      }
      const headers = headerMap(entry.headers, index, problems)
      channels.push({
        type,
        webhook,
        ...(secret === undefined ? {} : { secret }),
        ...(body === undefined ? {} : { body }),
        ...(groupId === undefined ? {} : { groupId }),
        ...(accessToken === undefined ? {} : { accessToken }),
        ...(headers === undefined ? {} : { headers }),
      })
    })
  }
  if (channels.length === 0) {
    const legacy = typeof patrol.feishuWebhook === 'string' ? patrol.feishuWebhook.trim() : ''
    if (legacy.length > 0) channels.push({ type: 'feishu', webhook: legacy })
  }
  return channels
}

/** Optional string field; a non-string value is a recorded problem. */
function optionalString(value: unknown, path: string, problems: string[]): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  problems.push(`${path} must be a string`)
  return undefined
}

/** Validate an optional header map (every value must be a string). */
function headerMap(value: unknown, index: number, problems: string[]): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (!isMergeableObject(value)) {
    problems.push(`patrol.notify[${index}].headers must be an object of strings`)
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      problems.push(`patrol.notify[${index}].headers.${key} must be a string`)
      continue
    }
    out[key] = item
  }
  return out
}
