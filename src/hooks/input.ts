/**
 * Input surface: `agent/pre-step` (§6.4, 1.11.0).
 *
 * Observed on every step; a hit denies only when `input.mode === 'enforce'`.
 * A denial closes the whole turn — the seam has no reason channel — so only
 * high-confidence structural rules are allowed to reach this surface, and the
 * model never learns which rule fired (generic wording only).
 *
 * Two capabilities ported from the Python core in 1.11.0:
 *
 *  * **Normalization + MODIFY** (`input.normalize`, default on): zero-width
 *    characters and HTML comments are removed and the text is NFKC-folded
 *    before matching, so `ig\u200bnore all rules` and full-width lookalikes hit
 *    the same rules. When the cleaned text was allowed, the step enters with the
 *    cleaned messages — the Python `InformPolicy` MODIFY outcome.
 *  * **Input semantic judge** (`input.judge`: off / flagged / always): one
 *    auxiliary model call on suspicious (or every) turns. `block` denies,
 *    `unknown` denies only when `input.judgeFailClosed` is set, which is the
 *    documented difference from the Python core's always-fail-closed UNCERTAIN.
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
import { normalizeInput } from '../engine/normalize.js'
import type { Decision } from '../engine/types.js'
import { ReasonCode } from '../engine/types.js'
import { foundSomething, type Runtime } from '../runtime.js'
import { createInputJudge } from '../judge/input.js'
import { judgeCallOf } from './llm.js'
import {
  agentIdOf, rewriteUserText, sessionCreatedAtOf, sessionIdOf, sessionTitleOf, sessionWorkspaceOf, userInputText,
} from './context.js'

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
  /** Input judge handle; its route is read per call, and `available` tracks the llm service. */
  const inputJudge = createInputJudge(judgeCallOf(ctx, runtime))

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
  const evaluate = async (text: string): Promise<{ decision: Decision; blocked: boolean; sidecarError?: string }> => {
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
      title: sessionTitleOf(ctx, payload.agent),
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

      // Normalization is a precondition, not a finding: the same rules run on the
      // cleaned text, and a changed-allowed step enters with the cleaned messages.
      const normalization = runtime.config.input.normalize
        ? normalizeInput(text)
        : { text, changed: false, zeroWidth: 0, comments: 0 }
      const scanned = normalization.text
      // A message made only of invisible characters leaves nothing to scan; pass
      // it through unchanged rather than entering an empty turn.
      if (scanned.length === 0) return next()

      const { decision, blocked, sidecarError } = await evaluate(scanned)
      const hit = foundSomething(decision)
      // A structural denial is already the strongest answer; judging on top of it
      // would spend a call to learn what we already act on.
      const wouldDeny = hit && (mode === 'enforce' || blocked)

      const judgeMode = runtime.config.input.judge
      const judgeEligible = inputJudge.available
        && !wouldDeny
        && (judgeMode === 'always' || (judgeMode === 'flagged' && hit))
      let judged = false
      let judgeBlocked = false
      let judgeUncertain = false
      const judgeLabels: Record<string, string> = {}
      let judgeMetrics: Record<string, number | undefined> = {}
      if (judgeEligible) {
        const verdict = await inputJudge.review(scanned, {
          maxChars: runtime.config.output.judge.maxChars,
          timeoutMs: runtime.config.output.judge.timeoutMs,
        })
        judged = true
        judgeBlocked = verdict.status === 'ok' && verdict.verdict === 'block'
        judgeUncertain = !(verdict.status === 'ok' && (verdict.verdict === 'allow' || verdict.verdict === 'block'))
        judgeLabels['judge'] = judgeBlocked ? 'block' : verdict.verdict === 'allow' ? 'allow' : 'unknown'
        judgeLabels['judge_status'] = verdict.status
        judgeMetrics = { ...verdict.metrics }
      }
      const uncertainDeny = judged && judgeUncertain && runtime.config.input.judgeFailClosed
      const deny = wouldDeny || judgeBlocked || uncertainDeny

      // Only label when the sidecar is configured: the built-in path's ledger lines
      // keep their pre-1.2.0 shape.
      const engineLabels: Record<string, string> | undefined = runtime.config.engine.kind !== 'sidecar'
        ? undefined
        : sidecarError === undefined
          ? { engine: 'sidecar' }
          : { engine: 'builtin', engine_error: sidecarError }
      const labels: Record<string, string> = { ...(engineLabels ?? {}), ...judgeLabels }
      if (normalization.changed) {
        labels['normalized'] = 'true'
        if (normalization.zeroWidth > 0) labels['zero_width'] = 'removed'
        if (normalization.comments > 0) labels['html_comment'] = 'removed'
      }
      const base = {
        ...runtime.sessionFields(sessionId, agentId),
        reason_code: judgeBlocked
          ? ReasonCode.InputJudgeBlocked
          : uncertainDeny
            ? ReasonCode.InputJudgeUnavailable
            : decision.reasonCode,
        rule_ids: [...decision.ruleIds],
        severity: judgeBlocked || uncertainDeny ? 'high' : decision.severity,
        category: judgeBlocked || uncertainDeny ? 'prompt_injection' : decision.category,
        detail_chars: text.length,
        ...(Object.keys(labels).length === 0 ? {} : { labels }),
      }
      const metrics = {
        chars: scanned.length,
        ...(normalization.changed ? { removed_chars: text.length - scanned.length } : {}),
        ...judgeMetrics,
      }

      /**
       * Enter the step, rewriting the user text when normalization changed it.
       *
       * The downstream decision is honoured first: a later listener may reject or
       * replace messages, and MODIFY must never turn a rejection into an enter.
       */
      const enter = async (): Promise<PreStepDecision> => {
        const downstream = await next()
        if (!normalization.changed || downstream.kind !== 'enter') return downstream
        const rewritten = rewriteUserText(downstream.messages, blockText => normalizeInput(blockText).text)
        return rewritten.changed ? { ...downstream, messages: rewritten.messages } : downstream
      }

      if (deny) {
        // Evidence first: an enforcement decision that cannot be recorded is not
        // taken (§7 "账本不可写 → deny").
        if (!runtime.ledgerPermitsEnforcement()) {
          runtime.counters.auditBlocked += 1
          runtime.logger.error('safeharness: refusing input because the audit ledger is unavailable')
          return { kind: 'reject' }
        }
        try {
          await runtime.auditStrict('input_denied', { ...base, decision: 'deny', metrics })
        } catch (error) {
          runtime.counters.auditBlocked += 1
          runtime.logger.error(`safeharness: input denial not recorded, failing closed: ${describe(error)}`)
          return { kind: 'reject' }
        }
        runtime.count('deny', sessionId)
        return { kind: 'reject' }
      }

      if (hit) {
        // warn / observe: record and continue untouched. No context is injected —
        // telling the model it was inspected pollutes the conversation (§6.4).
        runtime.audit('input_denied', { ...base, decision: 'warn', metrics })
        runtime.count('warn', sessionId)
        return enter()
      }

      runtime.audit('input_checked', { ...base, decision: 'allow', metrics })
      runtime.count('allow', sessionId)
      return enter()
    } catch (error) {
      // Observation surfaces survive their own bugs; an enforcing input guard
      // fails closed instead (§7 total principle).
      runtime.internalError('input', error)
      if (mode === 'enforce') return { kind: 'reject' }
      return next()
    }
  }, { prepend: true })
}

/** One-line error description for logs (never the offending content). */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
