#!/usr/bin/env node
/**
 * session-dump — read a DSH session log (`.jsonl.zstd`) without the host UI.
 *
 * A DSH session file is a sequence of concatenated zstd frames (one per append), so
 * `zlib.zstdDecompressSync()` alone only returns the first line. This script splits
 * on the zstd magic and decompresses every frame it can, which is enough to inspect
 * what a headless run actually did (tool results, model text, denials).
 *
 * LOCAL DIAGNOSTIC ONLY: the session log carries real conversation content, so its
 * output must never be committed, pasted into an issue or attached to a report —
 * the audit ledger (hashes and lengths only) is the evidence surface.
 *
 * CLI:
 *   node scripts/session-dump.mjs <session.v4.jsonl.zstd> [--type <type>] [--grep <text>] [--limit <n>]
 *
 * @module session-dump
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** Bytes of the zstd frame magic (little-endian 0xFD2FB528). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress a concatenated-frame zstd file: split at every magic occurrence and
 * decompress each segment, joining whatever succeeds (a false-positive magic inside
 * one frame's payload simply fails to decompress and is folded into the next slice).
 *
 * @param {Buffer} buffer - whole file contents.
 * @returns {string} the decoded UTF-8 text.
 */
export function decodeSessionLog(buffer) {
  const starts = []
  let index = 0
  while ((index = buffer.indexOf(ZSTD_MAGIC, index)) >= 0) {
    starts.push(index)
    index += ZSTD_MAGIC.length
  }
  if (starts.length === 0) return ''
  let text = ''
  let from = 0
  for (let frame = 1; frame <= starts.length; frame += 1) {
    const end = frame < starts.length ? starts[frame] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(from, end)).toString('utf8')
      from = end
    } catch {
      // This magic was inside the previous frame's payload; keep the slice growing.
    }
  }
  return text
}

/** Parse arguments into a tiny options object. */
function parseArgs(argv) {
  const options = { file: undefined, type: undefined, grep: undefined, limit: 0 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--type') options.type = argv[++index]
    else if (arg === '--grep') options.grep = argv[++index]
    else if (arg === '--limit') options.limit = Number.parseInt(argv[++index] ?? '0', 10) || 0
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write('usage: node scripts/session-dump.mjs <session.v4.jsonl.zstd> [--type <t>] [--grep <s>] [--limit <n>]\n')
      process.exit(0)
    } else options.file = arg
  }
  if (options.file === undefined) {
    process.stderr.write('usage: node scripts/session-dump.mjs <session.v4.jsonl.zstd> [--type <t>] [--grep <s>] [--limit <n>]\n')
    process.exit(2)
  }
  return options
}

/**
 * One compact line per event: type, seq, and the parts a debugging operator needs
 * (tool name, tool result text, assistant text). Content stays on stdout only.
 */
function summarize(event) {
  const data = event.data ?? {}
  const bits = [`#${event.seq}`, event.type]
  const message = data.message ?? data.result?.message
  if (data.name !== undefined) bits.push(`name=${data.name}`)
  if (data.callId !== undefined) bits.push(`call=${data.callId}`)
  const text = textOf(data)
  if (text.length > 0) bits.push(`text=${JSON.stringify(text.length > 400 ? `${text.slice(0, 400)}…` : text)}`)
  if (message?.isError === true || data.isError === true) bits.push('isError=true')
  return bits.join(' ')
}

/** Best-effort text of a tool result / assistant message, for one log line. */
function textOf(data) {
  const content = data.result?.content ?? data.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const text = decodeSessionLog(readFileSync(options.file))
  let shown = 0
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (options.type !== undefined && event.type !== options.type) continue
    const summary = summarize(event)
    if (options.grep !== undefined && !summary.includes(options.grep) && !line.includes(options.grep)) continue
    process.stdout.write(`${summary}\n`)
    shown += 1
    if (options.limit > 0 && shown >= options.limit) break
  }
}

main()
