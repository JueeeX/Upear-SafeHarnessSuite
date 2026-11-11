/**
 * Tool-surface judgement: name/tag policy, argument shape, trajectory chains and
 * the tool-result scan.
 *
 * The Python engine this mirrors is spread over `sql_guard.py` (argument SQL),
 * `trajectory.py` (chain rules over the session sequence) and the result rules.
 * Deliberate differences from Python:
 *
 * - **Chain endpoint matching is OR** between the name regex and the tag set, as
 *   required by the T1.2 spec ("tag alternatives are OR'ed with the regex").
 *   Python's `_endpoint_matches` ANDs them when both are given. OR is strictly
 *   more denying, i.e. fail-closed, and keeps tag-only and name-only rules
 *   working without the Python AND trap.
 * - The result scan (`credential_leak` / `injection_marker`) is new code: the
 *   Python `output_guard.py` has **no** credential, private-key or entropy
 *   detector at all (digest §7.2/§7.3); it only runs the inform rule family plus
 *   an LLM judge. The patterns here are therefore additions, not a port.
 *
 * Secrets discipline: no function in this module ever receives a value it logs.
 * Decisions carry rule ids, tool names and statement kinds only; findings carry a
 * fixed ASCII description and rule ids. Matched substrings are never retained.
 * @module
 */
import type { ResolvedConfig } from '../config.js'
import { inspectSql } from './sql.js'
import type {
  CompiledChainRule,
  Decision,
  ResultFinding,
  RuleSet,
  Severity,
  SessionView,
  ToolResultView,
  ToolView,
} from './types.js'
import { ReasonCode } from './types.js'

/** Severity ordering, highest wins. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
}

/**
 * Severity for config-driven tool denials. Neither `denyTools` nor `denyTags`
 * carries a severity in the config schema, and an explicit block is a hard
 * policy statement, so these are `high` (chain rules keep their own severity).
 */
const CONFIG_DENIAL_SEVERITY: Severity = 'high'

/** Severity attached to an `ask` decision (not a denial). */
const ASK_SEVERITY: Severity = 'medium'

/** Synthetic rule id recorded for dangerous SQL found in a tool argument. */
const SQL_ARG_RULE_ID = 'dangerous_sql'

/** Category for a dangerous-SQL argument hit (Python risk-tag vocabulary). */
const SQL_CATEGORY = 'dangerous_sql'

/** Hard bound on the text the result scanner looks at (256 KiB, §6.5(d)). */
export const MAX_RESULT_SCAN_CHARS = 256 * 1024

/** Bound on result tokens examined by the entropy heuristic. */
const MAX_ENTROPY_TOKENS = 2000

// ---------------------------------------------------------------------------
// Name globs and the built-in tag table
// ---------------------------------------------------------------------------

/** One semantic-tag rule: `*`-only glob over the tool name. */
export interface TagRule {
  readonly pattern: string
  readonly tags: readonly string[]
}

/**
 * Built-in tool-name → semantic-tag table (v1 has no tool descriptors, §6.3).
 * Overrides from `tools.tagOverrides` are unioned on top, in config order.
 */
const BUILTIN_TAG_RULES: readonly TagRule[] = [
  // Database / SQL surface: state-changing and internal by nature.
  { pattern: '*sql*', tags: ['db', 'internal'] },
  { pattern: 'db_*', tags: ['db', 'internal'] },
  { pattern: '*_db', tags: ['db', 'internal'] },
  { pattern: 'database*', tags: ['db', 'internal'] },
  { pattern: '*database*', tags: ['db', 'internal'] },
  { pattern: 'query_*', tags: ['db', 'internal'] },
  // Shell surface.
  { pattern: 'bash*', tags: ['shell'] },
  { pattern: 'pwsh*', tags: ['shell'] },
  { pattern: 'powershell*', tags: ['shell'] },
  { pattern: 'shell*', tags: ['shell'] },
  { pattern: 'terminal*', tags: ['shell'] },
  { pattern: 'cmd*', tags: ['shell'] },
  // Network / egress surface.
  { pattern: 'web_*', tags: ['network', 'egress'] },
  { pattern: '*fetch*', tags: ['network', 'egress'] },
  { pattern: '*search*', tags: ['network', 'egress'] },
  { pattern: 'http*', tags: ['network', 'egress'] },
  // MCP surface.
  { pattern: 'mcp_*', tags: ['mcp'] },
  { pattern: 'mcp__*', tags: ['mcp'] },
  { pattern: 'mcp-*', tags: ['mcp'] },
  // Filesystem surface.
  { pattern: 'fs_*', tags: ['fs'] },
  { pattern: 'file_*', tags: ['fs'] },
  { pattern: 'read*', tags: ['fs'] },
  { pattern: 'write*', tags: ['fs'] },
  { pattern: 'edit*', tags: ['fs'] },
  { pattern: 'glob*', tags: ['fs'] },
  { pattern: 'grep*', tags: ['fs'] },
  { pattern: 'ls*', tags: ['fs'] },
  { pattern: 'list_*', tags: ['fs'] },
]

