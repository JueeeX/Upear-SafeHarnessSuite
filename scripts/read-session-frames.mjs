/**
 * Read every zstd frame of a DSH session log (`session.v4.jsonl.zstd`).
 *
 * The file is a sequence of independently compressed frames, so a single
 * `zstdDecompressSync` stops after the first one and shows just the header. This
 * walks the frames so the event stream (and therefore any `sandbox/mode` event)
 * is actually visible.
 *
 * Usage: node scripts/read-session-frames.mjs <session-dir-or-file> [grep]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** Split one buffer into concatenated zstd frames by scanning for the magic. */
function frames(buffer) {
  const offsets = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(index) === ZSTD_MAGIC) offsets.push(index)
  }
  const out = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      out.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // A false-positive magic match inside compressed data: skip it.
    }
  }
  return out
}

const target = process.argv[2]
const filter = process.argv[3]
if (target === undefined) {
  console.error('usage: node scripts/read-session-frames.mjs <session-dir-or-file> [grep]')
  process.exit(2)
}

const file = statSync(target).isDirectory()
  ? join(target, readdirSync(target).find((name) => name.endsWith('.zstd')) ?? '')
  : target
const buffer = readFileSync(file)
const blocks = frames(buffer).map((chunk) => chunk.toString('utf8')).join('\n')
const lines = blocks.split('\n').filter((line) => line.length > 0)

const counts = new Map()
let matched = 0
for (const line of lines) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    continue
  }
  const type = String(parsed.type ?? '?')
  counts.set(type, (counts.get(type) ?? 0) + 1)
  if (filter !== undefined && type === filter) {
    matched += 1
    if (matched <= 5) console.log(JSON.stringify(parsed))
  }
}

console.log(`frames: ${blocks.length === 0 ? 0 : 'ok'}, lines: ${lines.length}`)
console.log('event types:', [...counts.entries()].map(([type, count]) => `${type}:${count}`).join(', '))
if (filter !== undefined) console.log(`${filter} events: ${matched}`)
