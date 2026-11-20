/**
 * Read-only diagnostic: locate `credential_assignment` matches in a source tree and
 * describe each match by SHAPE ONLY (line, key suffix, separator, quote style, value
 * length, character classes). The matched text is never printed, copied or hashed
 * into the report — the point is to tell a false positive from a real leak without
 * reproducing the value.
 *
 * The pattern is EXTRACTED from `src/engine/tool.ts` rather than copied here: a copy
 * went stale within one commit the first time this script was written, and a
 * diagnostic that lies about which regex it ran is worse than no diagnostic.
 *
 * Usage: node scripts/credential-shapes.mjs <file...>
 */
import { readFileSync } from 'node:fs'

const SOURCE = new URL('../src/engine/tool.ts', import.meta.url)

/**
 * Pull the `credential_assignment` regex source out of the engine module.
 *
 * The pattern is authored as a `/.../i` literal on the line(s) after its `id:`
 * marker; this reads that literal textually so there is exactly one definition of
 * the rule in the repository.
 */
function loadAssignmentPattern() {
  const text = readFileSync(SOURCE, 'utf8')
  const marker = text.indexOf("id: 'credential_assignment'")
  if (marker < 0) throw new Error('credential_assignment not found in src/engine/tool.ts')
  const open = text.indexOf('/', marker)
  const close = text.lastIndexOf('/i,')
  if (open < 0 || close < open) throw new Error('cannot delimit the credential_assignment literal')
  const source = text.slice(open + 1, close)
  return new RegExp(source, 'i')
}

/** Coarse shape tag for one string: no characters survive except class letters. */
function shapeOf(value) {
  const classes = new Set()
  for (const ch of value) {
    if (ch >= '0' && ch <= '9') classes.add('d')
    else if (ch >= 'a' && ch <= 'z') classes.add('L')
    else if (ch >= 'A' && ch <= 'Z') classes.add('U')
    else classes.add(`p:'${ch}'`)
  }
  return `${[...classes].sort().join('')} hex=${/^[0-9a-fA-F]+$/.test(value)}`
}

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/credential-shapes.mjs <file...>')
  process.exit(2)
}

const pattern = loadAssignmentPattern()
const keyPattern =
  /[A-Za-z0-9_$-]{0,32}(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)/i

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  const starts = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const lineOf = (index) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid] <= index) low = mid
      else high = mid - 1
    }
    return low + 1
  }

  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  const found = []
  for (let m = global.exec(text); m !== null; m = global.exec(text)) {
    const whole = m[0]
    const key = keyPattern.exec(whole)?.[0] ?? ''
    const sepIndex = whole.search(/[=:]/)
    const rawValue = sepIndex < 0 ? whole : whole.slice(sepIndex + 1).trim()
    const quoted = /^["']/.test(rawValue)
    found.push({
      line: lineOf(m.index),
      keyTail: key.toLowerCase(),
      sep: sepIndex < 0 ? '?' : whole[sepIndex],
      quoted,
      valueLen: quoted ? rawValue.length - 2 : rawValue.length,
      shape: shapeOf(quoted ? rawValue.slice(1, -1) : rawValue),
    })
    if (found.length > 50) break
  }

  if (found.length === 0) {
    console.log(`${file}: no credential_assignment match`)
    continue
  }
  for (const hit of found) {
    console.log(
      `${file}:${hit.line} key~${hit.keyTail} sep=${hit.sep} quoted=${hit.quoted} len=${hit.valueLen} ${hit.shape}`,
    )
  }
}
