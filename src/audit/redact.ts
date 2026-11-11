/**
 * Redaction for audit records: the single place raw content is turned into
 * hashes + lengths before it can reach the ledger file.
 *
 * Classification is by **field name**, deliberately not by value regex (the
 * Python runtime does the same): a value
 * regex can only ever guess, while a name contract can be enforced. Three tiers:
 *
 *  1. sensitive keys (`api_key`, `authorization`, `cookie`, `credential`,
 *     `password`, `private_key`, `secret`, `token`, …) → the literal
 *     {@link REDACTED_PLACEHOLDER}; the value is never inspected or hashed.
 *  2. content keys (`arguments`, `content`, `result`, `message`, `text`,
 *     `prompt`, `output`, `value`) → a {@link RedactedValue} envelope: type,
 *     length and sha256 only.
 *  3. every other key → the value may be kept when it is a short scalar
 *     (string ≤ 256 chars), otherwise it is replaced by a {@link RedactedValue}.
 *
 * Known structural containers of `AuditFields` (`rule_ids`, `labels`, `metrics`)
 * are recursed instead of hashed as a blob: the plan's ledger sample carries
 * `rule_ids` and an audit trail without the rule id that fired is not evidence.
 * The recursion still applies tiers 1–3 to every leaf, so it cannot smuggle raw
 * content through a label.
 *
 * Every exported function is total: it never throws, because redaction runs on
 * the audit write path and a redaction bug must degrade the record, never the
 * request (Python parity: failures there are swallowed too).
 * @module
 */
import { contentDigest, sha256Hex } from '../util/hash.js'

/** What a sensitive field's value is replaced with. */
export const REDACTED_PLACEHOLDER = '[REDACTED]'

/** Longest raw string a non-content, non-sensitive field may keep. */
export const MAX_SAFE_STRING = 256

/** Deepest object nesting the sanitizer follows before hashing a subtree. */
export const MAX_REDACT_DEPTH = 8

/**
 * Hashed envelope for content. Only these four facts about a raw value ever
 * reach the ledger: that it was redacted, its JSON type, its size, its digest.
 */
export interface RedactedValue {
  readonly redacted: true
  readonly type: string
  /** Characters for strings, entries for arrays/maps, keys for objects, bytes for buffers. */
  readonly length: number
  /** sha256 of `canonicalJson(value)` — the same convention as `args_sha256`. */
  readonly sha256: string
}

/** Substrings that mark a key as carrying a credential. Checked after normalizing. */
const SENSITIVE_FRAGMENTS: readonly string[] = [
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'password',
  'private_key',
  'secret',
  'token',
]

/**
 * Same fragments with `_` removed, so camelCase spellings (`apiKey`,
 * `privateKey`, `authToken`) cannot slip through as a "plain" scalar. Python
 * misses `privateKey`; a key name is the only signal we have, so we do not.
 */
const SENSITIVE_COMPACT_FRAGMENTS: readonly string[] = SENSITIVE_FRAGMENTS.map((fragment) =>
  fragment.replace(/_/g, ''),
)

/** Field names whose values are content by contract: hash + length only. */
export const CONTENT_KEYS: readonly string[] = [
  'arguments',
  'content',
  'result',
  'message',
  'text',
  'prompt',
  'output',
  'value',
]

/**
 * `AuditFields` containers that are structural metadata, not content, and are
 * therefore recursed (leaves still sanitized) instead of hashed wholesale.
 */
const STRUCTURAL_KEYS: readonly string[] = ['rule_ids', 'labels', 'metrics']

const CONTENT_KEY_SET: ReadonlySet<string> = new Set(CONTENT_KEYS)
const STRUCTURAL_KEY_SET: ReadonlySet<string> = new Set(STRUCTURAL_KEYS)

/** `true` when a field name denotes a credential and its value must be masked. */
export function isSensitiveKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false
  try {
    const normalized = key.toLowerCase().replace(/-/g, '_')
    if (SENSITIVE_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return true
    const compact = normalized.replace(/_/g, '')
    return SENSITIVE_COMPACT_FRAGMENTS.some((fragment) => compact.includes(fragment))
  } catch {
    // A throwing exotic object in place of a key is not a reason to emit anything.
    return true
  }
}