/** Characters that are special in a JS regex (escaped by {@link escapeLiteral}). */
const REGEX_SPECIAL_CHARS: ReadonlySet<string> = new Set([
  '\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|', '/',
])

/** Escape every regex metacharacter in `text`, building the literal by hand. */
function escapeLiteral(text: string): string {
  let out = ''
  for (const char of text) out += REGEX_SPECIAL_CHARS.has(char) ? `\\${char}` : char
  return out
}

/**
 * Compiled glob cache. Keys are config/table patterns (a small, fixed set), so
 * the cache is bounded by configuration, never by attacker input.
 */
const globCache = new Map<string, RegExp>()

/**
 * Translate one `*`-only glob into a case-insensitive anchored regex.
 *
 * Only `*` is a wildcard; every other character is a literal. No `g` flag, so
 * repeated `test` calls are stateless (§9.9).
 */
function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern)
  if (cached !== undefined) return cached
  const source = pattern.split('*').map(escapeLiteral).join('.*')
  const regex = new RegExp(`^${source}$`, 'i')
  globCache.set(pattern, regex)
  return regex
}

/** Stateless regex test, tolerant of a stray global/sticky flag from a caller. */
function testRegex(regex: RegExp, text: string): boolean {
  if (regex.global || regex.sticky) regex.lastIndex = 0
  const hit = regex.test(text)
  if (regex.global || regex.sticky) regex.lastIndex = 0
  return hit
}

/** Deterministic, de-duplicated, sorted ids. */
function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort()
}

/**
 * Whether `name` matches any of the `*`-glob `patterns` (case-insensitive).
 *
 * This is the exact predicate `tools.denyTools` / `tools.askTools` use, shared
 * with the synchronous guard so both seams agree.
 *
 * @param name - tool name to test.
 * @param patterns - `*`-only globs; an empty list never matches.
 * @returns true on the first matching pattern.
 */
export function matchNamePattern(name: string, patterns: readonly string[]): boolean {
  if (typeof name !== 'string' || name.length === 0) return false
  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue
    if (globToRegExp(pattern).test(name)) return true
  }
  return false
}

/**
 * Resolve the semantic tags of one tool name.
 *
 * Built-in table first, then every matching `tools.tagOverrides` entry in config
 * order, unioned without duplicates (first occurrence wins). Unknown tools get
 * `[]` — tags are advisory, never a reason to deny by themselves.
 *
 * @param name - tool name.
 * @param overrides - operator tag overrides (`tools.tagOverrides`).
 * @returns tags in deterministic resolution order.
 */
export function resolveTags(
  name: string,
  overrides: readonly { pattern: string; tags: readonly string[] }[],
): string[] {
  if (typeof name !== 'string' || name.length === 0) return []
  const tags: string[] = []
  const seen = new Set<string>()
  const add = (candidate: readonly string[]): void => {
    for (const tag of candidate) {
      if (typeof tag !== 'string' || tag.length === 0 || seen.has(tag)) continue
      seen.add(tag)
      tags.push(tag)
    }
  }
  for (const rule of BUILTIN_TAG_RULES) {
    if (globToRegExp(rule.pattern).test(name)) add(rule.tags)
  }
  for (const override of overrides) {
    if (typeof override.pattern !== 'string' || override.pattern.length === 0) continue
    if (globToRegExp(override.pattern).test(name)) add(override.tags)
  }
  return tags
}

// ---------------------------------------------------------------------------
// Tool-call judgement
// ---------------------------------------------------------------------------

/** Maximum object/array nodes the argument walker visits before giving up. */
const MAX_ARGUMENT_NODES = 100_000
/** Maximum characters of string leaves collected from the arguments. */
const MAX_ARGUMENT_CHARS = 4 * 1024 * 1024

