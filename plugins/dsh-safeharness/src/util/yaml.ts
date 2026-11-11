/**
 * A strict, dependency-free YAML **subset** parser, sized for the rule files.
 *
 * WHY a subset and not a real parser: the plugin runtime must stay dependency
 * free (node builtins only, plan §6.1), and a rule loader is a security boundary.
 * Every construct we do not implement is therefore a hard error instead of a
 * best-effort guess — a refused rule file is a loud, safe failure, while a
 * slightly-mis-parsed one silently changes what the engine blocks.
 *
 * Supported (exactly what `rules/*.yaml` needs):
 *   - `# comments` (whole-line and trailing, recognised outside quotes only);
 *   - block mappings and nested block mappings (`key: value`, `key:` + indented block);
 *   - block sequences (`- item`), including sequences of mappings and a block
 *     sequence placed at the *same* indentation as its parent key (legal YAML);
 *   - single-quoted scalars (`''` escapes a quote, backslashes stay literal) and
 *     double-quoted scalars (escapes: `\" \\ \n \t \r`);
 *   - plain scalars (strings, integers, floats, `true`/`false`, `null`/`~`);
 *   - the empty flow sequence `[]` (used for `first_tags: []`).
 *
 * Rejected with a descriptive error (never silently mis-parsed):
 *   flow mappings `{}`, non-empty flow sequences `[a, b]`, anchors/aliases
 *   (`&x`, `*x`), tags (`!!js/x`, `!custom`), document markers (`---`, `...`),
 *   YAML directives (`%YAML`), block scalars (`|`, `>`), tabs in indentation,
 *   duplicate mapping keys, multi-line (unterminated) quoted scalars, and any
 *   indentation the block grammar cannot explain.
 *
 * @module
 */

/** One significant (comment-stripped, non-blank) line with its indentation. */
interface YamlLine {
  readonly indent: number
  readonly text: string
  readonly lineNo: number
}

/** A parsed block: the value plus the index of the first unconsumed line. */
interface ParseBlockResult {
  readonly value: unknown
  readonly next: number
}

/** A quoted scalar's decoded value and the index just past its closing quote. */
interface QuotedScalar {
  readonly value: string
  readonly end: number
}

/** The remainder of a `- …` sequence indicator plus the column its content starts at. */
interface DashItem {
  readonly rest: string
  readonly keyColumn: number
}

/** A mapping entry that lives on the same line as its sequence dash. */
interface InlinedMappingEntry {
  readonly text: string
  readonly lineNo: number
}

/** A plain mapping key: conservative ASCII set; anything else must be quoted. */
const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/** Document markers: a whole line, never a value (we support one document per file). */
const DOCUMENT_MARKER = /^(?:---|\.\.\.)(?:\s|$)/

/** Decimal integer / float forms we convert to `number`; everything else stays a string. */
const INTEGER = /^[-+]?(?:0|[1-9][0-9]*)$/
const FLOAT = /^[-+]?(?:0|[1-9][0-9]*)\.[0-9]+$/

/**
 * Parse every YAML document in `text`.
 *
 * The grammar above is single-document (multi-document streams are rejected), so
 * this returns `[]` for an empty/comment-only file and a one-element array
 * otherwise. It exists as a list-returning API because the rule loader consumes
 * documents positionally and future formats may allow more than one.
 *
 * @param text - raw file content; a UTF-8 BOM is tolerated and stripped.
 * @param origin - file path or label used in every error message.
 * @throws Error with `origin:line: YAML: …` for any unsupported construct.
 */
export function parseYamlDocuments(text: string, origin: string): unknown[] {
  const lines = toLines(text, origin)
  const first = lines[0]
  if (first === undefined) return []
  if (first.indent !== 0) {
    throw fail(origin, first.lineNo, 'the document root must start at column 0')
  }
  const root = parseBlock(lines, 0, 0, origin)
  const trailing = lines[root.next]
  if (trailing !== undefined) {
    throw fail(
      origin,
      trailing.lineNo,
      'unexpected content after the document root value (only comments may follow the root node)',
    )
  }
  return [root.value]
}

