/**
 * Session state: the bounded trail chain rules read, plus counters and the
 * LRU bound that keeps a long-lived host from growing one entry per session.
 */
import { describe, expect, it } from 'vitest'
import { MAX_SESSIONS, MAX_TRAIL, SessionStateStore } from '../src/state.js'
import type { ToolView } from '../src/engine/types.js'

/** Build a minimal tool view. */
function view(name: string, tags: string[] = []): ToolView {
  return { name, arguments: {}, argsBytes: 2, tags }
}

describe('SessionStateStore', () => {
  it('isolates sessions', () => {
    const store = new SessionStateStore()
    store.recordToolCall('s1', view('bash'))
    store.recordToolCall('s2', view('web_search', ['network']))
    expect(store.view('s1').trail.map((entry) => entry.name)).toEqual(['bash'])
    expect(store.view('s2').trail.map((entry) => entry.name)).toEqual(['web_search'])
    expect(store.view('s1').totalCalls).toBe(1)
  })

  it('bounds the retained trail but keeps the total count', () => {
    const store = new SessionStateStore()
    for (let index = 0; index < MAX_TRAIL + 10; index += 1) store.recordToolCall('s', view(`tool_${index}`))
    const state = store.view('s')
    expect(state.trail.length).toBe(MAX_TRAIL)
    expect(state.totalCalls).toBe(MAX_TRAIL + 10)
    // The oldest entries were evicted; the newest is retained.
    expect(state.trail.at(-1)?.name).toBe(`tool_${MAX_TRAIL + 9}`)
    expect(state.trail.at(0)?.name).toBe('tool_10')
  })

  it('numbers trail entries monotonically for gap arithmetic', () => {
    const store = new SessionStateStore()
    store.recordToolCall('s', view('a'))
    store.recordToolCall('s', view('b'))
    expect(store.view('s').trail.map((entry) => entry.seq)).toEqual([0, 1])
  })

  it('counts decisions globally and per session', () => {
    const store = new SessionStateStore()
    store.count('s1', 'allow')
    store.count('s1', 'deny')
    store.count('s2', 'warn')
    const total = store.counters()
    expect(total).toEqual({ allow: 1, deny: 1, ask: 0, warn: 1 })
    expect(store.view('s1').trail).toEqual([])
  })

  it('evicts the least recently touched session beyond the bound', () => {
    const store = new SessionStateStore()
    for (let index = 0; index < MAX_SESSIONS; index += 1) store.of(`s${index}`)
    expect(store.size).toBe(MAX_SESSIONS)
    store.of('fresh')
    expect(store.size).toBe(MAX_SESSIONS)
  })

  it('forgets one session on demand', () => {
    const store = new SessionStateStore()
    store.of('gone')
    store.forget('gone')
    expect(store.size).toBe(0)
  })

  it('tolerates a missing session id and records its own errors', () => {
    const store = new SessionStateStore()
    const state = store.of(undefined)
    expect(state.sessionId).toBe('unknown')
  })

  it('describes a session once and lists newest-first without mutating order', () => {
    const store = new SessionStateStore()
    store.describe('s1', { workspace: 'F:\\AgentSecurity\\Upear', createdAt: 1_759_000_000_000 })
    store.count('s1', 'deny')
    store.recordToolCall('s1', view('pwsh'))
    store.describe('s1', { workspace: 'should-not-overwrite' })
    const page = store.list()
    expect(page).toEqual([{
      sessionId: 's1',
      workspace: 'F:\\AgentSecurity\\Upear',
      createdAt: 1_759_000_000_000,
      touchedAt: expect.any(Number),
      totalCalls: 1,
      counters: { allow: 0, deny: 1, ask: 0, warn: 0 },
    }])
    // A no-op describe must not invent an entry.
    store.describe(undefined, {})
    expect(store.size).toBe(1)
  })

  it('bounds the listed session page and keeps a bad limit usable', () => {
    const store = new SessionStateStore()
    for (let index = 0; index < 5; index += 1) store.of(`s${index}`)
    expect(store.list(2)).toHaveLength(2)
    // A non-positive or unsafe limit falls back to the default page size.
    expect(store.list(0)).toHaveLength(5)
    expect(store.list(Number.NaN)).toHaveLength(5)
    expect(store.list(50)).toHaveLength(5)
  })
})
