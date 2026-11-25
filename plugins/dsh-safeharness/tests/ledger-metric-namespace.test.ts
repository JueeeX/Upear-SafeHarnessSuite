/**
 * Ledger metric namespacing (1.20.0).
 *
 * The judge and the stream hook measure the same things — `chars`, `duration_ms`,
 * `truncated` — from opposite sides of two different calls. Until 1.20.0 they were
 * merged into one flat namespace with the judge's values last, so the judge's numbers
 * silently overwrote the answer's. Measured 2026-11-25 on the live ledger:
 * `duration_ms < review_ms` on 64 of 154 judged rows (impossible unless overwritten),
 * and `chars` pinned at `4096 - 230 - 5 = 3861` on the one row that hit the old
 * whole-prompt ceiling.
 *
 * These tests pin the fix from both ends: the judge's numbers must still be recorded
 * (they are the only record of what the judge cost and saw), and the answer's numbers
 * must survive the merge.
 * @module
 */
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { createFakeHost, readLedger, type FakeHost } from './helpers/fake-host.js'
import { installLlmHook } from '../src/hooks/llm.js'
import { JUDGE_METRIC_PREFIX, judgeLedgerMetrics } from '../src/judge/client.js'
import type { Runtime } from '../src/runtime.js'
import type { SafeHarnessConfig } from '../src/config.js'

/** Assistant text that trips no structural rule, so only the judge can flag it. */
const CLEAN_TEXT = 'The build finished; three files changed.'

/** Collect an async iterable into an array. */
async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

