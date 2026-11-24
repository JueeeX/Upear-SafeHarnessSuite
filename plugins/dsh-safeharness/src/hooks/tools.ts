/**
 * Tool surface: `tools/pre-execute` (async, deny/ask), `ctx.tools.guard` (sync
 * last line), `tools/post-execute` (result scan/block) and `tools/result`
 * (read-only observation). See §6.5 and Appendix A.
 *
 * Ordering is load-bearing: pre-execute may reorder decisions, the guard can only
 * make a call strictly less permitted, and a later listener can never turn a
 * guard denial back into an allow. `tools/result` performs no judgement at all.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'
import type { Runtime } from '../runtime.js'
import { foundSomething, RESULT_BLOCK_TEXT, TOOL_DENIAL_TEXT } from '../runtime.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { contentDigest } from '../util/hash.js'
import { ReasonCode } from '../engine/types.js'
import { collectArgumentStrings, matchNamePattern } from '../engine/tool.js'
import { scanSensitivePaths } from '../engine/sensitive-path.js'
import { agentIdOf, argsByteLength, callIdOf, sessionCreatedAtOf, sessionIdOf, sessionTitleOf, sessionWorkspaceOf, toolResultViewOf, toolViewOf } from './context.js'
import { observeSessionSandbox } from './sandbox.js'

/** Maximum number of in-flight call start times we keep (defensive bound). */
const MAX_INFLIGHT = 1024

/** The feedback block a blocked result is replaced with (never the value). */
const BLOCK_FEEDBACK: ContentBlock[] = [{ type: 'text', text: RESULT_BLOCK_TEXT }]

/**
 * Install every tool-pipeline listener.
 *
 * @param ctx - plugin context; all listeners dispose with the plugin fiber.
 * @param runtime - shared engine/ledger/state.
 */
