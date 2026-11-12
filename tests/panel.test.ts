/**
 * The panel payload builder (T5.3).
 *
 * What matters here is not the wiring but the projection: the browser must only
 * ever see coarse facts, the event list must come from the ledger tail with the
 * allow/ok bulk filtered out, sessions must stay bounded, and a dead ledger or
 * state store must degrade to empty lists rather than failing the whole panel.
 */
import { describe, expect, it } from 'vitest'
import { PANEL_EVENT_LIMIT, PANEL_SCAN_LIMIT, PANEL_SESSION_LIMIT, buildPanelPayload, shortSessionId } from '../src/panel/status.js'
import type { SessionSummary } from '../src/state.js'
import type { Runtime } from '../src/runtime.js'
import type { AuditQuery } from '../src/audit/types.js'

/** One session summary the stub store can return. */
function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: id,
    touchedAt: 1_760_000_000_000,
    totalCalls: 3,
    counters: { allow: 1, deny: 2, ask: 1, warn: 0 },
    ...overrides,
  }
}

/** A runtime-shaped stub: the builder reads exactly these fields. */
function stubRuntime(options: {
  readonly query?: (query?: AuditQuery) => Promise<unknown[]>
  readonly queryThrows?: boolean
  readonly sessions?: readonly SessionSummary[]
  readonly listThrows?: boolean
} = {}): { runtime: Runtime; queries: AuditQuery[] } {
  const queries: AuditQuery[] = []
  const sessions = options.sessions ?? []
  const runtime = {
    config: {
      preset: 'balanced',
      input: { mode: 'enforce' },
      tools: { mode: 'enforce' },
      results: { mode: 'warn' },
      output: { mode: 'warn' },
      approval: { mode: 'delegate' },
    },
    engine: { rulesetHash: 'a'.repeat(64), ruleCount: 20, chainCount: 3 },
    ledger: {
      stats: {
        enabled: true, writable: true, records: 7, failures: 1,
        lastWriteAt: 1_760_000_000_000, path: 'C:\\Users\\tester\\.dsh\\safeharness\\audit\\ledger.ndjson',
      },
      query: async (query?: AuditQuery) => {
        if (query !== undefined) queries.push(query)
        if (options.queryThrows === true) throw new Error('ledger closed')
        return options.query?.(query) ?? []
      },
    },
    state: {
      size: sessions.length,
      list: (limit: number) => {
        if (options.listThrows === true) throw new Error('state exploded')
        // Mirror the store contract: newest activity first.
        return [...sessions].sort((left, right) => right.touchedAt - left.touchedAt).slice(0, limit)
      },
    },
    counters: { allow: 5, warn: 2, deny: 3, ask: 1, auditBlocked: 0, internalErrors: 4 },
  } as unknown as Runtime
  return { runtime, queries }
}

