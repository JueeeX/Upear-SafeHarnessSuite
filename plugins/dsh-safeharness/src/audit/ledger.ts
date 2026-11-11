/**
 * NDJSON audit ledger with a per-record hash chain, rotation, tail queries and
 * chain verification (§6.8, plan §7).
 *
 * Design constraints, in priority order:
 *
 *  1. **No raw content ever reaches the file.** Every record's `fields` go
 *     through {@link redactRecord} (unless `audit.redact` is explicitly off) and
 *     the ledger's own keys are reserved, so a caller cannot smuggle `sha256` or
 *     `seq` in through `fields`.
 *  2. **Fail closed when evidence matters.** With `audit.required` the
 *     constructor probes the directory (mkdir + open) and throws when it cannot
 *     write; a failed append rejects the caller instead of silently dropping the
 *     record. With `audit.required: false` the ledger degrades: failures are
 *     counted and one rate-limited warning is printed.
 *  3. **Serialized writes.** Appends run one at a time through an in-process
 *     promise queue; a partially written line is rolled back (truncate to the
 *     pre-write size) so the next record still starts on a clean line.
 *  4. **Rotation never loses or duplicates a record.** A rotation renames the
 *     active file before the next record is built, the sequence number continues
 *     across files, and the new file's first record carries `chain_start`.
 *
 * All IO here is deliberately synchronous inside the queue step: one
 * `appendFileSync` per record is both the simplest and the most obviously
 * serialized thing the Node event loop can do.
 * @module
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  AuditFields,
  AuditKind,
  AuditQuery,
  ChainVerification,
  Ledger,
  LedgerRecord,
  LedgerStats,
} from './types.js'
import { canonicalJson, sha256Hex } from '../util/hash.js'
import { redactRecord } from './redact.js'
import { LEDGER_FILENAME } from './paths.js'

/** Query page size when the caller does not pass a limit. */
export const DEFAULT_QUERY_LIMIT = 50
/** Hard cap on a single query page, so one tool call cannot read the file out. */
export const MAX_QUERY_LIMIT = 500
/** Rotated files kept on disk. Older ones are deleted, oldest first. */
export const MAX_ROTATED_FILES = 10
/** Names {@link pruneRotated} is allowed to delete. Nothing else is touched. */
export const ROTATED_FILE_PATTERN = /^ledger-\d{8}-\d{6}\.ndjson$/

/** One warning per 30s no matter how many appends fail (plan §6.8). */
const WARN_INTERVAL_MS = 30_000
/** Read window for tail scans / recovery: bounded memory on a 64MB ledger. */
const CHUNK_BYTES = 64 * 1024
/** A ledger line longer than this is corruption, not a record. */
const MAX_LINE_BYTES = 1024 * 1024
/** Recursion cap for {@link recoverTailSync}'s broken-line trimming. */
const MAX_RECOVERY_TRIMS = 16

const NEWLINE_BYTE = 0x0a

/** Keys the ledger itself owns; `fields` may never overwrite them. */
const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set([
  'v',
  'ts',
  'seq',
  'kind',
  'plugin_version',
  'sha256',
  'prev_sha256',
  'chain_start',
])

/** Ledger construction/write options; mirrors `ResolvedConfig['audit']` plus identity. */
export interface LedgerOptions {
  readonly dir: string
  readonly format: 'ndjson' | 'off'
  readonly redact: boolean
  readonly hashChain: boolean
  readonly required: boolean
  readonly rotateMb: number
  readonly pluginVersion: string
  readonly rulesetHash: string
  readonly clock?: () => number
}

/** Mutable backing store for the (readonly, live) {@link LedgerStats} view. */
interface MutableStats {
  dir: string
  path: string
  enabled: boolean
  writable: boolean
  records: number
  lastWriteAt?: number
  lastSeq: number
  failures: number
}