/** Result of one argument walk. */
interface ArgumentScan {
  readonly strings: string[]
  /** True when a budget ran out: the caller must fail closed (deny). */
  readonly truncated: boolean
}

/**
 * Collect every string leaf of a parsed-arguments value.
 *
 * Iterative (an explicit stack, never recursion) so a pathologically deep value
 * cannot blow the call stack, and identity-guarded so a **cyclic** value cannot
 * spin forever (a hostile or accidental `exec.arguments` with a cycle previously
 * cost seconds of CPU and gigabytes of stack before throwing).
 *
 * The walk is bounded by {@link MAX_ARGUMENT_NODES} / {@link MAX_ARGUMENT_CHARS};
 * exhausting either budget is reported as `truncated`, and the caller treats that
 * as a denial (fail-closed) rather than scanning less and potentially allowing.
 * Every reachable leaf is still scanned for realistic arguments, whose size the
 * caller has already capped with `maxArgsBytes`.
 */
function collectArgumentStrings(root: unknown): ArgumentScan {
  const out: string[] = []
  const stack: unknown[] = [root]
  /** Objects/arrays already expanded — this is the cycle guard. */
  const seen = new Set<object>()
  let nodes = 0
  let chars = 0
  while (stack.length > 0) {
    nodes += 1
    if (nodes > MAX_ARGUMENT_NODES || chars > MAX_ARGUMENT_CHARS) {
      return { strings: out, truncated: true }
    }
    const value = stack.pop()
    if (typeof value === 'string') {
      if (value.length > 0) {
        out.push(value)
        chars += value.length
      }
      continue
    }
    if (value === null || typeof value !== 'object') continue
    if (seen.has(value)) continue
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item)
      continue
    }
    for (const item of Object.values(value as Record<string, unknown>)) stack.push(item)
  }
  return { strings: out, truncated: false }
}

/**
 * Whether one chain endpoint matches a call.
 *
 * The task spec (T1.2) says tag alternatives are OR'ed with the name regex, so a
 * call matches when the name matches **or** a rule tag is present. See the module
 * comment for why this intentionally differs from Python's AND.
 */
function endpointMatches(
  name: string,
  tags: readonly string[],
  regex: RegExp | undefined,
  ruleTags: readonly string[],
): boolean {
  const byName = regex !== undefined && testRegex(regex, name)
  if (byName) return true
  if (ruleTags.length === 0) return false
  return tags.some((tag) => ruleTags.includes(tag))
}

/**
 * Find the first chain rule that fires for this call against the session trail.
 *
 * Look-back semantics (mirrors Python `trajectory.py:214-241`): the entry right
 * before the current call is gap 0; `maxGap > 0` inspects only the most recent
 * `maxGap` entries, `maxGap === 0` inspects the whole bounded trail. Rules are
 * tried in rule-set order, so the outcome is deterministic.
 */
function findChainDenial(
  chains: readonly CompiledChainRule[],
  view: ToolView,
  session: SessionView,
): Decision | undefined {
  if (chains.length === 0) return undefined
  const trail = session.trail
  for (const chain of chains) {
    if (!endpointMatches(view.name, view.tags, chain.then, chain.thenTags)) continue
    const window = chain.maxGap > 0 ? Math.min(chain.maxGap, trail.length) : trail.length
    for (let offset = 0; offset < window; offset += 1) {
      const entry = trail[trail.length - 1 - offset]
      if (entry === undefined) continue
      if (!endpointMatches(entry.name, entry.tags, chain.first, chain.firstTags)) continue
      return {
        kind: 'deny',
        reasonCode: ReasonCode.ToolChain,
        ruleIds: [chain.name],
        severity: chain.severity,
        category: chain.category,
        // Operator-facing only: names the chain and the two tool names, never the
        // arguments.
        reason:
          chain.reason.length > 0
            ? chain.reason
            : `chain rule '${chain.name}' matched after '${entry.name}' (gap ${offset})`,
      }
    }
  }
  return undefined
}

