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
import { MAX_BUFFERED_OUTPUT_CHARS } from '../config.js'
import { contentDigest } from '../util/hash.js'
import { redactCredentialValues } from '../engine/tool.js'
import { ReasonCode, type Decision } from '../engine/types.js'
import { createJudge, JUDGE_REQUEST_MARK, judgeLedgerMetrics, type Judge, type JudgeCallOptions, type JudgeCallOptionsForModel, type JudgeResult, type JudgeStatus } from '../judge/client.js'
import { createRuleDrafter, DRAFT_REQUEST_MARK, type RuleDrafter } from '../draft/rule.js'

/** Characters of assistant text we keep for post-stream scanning. */
export const MAX_OUTPUT_SCAN_CHARS = MAX_BUFFERED_OUTPUT_CHARS

/**
 * Text held back before streaming so a credential split across two deltas still
 * matches. A provider emits a few characters per delta; without a window,
 * `"LLM_API_KEY": "…"` arrives in pieces and no single delta matches. 256 chars
 * covers every pattern here (a JWT is the longest common one) at the cost of a
 * one-off delay of that many characters.
 */
export const REDACT_TAIL_CHARS = 256

/** Per-block redaction state (held tail + what was already handed over). */
interface RedactState {
  /** Characters not yet emitted (the matching window's tail). */
  pending: string
  /** The redacted text emitted so far, used to rewrite `block-end`. */
  emitted: string
  /** How many values in this block were replaced. */
  count: number
  /** Whether the provider opened this block (then a synthetic `block-end` is due). */
  opened: boolean
  /** Which stream this block belongs to (1.18.0): text or reasoning. */
  kind: 'text' | 'reasoning'
}

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
 * The output judge's per-call limits, read from the live config (1.21.0).
 *
 * Exported so the panel and the `/safeharness judge probe` travel with the same
 * budget and effort as a real review: a probe that used different knobs would not be
 * evidence about the deployment.
 *
 * @param runtime - shared config (a settings reload changes every field here).
 * @returns the review options for {@link Judge.review}.
 */