/** Format an epoch-ms instant as the UTC `YYYYMMDD-HHmmss` rotation stamp. */
function utcStamp(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

/** ISO timestamp that cannot throw on an absurd injected clock. */
function safeIso(epochMs: number): string {
  try {
    return new Date(epochMs).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/** Compact, content-free description of an error for logs and messages. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return typeof code === 'string' ? code : error.name
  }
  return typeof error
}

/** Read exactly `length` bytes at `position` (may return fewer at EOF). */
function readExactlySync(fd: number, length: number, position: number): Buffer {
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.allocUnsafe(length)
  let total = 0
  while (total < length) {
    const bytesRead = readSync(fd, buffer, total, length - total, position + total)
    if (bytesRead <= 0) break
    total += bytesRead
  }
  return total === length ? buffer : buffer.subarray(0, total)
}

/** Byte offset of the last `\n` in `[0, before)`, or -1. Reads backwards in windows. */
function findLastNewlineSync(fd: number, before: number): number {
  let position = before
  while (position > 0) {
    const readSize = Math.min(CHUNK_BYTES, position)
    const start = position - readSize
    const chunk = readExactlySync(fd, readSize, start)
    for (let index = chunk.length - 1; index >= 0; index -= 1) {
      if (chunk[index] === NEWLINE_BYTE) return start + index
    }
    if (chunk.length < readSize) break // truncated read: stop instead of looping
    position = start
  }
  return -1
}

/** Parse one NDJSON line into a record, or `undefined` when it is not one. */
function parseLedgerRecord(line: string): LedgerRecord | undefined {
  if (line.trim().length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Partial<LedgerRecord>
  if (typeof record.seq !== 'number' || !Number.isFinite(record.seq)) return undefined
  if (typeof record.sha256 !== 'string') return undefined
  if (typeof record.kind !== 'string') return undefined
  return record as LedgerRecord
}

/** Normalize and validate a query limit: default 50, hard cap 500, reject < 1. */
function normalizeQueryLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new RangeError('safeharness: audit query limit must be an integer >= 1')
  }
  return Math.min(limit, MAX_QUERY_LIMIT)
}

/** True when a record matches every supplied filter. */
function matchesQuery(record: LedgerRecord, query: AuditQuery): boolean {
  if (query.session !== undefined && record.session !== query.session) return false
  if (query.decision !== undefined && record.decision !== query.decision) return false
  if (query.kind !== undefined && record.kind !== query.kind) return false
  return true
}

/**
 * Hash-verify an ordered (oldest-first) slice of records.
 *
 * `prev_sha256` is only compared when both records are in the slice; a tail
 * sample legitimately starts mid-chain, so an unknown predecessor is accepted
 * (its own sha256 is still checked). A record carrying `chain_start` resets the
 * expectation, which is the boundary between two rotated files.
 */
function verifyRecords(records: readonly LedgerRecord[]): ChainVerification {
  let expectedPrev: string | undefined
  let checked = 0
  for (const record of records) {
    if (record.chain_start === true) expectedPrev = undefined
    const copy: Record<string, unknown> = Object.fromEntries(Object.entries(record))
    delete copy.sha256
    const actual = sha256Hex(canonicalJson(copy))
    if (actual !== record.sha256) return { ok: false, checked, brokenAt: record.seq }
    checked += 1
    if (record.prev_sha256 !== undefined && expectedPrev !== undefined
      && record.prev_sha256 !== expectedPrev) {
      return { ok: false, checked, brokenAt: record.seq }
    }
    expectedPrev = record.sha256
    if (record.chain_start === true && checked > 1) break
  }
  return { ok: true, checked }
}

/** What tail recovery found after trimming any crash-torn trailing line. */
interface RecoveredTail {
  readonly record?: LedgerRecord
  /** File size after dropping torn/corrupt trailing bytes. */
  readonly cleanSize: number
}

/**
 * Make the active file safe to append to and recover the chain tail.
 *
 * A crash (or a failed partial write) can leave a line without its `\n` or a
 * half-written JSON object at the end of the file. Both are trimmed so the next
 * record lands on a clean line and the sequence/digest state matches the file.
 */
function recoverTailSync(filePath: string): RecoveredTail {
  const fd = openSync(filePath, 'r+')
  try {
    let size = fstatSync(fd).size
    if (size > 0) {
      const lastByte = readExactlySync(fd, 1, size - 1)
      if (lastByte.length === 1 && lastByte[0] !== NEWLINE_BYTE) {
        const newline = findLastNewlineSync(fd, size)
        const clean = newline >= 0 ? newline + 1 : 0
        ftruncateSync(fd, clean)
        size = clean
      }
    }
    for (let attempt = 0; attempt < MAX_RECOVERY_TRIMS && size > 0; attempt += 1) {
      const lineEnd = size - 1 // the '\n' terminating the last line
      const lineStart = findLastNewlineSync(fd, lineEnd) + 1
      const lineLength = lineEnd - lineStart
      if (lineLength > MAX_LINE_BYTES) {
        ftruncateSync(fd, lineStart)
        size = lineStart
        continue
      }
      const bytes = readExactlySync(fd, lineLength, lineStart)
      const record = parseLedgerRecord(bytes.toString('utf8'))
      if (record !== undefined) return { record, cleanSize: size }
      // Unparsable trailing line: drop it, then look at the one before.
      ftruncateSync(fd, lineStart)
      size = lineStart
    }
    return { cleanSize: size }
  } finally {
    closeSync(fd)
  }
}

/** A writable NDJSON ledger, or a disabled one when `format` is `off`. */
class FileLedger implements Ledger {
  private readonly options: LedgerOptions
  private readonly activePath: string
  private readonly limitBytes: number
  private readonly state: MutableStats

  /** Serializes every write: one `appendFileSync` at a time, in call order. */
  private queue: Promise<void> = Promise.resolve()
  private closing = false
  private closed = false

  /** Bytes in the active file as this process last observed them. */
  private currentSize = 0
  /** Last sequence number written to `activePath` (continues across rotation). */
  private seq = 0
  /** sha256 of the last record of the active file, when known. */
  private prevSha: string | undefined
  /** Whether the next record is the first one of a file (fresh start or rotation). */
  private chainStartNext = true
  private lastWarnAt = 0

  constructor(options: LedgerOptions) {
    this.options = options
    const dir = typeof options.dir === 'string' ? options.dir : ''
    this.activePath = dir.length > 0 ? join(dir, LEDGER_FILENAME) : LEDGER_FILENAME
    this.limitBytes = Number.isFinite(options.rotateMb) && options.rotateMb > 0
      ? options.rotateMb * 1024 * 1024
      : 0
    this.state = {
      dir,
      path: this.activePath,
      enabled: options.format !== 'off',
      writable: false,
      records: 0,
      lastSeq: 0,
      failures: 0,
    }
    if (!this.state.enabled) return // format 'off' touches nothing on disk
    try {
      this.openSink()
    } catch (error) {
      this.state.failures += 1
      this.state.writable = false
      const failure = new Error(`safeharness: audit ledger unavailable (${describeError(error)})`)
      // Fail closed: no evidence sink means the caller must not run enforcement.
      if (options.required) throw failure
      this.warnRateLimited('open', error)
    }
  }

  get stats(): LedgerStats {
    return this.state
  }

  append(kind: AuditKind, fields: AuditFields = {}): Promise<void> {
    if (!this.state.enabled) return Promise.resolve()
    if (this.closed || this.closing) {
      return Promise.reject(new Error('safeharness: audit ledger is closed'))
    }
    return this.enqueue(() => this.writeOne(kind, fields))
  }

  appendBestEffort(kind: AuditKind, fields: AuditFields = {}): void {
    if (!this.state.enabled || this.closed || this.closing) return
    // writeOne counts the failure and raises the rate-limited warning itself.
    void this.enqueue(() => this.writeOne(kind, fields)).catch(() => undefined)
  }

  async query(query: AuditQuery = {}): Promise<LedgerRecord[]> {
    const limit = normalizeQueryLimit(query.limit) // throws RangeError synchronously
    if (!this.state.enabled) return []
    const newestFirst: LedgerRecord[] = []
    await this.forEachTailLine((line) => {
      const record = parseLedgerRecord(line)
      if (record === undefined) return false // corrupt line: keep scanning older ones
      if (!matchesQuery(record, query)) return false
      newestFirst.push(record)
      return newestFirst.length >= limit
    })
    return newestFirst.reverse()
  }

  async verifyChain(tailRecords?: number): Promise<ChainVerification> {
    if (!this.state.enabled) return { ok: true, checked: 0 }
    if (tailRecords !== undefined && (!Number.isFinite(tailRecords) || tailRecords <= 0)) {
      return { ok: true, checked: 0 }
    }
    if (tailRecords !== undefined) {
      const newestFirst: LedgerRecord[] = []
      const want = Math.floor(tailRecords)
      await this.forEachTailLine((line) => {
        const record = parseLedgerRecord(line)
        if (record === undefined) return false
        newestFirst.push(record)
        return newestFirst.length >= want
      })
      return verifyRecords(newestFirst.reverse())
    }
    // Whole active file, verified in one streaming pass (never slurped).
    let expectedPrev: string | undefined
    let checked = 0
    let failure: ChainVerification | undefined
    await this.forEachFileLine((line) => {
      const record = parseLedgerRecord(line)
      if (record === undefined) {
        // A non-empty line that is not a record is corruption; report the slot.
        failure = { ok: false, checked, brokenAt: checked + 1 }
        return true
      }
      const result = verifyRecords([record])
      if (!result.ok) {
        failure = { ok: false, checked, brokenAt: record.seq }
        return true
      }
      if (record.chain_start === true) expectedPrev = undefined
      if (record.prev_sha256 !== undefined && expectedPrev !== undefined
        && record.prev_sha256 !== expectedPrev) {
        failure = { ok: false, checked, brokenAt: record.seq }
        return true
      }
      expectedPrev = record.sha256
      checked += 1
      return record.chain_start === true && checked > 1
    })
    if (failure !== undefined) return failure
    return { ok: true, checked }
  }

  async close(): Promise<void> {
    if (this.closing) {
      await this.queue
      return
    }
    this.closing = true
    await this.queue // drain: no handle is kept open between appends
    this.closed = true
    this.closing = false
  }

  /** Chain a task behind every previously queued write. */
  private enqueue(task: () => void): Promise<void> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Create the directory, prove it writable and recover the chain tail. */
  private openSink(): void {
    const dir = this.options.dir
    if (typeof dir !== 'string' || dir.trim().length === 0) {
      throw new Error('empty audit directory')
    }
    mkdirSync(dir, { recursive: true })
    const probe = openSync(this.activePath, 'a', 0o600)
    closeSync(probe)
    const recovered = recoverTailSync(this.activePath)
    this.currentSize = recovered.cleanSize
    const record = recovered.record
    this.seq = record !== undefined ? record.seq : 0
    this.prevSha = record?.sha256
    this.chainStartNext = record === undefined
    // `lastSeq` is a file fact, not a process counter: a reopened ledger reports
    // the sequence the file currently ends at.
    this.state.lastSeq = this.seq
    this.state.writable = true
    this.state.path = this.activePath
  }

  /** Build, serialize and append exactly one record; throws on any failure. */
  private writeOne(kind: AuditKind, fields: AuditFields): void {
    try {
      this.writeRecordSync(kind, fields)
    } catch (error) {
      throw this.recordFailure('write', error)
    }
  }

  /** The synchronous body of an append; runs inside the serialized queue step. */
  private writeRecordSync(kind: AuditKind, fields: AuditFields): void {
    if (!this.state.writable) this.openSink()
    const now = this.now()
    if (this.limitBytes > 0 && this.currentSize > this.limitBytes) this.rotate(now)
    const record = this.buildRecord(kind, fields, now)
    const line = `${canonicalJson(record)}\n`
    const sizeBefore = this.fileSize()
    try {
      appendFileSync(this.activePath, line, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.rollback(sizeBefore)
      throw error
    }
    this.currentSize = sizeBefore + Buffer.byteLength(line, 'utf8')
    this.seq += 1
    this.prevSha = record.sha256
    this.chainStartNext = false
    this.state.records += 1
    this.state.lastSeq = this.seq
    this.state.lastWriteAt = now
    this.state.writable = true
  }

  /** Assemble one record, reserving the ledger's own keys from `fields`. */
  private buildRecord(kind: AuditKind, fields: AuditFields, now: number): LedgerRecord {
    const raw: Record<string, unknown> = Object.fromEntries(Object.entries(fields ?? {}))
    const safeFields = this.options.redact ? redactRecord(raw) : raw
    const record: Record<string, unknown> = {
      v: 1,
      ts: safeIso(now),
      seq: this.seq + 1,
      kind,
      plugin_version: this.options.pluginVersion,
      ruleset_hash: this.options.rulesetHash,
    }
    for (const [key, value] of Object.entries(safeFields)) {
      if (RESERVED_FIELD_KEYS.has(key)) continue
      if (value === undefined) continue
      record[key] = value
    }
    if (this.options.hashChain && this.prevSha !== undefined) record.prev_sha256 = this.prevSha
    if (this.chainStartNext) record.chain_start = true
    // Hash over everything but the digest itself; canonicalJson sorts keys, so the
    // serialized form and the verified form agree byte for byte.
    record.sha256 = sha256Hex(canonicalJson(record))
    return record as unknown as LedgerRecord
  }

  /** Current on-disk size of the active file (falls back to the tracked size). */
  private fileSize(): number {
    try {
      return statSync(this.activePath).size
    } catch {
      return this.currentSize
    }
  }

  /** Undo a partial append so the next record starts on a clean line. */
  private rollback(sizeBefore: number): void {
    try {
      const current = statSync(this.activePath).size
      if (current > sizeBefore) truncateSync(this.activePath, sizeBefore)
      this.currentSize = Math.min(sizeBefore, current)
    } catch {
      // Best effort: if the file cannot be repaired the next append fails again.
    }
  }

  /** Rename the full active file aside and start a fresh chain in a new one. */
  private rotate(now: number): void {
    const target = this.nextRotatedPath(now)
    renameSync(this.activePath, target)
    this.currentSize = 0
    this.prevSha = undefined
    this.chainStartNext = true
    this.pruneRotated()
  }

  /** A free `ledger-YYYYMMDD-HHmmss.ndjson` name; never overwrites another file. */
  private nextRotatedPath(now: number): string {
    for (let attempt = 0; attempt < 3_600; attempt += 1) {
      const candidate = join(this.options.dir, `ledger-${utcStamp(now + attempt * 1000)}.ndjson`)
      if (!existsSync(candidate)) return candidate
    }
    throw new Error('no free rotation file name')
  }

  /** Keep at most {@link MAX_ROTATED_FILES} rotated files; leave all other files alone. */
  private pruneRotated(): void {
    try {
      const rotated = readdirSync(this.options.dir)
        .filter((name) => ROTATED_FILE_PATTERN.test(name))
        .sort()
      while (rotated.length > MAX_ROTATED_FILES) {
        const oldest = rotated.shift()
        if (oldest === undefined) break
        try {
          unlinkSync(join(this.options.dir, oldest))
        } catch {
          // Locked file: keeping one extra rotated file beats failing the append.
        }
      }
    } catch {
      // Listing failure is not a record loss; the append still succeeded.
    }
  }

  /** Monotonic epoch ms from the injected clock, defaulting to wall time. */
  private now(): number {
    try {
      const value = this.options.clock?.()
      if (typeof value === 'number' && Number.isFinite(value)) return value
    } catch {
      // A broken clock must not take the append path down.
    }
    return Date.now()
  }

  /** Count a failure, mark the sink unwritable and raise the rate-limited warning. */
  private recordFailure(phase: string, error: unknown): Error {
    this.state.failures += 1
    this.state.writable = false
    this.warnRateLimited(phase, error)
    return new Error(`safeharness: audit ledger ${phase} failed (${describeError(error)})`)
  }

  /** At most one warning per 30s, carrying an error code and never any content. */
  private warnRateLimited(phase: string, error: unknown): void {
    const now = Date.now()
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return
    this.lastWarnAt = now
    console.warn(
      `safeharness: audit ledger ${phase} failed (${describeError(error)}); `
      + 'continuing without evidence for this event',
    )
  }

  /**
   * Scan the active file from the tail, newest line first, in bounded windows.
   * Stops as soon as `visit` returns `true`. Only complete, newline-terminated
   * lines are visited.
   */
  private async forEachTailLine(visit: (line: string) => boolean): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await open(this.activePath, 'r')
    } catch {
      return // no ledger yet: nothing to read
    }
    try {
      const { size } = await handle.stat()
      let position = size
      let carry = Buffer.alloc(0) // bytes of the line whose start is in an earlier window
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
      let atEof = true
      while (position > 0) {
        const readSize = Math.min(CHUNK_BYTES, position)
        position -= readSize
        const { bytesRead } = await handle.read(chunk, 0, readSize, position)
        if (bytesRead <= 0) break
        let data = Buffer.concat([chunk.subarray(0, bytesRead), carry])
        // A torn tail (crash) is not a record: drop the unterminated fragment.
        if (atEof && data.length > 0 && data[data.length - 1] !== NEWLINE_BYTE) {
          const newline = data.lastIndexOf(NEWLINE_BYTE)
          data = newline >= 0 ? data.subarray(0, newline + 1) : Buffer.alloc(0)
        }
        atEof = false
        if (data.length === 0) continue
        const firstNewline = data.indexOf(NEWLINE_BYTE)
        // When the window does not reach the start of the file, the bytes before
        // the first newline are the head of a line completed by an earlier window.
        const emitStart = position > 0 ? firstNewline + 1 : 0
        if (position > 0) {
          carry = firstNewline === -1 ? data : data.subarray(0, firstNewline + 1)
          if (carry.length > MAX_LINE_BYTES) return // absurd line: give up scanning
        } else {
          carry = Buffer.alloc(0)
        }
        if (emitStart >= data.length) continue
        // Walk complete lines backwards: each is terminated by the newline at cursor-1.
        let cursor = data.length
        while (cursor > emitStart) {
          if (data[cursor - 1] !== NEWLINE_BYTE) break
          const lineEnd = cursor - 1
          let lineStart = lineEnd
          while (lineStart > emitStart && data[lineStart - 1] !== NEWLINE_BYTE) lineStart -= 1
          if (lineStart < lineEnd) {
            const line = data.subarray(lineStart, lineEnd).toString('utf8')
            if (line.length > 0 && visit(line)) return
          }
          cursor = lineStart
        }
      }
    } finally {
      await handle.close()
    }
  }

  /** Stream the whole active file forward, oldest line first, without slurping it. */
  private async forEachFileLine(visit: (line: string) => boolean): Promise<void> {
    let handle: FileHandle | undefined
    try {
      handle = await open(this.activePath, 'r')
    } catch {
      return
    }
    try {
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
      let leftover = Buffer.alloc(0)
      let position = 0
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position)
        if (bytesRead <= 0) break
        position += bytesRead
        const data = Buffer.concat([leftover, chunk.subarray(0, bytesRead)])
        let start = 0
        for (;;) {
          const newline = data.indexOf(NEWLINE_BYTE, start)
          if (newline === -1) break
          const line = data.subarray(start, newline).toString('utf8')
          start = newline + 1
          if (line.length > 0 && visit(line)) return
        }
        leftover = Buffer.from(data.subarray(start))
        if (leftover.length > MAX_LINE_BYTES) return
      }
      if (leftover.length > 0) {
        const line = leftover.toString('utf8')
        if (line.trim().length > 0) visit(line)
      }
    } finally {
      await handle.close()
    }
  }
}

/**
 * Create the audit ledger.
 *
 * @param options - see {@link LedgerOptions}; `dir` is expected to be absolute
 *   (use {@link resolveLedgerDir}).
 * @returns a ledger whose `stats` is a live view.
 * @throws Error when `format: 'ndjson'`, `required: true` and the directory
 *   cannot be created or written (fail-closed, plan §7). Never throws when
 *   `required: false`, `format: 'off'`, or for `appendBestEffort`/`query`.
 */
export function createLedger(options: LedgerOptions): Ledger {
  return new FileLedger(options)
}
