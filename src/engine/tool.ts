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
 * - The result scan (`credential_leak` / `injection_marker` / `pii`) is new code:
 *   the Python `output_guard.py` has **no** credential, private-key or entropy
 *   detector at all (digest §7.2/§7.3); it only runs the inform rule family plus
 *   an LLM judge. The credential patterns here are therefore additions, not a
 *   port. The `pii` classes are a port of the kernel's
 *   `memory/sanitizer.py` patterns (1.12.0).
 *
 * Secrets discipline: no function in this module ever receives a value it logs.
 * Decisions carry rule ids, tool names and statement kinds only; findings carry a
 * fixed ASCII description and rule ids. Matched substrings are never retained.
 * @module
 */
import type { ResolvedConfig, SqlScanScope } from '../config.js'
import { checkArgSchema } from './argschema.js'
import { scanPii } from './pii.js'
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

/** Synthetic rule id recorded when a SQL read touches a non-allowlisted table. */
const SQL_TABLE_RULE_ID = 'sql_table_allowlist'

/** Category for a dangerous-SQL argument hit (Python risk-tag vocabulary). */
const SQL_CATEGORY = 'dangerous_sql'

/** Hard bound on the text the result scanner looks at (256 KiB, §6.5(d)). */
export const MAX_RESULT_SCAN_CHARS = 256 * 1024

/** Bound on result tokens examined by the entropy heuristic. */
const MAX_ENTROPY_TOKENS = 2000

// ---------------------------------------------------------------------------
// Who gets an SQL scan (R42)
// ---------------------------------------------------------------------------

/**
 * A tool whose string arguments can REACH a SQL engine: database clients, shells
 * and anything that runs a statement. Only these are worth passing through
 * `inspectSql`, because "the argument text mentions a destructive statement" only
 * predicts harm when the tool can execute it (R42, 1.2.2).
 */
const EXECUTION_NAME_TOKENS: ReadonlySet<string> = new Set([
  // database clients
  'sql', 'db', 'database', 'query', 'psql', 'mysql', 'sqlite', 'postgres',
  'postgresql', 'mongo', 'mongodb', 'redis', 'oracle', 'mssql', 'clickhouse',
  'snowflake', 'bigquery',
  // command / process launchers
  'exec', 'execute', 'run', 'shell', 'bash', 'sh', 'zsh', 'pwsh', 'powershell',
  'cmd', 'terminal', 'console', 'eval', 'invoke',
])

/**
 * A tool that only LANDS text somewhere (file, document, clipboard, patch). Such
 * a tool cannot execute what it writes, so an SQL example in its payload is
 * content, not intent — the R42 false positive.
 *
 * The set is deliberately a *positive* recognition: a tool that matches neither
 * list keeps the SQL scan, so an unfamiliar or vaguely named tool stays on the
 * fail-closed side instead of silently losing coverage.
 */
const CONTENT_NAME_TOKENS: ReadonlySet<string> = new Set([
  'write', 'edit', 'patch', 'create', 'save', 'append', 'apply', 'put',
  'insert', 'update', 'upsert', 'upload', 'copy', 'move', 'rename', 'delete',
  'remove', 'mkdir', 'touch', 'read', 'cat', 'open', 'view', 'show', 'print',
  'glob', 'grep', 'find', 'ls', 'list', 'search', 'diff',
])

/** Semantic tags that mark a tool as able to execute its argument text. */
const EXECUTION_TAGS: ReadonlySet<string> = new Set(['db', 'shell', 'exec'])

/** Semantic tags that mark a tool as landing text rather than running it. */
const CONTENT_TAGS: ReadonlySet<string> = new Set(['fs'])

/**
 * Split a tool name into comparable tokens.
 *
 * Tool names arrive as `snake_case`, `kebab-case`, `camelCase` or MCP's
 * `mcp__server_tool`; all of those reduce to lowercase alphanumeric tokens
 * (`mcp__postgres_query` → `['mcp', 'postgres', 'query']`).
 */
