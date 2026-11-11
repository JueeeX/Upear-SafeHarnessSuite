/**
 * M5 T5.2: LLM-assisted rule drafting.
 *
 * Two halves. The *core* (src/draft/rule.ts) is driven here with fake model replies:
 * it must parse JSON strictly, validate with the loader's own gate, and never let the
 * operator's description leak into the result. The *surface* half proves the tool and
 * `/safeharness draft` return drafts only — `applied: false` is a contract, not a
 * comment, because a model must not be able to change the rule set by calling a tool.
 * @module
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import {
  createRuleDrafter,
  DRAFT_REQUEST_MARK,
  DRAFT_PROMPT_MARKER,
  MAX_PATTERN_CHARS,
  type DraftCall,
  type DraftLimits,
} from '../src/draft/rule.js'
import { draftRuleTool } from '../src/surface/tools.js'
import { safeharnessCommand, type DraftCommandTarget } from '../src/surface/commands.js'
import { isDraftRequest } from '../src/hooks/llm.js'
import { apply } from '../src/index.js'
import { createFakeHost } from './helpers/fake-host.js'
import type { Runtime } from '../src/runtime.js'

/** Generous limits so most cases exercise the "nothing truncated" path. */
const LIMITS: DraftLimits = { timeoutMs: 1000, maxChars: 500, maxTokens: 200 }

/** A temporary ledger directory (never inside the repo). */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'safeharness-draft-'))
}

/** A model call that replies with one text-delta carrying `text`. */
function replyOf(text: string, seen: string[] = []): DraftCall {
  return (prompt) => {
    seen.push(prompt)
    return (async function* () {
      yield { type: 'text-delta', text }
    })()
  }
}

/** Build a drafter whose model replies with `text`. */
function drafterFor(text: string, existingNames: readonly string[] = [], seen: string[] = []) {
  return createRuleDrafter(replyOf(text, seen), { existingNames: () => existingNames })
}

/** A valid inform-rule payload, overridable field by field. */
function informPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'draft_curl_pipe_shell',
    pattern: 'curl\\s+-[a-z]+\\s*\\|\\s*(?:sh|bash)',
    severity: 'high',
    category: 'remote-code-execution',
    reason: 'curl piped into a shell',
    ...over,
  })
}

/** A valid chain-rule payload, overridable field by field. */
function chainPayload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'draft_secret_then_post',
    first: '(?:^|_)(?:secret|token)(?:_|$)',
    then: '(?:^|_)(?:http|upload)(?:_|$)',
    max_gap: 2,
    severity: 'critical',
    category: 'trajectory-chain',
    reason: 'credential read then egress',
    ...over,
  })
}