/**
 * Judge one tool call before execution.
 *
 * Order (T1.2 spec): explicit `denyTools` name → `denyTags` → argument byte size
 * → dangerous SQL in any string argument → chain rules over the trail → `askTools`
 * → allow. The first match wins; the decision carries the governing rule's
 * severity where one exists.
 *
 * Arguments are **never** rendered into the decision: the reason names the shape
 * (`dangerous SQL`, `statement kinds`), not the value, so a credential-shaped
 * argument cannot leak through an audit record.
 *
 * @param ruleset - compiled rules (chains drive step 5).
 * @param cfg - `ResolvedConfig['tools']`.
 * @param view - the call as the engine sees it.
 * @param session - per-session trail (oldest first).
 * @returns a deny/ask/allow decision; `allow` only when nothing matched.
 */
export function evaluateToolCall(
  ruleset: RuleSet,
  cfg: ResolvedConfig['tools'],
  view: ToolView,
  session: SessionView,
): Decision {
  // (1) explicit tool-name deny list
  if (matchNamePattern(view.name, cfg.denyTools)) {
    return {
      kind: 'deny',
      reasonCode: ReasonCode.ToolName,
      ruleIds: [],
      severity: CONFIG_DENIAL_SEVERITY,
      reason: 'tool name matched the deny list',
    }
  }

  // (2) denied semantic tags
  const deniedTags = cfg.denyTags.filter((tag) => view.tags.includes(tag))
  if (deniedTags.length > 0) {
    return {
      kind: 'deny',
      reasonCode: ReasonCode.ToolTag,
      ruleIds: sortedIds(deniedTags),
      severity: CONFIG_DENIAL_SEVERITY,
      reason: `tool carries denied tag(s): ${sortedIds(deniedTags).join(',')}`,
    }
  }

  // (3) argument size ceiling
  if (view.argsBytes > cfg.maxArgsBytes) {
    return {
      kind: 'deny',
      reasonCode: ReasonCode.ToolArgsTooLarge,
      ruleIds: [],
      severity: 'high',
      reason: `arguments are ${view.argsBytes} bytes (limit ${cfg.maxArgsBytes})`,
    }
  }

  // (4) dangerous SQL in any string argument value
  const scan = collectArgumentStrings(view.arguments)
  if (scan.truncated) {
    // Fail closed: a value too large or too convoluted to scan end-to-end may be
    // hiding the very payload this check exists for.
    return {
      kind: 'deny',
      reasonCode: ReasonCode.ToolArgsTooLarge,
      ruleIds: [],
      severity: 'high',
      reason: 'tool arguments exceed the scan budget (too large or cyclic)',
    }
  }
  for (const candidate of scan.strings) {
    const verdict = inspectSql(candidate)
    if (!verdict.dangerous) continue
    return {
      kind: 'deny',
      reasonCode: ReasonCode.ToolArgs,
      ruleIds: [SQL_ARG_RULE_ID],
      severity: 'high',
      category: SQL_CATEGORY,
      reason: `tool arguments contain dangerous SQL (kinds=${verdict.statementKinds.join(',') || 'unknown'})`,
    }
  }

  // (5) trajectory chains over the session trail
  const chain = findChainDenial(ruleset.chains, view, session)
  if (chain !== undefined) return chain

  // (6) approval-required tools
  if (matchNamePattern(view.name, cfg.askTools)) {
    return {
      kind: 'ask',
      reasonCode: ReasonCode.ToolAsk,
      ruleIds: [],
      severity: ASK_SEVERITY,
      reason: 'tool name matched the ask list',
    }
  }

  // (7) nothing matched
  return { kind: 'allow', reasonCode: ReasonCode.None, ruleIds: [] }
}

// ---------------------------------------------------------------------------
// Tool-result scan
// ---------------------------------------------------------------------------

interface CredentialPattern {
  readonly id: string
  readonly severity: Severity
  readonly regex: RegExp
}

/**
 * Credential-shaped detection patterns. These are **additions**: the Python
 * `output_guard.py` has no credential/private-key/entropy detector;
 * the only runtime credential signals there are key-name redaction and the opt-in
 * trajectory entropy check. Every bound below is linear and `g`-free.
 */
const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  // OpenAI-style secret key.
  { id: 'credential_openai_key', severity: 'critical', regex: /\bsk-[A-Za-z0-9_-]{16,}/ },
  // HTTP bearer token.
  { id: 'credential_bearer_token', severity: 'high', regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  // PEM private-key header (RSA / EC / DSA / OPENSSH / ENCRYPTED / generic).
  {
    id: 'credential_private_key',
    severity: 'critical',
    regex: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/,
  },
  // key=value / key: value assignments for credential-ish names.
  {
    id: 'credential_assignment',
    severity: 'high',
    regex:
      /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
  },
]

