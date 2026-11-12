/**
 * Optional patrol timer for the panel.
 *
 * The plugin deliberately does not own a general scheduler; this is the one
 * timer the panel needs so an operator can say "check every 30 minutes" without
 * setting up an OS task. Scope is intentionally tiny: an interval, persisted in
 * a plugin-owned JSON file, running the same patrol the panel button and the
 * `/safeharness patrol` command run.
 *
 * Safety notes:
 *  - the timer never overlaps a run (the shared {@link PatrolRunner} enforces it);
 *  - the cooldown belongs to operator-triggered runs, so a scheduled run is not
 *    rejected just because someone clicked the button moments earlier;
 *  - a write failure degrades to memory-only and is reported in the snapshot;
 *  - `dispose()` clears the pending timer, so unloading the plugin stops it.
 * @module
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PanelSchedule } from './protocol.js'

/** Smallest interval the panel accepts, in minutes. */
export const PANEL_SCHEDULE_MIN_MINUTES = 5

/** Largest interval the panel accepts, in minutes (one day). */
export const PANEL_SCHEDULE_MAX_MINUTES = 1_440

/** Intervals the panel offers in its select (minutes). */
export const PANEL_SCHEDULE_CHOICES: readonly number[] = [5, 15, 30, 60, 180, 360, 720, 1_440]

/** Persisted shape of the schedule file (versioned for a future field). */
interface StoredSchedule {
  readonly version: 1
  readonly enabled: boolean
  readonly intervalMinutes: number | null
}

/** What the panel needs from a scheduler. */
export interface PatrolScheduler {
  /** Current schedule, including the next/last run instants. */
  snapshot(): PanelSchedule
  /** Replace the schedule and persist it. */
  set(enabled: boolean, intervalMinutes: number | null): PanelSchedule
  /** Stop the timer and release it. */
  dispose(): void
}

/** Options for {@link createPatrolScheduler}. */
export interface PatrolSchedulerOptions {
  /** One scheduled patrol; must not throw (the runner already maps failures). */
  readonly run: () => Promise<void>
  /** Absolute JSON file the schedule persists to. */
  readonly statePath: string
  /** Logger for persistence failures (never receives content). */
  readonly logger: { error: (message: string, ...rest: unknown[]) => void }
  /** Clock, injectable for tests. */
  readonly now?: () => number
}

/** True when `value` is an integer inside the accepted interval range. */
export function isScheduleInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= PANEL_SCHEDULE_MIN_MINUTES && value <= PANEL_SCHEDULE_MAX_MINUTES
}

/** Read the stored schedule, or null when absent/unreadable. */
function readStored(path: string): StoredSchedule | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredSchedule>
    if (parsed.version !== 1 || typeof parsed.enabled !== 'boolean') return null
    const interval = parsed.intervalMinutes
    if (parsed.enabled) {
      if (!isScheduleInterval(interval)) return null
      return { version: 1, enabled: true, intervalMinutes: interval }
    }
    return { version: 1, enabled: false, intervalMinutes: null }
  } catch {
    return null
  }
}

/** Write the schedule atomically; returns false on failure. */
function writeStored(path: string, stored: StoredSchedule, logger: PatrolSchedulerOptions['logger']): boolean {
  const tmp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, `${JSON.stringify(stored)}\n`, { encoding: 'utf8' })
    renameSync(tmp, path)
    return true
  } catch {
    logger.error('safeharness: could not persist the panel patrol schedule')
    try {
      writeFileSync(tmp, '', 'utf8')
    } catch {
      // best effort: the temp file is inside the plugin-owned directory
    }
    return false
  }
}

/**
 * Create the scheduler and arm it from the persisted file (if enabled).
 *
 * @param options - runner, state path, logger and clock.
 * @returns the scheduler the route/status read from.
 */
export function createPatrolScheduler(options: PatrolSchedulerOptions): PatrolScheduler {
  const now = options.now ?? (() => Date.now())
  const stored = readStored(options.statePath)
  let enabled = stored?.enabled === true
  let intervalMinutes: number | null = stored?.intervalMinutes ?? null
  let nextAt: number | null = null
  let lastRunAt: number | null = null
  let persisted = stored !== null
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    nextAt = null
  }

  /** Schedule the next run; a recursive timeout cannot accumulate ticks. */
  const armNext = (): void => {
    clearTimer()
    if (disposed || !enabled || intervalMinutes === null) return
    const wait = intervalMinutes * 60_000
    nextAt = now() + wait
    timer = setTimeout(() => {
      void tick()
    }, wait)
    // A security plugin must not be the reason the host process stays alive.
    timer.unref?.()
  }

  /** One timer tick: run patrol, then arm the next one. */
  const tick = async (): Promise<void> => {
    timer = undefined
    nextAt = null
    try {
      await options.run()
    } catch {
      // The runner maps failures; a throw here is a wiring bug, not a patrol result.
      options.logger.error('safeharness: scheduled patrol failed unexpectedly')
    } finally {
      lastRunAt = now()
    }
    armNext()
  }

  armNext()

  return {
    snapshot(): PanelSchedule {
      return {
        enabled,
        intervalMinutes: enabled ? intervalMinutes : null,
        nextAt: enabled ? nextAt : null,
        lastRunAt,
        persisted,
      }
    },
    set(nextEnabled: boolean, nextInterval: number | null): PanelSchedule {
      enabled = nextEnabled
      intervalMinutes = nextEnabled ? nextInterval : null
      persisted = writeStored(
        options.statePath,
        { version: 1, enabled, intervalMinutes: enabled ? intervalMinutes : null },
        options.logger,
      )
      armNext()
      return this.snapshot()
    },
    dispose(): void {
      disposed = true
      clearTimer()
    },
  }
}