/** Invoke one registered tool definition. */
async function invoke(definition: unknown, args: unknown = {}): Promise<Record<string, unknown>> {
  const execute = (definition as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute
  return await execute(args, {}) as Record<string, unknown>
}

describe('rule drafter: a valid reply becomes a paste-ready draft', () => {
  it('renders an inform rule as a complete rules file', async () => {
    const result = await drafterFor(informPayload()).draft({ description: 'catch curl | sh', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unreachable')
    expect(result.draft.name).toBe('draft_curl_pipe_shell')
    expect(result.draft.severity).toBe('high')
    expect(result.draft.yaml).toContain('rules:')
    expect(result.draft.yaml).toContain("  - name: draft_curl_pipe_shell")
    expect(result.draft.yaml).toContain("    pattern: 'curl\\s+-[a-z]+\\s*\\|\\s*(?:sh|bash)'")
    expect(result.draft.yaml).toContain('    action: deny')
    expect(result.draft.yaml).toContain("# Drafted by safeharness (not applied).")
    expect(result.draft.summary).toContain("inform rule 'draft_curl_pipe_shell' [high]")
    expect(result.metrics.replyChars).toBeGreaterThan(0)
    expect(result.metrics.promptChars).toBeGreaterThan(0)
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('renders a chain rule under chain_rules', async () => {
    const result = await drafterFor(chainPayload()).draft({ description: 'secret then post', kind: 'chain' }, LIMITS)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unreachable')
    expect(result.draft.yaml).toContain('chain_rules:')
    expect(result.draft.yaml).toContain('    max_gap: 2')
    expect(result.draft.yaml).toContain('    first: ')
    expect(result.draft.summary).toContain('chain rule')
  })

  it('accepts a fenced JSON reply (models like to add fences)', async () => {
    const fenced = '```json\n' + informPayload() + '\n```'
    const result = await drafterFor(fenced).draft({ description: 'catch curl | sh', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('ok')
  })

  it('escapes single quotes so the emitted YAML stays loadable', async () => {
    const payload = informPayload({ pattern: "can't be trusted", reason: "it's bad" })
    const result = await drafterFor(payload).draft({ description: 'quotes', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unreachable')
    expect(result.draft.yaml).toContain("pattern: 'can''t be trusted'")
    expect(result.draft.yaml).toContain("reason: 'it''s bad'")
  })
})

describe('rule drafter: the request is bounded and marked as auxiliary', () => {
  it('sends the marker, the kind and the description inside a nonce block', async () => {
    const seen: string[] = []
    await drafterFor(informPayload(), [], seen).draft({ description: 'catch curl | sh', kind: 'inform' }, LIMITS)
    expect(seen).toHaveLength(1)
    const prompt = seen[0] ?? ''
    expect(prompt.startsWith(DRAFT_PROMPT_MARKER)).toBe(true)
    expect(prompt).toContain('kind="inform"')
    expect(prompt).toContain('catch curl | sh')
    // The request block is closed with the same nonce it was opened with, so the
    // description cannot terminate the block early.
    expect(prompt).toMatch(/<request kind="inform" nonce="[^"]+">/)
    expect(prompt).toMatch(/<\/request nonce="[^"]+">/)
  })

  it('clamps the description to draft.maxChars', async () => {
    const seen: string[] = []
    await drafterFor(informPayload(), [], seen).draft({ description: 'x'.repeat(5000), kind: 'inform' }, { ...LIMITS, maxChars: 50 })
    const prompt = seen[0] ?? ''
    expect(prompt).toContain('x'.repeat(50))
    expect(prompt).not.toContain('x'.repeat(51))
  })

  it('marks its own request so the output guard skips it', () => {
    expect(isDraftRequest({ [DRAFT_REQUEST_MARK]: true })).toBe(true)
    expect(isDraftRequest({})).toBe(false)
    expect(isDraftRequest(null)).toBe(false)
  })
})

describe('rule drafter: failures degrade to a status, never a throw', () => {
  it('unavailable when the profile composes no llm service', async () => {
    const result = await createRuleDrafter(undefined, { existingNames: () => [] })
      .draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('unavailable')
    if (result.status !== 'unavailable') throw new Error('unreachable')
    expect(result.reason).toContain('llm')
  })

  it('bad_json when the reply is not JSON', async () => {
    const result = await drafterFor('I think the rule should be...').draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('bad_json')
  })

  it('empty when the model says nothing', async () => {
    const result = await drafterFor('   ').draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('empty')
  })

  it('timeout when the model does not answer in time', async () => {
    const hang: DraftCall = (_prompt, { signal }) => (async function* () {
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })()
    const result = await createRuleDrafter(hang, { existingNames: () => [] })
      .draft({ description: 'x', kind: 'inform' }, { ...LIMITS, timeoutMs: 1 })
    expect(result.status).toBe('timeout')
  })

  it('error when the call itself fails', async () => {
    const boom: DraftCall = () => (async function* () {
      throw new Error('provider exploded')
      // eslint-disable-next-line no-unreachable
      yield { type: 'text-delta', text: '' }
    })()
    const result = await createRuleDrafter(boom, { existingNames: () => [] }).draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('error')
  })
})

describe('rule drafter: the draft is validated with the loader gate', () => {
  it('rejects an unknown severity', async () => {
    const result = await drafterFor(informPayload({ severity: 'catastrophic' })).draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') throw new Error('unreachable')
    expect(result.reason).toContain('severity')
  })

  it('rejects a name that would shadow a loaded rule', async () => {
    const result = await drafterFor(informPayload(), ['draft_curl_pipe_shell'])
      .draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') throw new Error('unreachable')
    expect(result.reason).toContain('collides')
  })

  it('rejects a Python-only inline flag (the loader would refuse it too)', async () => {
    const result = await drafterFor(informPayload({ pattern: '(?i)secret' }))
      .draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('invalid')
  })

  it('rejects a nested quantifier (ReDoS risk in the synchronous guard)', async () => {
    const result = await drafterFor(informPayload({ pattern: '(a+)+b' }))
      .draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') throw new Error('unreachable')
    expect(result.reason).toContain('nested quantifier')
  })

  it('rejects an over-long pattern', async () => {
    const result = await drafterFor(informPayload({ pattern: 'a'.repeat(MAX_PATTERN_CHARS + 1) }))
      .draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') throw new Error('unreachable')
    expect(result.reason).toContain(String(MAX_PATTERN_CHARS))
  })

  it('rejects a pattern with embedded newlines', async () => {
    const result = await drafterFor(informPayload({ pattern: 'a\nb' })).draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('invalid')
  })

  it('rejects unexpected fields (a description cannot smuggle keys into a rule)', async () => {
    const result = await drafterFor(informPayload({ note: 'injected' })).draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') throw new Error('unreachable')
    expect(result.reason).toContain('note')
  })

  it('rejects a non-integer max_gap on a chain', async () => {
    const result = await drafterFor(chainPayload({ max_gap: '2' })).draft({ description: 'x', kind: 'chain' }, LIMITS)
    expect(result.status).toBe('invalid')
    if (result.status !== 'invalid') throw new Error('unreachable')
    expect(result.reason).toContain('max_gap')
  })

  it('never returns the operator description', async () => {
    const sentinel = 'SENTINEL-DESCRIPTION-7f3a'
    const result = await drafterFor(informPayload()).draft({ description: `catch ${sentinel}`, kind: 'inform' }, LIMITS)
    expect(JSON.stringify(result)).not.toContain(sentinel)
  })
})

describe('rule drafter: shape warnings for drafts that would catch almost nothing', () => {
  it('warns about an anchored literal (the measured /safeharness draft curl case)', async () => {
    const payload = informPayload({ name: 'deny_curl', pattern: '^curl$', reason: 'Blocks the requested curl command.' })
    const result = await drafterFor(payload).draft({ description: 'curl', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unreachable')
    expect(result.draft.warnings.length).toBeGreaterThanOrEqual(2)
    expect(result.draft.warnings.join(' ')).toContain('one literal string')
    expect(result.draft.warnings.join(' ')).toContain('6 characters')
  })

  it('warns about a pattern that matches a single token without separation', async () => {
    const result = await drafterFor(informPayload({ pattern: 'curl.*' })).draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unreachable')
    expect(result.draft.warnings.join(' ')).toContain('single token')
  })

  it('stays quiet for a pattern with real structure', async () => {
    const result = await drafterFor(informPayload()).draft({ description: 'x', kind: 'inform' }, LIMITS)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unreachable')
    expect(result.draft.warnings).toEqual([])
  })

  it('warns when a chain leg is one literal tool name', async () => {
    const result = await drafterFor(chainPayload({ first: 'query_db', then: 'http_post' }))
      .draft({ description: 'x', kind: 'chain' }, LIMITS)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('unreachable')
    expect(result.draft.warnings.join(' ')).toContain("'first' leg")
    expect(result.draft.warnings.join(' ')).toContain("'then' leg")
  })

  it('prints the warnings in the command output', async () => {
    const { runtime } = createFakeHost()
    const drafter = drafterFor(informPayload({ name: 'deny_curl', pattern: '^curl$' }))
    const command = safeharnessCommand(runtime, async () => ({
      ranAt: new Date().toISOString(),
      findings: [],
      summary: { fail: 0, warn: 0, ok: 0, skip: 0, clean: true },
    }), undefined, undefined, {
      enabled: true,
      draft: (description, kind) => drafter.draft({ description, kind }, LIMITS),
    }) as unknown as { handler: (invocation: unknown) => Promise<CommandResult> }
    const result = await command.handler({ rawInput: 'draft curl' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('warnings:')
    expect(result.text).toContain('one literal string')
  })
})

describe('safeharness_draft_rule tool', () => {
  it('returns the draft with applied:false and never the description', async () => {
    const tool = draftRuleTool(drafterFor(informPayload()), () => ({
      enabled: true, maxChars: 500, timeoutMs: 1000, maxTokens: 200,
    }))
    const value = await invoke(tool, { description: 'catch curl | sh' })
    expect(value.applied).toBe(false)
    expect(value.status).toBe('ok')
    expect((value.draft as Record<string, unknown>).yaml).toContain('rules:')
    expect(String(value.next)).toContain('Nothing was applied')
    expect(JSON.stringify(value)).not.toContain('catch curl | sh')
  })

  it('reports the disabled state without calling the model', async () => {
    const seen: string[] = []
    const tool = draftRuleTool(drafterFor(informPayload(), [], seen), () => ({
      enabled: false, maxChars: 500, timeoutMs: 1000, maxTokens: 200,
    }))
    const value = await invoke(tool, { description: 'catch curl | sh' })
    expect(value.status).toBe('disabled')
    expect(seen).toHaveLength(0)
  })

  it('refuses an empty description before spending a call', async () => {
    const seen: string[] = []
    const tool = draftRuleTool(drafterFor(informPayload(), [], seen), () => ({
      enabled: true, maxChars: 500, timeoutMs: 1000, maxTokens: 200,
    }))
    const value = await invoke(tool, { description: '   ' })
    expect(value.status).toBe('invalid')
    expect(seen).toHaveLength(0)
  })
})

describe('/safeharness draft', () => {
  /** Build the command with a draft target over a fake runtime. */
  function commandWith(draft: DraftCommandTarget | undefined, runtime: Runtime) {
    const definition = safeharnessCommand(runtime, async () => ({
      ranAt: new Date().toISOString(),
      findings: [],
      summary: { fail: 0, warn: 0, ok: 0, skip: 0, clean: true },
    }), undefined, undefined, draft)
    return definition as unknown as { handler: (invocation: unknown) => Promise<CommandResult> }
  }

  it('prints the paste-ready YAML and says nothing was applied', async () => {
    const { runtime } = createFakeHost()
    const drafter = drafterFor(informPayload())
    const command = commandWith({
      enabled: true,
      draft: (description, kind) => drafter.draft({ description, kind }, LIMITS),
    }, runtime)
    const result = await command.handler({ rawInput: 'draft catch curl | sh' })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('draft: ok (nothing applied)')
    expect(result.text).toContain('rules:')
    expect(result.text).toContain('next: save the YAML')
  })

  it('passes --chain through and strips it from the description', async () => {
    const { runtime } = createFakeHost()
    const kinds: string[] = []
    const command = commandWith({
      enabled: true,
      draft: (description, kind) => {
        kinds.push(`${kind}:${description}`)
        return drafterFor(chainPayload()).draft({ description, kind }, LIMITS)
      },
    }, runtime)
    const result = await command.handler({ rawInput: 'draft secret then post --chain' })
    expect(result.kind).toBe('success')
    expect(kinds).toEqual(['chain:secret then post'])
    expect(result.text).toContain('chain_rules:')
  })

  it('rejects an empty description and a disabled config', async () => {
    const { runtime } = createFakeHost()
    const empty = await commandWith({ enabled: true, draft: () => Promise.reject(new Error('must not be called')) }, runtime)
      .handler({ rawInput: 'draft' })
    expect(empty.kind).toBe('error')
    expect(empty.text).toContain('describe what to catch')
    const disabled = await commandWith({ enabled: false, draft: () => Promise.reject(new Error('must not be called')) }, runtime)
      .handler({ rawInput: 'draft anything' })
    expect(disabled.kind).toBe('error')
    expect(disabled.text).toContain('disabled')
  })

  it('reports a failed draft as an error with the reason', async () => {
    const { runtime } = createFakeHost()
    const command = commandWith({
      enabled: true,
      draft: (description, kind) => drafterFor('not json').draft({ description, kind }, LIMITS),
    }, runtime)
    const result = await command.handler({ rawInput: 'draft whatever' })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('draft: bad_json')
    expect(result.text).not.toContain('not json')
  })
})

describe('composition root wiring', () => {
  it('registers the drafting tool and never writes a rule file', async () => {
    const dir = tempDir()
    const { host, runtime } = createFakeHost({
      services: {
        llm: {
          stream: () => (async function* () {
            yield { type: 'text-delta', text: informPayload() } as never
          })() as never,
        },
      },
    })
    await apply(host.ctx as never, {
      audit: { dir },
      draft: { enabled: true, provider: 'p', model: 'm' },
    })
    const tool = host.tools.get('safeharness_draft_rule')
    expect(tool).toBeDefined()
    const before = runtime.engine.rulesetHash
    const value = await invoke(tool?.definition, { description: 'catch curl | sh' })
    expect(value.status).toBe('ok')
    expect(value.applied).toBe(false)
    // Drafting is a *read* of the model, not a write of the rule set: the hash the
    // ledger stamps is unchanged and no rule gained the drafted name.
    expect(runtime.engine.rulesetHash).toBe(before)
    expect(runtime.engine.ruleset.rules.some((rule) => rule.id === 'draft_curl_pipe_shell')).toBe(false)
  })
})
