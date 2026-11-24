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
import type { SandboxModeName } from './engine/types.js'
import { widerSandboxMode } from './engine/types.js'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Maximum tool calls retained per session for chain evaluation. */
export const MAX_TRAIL = 64
/** Maximum sessions tracked at once (LRU eviction beyond this). */
export const MAX_SESSIONS = 256
/** Default page size for {@link SessionStateStore.list}. */
export const MAX_LISTED_SESSIONS = 50
/** Maximum distinct tool names whose failures are tracked per session. */
export const MAX_FAILURE_TOOLS = 64
/** Maximum distinct tool names whose descriptor warning was already reported. */
export const MAX_FLAGGED_DESCRIPTORS = 64

/** Cap on distinct flagged result contents tracked per session. */
export const MAX_FLAGGED_RESULTS = 256

/** Format version of the plugin-owned session metadata index. */
export const SESSION_INDEX_VERSION = 1

/** How long metadata writes are coalesced before touching the disk. */
export const SESSION_PERSIST_DELAY_MS = 750

/** Longest workspace path or title kept in the index (display bounds). */
const MAX_WORKSPACE_CHARS = 512
const MAX_TITLE_CHARS = 100

/** Logger seam for persistence failures (matches what `apply()` owns). */
export interface SessionIndexLogger {
  error(message: string, ...rest: unknown[]): void
}

