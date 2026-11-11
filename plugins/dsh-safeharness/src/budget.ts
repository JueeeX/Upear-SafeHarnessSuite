/**
 * Per-turn token budget guard (§6.2 `budget.maxTokensPerTurn`, T3.5).
 *
 * Scope is deliberately narrow: this is an *advisory* guard that makes a runaway
 * turn visible. It never vetoes a call — the plan asks for `warn` first — because
 * a hard token veto in the model stream would truncate a turn at an arbitrary
 * point with no way to explain why to the user. Enforcement belongs to the tool
 * and input surfaces, which have a decision channel.
 *
 * Accounting semantics (decision D10, recorded in the plan §12):
 *  * one "turn" is the agent loop's own turn number, reported by `agent/pre-step`;
 *  * `used` accumulates `inputTokens + outputTokens` across every model call in
 *    that turn — including the prompt re-sent on each step, because that is the
 *    cost actually incurred;
 *  * `exceeded` flips exactly once, on the call that crosses the limit, so the
 *    caller writes one `budget_exceeded` record per turn instead of one per step.
 * @module
 */

/** Maximum sessions tracked at once (LRU eviction beyond this). */
export const MAX_BUDGET_SESSIONS = 256

/** Token counts as the model stream reports them; every field is optional. */
export interface BudgetUsage {
  readonly inputTokens?: number
  readonly outputTokens?: number
  /** Used only when neither input nor output counts are reported. */
  readonly totalTokens?: number
}

/** One session's budget state after an update (read-only snapshot). */
export interface BudgetSnapshot {
  readonly sessionId: string
  /** Agent-loop turn number the counters belong to (0 before the first step). */
  readonly turn: number
  /** Tokens counted so far this turn (input + output). */
  readonly used: number
  /** Configured limit; `0` means the guard is disabled. */
  readonly limit: number
  /** True once this turn crossed the limit (sticky until the next turn). */
  readonly exceeded: boolean
}

/** One session's mutable accounting. */
interface TurnState {
  turn: number
  used: number
  exceeded: boolean
}

/** Options for {@link BudgetGuard}. */
export interface BudgetGuardOptions {
  /** Token limit per turn; values `<= 0` disable the guard. */
  readonly limit: number
}

/**
 * Bounded, per-session turn accounting.
 *
 * Keyed by session id (a string) so the model-stream hook, which only carries
 * `options.sessionId`, can report usage without holding an `Agent`.
 */
export class BudgetGuard {
  private readonly sessions = new Map<string, TurnState>()
  private limit: number

  constructor(options: BudgetGuardOptions) {
    this.limit = normalizeLimit(options.limit)
  }

  /** Whether the guard can ever fire (a disabled guard is skipped entirely). */
  get enabled(): boolean {
    return this.limit > 0
  }

  /** Current limit (0 = disabled). */
  get limitValue(): number {
    return this.limit
  }

  /** Number of sessions currently tracked (status output). */
  get size(): number {
    return this.sessions.size
  }

  /** Apply a hot-reloaded limit; an existing turn keeps its accumulated usage. */
  setLimit(limit: number): void {
    this.limit = normalizeLimit(limit)
  }

  /**
   * Start (or re-enter) a turn. Idempotent for the same turn number: the agent
   * loop may emit several steps of one turn, and only the first one resets.
   *
   * @param sessionId - session key; `undefined` folds into a shared bucket.
   * @param turn - the agent loop's turn number.
   */
  beginTurn(sessionId: string | undefined, turn: number): void {
    const key = keyOf(sessionId)
    const state = this.sessions.get(key)
    const normalized = Number.isFinite(turn) ? Math.trunc(turn) : 0
    if (state === undefined) {
      this.sessions.set(key, { turn: normalized, used: 0, exceeded: false })
      this.evictIfNeeded()
      return
    }
    // Re-insert to refresh LRU order (Map preserves insertion order).
    this.sessions.delete(key)
    if (state.turn !== normalized) {
      state.turn = normalized
      state.used = 0
      state.exceeded = false
    }
    this.sessions.set(key, state)
  }

  /**
   * Add one model call's usage to the current turn.
   *
   * @param sessionId - session key.
   * @param usage - token counts from the stream's `usage` chunk.
   * @returns the post-update snapshot; `exceeded` is true on the crossing call.
   */
  record(sessionId: string | undefined, usage: BudgetUsage): BudgetSnapshot {
    const key = keyOf(sessionId)
    const state = this.sessions.get(key) ?? { turn: 0, used: 0, exceeded: false }
    this.sessions.delete(key)
    const delta = usageOf(usage)
    if (delta > 0) {
      state.used += delta
      // A disabled guard never flips the flag, so a later `setLimit(0)` cannot
      // resurrect a stale "exceeded" from an earlier turn.
      if (this.limit > 0 && !state.exceeded && state.used > this.limit) state.exceeded = true
    }
    this.sessions.set(key, state)
    this.evictIfNeeded()
    return snapshotOf(key, state, this.limit)
  }

  /** Read one session's state without mutating it (creates nothing). */
  snapshot(sessionId: string | undefined): BudgetSnapshot {
    const key = keyOf(sessionId)
    const state = this.sessions.get(key) ?? { turn: 0, used: 0, exceeded: false }
    return snapshotOf(key, state, this.limit)
  }

  /** Forget one session (e.g. after it ends). */
  reset(sessionId: string | undefined): void {
    this.sessions.delete(keyOf(sessionId))
  }

  /** Drop the least-recently-used sessions beyond {@link MAX_BUDGET_SESSIONS}. */
  private evictIfNeeded(): void {
    while (this.sessions.size > MAX_BUDGET_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) return
      this.sessions.delete(oldest.value)
    }
  }
}

/** Normalize a configured limit: finite, non-negative integer (0 disables). */
function normalizeLimit(limit: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return 0
  return Math.trunc(limit)
}

/** Session key, folding every unknown-session caller into one bucket. */
function keyOf(sessionId: string | undefined): string {
  return sessionId !== undefined && sessionId.length > 0 ? sessionId : 'unknown'
}

/**
 * Token delta of one usage report.
 *
 * `input + output` is preferred because a provider that reports cache tokens still
 * bills the call; `total` is only a fallback for adapters that report nothing else.
 */
function usageOf(usage: BudgetUsage): number {
  const input = finite(usage.inputTokens)
  const output = finite(usage.outputTokens)
  if (input > 0 || output > 0) return input + output
  return finite(usage.totalTokens)
}

/** Coerce one optional count to a non-negative integer. */
function finite(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

/** Build the immutable snapshot callers see. */
function snapshotOf(sessionId: string, state: TurnState, limit: number): BudgetSnapshot {
  return {
    sessionId,
    turn: state.turn,
    used: state.used,
    limit,
    exceeded: state.exceeded && limit > 0,
  }
}
