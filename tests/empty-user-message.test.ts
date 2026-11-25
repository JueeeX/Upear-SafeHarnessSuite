/**
 * The empty-user-message signal (1.21.0).
 *
 * On 2026-11-25 the host's "retry this turn" appended a user message with
 * `content: []` and `source.kind: 'retry'` to the persisted history. Strict endpoints
 * then rejected every later request with `400 empty_message_content
 * param=messages[N]` — including turns whose own input was perfectly normal — and the
 * session could not be recovered (`docs/incident-2026-11-25.md`).
 *
 * The plugin could not see it: `userInputText` only reads `source.kind === 'user'`, so
 * the empty message was skipped by design and left no ledger trace at all. Counting it
 * turns that into one queryable line.
 *
 * The signal is deliberately **read-only**. These tests pin both halves of that: the
 * count is recorded, and the messages handed downstream are untouched.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { emptyUserMessages } from '../src/hooks/context.js'
import { installInputHook } from '../src/hooks/input.js'
import { createFakeHost, flushLedger, readLedger } from './helpers/fake-host.js'
import type { Runtime } from '../src/runtime.js'

/** A user message with real text. */
function userMessage(text: string): Record<string, unknown> {
  return { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** A user message with no content at all — the retry artefact. */
function emptyMessage(sourceKind: string): Record<string, unknown> {
  return { id: `m-${sourceKind}`, role: 'user', content: [], source: { kind: sourceKind } }
}

/** Ledger rows written so far. */
async function records(runtime: Runtime): Promise<Record<string, unknown>[]> {
  await flushLedger(runtime)
  return readLedger(runtime)
}

describe('emptyUserMessages', () => {
  it('counts the retry artefact separately from any other empty user message', () => {
    expect(emptyUserMessages([
      userMessage('hello'),
      emptyMessage('retry'),
      emptyMessage('retry'),
      emptyMessage('user'),
      { id: 'a1', role: 'assistant', content: [], source: { kind: 'model' } },
    ] as never)).toEqual({ retry: 2, other: 1 })
  })

  it('ignores whitespace-only text and non-user roles', () => {
    expect(emptyUserMessages([
      { id: 'w', role: 'user', content: [{ type: 'text', text: '  \n\t ' }], source: { kind: 'user' } },
      { id: 't', role: 'user', content: [{ type: 'text', text: 'tool output' }], source: { kind: 'tool' } },
    ] as never)).toEqual({ retry: 0, other: 1 })
  })

  it('reports zeros for a healthy conversation', () => {
    expect(emptyUserMessages([userMessage('hello')] as never)).toEqual({ retry: 0, other: 0 })
  })
})

describe('agent/pre-step empty-message signal', () => {
  it('records the retry artefact when there is nothing else to scan', async () => {
    // This is the exact live shape: the turn's only user message is the empty retry one,
    // so `userInputText` returned '' and the hook left no trace whatsoever.
    const { host, runtime } = createFakeHost({ config: { preset: 'balanced' } })
    installInputHook(host.ctx as never, runtime)
    const messages = [emptyMessage('retry')]
    expect(await host.emit('agent/pre-step', {
      agent: { id: 'a', session: { id: 's1' } },
      messages,
    }, () => ({ kind: 'enter', messages }))).toEqual({ kind: 'enter', messages })

    const probe = (await records(runtime)).find((record) => record.reason_code === 'empty_user_message')
    expect(probe?.kind).toBe('invariant_probe')
    expect(probe?.decision).toBe('warn')
    expect((probe?.metrics as Record<string, unknown>).empty_user_messages).toBe(1)
    expect((probe?.labels as Record<string, string>).empty_user_retry).toBe('1')
  })

  it('labels a normal turn that also carries a stale empty message', async () => {
    // The poisoned-session shape: real input plus the persisted artefact. Before 1.21.0
    // this produced an ordinary `input_checked allow`, which is why the 400s looked
    // unexplainable from the ledger.
    const { host, runtime } = createFakeHost({ config: { preset: 'balanced' } })
    installInputHook(host.ctx as never, runtime)
    const messages = [emptyMessage('retry'), userMessage('please summarise the readme')]
    expect(await host.emit('agent/pre-step', {
      agent: { id: 'a', session: { id: 's1' } },
      messages,
    }, () => ({ kind: 'enter', messages }))).toEqual({ kind: 'enter', messages })

    const checked = (await records(runtime)).find((record) => record.kind === 'input_checked')
    expect((checked?.labels as Record<string, string>).empty_user_message).toBe('1')
    expect((checked?.labels as Record<string, string>).empty_user_retry).toBe('1')
  })

  it('writes no signal for a healthy conversation', async () => {
    const { host, runtime } = createFakeHost({ config: { preset: 'balanced' } })
    installInputHook(host.ctx as never, runtime)
    await host.emit('agent/pre-step', {
      agent: { id: 'a', session: { id: 's1' } },
      messages: [userMessage('hello')],
    }, () => ({ kind: 'enter', messages: [userMessage('hello')] }))

    const all = await records(runtime)
    expect(all.filter((record) => record.reason_code === 'empty_user_message')).toEqual([])
    const checked = all.find((record) => record.kind === 'input_checked')
    expect((checked?.labels as Record<string, string> | undefined)?.empty_user_message).toBeUndefined()
  })

  it('never rewrites the messages it counts', async () => {
    // A security plugin that silently edited the host's history would be a bigger risk
    // than this bug; the signal has to stay an observation.
    const { host, runtime } = createFakeHost({ config: { preset: 'balanced' } })
    installInputHook(host.ctx as never, runtime)
    const messages = [emptyMessage('retry'), userMessage('hello')]
    const downstream = { kind: 'enter', messages }
    const decision = await host.emit('agent/pre-step', {
      agent: { id: 'a', session: { id: 's1' } },
      messages,
    }, () => downstream)
    // Same object, same array identity: nothing was rebuilt.
    expect(decision).toBe(downstream)
    expect(downstream.messages).toBe(messages)
    expect(messages).toHaveLength(2)
  })
})
