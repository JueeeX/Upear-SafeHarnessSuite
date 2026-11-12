/**
 * Per-session observation state: the bounded tool trail chain rules read, plus
 * the counters `safeharness_status` reports.
 *
 * Keyed by session id (a string) rather than by the live `Agent` object so the
 * same state is reachable from hooks that only carry a session id (`llm/stream`
 * carries `options.sessionId`). The store is LRU-bounded: a long-lived host must
 * not accumulate one entry per session forever.
 * @module
 */
import type { SessionView, ToolTrailEntry, ToolView } from './engine/types.js'

/** Maximum tool calls retained per session for chain evaluation. */
export const MAX_TRAIL = 64
/** Maximum sessions tracked at once (LRU eviction beyond this). */
export const MAX_SESSIONS = 256
/** Default page size for {@link SessionStateStore.list}. */
export const MAX_LISTED_SESSIONS = 50

/** Aggregate counters across all live sessions. */
export interface CounterSnapshot {
  readonly allow: number
  readonly deny: number
  readonly ask: number
  readonly warn: number
}

/** One session's mutable observation state. */
export interface SessionState {
  readonly sessionId: string
  /** Oldest-first trail of observed tool calls. */
  trail: ToolTrailEntry[]
  /** Total tool calls observed (may exceed the retained trail length). */
  totalCalls: number
  /** Per-session decision counters. */
  counters: { allow: number; deny: number; ask: number; warn: number }
  /** Last time this session produced an event (epoch ms), for LRU. */
  touchedAt: number
  /**
   * Absolute project directory the session was created in, when the host
   * exposed it. A path only: never conversation content (§6.8).
   */
  workspace?: string
  /** Epoch ms the session was created, when the host exposed it. */
  createdAt?: number
  /**
   * Latest session title the host's title service reported. A session title is
   * session metadata (the user may rename it; otherwise a title provider
   * suggests it), shown by the panel only — never written to the ledger and
   * never sent to a model by this plugin.
   */
  title?: string
}

/** Read-only, panel-facing summary of one tracked session. */
export interface SessionSummary {
  /** Session id exactly as the ledger records it (`session-<uuid>`). */
  readonly sessionId: string
  /** Project directory, when known. */
  readonly workspace?: string
  /** Session creation time (epoch ms), when known. */
  readonly createdAt?: number
  /** Latest title the host reported, when known. */
  readonly title?: string
  /** Last time the session produced an event (epoch ms). */
  readonly touchedAt: number
  /** Tool calls observed for this session. */
  readonly totalCalls: number
  /** Per-session decision counters. */
  readonly counters: Readonly<{ allow: number; deny: number; ask: number; warn: number }>
}

/** A minimal, structural view of a DSH session event (no DSH import). */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
}

/**
 * Bounded store of {@link SessionState} instances.
 *
 * Not thread-safe by construction — DSH is single-threaded and every hook runs on
 * the same event loop. Calls interleave only at `await` points, and no method here
 * awaits, so a tool decision sees a consistent trail.
 */
export class SessionStateStore {
  private readonly sessions = new Map<string, SessionState>()

  /** Get (or create) the state for one session id. */
  of(sessionId: string | undefined): SessionState {
    const key = sessionId !== undefined && sessionId.length > 0 ? sessionId : 'unknown'
    const existing = this.sessions.get(key)
    if (existing !== undefined) {
      existing.touchedAt = Date.now()
      // Refresh LRU order: Map preserves insertion order, so re-insert.
      this.sessions.delete(key)
      this.sessions.set(key, existing)
      return existing
    }
    const created: SessionState = {
      sessionId: key,
      trail: [],
      totalCalls: 0,
      counters: { allow: 0, deny: 0, ask: 0, warn: 0 },
      touchedAt: Date.now(),
    }
    this.sessions.set(key, created)
    this.evictIfNeeded()
    return created
  }

