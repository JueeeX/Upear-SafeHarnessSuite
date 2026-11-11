/**
 * Dangerous-SQL inspection: the TypeScript port of
 * `src/safeharness/policies/sql_guard.py` (`inspect_sql`, read-only reference).
 *
 * The Python engine is a regex-shape classifier, not a parser:
 *
 * 1. pre-pass: strip C-style block comments (DOTALL), then `--...` / `#...` to
 *    end of line, then collapse whitespace to single spaces. This is what
 *    defeats `DEL/* * /ETE` and `DELETE -- x\nFROM` obfuscation.
 * 2. split the cleaned text on `;` and classify every non-empty segment against
 *    the statement shapes (write / ddl / admin / exec / read).
 * 3. dangerous = any segment carries a write/ddl/admin/exec kind **or** the
 *    cleaned text contains an exfiltration clause (`INTO OUTFILE` /
 *    `INTO DUMPFILE` / `LOAD_FILE(`).
 *
 * There is deliberately **no** "DELETE without WHERE" analysis: the Python
 * engine has none, so `delete from <ident>` is dangerous with or without a
 * WHERE clause (digest §2.3). `multi_statement` is reported but is not by itself
 * dangerous (`SELECT 1; SELECT 2` stays benign).
 *
 * Port hazards handled here:
 * - Python's `\b` is Unicode-aware, JS's is ASCII-only. Every keyword boundary is
 *   therefore written as an explicit lookaround over an approximation of
 *   Python's word class, so CJK-adjacent text matches like it does in Python.
 * - `re.DOTALL` becomes `[\s\S]`.
 * - the `select ... from` shape keeps Python's 600-character bound, the
 *   `grant|revoke` shape its 200-character bound (bounded quantifiers only).
 * - no policy regex carries the `g` flag (stateful `lastIndex`); bulk
 *   replacement is done with `split(re).join(' ')`, which needs no `g`.
 * - table extraction reuses `String.prototype.split`'s capturing-group behavior
 *   to collect every occurrence in one pass (also `g`-free).
 * @module
 */

/** Statement kinds the classifier can emit (mirrors Python's `_SQL_SHAPES`). */
export type SqlStatementKind = 'read' | 'write' | 'ddl' | 'admin' | 'exec'

/** Stable reason codes, identical to the Python strings (§2.2). */
export type SqlReasonCode = 'dangerous_sql_detected' | 'unauthorized_sql_table'

/** Outcome of inspecting one piece of text for dangerous SQL. */
export interface SqlVerdict {
  isSql: boolean
  dangerous: boolean
  statementKinds: readonly string[]
  tables: readonly string[]
  multiStatement: boolean
  reasonCode?: SqlReasonCode
  matchedTable?: string
}

/** Kinds that make a statement batch dangerous (§2.3). */
const DANGEROUS_KINDS: ReadonlySet<string> = new Set(['write', 'ddl', 'admin', 'exec'])

/**
 * Approximate Python word class for `\w`: Unicode letters, Unicode digits and
 * underscore. Python also counts `$` only where the source says `[\w$]`.
 */
const WORD = '[\\p{L}\\p{N}_]'
/** `[\w$]*` from the Python sources. */
const WORD_TAIL = '[\\p{L}\\p{N}_$]*'
/** Python `\b` before a keyword, without JS's ASCII-only word test. */
const BOUNDARY_START = `(?<!${WORD})`
/** Python `\b` after a keyword, without JS's ASCII-only word test. */
const BOUNDARY_END = `(?!${WORD})`
/** The optional identifier quote the Python shapes accept: backtick, `'`, `"`. */
const OPTIONAL_QUOTE = "[`'\"]?"
/** Python's shapes always start an identifier with `[A-Za-z_]` (ASCII on purpose). */
const IDENT_START = '[A-Za-z_]'

