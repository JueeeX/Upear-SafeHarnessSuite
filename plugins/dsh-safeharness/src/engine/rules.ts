/**
 * Rule loading, validation and compilation (plan §6.3, digest §3).
 *
 * Semantics mirrored from the Python `rules_loader.py`:
 *   - `*.yaml` / `*.yml` files only, every document in each file, sorted by filename;
 *   - accepted documents: a bare rule list, a single rule mapping, `{rules: [...]}`,
 *     `{chain_rules: [...]}`, or both keys; unknown top-level keys are ignored;
 *   - rules and chain rules live in separate name namespaces, each unique per source
 *     level; precedence is `inline` > `dir` > packaged `rules/` (higher level shadows
 *     the lower one by name — it is an override, not a duplicate);
 *   - patterns stay *strings* here and are compiled once into {@link CompiledRule}.
 *
 * Deliberate divergences (all on the strict side, all fail loud):
 *   - a bad rule file is never skipped: every problem in every file is collected and
 *     the load fails with one {@link RuleLoadError} listing them all;
 *   - Python-only regex syntax is a hard gate ({@link PYTHON_ONLY_REGEX_PATTERNS})
 *     plus a local gate for global inline flags (`(?i)`), per plan §8.2 item 3 —
 *     TS refuses what it cannot reproduce instead of relying on a divergence allowlist;
 *   - `max_gap` must be a YAML integer (no `int("3")` coercion);
 *   - an install that yields no packaged rules, or no deny rules at all, cannot load:
 *     an "ok" empty rule set would make every detection surface inert.
 *
 * `origin` labels: `packaged/<file>`, `dir/<file>` or `inline`, so a shadowed built-in
 * and an operator override are distinguishable in `RuleSet.sources` and the ledger.
 *
 * @module
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from '../util/hash.js'
import { parseYamlDocuments } from '../util/yaml.js'
import { PYTHON_ONLY_REGEX_PATTERNS, RuleLoadError } from './types.js'
import type {
  CompiledChainRule,
  CompiledRule,
  RawChainRule,
  RawRule,
  RuleSet,
  Severity,
} from './types.js'

/**
 * Flags every rule regex is compiled with, and why these two:
 *   - `i` reproduces the Python engine's `re.IGNORECASE` (applied outside the pattern);
 *   - `u` makes `\uXXXX` / `\w` / `.` operate on code points instead of UTF-16 units,
 *     which is the closest JS analogue of Python 3's Unicode str regexes (digest §9.2).
 * The shipped set contains no lone surrogates and no constructs that `/u` changes, and
 * `rules.test.ts` compiles + exercises all 20 patterns under these flags.
 * `g` is never used: a stateful `lastIndex` would make repeated `.test()` calls alternate.
 */
export const RULE_REGEX_FLAGS = 'iu'

/** Hard cap on distinct semantic tags per chain leg (rules_loader.py `_MAX_CHAIN_TAGS`). */
export const MAX_CHAIN_TAGS = 16

/** Rule file suffixes accepted (rules_loader.py `_SUFFIXES`). */
const RULE_FILE_SUFFIX = /\.ya?ml$/i

/** The severity vocabulary, kept in lockstep with the engine `Severity` type. */
const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'info']

/**
 * Format tag folded into the rule-set hash. Bump it whenever the *meaning* of the
 * canonical form changes, so audit rows written by different builds are distinguishable.
 */
const HASH_FORMAT = 'upear-safeharness-rules-v1'

/**
 * Global inline flag groups such as `(?i)` / `(?s)` / `(?m)`: Python-only in the
 * global form (JS only has scoped `(?i:...)` modifiers), and pointless here because
 * the loader already applies `i`. Rejected explicitly so the operator gets a clear
 * message instead of a JS `SyntaxError` (digest §3.5 / §9.7).
 */
const PYTHON_GLOBAL_INLINE_FLAG = /\(\?[aiLmsux-]+\)/

/** A rule source level, lowest precedence first. */
type RuleLevel = 'packaged' | 'dir' | 'inline'