function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0)
}

/** Whether any token of `name` belongs to `set`. */
function hasToken(name: string, set: ReadonlySet<string>): boolean {
  for (const token of nameTokens(name)) if (set.has(token)) return true
  return false
}

/**
 * Which tools get an SQL scan.
 *
 * - `execution` (default since 1.2.2): execution-facing tools, plus every tool
 *   this plugin does not positively recognize as content-landing. `write`, `edit`,
 *   `apply_patch` and `read` therefore stop being denied for quoting SQL.
 * - `all`: the pre-1.2.2 behaviour, every string argument of every tool.
 *
 * @param view - the call as the engine sees it (name, tags).
 * @param scope - `ResolvedConfig['tools']['sqlScan']`.
 * @returns whether `inspectSql` runs over this call's string arguments.
 */
export function shouldScanSql(view: Pick<ToolView, 'name' | 'tags'>, scope: SqlScanScope): boolean {
  if (scope === 'all') return true
  const execution = view.tags.some((tag) => EXECUTION_TAGS.has(tag))
    || hasToken(view.name, EXECUTION_NAME_TOKENS)
  if (execution) return true
  const content = view.tags.some((tag) => CONTENT_TAGS.has(tag))
    || hasToken(view.name, CONTENT_NAME_TOKENS)
  // Content tool: an SQL example in its payload is data. Everything else keeps the
  // pre-1.2.2 scan (fail-closed for tools this version cannot classify).
  return !content
}

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
// Tool descriptor scan (kernel `llm/safeharness_mcp_guard.py`, descriptor part)
// ---------------------------------------------------------------------------

/** Bound on the descriptor characters scanned (a hostile server can send anything). */
export const MAX_DESCRIPTOR_SCAN_CHARS = 8 * 1024

/** Which parts of a descriptor carried an injection rule. */
export type DescriptorField = 'name' | 'description'

/** One descriptor finding: matched fields and the governing rule ids. */
export interface DescriptorFinding {
  readonly fields: readonly DescriptorField[]
  readonly ruleIds: readonly string[]
  readonly severity: Severity
}

/**
 * Scan a tool's own name and description with the injection rule family.
 *
 * The kernel (`mcp_guard.apply_descriptor_guard`) runs the inform patterns over
 * every listed MCP tool's `name`/`description`, warns by default and drops the
 * tool when enforcement is enabled. The plugin has the same text at the tool
 * surface (`ctx.tools.get(name).description`), so the same scan runs there.
 *
 * The scan is deliberately **not** part of the argument judgement: a hostile
 * descriptor is a property of the tool, not of one call, so `evaluateToolCall`
 * evaluates it first and the hook deduplicates the warning per session.
 *
 * @param ruleset - compiled rule set (the injection family).
 * @param view - the proposed call as the engine sees it.
 * @returns the finding, or `undefined` when nothing matched / nothing to scan.
 */