/** JSON-ish type tag used in {@link RedactedValue.type}. */
function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Size of a value for {@link RedactedValue.length}; 0 for scalars without one. */
function measureLength(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.length
  if (value === null || value === undefined) return 0
  if (typeof value === 'object') {
    if (ArrayBuffer.isView(value)) return value.byteLength
    if (value instanceof ArrayBuffer) return value.byteLength
    if (value instanceof Map || value instanceof Set) return value.size
    return Object.keys(value as Record<string, unknown>).length
  }
  return 0
}

/** sha256 of an empty canonical form, used when a value resists hashing. */
const UNHASHABLE_SHA256 = sha256Hex('[unhashable]')

/**
 * Turn any value into a hash envelope. Safe on cycles, buffers, exotic objects
 * and getters that throw.
 */
export function redactValue(value: unknown): RedactedValue {
  const type = typeName(value)
  let length = 0
  let sha256 = UNHASHABLE_SHA256
  try {
    length = measureLength(value)
    sha256 = contentDigest(value).sha256
  } catch {
    // Keep the envelope: an unhashable value is still "do not store this".
  }
  return { redacted: true, type, length, sha256 }
}

/** True for a plain (non-array, non-null) object we may recurse into. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/** A scalar small enough to keep, or a hashed envelope when it is not. */
function leafValue(value: unknown): unknown {
  if (value === null) return null
  const kind = typeof value
  if (kind === 'string') {
    const text = value as string
    return text.length <= MAX_SAFE_STRING ? text : redactValue(text)
  }
  if (kind === 'number' || kind === 'boolean') return value
  if (kind === 'bigint') return String(value)
  return redactValue(value)
}

/** Sanitize one value found under an allow-listed structural key. */
function structuralValue(
  value: unknown,
  depth: number,
  seen: Set<object>,
): unknown {
  if (Array.isArray(value)) {
    // Arrays under structural keys are label/id lists (rule_ids). Leaves are
    // still sanitized: an object member becomes a hash, never a passthrough.
    const out: unknown[] = []
    for (const item of value) {
      if (item !== null && typeof item === 'object') out.push(redactValue(item))
      else out.push(leafValue(item))
    }
    return out
  }
  if (isPlainRecord(value)) return redactRecordImpl(value, depth + 1, seen)
  return leafValue(value)
}

/** Recursive implementation behind {@link redactRecord}. */
function redactRecordImpl(
  input: Record<string, unknown>,
  depth: number,
  seen: Set<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (depth > MAX_REDACT_DEPTH || seen.has(input)) return out
  seen.add(input)
  let keys: string[]
  try {
    keys = Object.keys(input)
  } catch {
    seen.delete(input)
    return out
  }
  for (const key of keys) {
    let value: unknown
    try {
      value = input[key]
    } catch {
      continue // a throwing getter is simply not evidence
    }
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (isSensitiveKey(key)) {
      out[key] = REDACTED_PLACEHOLDER
      continue
    }
    if (CONTENT_KEY_SET.has(lower)) {
      out[key] = redactValue(value)
      continue
    }
    if (STRUCTURAL_KEY_SET.has(key) || STRUCTURAL_KEY_SET.has(lower)) {
      out[key] = structuralValue(value, depth, seen)
      continue
    }
    out[key] = leafValue(value)
  }
  seen.delete(input)
  return out
}

/**
 * Deep-sanitize one audit record's `fields` object.
 *
 * Never throws; a field that cannot be read or classified is dropped rather than
 * passed through.
 *
 * @param input - untrusted field map (typically an `AuditFields` object).
 * @returns a fresh plain object safe to serialize into the ledger.
 */
export function redactRecord(input: Record<string, unknown>): Record<string, unknown> {
  if (input === null || typeof input !== 'object') return {}
  try {
    return redactRecordImpl(input, 0, new Set<object>())
  } catch {
    return {}
  }
}

/**
 * `true` when any of `sentinels` appears verbatim in `text`.
 *
 * This is the tripwire the audit tests assert against: after writing a record
 * that carried sentinel secrets/content, no sentinel may be findable in the
 * ledger bytes (or in any parsed field value).
 */
export function containsSecretSentinel(text: string, sentinels: readonly string[]): boolean {
  if (typeof text !== 'string') return false
  for (const sentinel of sentinels) {
    if (typeof sentinel !== 'string' || sentinel.length === 0) continue
    if (text.includes(sentinel)) return true
  }
  return false
}
