/**
 * Judge core: status/verdict matrix, prompt hygiene and the timeout lifecycle.
 * Every case drives the module through a fake `JudgeCall` (async generator or a
 * hand-written async iterator), so nothing here touches the network or DSH.
 */
import { describe, expect, it, vi } from 'vitest'
import { createJudge, JUDGE_REQUEST_MARK } from '../src/judge/client.js'
import type { JudgeCall, JudgeCallOptions, JudgeCallOptionsForModel, JudgeChunkLike, JudgeResult } from '../src/judge/client.js'

/** What a fake call saw; used for assertions about the prompt and the signal. */
interface CallRecord {
  readonly prompt: string
  readonly maxTokens: number
  readonly signal: AbortSignal
  /** 1.21.0: the configured reasoning effort, when one was asked for. */
  readonly reasoningEffort?: string
}

/** Generous limits so most cases exercise the "nothing truncated" path. */
const REVIEW: JudgeCallOptions = { maxChars: 100_000, timeoutMs: 1000 }

/** Record one invocation, including the optional 1.21.0 controls. */
function record(calls: CallRecord[], prompt: string, options: JudgeCallOptionsForModel): void {
  calls.push({
    prompt,
    maxTokens: options.maxTokens,
    signal: options.signal,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  })
}

/** A call that streams exactly the given chunks, recording how it was invoked. */
function chunkCall(chunks: readonly JudgeChunkLike[], calls: CallRecord[] = []): JudgeCall {
  return async function* (prompt, options) {
    record(calls, prompt, options)
    for (const chunk of chunks) yield chunk
  }
}

/** A call that streams one `text-delta` per string. */
function textCall(parts: readonly string[], calls: CallRecord[] = []): JudgeCall {
  return chunkCall(parts.map((text) => ({ type: 'text-delta', text })), calls)
}

/**
 * A call that scripts one response PER INVOCATION (1.19.0).
 *
 * Needed by the empty-reply retry: `textCall` emits every delta inside a single call, so
 * it cannot express "first call says nothing, the second says the JSON".
 */
function seqCall(responses: readonly (readonly string[])[], calls: CallRecord[] = []): JudgeCall {
  let index = 0
  return async function* (prompt, options) {
    record(calls, prompt, options)
    const parts = responses[Math.min(index, responses.length - 1)] ?? []
    index += 1
    for (const part of parts) yield { type: 'text-delta', text: part }
  }
}

/** A call that fails after one delta (iteration-time failure, not invocation). */
function throwingCall(calls: CallRecord[] = []): JudgeCall {
  return async function* (prompt, options) {
    record(calls, prompt, options)
    yield { type: 'text-delta', text: '{"verdict":' }
    throw new Error('provider failed mid-stream')
  }
}

/** A call that never produces a chunk; `return()` records cancellation. */
function hangingCall(calls: CallRecord[], state: { returned: boolean }): JudgeCall {
  return (prompt, options) => {
    record(calls, prompt, options)
    return {
      [Symbol.asyncIterator](): AsyncIterator<JudgeChunkLike> {
        return {
          next: () => new Promise<IteratorResult<JudgeChunkLike>>(() => {}),
          return: async (): Promise<IteratorResult<JudgeChunkLike>> => {
            state.returned = true
            return { done: true, value: undefined }
          },
        }
      },
    }
  }
}

/** Strip the frozen result down to the only thing a caller may serialize. */
function serialized(result: JudgeResult): string {
  return JSON.stringify(result)
}

describe('createJudge availability', () => {
  it('reports unavailable (not an error) when no call is composed', async () => {
    const judge = createJudge(undefined)
    expect(judge.available).toBe(false)
    const result = await judge.review('anything', REVIEW)
    expect(result.status).toBe('unavailable')
    expect(result.verdict).toBe('unknown')
    expect(result.blocked).toBe(false)
    expect(result.labels['reason']).toBe('no_judge_call')
    expect(typeof result.metrics['duration_ms']).toBe('number')
  })

  it('is available when a call is supplied', () => {
    expect(createJudge(textCall(['{"verdict":"allow"}'])).available).toBe(true)
  })
})