/** Rules and chains collected from one precedence level (or one file batch). */
interface RuleBatch {
  readonly rules: RawRule[]
  readonly chains: RawChainRule[]
}

/** Options for {@link loadRuleSet}. */
export interface LoadRuleSetOptions {
  /** The rules shipped inside the package (`<plugin>/rules`). Must exist and be non-empty. */
  readonly packagedRulesDir: string
  /**
   * Extra operator rule directory. An empty/blank string (the config default) or a
   * missing directory means "no extra rules"; a directory that exists but contains a
   * bad file fails the whole load.
   */
  readonly dir?: string
  /** Highest-precedence inline rule objects/documents (config `rules.inline`). */
  readonly inline?: readonly unknown[]
}

/** The fail-closed result of {@link tryLoadRuleSet}. */
export type RuleSetLoadResult =
  | { readonly ok: true; readonly ruleset: RuleSet }
  | { readonly ok: false; readonly error: RuleLoadError }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load, validate and compile the whole rule set.
 *
 * @param opts - packaged directory, optional operator directory and inline rules.
 * @returns the immutable, hashed {@link RuleSet}.
 * @throws RuleLoadError listing *every* problem found across all sources.
 */
export function loadRuleSet(opts: LoadRuleSetOptions): RuleSet {
  const problems: string[] = []
  const packaged = collectFromDirectory(opts.packagedRulesDir, 'packaged', problems)
  const extraDir = opts.dir === undefined ? '' : opts.dir.trim()
  const local =
    extraDir === '' ? emptyBatch() : collectFromDirectory(extraDir, 'dir', problems)
  const inline = opts.inline === undefined ? emptyBatch() : collectFromInline(opts.inline, problems)

  // Duplicates are only an error *within* one level; across levels the higher
  // level intentionally shadows the lower one (that is what "inline > dir >
  // packaged" means for the operator).
  reportDuplicateNames(packaged, 'packaged rules', problems)
  reportDuplicateNames(local, 'rules.dir', problems)
  reportDuplicateNames(inline, 'rules.inline', problems)

  const rawRules = mergeByName([packaged.rules, local.rules, inline.rules])
  const rawChains = mergeByName([packaged.chains, local.chains, inline.chains])
  if (rawRules.length === 0) {
    problems.push('no deny rules were loaded: refusing to load an inert rule set')
  }
  if (problems.length > 0) throw new RuleLoadError(problems)

  const rules = rawRules.map(compileRule)
  const chains = rawChains.map(compileChain)
  return {
    hash: canonicalRulesetHash(rawRules, rawChains),
    rules,
    chains,
    ruleCount: rules.length,
    chainCount: chains.length,
    sources: collectSources(rawRules, rawChains),
    loadedAt: Date.now(),
  }
}

/**
 * {@link loadRuleSet} that never throws, for callers that must degrade fail-closed
 * (keep the previous rule set, report a WARN) instead of crashing the plugin.
 */
export function tryLoadRuleSet(opts: LoadRuleSetOptions): RuleSetLoadResult {
  try {
    return { ok: true, ruleset: loadRuleSet(opts) }
  } catch (cause) {
    if (cause instanceof RuleLoadError) return { ok: false, error: cause }
    // Last-resort containment: the contract is "always a RuleLoadError", and an
    // unexpected internal failure must never be mistaken for a usable rule set.
    return {
      ok: false,
      error: new RuleLoadError([`unexpected rule loading failure: ${errorMessage(cause)}`]),
    }
  }
}

/**
 * Compile one already-validated raw rule.
 *
 * Re-runs the regex gate so a hand-built `RawRule` cannot smuggle in Python-only
 * syntax past the loader; `source` is kept verbatim for reproducibility.
 *
 * @throws RuleLoadError when the pattern is unusable.
 */
export function compileRule(raw: RawRule): CompiledRule {
  const label = `rule '${raw.name}'`
  const problems: string[] = []
  if (raw.action !== 'deny') problems.push(`${label}: action must be 'deny'`)
  if (!isSeverity(raw.severity)) problems.push(`${label}: invalid severity '${raw.severity}'`)
  const regex = checkRegex(raw.pattern, label, problems)
  if (regex === undefined || problems.length > 0) throw new RuleLoadError(problems)
  return {
    id: raw.name,
    name: raw.name,
    source: raw.pattern,
    regex,
    severity: raw.severity,
    category: raw.category,
    action: 'deny',
    reason: raw.reason,
    origin: raw.origin,
  }
}

