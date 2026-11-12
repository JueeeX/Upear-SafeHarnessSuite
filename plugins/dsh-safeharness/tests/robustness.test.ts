/**
 * Engine robustness (T2.6 / §8.4): hostile or accidental argument shapes must not
 * hang, blow the stack, or silently skip scanning.
 *
 * Regression origin: the first argument walker had no cycle guard, so a cyclic
 * `exec.arguments` cost seconds of CPU and gigabytes of stack before throwing
 * (reported by the failure-matrix pass; fixed with an identity set + node/char
 * budgets, and budget exhaustion now fails closed).
 */
import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { createFakeHost, packagedRules } from './helpers/fake-host.js'
import { evaluateToolCall } from '../src/engine/tool.js'
import { resolveConfig } from '../src/config.js'
import type { ToolView, SessionView } from '../src/engine/types.js'

/** Empty session trail. */
function session(): SessionView {
  return { sessionId: 'robust', trail: [], totalCalls: 0 }
}

/**
 * A tool view with the given raw arguments (bytes are declared, not measured).
 *
 * The name is execution-facing on purpose: since 1.2.2 the argument walk only runs
 * for tools whose arguments can reach an SQL engine (R42), and these cases are
 * about the WALKER, not about who is scanned.
 */
function view(argumentsValue: unknown, bytes = 1024): ToolView {
  return { name: 'db_query', arguments: argumentsValue, argsBytes: bytes, tags: ['db'] }
}

describe('argument-shape robustness', () => {
  const ruleset = packagedRules()
  const cfg = resolveConfig({ preset: 'balanced' }).tools

  it('handles a cyclic arguments object without hanging or throwing', () => {
    const cyclic: Record<string, unknown> = { path: '/tmp/x' }
    cyclic.self = cyclic
    const start = performance.now()
    const decision = evaluateToolCall(ruleset, cfg, view(cyclic), session())
    const elapsed = performance.now() - start
    // A benign cycle is still benign — it must simply be walked once.
    expect(decision.kind).toBe('allow')
    expect(elapsed).toBeLessThan(250)
  })

  it('still finds dangerous SQL hidden next to a cycle', () => {
    const cyclic: Record<string, unknown> = { sql: 'DROP TABLE users' }
    cyclic.self = cyclic
    const decision = evaluateToolCall(ruleset, cfg, view(cyclic), session())
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe('tool_denied_by_args')
  })

  it('fails closed on an arguments value that exceeds the node budget', () => {
    // 60k arrays × 4 items = 240k nodes, over MAX_ARGUMENT_NODES (100k).
    const wide: unknown[] = []
    for (let index = 0; index < 60_000; index += 1) wide.push([index, index, index, index])
    const decision = evaluateToolCall(ruleset, cfg, view(wide, 64 * 1024), session())
    expect(decision.kind).toBe('deny')
    // Budget exhaustion is reported as the argument-size class: the value is too
    // large to scan end-to-end, which is exactly what a size ceiling means here.
    expect(decision.reasonCode).toBe('tool_args_too_large')
    expect(decision.reason).toContain('scan budget')
  })

  it('never throws on exotic leaves (symbols, functions, bigints, undefined)', () => {
    const exotic = {
      a: undefined,
      b: Symbol('s'),
      c: () => 1,
      d: 10n,
      e: Number.NaN,
      f: [undefined, null, { g: 'plain' }],
    }
    expect(() => evaluateToolCall(ruleset, cfg, view(exotic), session())).not.toThrow()
  })

  it('a throwing getter is contained and cannot become an allow via a crash', () => {
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter exploded')
      },
    })
    // The engine may propagate (the hook then fails closed), but it must not hang
    // or return a false allow while silently skipping the rest of the walk.
    let outcome: 'threw' | 'denied' | 'allowed' = 'allowed'
    try {
      const decision = evaluateToolCall(ruleset, cfg, view(hostile), session())
      outcome = decision.kind === 'deny' ? 'denied' : 'allowed'
    } catch {
      outcome = 'threw'
    }
    expect(outcome).not.toBe('allowed')
  })

  it('keeps the guard-path helpers bounded too (bytes + digest on a cycle/throwing getter)', async () => {
    const { argsByteLength } = await import('../src/hooks/context.js')
    const { contentDigest } = await import('../src/util/hash.js')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    // canonicalJson has a depth cap; these must return, not hang.
    const start = performance.now()
    expect(argsByteLength(cyclic)).toBeGreaterThan(0)
    expect(contentDigest(cyclic).sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(performance.now() - start).toBeLessThan(250)
  })
})
