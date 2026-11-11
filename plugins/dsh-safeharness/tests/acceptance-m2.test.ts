/**
 * M2 acceptance: under `balanced`, every structurally-detectable attack in the
 * shipped corpus is denied, and ordinary work prompts are not (零误杀).
 *
 * The corpus is the same one the golden fixture was generated from, so "structural
 * hit" is not our own opinion: it is what the Python engine reports
 * (`inform_matched` / `sql_dangerous` in tests/fixtures/golden.json).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFakeHost, flushLedger, readLedger } from './helpers/fake-host.js'
import { loadCorpus, loadGolden, joinGolden } from './corpus.js'
import { installInputHook } from '../src/hooks/input.js'
import { evaluateInput } from '../src/engine/input.js'
import { inspectSql } from '../src/engine/sql.js'
import { resolveConfig } from '../src/config.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A user message in the shape `agent/pre-step` receives. */
function userMessage(text: string): Record<string, unknown> {
  return { id: 'm', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

/** Read a benign fixture. */
interface BenignFixture {
  name: string
  prompts: { id: string; text: string }[]
}
function benign(name: string): BenignFixture {
  return JSON.parse(readFileSync(join(pluginRoot, 'tests', 'fixtures', name), 'utf8')) as BenignFixture
}

describe('M2 acceptance — balanced denies every structural attack', () => {
  const corpus = loadCorpus()
  const golden = loadGolden()
  const aligned = joinGolden(corpus, golden)

  it('has the expected corpus shape (30 attacks / 2 suites)', () => {
    expect(corpus).toHaveLength(30)
    expect(new Set(corpus.map((attack) => attack.suite)).size).toBe(2)
  })

  it('the input hook rejects each attack that the Python engine flags structurally', async () => {
    const { host, runtime } = createFakeHost({ config: { preset: 'balanced' } })
    installInputHook(host.ctx as never, runtime)
    const denied: string[] = []
    for (const { attack, golden: verdict } of aligned) {
      const structural = verdict.inform_matched || verdict.sql_dangerous
      const decision = await host.emit(
        'agent/pre-step',
        { agent: { id: 'a', session: { id: 's' } }, messages: [userMessage(attack.text)] },
        () => ({ kind: 'enter', messages: [] }),
      )
      if (structural) {
        expect(decision, `${attack.suite}/${attack.id} must be rejected`).toEqual({ kind: 'reject' })
        denied.push(attack.id)
      }
    }
    // 9 inform matches + 16 dangerous SQL = 25 of the 30 attacks are structural.
    expect(denied).toHaveLength(25)
  })

  it('records the judge-face gap explicitly (5 attacks are not structurally detectable)', () => {
    const missed = aligned
      .filter(({ golden: verdict }) => !verdict.inform_matched && !verdict.sql_dangerous)
      .map(({ attack }) => `${attack.suite}/${attack.id}`)
    // These are the semantic cases the Python engine leaves to its LLM judge; the
    // structural parity test must NOT pretend they are covered (M3 wires the judge).
    expect(missed).toHaveLength(5)
    expect(missed).toEqual(['identity-impersonation/idp-010', 'identity-impersonation/idp-011', 'identity-impersonation/idp-012', 'identity-impersonation/idp-013', 'identity-impersonation/idp-014'])
  })

  it('the engine agrees with the hook (no divergence between layers)', () => {
    const config = resolveConfig({ preset: 'balanced' })
    const ruleset = createFakeHost({ config: { preset: 'balanced' } }).runtime.engine.ruleset
    for (const { attack, golden: verdict } of aligned) {
      const decision = evaluateInput(ruleset, attack.text, { maxChars: config.input.maxChars }).decision
      const structural = verdict.inform_matched || verdict.sql_dangerous
      expect(decision.kind === 'deny', `${attack.suite}/${attack.id}`).toBe(structural)
    }
  })
})

describe('M2 acceptance — benign work is never denied (零误杀)', () => {
  const fixture = benign('benign.json')

  it('has a realistic corpus', () => {
    expect(fixture.prompts.length).toBeGreaterThanOrEqual(30)
  })

  it('the engine finds no hit in any benign prompt', () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const hits: string[] = []
    for (const prompt of fixture.prompts) {
      const decision = runtime.engine.evaluateInput(prompt.text)
      if (decision.kind !== 'allow') hits.push(`${prompt.id}:${decision.ruleIds.join('+')}`)
    }
    expect(hits).toEqual([])
  })

  it('the input hook lets every benign prompt through', async () => {
    const { host, runtime } = createFakeHost({ config: { preset: 'balanced' } })
    installInputHook(host.ctx as never, runtime)
    for (const prompt of fixture.prompts) {
      const decision = await host.emit(
        'agent/pre-step',
        { agent: { id: 'a', session: { id: 's' } }, messages: [userMessage(prompt.text)] },
        () => ({ kind: 'enter', messages: [] }),
      )
      expect(decision, prompt.id).toEqual({ kind: 'enter', messages: [] })
    }
  })

  it('a benign SQL-shaped question is not flagged as dangerous SQL', () => {
    const prompt = fixture.prompts.find((item) => item.id === 'bn-018')
    expect(prompt).toBeDefined()
    expect(inspectSql(prompt?.text ?? '').dangerous).toBe(false)
  })
})

describe('M2 acceptance — borderline phrasing: the false-positive set is pinned', () => {
  /**
   * Prompts that mention privileged/override vocabulary in benign framing. This is
   * NOT a zero-FP assertion: the 20 patterns are ported verbatim from the Python
   * engine (golden parity), so some phrasing is denied by design. The list below
   * is a regression lock — widening it means the deployment gets noisier and must
   * be a deliberate, reviewed change (see evidence/T2.6-failure-matrix.md).
   */
  const documentedFalsePositives = ['bd-001', 'bd-002', 'bd-005', 'bd-006', 'bd-008', 'bd-009', 'bd-011']

  it('denies exactly the documented borderline set', () => {
    const fixture = benign('benign-borderline.json')
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const denied: string[] = []
    for (const prompt of fixture.prompts) {
      if (runtime.engine.evaluateInput(prompt.text).kind !== 'allow') denied.push(prompt.id)
    }
    expect(denied.sort()).toEqual([...documentedFalsePositives].sort())
  })

  it('observe mode still records them without denying (the escape hatch works)', async () => {
    const fixture = benign('benign-borderline.json')
    const { host, runtime } = createFakeHost({ config: { preset: 'observe' } })
    installInputHook(host.ctx as never, runtime)
    const denied: string[] = []
    for (const prompt of fixture.prompts) {
      const decision = await host.emit(
        'agent/pre-step',
        { agent: { id: 'a', session: { id: 'obs' } }, messages: [userMessage(prompt.text)] },
        () => ({ kind: 'enter', messages: [] }),
      )
      if (JSON.stringify(decision) === JSON.stringify({ kind: 'reject' })) denied.push(prompt.id)
    }
    expect(denied).toEqual([])
    await flushLedger(runtime)
    const records = await readLedger(runtime)
    // The hits are still recorded as warnings — observe is "see without stopping".
    expect(records.some((record) => record.kind === 'input_denied' && record.decision === 'warn')).toBe(true)
  })
})