/**
 * Compile one already-validated raw chain rule, re-checking everything a chain
 * needs to be usable (both legs present, tag cap, gap sanity).
 *
 * @throws RuleLoadError when the chain is unusable.
 */
export function compileChain(raw: RawChainRule): CompiledChainRule {
  const label = `chain '${raw.name}'`
  const problems: string[] = []
  if (raw.first === undefined && raw.firstTags.length === 0) {
    problems.push(`${label}: chain needs a 'first' regex or 'first_tags'`)
  }
  if (raw.then === undefined && raw.thenTags.length === 0) {
    problems.push(`${label}: chain needs a 'then' regex or 'then_tags'`)
  }
  if (raw.firstTags.length > MAX_CHAIN_TAGS) {
    problems.push(`${label}: 'first_tags' has ${raw.firstTags.length} tags; at most ${MAX_CHAIN_TAGS}`)
  }
  if (raw.thenTags.length > MAX_CHAIN_TAGS) {
    problems.push(`${label}: 'then_tags' has ${raw.thenTags.length} tags; at most ${MAX_CHAIN_TAGS}`)
  }
  if (!Number.isInteger(raw.maxGap) || raw.maxGap < 0) {
    problems.push(`${label}: max_gap must be an integer >= 0`)
  }
  if (!isSeverity(raw.severity)) problems.push(`${label}: invalid severity '${raw.severity}'`)
  const first = raw.first === undefined ? undefined : checkRegex(raw.first, `${label} 'first'`, problems)
  const then = raw.then === undefined ? undefined : checkRegex(raw.then, `${label} 'then'`, problems)
  if (problems.length > 0) throw new RuleLoadError(problems)
  return {
    name: raw.name,
    firstSource: raw.first,
    first,
    thenSource: raw.then,
    then,
    firstTags: [...raw.firstTags],
    thenTags: [...raw.thenTags],
    maxGap: raw.maxGap,
    severity: raw.severity,
    category: raw.category,
    reason: raw.reason,
  }
}

/**
 * Stable identity of a rule set: sha256 over the canonical JSON of the raw specs.
 *
 * `origin` (a filesystem path) and `loadedAt` are excluded, so the hash is identical
 * across reloads, machines and install directories, and changes iff a rule's content
 * changes. Declaration order is preserved: it is the evaluation order of the rules.
 *
 * @param rawRules - the effective (post-override) deny rules.
 * @param rawChains - the effective (post-override) chain rules.
 */
export function canonicalRulesetHash(
  rawRules: readonly RawRule[],
  rawChains: readonly RawChainRule[],
): string {
  return sha256Hex(
    canonicalJson({
      format: HASH_FORMAT,
      rules: rawRules.map((raw) => ({
        action: raw.action,
        category: raw.category,
        name: raw.name,
        pattern: raw.pattern,
        reason: raw.reason,
        severity: raw.severity,
      })),
      chains: rawChains.map((raw) => ({
        category: raw.category,
        first: raw.first,
        firstTags: [...raw.firstTags],
        maxGap: raw.maxGap,
        name: raw.name,
        reason: raw.reason,
        severity: raw.severity,
        then: raw.then,
        thenTags: [...raw.thenTags],
      })),
    }),
  )
}

// ---------------------------------------------------------------------------
// Source collection
// ---------------------------------------------------------------------------

function emptyBatch(): RuleBatch {
  return { rules: [], chains: [] }
}

/**
 * Read every `*.yaml`/`*.yml` file in `directory`, in filename order.
 *
 * A missing `dir` (operator option) is normal and contributes nothing; a missing or
 * empty *packaged* directory is a broken install and always reported.
 */
