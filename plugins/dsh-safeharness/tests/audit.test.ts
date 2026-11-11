/**
 * Audit ledger tests (plan §6.8, §7): serialized NDJSON writes, hash chain,
 * redaction, rotation, tail query and fail-closed construction.
 *
 * Every test works in a fresh directory under `os.tmpdir()` — nothing here writes
 * inside the repository. The load-bearing test is the redaction one: it appends a
 * record carrying sentinel secrets and content, then greps the **raw ledger
 * bytes** for those sentinels. If a single one is found the evidence claim is
 * false, so that assertion is deliberately redundant (byte buffer + decoded
 * text + parsed field values).
 * @module
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_QUERY_LIMIT,
  MAX_ROTATED_FILES,
  ROTATED_FILE_PATTERN,
  createLedger,
} from '../src/audit/ledger.js'
import type { LedgerOptions } from '../src/audit/ledger.js'
import { LEDGER_FILENAME, resolveLedgerDir } from '../src/audit/paths.js'
import { REDACTED_PLACEHOLDER, containsSecretSentinel, isSensitiveKey } from '../src/audit/redact.js'
import { canonicalJson, contentDigest, sha256Hex } from '../src/util/hash.js'
import type { AuditFields, AuditKind, LedgerRecord } from '../src/audit/types.js'

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tempRoots: string[] = []

/** Create a fresh temp root and register it for cleanup. */
function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'safeharness-audit-'))
  tempRoots.push(root)
  return root
}

beforeEach(() => {
  tempRoots = []
})

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
  tempRoots = []
})

/** Baseline options; `dir` is always overridden per test. */
const BASE_OPTIONS: LedgerOptions = {
  dir: '',
  format: 'ndjson',
  redact: true,
  hashChain: true,
  required: true,
  rotateMb: 64,
  pluginVersion: '0.0.1-test',
  rulesetHash: 'ruleset-test-hash',
}

/** Ledger options for a temp directory. */
function optionsFor(dir: string, overrides: Partial<LedgerOptions> = {}): LedgerOptions {
  return { ...BASE_OPTIONS, dir, ...overrides }
}

/** Path of the active ledger file in `dir`. */
function ledgerFile(dir: string): string {
  return join(dir, LEDGER_FILENAME)
}

/** Non-empty lines of a ledger file. */
function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0)
}

/** Parsed records of a ledger file, oldest first. */
function readRecords(path: string): LedgerRecord[] {
  return readLines(path).map((line) => JSON.parse(line) as LedgerRecord)
}

/** Rotated file names in a directory, oldest first. */
function rotatedFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => ROTATED_FILE_PATTERN.test(name)).sort()
}

/** Offline chain verification used to check files the API will not read (rotated). */
function verifyOffline(records: readonly LedgerRecord[]): boolean {
  let expectedPrev: string | undefined
  for (const record of records) {
    const copy: Record<string, unknown> = Object.fromEntries(Object.entries(record))
    delete copy.sha256
    if (sha256Hex(canonicalJson(copy)) !== record.sha256) return false
    if (record.prev_sha256 !== undefined && expectedPrev !== undefined
      && record.prev_sha256 !== expectedPrev) {
      return false
    }
    expectedPrev = record.sha256
  }
  return true
}

/** Cast a parsed record to a loose field map for redaction assertions. */
function fieldOf(record: LedgerRecord | undefined, key: string): unknown {
  if (record === undefined) return undefined
  return (record as unknown as Record<string, unknown>)[key]
}

/** A `RedactedValue`-shaped assertion helper. */
interface Envelope {
  readonly redacted: boolean
  readonly type: string
  readonly length: number
  readonly sha256: string
}

// ---------------------------------------------------------------------------
// paths.ts
// ---------------------------------------------------------------------------

