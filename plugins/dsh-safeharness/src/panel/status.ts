/**
 * The panel payload builder: the same facts `safeharness_status` reports, in
 * the shape the Settings tab renders (T5.3).
 *
 * Zero-echo discipline holds here too: nothing in this payload may carry input
 * text, tool arguments, model output, a credential or a webhook URL. The only
 * free-form data is the event projection (timestamp, kind, disposition, reason
 * code, tool name, severity/category, rule ids, a truncated argument hash and the
 * session id), all of which are coarse codes the ledger already stores. The
 * project directory of a session is durable session metadata, not content.
 * @module
 */
import type { LedgerRecord } from '../audit/types.js'
import type { Runtime } from '../runtime.js'
import type { SessionSummary } from '../state.js'
import { VERSION } from '../version.js'
import type { PanelEngine, PanelEvent, PanelPayload, PanelSession } from './protocol.js'

/** How many enforcement/approval events the panel shows. */
export const PANEL_EVENT_LIMIT = 60

/** Ledger tail the event list is filtered from (bounded by the query cap). */
export const PANEL_SCAN_LIMIT = 200

/** How many sessions the panel lists. */
export const PANEL_SESSION_LIMIT = 8

/** Session summaries read to resolve a workspace for an event row. */
const PANEL_STATE_SCAN = 200

/** Display width of the rule-set hash (the ledger keeps the full one). */
const HASH_PREFIX_CHARS = 12

/** DSH prefixes session ids with this; the panel shows the bare uuid prefix. */
const SESSION_PREFIX = 'session-'

/** Display width of a session id. */
const SESSION_SHORT_CHARS = 8

/** Display width of the argument hash. */
const ARGS_HASH_CHARS = 8

/** Longest rule-id list one event row carries. */
const MAX_RULE_IDS = 6

/**
 * Dispositions that count as "needs attention". `ok` / `allow` / `info` records
 * are the bulk of the ledger (every allowed call writes one) and would drown the
 * list; `fail` and `error` are the posture/patrol/internal failures.
 */
const EVENT_DECISIONS: ReadonlySet<string> = new Set(['deny', 'warn', 'block', 'ask', 'asked', 'fail', 'error'])

/** Display form of a session id: the bare uuid prefix the ledger uses. */
export function shortSessionId(sessionId: string): string {
  const bare = sessionId.startsWith(SESSION_PREFIX) ? sessionId.slice(SESSION_PREFIX.length) : sessionId
  return bare.slice(0, SESSION_SHORT_CHARS)
}

/** True when one ledger record belongs in the panel's event list. */
function isPanelEvent(record: LedgerRecord): boolean {
  // `tool_result` is pure observation (every finished call writes one, including
  // the error result of a call we just denied); it is not a disposition.
  if (record.kind === 'tool_result') return false
  const decision = record.decision ?? ''
  return EVENT_DECISIONS.has(decision) || record.kind === 'error'
}