function collectFromDirectory(directory: string, level: RuleLevel, problems: string[]): RuleBatch {
  const batch = emptyBatch()
  let fileNames: string[]
  try {
    fileNames = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && RULE_FILE_SUFFIX.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareFileNames)
  } catch (cause) {
    if (level === 'packaged') {
      problems.push(`packaged rules: cannot read directory '${directory}' (${errorMessage(cause)})`)
    } else if (!isNotFound(cause)) {
      problems.push(`rules.dir: cannot read directory '${directory}' (${errorMessage(cause)})`)
    }
    return batch
  }
  if (fileNames.length === 0 && level === 'packaged') {
    problems.push(
      `packaged rules: '${directory}' contains no *.yaml/*.yml files (the built-in rules must always be present)`,
    )
    return batch
  }
  for (const fileName of fileNames) {
    const origin = `${level}/${fileName}`
    let text: string
    try {
      text = readFileSync(join(directory, fileName), 'utf8')
    } catch (cause) {
      problems.push(`${origin}: cannot read file (${errorMessage(cause)})`)
      continue
    }
    let documents: unknown[]
    try {
      documents = parseYamlDocuments(text, origin)
    } catch (cause) {
      // The YAML parser already prefixes `origin:line`, so this stays a single
      // self-describing problem instead of a second wrapper.
      problems.push(errorMessage(cause))
      continue
    }
    for (const document of documents) collectDocument(document, origin, batch, problems)
  }
  return batch
}

/** Collect inline rule objects/documents (already-parsed values from config). */
function collectFromInline(items: readonly unknown[], problems: string[]): RuleBatch {
  const batch = emptyBatch()
  for (const item of items) collectDocument(item, 'inline', batch, problems)
  return batch
}

/**
 * Interpret one loaded YAML document (or one inline item).
 *
 * Shapes are exactly the ones rules_loader.py accepts: a list of rules, a single rule
 * mapping, `{rules: [...]}`, `{chain_rules: [...]}`, or both keys in one mapping.
 * Any other top-level key is ignored on purpose (forward compatibility).
 */
function collectDocument(
  document: unknown,
  origin: string,
  batch: RuleBatch,
  problems: string[],
): void {
  if (document === null || document === undefined) return
  if (Array.isArray(document)) {
    document.forEach((item, index) => {
      collectRuleItem(item, origin, `${origin}[${index}]`, batch, problems)
    })
    return
  }
  if (typeof document !== 'object') {
    problems.push(`${origin}: expected a rule mapping or a list of rule mappings, found ${describeValue(document)}`)
    return
  }
  const record = document as Record<string, unknown>
  const hasRules = Object.prototype.hasOwnProperty.call(record, 'rules')
  const hasChains = Object.prototype.hasOwnProperty.call(record, 'chain_rules')
  if (!hasRules && !hasChains) {
    collectRuleItem(record, origin, origin, batch, problems)
    return
  }
  if (hasRules) {
    const rules = record['rules']
    if (!Array.isArray(rules)) {
      problems.push(`${origin}: 'rules' must be a list of rule mappings`)
    } else {
      rules.forEach((item, index) => {
        collectRuleItem(item, origin, `${origin}: rules[${index}]`, batch, problems)
      })
    }
  }
  if (hasChains) {
    const chains = record['chain_rules']
    if (!Array.isArray(chains)) {
      problems.push(`${origin}: 'chain_rules' must be a list of chain rule mappings`)
    } else {
      chains.forEach((item, index) => {
        collectChainItem(item, origin, `${origin}: chain_rules[${index}]`, batch, problems)
      })
    }
  }
}

/** Validate one rule mapping; push it only when it produced no problems at all. */
function collectRuleItem(
  item: unknown,
  origin: string,
  label: string,
  batch: RuleBatch,
  problems: string[],
): void {
  const record = asRecord(item)
  if (record === undefined) {
    problems.push(`${label}: expected a rule mapping, found ${describeValue(item)}`)
    return
  }
  const rule = buildRule(record, origin, label, problems)
  if (rule !== undefined) {
    batch.rules.push(rule)
    return
  }
  // Hint only (the load already failed): a chain mapping is not a legal bare
  // document / list item, and "pattern is required" alone hides that. Never a
  // fallback — guessing here could turn a chain into an inert deny rule.
  if (record['pattern'] === undefined && isChainShaped(record)) {
    problems.push(
      `${label}: a chain rule must be nested under 'chain_rules:', not listed as a rule (chain keys without 'pattern')`,
    )
  }
}