describe('ledger paths', () => {
  it('resolves the default under DSH_HOME, and expands/anchors operator paths', () => {
    const home = join(tmpdir(), 'safeharness-home')
    expect(LEDGER_FILENAME).toBe('ledger.ndjson')
    expect(resolveLedgerDir('', { DSH_HOME: home })).toBe(join(home, 'safeharness', 'audit'))
    expect(resolveLedgerDir('   ', { DSH_HOME: home })).toBe(join(home, 'safeharness', 'audit'))
    expect(resolveLedgerDir('evidence/audit', { DSH_HOME: home }))
      .toBe(resolve(process.cwd(), 'evidence', 'audit'))
    const absolute = join(tmpdir(), 'safeharness-absolute-audit')
    expect(resolveLedgerDir(absolute, { DSH_HOME: home })).toBe(resolve(absolute))
    expect(resolveLedgerDir('~/safeharness-x', { DSH_HOME: home }))
      .toBe(resolve(join(homedir(), 'safeharness-x')))
  })

  it('falls back to ~/.dsh when DSH_HOME is unset or empty', () => {
    const saved = process.env.DSH_HOME
    try {
      delete process.env.DSH_HOME
      expect(resolveLedgerDir('')).toBe(join(homedir(), '.dsh', 'safeharness', 'audit'))
      expect(resolveLedgerDir('', { DSH_HOME: '' }))
        .toBe(join(homedir(), '.dsh', 'safeharness', 'audit'))
    } finally {
      if (saved !== undefined) process.env.DSH_HOME = saved
    }
  })
})

// ---------------------------------------------------------------------------
// record writing + chain
// ---------------------------------------------------------------------------

