/**
 * The optional Python sidecar engine (M5 T5.1, step 2).
 *
 * These tests use the fake child process, so they are about the *wiring*: the
 * asynchronous input path, decision composition staying identical to the built-in
 * engine, fail-closed behaviour on transport failures, and the rule-set
 * handshake. Behavioural parity against the real Python engine lives in
 * `tests/sidecar-parity.test.ts` (internal asset, needs the framework checkout).
 * @module
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { resolveConfig } from '../src/config.js'
import { createEngine } from '../src/engine/index.js'
import { createSidecarEngine, type SidecarEngine } from '../src/engine/sidecar-engine.js'
import { Sidecar, SidecarError } from '../src/engine/sidecar.js'
import { SQL_RULE_ID } from '../src/engine/input.js'
import type { CompiledRule, RuleSet, Severity } from '../src/engine/types.js'
import { ReasonCode } from '../src/engine/types.js'

const FAKE = fileURLToPath(new URL('./helpers/fake-sidecar.mjs', import.meta.url))

/** Build one compiled deny rule (the shape `loadRuleSet` produces). */
function rule(id: string, source: string, severity: Severity = 'high', category = 'family'): CompiledRule {
  return {
    id,
    name: id,
    source,
    regex: new RegExp(source, 'i'),
    severity,
    category,
    action: 'deny',
    reason: `test rule ${id}`,
    origin: 'inline',
  }
}

/** Build an immutable rule set over the given rules (no chains). */
function ruleset(rules: readonly CompiledRule[] = [], hash = 'a'.repeat(64)): RuleSet {
  return {
    hash,
    rules,
    chains: [],
    ruleCount: rules.length,
    chainCount: 0,
    sources: ['inline'],
    loadedAt: 1_747_000_000_000,
  }
}

/** Text that the fake engine's SQL heuristic calls dangerous (never a full literal). */
const DANGEROUS_SQL = ['dro', 'p', ' ta', 'ble', ' users'].join('')

interface Harness {
  readonly engine: SidecarEngine
  readonly client: Sidecar
  readonly rules: RuleSet
  readonly config: ReturnType<typeof resolveConfig>
}

/** Build a prepared sidecar engine over the fake child. */
async function harness(options: {
  args?: string[]
  rules?: RuleSet
  timeoutMs?: number
} = {}): Promise<Harness> {
  const rules = options.rules ?? ruleset([rule('hit_one', 'hit-one'), rule('hit_two', 'hit-two', 'critical', 'critical-family')])
  const config = resolveConfig({
    engine: {
      kind: 'sidecar',
      command: process.execPath,
      args: options.args ?? [FAKE],
      timeoutMs: options.timeoutMs ?? 1000,
      startTimeoutMs: 3000,
    },
  })
  const client = new Sidecar({
    command: config.engine.command,
    args: [...config.engine.args],
    timeoutMs: config.engine.timeoutMs,
    startTimeoutMs: config.engine.startTimeoutMs,
  })
  const engine = createSidecarEngine({
    builtin: createEngine(rules, config),
    sidecar: client,
    timeoutMs: 1000,
  })
  await engine.prepare()
  return { engine, client, rules, config }
}