/**
 * Python's `\s` for `str` patterns: `[ \t\n\r\f\v]` plus the Unicode White_Space
 * property plus `\x1c`-`\x1f`. JS `\s` differs both ways (it adds `\ufeff` and
 * omits `\x1c`-`\x1f`/`\x85`), and `\x85` between keywords would otherwise make a
 * statement Python classifies as dangerous slip through. Spell the class out.
 */
const PY_SPACE =
  '[\\t\\n\\v\\f\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
/** One or more Python whitespace characters (Python `\s+`). */
const SPACE_PLUS = `${PY_SPACE}+`
/** Zero or more Python whitespace characters (Python `\s*`). */
const SPACE_STAR = `${PY_SPACE}*`

/**
 * Python compiles every shape with `re.IGNORECASE`; `u` is required for
 * `\p{...}` and is the closest JS analogue of Unicode-aware matching (§9.2).
 * Never `g`: these regexes are used with `test`/`exec`-free logic.
 */
const SHAPE_FLAGS = 'iu'

interface ShapeSpec {
  readonly kind: SqlStatementKind
  readonly source: string
}

/**
 * The statement shapes, transcribed from `_SQL_SHAPES` in `sql_guard.py:51-102`.
 * Order is significant: kinds are appended in this order, matching Python.
 */
const SHAPE_SPECS: readonly ShapeSpec[] = [
  { kind: 'write', source: `${BOUNDARY_START}delete${SPACE_PLUS}from${SPACE_PLUS}${OPTIONAL_QUOTE}${IDENT_START}` },
  { kind: 'write', source: `${BOUNDARY_START}insert${SPACE_PLUS}into${SPACE_PLUS}${OPTIONAL_QUOTE}${IDENT_START}` },
  {
    kind: 'write',
    source:
      `${BOUNDARY_START}update${SPACE_PLUS}${OPTIONAL_QUOTE}${IDENT_START}${WORD_TAIL}` +
      `(?:${SPACE_STAR}\\.${SPACE_STAR}${OPTIONAL_QUOTE}${IDENT_START}${WORD_TAIL})*${SPACE_PLUS}set${BOUNDARY_END}`,
  },
  {
    kind: 'write',
    source: `${BOUNDARY_START}(?:merge${SPACE_PLUS}into|replace${SPACE_PLUS}into)${SPACE_PLUS}${OPTIONAL_QUOTE}${IDENT_START}`,
  },
  {
    kind: 'ddl',
    source: `${BOUNDARY_START}drop${SPACE_PLUS}(?:table|index|view|database|schema|procedure|function|trigger)${BOUNDARY_END}`,
  },
  {
    kind: 'ddl',
    source: `${BOUNDARY_START}truncate${SPACE_PLUS}(?:table${SPACE_PLUS})?${OPTIONAL_QUOTE}${IDENT_START}`,
  },
  { kind: 'ddl', source: `${BOUNDARY_START}alter${SPACE_PLUS}table${BOUNDARY_END}` },
  {
    kind: 'ddl',
    source: `${BOUNDARY_START}create${SPACE_PLUS}(?:table|index|view|database|schema|procedure|function|trigger)${BOUNDARY_END}`,
  },
  { kind: 'ddl', source: `${BOUNDARY_START}rename${SPACE_PLUS}table${BOUNDARY_END}` },
  {
    kind: 'admin',
    source: `${BOUNDARY_START}(?:grant|revoke)${BOUNDARY_END}[^;\\n]{0,200}${BOUNDARY_START}on${BOUNDARY_END}`,
  },
  {
    kind: 'exec',
    source:
      `${BOUNDARY_START}(?:call|exec|execute)${SPACE_PLUS}${OPTIONAL_QUOTE}${IDENT_START}${WORD_TAIL}${SPACE_STAR}\\(` +
      `|${BOUNDARY_START}exec(?:ute)?${SPACE_PLUS}(?:sp_|xp_|fn_)${WORD_TAIL}`,
  },
  {
    kind: 'read',
    // Python: `\bselect\b[^;]{0,600}?\bfrom\s+[`'"]?[A-Za-z_]` with re.DOTALL.
    source: `${BOUNDARY_START}select${BOUNDARY_END}[^;]{0,600}?${BOUNDARY_START}from${SPACE_PLUS}${OPTIONAL_QUOTE}${IDENT_START}`,
  },
  {
    kind: 'read',
    source: `${BOUNDARY_START}(?:show|describe|explain)${SPACE_PLUS}(?:tables|databases|schemas|create${SPACE_PLUS}table)${BOUNDARY_END}`,
  },
]