describe('ledger writes and hash chain', () => {
  it('writes one parseable line per record with monotonic seq and a verifying chain', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir))
    const total = 10
    for (let index = 0; index < total; index += 1) {
      await ledger.append('tool_checked', {
        session: 's1',
        tool: 'bash',
        decision: 'allow',
        rule_ids: ['rule_one'],
      })
    }

    const stats = ledger.stats
    expect(stats.enabled).toBe(true)
    expect(stats.writable).toBe(true)
    expect(stats.records).toBe(total)
    expect(stats.lastSeq).toBe(total)
    expect(stats.failures).toBe(0)
    expect(stats.dir).toBe(dir)
    expect(stats.path).toBe(ledgerFile(dir))
    expect(typeof stats.lastWriteAt).toBe('number')

    const records = readRecords(ledgerFile(dir))
    expect(records).toHaveLength(total)
    expect(records.map((record) => record.seq)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1),
    )
    expect(records[0]?.v).toBe(1)
    expect(records[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(records[0]?.kind).toBe('tool_checked')
    expect(records[0]?.plugin_version).toBe(BASE_OPTIONS.pluginVersion)
    expect(records[0]?.ruleset_hash).toBe(BASE_OPTIONS.rulesetHash)
    // First record of a file: no predecessor link, but marked as a chain start.
    expect(records[0]?.prev_sha256).toBeUndefined()
    expect(records[0]?.chain_start).toBe(true)
    expect(records[1]?.prev_sha256).toBe(records[0]?.sha256)
    // Structural metadata survives redaction (needed for evidence).
    expect(records[0]?.rule_ids).toEqual(['rule_one'])
    expect(verifyOffline(records)).toBe(true)

    await expect(ledger.verifyChain()).resolves.toEqual({ ok: true, checked: total })
    await expect(ledger.verifyChain(3)).resolves.toEqual({ ok: true, checked: 3 })
    await expect(ledger.verifyChain(0)).resolves.toEqual({ ok: true, checked: 0 })
    await ledger.close()
  })

  it('detects a single tampered field and reports the sequence', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir))
    for (const decision of ['allow', 'allow', 'deny', 'deny', 'allow']) {
      await ledger.append('tool_checked', { decision, tool: 'bash' })
    }
    await ledger.close()

    const path = ledgerFile(dir)
    const lines = readLines(path)
    const victim = lines[2] ?? ''
    const tampered = victim.replace('"decision":"deny"', '"decision":"allow"')
    expect(tampered).not.toBe(victim)
    lines[2] = tampered
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')

    const verification = await ledger.verifyChain()
    expect(verification.ok).toBe(false)
    expect(verification.checked).toBe(2)
    expect(verification.brokenAt).toBe(3)
  })

  it('reserves chain keys so fields cannot forge seq, kind or digest', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir))
    const forged = {
      seq: 999,
      sha256: 'f'.repeat(64),
      v: 9,
      kind: 'error',
      prev_sha256: 'e'.repeat(64),
    } as unknown as AuditFields
    await ledger.append('plugin_loaded', forged)
    const [record] = readRecords(ledgerFile(dir))
    expect(record?.seq).toBe(1)
    expect(record?.v).toBe(1)
    expect(record?.kind).toBe('plugin_loaded')
    expect(record?.sha256).not.toBe('f'.repeat(64))
    expect(record?.prev_sha256).toBeUndefined()
    await expect(ledger.verifyChain()).resolves.toEqual({ ok: true, checked: 1 })
    await ledger.close()
  })

  it('omits chain links when hashChain is false but keeps verifiable digests', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir, { hashChain: false }))
    await ledger.append('plugin_loaded', { session: 's-nohc' })
    await ledger.append('plugin_loaded', { session: 's-nohc' })
    const records = readRecords(ledgerFile(dir))
    expect(records).toHaveLength(2)
    expect(records.every((record) => record.prev_sha256 === undefined)).toBe(true)
    expect(records.every((record) => record.sha256.length === 64)).toBe(true)
    expect(verifyOffline(records)).toBe(true)
    await expect(ledger.verifyChain()).resolves.toEqual({ ok: true, checked: 2 })
    await ledger.close()
  })

  it('resumes seq and chain state when the ledger is reopened', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const first = createLedger(optionsFor(dir))
    await first.append('plugin_loaded', {})
    await first.append('plugin_loaded', {})
    await first.close()

    const second = createLedger(optionsFor(dir))
    expect(second.stats.lastSeq).toBe(2)
    await second.append('plugin_loaded', {})
    const records = readRecords(ledgerFile(dir))
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3])
    expect(records[2]?.prev_sha256).toBe(records[1]?.sha256)
    expect(records[2]?.chain_start).toBeUndefined()
    await expect(second.verifyChain()).resolves.toEqual({ ok: true, checked: 3 })
    await second.close()
  })

  it('repairs a crash-torn trailing line instead of appending after it', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir))
    await ledger.append('plugin_loaded', {})
    await ledger.close()

    const path = ledgerFile(dir)
    const torn = `${readFileSync(path, 'utf8')}{"v":1,"seq":2,"kind":"tool_den`
    writeFileSync(path, torn, 'utf8')

    const reopened = createLedger(optionsFor(dir))
    await reopened.append('plugin_loaded', {})
    const records = readRecords(path)
    expect(records.map((record) => record.seq)).toEqual([1, 2])
    expect(verifyOffline(records)).toBe(true)
    await expect(reopened.verifyChain()).resolves.toEqual({ ok: true, checked: 2 })
    await reopened.close()
  })
})

// ---------------------------------------------------------------------------
// redaction: the evidence-safety property
// ---------------------------------------------------------------------------

