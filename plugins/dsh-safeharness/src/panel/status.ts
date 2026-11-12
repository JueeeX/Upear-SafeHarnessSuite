/**
 * The panel payload builder: the same facts `safeharness_status` reports, in
 * the shape the Settings tab renders (T5.3).
 *
 * Zero-echo discipline holds for ledger-derived data: nothing here may carry
 * input text, tool arguments, model output, a credential or a webhook URL. The
 * event projection only carries coarse codes, hashes, session metadata and the
 * session title the host's title service owns (display-only, never logged).
 * Rule entries are the operator's own rule definitions, not matched content.
 * @module
 */
import type { LedgerRecord } from '../audit/types.js'
import type { Runtime } from '../runtime.js'
import type { SessionSummary } from '../state.js'
import { VERSION } from '../version.js'
import type {
  PanelDraft,
  PanelEngine,
  PanelEvent,
  PanelJudgeFact,
  PanelPayload,
  PanelRule,
  PanelSchedule,
  PanelSession,
} from './protocol.js'

/** How many enforcement/approval events the panel shows. */
export const PANEL_EVENT_LIMIT = 60

/** Ledger tail the event list is filtered from (bounded by the query cap). */
export const PANEL_SCAN_LIMIT = 200

/** How many sessions the panel lists. */
export const PANEL_SESSION_LIMIT = 50

/** Session summaries read to resolve a workspace/title for an event row. */
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

/** Longest rule detail string the rules tab carries. */
const MAX_RULE_DETAIL = 300

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
function toPanelEvent(
  record: LedgerRecord,
  sessionFacts: (session: string) => { workspace?: string; title?: string } | undefined,
): PanelEvent {
  const rawSession = record.session !== undefined && record.session.length > 0 ? record.session : undefined
  const facts = rawSession === undefined ? undefined : sessionFacts(rawSession)
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
    ...(facts?.workspace === undefined ? {} : { workspace: facts.workspace }),
    ...(facts?.title === undefined ? {} : { title: facts.title }),
    ...(record.args_sha256 === undefined ? {} : { argsHash: record.args_sha256.slice(0, ARGS_HASH_CHARS) }),
  }
}

