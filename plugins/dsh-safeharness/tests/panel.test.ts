/**
 * The panel payload builder (T5.3).
 *
 * What matters here is not the wiring but the projection: the browser must only
 * ever see coarse facts, the denial list must come from the ledger with the
 * deny filter applied, and a dead ledger must degrade to an empty list rather
 * than failing the whole panel.
 */
import { describe, expect, it } from 'vitest'
import { PANEL_RECENT_LIMIT, buildPanelPayload } from '../src/panel/status.js'
import type { Runtime } from '../src/runtime.js'
import type { AuditQuery } from '../src/audit/types.js'

/** A runtime-shaped stub: the builder reads exactly these fields. */
function stubRuntime(options: {
  readonly query?: (query?: AuditQuery) => Promise<unknown[]>
  readonly queryThrows?: boolean
} = {}): { runtime: Runtime; queries: AuditQuery[] } {
  const queries: AuditQuery[] = []
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
      stats: { enabled: true, writable: true, records: 7, failures: 1, lastWriteAt: 1_760_000_000_000 },
      query: async (query?: AuditQuery) => {
        if (query !== undefined) queries.push(query)
        if (options.queryThrows === true) throw new Error('ledger closed')
        return options.query?.(query) ?? []
      },
    },
    state: { size: 2 },
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
    expect(payload.sessions).toBe(2)
    expect(payload.rules).toEqual({ hash: 'aaaaaaaaaaaa', count: 20, chains: 3 })
    expect(payload.modes).toEqual({
      input: 'enforce', tools: 'enforce', results: 'warn', output: 'warn', approval: 'delegate',
    })
    expect(payload.counters).toEqual({
      allow: 5, warn: 2, deny: 3, ask: 1, auditBlocked: 0, internalErrors: 4,
    })
    expect(payload.ledger).toEqual({
      enabled: true, writable: true, records: 7, failures: 1, lastWriteAt: 1_760_000_000_000,
    })
    expect(payload.engine.kind).toBe('builtin')
    expect(payload.uptimeMs).toBeGreaterThanOrEqual(0)
    expect(payload.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u)
  })

  it('reads the newest denials from the ledger with the deny filter', async () => {
    const { runtime, queries } = stubRuntime({
      query: async () => [
        {
          ts: '2026-11-12T01:00:00.000Z',
          kind: 'tool_denied',
          reason_code: 'sql_dangerous',
          tool: 'db_query',
          rule_ids: ['dangerous_sql', 'batch'],
        },
        // A record with none of the optional fields must still project cleanly.
        { ts: '2026-11-12T01:00:01.000Z', kind: 'input_denied' },
      ],
    })
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(queries).toEqual([{ limit: PANEL_RECENT_LIMIT, decision: 'deny' }])
    expect(payload.recentDenials).toEqual([
      { ts: '2026-11-12T01:00:00.000Z', kind: 'tool_denied', reasonCode: 'sql_dangerous', tool: 'db_query', rules: 2 },
      { ts: '2026-11-12T01:00:01.000Z', kind: 'input_denied', reasonCode: '', rules: 0 },
    ])
  })

  it('keeps the panel alive when the ledger cannot answer', async () => {
    const { runtime } = stubRuntime({ queryThrows: true })
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(payload.recentDenials).toEqual([])
    // The rest of the payload is still the honest status.
    expect(payload.preset).toBe('balanced')
    expect(payload.ledger.records).toBe(7)
  })

  it('falls back to the built-in engine when no fact provider is wired', async () => {
    const { runtime } = stubRuntime()
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(payload.engine).toEqual({ kind: 'builtin', status: 'ready', rulesStale: false, pending: 0, badLines: 0 })
  })

  it('is lossless JSON (the RPC envelope must serialize)', async () => {
    const { runtime } = stubRuntime()
    const payload = await buildPanelPayload(runtime, Date.now())
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })
})
