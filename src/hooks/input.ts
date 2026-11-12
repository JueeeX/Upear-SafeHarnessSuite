/**
 * Input surface: `agent/pre-step` (§6.4).
 *
 * Observed on every step; it denies only when `input.mode === 'enforce'`.
 * A denial closes the whole turn — the seam has no reason channel — so only
 * high-confidence structural rules are allowed to reach this surface, and the
 * model never learns which rule fired (generic wording only).
 *
 * Optional Python engine (`engine.kind: 'sidecar'`, M5 T5.1): when the engine
 * exposes `evaluateInputAsync`, that path is used and a failure is handled by
 * preset — observe/balanced fall back to the built-in engine (recorded once per
 * cause), hardened denies. Fallback is never silent: the ledger labels the record
 * with `engine` and, on failure, `engine_error`.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SidecarError } from '../engine/sidecar.js'
import type { Decision } from '../engine/types.js'
import { ReasonCode } from '../engine/types.js'
import { foundSomething, type Runtime } from '../runtime.js'
import { agentIdOf, sessionCreatedAtOf, sessionIdOf, sessionWorkspaceOf, userInputText } from './context.js'

/** Decision used when the hardened preset cannot get input judged at all. */
const ENGINE_UNAVAILABLE_DECISION: Decision = {
  kind: 'deny',
  reasonCode: ReasonCode.InputEngineUnavailable,
  ruleIds: [],
  reason: 'the input engine is unavailable',
}

/**
 * Install the input guard listener.
 *
 * @param ctx - plugin context; the listener is disposed with the plugin fiber.
 * @param runtime - shared engine/ledger/state.
 */
export function installInputHook(ctx: Context, runtime: Runtime): void {
  /** Failure codes already reported; one ledger line per distinct cause, not per turn. */
  const reported = new Set<string>()

  /** Record one engine failure (first occurrence per code) without any content. */
  const reportEngineFailure = (code: string): void => {
    runtime.counters.internalErrors += 1
    if (reported.has(code)) return
    reported.add(code)
    runtime.logger.error(`safeharness: input engine unavailable (${code}); see posture`)
    runtime.audit('error', {
      decision: 'warn',
      reason_code: ReasonCode.InputEngineUnavailable,
      labels: { engine: 'sidecar', engine_error: code },
      preset: runtime.config.preset,
    })
  }

  /**
   * Ask the configured engine for a decision.
   *
   * @returns the decision plus whether enforcement must proceed even in `warn`
   *   mode (hardened + unavailable engine) and the sidecar failure code, if any.
   */
  const judge = async (text: string): Promise<{ decision: Decision; blocked: boolean; sidecarError?: string }> => {
    const evaluateAsync = runtime.engine.evaluateInputAsync
    if (typeof evaluateAsync !== 'function') {
      return { decision: runtime.engine.evaluateInput(text), blocked: false }
    }
    try {
      return { decision: await evaluateAsync.call(runtime.engine, text), blocked: false }
    } catch (error) {
      const code = error instanceof SidecarError ? error.code : 'sidecar_error'
      reportEngineFailure(code)
      if (runtime.config.preset === 'hardened') {
        // Fail-closed: an engine that cannot judge must never become "allow".
        return { decision: ENGINE_UNAVAILABLE_DECISION, blocked: true, sidecarError: code }
      }
      // observe/balanced: the built-in engine is always available, so keep
      // inspecting rather than dropping the control entirely.
      return { decision: runtime.engine.evaluateInput(text), blocked: false, sidecarError: code }
    }
  }

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const sessionId = sessionIdOf(payload.agent)
    const agentId = agentIdOf(payload.agent)
    // Runs before the mode gate: the panel's session view should know a
    // conversation's project even when the input guard is off.
    runtime.state.describe(sessionId, {
      workspace: sessionWorkspaceOf(payload.agent),
      createdAt: sessionCreatedAtOf(payload.agent),
    })

    // Turn accounting for the advisory budget guard (T3.5): `agent/pre-step` is the
    // only seam that reports the agent loop's own turn number, so the model-stream
    // hook can reset its counters at the right boundary. Runs even when the input
    // guard is off — the budget is a separate, independently configured control.
    try {
      runtime.budget.beginTurn(sessionId, typeof payload.turn === 'number' ? payload.turn : 0)
    } catch (error) {
      runtime.internalError('input:budget', error)
    }

    const mode = runtime.config.input.mode
    if (mode === 'off') return next()

    try {
      const text = userInputText(payload.messages)
      if (text.length === 0) return next()

      const { decision, blocked, sidecarError } = await judge(text)
      const hit = foundSomething(decision)
      // Only label when the sidecar is configured: the built-in path's ledger lines
      // keep their pre-1.2.0 shape.
      const engineLabels = runtime.config.engine.kind !== 'sidecar'
        ? undefined
        : sidecarError === undefined
          ? { engine: 'sidecar' }
          : { engine: 'builtin', engine_error: sidecarError }
      const base = {
        ...runtime.sessionFields(sessionId, agentId),
        reason_code: decision.reasonCode,
        rule_ids: [...decision.ruleIds],
        severity: decision.severity,
        category: decision.category,
        detail_chars: text.length,
        ...(engineLabels === undefined ? {} : { labels: engineLabels }),
      }

      if (!hit) {
        runtime.audit('input_checked', { ...base, decision: 'allow', metrics: { chars: text.length } })
        runtime.count('allow', sessionId)
        return next()
      }

      if (mode === 'enforce' || blocked) {
        // Evidence first: an enforcement decision that cannot be recorded is not
        // taken (§7 "账本不可写 → deny").
        if (!runtime.ledgerPermitsEnforcement()) {
          runtime.counters.auditBlocked += 1
          runtime.logger.error('safeharness: refusing input because the audit ledger is unavailable')
          return { kind: 'reject' }
        }
        try {
          await runtime.auditStrict('input_denied', { ...base, decision: 'deny' })
        } catch (error) {
          runtime.counters.auditBlocked += 1
          runtime.logger.error(`safeharness: input denial not recorded, failing closed: ${describe(error)}`)
          return { kind: 'reject' }
        }
        runtime.count('deny', sessionId)
        return { kind: 'reject' }
      }

      // warn / observe: record and continue untouched. No context is injected —
      // telling the model it was inspected pollutes the conversation (§6.4).
      runtime.audit('input_denied', { ...base, decision: 'warn' })
      runtime.count('warn', sessionId)
      return next()
    } catch (error) {
      // Observation surfaces survive their own bugs; an enforcing input guard
      // fails closed instead (§7 total principle).
      runtime.internalError('input', error)
      if (mode === 'enforce') return { kind: 'reject' }
      return next()
    }
  })
}

/** One-line error description for logs (never the offending content). */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