  /** Read-only engine projection of one session. */
  view(sessionId: string | undefined): SessionView {
    const state = this.of(sessionId)
    return {
      sessionId: state.sessionId,
      trail: state.trail,
      totalCalls: state.totalCalls,
    }
  }

  /** Record one tool call in the session trail (bounded). */
  recordToolCall(sessionId: string | undefined, view: ToolView): void {
    const state = this.of(sessionId)
    state.trail.push({ name: view.name, tags: [...view.tags], seq: state.totalCalls })
    state.totalCalls += 1
    if (state.trail.length > MAX_TRAIL) state.trail.splice(0, state.trail.length - MAX_TRAIL)
  }

  /** Count one decision outcome (allow/deny/ask/warn). */
  count(sessionId: string | undefined, outcome: 'allow' | 'deny' | 'ask' | 'warn'): void {
    const state = this.of(sessionId)
    state.counters[outcome] += 1
  }

  /**
   * Remember the durable facts the panel uses to tell sessions apart.
   *
   * Called from the seams that carry a live `Agent`; a session the host created
   * without metadata simply keeps the fields undefined and the panel shows the
   * id alone. Workspace/createdAt are first-write-wins; the title is
   * latest-wins, because a user rename or a later provider suggestion must
   * replace an earlier value.
   */
  describe(sessionId: string | undefined, facts: { workspace?: string; createdAt?: number; title?: string }): void {
    if (facts.workspace === undefined && facts.createdAt === undefined && facts.title === undefined) return
    const state = this.of(sessionId)
    if (state.workspace === undefined && facts.workspace !== undefined) state.workspace = facts.workspace
    if (state.createdAt === undefined && facts.createdAt !== undefined) state.createdAt = facts.createdAt
    if (facts.title !== undefined && facts.title.length > 0) state.title = facts.title
  }

  /**
   * Newest-first snapshot of tracked sessions (bounded, non-mutating).
   *
   * The panel renders this instead of the ledger so a session remains visible
   * before its first denial, and so the displayed counters match this process.
   *
   * @param limit - page size; defaults to {@link MAX_LISTED_SESSIONS}.
   */
  list(limit: number = MAX_LISTED_SESSIONS): SessionSummary[] {
    const pageSize = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_SESSIONS) : MAX_LISTED_SESSIONS
    const summaries: SessionSummary[] = []
    for (const state of this.sessions.values()) {
      summaries.push({
        sessionId: state.sessionId,
        ...(state.workspace === undefined ? {} : { workspace: state.workspace }),
        ...(state.createdAt === undefined ? {} : { createdAt: state.createdAt }),
        ...(state.title === undefined ? {} : { title: state.title }),
        touchedAt: state.touchedAt,
        totalCalls: state.totalCalls,
        counters: { ...state.counters },
      })
    }
    summaries.sort((left, right) => right.touchedAt - left.touchedAt)
    return summaries.slice(0, pageSize)
  }

  /** Feed one `session/event`. Only the trail-relevant facts are inspected. */
  observe(event: SessionEventLike): void {
    // Turn boundaries are not needed by chain rules (they use call distance), and
    // reading message content here would duplicate what the input hook already
    // hashes. Kept as a hook seam so a future chain rule can use turn numbers.
    void event
  }

  /** Aggregate counters across every live session. */
  counters(): CounterSnapshot {
    const total = { allow: 0, deny: 0, ask: 0, warn: 0 }
    for (const state of this.sessions.values()) {
      total.allow += state.counters.allow
      total.deny += state.counters.deny
      total.ask += state.counters.ask
      total.warn += state.counters.warn
    }
    return total
  }

  /** Number of sessions currently tracked (status output). */
  get size(): number {
    return this.sessions.size
  }

  /** Forget one session (e.g. after it ends). */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Drop the least-recently-touched sessions beyond {@link MAX_SESSIONS}. */
  private evictIfNeeded(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) return
      this.sessions.delete(oldest.value)
    }
  }
}