/**
 * Parse a single-document YAML file.
 *
 * Empty input yields `null` (an empty rule file is legal and contributes nothing).
 *
 * @param text - raw file content.
 * @param origin - file path or label used in every error message.
 * @throws Error with `origin:line: YAML: …` for any unsupported construct.
 */
export function parseYaml(text: string, origin: string): unknown {
  const documents = parseYamlDocuments(text, origin)
  return documents[0] ?? null
}

// ---------------------------------------------------------------------------
// Line scanning
// ---------------------------------------------------------------------------

/** Split into significant lines, validating indentation and stripping comments. */
function toLines(text: string, origin: string): YamlLine[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rawLines = body.split(/\r\n|\r|\n/)
  const lines: YamlLine[] = []
  for (let index = 0; index < rawLines.length; index += 1) {
    const lineNo = index + 1
    const raw = rawLines[index] ?? ''
    if (raw.startsWith('%')) {
      throw fail(origin, lineNo, 'YAML directives (%YAML, %TAG) are not supported')
    }
    let indent = 0
    while (indent < raw.length && raw.charCodeAt(indent) === 0x20) indent += 1
    const content = raw.slice(indent)
    // A tab (or NBSP) where indentation should be is a classic "looks nested,
    // is not nested" trap: reject instead of guessing at the column.
    if (content.startsWith('\t') || content.startsWith('\u00a0')) {
      throw fail(origin, lineNo, 'tabs cannot be used for indentation')
    }
    const significant = trimEnd(stripComment(content, origin, lineNo))
    if (significant === '') continue
    if (DOCUMENT_MARKER.test(significant)) {
      throw fail(
        origin,
        lineNo,
        "YAML document markers ('---' / '...') are not supported: one document per file",
      )
    }
    lines.push({ indent, text: significant, lineNo })
  }
  return lines
}

/**
 * Remove a trailing comment.
 *
 * A `#` only starts a comment at the start of the line or after whitespace, and
 * never inside a quoted scalar — that is exactly the YAML rule, and getting it
 * wrong would truncate patterns that contain `#`. A quote opens a scalar only at
 * a token boundary (start of line or after whitespace) so `don't` stays plain.
 */
function stripComment(text: string, origin: string, lineNo: number): string {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (quote === "'") {
      if (char === "'") {
        if (text.charAt(index + 1) === "'") {
          index += 1
          continue
        }
        quote = null
      }
      continue
    }
    if (quote === '"') {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if (char === '#' && (index === 0 || isBlank(text.charAt(index - 1)))) {
      return text.slice(0, index)
    }
    if ((char === '"' || char === "'") && (index === 0 || isBlank(text.charAt(index - 1)))) {
      quote = char
    }
  }
  // Unterminated quotes are refused earlier by the scalar parser; the only way to
  // land here is a quoted scalar that swallowed the rest of the line.
  if (quote !== null) {
    throw fail(origin, lineNo, 'unterminated quoted scalar (multi-line quoted scalars are not supported)')
  }
  return text
}

// ---------------------------------------------------------------------------
// Block grammar
// ---------------------------------------------------------------------------

/** Parse the block that starts at `start`, whose lines are indented by `indent`. */
function parseBlock(
  lines: readonly YamlLine[],
  start: number,
  indent: number,
  origin: string,
): ParseBlockResult {
  const line = lines[start]
  if (line === undefined) return { value: null, next: start }
  if (line.indent !== indent) {
    throw fail(origin, line.lineNo, `expected indentation of ${indent} spaces, found ${line.indent}`)
  }
  if (dashContent(line.text) !== null) return parseSequence(lines, start, indent, origin)
  if (findKeySeparator(line.text) >= 0) {
    return parseMapping(lines, start, indent, undefined, origin)
  }
  return { value: parseScalar(line.text, origin, line.lineNo), next: start + 1 }
}

