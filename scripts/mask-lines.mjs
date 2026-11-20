/**
 * Read-only helper: print source lines with every quoted string body masked, so a
 * human (or an agent whose own guard blocks credential-shaped text) can inspect a
 * region without reproducing it.
 *
 * Usage: node scripts/mask-lines.mjs <file> <firstLine> <lastLine>
 */
import { readFileSync } from 'node:fs'

const [, , file, from, to] = process.argv
if (file === undefined) {
  console.error('usage: node scripts/mask-lines.mjs <file> <firstLine> <lastLine>')
  process.exit(2)
}
const lines = readFileSync(file, 'utf8').split('\n')
const start = Math.max(1, Number(from ?? 1))
const end = Math.min(lines.length, Number(to ?? lines.length))

/** Replace the body of every '…' / "…" / `…` literal with its length. */
function mask(line) {
  let out = ''
  let quote = ''
  let body = 0
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote === '') {
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch
        body = 0
        out += ch
      } else {
        out += ch
      }
      continue
    }
    if (ch === '\\') {
      body += 1
      i += 1
      continue
    }
    if (ch === quote) {
      out += `<${body}>${quote}`
      quote = ''
      continue
    }
    body += 1
  }
  if (quote !== '') out += `<${body}>${quote}`
  return out
}

for (let index = start; index <= end; index += 1) {
  const line = lines[index - 1] ?? ''
  console.log(`${String(index).padStart(5)}: ${mask(line)}`)
}
