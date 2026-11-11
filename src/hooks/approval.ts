/**
 * Approval bridge: `approval/request` (§6.7, T3.3).
 *
 * The bridge is a *coarse* policy layer, on purpose. The event carries only the
 * tool name, the asker's prose reason and the call id — never the arguments
 * (verified: `dsh-user-approval/src/index.ts:149-174`), so any fine-grained
 * decision made here would be a guess. Two things are therefore allowed:
 *
 *  1. grant a configured `approval.allowOnce` tool exactly once per session;
 *  2. refuse a tool the deployment already denies at the tool surface
 *     (`tools.denyTools` / `tools.denyTags`);
 *  3. everything else is delegated to whoever answers approvals (human / ACP).
 *
 * "Once" is enforced with a bounded per-session grant set: the second ask for the
 * same tool in the same session delegates, so a persistent caller cannot turn one
 * configured grant into standing permission.
 *
 * Failure policy: an internal error always delegates (`next()`), never grants.
 * Auto-approving on a bug would be the one failure mode that silently removes a
 * human from the loop, so it is excluded by construction.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Runtime } from '../runtime.js'
import { matchNamePattern, resolveTags } from '../engine/tool.js'

/** Maximum remembered grants across all sessions (LRU-ish, insertion order). */
export const MAX_GRANTS = 512

/**
 * Structural view of one approval request. Declared locally so the hook can be
 * driven by the test harness without an `Agent`; the host's own `ApprovalRequest`
 * satisfies it.
 */
export interface ApprovalRequestLike {
  readonly toolName: string
  readonly agent?: unknown
  readonly callId?: unknown
  readonly reason?: string
  readonly signal?: AbortSignal
}

/**
 * Install the approval bridge listener.
 *
 * The listener is always registered, even in `delegate` mode: the mode is read per
 * event so a hot settings change from `delegate` to `policy` takes effect without
 * a restart (a listener registered only at load time could not do that). In
 * `delegate` mode the handler is a pass-through that still records the audit pair,
 * which is what makes the patrol reconciliation check (§6.10 #4) possible.
 *
 * @param ctx - plugin context; the listener is disposed with the plugin fiber.
 * @param runtime - shared config, ledger and counters.
 * @returns true when the listener was registered.
 */
export function installApprovalHook(ctx: Context, runtime: Runtime): boolean {
  try {
    ctx.on('approval/request', async (request, next): Promise<ApprovalOutcome> => {
      const mode = runtime.config.approval.mode
      if (mode === 'delegate') {
        // Audit pair first: the outcome is written below, after the answerer ran.
        runtime.audit('approval_asked', {
          ...runtime.sessionFields(sessionIdOf(request)),
          tool: nameOf(request),
          decision: 'asked',
          reason_code: 'approval_delegated',
          labels: { source: 'delegate' },
        })
        const outcome = await next()
        recordDecision(runtime, request, outcome, 'delegate')
        return outcome
      }

      try {
        runtime.audit('approval_asked', {
          ...runtime.sessionFields(sessionIdOf(request)),
          tool: nameOf(request),
          decision: 'asked',
          reason_code: 'approval_policy',
          labels: { source: 'policy' },
        })

        const toolName = nameOf(request)
        const cfg = runtime.config

        // 1) Configured one-time grant.
        if (matchNamePattern(toolName, cfg.approval.allowOnce) && grantIsAvailable(runtime, request, toolName)) {
          recordDecision(runtime, request, 'allowed-once', 'policy')
          return 'allowed-once'
        }

        // 2) A denial the tool surface already enforces. Refusing here is not a
        // second policy engine: it is the same configured denial, applied to the
        // approval channel so an `ask` cannot be used to reach a denied tool.
        if (toolIsDenied(runtime, toolName)) {
          recordDecision(runtime, request, 'rejected', 'policy')
          return 'rejected'
        }

        // 3) Delegate: the bridge has no argument visibility, so the human decides.
        const outcome = await next()
        recordDecision(runtime, request, outcome, 'policy')
        return outcome
      } catch (error) {
        // Never auto-approve on a bug. Delegating keeps the human in the loop; if
        // even the delegated answerer fails, `unavailable` is the honest outcome
        // (the tool layer turns every non-grant into a deny).
        runtime.internalError('approval', error)
        try {
          return await next()
        } catch (retryError) {
          runtime.internalError('approval:delegate', retryError)
          return 'unavailable'
        }
      }
    })
    return true
  } catch (error) {
    runtime.internalError('approval:register', error)
    return false
  }
}

/** Tool name of a request, defensively (a malformed event must not throw). */
function nameOf(request: ApprovalRequestLike | undefined): string {
  const name = request?.toolName
  return typeof name === 'string' && name.length > 0 ? name : 'unknown'
}

/** Session id carried by the request's agent, when the host provided one. */
function sessionIdOf(request: ApprovalRequestLike | undefined): string | undefined {
  const agent = request?.agent as { session?: { id?: unknown } } | undefined
  const id = agent?.session?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** Whether this (session, tool) pair still holds an unused one-time grant. */
function grantIsAvailable(runtime: Runtime, request: ApprovalRequestLike | undefined, toolName: string): boolean {
  const grants = grantsOf(runtime)
  const key = `${sessionIdOf(request) ?? 'unknown'}|${toolName}`
  if (grants.has(key)) return false
  grants.add(key)
  while (grants.size > MAX_GRANTS) {
    const oldest = grants.values().next()
    if (oldest.done === true) break
    grants.delete(oldest.value)
  }
  return true
}

/**
 * Per-runtime grant memory.
 *
 * Keyed by runtime identity so two plugin instances in one process (tests do
 * this) cannot share grants, and so the set is released with the runtime.
 */
const GRANT_SETS = new WeakMap<Runtime, Set<string>>()

/** Get (or create) the grant set of one runtime. */
function grantsOf(runtime: Runtime): Set<string> {
  let grants = GRANT_SETS.get(runtime)
  if (grants === undefined) {
    grants = new Set<string>()
    GRANT_SETS.set(runtime, grants)
  }
  return grants
}

/** Whether the deployment's tool policy already refuses this tool by name or tag. */
function toolIsDenied(runtime: Runtime, toolName: string): boolean {
  const cfg = runtime.config.tools
  if (matchNamePattern(toolName, cfg.denyTools)) return true
  if (cfg.denyTags.length === 0) return false
  const tags = resolveTags(toolName, cfg.tagOverrides)
  return tags.some((tag) => cfg.denyTags.includes(tag))
}

/** Write the decision half of the audit pair (never the reason or arguments). */
function recordDecision(
  runtime: Runtime,
  request: ApprovalRequestLike | undefined,
  outcome: ApprovalOutcome,
  source: 'policy' | 'delegate',
): void {
  runtime.audit('approval_decided', {
    ...runtime.sessionFields(sessionIdOf(request)),
    tool: nameOf(request),
    decision: outcome,
    reason_code: outcome === 'allowed-once' ? 'approval_allowed_once' : outcome === 'rejected' ? 'approval_rejected' : 'approval_not_granted',
    // The asker's prose reason can quote tool arguments, so only its length is kept.
    detail_chars: typeof request?.reason === 'string' ? request.reason.length : 0,
    labels: { source },
  })
  if (outcome === 'allowed-once') runtime.count('allow', sessionIdOf(request))
  else runtime.count('deny', sessionIdOf(request))
}