/** Project one tracked session into the wire shape. */
function toPanelSession(summary: SessionSummary): PanelSession {
  return {
    id: shortSessionId(summary.sessionId),
    ...(summary.workspace === undefined ? {} : { workspace: summary.workspace }),
    ...(summary.createdAt === undefined ? {} : { createdAt: summary.createdAt }),
    ...(summary.title === undefined ? {} : { title: summary.title }),
    ...(summary.historical === true ? { historical: true } : {}),
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

/** Count how often each rule name appears in the displayed event window. */
function ruleHits(events: readonly PanelEvent[]): Map<string, number> {
  const hits = new Map<string, number>()
  for (const event of events) {
    for (const id of event.ruleIds) hits.set(id, (hits.get(id) ?? 0) + 1)
  }
  return hits
}

/** Project the compiled rule set into the rules-tab list. */
function toPanelRules(runtime: Runtime, hits: ReadonlyMap<string, number>): PanelRule[] {
  const rules: PanelRule[] = []
  const ruleset = runtime.engine.ruleset
  for (const rule of ruleset.rules) {
    rules.push({
      kind: 'rule',
      name: rule.name,
      severity: rule.severity,
      category: rule.category,
      origin: rule.origin,
      detail: rule.source.slice(0, MAX_RULE_DETAIL),
      hits: hits.get(rule.name) ?? 0,
    })
  }
  for (const chain of ruleset.chains) {
    rules.push({
      kind: 'chain',
      name: chain.name,
      severity: chain.severity,
      category: chain.category,
      origin: '',
      detail: `${chain.firstSource ?? '(any tool)'} → ${chain.thenSource ?? '(any tool)'}${chain.maxGap > 0 ? ` · gap ≤ ${chain.maxGap}` : ''}`,
      hits: hits.get(chain.name) ?? 0,
    })
  }
  return rules
}

/** Live facts `apply()` owns but the runtime does not. */
export interface PanelFacts {
  /** Engine identity/health; defaults to the built-in engine when absent. */
  readonly engine?: () => PanelEngine
  /** Extra rules directory (empty means packaged rules only). */
  readonly rulesDir?: () => string
  /** Drafting availability; defaults to disabled. */
  readonly draft?: () => PanelDraft
  /** Patrol schedule; defaults to disabled. */
  readonly schedule?: () => PanelSchedule
  /** Semantic-judge facts; defaults to the config values with no llm. */
  readonly judge?: () => PanelJudgeFact
}

/** Default rule/draft/schedule facts for a host that wires none of them. */
const NO_DRAFT: PanelDraft = { enabled: false, maxChars: 0 }
const NO_SCHEDULE: PanelSchedule = { enabled: false, intervalMinutes: null, nextAt: null, lastRunAt: null, persisted: false }

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
  const bySession = new Map(summaries.map(summary => [summary.sessionId, summary]))
  const sessionFacts = (session: string): { workspace?: string; title?: string } | undefined => {
    const summary = bySession.get(session)
    if (summary === undefined) return undefined
    return {
      ...(summary.workspace === undefined ? {} : { workspace: summary.workspace }),
      ...(summary.title === undefined ? {} : { title: summary.title }),
    }
  }

  let scanned = 0
  let recentEvents: PanelEvent[] = []
  try {
    const records = await runtime.ledger.query({ limit: PANEL_SCAN_LIMIT })
    scanned = records.length
    recentEvents = records
      .filter(isPanelEvent)
      .slice(-PANEL_EVENT_LIMIT)
      .map(record => toPanelEvent(record, sessionFacts))
  } catch {
    scanned = 0
    recentEvents = []
  }

  // Conversation filter options must outlive this process: the ledger can still
  // show events from sessions whose metadata row is in the persisted index, and a
  // session that is neither indexed nor live still deserves an "id only" row.
  const details = new Map<string, PanelSession>()
  for (const summary of summaries.slice(0, PANEL_SESSION_LIMIT)) {
    const row = toPanelSession(summary)
    details.set(row.id, row)
  }
  for (const event of recentEvents) {
    if (event.session === undefined || details.has(event.session)) continue
    details.set(event.session, {
      id: event.session,
      ...(event.workspace === undefined ? {} : { workspace: event.workspace }),
      ...(event.title === undefined ? {} : { title: event.title }),
      lastSeenAt: Date.parse(event.ts),
      calls: 0,
      allow: 0,
      warn: 0,
      deny: 0,
      ask: 0,
      historical: true,
    })
  }
  const sessionDetails = [...details.values()]
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, PANEL_SESSION_LIMIT)

  const judgeCfg = runtime.config.output?.judge
  const judgeFact: PanelJudgeFact = facts.judge?.() ?? {
    enabled: judgeCfg?.enabled === true,
    scope: judgeCfg?.scope ?? 'flagged',
    provider: judgeCfg?.provider ?? '',
    model: judgeCfg?.model ?? '',
    available: false,
  }

  return {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    preset: runtime.config.preset,
    uptimeMs: Date.now() - startedAt,
    sessions: runtime.state.size,
    sessionDetails,
    rules: {
      hash: runtime.engine.rulesetHash.slice(0, HASH_PREFIX_CHARS),
      count: runtime.engine.ruleCount,
      chains: runtime.engine.chainCount,
    },
    rulesDetail: toPanelRules(runtime, ruleHits(recentEvents)),
    rulesDir: facts.rulesDir?.() ?? '',
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
    draft: facts.draft?.() ?? NO_DRAFT,
    judge: judgeFact,
    schedule: facts.schedule?.() ?? NO_SCHEDULE,
    recentEvents,
    eventWindow: {
      scanned,
      kept: recentEvents.length,
      since: recentEvents[0]?.ts ?? null,
    },
  }
}
