/**
 * The shared patrol gate: one run at a time, cooldown for operator clicks only,
 * and a throw mapped to a coded outcome.
 */
import { describe, expect, it } from 'vitest'
import { createPatrolRunner } from '../src/panel/patrol-runner.js'
import type { PatrolReport } from '../src/patrol/index.js'

/** A minimal report the runner only passes through. */
function report(): PatrolReport {
  return {
    ranAt: '2026-11-12T04:00:00.000Z',
    exitCode: 0,
    summary: { fail: 0, warn: 0, ok: 1, skip: 0, clean: true },
    findings: [],
    notified: false,
  } as PatrolReport
}

describe('createPatrolRunner', () => {
  it('runs one patrol at a time', async () => {
    let release: (() => void) | undefined
    const runner = createPatrolRunner(() => new Promise<PatrolReport>((resolve) => {
      release = () => { resolve(report()) }
    }))
    const first = runner.run()
    expect(runner.busy()).toBe(true)
    const second = await runner.run()
    expect(second).toEqual({ ok: false, code: 'patrol_in_progress' })
    release?.()
    expect(await first).toMatchObject({ ok: true })
    expect(runner.busy()).toBe(false)
  })

  it('applies the cooldown to operator runs only', async () => {
    let clock = 1_000
    let calls = 0
    const runner = createPatrolRunner(async () => { calls += 1; return report() }, { now: () => clock, cooldownMs: 5_000 })
    expect((await runner.run()).ok).toBe(true)
    expect(await runner.run()).toEqual({ ok: false, code: 'patrol_cooldown' })
    // A timer run is not blocked by a manual click moments earlier.
    expect((await runner.runScheduled()).ok).toBe(true)
    clock += 6_000
    expect((await runner.run()).ok).toBe(true)
    expect(calls).toBe(3)
  })

  it('keeps the cooldown after a scheduled run too', async () => {
    let clock = 1_000
    const runner = createPatrolRunner(async () => report(), { now: () => clock, cooldownMs: 5_000 })
    await runner.runScheduled()
    expect(await runner.run()).toEqual({ ok: false, code: 'patrol_cooldown' })
    clock += 5_000
    expect((await runner.run()).ok).toBe(true)
  })

  it('maps a throw to patrol_failed and still records the finish time', async () => {
    const runner = createPatrolRunner(async () => { throw new Error('boom') }, { now: () => 42 })
    expect(await runner.run()).toEqual({ ok: false, code: 'patrol_failed' })
    expect(runner.lastFinishedAt()).toBe(42)
  })
})
