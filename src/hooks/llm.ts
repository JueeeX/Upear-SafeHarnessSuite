/**
 * Output surface: `llm/stream` review, buffering and budget accounting
 * (§6.6, T3.1/T3.2/T3.5).
 *
 * Three modes, one listener:
 *
 *  * `off` — nothing is reviewed (budget accounting still runs when configured:
 *    it costs one counter update per usage chunk and is independent of review).
 *  * `warn` — chunks pass through untouched; the finished answer is scanned with
 *    the rule set and, when configured, the semantic judge. Findings are recorded,
 *    never acted on.
 *  * `enforce-buffer` — every chunk is held until the answer finishes, then either
 *    replayed or replaced by {@link OUTPUT_BLOCK_TEXT}. Documented cost: no
 *    streaming, first token arrives at the end, bounded by the configured
 *    `bufferTimeoutMs` / `bufferMaxChars`; past either bound the stream *degrades*
 *    to pass-through and says so in the ledger rather than holding the answer.
 *
 * Recursion guard (decision D6): the judge is a model call, so its own stream must
 * not be reviewed and must not be judged again. `GenerateOptions.purpose` is a
 * closed union (`'compaction' | 'session-title'`, §12 R17), so the judge request
 * carries {@link JUDGE_REQUEST_MARK} — a symbol on the object we hand to
 * `ctx.llm.stream()`, which the host passes to this very waterfall by reference
 * (`dsh-llm/src/index.ts:917-927`, verified). A depth counter is the second line of
 * defence in case a future host re-materializes the request object.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Runtime } from '../runtime.js'
import { foundSomething, OUTPUT_BLOCK_TEXT } from '../runtime.js'
import { contentDigest } from '../util/hash.js'
import { ReasonCode, type Decision } from '../engine/types.js'
import { createJudge, JUDGE_REQUEST_MARK, type Judge, type JudgeResult, type JudgeStatus } from '../judge/client.js'

/** Characters of assistant text we keep for post-stream scanning. */
export const MAX_OUTPUT_SCAN_CHARS = 128 * 1024

/**
 * Auxiliary model calls that must never be reviewed: compaction summaries and
 * session titles are bookkeeping, and reviewing them would add cost without
 * protecting the user.
 */
const SKIP_PURPOSES: ReadonlySet<string> = new Set(['compaction', 'session-title'])

/** What the post-stream review decided. */
interface ReviewOutcome {
  /** Disposition recorded in the ledger (`deny` only ever happens when buffering). */
  readonly decision: 'allow' | 'warn' | 'deny'
  readonly reasonCode: string
  readonly ruleIds: readonly string[]
  readonly severity?: string
  readonly judgeStatus?: JudgeStatus
  /** True when the buffered answer must be replaced. */
  readonly blocked: boolean
  readonly labels: Record<string, string | undefined>
  readonly metrics: Record<string, number | boolean | undefined>
}

/**
 * Build the judge handle over this host's `ctx.llm` route.
 *
 * Exported so the composition root can also hand the same handle to the
 * `/safeharness judge` diagnostic: a probe must travel the exact route the output
 * guard would use, otherwise "it works" would prove nothing about interception.
 * The handle is cheap (no state, no I/O) and safe to construct twice.
 *
 * @param ctx - plugin context; `ctx.get('llm')` is read on every call.
 * @param runtime - shared config (judge route can change on settings reload).
 * @returns a judge whose `available` is false when the profile composes no llm.
 */
export function createJudgeFor(ctx: Context, runtime: Runtime): Judge {
  return createJudge(judgeCallOf(ctx, runtime))
}

/**
 * Install the model-stream listener.
 *
 * @param ctx - plugin context; the listener is disposed with the plugin fiber.
 * @param runtime - shared engine/ledger/state/config.
 */
