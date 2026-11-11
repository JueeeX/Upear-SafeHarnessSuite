/**
 * Per-turn token budget tests (T3.5).
 *
 * The guard is deliberately dumb and testable: it accumulates `input + output`
 * tokens for one agent-loop turn, flips `exceeded` exactly once, and resets on the
 * next turn. Whether the crossing becomes an audit line is the hook's job
 * (covered by tests/output.test.ts), so nothing here touches a ledger.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { BudgetGuard, MAX_BUDGET_SESSIONS } from '../src/budget.js'

/** A guard with the given per-turn limit. */
function guard(limit: number): BudgetGuard {
  return new BudgetGuard({ limit })
}

describe('BudgetGuard', () => {
  it('is disabled at limit 0 and never flips the flag', () => {
    const budget = guard(0)
    expect(budget.enabled).toBe(false)
    const snapshot = budget.record('s1', { inputTokens: 10_000, outputTokens: 10_000 })
    expect(snapshot.exceeded).toBe(false)
    expect(snapshot.used).toBe(20_000)
  })

  it('treats a negative or non-finite limit as disabled', () => {
    expect(guard(-5).enabled).toBe(false)
    expect(guard(Number.NaN).enabled).toBe(false)
  })

  it('accumulates input + output and flips exactly on the crossing call', () => {
    const budget = guard(10)
    expect(budget.record('s1', { inputTokens: 4, outputTokens: 2 }).exceeded).toBe(false)
    const crossing = budget.record('s1', { inputTokens: 3, outputTokens: 2 })
    expect(crossing.used).toBe(11)
    expect(crossing.exceeded).toBe(true)
  })

  it('keeps the flag sticky for the rest of the turn', () => {
    const budget = guard(5)
    budget.record('s1', { inputTokens: 100, outputTokens: 0 })
    const later = budget.record('s1', { inputTokens: 1, outputTokens: 1 })
    expect(later.exceeded).toBe(true)
    expect(later.used).toBe(102)
  })

  it('is idempotent for the same turn number', () => {
    const budget = guard(10)
    budget.beginTurn('s1', 3)
    budget.record('s1', { inputTokens: 20, outputTokens: 0 })
    budget.beginTurn('s1', 3)
    expect(budget.snapshot('s1').used).toBe(20)
    expect(budget.snapshot('s1').exceeded).toBe(true)
  })

  it('resets usage and the flag on a new turn', () => {
    const budget = guard(10)
    budget.beginTurn('s1', 1)
    budget.record('s1', { inputTokens: 50, outputTokens: 0 })
    expect(budget.snapshot('s1').exceeded).toBe(true)
    budget.beginTurn('s1', 2)
    const fresh = budget.snapshot('s1')
    expect(fresh.turn).toBe(2)
    expect(fresh.used).toBe(0)
    expect(fresh.exceeded).toBe(false)
  })

  it('falls back to totalTokens when input/output are missing', () => {
    const budget = guard(10)
    expect(budget.record('s1', { totalTokens: 12 }).used).toBe(12)
  })

  it('ignores an empty or negative usage report', () => {
    const budget = guard(10)
    expect(budget.record('s1', {}).used).toBe(0)
    expect(budget.record('s1', { inputTokens: -3, outputTokens: Number.NaN }).used).toBe(0)
  })

  it('shares one bucket for callers without a session id', () => {
    const budget = guard(10)
    budget.record(undefined, { inputTokens: 4, outputTokens: 0 })
    const snapshot = budget.record('', { inputTokens: 9, outputTokens: 0 })
    expect(snapshot.sessionId).toBe('unknown')
    expect(snapshot.used).toBe(13)
  })

  it('applies a hot-reloaded limit to the current turn', () => {
    const budget = guard(0)
    budget.record('s1', { inputTokens: 5, outputTokens: 0 })
    budget.setLimit(3)
    expect(budget.limitValue).toBe(3)
    // A disabled guard never set a flag, so the crossing is detected on the next call.
    expect(budget.record('s1', { inputTokens: 0, outputTokens: 0 }).exceeded).toBe(false)
    expect(budget.record('s1', { inputTokens: 1, outputTokens: 0 }).exceeded).toBe(true)
  })

  it('clears the flag when the limit is switched off', () => {
    const budget = guard(1)
    budget.record('s1', { inputTokens: 5, outputTokens: 0 })
    expect(budget.snapshot('s1').exceeded).toBe(true)
    budget.setLimit(0)
    expect(budget.snapshot('s1').exceeded).toBe(false)
  })

  it('bounds the number of tracked sessions', () => {
    const budget = guard(1000)
    for (let index = 0; index < MAX_BUDGET_SESSIONS + 20; index += 1) {
      budget.beginTurn(`s-${index}`, 1)
    }
    expect(budget.size).toBe(MAX_BUDGET_SESSIONS)
    // The oldest sessions were evicted, the newest survived.
    expect(budget.snapshot('s-0').used).toBe(0)
    expect(budget.snapshot(`s-${MAX_BUDGET_SESSIONS + 19}`).sessionId).toBe(`s-${MAX_BUDGET_SESSIONS + 19}`)
  })

  it('forgets one session on reset', () => {
    const budget = guard(10)
    budget.record('s1', { inputTokens: 5, outputTokens: 0 })
    budget.reset('s1')
    expect(budget.snapshot('s1').used).toBe(0)
    expect(budget.size).toBe(0)
  })

  it('reads a snapshot without creating an entry', () => {
    const budget = guard(10)
    expect(budget.snapshot('never-seen').used).toBe(0)
    expect(budget.size).toBe(0)
  })
})