export function installToolHooks(ctx: Context, runtime: Runtime): void {
  const startedAt = new Map<string, number>()

  /** Record the monotonic start time of one call, bounded. */
  function markStart(exec: ToolExecution): void {
    const id = callIdOf(exec)
    if (id === undefined) return
    startedAt.set(id, Date.now())
    if (startedAt.size > MAX_INFLIGHT) {
      const oldest = startedAt.keys().next()
      if (oldest.done !== true) startedAt.delete(oldest.value)
    }
  }

  /** Consume the start time of one call, when we recorded it. */
  function takeStart(exec: ToolExecution): number | undefined {
    const id = callIdOf(exec)
    if (id === undefined) return undefined
    const start = startedAt.get(id)
    startedAt.delete(id)
    return start
  }

  // ---------------------------------------------------------------------------
  // (a) tools/pre-execute — async policy gate
  // ---------------------------------------------------------------------------
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const cfg = runtime.config.tools
    if (cfg.mode === 'off') return next()

    markStart(exec)
    const sessionId = sessionIdOf(exec.agent)
    const agentId = agentIdOf(exec.agent)
    // A tool call is the moment the sandbox mode actually binds to an execution,
    // so record the session's mode here too: posture must answer for the sessions
    // that run tools, not only for the ones that reach `agent/pre-step`.
    try {
      observeSessionSandbox(runtime, ctx, exec.agent?.session)
    } catch (error) {
      runtime.internalError('tools:sandbox', error)
    }
    runtime.state.describe(sessionId, {
      workspace: sessionWorkspaceOf(exec.agent),
      createdAt: sessionCreatedAtOf(exec.agent),
      title: sessionTitleOf(ctx, exec.agent),
    })

    try {
      const view = toolViewOf(exec, runtime.config, ctx.tools)
      const session = runtime.state.view(sessionId)
      const decision = runtime.engine.evaluateTool(view, session)
      // Attempts advance the trail even when denied: a model hammering a denied
      // call is exactly the trajectory a chain rule should still see.
      if (cfg.trajectory) runtime.state.recordToolCall(sessionId, view)

      const base = {
        ...runtime.sessionFields(sessionId, agentId),
        tool: view.name,
        call_id: view.callId,
        reason_code: decision.reasonCode,
        rule_ids: [...decision.ruleIds],
        severity: decision.severity,
        category: decision.category,
        args_chars: view.argsBytes,
      }

      // A sensitive-path hit in `warn` mode (1.18.0). The engine only enforces this
      // gate when the scan is `enforce`; in `warn` the call proceeds, so the finding
      // is produced here instead of in the decision. It must NOT be produced as a
      // warn-only ALLOW from the engine: that short-circuits every later gate
      // (argument schemas, chains) and turns observation into permission.
      //
      // Every call is recorded, not once per session: each is a separate act of
      // reaching for a credential file, and the count is the evidence an operator
      // needs before switching the scan to `enforce`.
      if (cfg.sensitivePathScan === 'warn') {
        const walked = collectArgumentStrings(exec.arguments)
        const found = walked.truncated
          // Fail closed on the observation too: a payload too large to walk may be
          // hiding the path this check exists for, and silence would read as clean.
          ? undefined
          : scanSensitivePaths(walked.strings, runtime.config.tools.sensitivePathClasses ?? [])
        if (found !== undefined) {
          runtime.audit('tool_result_flagged', {
            ...base,
            decision: 'warn',
            reason_code: ReasonCode.ToolSensitivePath,
            rule_ids: [...found.classes],
            severity: 'high',
            category: 'sensitive_path',
          })
          runtime.count('warn', sessionId)
        }
      }

      // A descriptor hit in `warn` mode is the one ALLOW that still carries a
      // finding: the call proceeds, but the tool itself is recorded once per
      // session (kernel `mcp_guard` warns per listing; a DSH session lists a tool
      // once, so warning once per session is the equivalent).
      if (decision.kind === 'allow' && decision.reasonCode === ReasonCode.ToolDescriptor) {
        if (runtime.state.noteDescriptorFlag(sessionId, view.name)) {
          runtime.audit('tool_descriptor_flagged', {
            ...base,
            decision: 'warn',
            reason_code: decision.reasonCode,
            rule_ids: [...decision.ruleIds],
            severity: decision.severity,
            category: decision.category,
          })
          runtime.count('warn', sessionId)
        }
        return next()
      }

      if (!foundSomething(decision) || decision.kind === 'allow') {
        runtime.count('allow', sessionId)
        return next()
      }

      if (cfg.mode === 'warn') {
        runtime.audit('tool_denied', { ...base, decision: 'warn' })
        runtime.count('warn', sessionId)
        return next()
      }

      // --- enforce ---
      if (!runtime.ledgerPermitsEnforcement()) {
        runtime.counters.auditBlocked += 1
        runtime.logger.error('safeharness: refusing a tool call because the audit ledger is unavailable')
        return { kind: 'deny', reason: TOOL_DENIAL_TEXT }
      }

      if (decision.kind === 'ask') {
        // `ask` is only survivable when an approval answerer exists; otherwise the
        // registry would turn it into a denial anyway, so fail closed here (§7).
        const approvalAvailable = ctx.get('approval') !== undefined
        try {
          await runtime.auditStrict('tool_asked', { ...base, decision: approvalAvailable ? 'ask' : 'deny' })
        } catch {
          runtime.counters.auditBlocked += 1
          return { kind: 'deny', reason: TOOL_DENIAL_TEXT }
        }
        if (!approvalAvailable) {
          runtime.count('deny', sessionId)
          return { kind: 'deny', reason: TOOL_DENIAL_TEXT }
        }
        runtime.count('ask', sessionId)
        return { kind: 'ask', reason: TOOL_DENIAL_TEXT }
      }

      try {
        await runtime.auditStrict('tool_denied', { ...base, decision: 'deny' })
      } catch {
        runtime.counters.auditBlocked += 1
        runtime.logger.error('safeharness: tool denial not recorded, failing closed')
        return { kind: 'deny', reason: TOOL_DENIAL_TEXT }
      }
      runtime.count('deny', sessionId)
      return { kind: 'deny', reason: TOOL_DENIAL_TEXT }
    } catch (error) {
      runtime.internalError('tool', error)
      // Execution surface: unknown state denies (§7). The deny branch does not call
      // `next()`, so the call never dispatches.
      return cfg.mode === 'enforce'
        ? { kind: 'deny', reason: TOOL_DENIAL_TEXT }
        : next()
    }
  }, { prepend: true })

  // ---------------------------------------------------------------------------
  // (b) ctx.tools.guard — synchronous, in-memory only, cannot be overridden
  // ---------------------------------------------------------------------------
  ctx.tools.guard((exec) => {
    const cfg = runtime.config.tools
    if (cfg.mode !== 'enforce') return undefined
    try {
      // Only O(1)-ish, allocation-bounded checks are legal here: no IO, no async,
      // no engine call that could touch the ledger (§6.5(b), p99 < 1ms).
      if (matchNamePattern(exec.name, cfg.denyTools)) {
        runtime.count('deny', sessionIdOf(exec.agent))
        return TOOL_DENIAL_TEXT
      }
      if (argsByteLength(exec.arguments) > cfg.maxArgsBytes) {
        runtime.count('deny', sessionIdOf(exec.agent))
        return TOOL_DENIAL_TEXT
      }
      return undefined
    } catch {
      // A throwing guard must never become an allow.
      runtime.counters.internalErrors += 1
      return TOOL_DENIAL_TEXT
    }
  })

  // ---------------------------------------------------------------------------
  // (d) tools/post-execute — result scanning (credential leak / injection marker)
  // ---------------------------------------------------------------------------
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const cfg = runtime.config.results
    const downstream = await next()
    if (cfg.mode === 'off') return downstream

    const sessionId = sessionIdOf(exec.agent)
    const agentId = agentIdOf(exec.agent)
    try {
      const view = toolResultViewOf(exec, result)
      const findings = runtime.engine.evaluateToolResult(view)
      if (findings.length === 0) return downstream

      const categories = findings.map((item) => item.category)
      const ruleIds = [...new Set(findings.flatMap((item) => [...item.ruleIds]))]
      const severity = findings.some((item) => item.severity === 'critical') ? 'critical' : 'high'
      const digest = contentDigest(view.text.length > 0 ? view.text : view.valueText)
      const fields = {
        ...runtime.sessionFields(sessionId, agentId),
        tool: view.name,
        call_id: view.callId,
        rule_ids: ruleIds,
        severity,
        detail_sha256: digest.sha256,
        detail_chars: digest.chars,
        labels: { categories: categories.join(',') },
      }

      const blocking = cfg.mode === 'enforce' && categories.some((category) => cfg.blockOn.includes(category))
      // Repeat suppression (1.19.0). Measured 2026-11-24: 132 injection_marker rows in
      // one day collapsed to seven distinct content digests — the same file flagged on
      // every edit that touched it. Re-scanning content that already produced a row is
      // not new evidence, so a repeat only bumps a counter the next row carries.
      //
      // Blocks are NEVER suppressed: a denial must be recorded in full every time it
      // happens, because the ledger is the evidence a denial occurred. Only the
      // warn/spam case is collapsed, and the count still shows the pressure.
      const occurrence = blocking ? 1 : runtime.state.noteResultFinding(sessionId, `${view.name}:${digest.sha256}`)
      if (!blocking && occurrence > 1) {
        runtime.count('warn', sessionId)
        return downstream
      }
      runtime.audit('tool_result_flagged', { ...fields, decision: blocking ? 'block' : 'warn' })
      runtime.count(blocking ? 'deny' : 'warn', sessionId)

      if (!blocking) return downstream

      // Blocking replaces the whole outcome (the canonical value is dropped), not
      // just the rendered content — content substitution is not a boundary (§6.5(d)).
      return { kind: 'block', feedback: BLOCK_FEEDBACK, additionalContexts: downstream.additionalContexts }
    } catch (error) {
      runtime.internalError('result', error)
      // Enforcing result scan fails closed: the value could be leaking.
      return cfg.mode === 'enforce'
        ? { kind: 'block', feedback: BLOCK_FEEDBACK, additionalContexts: downstream.additionalContexts }
        : downstream
    }
  })

  // ---------------------------------------------------------------------------
  // (e) tools/result — read-only observation, no judgement whatsoever
  // ---------------------------------------------------------------------------
  ctx.on('tools/result', (exec, result: ToolExecutionResult) => {
    try {
      const start = takeStart(exec)
      const sessionId = sessionIdOf(exec.agent)
      const agentId = agentIdOf(exec.agent)
      // Repeated-attempt pressure (kernel `trajectory.py`): a failed execution raises
      // the per-tool counter a later pre-execute check reads; a success clears it.
      runtime.state.recordToolOutcome(sessionId, exec.name, result.isError)
      const args = contentDigest(exec.arguments)
      const content = contentDigest(result.content.map((block) => (block.type === 'text' ? block.text : block.type)))
      const metrics: Record<string, number | boolean> = { is_error: result.isError, content_chars: content.chars }
      if (start !== undefined) metrics.duration_ms = Date.now() - start
      runtime.audit('tool_result', {
        ...runtime.sessionFields(sessionId, agentId),
        tool: exec.name,
        call_id: callIdOf(exec),
        decision: result.isError ? 'error' : 'ok',
        args_sha256: args.sha256,
        args_chars: args.chars,
        detail_sha256: content.sha256,
        detail_chars: content.chars,
        metrics,
      })
    } catch (error) {
      runtime.internalError('tools/result', error)
    }
  })
}