export function installLlmHook(ctx: Context, runtime: Runtime): void {
  const judge = createJudgeFor(ctx, runtime)
  /** How many judge calls are in flight (D6 second line of defence). */
  let judgeDepth = 0

  ctx.on('llm/stream', async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
    // The judge's own request: never reviewed, never judged (D6).
    if (isJudgeRequest(options)) {
      yield* next()
      return
    }
    const purpose = (options as { purpose?: string }).purpose
    if (purpose !== undefined && SKIP_PURPOSES.has(purpose)) {
      yield* next()
      return
    }

    const mode = runtime.config.output.mode
    const buffering = mode === 'enforce-buffer'
    if (mode === 'off') {
      // Review disabled: only the (independent) budget accounting remains. Passing
      // the stream straight through keeps "off" meaning exactly that in the ledger.
      if (!runtime.budget.enabled) {
        yield* next()
        return
      }
      const session = typeof options.sessionId === 'string' ? options.sessionId : undefined
      for await (const chunk of next()) {
        if (chunk.type === 'usage') noteBudget(runtime, session, chunk.usage)
        yield chunk
      }
      return
    }

    const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined
    const startedAt = Date.now()
    const held: StreamChunk[] = []
    let chars = 0
    let text = ''
    let truncated = false
    let usage: TokenUsage | undefined
    let finishKind: string | undefined
    let completed = false
    let degraded: string | undefined
    let judgeMs: number | undefined

    /** Accumulate one chunk into the scan state and the budget counters. */
    const observe = (chunk: StreamChunk): void => {
      if (chunk.type === 'text-delta') {
        chars += chunk.text.length
        if (!truncated) {
          text += chunk.text
          if (text.length >= MAX_OUTPUT_SCAN_CHARS) {
            truncated = true
            text = text.slice(0, MAX_OUTPUT_SCAN_CHARS)
          }
        }
        return
      }
      if (chunk.type === 'usage') {
        usage = chunk.usage
        noteBudget(runtime, sessionId, chunk.usage)
        return
      }
      if (chunk.type === 'finish') finishKind = chunk.reason.kind
    }

    try {
      for await (const chunk of next()) {
        observe(chunk)
        if (!buffering) {
          // Observation must not alter timing or content semantics.
          yield chunk
          continue
        }
        held.push(chunk)
        if (degraded === undefined) {
          if (text.length > runtime.config.output.bufferMaxChars) degraded = 'max_chars'
          else if (Date.now() - startedAt > runtime.config.output.bufferTimeoutMs) degraded = 'timeout'
          if (degraded !== undefined) {
            // Bound exceeded: hand over what we already hold and stop buffering
            // rather than making the user wait for a review that may never finish.
            for (const pending of held) yield pending
            held.length = 0
          }
        }
      }
      completed = true
    } finally {
      // A consumer that stops early leaves no auditable answer to review.
      if (!completed) held.length = 0
    }
    if (!completed) return

    // ---- post-stream review -------------------------------------------------
    const reviewStartedAt = Date.now()
    // A degraded buffer already handed the answer over chunk by chunk, so it can no
    // longer be replaced: review it as an observation and say why in the ledger.
    const canReplace = buffering && degraded === undefined
    let outcome: ReviewOutcome
    try {
      outcome = await reviewOutput(runtime, text, {
        buffering: canReplace,
        failed: finishKind === 'error' || finishKind === 'aborted',
        ...(finishKind === undefined ? {} : { finish: finishKind }),
        judgeAllowed: judgeDepth === 0,
        onJudgeStart: () => { judgeDepth += 1; judgeMs = Date.now() },
        onJudgeEnd: () => { judgeDepth -= 1; judgeMs = Date.now() - (judgeMs ?? Date.now()) },
      }, judge)
    } catch (error) {
      runtime.internalError('llm/stream', error)
      // Observation surfaces survive their own bugs; a buffered answer must still
      // reach the user rather than vanishing because our review threw.
      if (canReplace) yield* refusalChunks(usage)
      else for (const pending of held) yield pending
      return
    }

    const digest = contentDigest(text)
    const metrics: Record<string, number | boolean | undefined> = {
      chars,
      duration_ms: Date.now() - startedAt,
      review_ms: Date.now() - reviewStartedAt,
      truncated,
    }
    // Metric names deliberately avoid the substring "token": the ledger's
    // key-name redactor treats any `*token*` key as a credential and would blank
    // the value before it is written.
    if (usage !== undefined) {
      metrics.usage_input = usage.inputTokens
      metrics.usage_output = usage.outputTokens
    }
    if (judgeMs !== undefined) metrics.judge_ms = judgeMs
    if (degraded !== undefined) metrics.buffer_chars = chars

    runtime.audit('output_reviewed', {
      ...runtime.sessionFields(sessionId),
      decision: outcome.decision,
      reason_code: outcome.reasonCode,
      rule_ids: [...outcome.ruleIds],
      severity: outcome.severity,
      detail_sha256: digest.sha256,
      detail_chars: digest.chars,
      labels: {
        ...outcome.labels,
        // Why a configured buffer did not hold: `timeout` or `max_chars`. Recorded
        // so "enforce-buffer was supposed to block this" stays answerable.
        ...(degraded === undefined ? {} : { buffer: degraded }),
      },
      metrics: { ...metrics, ...outcome.metrics },
    })
    runtime.count(outcome.decision === 'deny' ? 'deny' : outcome.decision === 'warn' ? 'warn' : 'allow', sessionId)

    if (!buffering) return
    if (outcome.blocked && canReplace) {
      yield* refusalChunks(usage)
      return
    }
    for (const pending of held) yield pending
  })
}

