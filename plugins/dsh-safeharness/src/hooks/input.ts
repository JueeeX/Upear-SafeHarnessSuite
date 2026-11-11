/**
 * Input surface: `agent/pre-step` (§6.4).
 *
 * Observed on every step; it denies only when `input.mode === 'enforce'`.
 * A denial closes the whole turn — the seam has no reason channel — so only
 * high-confidence structural rules are allowed to reach this surface, and the
 * model never learns which rule fired (generic wording only).
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { foundSomething, type Runtime } from '../runtime.js'
import { agentIdOf, sessionIdOf, userInputText } from './context.js'

/**
 * Install the input guard listener.
 *
 * @param ctx - plugin context; the listener is disposed with the plugin fiber.
 * @param runtime - shared engine/ledger/state.
 */
export function installInputHook(ctx: Context, runtime: Runtime): void {
  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const sessionId = sessionIdOf(payload.agent)
    const agentId = agentIdOf(payload.agent)

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

      const decision = runtime.engine.evaluateInput(text)
      const hit = foundSomething(decision)
      const base = {
        ...runtime.sessionFields(sessionId, agentId),
        reason_code: decision.reasonCode,
        rule_ids: [...decision.ruleIds],
        severity: decision.severity,
        category: decision.category,
        detail_chars: text.length,
      }

      if (!hit) {
        runtime.audit('input_checked', { ...base, decision: 'allow', metrics: { chars: text.length } })
        runtime.count('allow', sessionId)
        return next()
      }

      if (mode === 'enforce') {
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