describe('buildPanelPayload', () => {
  it('projects live state into the wire shape', async () => {
    const { runtime } = stubRuntime()
    const payload = await buildPanelPayload(runtime, Date.now() - 1_000, {
      engine: () => ({ kind: 'builtin', status: 'ready', rulesStale: false, pending: 0, badLines: 0 }),
    })
    expect(payload.version).toMatch(/^\d+\.\d+\.\d+/u)
    expect(payload.preset).toBe('balanced')
    expect(payload.sessions).toBe(0)
    expect(payload.rules).toEqual({ hash: 'aaaaaaaaaaaa', count: 20, chains: 3 })
    expect(payload.modes).toEqual({
      input: 'enforce', tools: 'enforce', results: 'warn', output: 'warn', approval: 'delegate',
    })
    expect(payload.counters).toEqual({
      allow: 5, warn: 2, deny: 3, ask: 1, auditBlocked: 0, internalErrors: 4,
    })
    expect(payload.ledger).toEqual({
      enabled: true, writable: true, records: 7, failures: 1,
      lastWriteAt: 1_760_000_000_000,
      path: 'C:\\Users\\tester\\.dsh\\safeharness\\audit\\ledger.ndjson',
    })
    expect(payload.engine.kind).toBe('builtin')
    expect(payload.uptimeMs).toBeGreaterThanOrEqual(0)
    expect(payload.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
    expect(payload.sessionDetails).toEqual([])
    expect(payload.recentEvents).toEqual([])
    expect(payload.eventWindow).toEqual({ scanned: 0, kept: 0, since: null })
  })

  it('lists sessions newest-first with short ids and bounded history', async () => {
    const sessions = [
      summary('session-11111111-aaaa', { workspace: 'F:\\AgentSecurity\\Upear', createdAt: 1_759_000_000_000, touchedAt: 300 }),
      summary('session-22222222-bbbb', { touchedAt: 200, totalCalls: 9, counters: { allow: 0, deny: 0, ask: 0, warn: 0 } }),
      summary('session-33333333-cccc', { touchedAt: 100 }),
    ]
    const { runtime } = stubRuntime({ sessions })
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(payload.sessions).toBe(3)
    expect(payload.sessionDetails).toHaveLength(3)
    expect(payload.sessionDetails[0]).toEqual({
      id: '11111111',
      workspace: 'F:\\AgentSecurity\\Upear',
      createdAt: 1_759_000_000_000,
      lastSeenAt: 300,
      calls: 3,
      allow: 1, warn: 0, deny: 2, ask: 1,
    })
    expect(payload.sessionDetails[1]).toEqual({
      id: '22222222', lastSeenAt: 200, calls: 9, allow: 0, warn: 0, deny: 0, ask: 0,
    })
    // A list longer than the panel page is truncated, not rejected.
    const many = Array.from({ length: PANEL_SESSION_LIMIT + 4 }, (_, index) =>
      summary(`session-${String(index).padStart(8, '0')}-x`, { touchedAt: index }))
    const wide = await buildPanelPayload(stubRuntime({ sessions: many }).runtime, Date.now())
    expect(wide.sessions).toBe(PANEL_SESSION_LIMIT + 4)
    expect(wide.sessionDetails).toHaveLength(PANEL_SESSION_LIMIT)
    // Newest activity first.
    expect(wide.sessionDetails[0]?.id).toBe(
      (many.at(-1) as SessionSummary).sessionId.slice('session-'.length, 'session-'.length + 8),
    )
  })

  it('projects the ledger tail into enforcement events, dropping allow/ok bulk', async () => {
    const records = [
      {
        ts: '2026-11-12T01:00:00.000Z',
        kind: 'tool_denied',
        decision: 'deny',
        reason_code: 'tool_denied_by_name',
        tool: 'pwsh',
        severity: 'critical',
        category: 'execution',
        session: 'session-abcdef01-2345',
        rule_ids: ['danger_rm', 'inform_05', 'extra_rule', 'r4', 'r5', 'r6', 'r7'],
        args_sha256: 'f'.repeat(64),
      },
      // Bulk: every allowed call writes one of these; they must not reach the panel.
      { ts: '2026-11-12T01:00:01.000Z', kind: 'tool_checked', decision: 'allow', session: 'session-abcdef01-2345' },
      { ts: '2026-11-12T01:00:02.000Z', kind: 'output_reviewed', decision: 'allow', reason_code: 'none' },
      // An approval request, a flagged result and a warn-mode input denial.
      { ts: '2026-11-12T01:00:03.000Z', kind: 'approval_asked', decision: 'asked', reason_code: 'approval_delegated', tool: 'write', session: 'session-99aa00bb-0001' },
      { ts: '2026-11-12T01:00:04.000Z', kind: 'tool_result_flagged', decision: 'block', reason_code: 'credential_leak', tool: 'read', session: 'session-abcdef01-2345' },
      { ts: '2026-11-12T01:00:05.000Z', kind: 'input_denied', decision: 'warn', reason_code: 'input_sql_dangerous' },
      // The error result of a denied call is observation, not a disposition.
      { ts: '2026-11-12T01:00:06.000Z', kind: 'tool_result', decision: 'error', tool: 'pwsh', session: 'session-abcdef01-2345' },
    ]
    const { runtime, queries } = stubRuntime({
      sessions: [summary('session-abcdef01-2345', { workspace: 'F:\\AgentSecurity\\Upear' })],
      query: async () => records,
    })
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(queries).toEqual([{ limit: PANEL_SCAN_LIMIT }])
    expect(payload.recentEvents.map(event => event.kind)).toEqual([
      'tool_denied', 'approval_asked', 'tool_result_flagged', 'input_denied',
    ])
    expect(payload.recentEvents[0]).toEqual({
      ts: '2026-11-12T01:00:00.000Z',
      kind: 'tool_denied',
      decision: 'deny',
      reasonCode: 'tool_denied_by_name',
      tool: 'pwsh',
      severity: 'critical',
      category: 'execution',
      ruleIds: ['danger_rm', 'inform_05', 'extra_rule', 'r4', 'r5', 'r6'],
      rules: 7,
      session: 'abcdef01',
      workspace: 'F:\\AgentSecurity\\Upear',
      argsHash: 'ffffffff',
    })
    // A different session keeps its own short id and has no workspace known here.
    expect(payload.recentEvents[1]?.session).toBe('99aa00bb')
    expect(payload.recentEvents[1]?.workspace).toBeUndefined()
    // A record with no session at all still projects cleanly.
    expect(payload.recentEvents[3]).toEqual({
      ts: '2026-11-12T01:00:05.000Z',
      kind: 'input_denied',
      decision: 'warn',
      reasonCode: 'input_sql_dangerous',
      ruleIds: [],
      rules: 0,
    })
    expect(payload.eventWindow).toEqual({
      scanned: 7,
      kept: 4,
      since: '2026-11-12T01:00:00.000Z',
    })
  })

  it('keeps only the newest PAGE events of a long ledger tail', async () => {
    const records = Array.from({ length: 150 }, (_, index) => ({
      ts: new Date(Date.UTC(2026, 10, 12, 1, 0, index % 60, index)).toISOString(),
      kind: 'tool_denied',
      decision: 'deny',
      reason_code: 'tool_denied_by_args',
      tool: 'pwsh',
      rule_ids: ['r1'],
      session: 'session-01234567-89ab',
    }))
    const { runtime } = stubRuntime({ query: async () => records })
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(payload.eventWindow.scanned).toBe(150)
    expect(payload.recentEvents).toHaveLength(PANEL_EVENT_LIMIT)
    // Oldest-first: the kept window is the tail, not the head.
    expect(payload.recentEvents.at(-1)?.ts).toBe(records.at(-1)?.ts)
  })

  it('survives a dead ledger and a dead session store', async () => {
    const { runtime } = stubRuntime({ queryThrows: true, listThrows: true })
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(payload.recentEvents).toEqual([])
    expect(payload.sessionDetails).toEqual([])
    expect(payload.eventWindow).toEqual({ scanned: 0, kept: 0, since: null })
    // The rest of the payload is still the honest status.
    expect(payload.preset).toBe('balanced')
    expect(payload.ledger.records).toBe(7)
  })

  it('falls back to the built-in engine when no fact provider is wired', async () => {
    const { runtime } = stubRuntime()
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(payload.engine).toEqual({ kind: 'builtin', status: 'ready', rulesStale: false, pending: 0, badLines: 0 })
  })

  it('shortens session ids without inventing a workspace', async () => {
    expect(shortSessionId('session-0123456789abcdef')).toBe('01234567')
    expect(shortSessionId('bare-id')).toBe('bare-id')
    const { runtime } = stubRuntime({
      query: async () => [{
        ts: '2026-11-12T01:00:00.000Z', kind: 'error', reason_code: 'internal_error',
      }],
    })
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(payload.recentEvents).toHaveLength(1)
    expect(payload.recentEvents[0]?.session).toBeUndefined()
    expect(payload.recentEvents[0]?.workspace).toBeUndefined()
  })

  it('is lossless JSON (the RPC envelope must serialize)', async () => {
    const { runtime } = stubRuntime({
      sessions: [summary('session-abcdef01-2345', { workspace: 'F:\\AgentSecurity\\Upear' })],
      query: async () => [{
        ts: '2026-11-12T01:00:00.000Z',
        kind: 'tool_denied',
        decision: 'deny',
        reason_code: 'tool_denied_by_chain',
        tool: 'pwsh',
        session: 'session-abcdef01-2345',
        rule_ids: ['chain_1'],
      }],
    })
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})