/** Compiled shapes: pre-compiled once at module load, immutable thereafter. */
const SHAPES: readonly { readonly kind: SqlStatementKind; readonly regex: RegExp }[] =
  SHAPE_SPECS.map((spec) => ({ kind: spec.kind, regex: new RegExp(spec.source, SHAPE_FLAGS) }))

/**
 * Table extraction, from `_TABLE_RE` (`sql_guard.py:103-106`). Exactly one
 * capturing group: `String.prototype.split` splices that capture into its
 * output, which lets {@link extractTables} walk every match in one pass without
 * a global (`g`) regex.
 */
const TABLE_RE = new RegExp(
  `${BOUNDARY_START}(?:from|join|into|update|table)${SPACE_PLUS}${OPTIONAL_QUOTE}` +
    `(${IDENT_START}${WORD_TAIL}(?:\\.${IDENT_START}${WORD_TAIL})*)`,
  SHAPE_FLAGS,
)

/** Exfiltration clause, `_EXFIL_RE` (`sql_guard.py:46-48`), applied to cleaned text. */
const EXFIL_RE = new RegExp(
  `${BOUNDARY_START}into${SPACE_PLUS}(?:outfile|dumpfile)${BOUNDARY_END}|${BOUNDARY_START}load_file${SPACE_STAR}\\(`,
  SHAPE_FLAGS,
)

/** `_COMMENT_BLOCK_RE` (`sql_guard.py:44`), DOTALL via `[\s\S]`, lazy. */
const COMMENT_BLOCK_RE = /\/\*[\s\S]*?\*\//
/** `_COMMENT_LINE_RE` (`sql_guard.py:43`): `--...` or `#...` to end of line. */
const COMMENT_LINE_RE = /--[^\n]*|#[^\n]*/
/** Whitespace collapse (`sql_guard.py:128`), with Python's exact `\s` class. */
const WHITESPACE_RE = new RegExp(SPACE_PLUS)

/** Characters Python's `str.strip("`'\"")` removes from both ends. */
const QUOTE_CHARS: ReadonlySet<string> = new Set(['`', "'", '"'])

/** Replace every non-overlapping match of `re` with a single space, without `g`. */
function replaceMatchesWithSpace(re: RegExp, text: string): string {
  // `split` honours every match of a non-global regex and never touches the
  // regex's `lastIndex`; joining with a space is exactly `re.sub(re, " ", text)`
  // for these match shapes. None of the patterns can match the empty string.
  return text.split(re).join(' ')
}

/**
 * Comment pre-pass, in the Python order: block comments first, then line
 * comments, then whitespace collapse (§2.3). Order matters: `--` inside a block
 * comment is already gone, and `#` inside a line comment cannot re-open anything.
 */
function stripComments(text: string): string {
  let cleaned = replaceMatchesWithSpace(COMMENT_BLOCK_RE, text)
  cleaned = replaceMatchesWithSpace(COMMENT_LINE_RE, cleaned)
  return replaceMatchesWithSpace(WHITESPACE_RE, cleaned)
}

/** `_normalise_table`: strip quoting characters from both ends, then lowercase. */
function normaliseTable(name: string): string {
  let start = 0
  let end = name.length
  while (start < end) {
    const first = name[start]
    if (first === undefined || !QUOTE_CHARS.has(first)) break
    start += 1
  }
  while (end > start) {
    const last = name[end - 1]
    if (last === undefined || !QUOTE_CHARS.has(last)) break
    end -= 1
  }
  return name.slice(start, end).toLowerCase()
}

