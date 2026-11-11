/**
 * Audit ledger vocabulary. The ledger is the plugin's evidence: one NDJSON line
 * per event, hash-chained, redacted to hashes and lengths (§6.8).
 * @module
 */

/** Every record kind the ledger writes. Keep this list closed: a typo is a bug. */
export type AuditKind =
  | 'plugin_loaded'
  | 'plugin_unloaded'
  | 'posture_report'
  | 'input_checked'
  | 'input_denied'
  | 'tool_checked'
  | 'tool_denied'
  | 'tool_asked'
  | 'tool_executed'
  | 'tool_result'
  | 'tool_result_flagged'
  | 'output_reviewed'
  | 'approval_asked'
  | 'approval_decided'
  | 'rules_reloaded'
  | 'patrol_report'
  | 'invariant_probe'
  | 'budget_exceeded'
  | 'error'

/** Fields every record may carry. Unknown content never appears here as raw text. */
export interface AuditFields {
  /** Session id the event belongs to, when known. */
  session?: string
  /** Agent id the event belongs to, when known. */
  agent?: string
  /** Tool name, for tool-surface records. */
  tool?: string
  /** Call id, for correlating with DSH session events. */
  call_id?: string
  /** The disposition: allow / deny / ask / block / warn / info. */
  decision?: string
  /** Stable reason code (see engine/types ReasonCode). */
  reason_code?: string
  /** Rule (or finding) identifiers involved. Never matched text. */
  rule_ids?: string[]
  /** Severity of the governing rule, when any. */
  severity?: string
  /** Rule category, when any. */
  category?: string
  /** sha256 of the canonical JSON form of the tool arguments. */
  args_sha256?: string
  /** Character length of that canonical form. */
  args_chars?: number
  /** sha256 of whatever detail content this record describes. */
  detail_sha256?: string
  /** Character length of that detail. */
  detail_chars?: number
  /** Preset in force when the record was written. */
  preset?: string
  /** Rule set hash in force when the record was written. */
  ruleset_hash?: string
  /** Free-form numeric/boolean metrics (durations, counts) — never content. */
  metrics?: Record<string, number | boolean | undefined>
  /** Extra short, non-content labels (codes, categories, statuses). */
  labels?: Record<string, string | undefined>
}

/** One materialized ledger line, after the chain fields were added. */
export interface LedgerRecord extends AuditFields {
  /** Record format version. Bumped only on an incompatible field change. */
  v: 1
  /** ISO-8601 UTC timestamp. */
  ts: string
  /** Monotonic sequence within the current file. */
  seq: number
  /** Event kind. */
  kind: AuditKind
  /** Plugin version that wrote the record. */
  plugin_version: string
  /** Previous record's sha256 (absent on the first record of a file). */
  prev_sha256?: string
  /** sha256 over this record without `sha256`. */
  sha256: string
  /** Marks the first record of a rotated file. */
  chain_start?: boolean
}

/** Ledger health snapshot used by posture/patrol/status. */
export interface LedgerStats {
  /** Directory the ledger writes to (may be empty when disabled). */
  readonly dir: string
  /** Absolute path of the active file. */
  readonly path: string
  /** Whether writes are enabled by config. */
  readonly enabled: boolean
  /** Whether the last write attempt succeeded. */
  readonly writable: boolean
  /** Total records written by this process. */
  readonly records: number
  /** Epoch ms of the last successful write. */
  readonly lastWriteAt?: number
  /** Last sequence number written. */
  readonly lastSeq: number
  /** Number of writes that failed (and were tolerated). */
  readonly failures: number
}

/** Query filter accepted by the read-only audit query surface. */
export interface AuditQuery {
  readonly limit?: number
  readonly session?: string
  readonly decision?: string
  readonly kind?: AuditKind
}

/** Chain verification result. */
export interface ChainVerification {
  readonly ok: boolean
  readonly checked: number
  /** Sequence of the first record whose chain link does not verify. */
  readonly brokenAt?: number
}

/** The ledger surface hooks and tools use. */
export interface Ledger {
  readonly stats: LedgerStats
  /** Append one record, awaiting the serialized write. Rejects when the sink is dead. */
  append(kind: AuditKind, fields?: AuditFields): Promise<void>
  /** Enqueue one record without awaiting; failures are swallowed into `stats.failures`. */
  appendBestEffort(kind: AuditKind, fields?: AuditFields): void
  /** Read the newest `limit` records matching the filter (oldest first). */
  query(query?: AuditQuery): Promise<LedgerRecord[]>
  /** Verify the hash chain over the whole active file (or a tail sample). */
  verifyChain(tailRecords?: number): Promise<ChainVerification>
  /** Flush and release the writer. */
  close(): Promise<void>
}