export function outputJudgeLimits(runtime: Runtime): JudgeCallOptions {
  const cfg = runtime.config.output.judge
  return {
    maxChars: cfg.maxChars,
    timeoutMs: cfg.timeoutMs,
    maxTokens: cfg.maxTokens,
    ...(cfg.reasoningEffort.length === 0 ? {} : { reasoningEffort: cfg.reasoningEffort }),
  }
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
    // Auxiliary calls (judge, rule drafting): never reviewed, never judged (D6).
    if (isJudgeRequest(options) || isDraftRequest(options)) {
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
    /** Per-block redaction state for the streaming (non-buffering) path. */
    const redactStates = new Map<number, RedactState>()
    /** How many credential values were replaced before the user saw them. */
    let redactedCount = 0
    let chars = 0
    let text = ''
    let truncated = false
    let usage: TokenUsage | undefined
    let finishKind: string | undefined
    let completed = false
    let degraded: string | undefined
    let judgeMs: number | undefined
    /**
     * Reasoning (thinking) accumulation, 1.18.0.
     *
     * Until 1.17.x this stream never looked at `reasoning-delta`: the text went to the
     * user unreviewed, unrecorded and unredacted. Measured on 2026-11-24, a model
     * reasoned "there's a security layer, but I shouldn't editorialize" and then read a
     * secret — the deliberation that mattered was the one surface with no coverage.
     */
    let reasoning = ''
    let reasoningChars = 0
    let reasoningTruncated = false
    let reasoningRedacted = 0

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
      if (chunk.type === 'reasoning-delta') {
        reasoningChars += chunk.text.length
        if (!reasoningTruncated) {
          reasoning += chunk.text
          if (reasoning.length >= MAX_OUTPUT_SCAN_CHARS) {
            reasoningTruncated = true
            reasoning = reasoning.slice(0, MAX_OUTPUT_SCAN_CHARS)
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

    /** Hand over one block's held tail, redacted (never the raw value). */
    const flushBlock = (index: number, state: RedactState, kind: 'text' | 'reasoning' = 'text'): StreamChunk[] => {
      const tail = redactCredentialValues(state.pending)
      state.pending = ''
      state.count += tail.count
      if (kind === 'reasoning') reasoningRedacted += tail.count
      else redactedCount += tail.count
      state.emitted += tail.text
      if (tail.text.length === 0) return []
      // The delta type must match the block it belongs to: a reasoning tail emitted as
      // `text-delta` would append the model's scratchpad to the visible answer.
      return [kind === 'reasoning'
        ? { type: 'reasoning-delta', index, text: tail.text }
        : { type: 'text-delta', index, text: tail.text }]
    }

    /** Hand over every held tail; closes blocks the provider opened but never closed. */
    const flushAll = (): StreamChunk[] => {
      const chunks: StreamChunk[] = []
      for (const [index, state] of redactStates) {
        chunks.push(...flushBlock(index, state, state.kind))
        if (state.opened) chunks.push({ type: 'block-end', index, block: { type: state.kind, text: state.emitted } })
      }
      redactStates.clear()
      return chunks
    }

    try {
      for await (const chunk of next()) {
        observe(chunk)
        if (!buffering) {
          // Streaming path: ordinary text passes through byte-identically, but a
          // credential-shaped value is replaced before the user can see it. The
          // tail (REDACT_TAIL_CHARS) is held so a secret split across deltas still
          // matches; `block-end` carries the authoritative text, so it is rewritten
          // with the redacted version.
          if (chunk.type === 'block-start') {
            if (chunk.blockType === 'text' || chunk.blockType === 'reasoning') {
              const kind = chunk.blockType === 'text' ? 'text' : 'reasoning'
              redactStates.set(chunk.index, { pending: '', emitted: '', count: 0, opened: true, kind })
            }
            yield chunk
            continue
          }
          // Reasoning gets the same window as text (1.18.0). It is NOT reviewed for
          // policy here — that happens once after the stream — but a credential the
          // model repeats while thinking must not reach the screen unredacted, and the
          // split-across-deltas problem is identical.
          if (chunk.type === 'reasoning-delta') {
            if (!runtime.config.output.reasoningRedact) {
              yield chunk
              continue
            }
            const state = redactStates.get(chunk.index) ?? { pending: '', emitted: '', count: 0, opened: false, kind: 'text' as const }
            redactStates.set(chunk.index, state)
            state.pending += chunk.text
            if (state.pending.length > REDACT_TAIL_CHARS) {
              const cut = state.pending.length - REDACT_TAIL_CHARS
              const head = state.pending.slice(0, cut)
              state.pending = state.pending.slice(cut)
              const redacted = redactCredentialValues(head)
              state.count += redacted.count
              reasoningRedacted += redacted.count
              state.emitted += redacted.text
              if (redacted.text.length > 0) yield { ...chunk, text: redacted.text }
            }
            continue
          }
          if (chunk.type === 'text-delta') {
            const state = redactStates.get(chunk.index) ?? { pending: '', emitted: '', count: 0, opened: false, kind: 'text' as const }
            redactStates.set(chunk.index, state)
            state.pending += chunk.text
            if (state.pending.length > REDACT_TAIL_CHARS) {
              const cut = state.pending.length - REDACT_TAIL_CHARS
              const head = state.pending.slice(0, cut)
              state.pending = state.pending.slice(cut)
              const redacted = redactCredentialValues(head)
              state.count += redacted.count
              redactedCount += redacted.count
              state.emitted += redacted.text
              if (redacted.text.length > 0) yield { ...chunk, text: redacted.text }
            }
            continue
          }
          if (chunk.type === 'block-end') {
            const state = redactStates.get(chunk.index)
            if (state !== undefined) {
              for (const flushed of flushBlock(chunk.index, state, state.kind)) yield flushed
              redactStates.delete(chunk.index)
              const block = chunk.block
              // A reasoning block carries its own type: rewriting it as `text` would
              // turn the model's scratchpad into part of the answer.
              if (block.type !== 'text' && block.type !== 'reasoning') {
                yield chunk
                continue
              }
              yield { ...chunk, block: { ...block, text: state.emitted } }
              continue
            }
            yield chunk
            continue
          }
          // A terminal or usage chunk while text is still held: hand the text over
          // first, so the host sees the provider's order and nothing is lost when a
          // provider ends without a `block-end`.
          if (redactStates.size > 0) for (const flushed of flushAll()) yield flushed
          yield chunk
          continue
        }
        if (degraded !== undefined) {
          // Past a bound the answer is already being handed over: passing every
          // later chunk straight through keeps the “degrade to pass-through”
          // promise and stops `held` from growing without limit.
          yield chunk
          continue
        }
        held.push(chunk)
        // Use the total character count, not `text.length`: `text` stops growing
        // at the scan cap, so a longer answer would never cross a large cap and
        // `held` would grow without limit.
        if (chars > runtime.config.output.bufferMaxChars) degraded = 'max_chars'
        else if (Date.now() - startedAt > runtime.config.output.bufferTimeoutMs) degraded = 'timeout'
        if (degraded !== undefined) {
          // Bound exceeded: hand over what we already hold and stop buffering
          // rather than making the user wait for a review that may never finish.
          for (const pending of held) yield pending
          held.length = 0
        }
      }
      completed = true
    } finally {
      // A consumer that stops early leaves no auditable answer to review.
      if (!completed) held.length = 0
    }
    if (!completed) return

    // Text still held when the provider ended without a `block-end`: hand it over
    // (redacted) before reviewing, so nothing the model produced is silently lost.
    if (!buffering && redactStates.size > 0) {
      for (const flushed of flushAll()) yield flushed
    }

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
    if (redactedCount > 0) metrics.redacted_count = redactedCount

    // ---- reasoning (1.18.0) --------------------------------------------------
    //
    // Reviewing the answer but not the deliberation was a real blind spot: on
    // 2026-11-24 a model reasoned "there's a security layer, but I shouldn't
    // editorialize" and then read a secret. The honest limit of this block is that it
    // only ever sees reasoning the provider chose to stream.
    const reasoningMode = runtime.config.output.reasoning
    const reasoningLabels: Record<string, string | undefined> = {}
    let reasoningDecision: 'allow' | 'warn' = 'allow'
    let reasoningReason: string = ReasonCode.None
    let reasoningRuleIds: readonly string[] = []
    if (reasoningMode !== 'off' && reasoningChars > 0) {
      const reasoningDigest = contentDigest(reasoning)
      // The structural scan is local and free: run it even in `observe`, because a
      // credential the model repeats to itself is worth a warning with or without the
      // judge. Only the classes and rule ids are recorded.
      const ruleDecision = runtime.engine.evaluateOutput(reasoning)
      reasoningRuleIds = [...ruleDecision.ruleIds]
      if (foundSomething(ruleDecision)) {
        reasoningDecision = 'warn'
        reasoningReason = ruleDecision.reasonCode
      }
      reasoningLabels.reasoning_chars = String(reasoningChars)
      reasoningLabels.reasoning_sha256 = reasoningDigest.sha256
      if (reasoningTruncated) reasoningLabels.reasoning_truncated = 'true'
      if (reasoningRedacted > 0) {
        reasoningLabels.reasoning_redacted = 'credential'
        reasoningLabels.reasoning_redacted_count = String(reasoningRedacted)
        metrics.reasoning_redacted_count = reasoningRedacted
      }
      reasoningLabels.reasoning_mode = reasoningMode
      if (reasoningMode === 'judge' && judgeDepth === 0) {
        // The operator asked for this explicitly: the reasoning goes to the judge like
        // the answer does. Same cap, same timeout, same recursion guard.
        judgeDepth += 1
        const startedJudge = Date.now()
        try {
          const judged = await judge.review(reasoning, outputJudgeLimits(runtime))
          reasoningLabels.reasoning_judge = judged.status
          if (judged.status === 'ok' && judged.blocked) {
            reasoningDecision = 'warn'
            reasoningReason = ReasonCode.OutputJudgeBlocked
            reasoningRuleIds = [...reasoningRuleIds, 'judge:block']
          }
        } catch {
          // The judge never throws by contract; if it did, the reasoning record keeps
          // its structural verdict rather than losing the whole audit row.
          reasoningLabels.reasoning_judge = 'unavailable'
        } finally {
          judgeDepth -= 1
          judgeMs = Date.now() - startedJudge
        }
      }
      runtime.audit('invariant_probe', {
        decision: reasoningDecision,
        reason_code: reasoningReason,
        rule_ids: [...reasoningRuleIds],
        ...runtime.sessionFields(sessionId),
        labels: { state: 'reasoning_reviewed', ...reasoningLabels },
        metrics: { reasoning_chars: reasoningChars },
      })
      if (reasoningDecision === 'warn') runtime.count('warn', sessionId)
    } else if (reasoningMode !== 'off') {
      // Telemetry that never reached the model reads as "no reasoning", which is a
      // different and harmless fact; say so instead of leaving the field blank.
      reasoningLabels.reasoning_mode = reasoningMode
      reasoningLabels.reasoning_empty = 'true'
    }

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
        ...reasoningLabels,
        // Streaming redaction happened before the answer was reviewed: record it so
        // "the ledger says allow" can never be read as "the key was on screen".
        ...(redactedCount > 0 ? { redacted: 'credential', redacted_count: String(redactedCount) } : {}),
        // Why a configured buffer did not hold: `timeout` or `max_chars`. Recorded
        // so "enforce-buffer was supposed to block this" stays answerable.
        ...(degraded === undefined ? {} : { buffer: degraded }),
      },
      metrics: { ...metrics, ...judgeLedgerMetrics(outcome.metrics) },
    })
    runtime.count(outcome.decision === 'deny' ? 'deny' : outcome.decision === 'warn' ? 'warn' : 'allow', sessionId)

    if (!buffering) return
    if (outcome.blocked && canReplace) {
      yield* refusalChunks(usage)
      return
    }
    for (const pending of held) yield pending
  }, { prepend: true })
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
      judgeResult = await judge.review(text, outputJudgeLimits(runtime))
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

