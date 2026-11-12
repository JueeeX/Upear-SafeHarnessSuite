/**
 * 三档预设表（observe / balanced / hardened）—— 每个维度一个测试。
 *
 * The preset table (README, "预设") is a
 * *default-value combination*, expanded once inside `apply()` via `resolveConfig`.
 * These tests pin one dimension per row so a future preset edit cannot silently
 * move a cell (e.g. turn the factory default into `observe`), plus the two
 * structural promises the table makes: an explicit operator field always beats
 * the preset, and expansion is idempotent (nothing re-reads the preset table at
 * runtime).
 *
 * The last table row ("规则加载失败") is not a config value: it is the load-time
 * behaviour driven through `tryLoadRuleSet` and is proven row-by-row in
 * `tests/failure-matrix.test.ts` (§7 row 1).
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, resolveConfig } from '../src/config.js'
import type { PresetId, SafeHarnessConfig } from '../src/config.js'
import { installToolHooks } from '../src/hooks/tools.js'
import { TOOL_DENIAL_TEXT } from '../src/runtime.js'
import { createFakeHost } from './helpers/fake-host.js'

/** The three presets in the order the plan lists them. */
const PRESETS: readonly PresetId[] = ['observe', 'balanced', 'hardened']

/** One tool execution view, as the fake host hands it to pre-execute/guard. */
function toolExecution(name: string, args: unknown, sessionId = 'sess-preset'): Record<string, unknown> {
  return { callId: `call-${name}`, name, arguments: args, agent: { id: sessionId, session: { id: sessionId } } }
}

describe('§5.3 preset table — one dimension per test', () => {
  it('§5.3 输入 (input.mode): observe=warn, balanced=enforce, hardened=enforce', () => {
    expect(resolveConfig({ preset: 'observe' }).input.mode).toBe('warn')
    expect(resolveConfig({ preset: 'balanced' }).input.mode).toBe('enforce')
    expect(resolveConfig({ preset: 'hardened' }).input.mode).toBe('enforce')
  })

  it('§5.3 工具 pre-execute (tools.mode): observe=warn, balanced=enforce, hardened=enforce', () => {
    expect(resolveConfig({ preset: 'observe' }).tools.mode).toBe('warn')
    expect(resolveConfig({ preset: 'balanced' }).tools.mode).toBe('enforce')
    expect(resolveConfig({ preset: 'hardened' }).tools.mode).toBe('enforce')
  })

  it('§5.3 同步 guard: observe is a no-op; balanced/hardened deny a hard name rule', () => {
    // The sync guard has no mode of its own: it is live exactly when `tools.mode`
    // enforces. That is what makes the table cell "空转 / deny / deny" true.
    const expected: Record<PresetId, string | undefined> = {
      observe: undefined,
      balanced: TOOL_DENIAL_TEXT,
      hardened: TOOL_DENIAL_TEXT,
    }
    for (const preset of PRESETS) {
      const { host, runtime } = createFakeHost({ config: { preset, tools: { denyTools: ['bash'] } } })
      installToolHooks(host.ctx as never, runtime)
      expect(host.guards).toHaveLength(1)
      expect(host.guards[0]?.(toolExecution('bash', { command: 'echo hi' }))).toBe(expected[preset])
    }
  })

  it('§5.3 工具结果 (results.mode + blockOn): observe warn/[], balanced warn/[credential_leak], hardened enforce/[credential_leak, injection_marker]', () => {
    expect(resolveConfig({ preset: 'observe' }).results).toEqual({ mode: 'warn', blockOn: [] })
    expect(resolveConfig({ preset: 'balanced' }).results).toEqual({ mode: 'warn', blockOn: ['credential_leak'] })
    expect(resolveConfig({ preset: 'hardened' }).results).toEqual({
      mode: 'enforce',
      blockOn: ['credential_leak', 'injection_marker'],
    })
  })

  it('§5.3 输出 (output.mode): warn on every preset; enforce-buffer is opt-in only', () => {
    for (const preset of PRESETS) {
      expect(resolveConfig({ preset }).output.mode).toBe('warn')
    }
    // The table says "warn / warn / enforce-buffer（opt-in 后）": the mode exists,
    // but no preset turns it on.
    for (const preset of PRESETS) {
      expect(resolveConfig({ preset, output: { mode: 'enforce-buffer' } }).output.mode).toBe('enforce-buffer')
    }
  })

  it('§5.3 审批桥 (approval.mode): observe=delegate, balanced=delegate, hardened=policy', () => {
    expect(resolveConfig({ preset: 'observe' }).approval.mode).toBe('delegate')
    expect(resolveConfig({ preset: 'balanced' }).approval.mode).toBe('delegate')
    expect(resolveConfig({ preset: 'hardened' }).approval.mode).toBe('policy')
    for (const preset of PRESETS) {
      expect(resolveConfig({ preset }).approval.allowOnce).toEqual([])
    }
  })

  it('§5.3 审计 required: observe=false, balanced=true, hardened=true', () => {
    expect(resolveConfig({ preset: 'observe' }).audit.required).toBe(false)
    expect(resolveConfig({ preset: 'balanced' }).audit.required).toBe(true)
    expect(resolveConfig({ preset: 'hardened' }).audit.required).toBe(true)
    // required is the only cell the preset moves: redaction and the hash chain
    // are always on (a non-chained ledger is not evidence).
    for (const preset of PRESETS) {
      expect(resolveConfig({ preset }).audit.redact).toBe(true)
      expect(resolveConfig({ preset }).audit.hashChain).toBe(true)
      expect(resolveConfig({ preset }).audit.format).toBe('ndjson')
    }
  })

  it('§5.3 姿态 failOn: observe=[], balanced=[] (report only), hardened=gated codes', () => {
    expect(resolveConfig({ preset: 'observe' }).posture.failOn).toEqual([])
    expect(resolveConfig({ preset: 'balanced' }).posture.failOn).toEqual([])
    expect(resolveConfig({ preset: 'hardened' }).posture.failOn).toEqual([
      'sandbox_danger_full_access',
      'approval_never',
      'hmr_enabled',
      // §7 row 10: hardened must refuse the load on a host version mismatch, and
      // the gate is `posture.failOn` — so the code belongs in this list even
      // though §5.3's table only named the three deployment-posture codes.
      'plugin_version_mismatch',
      // 1.2.0: an explicitly configured Python engine must be running.
      'engine_sidecar_unavailable',
    ])
  })

  it('§5.3 输出 judge: the judge requirement is fatal only under hardened', () => {
    // The output row of the table is satisfied by a judge that degrades under
    // balanced/observe, but hardened declares the judge a requirement.
    expect(() => resolveConfig({ preset: 'hardened', output: { judge: { enabled: true } } })).toThrow(ConfigError)
    expect(() => resolveConfig({ preset: 'balanced', output: { judge: { enabled: true } } })).not.toThrow()
    expect(() => resolveConfig({ preset: 'observe', output: { judge: { enabled: true } } })).not.toThrow()
  })
})