/** Options threaded into {@link reviewOutput}. */
interface ReviewHooks {
  readonly buffering: boolean
  /** Whether the provider reported a terminal failure (no answer to review). */
  readonly failed: boolean
  /** Terminal finish kind, when the provider reported one (`stop`, `error`, …). */
  readonly finish?: string
  /** False while another judge call is in flight (recursion protection). */
  readonly judgeAllowed: boolean
  onJudgeStart(): void
  onJudgeEnd(): void
}

/**
 * Decide what one finished answer amounts to.
 *
 * The matrix follows §7 with one addition: the judge's *failure* modes are keyed
 * off the preset, not off the output mode, so a hardened deployment that cannot
 * reach its judge refuses the answer while balanced records a warning and lets the
 * answer through. `bad_json` and `empty` count as a judge failure — the judge
 * answered but its answer cannot be trusted, so treating it as "allow" would be
 * exactly the "error means pass" the plan forbids.
 */
async function reviewOutput(
  runtime: Runtime,
  text: string,
  hooks: ReviewHooks,
  judge: Judge,
): Promise<ReviewOutcome> {
  const ruleDecision: Decision = runtime.engine.evaluateOutput(text)
  const ruleHit = foundSomething(ruleDecision)
  const cfg = runtime.config
  // A tool-call-only answer has no text to review: judging an empty string would
  // turn every normal tool step into a `judge` finding (observed live in T3.7).
  const hasText = text.trim().length > 0
  const judgeWanted = hasText && cfg.output.judge.enabled && (cfg.output.judge.scope === 'always' || ruleHit)
  const labels: Record<string, string | undefined> = {}
  const metrics: Record<string, number | boolean | undefined> = {}

  let judgeResult: JudgeResult | undefined
  if (!hasText) {
    if (cfg.output.judge.enabled) labels.judge_status = 'skipped_empty'
  } else if (judgeWanted && hooks.judgeAllowed) {
    hooks.onJudgeStart()
    try {
      judgeResult = await judge.review(text, {
        maxChars: cfg.output.judge.maxChars,
        timeoutMs: cfg.output.judge.timeoutMs,
      })
    } finally {
      hooks.onJudgeEnd()
    }
  } else if (judgeWanted) {
    // Another judge call is in flight: skip rather than nest (D6).
    labels.judge_status = 'skipped_recursion'
  }

  let decision: 'allow' | 'warn' | 'deny' = ruleHit ? (hooks.buffering ? 'deny' : 'warn') : 'allow'
  let reasonCode: string = ruleHit ? ruleDecision.reasonCode : ReasonCode.None
  let ruleIds: readonly string[] = ruleDecision.ruleIds
  let severity: string | undefined = ruleDecision.severity

  if (judgeResult !== undefined) {
    labels.judge_status = judgeResult.status
    Object.assign(labels, judgeResult.labels)
    Object.assign(metrics, judgeResult.metrics)
    if (judgeResult.status === 'ok') {
      if (judgeResult.blocked) {
        decision = hooks.buffering ? 'deny' : 'warn'
        reasonCode = ReasonCode.OutputJudgeBlocked
        ruleIds = [...ruleIds, 'judge:block']
        severity = 'high'
      }
    } else if (cfg.preset === 'hardened') {
      // §7: hardened refuses the answer when the judge it requires is unusable.
      reasonCode = ReasonCode.OutputJudgeUnavailable
      if (hooks.buffering) {
        decision = 'deny'
      } else {
        // warn mode cannot replace output; record the truth (would have blocked)
        // instead of reporting a denial that never happened.
        decision = 'warn'
        metrics.would_block = true
      }
      labels.judge_fail_closed = 'true'
    } else if (!ruleHit) {
      decision = 'warn'
      reasonCode = ReasonCode.OutputJudgeUnavailable
    }
  }

  if (decision === 'allow' && hooks.failed) {
    // A provider failure still reaches us as a terminal finish chunk; there is no
    // answer to review, so record it as a warning with the finish kind — that
    // keeps "model failed" visible in evidence without pretending the output
    // passed a review.
    decision = 'warn'
  }
  if (hooks.failed) labels.finish = hooks.finish ?? 'failed'

  return {
    decision,
    reasonCode,
    ruleIds,
    severity,
    ...(labels.judge_status === undefined ? {} : { judgeStatus: labels.judge_status as JudgeStatus }),
    blocked: decision === 'deny' && hooks.buffering,
    labels,
    metrics,
  }
}