/** True when a mapping looks like a chain rule (so the error can say what is missing). */
function isChainShaped(record: Record<string, unknown>): boolean {
  return record['first'] !== undefined || record['then'] !== undefined || record['first_tags'] !== undefined || record['max_gap'] !== undefined
}

/** Validate one chain mapping; push it only when it produced no problems at all. */
function collectChainItem(
  item: unknown,
  origin: string,
  label: string,
  batch: RuleBatch,
  problems: string[],
): void {
  const record = asRecord(item)
  if (record === undefined) {
    problems.push(`${label}: expected a chain rule mapping, found ${describeValue(item)}`)
    return
  }
  const chain = buildChain(record, origin, label, problems)
  if (chain !== undefined) batch.chains.push(chain)
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

function buildRule(
  record: Record<string, unknown>,
  origin: string,
  label: string,
  problems: string[],
): RawRule | undefined {
  const problemCount = problems.length
  const name = readName(record, label, problems)
  const tagged = name === undefined ? label : `${label} ('${name}')`
  const pattern = readPattern(record, tagged, problems)
  const severity = readSeverity(record, tagged, problems, 'high')
  const action = readAction(record, tagged, problems)
  const category = readOptionalString(record, 'category', tagged, problems, '')
  const reason = readOptionalString(record, 'reason', tagged, problems, '')
  if (name === undefined || pattern === undefined || problems.length !== problemCount) {
    return undefined
  }
  return { name, pattern, severity, category, action, reason, origin }
}

function buildChain(
  record: Record<string, unknown>,
  origin: string,
  label: string,
  problems: string[],
): RawChainRule | undefined {
  const problemCount = problems.length
  const name = readName(record, label, problems)
  const tagged = name === undefined ? label : `${label} ('${name}')`
  const first = readChainPattern(record, 'first', tagged, problems)
  const then = readChainPattern(record, 'then', tagged, problems)
  const firstTags = readTags(record, 'first_tags', tagged, problems)
  const thenTags = readTags(record, 'then_tags', tagged, problems)
  const maxGap = readMaxGap(record, tagged, problems)
  const severity = readSeverity(record, tagged, problems, 'high')
  const category = readOptionalString(record, 'category', tagged, problems, 'trajectory_chain')
  const reason = readOptionalString(record, 'reason', tagged, problems, '')
  // A chain leg must be able to match something: a tool-name regex or at least one tag.
  if (first.source === undefined && firstTags.length === 0) {
    problems.push(`${label}: chain needs a 'first' regex or 'first_tags'`)
  }
  if (then.source === undefined && thenTags.length === 0) {
    problems.push(`${label}: chain needs a 'then' regex or 'then_tags'`)
  }
  if (name === undefined || problems.length !== problemCount) return undefined
  return {
    name,
    first: first.source,
    then: then.source,
    firstTags,
    thenTags,
    maxGap,
    severity,
    category,
    reason,
    origin,
  }
}

/** `name` is required, non-empty and (per level) unique; compared after trimming. */
function readName(
  record: Record<string, unknown>,
  label: string,
  problems: string[],
): string | undefined {
  const raw = record['name']
  if (raw === undefined) {
    problems.push(`${label}: 'name' is required`)
    return undefined
  }
  if (typeof raw !== 'string') {
    problems.push(`${label}: 'name' must be a string`)
    return undefined
  }
  const name = raw.trim()
  if (name === '') {
    problems.push(`${label}: 'name' must not be empty`)
    return undefined
  }
  return name
}

/** `pattern` is required, non-empty and must pass the JS regex gate. Kept verbatim. */
function readPattern(
  record: Record<string, unknown>,
  label: string,
  problems: string[],
): string | undefined {
  const raw = record['pattern']
  if (raw === undefined) {
    problems.push(`${label}: 'pattern' is required`)
    return undefined
  }
  if (typeof raw !== 'string') {
    problems.push(`${label}: 'pattern' must be a string`)
    return undefined
  }
  if (raw.trim() === '') {
    problems.push(`${label}: 'pattern' must not be empty`)
    return undefined
  }
  if (checkRegex(raw, label, problems) === undefined) return undefined
  return raw
}

/** An optional chain-leg regex; Python `.strip()`s these, so we do too. */
interface ChainPattern {
  readonly source: string | undefined
}

function readChainPattern(
  record: Record<string, unknown>,
  key: 'first' | 'then',
  label: string,
  problems: string[],
): ChainPattern {
  const raw = record[key]
  if (raw === undefined) return { source: undefined }
  if (typeof raw !== 'string') {
    problems.push(`${label}: '${key}' must be a string (a tool-name regex)`)
    return { source: undefined }
  }
  const source = raw.trim()
  if (source === '') {
    problems.push(`${label}: '${key}' must not be empty when present`)
    return { source: undefined }
  }
  if (checkRegex(source, `${label} '${key}'`, problems) === undefined) {
    return { source: undefined }
  }
  return { source }
}

/** Optional `first_tags`/`then_tags`: non-empty strings, deduped, capped at 16. */
function readTags(
  record: Record<string, unknown>,
  key: 'first_tags' | 'then_tags',
  label: string,
  problems: string[],
): string[] {
  const raw = record[key]
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    problems.push(`${label}: '${key}' must be a list of tag strings`)
    return []
  }
  const seen = new Set<string>()
  const tags: string[] = []
  raw.forEach((item, index) => {
    if (typeof item !== 'string') {
      problems.push(`${label}: '${key}[${index}]' must be a string`)
      return
    }
    const tag = item.trim()
    if (tag === '') {
      problems.push(`${label}: '${key}[${index}]' must not be empty`)
      return
    }
    if (seen.has(tag)) return
    seen.add(tag)
    tags.push(tag)
  })
  // Python dedupes first, then enforces the cap; mirror that exactly.
  if (tags.length > MAX_CHAIN_TAGS) {
    problems.push(
      `${label}: '${key}' lists ${tags.length} distinct tags; at most ${MAX_CHAIN_TAGS} are supported`,
    )
  }
  return tags
}