/** Drop the schema prefix: `db.schema.table` -> `table` (Python `rsplit(".", 1)`). */
function bareTableName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1) : name
}

/** `_table_matches` (`sql_guard.py:135-142`): full name or bare name equality. */
function tableMatches(table: string, allowed: readonly string[]): boolean {
  const normalised = normaliseTable(table)
  const bare = bareTableName(normalised)
  for (const entry of allowed) {
    const allowedName = normaliseTable(entry)
    if (normalised === allowedName || bare === bareTableName(allowedName)) return true
  }
  return false
}

/**
 * All table references in one segment, `_TABLE_RE.findall`.
 *
 * `split` with exactly one capturing group yields
 * `[prefix, capture1, between1, capture2, ...]`, so the captures live at the odd
 * indices. This is spec'd behavior and costs one linear pass (no `g` regex).
 */
function extractTables(segment: string): string[] {
  const parts = segment.split(TABLE_RE)
  const tables: string[] = []
  for (let index = 1; index < parts.length; index += 2) {
    const captured = parts[index]
    if (typeof captured === 'string' && captured.length > 0) tables.push(captured)
  }
  return tables
}

/** Deduplicate preserving first-seen order (Python `dict.fromkeys`). */
function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

/** An all-false verdict, fresh each call (Python returns a new frozen dataclass). */
function emptyVerdict(): SqlVerdict {
  return {
    isSql: false,
    dangerous: false,
    statementKinds: [],
    tables: [],
    multiStatement: false,
    reasonCode: undefined,
    matchedTable: undefined,
  }
}

/**
 * Classify text into an SQL verdict.
 *
 * `opts.allowedTables === undefined` disables table checks entirely (Python
 * `allowed_tables=None`). When an array is given — including an empty one —
 * every extracted table reference must match an allowlist entry by full or bare
 * (schema-stripped) name, otherwise the verdict carries
 * `reasonCode: 'unauthorized_sql_table'`. `dangerous` always wins over the
 * allowlist check, exactly like Python.
 *
 * @param text - text to inspect (user input, tool argument value, ...).
 * @param opts - optional table allowlist.
 * @returns the verdict; `statementKinds` may contain duplicates (Python parity).
 */
export function inspectSql(
  text: string,
  opts?: { allowedTables?: readonly string[] },
): SqlVerdict {
  if (typeof text !== 'string' || text.trim() === '') return emptyVerdict()

  const cleaned = stripComments(text)
  const segments = cleaned.split(';')

  const kinds: string[] = []
  const tables: string[] = []
  let matchedShapes = 0

  for (const segment of segments) {
    if (segment.trim() === '') continue
    let segmentMatched = false
    for (const shape of SHAPES) {
      if (shape.regex.test(segment)) {
        kinds.push(shape.kind)
        segmentMatched = true
      }
    }
    if (segmentMatched) matchedShapes += 1
    for (const table of extractTables(segment)) tables.push(normaliseTable(table))
  }

  const multiStatement = matchedShapes >= 2
  const dangerous =
    kinds.some((kind) => DANGEROUS_KINDS.has(kind)) || EXFIL_RE.test(cleaned)

  let reasonCode: SqlReasonCode | undefined
  let matchedTable: string | undefined
  if (dangerous) {
    reasonCode = 'dangerous_sql_detected'
  } else {
    const allowed = opts?.allowedTables
    if (allowed !== undefined) {
      for (const table of tables) {
        if (!tableMatches(table, allowed)) {
          reasonCode = 'unauthorized_sql_table'
          matchedTable = table
          break
        }
      }
    }
  }

  return {
    isSql: kinds.length > 0,
    dangerous,
    statementKinds: kinds,
    tables: dedupe(tables),
    multiStatement,
    reasonCode,
    matchedTable,
  }
}