/** Parse consecutive `- item` lines at exactly `indent`. */
function parseSequence(
  lines: readonly YamlLine[],
  start: number,
  indent: number,
  origin: string,
): ParseBlockResult {
  const items: unknown[] = []
  let index = start
  for (;;) {
    const line = lines[index]
    if (line === undefined) break
    if (line.indent < indent) break
    if (line.indent > indent) {
      throw fail(origin, line.lineNo, `unexpected indentation: expected ${indent} spaces, found ${line.indent}`)
    }
    const dash = dashContent(line.text)
    // A mapping entry at the sequence's own indent means the sequence is over
    // (`key:` with a same-indent block sequence returns control to the mapping).
    if (dash === null) break
    index += 1
    if (dash.rest === '') {
      const nested = lines[index]
      if (nested === undefined || nested.indent <= indent) {
        items.push(null)
        continue
      }
      const child = parseBlock(lines, index, nested.indent, origin)
      items.push(child.value)
      index = child.next
      continue
    }
    if (dashContent(dash.rest) !== null) {
      throw fail(origin, line.lineNo, 'nested inline sequences ("- - x") are not supported')
    }
    if (findKeySeparator(dash.rest) >= 0) {
      // `- name: x` opens a mapping whose first entry is inline; the remaining
      // entries must line up with that first key (column-indent semantics).
      const child = parseMapping(
        lines,
        index,
        indent + dash.keyColumn,
        { text: dash.rest, lineNo: line.lineNo },
        origin,
      )
      items.push(child.value)
      index = child.next
      continue
    }
    items.push(parseScalar(dash.rest, origin, line.lineNo))
    const following = lines[index]
    if (following !== undefined && following.indent > indent) {
      throw fail(
        origin,
        following.lineNo,
        'unexpected indentation after a scalar sequence item (multi-line plain scalars are not supported)',
      )
    }
  }
  return { value: items, next: index }
}

/**
 * Parse `key: value` entries. When `inlinedFirst` is given, that entry (from a
 * `- key: value` line) is consumed before `lines[start]`; `indent` is the column
 * every key of this mapping must sit at.
 */
function parseMapping(
  lines: readonly YamlLine[],
  start: number,
  indent: number,
  inlinedFirst: InlinedMappingEntry | undefined,
  origin: string,
): ParseBlockResult {
  const value: Record<string, unknown> = {}
  let index = start
  let inlined = inlinedFirst
  for (;;) {
    let text: string
    let lineNo: number
    if (inlined !== undefined) {
      text = inlined.text
      lineNo = inlined.lineNo
      inlined = undefined
    } else {
      const line = lines[index]
      if (line === undefined) break
      if (line.indent < indent) break
      if (line.indent > indent) {
        throw fail(origin, line.lineNo, `unexpected indentation: expected ${indent} spaces, found ${line.indent}`)
      }
      if (dashContent(line.text) !== null) break
      text = line.text
      lineNo = line.lineNo
      index += 1
    }
    const separator = findKeySeparator(text)
    if (separator < 0) {
      throw fail(
        origin,
        lineNo,
        "expected a 'key: value' mapping entry (a key and its value must be separated by ': ' with a space, not a tab)",
      )
    }
    const key = parseKey(text.slice(0, separator), origin, lineNo)
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      throw fail(origin, lineNo, `duplicate mapping key '${key}' (the later value would silently win)`)
    }
    const rest = trimStart(text.slice(separator + 1))
    if (rest !== '') {
      value[key] = parseScalar(rest, origin, lineNo)
      continue
    }
    // Empty value: either an explicit null, a nested block, or a block sequence
    // at the parent key's own indentation (legal YAML, common in hand-written files).
    const nextLine = lines[index]
    if (nextLine === undefined || nextLine.indent < indent) {
      value[key] = null
      continue
    }
    if (nextLine.indent === indent) {
      if (dashContent(nextLine.text) === null) {
        value[key] = null
        continue
      }
      const child = parseSequence(lines, index, indent, origin)
      value[key] = child.value
      index = child.next
      continue
    }
    const child = parseBlock(lines, index, nextLine.indent, origin)
    value[key] = child.value
    index = child.next
  }
  return { value, next: index }
}