/** Options for {@link SessionStateStore}. */
export interface SessionStoreOptions {
  /**
   * Absolute path of the plugin-owned metadata index. When omitted the store is
   * memory-only (unit tests, headless probes).
   */
  readonly path?: string
  /** Logger used once per distinct persistence failure. */
  readonly logger?: SessionIndexLogger
  /** Coalescing delay; injectable so tests do not sleep. */
  readonly persistDelayMs?: number
}

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
  /**
   * Consecutive failed executions per tool name (kernel `trajectory.denials`):
   * a success clears the entry, so "it failed, then worked" starts clean.
   */
  failures: Record<string, number>
  /**
   * Tool names whose descriptor already produced a warning in this session.
   * A hostile description is a property of the tool, not of one call, so the
   * warning is written once per session instead of on every proposal.
   */
  flaggedDescriptors: Set<string>
  /**
   * Result-scan findings already recorded in this session, keyed by
   * `tool:sha256` of the flagged content, mapped to how many times it has recurred.
   *
   * Why: measured 2026-11-24, 132 `injection_marker` records in one day collapsed to
   * seven distinct content digests — the same file content flagged on every edit that
   * touched it. Re-reading a file that quotes an injection example is not new evidence,
   * so the row is written once and the registry counts the repeats. The count is the
   * signal that survives ("this content was flagged 23 times"), without 22 duplicate
   * rows burying the one that would have been different.
   */
  flaggedResults: Map<string, number>
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
  /**
   * The file-sandbox mode in force for this session, as the host resolved it.
   *
   * Recorded because the sandbox mode is per **session**, not per deployment: a
   * session's own `sandbox/mode` event outranks the profile default, and a
   * deployment whose default is `read-only` can still be running one
   * `danger-full-access` conversation. Posture must answer for the sessions that
   * actually exist, so this value is read from the host's resolver at every seam
   * that carries a live session and folded into the deployment-wide answer by
   * {@link SessionStateStore.sandboxSummary}.
   *
   * Memory only, never persisted: it is live host state, not durable history.
   */
  sandboxMode?: SandboxModeName
  /**
   * True once this session's sandbox mode was actually probed (whatever the
   * answer). Distinguishes "observed but unreadable" from "never observed": only
   * the former makes a posture claim unsound, and only the former must not be
   * probed again (the resolver folds the whole event log per call).
   */
  sandboxProbed?: boolean
  /**
   * True for a row restored from the persisted index that this process has not
   * touched yet. Its counters/trail start at zero because they are per process,
   * while the workspace/title are durable display metadata.
   */
  historical: boolean
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
  /** True when only persisted metadata is known (no call this process). */
  readonly historical?: boolean
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
  /**
   * The widest sandbox mode of any session that was **evicted** from {@link sessions}.
   *
   * Why: `MAX_SESSIONS` is an LRU cap that exists so a busy machine cannot grow this
   * store without bound. But eviction deletes a live session's `sandboxMode`, and a
   * session that ran one tool at `danger-full-access` before being pushed out would
   * then vanish from the posture answer — turning a real finding back into a clean
   * pass. A session whose mode is no longer observable contributes its last known
   * mode as a floor instead (evidence is kept; only the per-session detail is
   * dropped).
   */
  private sandboxEvictedPeak: SandboxModeName | undefined
  /** How many evicted sessions had been probed but never answered with a mode. */
  private sandboxEvictedUnknown = 0

  private readonly path: string | undefined
  private readonly logger: SessionIndexLogger | undefined
  private readonly persistDelayMs: number
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private lastPersistError: string | undefined

  /**
   * @param options - optional disk index path, logger and coalescing delay.
   */
  constructor(options: SessionStoreOptions = {}) {
    this.path = options.path
    this.logger = options.logger
    this.persistDelayMs = options.persistDelayMs ?? SESSION_PERSIST_DELAY_MS
    if (this.path !== undefined) this.restore()
  }

  /** Get (or create) the state for one session id. */
  of(sessionId: string | undefined): SessionState {
    const key = sessionId !== undefined && sessionId.length > 0 ? sessionId : 'unknown'
    const existing = this.sessions.get(key)
    if (existing !== undefined) {
      existing.touchedAt = Date.now()
      // A restored row becomes live the first time a hook sees it.
      existing.historical = false
      // Refresh LRU order: Map preserves insertion order, so re-insert.
      this.sessions.delete(key)
      this.sessions.set(key, existing)
      return existing
    }
    const created: SessionState = {
      sessionId: key,
      trail: [],
      totalCalls: 0,
      failures: {},
      flaggedDescriptors: new Set<string>(),
      flaggedResults: new Map<string, number>(),
      counters: { allow: 0, deny: 0, ask: 0, warn: 0 },
      touchedAt: Date.now(),
      historical: false,
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
      failures: state.failures,
    }
  }

  /**
   * Record one execution outcome for the repeated-attempt check.
   *
   * Mirrors the kernel's `trajectory.py`: a failure raises the per-tool counter, a
   * success clears it (the tool worked, so the pressure is gone). Only names are
   * stored, never arguments, and the map is bounded so a session that touches
   * thousands of MCP tools cannot grow it without limit.
   */
  recordToolOutcome(sessionId: string | undefined, toolName: string, isError: boolean): void {
    if (toolName.length === 0) return
    const state = this.of(sessionId)
    if (!isError) {
      delete state.failures[toolName]
      return
    }
    if (state.failures[toolName] === undefined && Object.keys(state.failures).length >= MAX_FAILURE_TOOLS) {
      // Bounded: drop the oldest insertion (object key order is insertion order for
      // string keys), which is the least recently added failure.
      const oldest = Object.keys(state.failures)[0]
      if (oldest !== undefined) delete state.failures[oldest]
    }
    state.failures[toolName] = (state.failures[toolName] ?? 0) + 1
  }

  /**
   * Note that a tool's descriptor was reported, returning true only the first time.
   *
   * @returns whether this call is the first flagged proposal of that tool this session.
   */
  noteDescriptorFlag(sessionId: string | undefined, toolName: string): boolean {
    const state = this.of(sessionId)
    if (state.flaggedDescriptors.has(toolName)) return false
    if (state.flaggedDescriptors.size >= MAX_FLAGGED_DESCRIPTORS) {
      const first = state.flaggedDescriptors.values().next()
      if (first.done !== true) state.flaggedDescriptors.delete(first.value)
    }
    state.flaggedDescriptors.add(toolName)
    return true
  }

  /**
   * Whether one flagged result content is new in this session, counting the repeat.
   *
   * Returns the occurrence number: 1 means "first time, write the row", and a larger
   * number means "already recorded, only bump the counter". The caller decides what to
   * do with it; this only owns the bound and the identity.
   *
   * @param sessionId - owning session (internal key).
   * @param identity - `tool:sha256` of the flagged content.
   * @returns the 1-based occurrence count.
   */
  noteResultFinding(sessionId: string | undefined, identity: string): number {
    const state = this.of(sessionId)
    const seen = state.flaggedResults.get(identity) ?? 0
    const next = seen + 1
    if (seen === 0 && state.flaggedResults.size >= MAX_FLAGGED_RESULTS) {
      const first = state.flaggedResults.keys().next()
      if (first.done !== true) state.flaggedResults.delete(first.value)
    }
    state.flaggedResults.set(identity, next)
    return next
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
   * Record the file-sandbox mode the host resolved for one session.
   *
   * Posture cannot ask "is this deployment confined?" from the deployment
   * default alone: DSH resolves the mode per session (a session's own
   * `sandbox/mode` event outranks the profile default), so a `read-only` profile
   * can still be running a `danger-full-access` conversation. Callers pass what
   * the host's own resolver returned for a specific live session.
   *
   * `undefined` is meaningful: it records that this session was **observed** but
   * its mode could not be read. That must never be folded into "confined" — an
   * unreadable mode is evidence of nothing, and claiming otherwise is precisely
   * the failure this method exists to prevent.
   *
   * Memory only: this is live host state, not the durable session index.
   *
   * @param sessionId - the session the mode applies to.
   * @param mode - the resolved mode, or `undefined` when the host exposed none.
   */
  recordSandboxMode(sessionId: string | undefined, mode: SandboxModeName | undefined): void {
    const state = this.of(sessionId)
    // Latest wins: a session may switch modes at runtime, and the mode in force
    // now is the one posture must report. A later successful resolution clears a
    // previous "unknown".
    state.sandboxMode = mode
    state.sandboxProbed = true
  }

  /**
   * The sandbox mode recorded for one session, or `undefined` when this process
   * has not resolved it yet.
   *
   * @param sessionId - the session to read.
   * @returns the recorded mode, when there is one.
   */
  knownSandboxMode(sessionId: string | undefined): SandboxModeName | undefined {
    if (sessionId === undefined || sessionId.length === 0) return undefined
    return this.sessions.get(sessionId)?.sandboxMode
  }

  /**
   * Whether one session's sandbox mode was already probed (readable or not).
   *
   * The resolver folds the session's whole event log, so callers must ask this
   * before resolving again: an unreadable answer is still an answer, and retrying
   * it on every event would make a long conversation quadratic.
   *
   * @param sessionId - the session to read.
   * @returns true once a probe was recorded, whatever it found.
   */
  hasSandboxProbe(sessionId: string | undefined): boolean {
    if (sessionId === undefined || sessionId.length === 0) return false
    return this.sessions.get(sessionId)?.sandboxProbed === true
  }

  /**
   * The widest sandbox mode observed across tracked sessions, plus how much is
   * still unknown.
   *
   * Posture is a statement about the whole deployment, so the mode is the weakest
   * link: if any session runs unrestricted, "the sandbox confines the deployment"
   * is false. `unknown` counts sessions whose mode was never readable; a caller
   * that gets `unknown > 0` must not report a clean pass, because the remaining
   * sessions could be running at any mode. Sessions already evicted by the
   * {@link MAX_SESSIONS} cap still contribute their widest mode (and their
   * unreadable count), so an LRU eviction cannot launder a finding.
   *
   * @returns the widest known mode (or `undefined`), the unknown-session count,
   *   and a mode census for the operator-facing detail.
   */
  sandboxSummary(): {
    readonly mode: SandboxModeName | undefined
    readonly unknown: number
    readonly census: Readonly<Record<SandboxModeName, number>>
  } {
    let widest: SandboxModeName | undefined
    let unknown = 0
    const census: Record<SandboxModeName, number> = { 'read-only': 0, 'workspace-write': 0, 'danger-full-access': 0 }
    for (const state of this.sessions.values()) {
      if (state.sandboxMode === undefined) {
        // Only sessions that were actually probed count as unknown; a session the
        // plugin never saw a sandbox seam for is "not observed", not "unreadable".
        if (state.sandboxProbed === true) unknown += 1
        continue
      }
      census[state.sandboxMode] += 1
      widest = widerSandboxMode(widest, state.sandboxMode)
    }
    // Sessions evicted by the LRU cap still count: their evidence must not expire
    // just because the per-session row did (see `sandboxEvictedPeak`).
    return {
      mode: widerSandboxMode(widest, this.sandboxEvictedPeak),
      unknown: unknown + this.sandboxEvictedUnknown,
      census,
    }
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
    state.historical = false
    let changed = false
    if (state.workspace === undefined && facts.workspace !== undefined) {
      state.workspace = facts.workspace.slice(0, MAX_WORKSPACE_CHARS)
      changed = true
    }
    if (state.createdAt === undefined && facts.createdAt !== undefined) {
      state.createdAt = facts.createdAt
      changed = true
    }
    if (facts.title !== undefined && facts.title.length > 0) {
      const title = facts.title.slice(0, MAX_TITLE_CHARS)
      if (state.title !== title) {
        state.title = title
        changed = true
      }
    }
    if (changed) this.schedulePersist()
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
        ...(state.historical ? { historical: true } : {}),
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
    if (this.sessions.delete(sessionId)) this.schedulePersist()
  }

  /**
   * Flush a pending metadata write and stop the timer.
   *
   * Called from the plugin's teardown effect so a just-renamed session does not
   * lose its title; safe to call more than once.
   */
  dispose(): void {
    this.disposed = true
    this.clearTimer()
    this.persistNow()
  }

  /** Write any pending metadata immediately (tests and teardown). */
  flush(): void {
    this.clearTimer()
    this.persistNow()
  }

  /** Cancel a scheduled write. */
  private clearTimer(): void {
    if (this.persistTimer !== undefined) {
      clearTimeout(this.persistTimer)
      this.persistTimer = undefined
    }
  }

  /** Coalesce metadata writes: titles are re-reported on every step. */
  private schedulePersist(): void {
    if (this.path === undefined || this.disposed || this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.persistNow()
    }, this.persistDelayMs)
    // Do not keep a headless host alive just for a metadata write.
    this.persistTimer.unref?.()
  }

  /** Restore metadata rows from disk; a broken file is ignored (memory-only). */
  private restore(): void {
    const file = this.path
    if (file === undefined || !existsSync(file)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return
      const document = parsed as { version?: unknown; sessions?: unknown }
      if (document.version !== SESSION_INDEX_VERSION || !Array.isArray(document.sessions)) return
      const restored: Array<{ id: string; touchedAt: number; workspace?: string; createdAt?: number; title?: string }> = []
      for (const row of document.sessions) {
        if (row === null || typeof row !== 'object') continue
        const value = row as Record<string, unknown>
        const id = value['id']
        if (typeof id !== 'string' || id.length === 0 || id.length > 200) continue
        const item: { id: string; touchedAt: number; workspace?: string; createdAt?: number; title?: string } = {
          id,
          touchedAt: typeof value['touchedAt'] === 'number' && Number.isFinite(value['touchedAt']) ? value['touchedAt'] : 0,
        }
        if (typeof value['workspace'] === 'string' && value['workspace'].length > 0) item.workspace = value['workspace'].slice(0, MAX_WORKSPACE_CHARS)
        if (typeof value['createdAt'] === 'number' && Number.isFinite(value['createdAt'])) item.createdAt = value['createdAt']
        if (typeof value['title'] === 'string' && value['title'].length > 0) item.title = value['title'].slice(0, MAX_TITLE_CHARS)
        restored.push(item)
      }
      // Oldest first: the LRU eviction below drops from the front.
      restored.sort((left, right) => left.touchedAt - right.touchedAt)
      for (const item of restored.slice(-MAX_SESSIONS)) {
        if (this.sessions.has(item.id)) continue
        this.sessions.set(item.id, {
          sessionId: item.id,
          trail: [],
          totalCalls: 0,
          failures: {},
          flaggedDescriptors: new Set<string>(),
          flaggedResults: new Map<string, number>(),
          counters: { allow: 0, deny: 0, ask: 0, warn: 0 },
          touchedAt: item.touchedAt,
          ...(item.workspace === undefined ? {} : { workspace: item.workspace }),
          ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
          ...(item.title === undefined ? {} : { title: item.title }),
          historical: true,
        })
      }
      this.evictIfNeeded()
    } catch {
      // A partial/corrupt index must never stop the plugin: fall back to memory.
    }
  }

  /** Persist display metadata only (never content, never counters). */
  private persistNow(): void {
    const file = this.path
    if (file === undefined) return
    try {
      const rows: Array<{ id: string; touchedAt: number; workspace?: string; createdAt?: number; title?: string }> = []
      for (const state of this.sessions.values()) {
        if (state.workspace === undefined && state.createdAt === undefined && state.title === undefined) continue
        rows.push({
          id: state.sessionId,
          touchedAt: state.touchedAt,
          ...(state.workspace === undefined ? {} : { workspace: state.workspace }),
          ...(state.createdAt === undefined ? {} : { createdAt: state.createdAt }),
          ...(state.title === undefined ? {} : { title: state.title }),
        })
      }
      rows.sort((left, right) => left.touchedAt - right.touchedAt)
      if (rows.length === 0) return
      const body = `${JSON.stringify({ version: SESSION_INDEX_VERSION, savedAt: Date.now(), sessions: rows.slice(-MAX_SESSIONS) }, null, 0)}\n`
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp`
      writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, file)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== this.lastPersistError) {
        this.lastPersistError = message
        this.logger?.error(`safeharness: could not write the session index (${message})`)
      }
    }
  }

  /** Drop the least-recently-touched sessions beyond {@link MAX_SESSIONS}. */
  private evictIfNeeded(): void {
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (oldest.done === true) return
      // Keep the sandbox evidence before the row goes away: an evicted session's
      // `danger-full-access` must not turn into a clean posture pass. Anything that
      // was probed but unreadable stays "unreadable" for the same reason.
      const row = this.sessions.get(oldest.value)
      if (row !== undefined && row.sandboxProbed === true) {
        if (row.sandboxMode === undefined) this.sandboxEvictedUnknown += 1
        else this.sandboxEvictedPeak = widerSandboxMode(this.sandboxEvictedPeak, row.sandboxMode)
      }
      this.sessions.delete(oldest.value)
    }
  }
}
