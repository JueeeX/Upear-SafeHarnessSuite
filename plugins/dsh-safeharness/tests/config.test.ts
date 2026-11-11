/**
 * Config resolution: preset expansion, per-field override precedence, fail-loud
 * validation. The preset layer is the part with real risk (a schema default that
 * pre-empts the preset would silently run `balanced` enforcement under `observe`),
 * so it is tested first.
 */
import { describe, expect, it } from 'vitest'
import { Config, ConfigError, resolveConfig } from '../src/config.js'

describe('resolveConfig — host-validated config (R37)', () => {
  it('does not let schemastery materialize absent arrays (they used to defeat presets)', () => {
    // Regression: a bare `z.array(...)` validates a missing key into `[]`, and the
    // host hands that validated object to apply(); resolveConfig then saw an
    // "explicit" empty list and dropped the preset's failOn/blockOn on every real
    // host (M4 live finding). `keepAbsent` keeps absence absent.
    const validated = Config({}) as Record<string, unknown>
    expect(validated['posture']).toEqual({})
    expect(validated['results']).toEqual({})
    expect(JSON.stringify(validated)).not.toContain('"failOn"')
  })

  it('still expands the hardened preset after host validation', () => {
    const config = resolveConfig(Config({ preset: 'hardened' }) as never)
    expect(config.posture.failOn).toEqual([
      'sandbox_danger_full_access',
      'approval_never',
      'hmr_enabled',
      'plugin_version_mismatch',
    ])
    expect(config.results.blockOn).toEqual(['credential_leak', 'injection_marker'])
  })

  it('honours an explicitly emptied array as an operator override', () => {
    const config = resolveConfig(Config({ preset: 'hardened', posture: { failOn: [] }, results: { blockOn: [] } }) as never)
    expect(config.posture.failOn).toEqual([])
    expect(config.results.blockOn).toEqual([])
  })
})

describe('resolveConfig — preset expansion', () => {
  it('defaults to the balanced preset', () => {
    const config = resolveConfig({})
    expect(config.preset).toBe('balanced')
    expect(config.input.mode).toBe('enforce')
    expect(config.tools.mode).toBe('enforce')
    expect(config.results.mode).toBe('warn')
    expect(config.output.mode).toBe('warn')
    expect(config.approval.mode).toBe('delegate')
    expect(config.audit.required).toBe(true)
  })

  it('observe never enforces on any surface', () => {
    const config = resolveConfig({ preset: 'observe' })
    expect(config.input.mode).toBe('warn')
    expect(config.tools.mode).toBe('warn')
    expect(config.results.mode).toBe('warn')
    expect(config.output.mode).toBe('warn')
    expect(config.audit.required).toBe(false)
    expect(config.posture.failOn).toEqual([])
  })

  it('hardened enforces everything and gates load on posture', () => {
    const config = resolveConfig({ preset: 'hardened' })
    expect(config.input.mode).toBe('enforce')
    expect(config.tools.mode).toBe('enforce')
    expect(config.results.mode).toBe('enforce')
    expect(config.approval.mode).toBe('policy')
    expect(config.posture.failOn).toEqual([
      'sandbox_danger_full_access',
      'approval_never',
      'hmr_enabled',
      // §7 row 10: a hardened deployment must refuse the load on a host version mismatch.
      'plugin_version_mismatch',
    ])
  })

  it('an explicit field beats the preset', () => {
    const config = resolveConfig({ preset: 'balanced', input: { mode: 'warn' } })
    expect(config.input.mode).toBe('warn')
    // untouched siblings still come from the preset
    expect(config.tools.mode).toBe('enforce')
  })

  it('a preset field beats the base default (observe must not inherit enforce)', () => {
    const config = resolveConfig({ preset: 'observe', tools: {} })
    expect(config.tools.mode).toBe('warn')
  })

  it('keeps unrelated base defaults stable across presets', () => {
    for (const preset of ['observe', 'balanced', 'hardened'] as const) {
      const config = resolveConfig({ preset })
      expect(config.input.maxChars).toBe(60000)
      expect(config.tools.maxArgsBytes).toBe(65536)
      expect(config.audit.rotateMb).toBe(64)
      expect(config.output.judge.timeoutMs).toBe(4000)
      expect(config.patrol.windowMinutes).toBe(10)
    }
  })

  it('resolves the documented balanced defaults for every documented field', () => {
    const config = resolveConfig({ preset: 'balanced' })
    expect(config.rules).toEqual({ dir: '', watch: true, inline: [] })
    expect(config.results.blockOn).toEqual(['credential_leak'])
    expect(config.output.judge).toEqual({ enabled: false, scope: 'flagged', provider: '', model: '', maxChars: 12000, timeoutMs: 4000 })
    // M3 buffers (T3.2): both caps are present so a deployment can tune them.
    expect(config.output.bufferTimeoutMs).toBe(15000)
    expect(config.output.bufferMaxChars).toBe(512000)
    expect(config.audit).toEqual({
      format: 'ndjson',
      dir: '',
      redact: true,
      hashChain: true,
      required: true,
      rotateMb: 64,
    })
    expect(config.posture.onLoad).toBe(true)
    expect(config.patrol.feishuWebhook).toBe('')
    expect(config.budget.maxTokensPerTurn).toBe(0)
  })

  it('freezes the resolved config', () => {
    const config = resolveConfig({})
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.tools)).toBe(true)
    expect(Object.isFrozen(config.tools.denyTools)).toBe(true)
  })
})

describe('resolveConfig — validation', () => {
  it('rejects an unknown preset', () => {
    expect(() => resolveConfig({ preset: 'paranoid' as never })).toThrow(ConfigError)
  })

  it('rejects an unknown mode', () => {
    expect(() => resolveConfig({ input: { mode: 'block' as never } })).toThrow(/input\.mode/u)
  })

  it('rejects a non-positive bound', () => {
    expect(() => resolveConfig({ input: { maxChars: 0 } })).toThrow(/input\.maxChars/u)
    expect(() => resolveConfig({ tools: { maxArgsBytes: -1 } })).toThrow(/tools\.maxArgsBytes/u)
  })

  it('reports every problem at once', () => {
    try {
      resolveConfig({ preset: 'nope' as never, input: { mode: 'nope' as never }, audit: { rotateMb: 0 } })
      throw new Error('expected a ConfigError')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      const problems = (error as ConfigError).problems
      expect(problems.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('rejects a malformed tag override', () => {
    expect(() => resolveConfig({ tools: { tagOverrides: [{ pattern: 'x' } as never] } })).toThrow(/tagOverrides/u)
  })

  it('requires a judge provider and model under hardened', () => {
    expect(() => resolveConfig({ preset: 'hardened', output: { judge: { enabled: true } } })).toThrow(/judge/u)
    // …but not under balanced, where the judge degrades instead.
    expect(() => resolveConfig({ preset: 'balanced', output: { judge: { enabled: true } } })).not.toThrow()
  })
})
