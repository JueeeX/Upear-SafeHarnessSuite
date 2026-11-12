/**
 * Wire types shared by the panel's Host RPC handler and its browser half.
 *
 * Type-only by contract (T5.3): the client bundle imports these with
 * `import type`, so this module must not gain a runtime value — the browser
 * module table has exactly ten specifiers, and none of ours is among them.
 * @module
 */

/** Absolute logical RPC channel serving the panel (not `/api`, which is reserved). */
export const PANEL_CHANNEL = '/safeharness'

/** Endpoint on that channel that returns {@link PanelPayload}. */
export const PANEL_STATUS_ENDPOINT = 'status'

/**
 * One denial as the panel shows it. Deliberately a projection, not the ledger
 * record: the ledger may grow fields, and the GUI must never be the reason a
 * new field reaches a browser.
 */
export interface PanelDenial {
  /** ISO-8601 UTC timestamp of the record. */
  readonly ts: string
  /** Record kind (`input_denied`, `tool_denied`, …). */
  readonly kind: string
  /** Stable reason code; empty when the record carried none. */
  readonly reasonCode: string
  /** Tool name, when the denial was a tool-surface one. */
  readonly tool?: string
  /** Number of rules that fired (never the rule text). */
  readonly rules: number
}

/** Outcome counters, per process. */
export interface PanelCounters {
  readonly allow: number
  readonly warn: number
  readonly deny: number
  readonly ask: number
  readonly auditBlocked: number
  readonly internalErrors: number
}

/** Enforcement mode in force per seam. */
export interface PanelModes {
  readonly input: string
  readonly tools: string
  readonly results: string
  readonly output: string
  readonly approval: string
}

/** Audit sink health. */
export interface PanelLedger {
  readonly enabled: boolean
  readonly writable: boolean
  readonly records: number
  readonly failures: number
  readonly lastWriteAt: number | null
}

/** Input engine state (built-in, or the optional Python sidecar). */
export interface PanelEngine {
  readonly kind: string
  readonly status: string
  readonly rulesStale: boolean
  readonly pending: number
  readonly badLines: number
}

/** Everything the SafeHarness settings tab renders. */
export interface PanelPayload {
  /** When the Host produced the payload. */
  readonly generatedAt: string
  /** Plugin version that produced it. */
  readonly version: string
  /** Active preset. */
  readonly preset: string
  /** Milliseconds since `apply()`. */
  readonly uptimeMs: number
  /** Sessions the plugin has seen. */
  readonly sessions: number
  /** Compiled rule set identity (hash truncated for display). */
  readonly rules: { readonly hash: string; readonly count: number; readonly chains: number }
  /** Seam modes. */
  readonly modes: PanelModes
  /** Decision counters. */
  readonly counters: PanelCounters
  /** Audit sink health. */
  readonly ledger: PanelLedger
  /** Engine facts. */
  readonly engine: PanelEngine
  /** Newest denials, oldest first. */
  readonly recentDenials: readonly PanelDenial[]
}

/** Successful RPC envelope. */
export interface PanelOk {
  readonly ok: true
  readonly value: PanelPayload
}

/** Failed RPC envelope (the Host's own result shape, structurally). */
export interface PanelError {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

/** What one panel RPC call resolves to. */
export type PanelResult = PanelOk | PanelError