/** Await a rejection and return its `SidecarError` code. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SidecarError)
    return (error as SidecarError).code
  }
  throw new Error('expected the call to reject')
}

describe('sidecar engine: input judgement', () => {
  it('serves the async path and composes the same decision the built-in engine makes', async () => {
    const { engine } = await harness()
    try {
      const text = 'please hit-one and hit-two'
      const sidecarDecision = await engine.evaluateInputAsync(text)
      const builtinDecision = engine.evaluateInput(text)
      expect(sidecarDecision).toEqual(builtinDecision)
      expect(sidecarDecision.kind).toBe('deny')
      expect(sidecarDecision.ruleIds).toEqual(['hit_one', 'hit_two'])
      // Highest severity wins: hit_two is critical.
      expect(sidecarDecision.severity).toBe('critical')
      expect(sidecarDecision.category).toBe('critical-family')
      expect(sidecarDecision.reasonCode).toBe(ReasonCode.InputRule)
    } finally {
      await engine.stop()
    }
  })

  it('composes a dangerous-SQL hit reported by the child exactly like the built-in engine', async () => {
    const { engine } = await harness()
    try {
      const sidecarDecision = await engine.evaluateInputAsync(`now ${DANGEROUS_SQL}`)
      const builtinDecision = engine.evaluateInput(`now ${DANGEROUS_SQL}`)
      expect(sidecarDecision).toEqual(builtinDecision)
      expect(sidecarDecision.reasonCode).toBe(ReasonCode.InputSql)
      expect(sidecarDecision.ruleIds).toEqual([SQL_RULE_ID])
      expect(sidecarDecision.severity).toBe('high')
    } finally {
      await engine.stop()
    }
  })

  it('allows clean text without a denial and truncates before sending (built-in parity)', async () => {
    const { engine } = await harness()
    try {
      const clean = 'summarise the alarms from yesterday'
      expect(await engine.evaluateInputAsync(clean)).toEqual(engine.evaluateInput(clean))
      // A hit beyond the configured truncation bound is not scanned by either engine.
      const long = `${'x'.repeat(60_000)}hit-one`
      expect(await engine.evaluateInputAsync(long)).toEqual(engine.evaluateInput(long))
    } finally {
      await engine.stop()
    }
  })

  it('keeps the synchronous built-in decision available when the child is dead', async () => {
    const { engine, client } = await harness()
    try {
      const crashed = client.request('crash').catch(() => undefined)
      await crashed
      // Let the exit event settle.
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(engine.evaluateInput('hit-one').kind).toBe('deny')
      expect(['sidecar_exited', 'sidecar_not_ready']).toContain(await codeOf(engine.evaluateInputAsync('hit-one')))
    } finally {
      await engine.stop()
    }
  })
})

describe('sidecar engine: rule-set integrity', () => {
  it('fails the handshake when the child rejects the rule set (no partial engine)', async () => {
    const config = resolveConfig({
      engine: { kind: 'sidecar', command: process.execPath, args: [FAKE], startTimeoutMs: 3000 },
    })
    const bad = ruleset([rule('bad', 'BADREGEX-token')])
    const client = new Sidecar({
      command: config.engine.command,
      args: [...config.engine.args],
      timeoutMs: 1000,
      startTimeoutMs: 3000,
    })
    const engine = createSidecarEngine({ builtin: createEngine(bad, config), sidecar: client, timeoutMs: 1000 })
    expect(await codeOf(engine.prepare())).toBe('sidecar_rules_rejected')
    await engine.stop()
  })

  it('refuses new input until the child has accepted a reloaded rule set', async () => {
    const { engine } = await harness()
    try {
      expect(await engine.evaluateInputAsync('hit-one')).toMatchObject({ kind: 'deny' })
      engine.reloadRules(ruleset([rule('hit_one', 'hit-one'), rule('hit_three', 'hit-three')], 'b'.repeat(64)))
      // Immediately after the reload the child still has the previous rule set.
      expect(await codeOf(engine.evaluateInputAsync('hit-one'))).toBe('sidecar_rules_stale')
      // The queued push completes; then the live rule set is served again.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(engine.rulesStale).toBe(false)
      expect(await engine.evaluateInputAsync('hit-three')).toMatchObject({ kind: 'deny', ruleIds: ['hit_three'] })
    } finally {
      await engine.stop()
    }
  })

  it('rejects a child that reports a rule name this rule set does not contain', async () => {
    const { engine } = await harness({ args: [FAKE, '--mode', 'bogus-rule'] })
    try {
      expect(await codeOf(engine.evaluateInputAsync('anything'))).toBe('sidecar_unknown_rule')
    } finally {
      await engine.stop()
    }
  })
})