describe('redaction', () => {
  it('classifies sensitive field names, including camelCase spellings', () => {
    for (const key of [
      'api_key', 'x-api-key', 'apiKey', 'apikey', 'Authorization', 'cookie',
      'credential', 'db_password', 'private_key', 'privateKey', 'client_secret',
      'access_token', 'refreshToken',
    ]) {
      expect(isSensitiveKey(key), key).toBe(true)
    }
    for (const key of [
      'session', 'agent', 'tool', 'call_id', 'decision', 'reason_code', 'rule_ids',
      'severity', 'category', 'args_sha256', 'detail_sha256', 'preset',
      'ruleset_hash', 'plugin_version', 'labels', 'metrics', 'args_chars',
    ]) {
      expect(isSensitiveKey(key), key).toBe(false)
    }
  })

  it('never writes sentinel secrets or raw content into the ledger bytes', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir))
    const sentinels = [
      'sk-test-sentinel-4f9a2c',
      'hunter2-sentinel',
      'SECRET-BODY-SENTINEL',
      'SECRET-ARGS-SENTINEL',
      'SECRET-MESSAGE-SENTINEL',
      'SECRET-OUTPUT-SENTINEL',
      'SECRET-PROMPT-SENTINEL',
      'SECRET-VALUE-SENTINEL',
      'SECRET-TOOL-RESULT-SENTINEL',
      'label-token-sentinel',
    ]
    const longLabel = `LONG-SENTINEL-${'z'.repeat(400)}`
    await ledger.append('tool_denied', {
      session: 's-redact',
      tool: 'shell',
      decision: 'deny',
      reason_code: 'tool_denied_by_tag',
      rule_ids: ['danger_shell'],
      api_key: sentinels[0],
      password: `password=${sentinels[1]}`,
      authorization: `Bearer ${sentinels[0]}`,
      content: sentinels[2],
      arguments: { cmd: sentinels[3] },
      message: sentinels[4],
      output: sentinels[5],
      prompt: sentinels[6],
      value: sentinels[7],
      result: sentinels[8],
      labels: { note: 'label-note-ok', refresh_token: 'label-token-sentinel', detail_summary: longLabel },
    })
    await ledger.close()

    const path = ledgerFile(dir)
    const bytes = readFileSync(path)
    const text = bytes.toString('utf8')
    for (const sentinel of sentinels) {
      expect(bytes.includes(sentinel), `raw bytes contain ${sentinel}`).toBe(false)
      expect(text.includes(sentinel), `file text contains ${sentinel}`).toBe(false)
    }
    expect(text.includes('label-token-sentinel')).toBe(false)
    expect(text.includes('LONG-SENTINEL-')).toBe(false)
    expect(containsSecretSentinel(text, [...sentinels, 'LONG-SENTINEL-'])).toBe(false)

    const [record] = readRecords(path)
    // Sensitive values become the placeholder and nothing else.
    expect(fieldOf(record, 'api_key')).toBe(REDACTED_PLACEHOLDER)
    expect(fieldOf(record, 'authorization')).toBe(REDACTED_PLACEHOLDER)
    expect(fieldOf(record, 'password')).toBe(REDACTED_PLACEHOLDER)
    // Content values become a hash envelope: type + length + sha256.
    const content = fieldOf(record, 'content') as Envelope
    expect(content.redacted).toBe(true)
    expect(content.type).toBe('string')
    expect(content.length).toBe(sentinels[2]?.length)
    expect(content.sha256).toHaveLength(64)
    expect(content.sha256).toBe(contentDigest(sentinels[2]).sha256)
    const args = fieldOf(record, 'arguments') as Envelope
    expect(args.redacted).toBe(true)
    expect(args.type).toBe('object')
    expect(args.length).toBe(1)
    expect(args.sha256).toHaveLength(64)
    for (const key of ['message', 'output', 'prompt', 'value', 'result']) {
      expect((fieldOf(record, key) as Envelope).redacted, key).toBe(true)
    }
    // Short non-content labels are kept; sensitive keys inside labels are masked;
    // an over-long label is hashed rather than truncated into the file.
    const labels = fieldOf(record, 'labels') as Record<string, unknown>
    expect(labels.note).toBe('label-note-ok')
    expect(labels.refresh_token).toBe(REDACTED_PLACEHOLDER)
    const longValue = labels.detail_summary as Envelope
    expect(longValue.redacted).toBe(true)
    expect(longValue.length).toBe(longLabel.length)
    // The record as a whole still verifies.
    await expect(ledger.verifyChain()).resolves.toEqual({ ok: true, checked: 1 })
  })
})