/** Whether this request is a rule-drafting call (marker set by {@link draftCallOf}). */
export function isDraftRequest(options: unknown): boolean {
  if (options === null || typeof options !== 'object') return false
  return (options as Record<symbol, unknown>)[DRAFT_REQUEST_MARK] === true
}

/**
 * Build the rule drafter over this host's `ctx.llm` route (M5 T5.2).
 *
 * The drafter is a *producer of text*, never a producer of state: it validates the
 * model's JSON with the loader's own gate and returns a paste-ready snippet. The
 * composition root hands the same handle to the tool and to `/safeharness draft`,
 * so the command and the model see exactly one implementation.
 *
 * @param ctx - plugin context; `ctx.get('llm')` is read on every call.
 * @param runtime - shared config (the drafting route can change on settings reload).
 * @returns a drafter whose `available` is false when the profile composes no llm.
 */
export function createDrafterFor(ctx: Context, runtime: Runtime): RuleDrafter {
  return createRuleDrafter(draftCallOf(ctx, runtime), {
    // Collisions are refused rather than shadowed: an operator pasting a draft must
    // not silently lose a rule they already rely on.
    existingNames: () => runtime.engine.ruleset.rules.map((rule) => rule.id),
  })
}

/**
 * Build the drafting model call from `ctx.llm` (same rationale as the judge: use the
 * host's LLM service, never our own HTTP client).
 *
 * The route is `draft.provider`/`draft.model` when set and the judge route otherwise:
 * most deployments already have exactly one auxiliary route configured, and forcing
 * operators to repeat it would only create a second thing to get wrong.
 */