describe('createJudge verdicts', () => {
  it('parses a plain allow reply', async () => {
    const calls: CallRecord[] = []
    const judge = createJudge(textCall(['{"verdict":"allow"}'], calls))
    const result = await judge.review('hello', REVIEW)
    expect(result.status).toBe('ok')
    expect(result.verdict).toBe('allow')
    expect(result.blocked).toBe(false)
    expect(result.metrics['chars']).toBe(5)
    expect(result.metrics['response_chars']).toBe(19)
    expect(result.labels['truncated']).toBeUndefined()
    expect(calls).toHaveLength(1)
    // prompt_chars is the whole request, chars is the content that reached the model.
    expect(result.metrics['prompt_chars']).toBe(judge.systemPrompt.length + '\n---\n'.length + 5)
    expect(result.metrics['prompt_chars']).toBe(calls[0]?.prompt.length)
  })

  it('turns a block verdict into blocked=true', async () => {
    const result = await createJudge(textCall(['{"verdict":"block","reason":"leaks a key"}'])).review('x', REVIEW)
    expect(result.status).toBe('ok')
    expect(result.verdict).toBe('block')
    expect(result.blocked).toBe(true)
  })

  it('normalizes case in both keys and values', async () => {
    const result = await createJudge(textCall(['{"VERDICT":"BLOCK"}'])).review('x', REVIEW)
    expect(result.verdict).toBe('block')
    expect(result.blocked).toBe(true)
  })

  it('ignores ```json fences around the object', async () => {
    const result = await createJudge(textCall(['```json\n{"verdict":"allow"}\n```'])).review('x', REVIEW)
    expect(result.status).toBe('ok')
    expect(result.verdict).toBe('allow')
  })

  it('ignores extra fields', async () => {
    const reply = '{"verdict":"allow","confidence":0.92,"labels":{"toxicity":"none"}}'
    const result = await createJudge(textCall([reply])).review('x', REVIEW)
    expect(result.verdict).toBe('allow')
  })

  it('accepts {block:boolean} as the verdict form', async () => {
    const block = await createJudge(textCall(['{"block":true}'])).review('x', REVIEW)
    expect(block.verdict).toBe('block')
    expect(block.blocked).toBe(true)
    const allow = await createJudge(textCall(['{"block":false}'])).review('x', REVIEW)
    expect(allow.verdict).toBe('allow')
  })

  it('accepts {allowed:boolean} as the verdict form', async () => {
    const deny = await createJudge(textCall(['{"allowed":false}'])).review('x', REVIEW)
    expect(deny.verdict).toBe('block')
    const allow = await createJudge(textCall(['{"allowed":true}'])).review('x', REVIEW)
    expect(allow.verdict).toBe('allow')
  })

  it('concatenates multiple text deltas split across a fence', async () => {
    const result = await createJudge(
      textCall(['```json\n{"verdict":', '"block","reason":"x"}\n```']),
    ).review('x', REVIEW)
    expect(result.verdict).toBe('block')
  })

  it('ignores chunks that are not text-delta', async () => {
    const chunks: JudgeChunkLike[] = [
      { type: 'usage' },
      { type: 'text-delta', text: '{"verdict":"block"}' },
      { type: 'finish' },
    ]
    const result = await createJudge(chunkCall(chunks)).review('x', REVIEW)
    expect(result.verdict).toBe('block')
    expect(result.metrics['chars']).toBe(1)
  })
})