/** Token splitter for the entropy heuristic: everything that is not base64-ish. */
const ENTROPY_TOKEN_SEPARATOR_RE = /[^A-Za-z0-9+/_=-]+/
/** Minimum token length for the entropy heuristic (T1.2: >= 40 chars). */
const ENTROPY_MIN_CHARS = 40
/** Minimum Shannon entropy in bits/char (T1.2: >= 3.5). */
const ENTROPY_MIN_BITS_PER_CHAR = 3.5

/** Shannon entropy in bits per character (the Python `_shannon_entropy` formula). */
function shannonEntropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  const total = value.length
  for (const count of counts.values()) {
    const probability = count / total
    bits -= probability * Math.log2(probability)
  }
  return bits
}

/** True when the text contains a >=40-char, >=3.5 bits/char token. */
function hasHighEntropyToken(text: string): boolean {
  const tokens = text.split(ENTROPY_TOKEN_SEPARATOR_RE)
  let examined = 0
  for (const token of tokens) {
    if (token.length < ENTROPY_MIN_CHARS) continue
    examined += 1
    if (examined > MAX_ENTROPY_TOKENS) return false
    if (shannonEntropy(token) >= ENTROPY_MIN_BITS_PER_CHAR) return true
  }
  return false
}

/**
 * Scan one tool result for credential leaks and injection markers.
 *
 * At most {@link MAX_RESULT_SCAN_CHARS} characters are inspected (the hook layer
 * applies the same bound to the view). Two findings can be returned, one per
 * category, each carrying every rule id that fired and the highest severity.
 * `detail` is a fixed ASCII description: a matched substring is never copied into
 * a finding, so the finding is safe to persist and to show an operator.
 *
 * Blocking is policy, not detection: `cfg.blockOn` is interpreted by the
 * post-execute hook, not here. `cfg.mode === 'off'` short-circuits to no findings
 * so an off guard costs nothing.
 *
 * @param ruleset - compiled injection/leak rules.
 * @param cfg - `ResolvedConfig['results']`.
 * @param view - the result as the engine sees it.
 * @returns findings in deterministic order (credential first), `[]` when clean.
 */
export function scanToolResult(
  ruleset: RuleSet,
  cfg: ResolvedConfig['results'],
  view: ToolResultView,
): readonly ResultFinding[] {
  if (cfg.mode === 'off') return []
  const joined = `${view.text}\n${view.valueText}`
  const scanned = joined.length > MAX_RESULT_SCAN_CHARS ? joined.slice(0, MAX_RESULT_SCAN_CHARS) : joined
  if (scanned.trim().length === 0) return []

  const findings: ResultFinding[] = []

  // (a) credential leaks
  const credentialIds: string[] = []
  let credentialSeverity: Severity | undefined
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (!testRegex(pattern.regex, scanned)) continue
    credentialIds.push(pattern.id)
    if (credentialSeverity === undefined || SEVERITY_RANK[pattern.severity] > SEVERITY_RANK[credentialSeverity]) {
      credentialSeverity = pattern.severity
    }
  }
  if (hasHighEntropyToken(scanned)) {
    credentialIds.push('credential_high_entropy')
    if (credentialSeverity === undefined) credentialSeverity = 'high'
  }
  if (credentialIds.length > 0) {
    findings.push({
      category: 'credential_leak',
      ruleIds: sortedIds(credentialIds),
      severity: credentialSeverity ?? 'high',
      detail: 'credential-shaped value in tool result (value never recorded)',
    })
  }

  // (b) injection markers: the same prompt-injection rule family as the input face
  const injectionIds: string[] = []
  let injectionSeverity: Severity | undefined
  for (const rule of ruleset.rules) {
    if (!testRegex(rule.regex, scanned)) continue
    injectionIds.push(rule.id)
    if (injectionSeverity === undefined || SEVERITY_RANK[rule.severity] > SEVERITY_RANK[injectionSeverity]) {
      injectionSeverity = rule.severity
    }
  }
  if (injectionIds.length > 0) {
    findings.push({
      category: 'injection_marker',
      ruleIds: sortedIds(injectionIds),
      severity: injectionSeverity ?? 'high',
      detail: 'prompt-injection marker in tool result (rule ids only)',
    })
  }

  return findings
}
