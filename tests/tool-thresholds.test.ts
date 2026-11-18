/**
 * Trajectory thresholds (1.12.0): the two kernel knobs the plugin used to lack —
 * `repeated_attempt_threshold` and `entropy_threshold` (+ `entropy_min_length`)
 * from `safeharness/policies/trajectory.py`.
 *
 * Kernel semantics ported here:
 *  - the repeated-attempt counter rises on a FAILED execution and is cleared by a
 *    success, so "failed, then worked" starts clean (`trajectory._record`);
 *  - both thresholds default to 0 = off, i.e. installing the plugin changes
 *    nothing until an operator turns them on;
 *  - the entropy check looks at string arguments only, ignores anything shorter
 *    than `entropy_min_length`, and reports length/entropy — never the value.
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { evaluateToolCall } from '../src/engine/tool.js'
import { ReasonCode } from '../src/engine/types.js'
import type { RuleSet, SessionView, ToolView } from '../src/engine/types.js'
import type { SafeHarnessConfig } from '../src/config.js'

/** No rules and no chains: these tests exercise the thresholds alone. */
const RULESET: RuleSet = {
  hash: 'test',
  rules: [],
  chains: [],
  ruleCount: 0,
  chainCount: 0,
  sources: ['test'],
  loadedAt: 0,
}

/** A no-trail session with an optional failure map. */
function session(failures?: Record<string, number>): SessionView {
  return {
    sessionId: 's-thresholds',
    trail: [],
    totalCalls: 0,
    ...(failures === undefined ? {} : { failures }),
  }
}

/** A tool call with arbitrary string arguments. */
function view(argumentsValue: unknown, name = 'db_query'): ToolView {
  return { name, arguments: argumentsValue, argsBytes: 2, tags: [] }
}

/** Resolved `tools` config over a partial override. */
function toolsConfig(overrides: Partial<SafeHarnessConfig['tools']> = {}) {
  return resolveConfig({ preset: 'balanced', tools: overrides }).tools
}

/** A 64-character string with plenty of entropy (mixed case + digits + punctuation). */
const HIGH_ENTROPY = 'Qk7xR2mP9vL4tZ8nW1cY6hJ3sD0fG5bA2eU7iO4pK1lM8nB5vC2xZ9qW3eR6t'

describe('repeated failed attempts', () => {
  it('is off by default', () => {
    const cfg = toolsConfig()
    expect(cfg.repeatedAttemptThreshold).toBe(0)
    const decision = evaluateToolCall(RULESET, cfg, view({ sql: 'select 1' }), session({ db_query: 99 }))
    expect(decision.reasonCode).toBe(ReasonCode.None)
  })

  it('denies once the failure count reaches the threshold', () => {
    const cfg = toolsConfig({ repeatedAttemptThreshold: 2 })
    expect(evaluateToolCall(RULESET, cfg, view({ sql: 'select 1' }), session({ db_query: 1 })).reasonCode)
      .toBe(ReasonCode.None)
    const denied = evaluateToolCall(RULESET, cfg, view({ sql: 'select 1' }), session({ db_query: 2 }))
    expect(denied.kind).toBe('deny')
    expect(denied.reasonCode).toBe(ReasonCode.ToolRepeatedAttempt)
    expect(denied.category).toBe('repeated_attempts')
    expect(denied.reason).toContain('2')
  })

  it('counts per tool, not per session', () => {
    const cfg = toolsConfig({ repeatedAttemptThreshold: 2 })
    const decision = evaluateToolCall(RULESET, cfg, view({ sql: 'select 1' }, 'read_file'), session({ db_query: 5 }))
    expect(decision.reasonCode).toBe(ReasonCode.None)
  })

  it('is validated as a non-negative integer', () => {
    expect(() => resolveConfig({ preset: 'balanced', tools: { repeatedAttemptThreshold: -1 } })).toThrow(/repeatedAttemptThreshold/)
    expect(() => resolveConfig({ preset: 'balanced', tools: { repeatedAttemptThreshold: 1.5 } })).toThrow(/repeatedAttemptThreshold/)
  })
})

describe('entropy threshold', () => {
  it('is off by default and accepts the kernel range', () => {
    expect(toolsConfig().entropyThreshold).toBe(0)
    expect(toolsConfig().entropyMinLength).toBe(48)
    expect(() => resolveConfig({ preset: 'balanced', tools: { entropyThreshold: 9 } })).toThrow(/entropyThreshold/)
  })

  it('denies a long high-entropy argument with no payload in the reason', () => {
    const cfg = toolsConfig({ entropyThreshold: 3.5 })
    const decision = evaluateToolCall(RULESET, cfg, view({ blob: HIGH_ENTROPY }), session())
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe(ReasonCode.ToolHighEntropy)
    expect(decision.category).toBe('high_entropy')
    expect(decision.reason).toContain(`length ${HIGH_ENTROPY.length}`)
    expect(decision.reason).not.toContain(HIGH_ENTROPY.slice(0, 12))
  })

  it('ignores a long low-entropy argument', () => {
    const cfg = toolsConfig({ entropyThreshold: 3.5 })
    const decision = evaluateToolCall(RULESET, cfg, view({ text: 'a'.repeat(200) }), session())
    expect(decision.reasonCode).toBe(ReasonCode.None)
  })

  it('ignores arguments shorter than entropyMinLength', () => {
    const cfg = toolsConfig({ entropyThreshold: 3.5, entropyMinLength: 200 })
    const decision = evaluateToolCall(RULESET, cfg, view({ blob: HIGH_ENTROPY }), session())
    expect(decision.reasonCode).toBe(ReasonCode.None)
  })

  it('walks nested arguments', () => {
    const cfg = toolsConfig({ entropyThreshold: 3.5 })
    const decision = evaluateToolCall(RULESET, cfg, view({ outer: { inner: [HIGH_ENTROPY] } }), session())
    expect(decision.reasonCode).toBe(ReasonCode.ToolHighEntropy)
  })
})

describe('session failure tracking', () => {
  it('rises on error and clears on success', async () => {
    const { SessionStateStore } = await import('../src/state.js')
    const store = new SessionStateStore()
    expect(store.view('s').failures).toEqual({})
    store.recordToolOutcome('s', 'db_query', true)
    store.recordToolOutcome('s', 'db_query', true)
    expect(store.view('s').failures).toEqual({ db_query: 2 })
    store.recordToolOutcome('s', 'db_query', false)
    expect(store.view('s').failures).toEqual({})
  })

  it('is bounded by the number of distinct tool names', async () => {
    const { MAX_FAILURE_TOOLS, SessionStateStore } = await import('../src/state.js')
    const store = new SessionStateStore()
    for (let index = 0; index < MAX_FAILURE_TOOLS + 10; index += 1) {
      store.recordToolOutcome('s', `tool_${index}`, true)
    }
    expect(Object.keys(store.view('s').failures ?? {})).toHaveLength(MAX_FAILURE_TOOLS)
  })

  it('reports a descriptor warning once per session per tool', async () => {
    const { SessionStateStore } = await import('../src/state.js')
    const store = new SessionStateStore()
    expect(store.noteDescriptorFlag('s', 'mcp__x')).toBe(true)
    expect(store.noteDescriptorFlag('s', 'mcp__x')).toBe(false)
    expect(store.noteDescriptorFlag('s', 'mcp__y')).toBe(true)
    expect(store.noteDescriptorFlag('other', 'mcp__x')).toBe(true)
  })
})
