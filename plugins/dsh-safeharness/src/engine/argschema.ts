/**
 * Per-tool argument shape rules: the TypeScript port of the **argument-schema**
 * half of the kernel's `policies/constrain.py` (read-only reference).
 *
 * What the kernel does and what is deliberately not ported:
 *
 * - `constrain.py` resolves the call against a trusted `ToolCatalog`, validates
 *   `arguments` against the descriptor's `input_schema` via
 *   `policies/_schema.py` (a small JSON-Schema subset), then asks a
 *   `CapabilityAuthority` for an authorization decision.
 * - The **catalog** half has no DSH equivalent (the host owns the registry and
 *   never hands the plugin a signed descriptor), so it stays approximated by
 *   `tools.denyTools` / `denyTags` / `tagOverrides` — documented in MANUAL §8.
 * - The **authority** half is the forged-token / HMAC world the plugin does not
 *   reproduce (MANUAL §8 "明确不移植").
 * - The **schema** half is what this module ports, and it ports it in the shape
 *   this package already uses elsewhere: a small set of primitives rather than a
 *   JSON-Schema engine. The host already validates model-generated arguments
 *   against each tool's own declared parameters; adding a second, competing
 *   JSON-Schema implementation inside the plugin would mean two answers to "is
 *   this argument acceptable", which is exactly the ambiguity a security control
 *   must not have.
 *
 * Primitives (every one is a bound the engine can check in linear time):
 *
 * | keyword            | meaning                                                  |
 * |--------------------|----------------------------------------------------------|
 * | `pattern`          | the value must match a regex (same loader gate as rules) |
 * | `enum`             | the value must be one of a fixed list                    |
 * | `minBytes`/`maxBytes` | UTF-8 size bounds (string length, else JSON length)   |
 * | `pathPrefix`       | a filesystem path that stays under a prefix (no `..`)    |
 * | `urlScheme`        | a URL whose scheme is on the list (`file:` is not, by default) |
 * | `commandAllowlist` | a command line whose first token is on the list, with no shell metacharacters |
 *
 * Secrets discipline: a violation is reported as
 * `{schema, argument name, constraint kind}`. The value is **never** retained,
 * quoted, hashed or logged by this module — the caller already records
 * `args_sha256` from the canonical argument form.
 *
 * ReDoS discipline: `pattern` goes through the same {@link checkRegex} gate the
 * rule loader uses (Python-only constructs, global inline flags, unbounded nested
 * quantifiers). An argument can be 64 KiB of attacker-controlled text and this
 * check runs in the tool pipeline, so a pattern that can backtrack catastrophically
 * must never be accepted here either.
 * @module
 */
import { canonicalJson } from '../util/hash.js'
import { checkRegex } from './rules.js'

/**
 * One operator-declared argument schema.
 *
 * Declared in `tools.argSchemas`; the raw form is what lives in `ResolvedConfig`
 * (plain, frozen JSON data) so a hot-reloaded config can be compared structurally.
 */
export interface ArgSchemaDeclaration {
  /**
   * Stable rule id recorded on a denial. Defaults to `arg_schema_<index>`; an
   * explicit name is what shows up in `rule_ids` and in the posture report.
   */
  readonly name?: string
  /** Tool-name glob (`*` is the only wildcard), same syntax as `tools.denyTools`. */
  readonly tool: string
  /** Argument name → the bounds that argument must satisfy. */
  readonly args: Readonly<Record<string, ArgBounds>>
}

/** The bounds one argument may carry. Every keyword is optional; none = no opinion. */
export interface ArgBounds {
  /** Regex source the whole value must match (compiled with the rule loader's gate). */
  readonly pattern?: string
  /** Closed list of accepted values. */
  readonly enum?: readonly string[]
  /** Minimum UTF-8 byte length. */
  readonly minBytes?: number
  /** Maximum UTF-8 byte length. */
  readonly maxBytes?: number
  /** A path that must stay under this prefix (`..` segments are always refused). */
  readonly pathPrefix?: string
  /** Accepted URL schemes, lower case, without `:` (e.g. `['https']`). */
  readonly urlScheme?: readonly string[]
  /** Accepted first token of a command line (case-insensitive, no path stripping). */
  readonly commandAllowlist?: readonly string[]
}

