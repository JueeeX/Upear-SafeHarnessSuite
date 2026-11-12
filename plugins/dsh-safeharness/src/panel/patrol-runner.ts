/**
 * One patrol at a time, shared by the panel route and the optional timer.
 *
 * The route used to own the single-flight/cooldown logic; the scheduler needs
 * the same "do not overlap" guarantee, so the logic moved here and both call
 * sites share one runner. The cooldown applies to operator-triggered runs only:
 * a timer that was just armed must not be delayed by a manual click, but two
 * timers must still never overlap.
 * @module
 */
import type { PatrolReport } from '../patrol/index.js'

/** Minimum spacing between two operator-triggered patrols. */
export const PANEL_PATROL_COOLDOWN_MS = 5_000

/** What one patrol attempt resolves to. */
export type PatrolOutcome =
  | { readonly ok: true; readonly report: PatrolReport }
  | { readonly ok: false; readonly code: 'patrol_in_progress' | 'patrol_cooldown' | 'patrol_failed' }

/** The shared patrol gate. */
export interface PatrolRunner {
  /** Operator-triggered run: single-flight plus the cooldown. */
  run(): Promise<PatrolOutcome>
  /** Timer-triggered run: single-flight only. */
  runScheduled(): Promise<PatrolOutcome>
  /** Epoch ms of the last finished run, when any. */
  lastFinishedAt(): number | undefined
  /** Whether a run is in flight right now. */
  busy(): boolean
}

/** Options for {@link createPatrolRunner}. */
export interface PatrolRunnerOptions {
  /** Cooldown between operator-triggered runs; defaults to 5 s. */
  readonly cooldownMs?: number
  /** Clock, injectable for tests. */
  readonly now?: () => number
}

/**
 * Wrap one patrol implementation with the shared gate.
 *
 * @param execute - the real patrol call (never throws by contract, but a bug
 *   still maps to `patrol_failed`).
 * @param options - cooldown and clock.
 */
export function createPatrolRunner(
  execute: () => Promise<PatrolReport>,
  options: PatrolRunnerOptions = {},
): PatrolRunner {
  const cooldownMs = options.cooldownMs ?? PANEL_PATROL_COOLDOWN_MS
  const now = options.now ?? (() => Date.now())
  let inFlight = false
  let lastFinished: number | undefined

  const attempt = async (): Promise<PatrolOutcome> => {
    inFlight = true
    try {
      const report = await execute()
      return { ok: true, report }
    } catch {
      return { ok: false, code: 'patrol_failed' }
    } finally {
      inFlight = false
      lastFinished = now()
    }
  }

  return {
    async run(): Promise<PatrolOutcome> {
      if (inFlight) return { ok: false, code: 'patrol_in_progress' }
      if (lastFinished !== undefined && now() - lastFinished < cooldownMs) {
        return { ok: false, code: 'patrol_cooldown' }
      }
      return attempt()
    },
    async runScheduled(): Promise<PatrolOutcome> {
      if (inFlight) return { ok: false, code: 'patrol_in_progress' }
      return attempt()
    },
    lastFinishedAt: () => lastFinished,
    busy: () => inFlight,
  }
}