describe('§5.3 preset mechanics — overrides, default and idempotency', () => {
  it('§5.3 an explicit field overrides the preset on every dimension', () => {
    const loosened = resolveConfig({
      preset: 'hardened',
      input: { mode: 'warn' },
      tools: { mode: 'warn' },
      results: { mode: 'warn', blockOn: [] },
      output: { mode: 'off' },
      approval: { mode: 'delegate' },
      audit: { required: false },
      posture: { failOn: [] },
    })
    expect(loosened.input.mode).toBe('warn')
    expect(loosened.tools.mode).toBe('warn')
    expect(loosened.results).toEqual({ mode: 'warn', blockOn: [] })
    expect(loosened.output.mode).toBe('off')
    expect(loosened.approval.mode).toBe('delegate')
    expect(loosened.audit.required).toBe(false)
    expect(loosened.posture.failOn).toEqual([])
    // Fields the override did not name still come from the preset/default layer.
    expect(loosened.preset).toBe('hardened')
    expect(loosened.tools.trajectory).toBe(true)
    expect(loosened.audit.redact).toBe(true)

    // …and a loosened observe deployment can be tightened the same way.
    const tightened = resolveConfig({ preset: 'observe', input: { mode: 'enforce' }, audit: { required: true } })
    expect(tightened.input.mode).toBe('enforce')
    expect(tightened.audit.required).toBe(true)
    expect(tightened.tools.mode).toBe('warn')
  })

  it('§5.3 no `preset` field means the factory default `balanced`, never `observe`', () => {
    const config = resolveConfig({})
    expect(config.preset).toBe('balanced')
    expect(config).toEqual(resolveConfig({ preset: 'balanced' }))
  })

  it('§5.3 preset expansion is idempotent: a resolved config re-resolves to itself', () => {
    // "预设展开发生在 apply 内，不要在运行时再读预设表" — the proof at this layer is
    // that expansion consumes its own output unchanged (no oscillation, no
    // second-pass default creeping in).
    for (const preset of PRESETS) {
      const first = resolveConfig({ preset })
      const second = resolveConfig(first as unknown as SafeHarnessConfig)
      expect(second).toEqual(first)
      expect(Object.isFrozen(second)).toBe(true)
    }
  })
})
