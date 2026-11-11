/**
 * Process-boundary transport for the optional Python engine (M5 T5.1, step 1).
 *
 * This module is deliberately *only* the transport: spawn, newline-delimited JSON
 * envelopes, request/response correlation, deadlines, and fail-closed teardown. It
 * knows nothing about what the engine evaluates, and nothing imports it yet — the
 * next step puts it behind `SecurityEngine`, which needs an async input path (the
 * plan's §6.14 signature is synchronous; a child process is not).
 *
 * Invariants, all of them about *not* letting a broken engine turn into "allow":
 *
 * - every failure is a rejection carrying a coarse `code`; the request payload and
 *   the child's stderr are never echoed, because they can carry prompt text (the
 *   ledger rule — hashes and lengths only — applies to errors too);
 * - a child that dies or hangs fails **every** pending and future call; there is no
 *   silent fallback to the built-in engine here (the caller decides, fail-closed);
 * - only stdout lines that parse as our envelope are accepted; anything else is
 *   counted and ignored, so a chatty child cannot corrupt the protocol;
 * - stderr is measured, never stored: crossing the cap kills the child.
 *
 * @module
 */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

/** Lifecycle of the transport. */
export type SidecarStatus = 'idle' | 'starting' | 'ready' | 'failed' | 'stopped'

/** How to start and talk to the engine process. */
export interface SidecarOptions {
  /** Executable to spawn (e.g. `python`); tests pass `process.execPath`. */
  readonly command: string
  /** Arguments (e.g. `['-u', 'scripts/safeharness_sidecar.py']`). */
  readonly args?: readonly string[]
  /** Working directory of the child. */
  readonly cwd?: string
  /** Extra environment entries (merged over `process.env`). */
  readonly env?: Readonly<Record<string, string>>
  /** Per-request deadline; a late answer is discarded and the call rejects. */
  readonly timeoutMs?: number
  /** How long {@link Sidecar.start} waits for the `health` answer. */
  readonly startTimeoutMs?: number
  /** Cap on captured stderr bytes before the child is killed. */
  readonly maxStderrBytes?: number
}

/**
 * A transport failure. `code` is the only thing a caller may surface: the message
 * is a fixed, content-free string.
 */
export class SidecarError extends Error {
  /** Coarse machine-readable cause (`sidecar_timeout`, `sidecar_exited`, ...). */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'SidecarError'
    this.code = code
  }
}

/** The response envelope the child must emit (one JSON object per line). */
interface Envelope {
  readonly v?: number
  readonly id?: number
  readonly ok?: boolean
  readonly result?: unknown
  readonly error?: { readonly code?: string; readonly message?: string }
}

/** Diagnostics a caller may log: counters only, never payloads or stderr text. */
export interface SidecarStats {
  readonly status: SidecarStatus
  readonly pid: number | undefined
  readonly pending: number
  /** Stdout lines that were not our envelope (a chatty child, not an error). */
  readonly badLines: number
  /** Bytes of stderr seen so far (content is never retained). */
  readonly stderrBytes: number
}

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_START_TIMEOUT_MS = 10000
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024
const KILL_GRACE_MS = 2000

/** One in-flight request, resolved by {@link Sidecar.onLine}. */
interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

/**
 * A JSON-lines request/response channel to a child process.
 *
 * Not safe to reuse after {@link Sidecar.stop}: the instance stays `stopped` and
 * every further `request` rejects.
 */
export class Sidecar {
  private readonly command: string
  private readonly args: readonly string[]
  private readonly cwd: string | undefined
  private readonly env: Readonly<Record<string, string>> | undefined
  private readonly timeoutMs: number
  private readonly startTimeoutMs: number
  private readonly maxStderrBytes: number

  private child: ChildProcessWithoutNullStreams | undefined
  private statusValue: SidecarStatus = 'idle'
  private nextId = 1
  private readonly pending = new Map<number, PendingCall>()
  private badLines = 0
  private stderrBytes = 0
  /** Set once `health` answered; `request()` refuses before that. */
  private ready = false

  constructor(options: SidecarOptions) {
    this.command = options.command
    this.args = options.args === undefined ? [] : [...options.args]
    this.cwd = options.cwd
    this.env = options.env
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES
  }

  /** Current lifecycle state. */
  get status(): SidecarStatus {
    return this.statusValue
  }

  /** Child pid, when one has been spawned. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  /** Counters for diagnostics (no content). */
  get stats(): SidecarStats {
    return {
      status: this.statusValue,
      pid: this.child?.pid,
      pending: this.pending.size,
      badLines: this.badLines,
      stderrBytes: this.stderrBytes,
    }
  }