/** `max_gap` must be an integer >= 0 (0 = any distance); no string coercion. */
function readMaxGap(record: Record<string, unknown>, label: string, problems: string[]): number {
  const raw = record['max_gap']
  if (raw === undefined) return 0
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    problems.push(`${label}: 'max_gap' must be an integer >= 0 (0 means any distance)`)
    return 0
  }
  if (raw < 0) {
    problems.push(`${label}: 'max_gap' must be >= 0 (0 means any distance)`)
    return 0
  }
  return raw
}

function readSeverity(
  record: Record<string, unknown>,
  label: string,
  problems: string[],
  fallback: Severity,
): Severity {
  const raw = record['severity']
  if (raw === undefined) return fallback
  if (typeof raw !== 'string' || !isSeverity(raw)) {
    problems.push(`${label}: 'severity' must be one of ${SEVERITIES.join(', ')}`)
    return fallback
  }
  return raw
}

/** `action` defaults to `deny`; v1 refuses to load anything else (rules_loader `_ACTIONS`). */
function readAction(
  record: Record<string, unknown>,
  label: string,
  problems: string[],
): 'deny' {
  const raw = record['action']
  if (raw === undefined) return 'deny'
  if (raw !== 'deny') {
    problems.push(`${label}: 'action' must be 'deny' (the only supported action in v1)`)
  }
  return 'deny'
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
  problems: string[],
  fallback: string,
): string {
  const raw = record[key]
  if (raw === undefined) return fallback
  if (typeof raw !== 'string') {
    problems.push(`${label}: '${key}' must be a string`)
    return fallback
  }
  return raw
}

