/**
 * Credential leakage (1.15.1 regression suite).
 *
 * Real incident, 2026-11-19, session-2242f394: the user asked for the relay key in
 * their config, a tool result delivered it, and the model echoed it in its answer.
 * Two independent gaps let that happen:
 *
 *  1. the result-face assignment pattern missed JSON-quoted names (`"LLM_API_KEY": "…"`)
 *     and names that are the suffix of a longer identifier, so the key reached the model;
 *  2. the output face only ran the injection rule set, so the answer that echoed the
 *     key was recorded as `rule_ids: []` and `warn` never touched it.
 *
 * These tests pin detection on all three faces (result, output, stream) with the
 * key assembled at runtime, so the fixture itself is not a credential-shaped literal.
 * @module
 */
import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

import { createFakeHost, flushLedger, readLedger } from './helpers/fake-host.js'
import { installLlmHook } from '../src/hooks/llm.js'
import { scanCredentialLeaks } from '../src/engine/tool.js'
import { OUTPUT_BLOCK_TEXT } from '../src/runtime.js'
import type { Runtime } from '../src/runtime.js'

/** A 14-char, mixed-case relay key — assembled so this file carries no literal key. */
const FAKE_KEY = ['yXcX', 'Abc123', 'XpJ'].join('')
/** An `sk-` style token, also assembled. */
const FAKE_SK = `sk-${'abcdEFGH1234'.repeat(2)}`

/** One JSON config line, the shape that leaked. */
const JSON_LINE = `{"LLM_API_KEY": "${FAKE_KEY}"}`

/** Drain the ledger and read it back. */
async function records(runtime: Runtime): Promise<Record<string, unknown>[]> {
  await flushLedger(runtime)
  return readLedger(runtime)
}

/** Drain one stream. */
async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** The text a consumer would render from a chunk sequence. */
function textOf(chunks: readonly StreamChunk[]): string {
  const deltas = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => (chunk as { text: string }).text)
    .join('')
  // `block-end` repeats the text the deltas carried; it is the fallback only.
  const closed = chunks
    .filter((chunk) => chunk.type === 'block-end')
    .map((chunk) => ((chunk as { block: { text?: string } }).block.text ?? ''))
    .join('')
  return deltas.length > 0 ? deltas : closed
}

describe('credential detection patterns', () => {
  it('catches a JSON-quoted key whose name is a suffix of a longer identifier', () => {
    const scan = scanCredentialLeaks(JSON_LINE)
    expect(scan.ruleIds).toContain('credential_assignment')
    expect(scan.severity).toBe('high')
  })

  it('catches unquoted assignments and nested JSON', () => {
    expect(scanCredentialLeaks(`LLM_API_KEY=${FAKE_KEY}`).ruleIds).toContain('credential_assignment')
    expect(scanCredentialLeaks(`{"env":{"RELAY_API_KEY":"${FAKE_KEY}"}}`).ruleIds).toContain('credential_assignment')
    expect(scanCredentialLeaks(`your key: ${FAKE_SK}`).ruleIds).toContain('credential_openai_key')
  })

  it('does not fire on type expressions, env references or empty values', () => {
    for (const text of [
      '"apiKey": "z.string()"',
      'token: process.env.TOKEN',
      '"api_key": ""',
      'maxTokens: 2048',
      'const passwordHint = "please choose one"',
    ]) {
      expect(scanCredentialLeaks(text).ruleIds, text).toHaveLength(0)
    }
  })
})

describe('all three faces see the leak', () => {
  it('the result face reports credential_leak for the JSON line', () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const findings = runtime.engine.evaluateToolResult({ text: JSON_LINE, valueText: '' } as never)
    const credential = findings.find((finding) => finding.category === 'credential_leak')
    expect(credential).toBeDefined()
    expect(credential?.ruleIds).toContain('credential_assignment')
    // A finding never carries the value.
    expect(JSON.stringify(findings)).not.toContain(FAKE_KEY)
  })

  it('the output face denies an answer that echoes the key', () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const decision = runtime.engine.evaluateOutput(`your relay key is ${JSON_LINE}`)
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe('credential_leak')
    expect(decision.ruleIds).toContain('credential_assignment')
  })
})

