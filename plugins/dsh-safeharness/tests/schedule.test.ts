/**
 * The optional patrol timer: interval validation, persistence, arming and
 * disposal. Uses fake timers so a 5-minute interval is testable instantly.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PANEL_SCHEDULE_CHOICES,
  PANEL_SCHEDULE_MAX_MINUTES,
  PANEL_SCHEDULE_MIN_MINUTES,
  createPatrolScheduler,
  isScheduleInterval,
} from '../src/panel/schedule.js'

/** A logger that records calls instead of writing. */
function logger(): { messages: string[]; error: (message: string) => void } {
  const messages: string[] = []
  return { messages, error: (message: string) => { messages.push(message) } }
}

/** One clean temp directory for a schedule file. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sh-schedule-'))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('schedule interval validation', () => {
  it('accepts only integers inside the documented bounds', () => {
    expect(isScheduleInterval(PANEL_SCHEDULE_MIN_MINUTES)).toBe(true)
    expect(isScheduleInterval(PANEL_SCHEDULE_MAX_MINUTES)).toBe(true)
    expect(isScheduleInterval(30)).toBe(true)
    for (const bad of [4, 1_441, 30.5, '30', null, undefined, Number.NaN]) {
      expect(isScheduleInterval(bad)).toBe(false)
    }
    expect(PANEL_SCHEDULE_CHOICES.every(isScheduleInterval)).toBe(true)
  })
})

describe('createPatrolScheduler', () => {
  it('arms, persists, fires and disarms', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T04:00:00.000Z'))
    let runs = 0
    const dir = tempDir()
    const path = join(dir, 'panel-state.json')
    const scheduler = createPatrolScheduler({
      run: async () => { runs += 1 },
      statePath: path,
      logger: logger(),
    })
    expect(scheduler.snapshot()).toEqual({ enabled: false, intervalMinutes: null, nextAt: null, lastRunAt: null, persisted: false })

    const armed = scheduler.set(true, 1)
    expect(armed.enabled).toBe(true)
    expect(armed.intervalMinutes).toBe(1)
    expect(armed.nextAt).toBe(Date.now() + 60_000)
    expect(armed.persisted).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, enabled: true, intervalMinutes: 1 })

    await vi.advanceTimersByTimeAsync(60_000)
    expect(runs).toBe(1)
    const afterTick = scheduler.snapshot()
    expect(afterTick.lastRunAt).toBe(Date.now())
    expect(afterTick.nextAt).toBe(Date.now() + 60_000)

    const off = scheduler.set(false, null)
    expect(off).toEqual({ enabled: false, intervalMinutes: null, nextAt: null, lastRunAt: Date.now(), persisted: true })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(runs).toBe(1)
    scheduler.dispose()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, enabled: false, intervalMinutes: null })
  })

  it('restores an enabled schedule from disk on the next load', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T04:00:00.000Z'))
    const path = join(tempDir(), 'panel-state.json')
    writeFileSync(path, JSON.stringify({ version: 1, enabled: true, intervalMinutes: 15 }))
    const scheduler = createPatrolScheduler({ run: async () => undefined, statePath: path, logger: logger() })
    const snapshot = scheduler.snapshot()
    expect(snapshot.enabled).toBe(true)
    expect(snapshot.intervalMinutes).toBe(15)
    expect(snapshot.nextAt).toBe(Date.now() + 15 * 60_000)
    scheduler.dispose()
  })

  it('ignores an unreadable, corrupt or out-of-range file', () => {
    const dir = tempDir()
    const contents = ['not json', '{}', '{"version":1,"enabled":true,"intervalMinutes":2}']
    contents.forEach((content, index) => {
      const path = join(dir, `state-${index}.json`)
      writeFileSync(path, content)
      const scheduler = createPatrolScheduler({ run: async () => undefined, statePath: path, logger: logger() })
      expect(scheduler.snapshot().enabled).toBe(false)
      scheduler.dispose()
    })
  })

  it('degrades to memory-only when the state file cannot be written', () => {
    const dir = tempDir()
    // The path is a directory, so the atomic write fails.
    const scheduler = createPatrolScheduler({ run: async () => undefined, statePath: dir, logger: logger() })
    const armed = scheduler.set(true, 5)
    expect(armed.enabled).toBe(true)
    expect(armed.persisted).toBe(false)
    scheduler.dispose()
  })

  it('does not re-arm after dispose', async () => {
    vi.useFakeTimers()
    let runs = 0
    const scheduler = createPatrolScheduler({
      run: async () => { runs += 1 },
      statePath: join(tempDir(), 'panel-state.json'),
      logger: logger(),
    })
    scheduler.set(true, 1)
    scheduler.dispose()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(runs).toBe(0)
    expect(scheduler.snapshot().nextAt).toBeNull()
  })

  it('logs and keeps going when the scheduled run throws', async () => {
    vi.useFakeTimers()
    const log = logger()
    const scheduler = createPatrolScheduler({
      run: async () => { throw new Error('boom') },
      statePath: join(tempDir(), 'panel-state.json'),
      logger: log,
    })
    scheduler.set(true, 1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(log.messages).toContain('safeharness: scheduled patrol failed unexpectedly')
    expect(scheduler.snapshot().lastRunAt).not.toBeNull()
    scheduler.dispose()
  })
})
