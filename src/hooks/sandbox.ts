/**
 * Per-session file-sandbox observation.
 *
 * Why this module exists: DSH resolves the file-sandbox mode **per session**.
 * `ctx.sandboxPolicy.resolve()` with no session returns the deployment default,
 * while every live session may run at its own mode (a session's `sandbox/mode`
 * event outranks that default, and a delegation may seed a child with another
 * one). A posture check that asks only the session-less question therefore
 * reports `workspace-write` for a deployment whose actual conversations run at
 * `danger-full-access` — a clean bill of health for an unrestricted machine.
 *
 * So the plugin resolves the mode for each session it actually sees, keeps the
 * widest answer, and lets posture judge that:
 *
 *  * {@link observeSessionSandbox} — resolve once per session (folding the whole
 *    event log is not free, so it must not happen on every event).
 *  * {@link recordSandboxSwitch} — apply a `sandbox/mode` event directly; the
 *    event is the authority the enforcement side folds.
 *  * {@link observeSandbox} — the union of the deployment default and every
 *    observed session, plus how many sessions could not be read at all.
 *
 * No value from here ever reaches the ledger: posture writes codes and counts.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PostureEnv, SandboxModeName } from '../engine/types.js'
import { asSandboxMode, SANDBOX_MODES } from '../engine/types.js'
import type { Runtime } from '../runtime.js'

/**
 * The host's sandbox policy service, read structurally.
 *
 * `@deepseek-ai/dsh-sandbox-policy` is not one of this package's peers (it is an
 * optional host package), so the shape is declared here rather than imported.
 */
interface SandboxPolicyLike {
  resolve(request?: { session?: unknown; mode?: unknown }): { mode?: unknown } | undefined
}

/** Read the policy service, when this profile composes one. */
export function sandboxServiceOf(ctx: Context): SandboxPolicyLike | undefined {
  const service = ctx.get('sandboxPolicy') as Partial<SandboxPolicyLike> | undefined
  if (service === undefined || typeof service.resolve !== 'function') return undefined
  return service as SandboxPolicyLike
}

/**
 * Resolve the file-sandbox mode the host would apply to one call.
 *
 * @param ctx - plugin context carrying the optional service.
 * @param session - the live session to resolve for; omitted means "the
 *   deployment default", which is a different question, not a cheaper one.
 * @returns the mode, or `undefined` when the service is absent or unreadable.
 */
export function resolveSandboxMode(ctx: Context, session?: unknown): SandboxModeName | undefined {
  const service = sandboxServiceOf(ctx)
  if (service === undefined) return undefined
  try {
    const resolved = session === undefined ? service.resolve() : service.resolve({ session })
    return asSandboxMode(resolved?.mode)
  } catch {
    // A throwing or partly composed service is "unknown", and unknown is not OK.
    return undefined
  }
}

/**
 * Extract the session id from a session-shaped value.
 *
 * @param session - anything the host passes at a seam (`Agent.session`, a
 *   `session/event` first argument, ...).
 * @returns the id, when there is a non-empty one.
 */
function sessionIdOfLike(session: unknown): string | undefined {
  const id = (session as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Resolve and record one session's sandbox mode the first time it is seen.
 *
 * @param runtime - shared runtime owning the session store.
 * @param ctx - plugin context (the optional policy service).
 * @param session - the live session, when the seam carries one.
 */
export function observeSessionSandbox(runtime: Runtime, ctx: Context, session: unknown): void {
  const sessionId = sessionIdOfLike(session)
  if (sessionId === undefined) return
  // Once per session, whatever the outcome: an unreadable answer is recorded as
  // unknown (so posture refuses to call it clean) and is not retried per event.
  if (runtime.state.hasSandboxProbe(sessionId)) return
  runtime.state.recordSandboxMode(sessionId, resolveSandboxMode(ctx, session))
}

/**
 * Apply a `sandbox/mode` session event.
 *
 * The event is the authority: enforcement folds the **last** one over the
 * deployment default, so recording it directly keeps posture in step with what
 * an enforcing tool would actually do.
 *
 * @param runtime - shared runtime owning the session store.
 * @param session - the session the event belongs to.
 * @param event - the raw `session/event` payload.
 */
export function recordSandboxSwitch(runtime: Runtime, session: unknown, event: { type?: unknown; data?: unknown }): void {
  if (event.type !== 'sandbox/mode') return
  const sessionId = sessionIdOfLike(session)
  if (sessionId === undefined) return
  const mode = asSandboxMode((event.data as { mode?: unknown } | undefined)?.mode)
  if (mode !== undefined) runtime.state.recordSandboxMode(sessionId, mode)
}

/**
 * The sandbox observation posture reports.
 *
 * @param ctx - plugin context (the optional policy service).
 * @param runtime - shared runtime owning the session store.
 * @returns the observation, or `undefined` when no policy service is composed
 *   (posture then reports SKIP rather than a clean pass).
 */
export function observeSandbox(ctx: Context, runtime: Runtime): PostureEnv['sandbox'] {
  if (sandboxServiceOf(ctx) === undefined) return undefined
  const sessions = runtime.state.sandboxSummary()
  const observedSessions = SANDBOX_MODES.reduce((total, mode) => total + sessions.census[mode], 0)
  const defaultMode = resolveSandboxMode(ctx)
  return {
    defaultMode,
    sessionMode: sessions.mode,
    observedSessions,
    // An unreadable deployment default is its own unknown once sessions exist: those
    // sessions are known, but any *new* one would fall back to a default nobody read.
    unknownSessions: sessions.unknown + (defaultMode === undefined && observedSessions > 0 ? 1 : 0),
    census: sessions.census,
  }
}
