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
    inputJudge: { mode: 'flagged', failClosed: false, normalize: true },
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
    judge: { enabled: true, scope: 'always', provider: 'liao', model: 'gpt-6-luna', maxChars: 12000, timeoutMs: 6000, available: true, configurable: true },
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
})