/** A one-answer chunk list that ends normally. */
function answer(text: string): StreamChunk[] {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A host whose judge call is answered by `respond` (and re-enters the waterfall). */
function setupWithLlm(config: SafeHarnessConfig, respond: () => StreamChunk[]): { host: FakeHost; runtime: Runtime } {
  let hostRef: FakeHost | undefined
  const services = {
    llm: {
      stream(request: unknown): AsyncIterable<StreamChunk> {
        void request
        const inner = hostRef
        if (inner === undefined) throw new Error('fake host not ready')
        return inner.emitStream('llm/stream', request, async function* () {
          for (const chunk of respond()) yield chunk
        }) as AsyncIterable<StreamChunk>
      },
    },
  }
  const { host, runtime } = createFakeHost({ config, services })
  hostRef = host
  installLlmHook(host.ctx as never, runtime)
  return { host, runtime }
}

/** Stream one answer through the installed listener. */
async function streamAnswer(host: FakeHost, text: string): Promise<StreamChunk[]> {
  const source = async function* (): AsyncIterable<StreamChunk> {
    for (const chunk of answer(text)) yield chunk
  }
  return collect(host.emitStream('llm/stream', { provider: 'p', model: 'm', messages: [] }, source) as AsyncIterable<StreamChunk>)
}

/** The single `output_reviewed` record, or undefined. */
async function reviewedOf(runtime: Runtime): Promise<Record<string, unknown> | undefined> {
  const ledger = await readLedger(runtime)
  return ledger.filter((record) => record.kind === 'output_reviewed').at(-1)
}

/** Judge-enabled config that keeps the answer (so the review is an observation). */
const JUDGED: SafeHarnessConfig = {
  preset: 'balanced',
  output: {
    mode: 'warn',
    judge: { enabled: true, scope: 'always', provider: 'fake', model: 'judge-model', timeoutMs: 1500 },
  },
}

describe('judgeLedgerMetrics', () => {
  it('prefixes every key and keeps the values', () => {
    const renamed = judgeLedgerMetrics({ chars: 12, duration_ms: 34, prompt_chars: 0, attempts: 1 })
    expect(renamed).toEqual({
      [`${JUDGE_METRIC_PREFIX}chars`]: 12,
      [`${JUDGE_METRIC_PREFIX}duration_ms`]: 34,
      [`${JUDGE_METRIC_PREFIX}prompt_chars`]: 0,
      [`${JUDGE_METRIC_PREFIX}attempts`]: 1,
    })
  })

  it('drops undefined values instead of writing holes', () => {
    // `JSON.stringify` would elide them anyway; dropping keeps a ledger row honest about
    // which measurements the judge actually produced.
    expect(judgeLedgerMetrics({ chars: 1, duration_ms: undefined })).toEqual({ judge_chars: 1 })
  })

  it('cannot collide with an answer-side key', () => {
    // The live defect was exactly this: a shared name. A prefixed key is only equal to
    // another prefixed key, and the answer side never writes one.
    const answerSide = ['chars', 'duration_ms', 'review_ms', 'truncated', 'usage_input', 'usage_output']
    const judgeSide = Object.keys(judgeLedgerMetrics({ chars: 1, duration_ms: 1, truncated: true, prompt_chars: 1 }))
    for (const key of judgeSide) expect(answerSide).not.toContain(key)
  })
})

describe('output_reviewed: the answer and the judge both survive the merge', () => {
  it('keeps the answer length in chars and puts the judge length in judge_chars', async () => {
    // The judge replies with JSON, so its own `response_chars` is 19-ish — far shorter
    // than the answer. Before 1.20.0 the answer's `chars` was replaced by the judge's
    // content length, which is the number a reviewer would have read as "answer size".
    const { host, runtime } = setupWithLlm(JUDGED, () => answer('{"verdict":"allow"}'))
    await streamAnswer(host, CLEAN_TEXT)
    const reviewed = await reviewedOf(runtime)
    const metrics = reviewed?.metrics as Record<string, unknown>
    expect(metrics.chars).toBe(CLEAN_TEXT.length)
    expect(metrics.judge_chars).toBe(CLEAN_TEXT.length)
    expect(metrics.judge_duration_ms).toEqual(expect.any(Number))
  })

  it('keeps the stream duration in duration_ms and puts the judge duration in judge_duration_ms', async () => {
    // `duration_ms >= review_ms` is an invariant of the un-overwritten code:
    // `reviewStartedAt` is taken after the stream ended. It was violated on 64 live
    // rows because the judge's `duration_ms` replaced the stream's.
    const { host, runtime } = setupWithLlm(JUDGED, () => answer('{"verdict":"allow"}'))
    await streamAnswer(host, CLEAN_TEXT)
    const metrics = (await reviewedOf(runtime))?.metrics as Record<string, unknown>
    expect(metrics.duration_ms).toBeGreaterThanOrEqual(metrics.review_ms as number)
    expect(metrics.judge_duration_ms).toEqual(expect.any(Number))
  })

  it('records the judge prompt size without touching the answer metrics', async () => {
    const { host, runtime } = setupWithLlm(JUDGED, () => answer('{"verdict":"allow"}'))
    await streamAnswer(host, CLEAN_TEXT)
    const metrics = (await reviewedOf(runtime))?.metrics as Record<string, unknown>
    // The judge's own bookkeeping is still there, one prefix away.
    expect(metrics.judge_prompt_chars).toBeGreaterThan(CLEAN_TEXT.length)
    expect(metrics.judge_response_chars).toBeGreaterThan(0)
    expect(metrics.judge_attempts).toBe(1)
  })

  it('writes no prefixed keys when the judge never ran', async () => {
    // `skipped_empty` means no judge call happened: the row must not claim otherwise.
    const { host, runtime } = setupWithLlm(JUDGED, () => answer('{"verdict":"allow"}'))
    await collect(host.emitStream('llm/stream', { provider: 'p', model: 'm', messages: [] }, async function* () {
      yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read', argumentsDelta: '{}' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }) as AsyncIterable<StreamChunk>)
    const metrics = (await reviewedOf(runtime))?.metrics as Record<string, unknown>
    expect(Object.keys(metrics).filter((key) => key.startsWith(JUDGE_METRIC_PREFIX))).toEqual([])
  })

  it('never truncates the answer metrics to the judge cap', async () => {
    // `output.judge.maxChars` caps what the judge *reads*, not what the answer *was*.
    // With the cap below the answer length, the un-prefixed `chars` must still report the
    // full answer: that is the exact confusion the live ledger showed.
    //
    // `truncated` is the one pair that never collided: the judge reports its own
    // truncation as a *label* (`labels.truncated`) while the answer reports its scan
    // truncation as a *metric* (`metrics.truncated`). Keeping both is the point.
    const { host, runtime } = setupWithLlm({
      preset: 'balanced',
      output: {
        mode: 'warn',
        judge: { enabled: true, scope: 'always', provider: 'fake', model: 'judge-model', timeoutMs: 1500, maxChars: 10 },
      },
    }, () => answer('{"verdict":"allow"}'))
    const long = `${CLEAN_TEXT} ${'and more text '.repeat(20)}`
    await streamAnswer(host, long)
    const reviewed = await reviewedOf(runtime)
    const metrics = reviewed?.metrics as Record<string, unknown>
    expect(metrics.chars).toBe(long.length)
    expect(metrics.judge_chars).toBe(10)
    // Answer side: the scan saw a short answer, so nothing was clipped.
    expect(metrics.truncated).toBe(false)
    // Judge side: it read the first 10 characters only.
    expect((reviewed?.labels as Record<string, unknown>).truncated).toBe('true')
  })
})