/** Recognise a `- …` sequence indicator; return its content and content column. */
function dashContent(text: string): DashItem | null {
  if (text.charAt(0) !== '-') return null
  if (text.length === 1) return { rest: '', keyColumn: 1 }
  if (text.charAt(1) !== ' ') return null
  let offset = 1
  while (offset < text.length && text.charAt(offset) === ' ') offset += 1
  return { rest: text.slice(offset), keyColumn: offset }
}

/**
 * Index of the `:` that separates a mapping key from its value, or -1.
 *
 * A block-mapping separator must be followed by a space or end the line, and a
 * colon inside a quoted scalar is not a separator — getting this wrong would
 * split `pattern: 'a: b'` in the middle of the pattern.
 */
function findKeySeparator(text: string): number {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (quote === "'") {
      if (char === "'") {
        if (text.charAt(index + 1) === "'") {
          index += 1
          continue
        }
        quote = null
      }
      continue
    }
    if (quote === '"') {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === '"') quote = null
      continue
    }
    if ((char === '"' || char === "'") && (index === 0 || isBlank(text.charAt(index - 1)))) {
      quote = char
      continue
    }
    if (char === ':' && (index + 1 === text.length || text.charAt(index + 1) === ' ')) {
      return index
    }
  }
  return -1
}