// ---------------------------------------------------------------------------
// rotation
// ---------------------------------------------------------------------------

describe('rotation', () => {
  it('rotates without losing or duplicating records and marks each new chain start', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir, { rotateMb: 0.0001 }))
    const total = 4
    for (let index = 0; index < total; index += 1) {
      await ledger.append('input_checked', {
        session: 's-rot',
        decision: 'allow',
        metrics: { index },
      })
    }
    await ledger.close()

    const rotated = rotatedFiles(dir)
    expect(rotated.length).toBeGreaterThanOrEqual(2)
    expect(rotated.every((name) => ROTATED_FILE_PATTERN.test(name))).toBe(true)

    const activePath = ledgerFile(dir)
    const files = [...rotated.map((name) => join(dir, name))]
    if (existsSync(activePath)) files.push(activePath)
    expect(files.length).toBeGreaterThanOrEqual(2)

    const sequences: number[] = []
    for (const file of files) {
      const records = readRecords(file)
      expect(records.length).toBeGreaterThan(0)
      // Each file starts its own chain: chain_start and no predecessor link.
      expect(records[0]?.chain_start).toBe(true)
      expect(records[0]?.prev_sha256).toBeUndefined()
      expect(verifyOffline(records)).toBe(true)
      for (const record of records) sequences.push(record.seq)
    }
    sequences.sort((left, right) => left - right)
    expect(sequences).toEqual(Array.from({ length: total }, (_, index) => index + 1))
  })

  it('keeps at most ten rotated files and never deletes foreign files', async () => {
    const dir = makeTempRoot() // use the root itself so we can plant foreign files
    const foreign = join(dir, 'keep-me.ndjson')
    writeFileSync(foreign, 'not a ledger\n', 'utf8')
    const ledger = createLedger(optionsFor(dir, { rotateMb: 0.0001 }))
    const writes = MAX_ROTATED_FILES + 4
    for (let index = 0; index < writes; index += 1) {
      await ledger.append('error', { reason_code: 'rotation_test' })
    }
    await ledger.close()

    const rotated = rotatedFiles(dir)
    expect(rotated).toHaveLength(MAX_ROTATED_FILES)
    expect(existsSync(foreign)).toBe(true)
    expect(readFileSync(foreign, 'utf8')).toBe('not a ledger\n')
  })
})

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

describe('serialized writes', () => {
  it('serializes 20 concurrent appends with no interleaving or corruption', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir))
    const kinds: AuditKind[] = ['tool_checked', 'tool_denied', 'input_checked', 'output_reviewed']
    const total = 20
    await Promise.all(Array.from({ length: total }, (_, index) => ledger.append(
      kinds[index % kinds.length] ?? 'tool_checked',
      {
        session: 's-concurrent',
        decision: index % 2 === 0 ? 'allow' : 'deny',
        metrics: { index },
      },
    )))
    await ledger.close()

    const lines = readLines(ledgerFile(dir))
    expect(lines).toHaveLength(total)
    const records = lines.map((line) => JSON.parse(line) as LedgerRecord)
    // Enqueue order is call order, so seq and payload order must both be exact.
    expect(records.map((record) => record.seq)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1),
    )
    expect(records.map((record) => (record.metrics as { index: number }).index)).toEqual(
      Array.from({ length: total }, (_, index) => index),
    )
    expect(new Set(records.map((record) => record.sha256)).size).toBe(total)
    expect(verifyOffline(records)).toBe(true)
    await expect(ledger.verifyChain()).resolves.toEqual({ ok: true, checked: total })
  })
})

// ---------------------------------------------------------------------------
// disabled / degraded modes
// ---------------------------------------------------------------------------

