/**
 * Deterministic JSON + hashing helpers shared by the engine, the ledger and the
 * surface tools. Everything here is pure and synchronous: it is safe to call
 * from `ctx.tools.guard()` (which forbids IO) and from audit record building.
 * @module
 */
import { createHash } from 'node:crypto'

/** A JSON value we can canonicalize (the lossless-JSON domain DSH works in). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Deep key-sort so two values differing only in property order canonicalize
 * identically. Array order is preserved (it is semantic). `undefined` object
 * properties are dropped, matching `JSON.stringify`; a top-level `undefined`
 * canonicalizes to `null`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value, 0)) ?? 'null'
}

/** Depth guard: beyond this we degrade to a type tag rather than recursing forever. */
const MAX_DEPTH = 32

/** Recursive key-sorting canonicalization with cycle + depth containment. */
function canonicalizeValue(value: unknown, depth: number): JsonValue {
  if (depth > MAX_DEPTH) return '[max-depth]'
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string') return value as string
  if (kind === 'boolean') return value as boolean
  if (kind === 'number') {
    const num = value as number
    // JSON has no NaN/Infinity; make the canonical form explicit and stable.
    return Number.isFinite(num) ? num : String(num)
  }
  if (kind === 'bigint') return String(value)
  if (kind === 'undefined' || kind === 'function' || kind === 'symbol') return null
  if (Array.isArray(value)) return value.map((item) => canonicalizeValue(item, depth + 1))
  const record = value as Record<string, unknown>
  const sorted: Record<string, JsonValue> = {}
  for (const key of Object.keys(record).sort()) {
    const item = record[key]
    if (item === undefined) continue
    sorted[key] = canonicalizeValue(item, depth + 1)
  }
  return sorted
}

/** Hex sha256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Hex sha256 of a byte buffer. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Hash an arbitrary value (arguments, tool results, messages) for the ledger.
 * Never returns the value itself — callers log the hash plus the size only.
 */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}

/**
 * Size and hash of an arbitrary value, the only shape audit records ever get to
 * store about raw content. `chars` is the length of the canonical JSON form.
 */
export interface ContentDigest {
  readonly sha256: string
  readonly chars: number
}

/** Compute {@link ContentDigest} for any value, never throwing. */
export function contentDigest(value: unknown): ContentDigest {
  let canonical: string
  try {
    canonical = canonicalJson(value)
  } catch {
    canonical = '[unhashable]'
  }
  return { sha256: sha256Hex(canonical), chars: canonical.length }
}

/**
 * Head-truncate for human-facing text (status/prompt/log lines) with an explicit
 * omission marker. Never used to build audit records (those keep hashes only).
 */
export function headTruncate(text: string, cap: number): string {
  if (cap < 0) return ''
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}… (+${text.length - cap} chars)`
}