/** Hard cap on declared schemas per deployment (a typo must not cost a scan loop). */
export const MAX_ARG_SCHEMAS = 64

/** Hard cap on distinct argument names per schema. */
export const MAX_SCHEMA_ARGS = 32

/** Hard cap on constraints per argument. */
export const MAX_CONSTRAINTS_PER_ARG = 8

/** Hard cap on `enum` / `urlScheme` / `commandAllowlist` entries. */
export const MAX_LIST_VALUES = 64

/** Hard cap on a `pattern` source (mirrors the draft surface's cap). */
export const MAX_PATTERN_CHARS = 300

/** One compiled constraint; the discriminant is what a violation reports. */
type CompiledConstraint =
  | { readonly kind: 'pattern'; readonly regex: RegExp }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'minBytes'; readonly min: number }
  | { readonly kind: 'maxBytes'; readonly max: number }
  | { readonly kind: 'pathPrefix'; readonly prefix: string }
  | { readonly kind: 'urlScheme'; readonly schemes: readonly string[] }
  | { readonly kind: 'commandAllowlist'; readonly commands: readonly string[] }

/** One compiled argument: its name and the bounds in declaration order. */
interface CompiledArg {
  readonly arg: string
  readonly constraints: readonly CompiledConstraint[]
}

/** One compiled schema, ready to match a tool name and check its arguments. */
export interface CompiledArgSchema {
  /** Rule id recorded on a denial (`name` or `arg_schema_<index>`). */
  readonly name: string
  /** Tool-name glob, matched by the caller with the shared glob predicate. */
  readonly tool: string
  readonly args: readonly CompiledArg[]
}

/** A refusal, with no reference to the offending value. */
export interface ArgSchemaViolation {
  /** Rule id of the schema that refused the call. */
  readonly schema: string
  /** Declared argument name. */
  readonly argument: string
  /** Which constraint refused: `pattern` / `enum` / `minBytes` / `maxBytes` /
   *  `pathPrefix` / `urlScheme` / `commandAllowlist` / `type`. */
  readonly constraint: string
}

/** The compile outcome: usable entries plus one message per rejected declaration. */
export interface ArgSchemaCompileResult {
  readonly entries: readonly CompiledArgSchema[]
  readonly problems: readonly string[]
}