describe('disabled and degraded modes', () => {
  it("format 'off' disables the ledger and touches nothing on disk", async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir, { format: 'off' }))
    expect(ledger.stats.enabled).toBe(false)
    await expect(ledger.append('plugin_loaded', {})).resolves.toBeUndefined()
    expect(() => ledger.appendBestEffort('plugin_loaded', {})).not.toThrow()
    await expect(ledger.query()).resolves.toEqual([])
    await expect(ledger.verifyChain()).resolves.toEqual({ ok: true, checked: 0 })
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(ledgerFile(dir))).toBe(false)
    await ledger.close()
  })

  it('fails closed at construction when required and the directory cannot be written', () => {
    const root = makeTempRoot()
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const unwritable = join(blocker, 'sub', 'audit')
    expect(() => createLedger(optionsFor(unwritable))).toThrow(/audit ledger unavailable/)
    // Same shape with format off is fine: nothing is written.
    expect(() => createLedger(optionsFor(unwritable, { format: 'off' }))).not.toThrow()
  })

  it('degrades with one rate-limited warning and appendBestEffort never throws', async () => {
    const root = makeTempRoot()
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const unwritable = join(blocker, 'sub', 'audit')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const ledger = createLedger(optionsFor(unwritable, { required: false }))
      expect(ledger.stats.enabled).toBe(true)
      expect(ledger.stats.writable).toBe(false)
      expect(ledger.stats.failures).toBeGreaterThanOrEqual(1)

      expect(() => ledger.appendBestEffort('error', { reason_code: 'boom' })).not.toThrow()
      expect(() => ledger.appendBestEffort('error', { reason_code: 'boom' })).not.toThrow()
      await new Promise((resolveDone) => setTimeout(resolveDone, 25))

      // Both best-effort appends failed, only one warning was allowed out.
      expect(ledger.stats.failures).toBeGreaterThanOrEqual(3)
      expect(warn).toHaveBeenCalledTimes(1)
      await expect(ledger.append('error', {})).rejects.toThrow(/audit ledger/)
      await expect(ledger.query()).resolves.toEqual([])
      await ledger.close()
    } finally {
      warn.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

describe('query', () => {
  it('filters by kind/decision/session and validates the limit', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir))
    for (let index = 0; index < 6; index += 1) {
      await ledger.append(index < 3 ? 'tool_denied' : 'tool_checked', {
        session: `s${index % 2}`,
        decision: index % 2 === 0 ? 'deny' : 'allow',
        metrics: { index },
      })
    }

    expect((await ledger.query()).map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect((await ledger.query({ limit: 2 })).map((record) => record.seq)).toEqual([5, 6])
    expect((await ledger.query({ kind: 'tool_denied' })).map((record) => record.seq))
      .toEqual([1, 2, 3])
    expect((await ledger.query({ decision: 'deny' })).map((record) => record.seq))
      .toEqual([1, 3, 5])
    expect((await ledger.query({ session: 's1' })).map((record) => record.seq))
      .toEqual([2, 4, 6])
    // A limit over the cap is clamped, not an error; MAX_QUERY_LIMIT is the cap.
    expect((await ledger.query({ limit: 10_000 }))).toHaveLength(6)
    expect(MAX_QUERY_LIMIT).toBe(500)
    await expect(ledger.query({ limit: 0 })).rejects.toThrow(RangeError)
    await expect(ledger.query({ limit: -5 })).rejects.toThrow(RangeError)
    await expect(ledger.query({ limit: 1.5 })).rejects.toThrow(RangeError)
    await ledger.close()
  })

  it('reads the tail of a large ledger across read-window boundaries', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    const ledger = createLedger(optionsFor(dir))
    const total = 2_000
    for (let index = 0; index < total; index += 1) {
      ledger.appendBestEffort('tool_checked', {
        session: 's-bulk',
        decision: 'allow',
        metrics: { index },
      })
    }
    await ledger.close()

    const path = ledgerFile(dir)
    expect(statSync(path).size).toBeGreaterThan(200_000)

    const tail = await ledger.query({ limit: 5 })
    expect(tail.map((record) => record.seq)).toEqual([total - 4, total - 3, total - 2, total - 1, total])
    // Proves the reader landed on exact record boundaries, not approximate ones.
    expect(tail.map((record) => (record.metrics as { index: number }).index))
      .toEqual([total - 5, total - 4, total - 3, total - 2, total - 1])
    expect(tail.every((record) => record.session === 's-bulk')).toBe(true)

    const filtered = await ledger.query({ session: 's-bulk', limit: 3, kind: 'tool_checked' })
    expect(filtered.map((record) => record.seq)).toEqual([total - 2, total - 1, total])

    await expect(ledger.verifyChain(50)).resolves.toEqual({ ok: true, checked: 50 })
    await expect(ledger.verifyChain()).resolves.toEqual({ ok: true, checked: total })
  })

  it('returns an empty page when the ledger file does not exist yet', async () => {
    const dir = join(makeTempRoot(), 'ledger')
    mkdirSync(dir, { recursive: true })
    const ledger = createLedger(optionsFor(dir))
    // The constructor creates the file eagerly, so emulate "no file" explicitly.
    await ledger.close()
    rmSync(ledgerFile(dir), { force: true })
    await expect(ledger.query()).resolves.toEqual([])
    await expect(ledger.verifyChain()).resolves.toEqual({ ok: true, checked: 0 })
  })
})

