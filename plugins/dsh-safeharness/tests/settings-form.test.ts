/**
 * The settings form's diff and parse logic (1.15.2).
 *
 * The panel's save button is driven by `buildPatch` alone, and until 1.15.2 that
 * function had no test at all. The regression it now pins: the entropy helper's
 * hard-wired `[0, 8]` cap was shared with the patrol window, so the *default*
 * form (`patrolWindowMinutes: 10`) counted as invalid, no patch was ever built,
 * and the bar said "没有修改" while every control stayed savable-looking.
 */
import { describe, expect, it } from 'vitest'
import { baselineOf, buildPatch, toSettingsData } from '../src/client/panel.js'
import type { PanelSettingsValue } from '../src/panel/protocol.js'

/** One loaded value shaped like the real `/settings` answer. */
function settingsValue(overrides: Partial<PanelSettingsValue> = {}): PanelSettingsValue {
  return {
    preset: 'balanced',
    surfaces: { input: 'enforce', tools: 'enforce', results: 'enforce', output: 'warn', approval: 'delegate' },
    inputJudge: { mode: 'flagged', failClosed: false, normalize: true, timeoutMs: 4500, maxTokens: 4096 },
    toolDetection: { descriptorScan: 'warn', repeatedAttemptThreshold: 0, entropyThreshold: 0, entropyMinLength: 48, allowedTables: [] },
    pii: { enabled: true, classes: ['email', 'api_key'] },
    lists: { denyTools: ['rm -rf *'], askTools: [], denyTags: [], tagOverrides: [{ pattern: 'mcp__*', tags: ['external'] }], blockOn: ['credential_leak'], allowOnce: [] },
    source: { rulesDir: 'C:\\ws\\rules', rulesWatch: true, patrolWindowMinutes: 10, patrolFactor: 5, patrolMinCount: 10 },
    facts: {
      engine: { kind: 'builtin', command: '' },
      rules: { inlineRules: 0, sources: 2 },
      audit: { format: 'ndjson', dir: '', rotateMb: 64, required: true, hashChain: true },
      posture: { onLoad: true, failOn: [] },
      patrolNotify: { channels: [], healthUrls: 0 },
    },
    judge: { enabled: true, scope: 'always', provider: 'liao', model: 'gpt-6-luna', maxChars: 12000, timeoutMs: 6000, maxTokens: 0, reasoningEffort: '', available: true, configurable: true },
    draft: { enabled: true, provider: 'liao', model: '' },
    providers: [],
    customProviders: [],
    providerConfigurable: true,
    revision: 3,
    configPath: 'C:\\ws\\cordis.patch.yml',
    ...overrides,
  }
}