/** Characters that make a shell do something other than run the first token. */
const SHELL_METACHARACTER = /[;&|`$<>(){}\n\r]/

/** Scheme prefix of a URL (`https:`, `file:`, `javascript:`). */
const URL_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/

/**
 * Compile cache, keyed by the declaration array's identity.
 *
 * `resolveConfig` deep-freezes a fresh array per config version, so the identity
 * is stable for as long as one config is live and a hot reload naturally misses.
 * Bounded by config churn, never by attacker input.
 */
const compileCache = new WeakMap<object, ArgSchemaCompileResult>()

/** Byte length of a value as it would appear on the wire. */
function byteLengthOf(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  return Buffer.byteLength(canonicalJson(value), 'utf8')
}

/** Read a positive integer bound, or report the declaration as unusable. */
function readSize(
  raw: unknown,
  label: string,
  problems: string[],
): number | undefined {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    problems.push(`${label} must be a non-negative integer`)
    return undefined
  }
  return raw
}

/** Read a bounded list of non-empty strings. */
function readStringList(
  raw: unknown,
  label: string,
  problems: string[],
  { lowerCase = false }: { lowerCase?: boolean } = {},
): string[] | undefined {
  if (!Array.isArray(raw)) {
    problems.push(`${label} must be an array of strings`)
    return undefined
  }
  if (raw.length === 0) {
    problems.push(`${label} must list at least one value`)
    return undefined
  }
  if (raw.length > MAX_LIST_VALUES) {
    problems.push(`${label} lists ${raw.length} values; at most ${MAX_LIST_VALUES}`)
    return undefined
  }
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.length === 0) {
      problems.push(`${label} entries must be non-empty strings`)
      return undefined
    }
    const value = lowerCase ? entry.toLowerCase() : entry
    if (!out.includes(value)) out.push(value)
  }
  return out
}

/**
 * Normalize one path for prefix containment: unify separators and collapse the
 * `.` segments, but **keep** `..` so the caller can refuse it.
 *
 * @param value - raw path text.
 * @returns segments, with empty and `.` entries removed.
 */
function pathSegments(value: string): string[] {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
}

/**
 * Compile one `args` map.
 *
 * @param raw - the declaration's `args` object.
 * @param label - prefix used in problem messages.
 * @param problems - collector; a non-empty return means the schema is unusable.
 * @returns the compiled arguments, in declaration order.
 */
function compileArgs(
  raw: unknown,
  label: string,
  problems: string[],
): CompiledArg[] | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push(`${label}: 'args' must be an object of argument names`)
    return undefined
  }
  const names = Object.keys(raw as Record<string, unknown>)
  if (names.length === 0) {
    problems.push(`${label}: 'args' must declare at least one argument`)
    return undefined
  }
  if (names.length > MAX_SCHEMA_ARGS) {
    problems.push(`${label}: 'args' declares ${names.length} arguments; at most ${MAX_SCHEMA_ARGS}`)
    return undefined
  }

  const compiled: CompiledArg[] = []
  for (const arg of names) {
    const spec = (raw as Record<string, unknown>)[arg]
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      problems.push(`${label}.${arg}: bounds must be an object`)
      return undefined
    }
    const bounds = spec as Record<string, unknown>
    const constraints: CompiledConstraint[] = []
    const argLabel = `${label}.${arg}`

    if (bounds['pattern'] !== undefined) {
      const source = bounds['pattern']
      if (typeof source !== 'string' || source.length === 0) {
        problems.push(`${argLabel}.pattern must be a non-empty string`)
        return undefined
      }
      if (source.length > MAX_PATTERN_CHARS) {
        problems.push(`${argLabel}.pattern is ${source.length} chars; at most ${MAX_PATTERN_CHARS}`)
        return undefined
      }
      const regex = checkRegex(source, `${argLabel}.pattern`, problems)
      if (regex === undefined) return undefined
      constraints.push({ kind: 'pattern', regex })
    }

    if (bounds['enum'] !== undefined) {
      const values = readStringList(bounds['enum'], `${argLabel}.enum`, problems)
      if (values === undefined) return undefined
      constraints.push({ kind: 'enum', values })
    }

    if (bounds['minBytes'] !== undefined) {
      const min = readSize(bounds['minBytes'], `${argLabel}.minBytes`, problems)
      if (min === undefined) return undefined
      constraints.push({ kind: 'minBytes', min })
    }

    if (bounds['maxBytes'] !== undefined) {
      const max = readSize(bounds['maxBytes'], `${argLabel}.maxBytes`, problems)
      if (max === undefined) return undefined
      constraints.push({ kind: 'maxBytes', max })
    }

    if (bounds['pathPrefix'] !== undefined) {
      const prefix = bounds['pathPrefix']
      if (typeof prefix !== 'string' || prefix.length === 0) {
        problems.push(`${argLabel}.pathPrefix must be a non-empty string`)
        return undefined
      }
      if (pathSegments(prefix).includes('..')) {
        problems.push(`${argLabel}.pathPrefix must not itself contain '..'`)
        return undefined
      }
      if (pathSegments(prefix).length === 0) {
        problems.push(`${argLabel}.pathPrefix must name a directory, not the filesystem root`)
        return undefined
      }
      constraints.push({ kind: 'pathPrefix', prefix: pathSegments(prefix).join('/') })
    }

    if (bounds['urlScheme'] !== undefined) {
      const schemes = readStringList(bounds['urlScheme'], `${argLabel}.urlScheme`, problems, { lowerCase: true })
      if (schemes === undefined) return undefined
      for (const scheme of schemes) {
        if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
          problems.push(`${argLabel}.urlScheme entries must be bare scheme names such as 'https'`)
          return undefined
        }
      }
      constraints.push({ kind: 'urlScheme', schemes })
    }

    if (bounds['commandAllowlist'] !== undefined) {
      const commands = readStringList(bounds['commandAllowlist'], `${argLabel}.commandAllowlist`, problems, { lowerCase: true })
      if (commands === undefined) return undefined
      for (const command of commands) {
        if (/\s/.test(command)) {
          problems.push(`${argLabel}.commandAllowlist entries must be single command names`)
          return undefined
        }
      }
      constraints.push({ kind: 'commandAllowlist', commands })
    }

    const unknownKeys = Object.keys(bounds).filter((key) => !SUPPORTED_KEYWORDS.has(key))
    if (unknownKeys.length > 0) {
      // Refuse rather than ignore: an operator who wrote `regex:` instead of
      // `pattern:` must not get a schema that silently checks nothing.
      problems.push(`${argLabel}: unsupported keyword(s) ${unknownKeys.sort().join(', ')}`)
      return undefined
    }

    if (constraints.length === 0) {
      problems.push(`${argLabel}: needs at least one bound (${[...SUPPORTED_KEYWORDS].sort().join(', ')})`)
      return undefined
    }
    if (constraints.length > MAX_CONSTRAINTS_PER_ARG) {
      problems.push(`${argLabel}: ${constraints.length} bounds; at most ${MAX_CONSTRAINTS_PER_ARG}`)
      return undefined
    }
    compiled.push({ arg, constraints })
  }
  return compiled
}

/** Every keyword {@link ArgBounds} accepts. */
const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  'pattern',
  'enum',
  'minBytes',
  'maxBytes',
  'pathPrefix',
  'urlScheme',
  'commandAllowlist',
])

/**
 * Compile `tools.argSchemas` into match-ready entries.
 *
 * Fail-loud per declaration, never globally: one unusable declaration is dropped
 * and reported (the posture check turns it into `arg_schema_invalid`), the rest
 * keep protecting their tools. A declaration is never silently rewritten.
 *
 * @param raw - the operator's declarations, straight from the resolved config.
 * @returns compiled entries plus one message per rejected declaration.
 */
export function compileArgSchemas(raw: readonly ArgSchemaDeclaration[] | undefined): ArgSchemaCompileResult {
  if (raw === undefined || raw.length === 0) return { entries: [], problems: [] }
  const cached = compileCache.get(raw as unknown as object)
  if (cached !== undefined) return cached

  const problems: string[] = []
  const entries: CompiledArgSchema[] = []

  if (!Array.isArray(raw)) {
    const result: ArgSchemaCompileResult = {
      entries: [],
      problems: ['tools.argSchemas must be an array'],
    }
    compileCache.set(raw as unknown as object, result)
    return result
  }
  if (raw.length > MAX_ARG_SCHEMAS) {
    const result: ArgSchemaCompileResult = {
      entries: [],
      problems: [`tools.argSchemas declares ${raw.length} schemas; at most ${MAX_ARG_SCHEMAS}`],
    }
    compileCache.set(raw as unknown as object, result)
    return result
  }

  for (let index = 0; index < raw.length; index += 1) {
    const declaration = raw[index]
    const fallbackName = `arg_schema_${index}`
    if (declaration === null || typeof declaration !== 'object' || Array.isArray(declaration)) {
      problems.push(`${fallbackName}: must be an object`)
      continue
    }
    const record = declaration as unknown as Record<string, unknown>
    const label = typeof record['name'] === 'string' && record['name'].length > 0
      ? (record['name'] as string)
      : fallbackName
    if (typeof record['tool'] !== 'string' || record['tool'].length === 0) {
      problems.push(`${label}: 'tool' must be a non-empty name glob`)
      continue
    }
    const args = compileArgs(record['args'], label, problems)
    if (args === undefined) continue
    entries.push({ name: label, tool: record['tool'] as string, args })
  }

  const result: ArgSchemaCompileResult = { entries, problems }
  compileCache.set(raw as unknown as object, result)
  return result
}

/**
 * Compile a declaration set for reporting only.
 *
 * Used by the posture check, which needs the reject messages but not the entries.
 *
 * @param raw - the operator's declarations.
 * @returns one message per unusable declaration (empty when everything compiled).
 */
export function argSchemaProblems(raw: readonly ArgSchemaDeclaration[] | undefined): readonly string[] {
  return compileArgSchemas(raw).problems
}

/** True when a non-string value shows up where a string-only bound was declared. */
function isStringValue(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * Check one argument value against one constraint.
 *
 * @param constraint - the compiled bound.
 * @param value - the argument value as the host parsed it.
 * @returns the constraint kind that refused, or `undefined` when it passed.
 */
function checkConstraint(constraint: CompiledConstraint, value: unknown): string | undefined {
  if (constraint.kind === 'maxBytes') {
    return byteLengthOf(value) > constraint.max ? 'maxBytes' : undefined
  }
  if (constraint.kind === 'minBytes') {
    return byteLengthOf(value) < constraint.min ? 'minBytes' : undefined
  }
  // Every remaining bound is about the text of a string argument; a structured
  // value cannot be shown to satisfy it, so it is refused (fail-closed).
  if (!isStringValue(value)) return 'type'

  switch (constraint.kind) {
    case 'pattern': {
      if (constraint.regex.global || constraint.regex.sticky) constraint.regex.lastIndex = 0
      const hit = constraint.regex.test(value)
      if (constraint.regex.global || constraint.regex.sticky) constraint.regex.lastIndex = 0
      return hit ? undefined : 'pattern'
    }
    case 'enum':
      return constraint.values.includes(value) ? undefined : 'enum'
    case 'pathPrefix': {
      const segments = pathSegments(value)
      // Any `..` is refused outright: prefix matching alone cannot tell
      // `/workspace/../../etc/passwd` from a path inside the workspace.
      if (segments.includes('..')) return 'pathPrefix'
      const normalized = segments.join('/')
      const prefix = constraint.prefix
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return undefined
      return 'pathPrefix'
    }
    case 'urlScheme': {
      const match = URL_SCHEME.exec(value)
      if (match === null) return 'urlScheme'
      const scheme = (match[1] ?? '').toLowerCase()
      return constraint.schemes.includes(scheme) ? undefined : 'urlScheme'
    }
    case 'commandAllowlist': {
      // The first token is the command; anything that lets a shell run a second
      // one makes the allowlist meaningless, so it is refused before the lookup.
      if (SHELL_METACHARACTER.test(value)) return 'commandAllowlist'
      const first = value.trim().split(/\s+/u)[0] ?? ''
      if (first.length === 0) return 'commandAllowlist'
      if (first.includes('=')) return 'commandAllowlist'
      return constraint.commands.includes(first.toLowerCase()) ? undefined : 'commandAllowlist'
    }
  }
}

/**
 * Check one call's arguments against one compiled schema.
 *
 * A declared argument that the call does not carry is simply absent: the schema
 * constrains the shape of arguments that ARE passed, it does not make them
 * mandatory (that is the tool's own parameter schema).
 *
 * @param entry - the compiled schema (already matched to the tool name).
 * @param args - the call's parsed arguments.
 * @returns the first violation in declaration order, or `undefined`.
 */
export function checkArgSchema(entry: CompiledArgSchema, args: unknown): ArgSchemaViolation | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    // A call with no argument object cannot be shown to satisfy any bound that
    // names an argument: refuse rather than pass an unconstrainable shape.
    const first = entry.args[0]
    return first === undefined ? undefined : { schema: entry.name, argument: first.arg, constraint: 'type' }
  }
  const record = args as Record<string, unknown>
  for (const arg of entry.args) {
    if (!Object.prototype.hasOwnProperty.call(record, arg.arg)) continue
    const value = record[arg.arg]
    for (const constraint of arg.constraints) {
      const kind = checkConstraint(constraint, value)
      if (kind !== undefined) return { schema: entry.name, argument: arg.arg, constraint: kind }
    }
  }
  return undefined
}