  /**
   * Spawn the child and confirm it answers `health`.
   *
   * @throws SidecarError `sidecar_spawn_failed` (cannot exec) or
   *   `sidecar_unavailable` (spawned but the handshake failed / timed out).
   */
  async start(): Promise<void> {
    if (this.statusValue === 'ready') return
    if (this.statusValue === 'stopped') throw new SidecarError('sidecar_stopped', 'the engine process was already stopped')
    if (this.statusValue === 'starting') throw new SidecarError('sidecar_starting', 'the engine process is already starting')
    this.statusValue = 'starting'

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.command, [...this.args], {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      this.statusValue = 'failed'
      throw new SidecarError('sidecar_spawn_failed', 'the engine process could not be started')
    }
    this.child = child

    child.on('error', () => {
      this.statusValue = 'failed'
      this.failAll('sidecar_spawn_failed', 'the engine process failed to start')
    })
    child.on('exit', () => {
      if (this.statusValue !== 'stopped') this.statusValue = 'failed'
      this.ready = false
      this.failAll('sidecar_exited', 'the engine process exited')
    })
    // A closed stdin (the child died) must not surface as an unhandled error event.
    child.stdin.on('error', () => {})
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrBytes += chunk.length
      // stderr content is dropped on the floor; only the cap matters.
      if (this.stderrBytes > this.maxStderrBytes) this.kill()
    })
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line))

    try {
      await this.request('health', {}, this.startTimeoutMs)
    } catch (error) {
      this.kill()
      this.statusValue = 'failed'
      const code = error instanceof SidecarError ? error.code : 'sidecar_unavailable'
      throw new SidecarError('sidecar_unavailable', `the engine did not answer its health check (${code})`)
    }
    this.ready = true
    this.statusValue = 'ready'
  }

  /**
   * Send one request and await its answer.
   *
   * @param method - engine method name.
   * @param params - JSON-serializable parameters (never echoed in errors).
   * @param timeoutMs - overrides the configured deadline for this call.
   * @throws SidecarError with a coarse code; never throws anything else.
   */
  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.statusValue === 'stopped') throw new SidecarError('sidecar_stopped', 'the engine process is not running')
    const child = this.child
    if (child === undefined || this.statusValue === 'failed') {
      throw new SidecarError('sidecar_not_ready', 'the engine process is not running')
    }
    if (!this.ready && method !== 'health') {
      throw new SidecarError('sidecar_not_ready', 'the engine process has not completed its health check')
    }

    let line: string
    try {
      line = `${JSON.stringify({ v: 1, id: this.nextId, method, ...(params === undefined ? {} : { params }) })}\n`
    } catch {
      throw new SidecarError('sidecar_bad_params', 'the request parameters are not JSON-serializable')
    }
    const id = this.nextId
    this.nextId += 1
    const deadline = Math.max(50, Math.trunc(timeoutMs ?? this.timeoutMs))

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new SidecarError('sidecar_timeout', 'the engine did not answer in time'))
      }, deadline)
      timer.unref?.()
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        child.stdin.write(line)
      } catch {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new SidecarError('sidecar_write_failed', 'the request could not be written to the engine'))
      }
    })
  }

  /**
   * Stop the child: fail everything in flight, close stdin, then kill.
   *
   * Never throws; a child that ignores SIGTERM is force-killed after a grace period.
   */
  async stop(): Promise<void> {
    this.statusValue = 'stopped'
    this.ready = false
    this.failAll('sidecar_stopped', 'the engine process was stopped')
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    try {
      child.stdin.end()
    } catch {
      // already closed
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        this.killOf(child)
        resolve()
      }, KILL_GRACE_MS)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      this.killOf(child)
    })
  }

  /** SIGTERM, then SIGKILL: best-effort, never throws. */
  private killOf(child: ChildProcessWithoutNullStreams): void {
    try {
      child.kill()
    } catch {
      // already gone
    }
  }

  /** Kill the current child (used by the stderr cap and the handshake failure path). */
  private kill(): void {
    const child = this.child
    if (child === undefined) return
    this.killOf(child)
  }

  /** Reject every in-flight call with one coarse error. */
  private failAll(code: string, message: string): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      clearTimeout(entry.timer)
      entry.reject(new SidecarError(code, message))
    }
  }

  /** Route one stdout line to its caller; anything that is not our envelope is counted. */
  private onLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.badLines += 1
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.badLines += 1
      return
    }
    const envelope = parsed as Envelope
    if (typeof envelope.id !== 'number') {
      this.badLines += 1
      return
    }
    const entry = this.pending.get(envelope.id)
    if (entry === undefined) return
    this.pending.delete(envelope.id)
    clearTimeout(entry.timer)
    if (envelope.ok === true) {
      entry.resolve(envelope.result)
      return
    }
    const code = typeof envelope.error?.code === 'string' ? envelope.error.code : 'sidecar_error'
    entry.reject(new SidecarError(code, 'the engine reported an error'))
  }
}