/** Decode a mapping key: quoted scalar, or a conservative plain key. */
function parseKey(text: string, origin: string, lineNo: number): string {
  const raw = trimEnd(trimStart(text))
  const first = raw.charAt(0)
  if (raw === '') throw fail(origin, lineNo, 'mapping key must not be empty')
  if (first === '"') {
    const parsed = parseDoubleQuoted(raw, origin, lineNo)
    assertNoTrailing(raw, parsed.end, origin, lineNo)
    return parsed.value
  }
  if (first === "'") {
    const parsed = parseSingleQuoted(raw, origin, lineNo)
    assertNoTrailing(raw, parsed.end, origin, lineNo)
    return parsed.value
  }
  if (!PLAIN_KEY.test(raw)) {
    throw fail(
      origin,
      lineNo,
      `unsupported plain mapping key '${raw}': use [A-Za-z0-9_.-] or quote the key`,
    )
  }
  return raw
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Decode one scalar value (quoted, `[]`, or plain). */
function parseScalar(text: string, origin: string, lineNo: number): unknown {
  const first = text.charAt(0)
  if (text === '[]') return []
  if (first === '[') {
    throw fail(origin, lineNo, 'flow sequences with content ("[a, b]") are not supported; use a block sequence or exactly "[]"')
  }
  if (first === '{') throw fail(origin, lineNo, 'flow mappings ("{}") are not supported; use a block mapping')
  if (first === '&' || first === '*') {
    throw fail(origin, lineNo, 'YAML anchors and aliases ("&name" / "*name") are not supported')
  }
  if (first === '!') throw fail(origin, lineNo, 'YAML tags ("!!str", "!js/…") are not supported')
  if (first === '|' || first === '>') {
    throw fail(origin, lineNo, 'block scalars ("|", ">") are not supported; use a quoted single-line scalar')
  }
  if (first === '"') {
    const parsed = parseDoubleQuoted(text, origin, lineNo)
    assertNoTrailing(text, parsed.end, origin, lineNo)
    return parsed.value
  }
  if (first === "'") {
    const parsed = parseSingleQuoted(text, origin, lineNo)
    assertNoTrailing(text, parsed.end, origin, lineNo)
    return parsed.value
  }
  return parsePlainScalar(text, origin, lineNo)
}

/**
 * Plain (unquoted) scalar. Kept deliberately narrow: anything whose YAML meaning
 * is contextual (a leading indicator, an embedded `": "`) is refused so that a
 * regex is never silently reinterpreted.
 */
function parsePlainScalar(text: string, origin: string, lineNo: number): unknown {
  if (text.includes('\t')) {
    throw fail(origin, lineNo, 'tab characters are not allowed in a plain scalar; quote the value')
  }
  if (text.includes(': ')) {
    throw fail(origin, lineNo, 'plain scalar contains ": " (ambiguous with a nested mapping); quote the value')
  }
  if (text.endsWith(':')) {
    throw fail(origin, lineNo, 'plain scalar ends with ":"; quote the value')
  }
  const first = text.charAt(0)
  if (first === '-' && (text.length === 1 || text.charAt(1) === ' ')) {
    throw fail(origin, lineNo, 'a sequence indicator ("- ") cannot start a scalar value; quote the value')
  }
  if (first === '?' || first === ':' || first === '%' || first === '@' || first === '`') {
    throw fail(origin, lineNo, `a plain scalar cannot start with '${first}'; quote the value`)
  }
  switch (text) {
    case 'null':
    case 'Null':
    case 'NULL':
    case '~':
      return null
    case 'true':
    case 'True':
    case 'TRUE':
      return true
    case 'false':
    case 'False':
    case 'FALSE':
      return false
    default:
      break
  }
  if (INTEGER.test(text)) return Number(text)
  if (FLOAT.test(text)) return Number(text)
  return text
}

/** Decode a `"…"` scalar; the only escapes we accept are the four the rules need. */
function parseDoubleQuoted(text: string, origin: string, lineNo: number): QuotedScalar {
  let value = ''
  let index = 1
  while (index < text.length) {
    const char = text.charAt(index)
    if (char === '"') return { value, end: index + 1 }
    if (char === '\\') {
      if (index + 1 >= text.length) break
      const escape = text.charAt(index + 1)
      index += 2
      switch (escape) {
        case '"':
          value += '"'
          break
        case '\\':
          value += '\\'
          break
        case 'n':
          value += '\n'
          break
        case 't':
          value += '\t'
          break
        case 'r':
          value += '\r'
          break
        default:
          // Notably `\uXXXX`: real YAML would decode it, which would silently
          // rewrite a regex. Single-quoted scalars keep backslashes verbatim.
          throw fail(
            origin,
            lineNo,
            `unsupported escape '\\${escape}' in a double-quoted scalar (supported: \\" \\\\ \\n \\t \\r; use single quotes to keep a backslash such as \\uXXXX verbatim)`,
          )
      }
      continue
    }
    value += char
    index += 1
  }
  throw fail(origin, lineNo, 'unterminated double-quoted scalar (multi-line quoted scalars are not supported)')
}

/** Decode a `'…'` scalar: only `''` is special, every backslash stays literal. */
function parseSingleQuoted(text: string, origin: string, lineNo: number): QuotedScalar {
  let value = ''
  let index = 1
  while (index < text.length) {
    const char = text.charAt(index)
    if (char === "'") {
      if (text.charAt(index + 1) === "'") {
        value += "'"
        index += 2
        continue
      }
      return { value, end: index + 1 }
    }
    value += char
    index += 1
  }
  throw fail(origin, lineNo, 'unterminated single-quoted scalar (multi-line quoted scalars are not supported)')
}

/** A quoted scalar must be the whole value (no trailing junk after the quote). */
function assertNoTrailing(text: string, end: number, origin: string, lineNo: number): void {
  if (trimStart(text.slice(end)) !== '') {
    throw fail(origin, lineNo, 'unexpected characters after a quoted scalar; quote the whole value')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the one error shape every function throws: `origin:line: YAML: message`. */
function fail(origin: string, lineNo: number, message: string): Error {
  return new Error(`${origin}:${lineNo}: YAML: ${message}`)
}

/** Space or tab: the two characters that count as separation inside a line. */
function isBlank(char: string): boolean {
  return char === ' ' || char === '\t'
}

function trimStart(text: string): string {
  return text.replace(/^[ \t]+/, '')
}

function trimEnd(text: string): string {
  return text.replace(/[ \t]+$/, '')
}