export function scanToolDescriptor(
  ruleset: Pick<RuleSet, 'rules'>,
  view: Pick<ToolView, 'name' | 'description'>,
): DescriptorFinding | undefined {
  if (ruleset.rules.length === 0) return undefined
  const fields: DescriptorField[] = []
  const ruleIds = new Set<string>()
  let severity: Severity | undefined
  for (const field of ['name', 'description'] as const) {
    const raw = field === 'name' ? view.name : view.description
    if (typeof raw !== 'string' || raw.length === 0) continue
    const value = raw.length > MAX_DESCRIPTOR_SCAN_CHARS ? raw.slice(0, MAX_DESCRIPTOR_SCAN_CHARS) : raw
    let hit = false
    for (const rule of ruleset.rules) {
      if (!testRegex(rule.regex, value)) continue
      hit = true
      ruleIds.add(rule.id)
      if (severity === undefined || SEVERITY_RANK[rule.severity] > SEVERITY_RANK[severity]) severity = rule.severity
    }
    if (hit) fields.push(field)
  }
  if (fields.length === 0 || severity === undefined) return undefined
  return { fields, ruleIds: sortedIds([...ruleIds]), severity }
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
 * Order: tool descriptor injection → explicit `denyTools` name → `denyTags` →
 * argument byte size → dangerous SQL / non-allowlisted table in any string
 * argument → declared argument shapes (`tools.argSchemas`) → chain rules over the
 * trail → repeated failed attempts → high-entropy argument → `askTools` → allow.
 * The first match wins; the decision carries the governing rule's severity where
 * one exists.
 *
 * A descriptor hit in `warn` mode is the one ALLOW that still carries a finding
 * (`reasonCode` + `ruleIds`); the hook records it once per session and lets the
 * call proceed.
 *
 * Arguments are **never** rendered into the decision: the reason names the shape
 * (`dangerous SQL`, `statement kinds`), not the value, so a credential-shaped
 * argument cannot leak through an audit record. The high-entropy reason carries
 * only the argument index, its length and the entropy value; an argument-schema
 * refusal carries the schema id, the argument NAME and the constraint kind, never
 * the offending value.
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
  // (0) tool descriptor: a tool whose own name/description carries an injection is
  // hostile before any argument is considered (kernel `mcp_guard` descriptor scan).
  //
  // `warn` returns an ALLOW carrying the finding so the hook can record it without
  // touching the call; `enforce` denies the call itself. The registry has no seam to
  // drop a tool from the model's list, so enforcement is per call (documented in
  // MANUAL §4.10).
  if (cfg.descriptorScan !== 'off') {
    const descriptor = scanToolDescriptor(ruleset, view)
    if (descriptor !== undefined) {
      if (cfg.descriptorScan === 'enforce') {
        return {
          kind: 'deny',
          reasonCode: ReasonCode.ToolDescriptor,
          ruleIds: descriptor.ruleIds,
          severity: descriptor.severity,
          category: 'descriptor_injection',
          reason: `tool descriptor (${descriptor.fields.join(',')}) matched an injection rule`,
        }
      }
      return {
        kind: 'allow',
        reasonCode: ReasonCode.ToolDescriptor,
        ruleIds: descriptor.ruleIds,
        severity: descriptor.severity,
        category: 'descriptor_injection',
        reason: `tool descriptor (${descriptor.fields.join(',')}) matched an injection rule (warn-only)`,
      }
    }
  }

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

  // (4) dangerous SQL in string arguments — only where it can execute (R42)
  //
  // Walking every string leaf of every tool was the pre-1.2.2 rule; it denied
  // `write`/`edit` whenever the document merely QUOTED a destructive statement
  // (R42). `sqlScan` decides who is scanned; the walk itself stays fail-closed.
  //
  // 1.12.0 adds the kernel's table allowlist: `tools.sql.allowedTables` non-empty
  // means every table reference in a scanned argument must match an entry, exactly
  // like `SqlGuardPolicy._argument_verdict` (a dangerous statement still wins, and
  // the allowlist only fires when the statement is otherwise benign).
  // One argument walk serves both the SQL scan and the entropy threshold: the walk
  // is bounded and iterative, but repeating it for every feature would double the
  // per-call cost of a large payload.
  const sqlActive = shouldScanSql(view, cfg.sqlScan)
  const entropyActive = cfg.entropyThreshold > 0
  const scan = sqlActive || entropyActive ? collectArgumentStrings(view.arguments) : undefined
  if (scan?.truncated === true) {
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

  if (sqlActive && scan !== undefined) {
    const allowedTables = cfg.sql.allowedTables.length > 0 ? cfg.sql.allowedTables : undefined
    for (const candidate of scan.strings) {
      const verdict = inspectSql(candidate, allowedTables === undefined ? undefined : { allowedTables })
      if (verdict.reasonCode === 'dangerous_sql_detected') {
        return {
          kind: 'deny',
          reasonCode: ReasonCode.ToolArgs,
          ruleIds: [SQL_ARG_RULE_ID],
          severity: 'high',
          category: SQL_CATEGORY,
          reason: `tool arguments contain dangerous SQL (kinds=${verdict.statementKinds.join(',') || 'unknown'})`,
        }
      }
      if (verdict.reasonCode === 'unauthorized_sql_table') {
        return {
          kind: 'deny',
          reasonCode: ReasonCode.ToolSqlTable,
          ruleIds: [SQL_TABLE_RULE_ID],
          severity: 'high',
          category: SQL_CATEGORY,
          reason: `tool arguments read a table outside the allowlist (table=${verdict.matchedTable ?? 'unknown'})`,
        }
      }
    }
  }

  // (4b) declared argument shapes (kernel `constrain.py`, argument-schema half;
  // 1.16.0). Placed after the name/tag/size/SQL gates and before the trajectory
  // checks: an operator who already refuses a tool by name or by statement shape
  // should see that reason first, and a schema is a *shape* constraint on the same
  // argument text, so it belongs with the other per-call argument gates.
  //
  // Every schema whose tool glob matches applies (AND, not "first match wins"):
  // adding a declaration can only ever narrow a call, never widen one, and an
  // operator who writes two schemas for one tool gets both enforced. The refusal
  // reports the FIRST violation in declaration order, and names only the schema,
  // the argument and the keyword — never the value.
  if (cfg.argSchemas !== undefined && cfg.argSchemas.length > 0) {
    for (const entry of cfg.argSchemas) {
      if (!matchNamePattern(view.name, [entry.tool])) continue
      const violation = checkArgSchema(entry, view.arguments)
      if (violation === undefined) continue
      return {
        kind: 'deny',
        reasonCode: ReasonCode.ToolArgument,
        ruleIds: [violation.schema],
        severity: 'high',
        category: 'tool_argument',
        reason: `argument '${violation.argument}' violates ${violation.constraint} in schema '${violation.schema}'`,
      }
    }
  }

  // (5) trajectory chains over the session trail
  const chain = findChainDenial(ruleset.chains, view, session)
  if (chain !== undefined) return chain
  // (5b) repeated failed attempts on the same tool (kernel `trajectory.py`
  // `repeated_attempt_threshold`). A success resets the counter, so a tool that
  // failed five times, then worked, starts clean again.
  if (cfg.repeatedAttemptThreshold > 0) {
    const failures = session.failures?.[view.name] ?? 0
    if (failures >= cfg.repeatedAttemptThreshold) {
      return {
        kind: 'deny',
        reasonCode: ReasonCode.ToolRepeatedAttempt,
        ruleIds: [],
        severity: 'high',
        category: 'repeated_attempts',
        reason: `tool already failed ${failures} times this session (threshold ${cfg.repeatedAttemptThreshold})`,
      }
    }
  }

  // (5c) high-entropy string argument (kernel `trajectory.py` `entropy_threshold`,
  // default 0 = off, as in the kernel). Only the length, entropy value and the
  // argument index are reported — never the value.
  if (entropyActive && scan !== undefined) {
    for (let index = 0; index < scan.strings.length; index += 1) {
      const candidate = scan.strings[index]
      if (candidate === undefined || candidate.length < cfg.entropyMinLength) continue
      const entropy = shannonEntropy(candidate)
      if (entropy < cfg.entropyThreshold) continue
      return {
        kind: 'deny',
        reasonCode: ReasonCode.ToolHighEntropy,
        ruleIds: [],
        severity: 'high',
        category: 'high_entropy',
        reason: `argument ${index} looks like an encoded payload (length ${candidate.length}, entropy ${entropy.toFixed(2)})`,
      }
    }
  }

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
  //
  // Two shapes were missed in 1.15.0 and leaked a real 14-char relay key
  // (2026-11-19, session-2242f394): a JSON-quoted name (`"LLM_API_KEY": "…"`) and a
  // name that is the suffix of a longer identifier (`LLM_API_KEY` never matched
  // because `\b` sits between `_` and `A`). The name is therefore not boundary-
  // anchored at the start, and one closing quote is allowed before the separator.
  //
  // The value must still look like a literal secret: a quoted string, or an
  // unquoted token that is not a dotted reference/type expression. Without the
  // negative lookahead, source code such as `apiKey: z.string()` or
  // `token: process.env.TOKEN` matched and (under `results.mode: enforce`) whole
  // source/config files became unreadable — measured on the desktop profile.
  {
    id: 'credential_assignment',
    severity: 'high',
    regex:
      /[A-Za-z0-9_$-]{0,32}(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)["']?\s*[=:]\s*("(?!z\.|process\.env|os\.environ|import\.meta|\$\{|\[REDACTED)[^"\r\n]{8,}"|'(?!z\.|process\.env|os\.environ|import\.meta|\$\{|\[REDACTED)[^'\r\n]{8,}'|(?!z\.|process\.env|os\.environ|import\.meta|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b)[A-Za-z0-9._~+/=-]{8,}(?![A-Za-z0-9._~+/=(-]))/i,
  },
]

/**
 * The character class of one base64-ish run; the text is split on its complement.
 *
 * Why not match the long runs directly: measured 2026-11-23, a `{40,}` walk over the
 * same 61 KB input costs 0.51 ms median against 0.15 ms for `split()` — the bounded
 * quantifier has to try a match at every position, while the split does one linear
 * pass. The split's allocation is real but cheaper than the scan it replaces, so the
 * simpler implementation wins. (The scan's own p99 variance comes from the machine,
 * not from this line: see the `perf` project in `vitest.config.ts`.)
 */
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

/** A token made only of hexadecimal digits is a hash or an id, not an encoded secret. */
const HEX_TOKEN_RE = /^[0-9a-f]+$/i
/** A Windows path (`C:/...`) — including `file:///C:/...` — is a location, not a secret. */
const WINDOWS_PATH_TOKEN_RE = /(?:^|\/)[A-Za-z]:\//
/**
 * A Subresource-Integrity digest: `sha1-` / `sha256-` / `sha384-` / `sha512-` followed
 * by base64. `pnpm-lock.yaml` is full of them, and reading a lockfile is ordinary
 * work, not a leak — an SRI digest is a *check* on public bytes, never a credential.
 * Matched before the entropy gate because base64 easily clears 40 chars / 3.5 bits.
 */
const SRI_TOKEN_PREFIX_RE = /^sha(?:1|256|384|512)-/i
const LOWER_CHAR_RE = /[a-z]/
const UPPER_CHAR_RE = /[A-Z]/
const DIGIT_CHAR_RE = /[0-9]/

/**
 * Whether a long token is shaped like an encoded secret rather than a hash or a
 * path fragment (R50).
 *
 * The bare entropy heuristic was built for T1.2 and, once `results.mode` becomes
 * `enforce`, its false positives block ordinary tool results wholesale: 64-hex
 * ledger/ruleset digests in `safeharness_status`, 40-hex `git log` ids, long
 * `@scope/pkg/lib/...` stack-trace fragments, `file:///C:/...` module URLs in
 * Node error output, and the `sha512-…` SRI digests of a lockfile all cleared
 * 40 chars / 3.5 bits. A real encoded credential mixes lower case, upper case and
 * digits and is not pure hexadecimal; hashes are hex, path fragments are usually
 * lower case, Windows paths carry a drive letter, and an SRI digest announces
 * itself with a `sha<alg>-` prefix — so all four are skipped here instead of
 * relying on an operational workaround.
 *
 * @param token - one base64-ish token produced by {@link ENTROPY_TOKEN_SEPARATOR_RE}.
 * @returns true when the token passes the shape gate (entropy is checked by the caller).
 */
function isCredentialShapedToken(token: string): boolean {
  if (HEX_TOKEN_RE.test(token)) return false
  if (WINDOWS_PATH_TOKEN_RE.test(token)) return false
  if (SRI_TOKEN_PREFIX_RE.test(token)) return false
  return LOWER_CHAR_RE.test(token) && UPPER_CHAR_RE.test(token) && DIGIT_CHAR_RE.test(token)
}

/** True when the text contains a >=40-char, >=3.5 bits/char credential-shaped token. */
function hasHighEntropyToken(text: string): boolean {
  const tokens = text.split(ENTROPY_TOKEN_SEPARATOR_RE)
  let examined = 0
  for (const token of tokens) {
    if (token.length < ENTROPY_MIN_CHARS) continue
    examined += 1
    if (examined > MAX_ENTROPY_TOKENS) return false
    if (!isCredentialShapedToken(token)) continue
    if (shannonEntropy(token) >= ENTROPY_MIN_BITS_PER_CHAR) return true
  }
  return false
}

/** Credential-only scan result: rule ids in deterministic order + highest severity. */
export interface CredentialScan {
  /** Credential patterns that fired, sorted (empty = clean). */
  readonly ruleIds: readonly string[]
  /** Highest severity among the hits, when any. */
  readonly severity?: Severity
}/**
 * Cheap pre-check for the assignment pattern: a text without any key-ish word
 * cannot match it. Skipping the regex keeps a 256 KB scan near the pre-1.15.1 cost
 * (the pattern is the expensive one, and most results contain no such word at all).
 */
const ASSIGNMENT_HINT_RE = /key|token|secret|password|passwd/i

/**
 * Cheap pre-check #2: the assignment pattern requires a `=` or `:` separator.
 *
 * The hint above is not enough on its own, because ordinary prose contains those
 * words: the perf file's own fixture is `'plain log line without secrets'` repeated,
 * which passes the hint and then runs the heaviest regex in the file over 61 KB of
 * text that has no separator at all. Measured 2026-11-23: 0.80 ms with the hint
 * word present versus 0.20 ms without it — a 4× difference caused by one preposition.
 *
 * A `[=:]` test is a single linear scan with no allocation, and it is a *necessary*
 * condition of the pattern (`\s*[=:]\s*` is mandatory in it), so skipping when it
 * fails cannot change a verdict — only the cost.
 */
const ASSIGNMENT_SEPARATOR_RE = /[=:]/

/**
 * Scan text for credential-shaped values.
 *
 * Shared by the tool-result face and the output face. Before 1.15.1 only the
 * result face ran these patterns: on 2026-11-19 the model echoed a relay key it
 * had been shown and the finished answer was recorded as `rule_ids: []`, so the
 * operator saw the key with a clean audit line — detection, not just policy, was
 * missing on the output side.
 *
 * @param text - already length-bounded by the caller.
 * @returns ids and severity; a matched value is never copied out.
 */
export function scanCredentialLeaks(text: string): CredentialScan {
  const ids: string[] = []
  let severity: Severity | undefined
  // Both hints are necessary conditions of the assignment pattern, so testing them
  // first cannot change a verdict — it only skips a regex that would have failed.
  const assignmentRelevant = ASSIGNMENT_HINT_RE.test(text) && ASSIGNMENT_SEPARATOR_RE.test(text)
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.id === 'credential_assignment' && !assignmentRelevant) continue
    if (!testRegex(pattern.regex, text)) continue
    ids.push(pattern.id)
    if (severity === undefined || SEVERITY_RANK[pattern.severity] > SEVERITY_RANK[severity]) {
      severity = pattern.severity
    }
  }
  if (hasHighEntropyToken(text)) {
    ids.push('credential_high_entropy')
    if (severity === undefined) severity = 'high'
  }
  return { ruleIds: sortedIds(ids), severity }
}

/** Placeholder left in place of a credential-shaped value. Never contains the value. */
export const CREDENTIAL_REDACTION = '[REDACTED:credential]'

/**
 * Replace credential-shaped values with {@link CREDENTIAL_REDACTION}.
 *
 * Why the output stream redacts instead of only recording: `output.mode: warn`
 * cannot recall bytes the UI already painted, and 2026-11-19 that meant a real
 * relay key reached the operator's screen while the ledger said `allow`. Detection
 * alone is not a control. Redaction keeps streaming (no buffering, no loss of the
 * rest of the answer) and only ever touches credential-shaped runs, so ordinary
 * text is byte-identical.
 *
 * The caller must feed *windows*, not single chunks (see the tail buffer in
 * `hooks/llm.ts`): a secret split across two deltas would otherwise pass through.
 *
 * @param text - a bounded slice of assistant text.
 * @returns the redacted slice and how many values were replaced.
 */
export function redactCredentialValues(text: string): { readonly text: string; readonly count: number } {
  let count = 0
  let out = text

  // Assignment first, and only the value: the key name is useful context and is
  // not itself the secret (`"LLM_API_KEY": "[REDACTED:credential]"`).
  //
  // Same two necessary-condition hints as the scanner: without a key-ish word AND a
  // `=`/`:` separator the pattern cannot match, and both tests are one linear pass
  // against a regex that dominates the cost of this function.
  const assignmentPattern = CREDENTIAL_PATTERNS.find((pattern) => pattern.id === 'credential_assignment')
  if (
    assignmentPattern !== undefined
    && ASSIGNMENT_HINT_RE.test(text)
    && ASSIGNMENT_SEPARATOR_RE.test(text)
  ) {
    const assignment = new RegExp(assignmentPattern.regex.source, `${assignmentPattern.regex.flags}g`)
    out = out.replace(assignment, (match: string, value: string) => {
      count += 1
      return match.slice(0, match.length - value.length) + CREDENTIAL_REDACTION
    })
  }

  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.id === 'credential_assignment') continue
    const global = new RegExp(pattern.regex.source, `${pattern.regex.flags}g`)
    const replacement = pattern.id === 'credential_openai_key'
      ? `sk-${CREDENTIAL_REDACTION}`
      : pattern.id === 'credential_bearer_token'
        ? `Bearer ${CREDENTIAL_REDACTION}`
        : CREDENTIAL_REDACTION
    out = out.replace(global, () => {
      count += 1
      return replacement
    })
  }

  // Long encoded secrets with no key name next to them.
  out = out.replace(/[A-Za-z0-9+/_=-]{40,}/gu, (token) => {
    if (!isCredentialShapedToken(token) || shannonEntropy(token) < ENTROPY_MIN_BITS_PER_CHAR) return token
    count += 1
    return CREDENTIAL_REDACTION
  })
  return { text: out, count }
}

/**
 * Scan one tool result for credential leaks, PII classes and injection markers.
 *
 * At most {@link MAX_RESULT_SCAN_CHARS} characters are inspected (the hook layer
 * applies the same bound to the view). Up to three findings can be returned, one
 * per category, each carrying every rule id that fired and the highest severity.
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
 * @returns findings in deterministic order (credential, pii, injection), `[]` when clean.
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
  const credentials = scanCredentialLeaks(scanned)
  if (credentials.ruleIds.length > 0) {
    findings.push({
      category: 'credential_leak',
      ruleIds: [...credentials.ruleIds],
      severity: credentials.severity ?? 'high',
      detail: 'credential-shaped value in tool result (value never recorded)',
    })
  }

  // (b) PII / sensitive-value classes (kernel `memory/sanitizer.py`, 1.12.0)
  if (cfg.pii) {
    const pii = scanPii(scanned, cfg.piiClasses)
    if (pii.classes.length > 0) {
      findings.push({
        category: 'pii',
        ruleIds: [...pii.classes],
        severity: pii.severity ?? 'medium',
        detail: 'PII-shaped value in tool result (value never recorded)',
      })
    }
  }

  // (c) injection markers: the same prompt-injection rule family as the input face
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