// ---------------------------------------------------------------------------
// ledger sample (prints a real record shape for manual inspection)
// ---------------------------------------------------------------------------

describe('evidence sample', () => {
  it('prints a redacted ledger line, a chain verdict and rotation file names', async () => {
    // (a) A normal ledger: the record carries every sensitive/content field.
    const sampleDir = join(makeTempRoot(), 'ledger')
    const sampleLedger = createLedger(optionsFor(sampleDir))
    await sampleLedger.append('tool_denied', {
      session: 's-evidence',
      agent: 'agent-1',
      tool: 'shell',
      decision: 'deny',
      reason_code: 'tool_denied_by_tag',
      rule_ids: ['danger_shell'],
      severity: 'high',
      args_sha256: 'a'.repeat(64),
      args_chars: 120,
      api_key: 'sk-test-sentinel-evidence',
      authorization: 'Bearer sentinel-evidence',
      password: 'password=hunter2-sentinel',
      content: 'SECRET-BODY-SENTINEL',
      metrics: { elapsed_ms: 3 },
    })
    for (let index = 0; index < 3; index += 1) {
      await sampleLedger.append('tool_checked', { session: 's-evidence', decision: 'allow' })
    }
    const sampleVerdict = await sampleLedger.verifyChain()
    const sampleText = readFileSync(ledgerFile(sampleDir), 'utf8')
    const sampleLine = readLines(ledgerFile(sampleDir))[0] ?? '(no record)'

    // (b) A tiny rotation threshold: file names only.
    const rotationDir = join(makeTempRoot(), 'ledger')
    const rotationLedger = createLedger(optionsFor(rotationDir, { rotateMb: 0.0002 }))
    for (let index = 0; index < 3; index += 1) {
      await rotationLedger.append('input_checked', { session: 's-evidence', decision: 'allow' })
    }
    await rotationLedger.close()
    const rotationNames = [
      ...rotatedFiles(rotationDir),
      ...(existsSync(ledgerFile(rotationDir)) ? [LEDGER_FILENAME] : []),
    ]

    console.log(`[evidence] ledger path: ${ledgerFile(sampleDir)}`)
    console.log(`[evidence] sample line: ${sampleLine}`)
    console.log(`[evidence] verifyChain(): ${JSON.stringify(sampleVerdict)}`)
    console.log(`[evidence] rotation files: ${rotationNames.join(', ')}`)
    console.log(`[evidence] raw sentinel in file bytes: ${containsSecretSentinel(sampleText, ['sk-test-sentinel-evidence', 'hunter2-sentinel', 'SECRET-BODY-SENTINEL'])}`)
    await sampleLedger.close()
  })
})