function draftCallOf(
  ctx: Context,
  runtime: Runtime,
): ((prompt: string, options: { signal: AbortSignal; maxTokens: number }) => AsyncIterable<{ type: string; text?: string }>) | undefined {
  const service = ctx.get('llm') as { stream?: (options: unknown) => AsyncIterable<StreamChunk> } | undefined
  const dispatch = service?.stream?.bind(service)
  if (dispatch === undefined) return undefined
  return (prompt, options) => {
    const draft = runtime.config.draft
    const judge = runtime.config.output.judge
    const provider = draft.provider.trim() === '' ? judge.provider : draft.provider
    const model = draft.model.trim() === '' ? judge.model : draft.model
    const request = {
      provider,
      model,
      system: prompt,
      messages: [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        // Same cast as the judge (the published type surface omits `plugin`); the
        // running host accepts it and the provenance is worth keeping.
        source: { kind: 'plugin', plugin: '@upear/dsh-safeharness' } as never,
      })],
      maxTokens: options.maxTokens,
      signal: options.signal,
      [DRAFT_REQUEST_MARK]: true,
    }
    return dispatch(request) as AsyncIterable<StreamChunk>
  }
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
/**
 * Adapter over `ctx.llm` for auxiliary calls (judge / drafting).
 *
 * Exported for the input judge (1.11.0): both surfaces must travel the exact
 * route an operator configured, otherwise a probe or a switch would prove
 * nothing about the deployment.
 *
 * @param ctx - plugin context.
 * @param runtime - shared config (route can change on settings reload).
 * @returns the call, or undefined when the profile composes no llm service.
 */
export function judgeCallOf(ctx: Context, runtime: Runtime): ((prompt: string, options: JudgeCallOptionsForModel) => AsyncIterable<{ type: string; text?: string }>) | undefined {
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
      // 1.21.0. Sent only when configured: the host refuses an effort id the route
      // does not advertise (UNSUPPORTED_REASONING_EFFORT) before any provider I/O, and
      // a profile written before this field existed must keep the provider default.
      ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort as never }),
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