describe('buildPatch', () => {
  it('reports nothing for a freshly loaded form', () => {
    const value = settingsValue()
    expect(buildPatch(value, toSettingsData(value))).toEqual({ patch: undefined, invalid: null })
  })

  it('echoes the revision and patches one judge field', () => {
    const value = settingsValue()
    const form = { ...toSettingsData(value), judge: { ...toSettingsData(value).judge, scope: 'flagged' as const } }
    expect(buildPatch(value, form).patch).toEqual({ expectedRevision: 3, judge: { scope: 'flagged' } })
  })

  it('omits expectedRevision when the host exposes no revision', () => {
    const value = settingsValue({ revision: null })
    const form = { ...toSettingsData(value), judge: { ...toSettingsData(value).judge, timeoutMs: '9000' } }
    expect(buildPatch(value, form).patch).toEqual({ judge: { timeoutMs: 9000 } })
  })

  it('accepts the default patrol window and factor', () => {
    // The 1.13.0–1.15.1 regression: 10 minutes fell outside the entropy cap.
    const value = settingsValue()
    expect(buildPatch(value, { ...toSettingsData(value), source: { ...toSettingsData(value).source, patrolWindowMinutes: '30', patrolFactor: '12' } }).patch)
      .toEqual({ expectedRevision: 3, source: { patrolWindowMinutes: 30, patrolFactor: 12 } })
  })

  it('refuses out-of-range values with a reason', () => {
    const value = settingsValue()
    const base = toSettingsData(value)
    expect(buildPatch(value, { ...base, judge: { ...base.judge, maxChars: '0' } }).invalid).toContain('正整数')
    expect(buildPatch(value, { ...base, judge: { ...base.judge, timeoutMs: 'abc' } }).invalid).toContain('正整数')
    expect(buildPatch(value, { ...base, toolDetection: { ...base.toolDetection, entropyThreshold: '9' } }).invalid).toContain('0–8')
    expect(buildPatch(value, { ...base, source: { ...base.source, patrolWindowMinutes: '0' } }).invalid).toContain('≥ 1')
    expect(buildPatch(value, { ...base, source: { ...base.source, patrolMinCount: '-1' } }).invalid).toContain('0 或正整数')
  })

  it('patches the input judge deadline and rejects a non-numeric one (1.20.0)', () => {
    const value = settingsValue()
    const base = toSettingsData(value)
    expect(buildPatch(value, {
      ...base,
      inputJudge: { ...base.inputJudge, timeoutMs: '12000' },
    }).patch).toEqual({ expectedRevision: 3, inputJudge: { timeoutMs: 12000 } })
    // `0` is a real choice ("inherit the output judge"), not an empty field.
    expect(buildPatch(value, {
      ...base,
      inputJudge: { ...base.inputJudge, timeoutMs: '0' },
    }).patch).toEqual({ expectedRevision: 3, inputJudge: { timeoutMs: 0 } })
    expect(buildPatch(value, {
      ...base,
      inputJudge: { ...base.inputJudge, timeoutMs: 'abc' },
    }).invalid).toContain('0 或正整数毫秒')
  })

  it('treats the freshly loaded input deadline as unchanged', () => {
    // The regression this guards: the form carries the *resolved* deadline (4500 here)
    // while the raw config may say `0`. Comparing the two raw values would make every
    // load look dirty and pin the fallback on the first save.
    const value = settingsValue()
    expect(toSettingsData(value).inputJudge.timeoutMs).toBe('4500')
    expect(buildPatch(value, toSettingsData(value)).patch).toBeUndefined()
  })

  it('diffs the 1.21.0 judge budget and effort, and refuses a negative budget', () => {
    const value = settingsValue()
    const base = toSettingsData(value)
    expect(buildPatch(value, { ...base, judge: { ...base.judge, maxTokens: '6000' } }).patch)
      .toEqual({ expectedRevision: 3, judge: { maxTokens: 6000 } })
    expect(buildPatch(value, { ...base, judge: { ...base.judge, reasoningEffort: ' low ' } }).patch)
      .toEqual({ expectedRevision: 3, judge: { reasoningEffort: 'low' } })
    expect(buildPatch(value, { ...base, judge: { ...base.judge, maxTokens: '-1' } }).invalid).toContain('0 或正整数')
    expect(buildPatch(value, { ...base, judge: { ...base.judge, maxTokens: 'lots' } }).invalid).toContain('0 或正整数')
  })

  it('diffs the 1.21.0 input judge budget the same way', () => {
    const value = settingsValue()
    const base = toSettingsData(value)
    expect(buildPatch(value, { ...base, inputJudge: { ...base.inputJudge, maxTokens: '2048' } }).patch)
      .toEqual({ expectedRevision: 3, inputJudge: { maxTokens: 2048 } })
    expect(buildPatch(value, { ...base, inputJudge: { ...base.inputJudge, maxTokens: '-5' } }).invalid).toContain('0 或正整数')
  })

  it('normalizes a list and ignores a pure reorder', () => {
    const value = settingsValue({ lists: { ...settingsValue().lists, denyTools: ['b', 'a'] } })
    const base = toSettingsData(value)
    // Order alone is not a change.
    expect(buildPatch(value, { ...base, lists: { ...base.lists, denyTools: 'a\nb\n' } }).patch).toBeUndefined()
    // A new entry is, and the text is normalized before it goes on the wire.
    expect(buildPatch(value, { ...base, lists: { ...base.lists, denyTools: 'a\nb\n\nc\nc\n' } }).patch)
      .toEqual({ expectedRevision: 3, lists: { denyTools: ['a', 'b', 'c'] } })
  })

  it('does not save a table list whose case only differs', () => {
    const value = settingsValue({ toolDetection: { ...settingsValue().toolDetection, allowedTables: ['Users'] } })
    const base = toSettingsData(value)
    expect(buildPatch(value, { ...base, toolDetection: { ...base.toolDetection, allowedTables: 'users' } }).patch).toBeUndefined()
  })
})

describe('baselineOf', () => {
  it('moves when an editable field moves and stays put when a status flag flips', () => {
    const value = settingsValue()
    expect(baselineOf(settingsValue({ judge: { ...value.judge, available: false } }))).toBe(baselineOf(value))
    expect(baselineOf(settingsValue({ preset: 'hardened' }))).toBe(baselineOf(value))
    expect(baselineOf(settingsValue({ judge: { ...value.judge, maxChars: 9000 } }))).not.toBe(baselineOf(value))
  })

  it('tracks the 1.21.0 budget and effort fields', () => {
    const value = settingsValue()
    expect(baselineOf(settingsValue({ judge: { ...value.judge, maxTokens: 6000 } }))).not.toBe(baselineOf(value))
    expect(baselineOf(settingsValue({ judge: { ...value.judge, reasoningEffort: 'low' } }))).not.toBe(baselineOf(value))
  })

  it('treats a panel that predates 1.21.0 as the 0/empty baseline', () => {
    // The `?? 0` / `?? ''` in `baselineOf`: a payload without the new fields must compare
    // equal to a form carrying their defaults, or every upgrade would drop a live draft.
    const value = settingsValue()
    const legacy = {
      ...value,
      judge: { ...value.judge, maxTokens: undefined, reasoningEffort: undefined },
    } as unknown as PanelSettingsValue
    expect(baselineOf(legacy)).toBe(baselineOf(value))
  })
})