/**
 * The synthetic stream returned instead of a blocked answer.
 *
 * Shaped like a real text answer (`block-start` / `text-delta` / `block-end`) so
 * the host assembler and the session log see one ordinary text block; the usage
 * chunk is preserved because the tokens were really consumed.
 */
async function* refusalChunks(usage: TokenUsage | undefined): AsyncGenerator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: OUTPUT_BLOCK_TEXT }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: OUTPUT_BLOCK_TEXT } }
  if (usage !== undefined) yield { type: 'usage', usage }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Whether this request is the judge's own (marker set by {@link judgeCallOf}). */
function isJudgeRequest(options: unknown): boolean {
  if (options === null || typeof options !== 'object') return false
  return (options as Record<symbol, unknown>)[JUDGE_REQUEST_MARK] === true
}

/**
 * Build the judge's model call from `ctx.llm` (§6.6: use the host's LLM service,
 * never our own HTTP client).
 *
 * The route (provider/model) is read from the live config on every call, so a
 * settings hot-reload changes the judge model without re-registering the hook.
 *
 * @returns the call adapter, or `undefined` when this profile composes no `llm`
 *   service (the judge then reports `unavailable`, which §7 degrades by preset).
 */
function judgeCallOf(ctx: Context, runtime: Runtime): ((prompt: string, options: { signal: AbortSignal; maxTokens: number }) => AsyncIterable<{ type: string; text?: string }>) | undefined {
  const service = ctx.get('llm') as { stream?: (options: unknown) => AsyncIterable<StreamChunk> } | undefined
  const dispatch = service?.stream?.bind(service)
  if (dispatch === undefined) return undefined
  return (prompt, options) => {
    const cfg = runtime.config.output.judge
    const request = {
      provider: cfg.provider,
      model: cfg.model,
      system: prompt,
      messages: [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        // The published 0.2.2-rc.1 type surface omits `plugin` from the message
        // source union, while the running host accepts it (verified: judge calls
        // stream normally on the real host). The cast keeps the runtime provenance
        // without pinning the build to one revision of those types.
        source: { kind: 'plugin', plugin: '@upear/dsh-safeharness' } as never,
      })],
      maxTokens: options.maxTokens,
      signal: options.signal,
      [JUDGE_REQUEST_MARK]: true,
    }
    return dispatch(request) as AsyncIterable<StreamChunk>
  }
}

/**
 * Fold one usage chunk into the per-turn budget (§6.2 `budget.maxTokensPerTurn`).
 *
 * The guard is advisory (warn first, T3.5): it records one `budget_exceeded` line
 * on the call that crosses the limit and never vetoes the stream.
 */
function noteBudget(runtime: Runtime, sessionId: string | undefined, usage: TokenUsage): void {
  if (!runtime.budget.enabled) return
  try {
    const before = runtime.budget.snapshot(sessionId).exceeded
    const after = runtime.budget.record(sessionId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    if (before || !after.exceeded) return
    runtime.audit('budget_exceeded', {
      ...runtime.sessionFields(sessionId),
      decision: 'warn',
      reason_code: 'budget_exceeded',
      metrics: { used: after.used, limit: after.limit, turn: after.turn },
    })
    runtime.count('warn', sessionId)
  } catch (error) {
    runtime.internalError('llm/stream:budget', error)
  }
}