describe('createJudge malformed or missing replies', () => {
  it('reports bad_json for unparsable output', async () => {
    const result = await createJudge(textCall(['sorry, I cannot help with that'])).review('x', REVIEW)
    expect(result.status).toBe('bad_json')
    expect(result.verdict).toBe('unknown')
    expect(result.blocked).toBe(false)
    expect(result.labels['reason']).toBe('unparsable_model_reply')
  })

  it('reports bad_json when the JSON has no usable verdict field', async () => {
    expect((await createJudge(textCall(['{"reason":"nope"}'])).review('x', REVIEW)).status).toBe('bad_json')
    expect((await createJudge(textCall(['{"verdict":"maybe"}'])).review('x', REVIEW)).status).toBe('bad_json')
    expect((await createJudge(textCall(['[1,2,3]'])).review('x', REVIEW)).status).toBe('bad_json')
  })

  it('returns empty for an empty input without calling the model', async () => {
    const calls: CallRecord[] = []
    const result = await createJudge(textCall(['{"verdict":"allow"}'], calls)).review('', REVIEW)
    expect(result.status).toBe('empty')
    expect(result.labels['reason']).toBe('empty_text')
    expect(result.metrics['chars']).toBe(0)
    expect(result.metrics['prompt_chars']).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('returns empty for whitespace-only input without calling the model', async () => {
    const calls: CallRecord[] = []
    const result = await createJudge(textCall(['{"verdict":"allow"}'], calls)).review(' \n\t ', REVIEW)
    expect(result.status).toBe('empty')
    expect(calls).toHaveLength(0)
  })

  it('returns empty when the model emits no text-delta', async () => {
    const result = await createJudge(chunkCall([{ type: 'usage' }, { type: 'finish' }])).review('x', REVIEW)
    expect(result.status).toBe('empty')
    expect(result.labels['reason']).toBe('empty_model_reply')
  })
})

describe('empty-reply retry (1.19.0)', () => {
  it('retries once with a larger budget when the reply has no text', async () => {
    const calls: CallRecord[] = []
    const result = await createJudge(seqCall([[], ['{"verdict":"block","reason":"x"}']], calls))
      .review('hello', REVIEW)
    expect(result.status).toBe('ok')
    expect(result.verdict).toBe('block')
    expect(calls).toHaveLength(2)
    // The retry gets a bigger budget: the first attempt is what ran out.
    expect(calls[0]?.maxTokens).toBe(4096)
    expect(calls[1]?.maxTokens).toBe(8192)
    // The recursion marker must survive into the retry prompt verbatim.
    expect(calls[1]?.prompt.startsWith('[safeharness-judge]')).toBe(true)
    expect(result.labels['attempts']).toBe('2')
    expect(result.metrics['attempts']).toBe(2)
  })

  it('reports empty when both attempts produce no text', async () => {
    const calls: CallRecord[] = []
    const result = await createJudge(seqCall([[], []], calls)).review('hello', REVIEW)
    expect(result.status).toBe('empty')
    expect(calls).toHaveLength(2)
  })

  it('does not retry a reply that arrived but did not parse', async () => {
    const calls: CallRecord[] = []
    const result = await createJudge(textCall(['not json at all'], calls)).review('hello', REVIEW)
    expect(result.status).toBe('bad_json')
    expect(calls).toHaveLength(1)
  })

  it('does not retry a timeout', async () => {
    const calls: CallRecord[] = []
    const hang: JudgeCall = async function* (_prompt, options) {
      calls.push({ prompt: _prompt, maxTokens: options.maxTokens, signal: options.signal })
      await new Promise((resolve) => setTimeout(resolve, 200))
      yield { type: 'text-delta', text: '{"verdict":"allow"}' }
    }
    const result = await createJudge(hang).review('hello', { maxChars: 1000, timeoutMs: 20 })
    expect(result.status).toBe('timeout')
    expect(calls).toHaveLength(1)
  })

  it('does not start a retry once the deadline has passed', async () => {
    // A first attempt that consumed the whole budget must not be followed by a second
    // call the operator never agreed to wait for.
    const calls: CallRecord[] = []
    const slowEmpty: JudgeCall = async function* (_prompt, options) {
      calls.push({ prompt: _prompt, maxTokens: options.maxTokens, signal: options.signal })
      await new Promise((resolve) => setTimeout(resolve, 60))
      // Emits nothing: an honest empty reply, but only after the deadline.
    }
    const result = await createJudge(slowEmpty).review('hello', { maxChars: 1000, timeoutMs: 50 })
    expect(calls).toHaveLength(1)
    expect(['empty', 'timeout']).toContain(result.status)
  })
})

describe('createJudge prompt construction', () => {
  it('clips content to maxChars independently of the instruction', async () => {
    const calls: CallRecord[] = []
    const judge = createJudge(textCall(['{"verdict":"allow"}'], calls))
    const result = await judge.review('A'.repeat(1000), {
      maxChars: 50,
      timeoutMs: 1000,
    })
    expect(result.status).toBe('ok')
    expect(result.labels['truncated']).toBe('true')
    expect(result.metrics['chars']).toBe(50)
    const prompt = calls[0]?.prompt ?? ''
    // instruction + separator marker + exactly the maxChars content
    expect(prompt.length).toBe(judge.systemPrompt.length + '\n---\n'.length + 50)
    expect(result.metrics['prompt_chars']).toBe(prompt.length)
    expect(prompt.endsWith('A'.repeat(50))).toBe(true)
    expect(prompt.includes('A'.repeat(51))).toBe(false)
  })

  it('caps the whole prompt at 16384 chars even when maxChars is huge', async () => {
    const calls: CallRecord[] = []
    const judge = createJudge(textCall(['{"verdict":"allow"}'], calls))
    const result = await judge.review('B'.repeat(20_000), { maxChars: 1_000_000, timeoutMs: 1000 })
    const prompt = calls[0]?.prompt ?? ''
    expect(prompt.length).toBeLessThanOrEqual(16_384)
    expect(prompt.length).toBe(16_384)
    expect(result.labels['truncated']).toBe('true')
    expect(result.metrics['chars']).toBe(16_384 - judge.systemPrompt.length - '\n---\n'.length)
    expect(result.metrics['prompt_chars']).toBe(16_384)
  })

  it('does not clip the default judge.maxChars (12000)', async () => {
    const calls: CallRecord[] = []
    const judge = createJudge(textCall(['{"verdict":"allow"}'], calls))
    const result = await judge.review('B'.repeat(12_000), { maxChars: 12_000, timeoutMs: 1000 })
    expect(result.labels['truncated']).toBeUndefined()
    expect(result.metrics['chars']).toBe(12_000)
  })

  it('carries the stable recursion marker in the instruction and prompt', async () => {
    const calls: CallRecord[] = []
    const judge = createJudge(textCall(['{"verdict":"allow"}'], calls))
    expect(judge.systemPrompt.length).toBeLessThanOrEqual(400)
    expect(judge.systemPrompt).toContain('[safeharness-judge]')
    await judge.review('hello', REVIEW)
    const prompt = calls[0]?.prompt ?? ''
    expect(prompt.startsWith(judge.systemPrompt)).toBe(true)
    expect(prompt).toContain('[safeharness-judge]')
    expect(prompt).toContain('\n---\nhello')
    expect(typeof JUDGE_REQUEST_MARK).toBe('symbol')
  })

  it('forwards a signal and the default maxTokens budget', async () => {
    const calls: CallRecord[] = []
    const result = await createJudge(textCall(['{"verdict":"allow"}'], calls)).review('hello', REVIEW)
    expect(result.status).toBe('ok')
    // 4096 since 1.19.0: measured on the deployed thinking model, 2048 went entirely
    // to reasoning tokens and produced zero characters of text (10 such reviews).
    expect(calls[0]?.maxTokens).toBe(4096)
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(calls[0]?.signal.aborted).toBe(false)
  })
})

describe('createJudge failure containment', () => {
  it('folds a synchronously throwing call into error', async () => {
    const call: JudgeCall = () => {
      throw new Error('no provider composed')
    }
    const result = await createJudge(call).review('hello', REVIEW)
    expect(result.status).toBe('error')
    expect(result.verdict).toBe('unknown')
    expect(result.blocked).toBe(false)
    expect(result.labels['reason']).toBe('call_failed')
  })

  it('folds an iteration-time failure into error', async () => {
    const result = await createJudge(throwingCall()).review('hello', REVIEW)
    expect(result.status).toBe('error')
    expect(result.verdict).toBe('unknown')
  })

  it('returns timeout, aborts the signal and closes the iterator', async () => {
    const calls: CallRecord[] = []
    const state = { returned: false }
    const startedAt = Date.now()
    const result = await createJudge(hangingCall(calls, state)).review('hello', {
      maxChars: 100,
      timeoutMs: 25,
    })
    const elapsed = Date.now() - startedAt
    expect(result.status).toBe('timeout')
    expect(result.verdict).toBe('unknown')
    expect(result.blocked).toBe(false)
    expect(result.metrics['timeout_ms']).toBe(25)
    expect(elapsed).toBeGreaterThanOrEqual(10)
    expect(elapsed).toBeLessThan(2000)
    expect(calls[0]?.signal.aborted).toBe(true)
    expect(state.returned).toBe(true)
  })

  it('clears its timeout timer on success', async () => {
    vi.useFakeTimers()
    try {
      const result = await createJudge(textCall(['{"verdict":"allow"}'])).review('hello', {
        maxChars: 100,
        timeoutMs: 5000,
      })
      expect(result.status).toBe('ok')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createJudge result hygiene', () => {
  it('keeps metrics and labels JSON-serializable and frozen', async () => {
    const result = await createJudge(textCall(['{"verdict":"allow"}'])).review('hello', REVIEW)
    expect(Object.isFrozen(result.labels)).toBe(true)
    expect(Object.isFrozen(result.metrics)).toBe(true)
    for (const value of Object.values(result.metrics)) {
      expect(value === undefined || typeof value === 'number').toBe(true)
    }
    for (const value of Object.values(result.labels)) {
      expect(value === undefined || typeof value === 'string').toBe(true)
    }
    expect(() => serialized(result)).not.toThrow()
  })

  it('never returns the reviewed text — only the prompt may carry it', async () => {
    const calls: CallRecord[] = []
    const secret = `sk-live-${'A'.repeat(30)}`
    const result = await createJudge(textCall(['{"verdict":"block","reason":"secret"}'], calls)).review(secret, REVIEW)
    expect(result.status).toBe('ok')
    expect(calls[0]?.prompt).toContain(secret)
    expect(serialized(result)).not.toContain(secret)
    expect(serialized(result)).not.toContain('sk-live')
    for (const value of Object.values(result.labels)) {
      expect(value ?? '').not.toContain(secret)
    }
  })

  it('derives duration_ms from the injected clock', async () => {
    const ticks = [1000, 1015]
    const judge = createJudge(textCall(['{"verdict":"allow"}']), { now: () => ticks.shift() ?? 1015 })
    const result = await judge.review('hello', REVIEW)
    expect(result.metrics['duration_ms']).toBe(15)
  })
})

describe('judge usage accounting (1.21.0)', () => {
  /** A usage chunk as the host emits it before the terminal finish. */
  function usageChunk(usage: Record<string, number>): JudgeChunkLike {
    return { type: 'usage', usage }
  }

  it('reports the judged call\'s own token usage', async () => {
    // Before 1.21.0 `JudgeChunkLike` dropped the usage block, so `output_reviewed`
    // carried only the MAIN model's bill and the judge's cost was unmeasurable.
    const result = await createJudge(chunkCall([
      { type: 'text-delta', text: '{"verdict":"allow"}' },
      usageChunk({ inputTokens: 800, outputTokens: 120 }),
      { type: 'finish' },
    ])).review('hello', REVIEW)
    expect(result.metrics['usage_input']).toBe(800)
    expect(result.metrics['usage_output']).toBe(120)
  })

  it('reports no usage keys when the provider sent no usage chunk', async () => {
    const result = await createJudge(textCall(['{"verdict":"allow"}'])).review('hello', REVIEW)
    expect(result.metrics['usage_input']).toBeUndefined()
    expect(result.metrics['usage_output']).toBeUndefined()
  })

  it('sums usage across both attempts of an empty-reply retry', async () => {
    // A retry is a second billed call: reporting only the last attempt would halve the
    // recorded cost of exactly the reviews that cost the most.
    let index = 0
    const call: JudgeCall = async function* () {
      const attempt = index
      index += 1
      if (attempt === 0) {
        yield usageChunk({ inputTokens: 500, outputTokens: 4096 })
        yield { type: 'finish' }
        return
      }
      yield { type: 'text-delta', text: '{"verdict":"allow"}' }
      yield usageChunk({ inputTokens: 400, outputTokens: 20 })
      yield { type: 'finish' }
    }
    const result = await createJudge(call).review('hello', REVIEW)
    expect(result.status).toBe('ok')
    expect(result.metrics['attempts']).toBe(2)
    expect(result.metrics['usage_input']).toBe(900)
    expect(result.metrics['usage_output']).toBe(4116)
  })

  it('carries the optional cache and reasoning counters only when reported', async () => {
    const withExtras = await createJudge(chunkCall([
      { type: 'text-delta', text: '{"verdict":"allow"}' },
      usageChunk({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        reasoningTokens: 4,
      }),
      { type: 'finish' },
    ])).review('hello', REVIEW)
    expect(withExtras.metrics['usage_cache_read']).toBe(7)
    expect(withExtras.metrics['usage_cache_write']).toBe(3)
    expect(withExtras.metrics['usage_reasoning']).toBe(4)

    const withoutExtras = await createJudge(chunkCall([
      { type: 'text-delta', text: '{"verdict":"allow"}' },
      usageChunk({ inputTokens: 10, outputTokens: 5 }),
      { type: 'finish' },
    ])).review('hello', REVIEW)
    expect(withoutExtras.metrics['usage_cache_read']).toBeUndefined()
    expect(withoutExtras.metrics['usage_reasoning']).toBeUndefined()
  })

  it('survives a malformed usage block without poisoning the totals', async () => {
    // `NaN` serializes to `null` in the ledger, which a reader would take as zero; a
    // NaN total would be worse — it makes every downstream percentage meaningless.
    const result = await createJudge(chunkCall([
      { type: 'usage', usage: { inputTokens: Number.NaN, outputTokens: -5 } },
      { type: 'text-delta', text: '{"verdict":"allow"}' },
      { type: 'finish' },
    ])).review('hello', REVIEW)
    expect(result.status).toBe('ok')
    expect(result.metrics['usage_input']).toBe(0)
    expect(result.metrics['usage_output']).toBe(0)
  })
})

describe('judge budget and effort controls (1.21.0)', () => {
  it('uses the configured budget for the first attempt and doubles it for the retry', async () => {
    const calls: CallRecord[] = []
    const result = await createJudge(seqCall([[], ['{"verdict":"allow"}']], calls))
      .review('hello', { ...REVIEW, maxTokens: 3000 })
    expect(result.status).toBe('ok')
    expect(calls[0]?.maxTokens).toBe(3000)
    expect(calls[1]?.maxTokens).toBe(6000)
  })

  it('keeps 4096 when the configured budget is 0 (the unconfigured default)', async () => {
    const calls: CallRecord[] = []
    await createJudge(textCall(['{"verdict":"allow"}'], calls)).review('hello', { ...REVIEW, maxTokens: 0 })
    expect(calls[0]?.maxTokens).toBe(4096)
  })

  it('forwards the configured reasoning effort to every attempt', async () => {
    const calls: CallRecord[] = []
    const result = await createJudge(seqCall([[], ['{"verdict":"allow"}']], calls))
      .review('hello', { ...REVIEW, reasoningEffort: 'low' })
    expect(result.status).toBe('ok')
    expect(calls[0]?.reasoningEffort).toBe('low')
    expect(calls[1]?.reasoningEffort).toBe('low')
    expect(result.labels['effort']).toBe('low')
  })

  it('omits the effort entirely when none is configured', async () => {
    const calls: CallRecord[] = []
    const result = await createJudge(textCall(['{"verdict":"allow"}'], calls)).review('hello', REVIEW)
    expect(calls[0]?.reasoningEffort).toBeUndefined()
    expect(result.labels['effort']).toBeUndefined()
  })

  it('reports a refused request as error/call_refused instead of an empty reply', async () => {
    // The host turns an unsupported `reasoningEffort` into a terminal `finish` chunk with
    // an error reason, NOT a throw — so without reading the finish reason this would look
    // like "the model said nothing" and be retried with a bigger budget.
    const calls: CallRecord[] = []
    const call: JudgeCall = async function* (prompt, options) {
      record(calls, prompt, options)
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } },
      }
    }
    const result = await createJudge(call).review('hello', { ...REVIEW, reasoningEffort: 'ultra' })
    expect(result.status).toBe('error')
    expect(result.labels['reason']).toBe('call_refused')
    expect(result.labels['failure']).toBe('UNSUPPORTED_REASONING_EFFORT')
    // Not retried: the same request would be refused again.
    expect(calls).toHaveLength(1)
  })

  it('still parses an answer that arrives before a benign finish', async () => {
    const call: JudgeCall = async function* () {
      yield { type: 'text-delta', text: '{"verdict":"allow"}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const result = await createJudge(call).review('hello', REVIEW)
    expect(result.status).toBe('ok')
    expect(result.verdict).toBe('allow')
  })
})