/**
 * The JS/Python regex hard gate.
 *
 * 1. Python-only constructs listed in `PYTHON_ONLY_REGEX_PATTERNS` (plan §8.2 item 3:
 *    reject them outright, never allowlist a divergence);
 * 2. global inline flag groups (Python-only in JS, redundant under our `iu` flags);
 * 3. compilation under {@link RULE_REGEX_FLAGS}; JS is stricter than Python in a few
 *    places (e.g. `\-` outside a class is invalid under `u`), and that is intentional:
 *    a pattern we cannot reproduce exactly is a pattern we must not pretend to run.
 */
function checkRegex(source: string, label: string, problems: string[]): RegExp | undefined {
  if (source === '') {
    problems.push(`${label}: pattern must not be empty`)
    return undefined
  }
  for (const gate of PYTHON_ONLY_REGEX_PATTERNS) {
    if (gate.pattern.test(source)) {
      problems.push(
        `${label}: pattern uses ${gate.feature}, which JS cannot reproduce identically (rejected by the rule loader)`,
      )
      return undefined
    }
  }
  if (PYTHON_GLOBAL_INLINE_FLAG.test(source)) {
    problems.push(
      `${label}: pattern uses a global inline flag group such as (?i); the loader already applies the 'i' flag — remove it`,
    )
    return undefined
  }
  try {
    return new RegExp(source, RULE_REGEX_FLAGS)
  } catch (cause) {
    problems.push(
      `${label}: pattern does not compile with JS RegExp flags '${RULE_REGEX_FLAGS}' (${errorMessage(cause)})`,
    )
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Merging / helpers
// ---------------------------------------------------------------------------

/** Case-insensitive severity membership test (no cast: keeps the type guard honest). */
function isSeverity(value: string): value is Severity {
  for (const severity of SEVERITIES) {
    if (severity === value) return true
  }
  return false
}

/** Duplicate names inside one level are an error; rules and chains are separate namespaces. */
function reportDuplicateNames(batch: RuleBatch, level: string, problems: string[]): void {
  reportDuplicates(
    batch.rules.map((rule) => rule.name),
    `${level}: duplicate rule name`,
    problems,
  )
  reportDuplicates(
    batch.chains.map((chain) => chain.name),
    `${level}: duplicate chain name`,
    problems,
  )
}

function reportDuplicates(names: readonly string[], prefix: string, problems: string[]): void {
  const seen = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) {
      problems.push(`${prefix} '${name}' (names must be unique within one source)`)
    } else {
      seen.add(name)
    }
  }
}

/**
 * Merge levels lowest-precedence first; a later entry with the same name replaces the
 * earlier one in place, so the packaged declaration order stays the evaluation order.
 */
function mergeByName<T extends { readonly name: string }>(
  levels: readonly (readonly T[])[],
): T[] {
  const merged = new Map<string, T>()
  for (const level of levels) {
    for (const item of level) merged.set(item.name, item)
  }
  return [...merged.values()]
}

/**
 * Contributing origins, first-occurrence order, for `RuleSet.sources`.
 *
 * Computed from the *raw* specs: `CompiledChainRule` deliberately has no `origin`
 * field, and a chain-only operator file must still be reported as a contributor.
 */
function collectSources(
  rules: readonly RawRule[],
  chains: readonly RawChainRule[],
): string[] {
  const sources: string[] = []
  const seen = new Set<string>()
  const add = (origin: string): void => {
    if (seen.has(origin)) return
    seen.add(origin)
    sources.push(origin)
  }
  for (const rule of rules) add(rule.origin)
  for (const chain of chains) add(chain.origin)
  return sources
}

/** Locale-independent filename order (`String#localeCompare` varies by host locale). */
function compareFileNames(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Narrow an unknown to a plain mapping (arrays and null are not mappings). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'nothing'
  if (Array.isArray(value)) return 'a list'
  switch (typeof value) {
    case 'object':
      return 'a mapping'
    case 'string':
      return 'a string'
    case 'number':
      return 'a number'
    case 'boolean':
      return 'a boolean'
    default:
      return `a ${typeof value}`
  }
}

/** `Error#message` for unknown throwables, never a cast to `any`. */
function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** True for the "the optional directory is simply not there" fs errors. */
function isNotFound(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  if (!('code' in cause)) return false
  const code = (cause as { readonly code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