/** Project one ledger record into the wire shape (codes and hashes only). */
function toPanelEvent(record: LedgerRecord, workspaceOf: (session: string) => string | undefined): PanelEvent {
  const rawSession = record.session !== undefined && record.session.length > 0 ? record.session : undefined
  const workspace = rawSession === undefined ? undefined : workspaceOf(rawSession)
  const ruleIds = record.rule_ids === undefined ? [] : record.rule_ids.slice(0, MAX_RULE_IDS)
  return {
    ts: record.ts,
    kind: record.kind,
    decision: record.decision ?? '',
    reasonCode: record.reason_code ?? '',
    ...(record.tool === undefined ? {} : { tool: record.tool }),
    ...(record.severity === undefined ? {} : { severity: record.severity }),
    ...(record.category === undefined ? {} : { category: record.category }),
    ruleIds,
    rules: record.rule_ids?.length ?? 0,
    ...(rawSession === undefined ? {} : { session: shortSessionId(rawSession) }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(record.args_sha256 === undefined ? {} : { argsHash: record.args_sha256.slice(0, ARGS_HASH_CHARS) }),
  }
}

/** Project one tracked session into the wire shape. */
function toPanelSession(summary: SessionSummary): PanelSession {
  return {
    id: shortSessionId(summary.sessionId),
    ...(summary.workspace === undefined ? {} : { workspace: summary.workspace }),
    ...(summary.createdAt === undefined ? {} : { createdAt: summary.createdAt }),
    lastSeenAt: summary.touchedAt,
    calls: summary.totalCalls,
    allow: summary.counters.allow,
    warn: summary.counters.warn,
    deny: summary.counters.deny,
    ask: summary.counters.ask,
  }
}

/** Read the session page; a store that cannot answer degrades to an empty list. */
function safeSessions(runtime: Runtime): SessionSummary[] {
  try {
    return runtime.state.list(PANEL_STATE_SCAN)
  } catch {
    return []
  }
}

/** Live facts `apply()` owns but the runtime does not: the engine's health. */
export interface PanelFacts {
  /** Engine identity/health; defaults to the built-in engine when absent. */
  readonly engine?: () => PanelEngine
}

/**
 * Build one panel payload from live runtime state.
 *
 * Every read is defensive: a ledger that cannot answer (closed, unreadable)
 * reports an empty event list rather than failing the whole panel, because the
 * panel's primary job is to show that the plugin is alive.
 *
 * @param runtime - the plugin runtime.
 * @param startedAt - epoch ms recorded by `apply()`.
 * @param facts - optional live facts.
 * @returns a JSON-serializable payload.
 */
export async function buildPanelPayload(
  runtime: Runtime,
  startedAt: number,
  facts: PanelFacts = {},
): Promise<PanelPayload> {
  const stats = runtime.ledger.stats
  const counters = runtime.counters
  const summaries = safeSessions(runtime)
  const workspaceOf = (session: string): string | undefined =>
    summaries.find(summary => summary.sessionId === session)?.workspace

  let scanned = 0
  let recentEvents: PanelEvent[] = []
  try {
    const records = await runtime.ledger.query({ limit: PANEL_SCAN_LIMIT })
    scanned = records.length
    recentEvents = records
      .filter(isPanelEvent)
      .slice(-PANEL_EVENT_LIMIT)
      .map(record => toPanelEvent(record, workspaceOf))
  } catch {
    scanned = 0
    recentEvents = []
  }

  return {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    preset: runtime.config.preset,
    uptimeMs: Date.now() - startedAt,
    sessions: runtime.state.size,
    sessionDetails: summaries.slice(0, PANEL_SESSION_LIMIT).map(toPanelSession),
    rules: {
      hash: runtime.engine.rulesetHash.slice(0, HASH_PREFIX_CHARS),
      count: runtime.engine.ruleCount,
      chains: runtime.engine.chainCount,
    },
    modes: {
      input: runtime.config.input.mode,
      tools: runtime.config.tools.mode,
      results: runtime.config.results.mode,
      output: runtime.config.output.mode,
      approval: runtime.config.approval.mode,
    },
    counters: {
      allow: counters.allow,
      warn: counters.warn,
      deny: counters.deny,
      ask: counters.ask,
      auditBlocked: counters.auditBlocked,
      internalErrors: counters.internalErrors,
    },
    ledger: {
      enabled: stats.enabled,
      writable: stats.writable,
      records: stats.records,
      failures: stats.failures,
      lastWriteAt: stats.lastWriteAt ?? null,
      path: stats.path !== undefined && stats.path.length > 0 ? stats.path : null,
    },
    engine: facts.engine?.() ?? { kind: 'builtin', status: 'ready', rulesStale: false, pending: 0, badLines: 0 },
    recentEvents,
    eventWindow: {
      scanned,
      kept: recentEvents.length,
      since: recentEvents[0]?.ts ?? null,
    },
  }
}