describe('stream redaction (warn mode keeps streaming, still hides the key)', () => {
  it('replaces the value across delta boundaries and rewrites block-end', async () => {
    const { host, runtime } = createFakeHost({ config: { preset: 'balanced' } })
    installLlmHook(host.ctx as never, runtime)
    // The key is split across two deltas, exactly how a provider emits it.
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'found: {"LLM_API_KEY": "' },
      { type: 'text-delta', index: 0, text: `${FAKE_KEY}"}` },
      { type: 'block-end', index: 0, block: { type: 'text', text: `found: {"LLM_API_KEY": "${FAKE_KEY}"}` } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const output = await collect(
      host.emitStream('llm/stream', { provider: 'p', model: 'm', messages: [] }, async function* () {
        for (const chunk of chunks) yield chunk
      }) as AsyncIterable<StreamChunk>,
    )
    const rendered = textOf(output)
    expect(rendered).not.toContain(FAKE_KEY)
    expect(rendered).toContain('[REDACTED:credential]')
    // The key name survives: the answer stays readable.
    expect(rendered).toContain('LLM_API_KEY')

    const reviewed = (await records(runtime)).find((record) => record.kind === 'output_reviewed')
    expect(reviewed?.decision).toBe('warn')
    expect(reviewed?.reason_code).toBe('credential_leak')
    expect(reviewed?.rule_ids).toContain('credential_assignment')
    expect((reviewed?.labels as Record<string, unknown>).redacted).toBe('credential')
    expect((reviewed?.metrics as Record<string, unknown>).redacted_count).toBe(1)
    // Not even the hash of the key value is stored — only hashes of the answer.
    expect(JSON.stringify(reviewed)).not.toContain(FAKE_KEY)
  })

  it('leaves ordinary text byte-identical', async () => {
    const { host, runtime } = createFakeHost({ config: { preset: 'balanced' } })
    installLlmHook(host.ctx as never, runtime)
    const answer = 'deploy finished: 3 tests passed, nothing sensitive here'
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: answer },
      { type: 'block-end', index: 0, block: { type: 'text', text: answer } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const output = await collect(
      host.emitStream('llm/stream', { provider: 'p', model: 'm', messages: [] }, async function* () {
        for (const chunk of chunks) yield chunk
      }) as AsyncIterable<StreamChunk>,
    )
    expect(textOf(output)).toBe(answer)
    const deltas = output
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => (chunk as { text: string }).text)
      .join('')
    expect(deltas).toBe(answer)
    const closed = output.find((chunk) => chunk.type === 'block-end') as { block: { text?: string } } | undefined
    expect(closed?.block.text).toBe(answer)
    const reviewed = (await records(runtime)).find((record) => record.kind === 'output_reviewed')
    expect(reviewed?.decision).toBe('allow')
    expect((reviewed?.labels as Record<string, unknown>).redacted).toBeUndefined()
  })
})

describe('enforce-buffer still blocks the whole answer', () => {
  it('replaces a leaked answer with the fixed denial text', async () => {
    const { host, runtime } = createFakeHost({
      config: { preset: 'balanced', output: { mode: 'enforce-buffer' } },
    })
    installLlmHook(host.ctx as never, runtime)
    const chunks: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: JSON_LINE },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const output = await collect(
      host.emitStream('llm/stream', { provider: 'p', model: 'm', messages: [] }, async function* () {
        for (const chunk of chunks) yield chunk
      }) as AsyncIterable<StreamChunk>,
    )
    expect(textOf(output)).toContain(OUTPUT_BLOCK_TEXT)
    expect(textOf(output)).not.toContain(FAKE_KEY)
    const reviewed = (await records(runtime)).find((record) => record.kind === 'output_reviewed')
    expect(reviewed?.decision).toBe('deny')
  })
})
