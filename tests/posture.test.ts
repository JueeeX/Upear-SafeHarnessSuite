/**
 * Posture checks: three-state behaviour per check and the hardened gate.
 * These are pure functions, so every branch is cheap to exercise.
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { failOnHits, runPostureChecks, summarize } from '../src/posture/checks.js'
import type { PostureEnv } from '../src/engine/types.js'

/** A healthy environment: everything observable and clean. */
function healthyEnv(): PostureEnv {
  return {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'ask',
    hmrEnabled: false,
    versionMismatch: [],
    engine: { kind: 'builtin', status: 'ready' },
    rules: { loaded: true, hash: 'a'.repeat(64), ruleCount: 20 },
    ledger: { writable: true, chainOk: true, lastWriteAt: Date.now() },
  }
}

/** Find one finding by code. */
function find(env: PostureEnv, preset: 'observe' | 'balanced' | 'hardened', code: string) {
  const findings = runPostureChecks(resolveConfig({ preset }), env)
  return findings.find((item) => item.code === code)
}

describe('runPostureChecks', () => {
  it('reports a fully healthy environment as clean', () => {
    const findings = runPostureChecks(resolveConfig({ preset: 'balanced' }), healthyEnv())
    const summary = summarize(findings)
    expect(summary.fail).toBe(0)
    expect(summary.warn).toBe(0)
    expect(summary.clean).toBe(true)
  })

  it('emits every documented code exactly once, in order', () => {
    const findings = runPostureChecks(resolveConfig({ preset: 'balanced' }), healthyEnv())
    expect(findings.map((item) => item.code)).toEqual([
      'sandbox_danger_full_access',
      'approval_never',
      'hmr_enabled',
      'rules_loaded',
      'ledger_writable',
      'ledger_chain_ok',
      'output_guard_off',
      'judge_unavailable',
      'plugin_version_mismatch',
      'engine_sidecar_unavailable',
    ])
  })

  it('danger-full-access is WARN in balanced and FAIL in hardened', () => {
    const env = { ...healthyEnv(), sandboxMode: 'danger-full-access' as const }
    expect(find(env, 'balanced', 'sandbox_danger_full_access')?.severity).toBe('WARN')
    expect(find(env, 'hardened', 'sandbox_danger_full_access')?.severity).toBe('FAIL')
  })

  it('an unknown sandbox mode is SKIP, never OK', () => {
    const env: PostureEnv = { ...healthyEnv(), sandboxMode: undefined }
    expect(find(env, 'balanced', 'sandbox_danger_full_access')?.severity).toBe('SKIP')
  })

  it('approval=never is WARN while delegating and FAIL when hardened still delegates', () => {
    const env = { ...healthyEnv(), approvalPolicy: 'never' as const }
    // balanced delegates: `never` means no human gate exists at all → WARN.
    expect(find(env, 'balanced', 'approval_never')?.severity).toBe('WARN')
    // hardened turns the bridge into a policy engine, so `never` is compensated → OK.
    expect(find(env, 'hardened', 'approval_never')?.severity).toBe('OK')
    // …unless the operator put hardened back on delegation: then it is fatal.
    const hardDelegating = runPostureChecks(
      resolveConfig({ preset: 'hardened', approval: { mode: 'delegate' } }),
      env,
    )
    expect(hardDelegating.find((item) => item.code === 'approval_never')?.severity).toBe('FAIL')
  })

  it('an unresolvable approval policy is SKIP', () => {
    const env: PostureEnv = { ...healthyEnv(), approvalPolicy: undefined }
    expect(find(env, 'balanced', 'approval_never')?.severity).toBe('SKIP')
  })

  it('HMR is only a WARN under hardened', () => {
    const env = { ...healthyEnv(), hmrEnabled: true }
    expect(find(env, 'balanced', 'hmr_enabled')?.severity).toBe('OK')
    expect(find(env, 'hardened', 'hmr_enabled')?.severity).toBe('WARN')
  })

  it('missing or unloaded rules are a FAIL on every preset', () => {
    const env: PostureEnv = { ...healthyEnv(), rules: undefined }
    for (const preset of ['observe', 'balanced', 'hardened'] as const) {
      expect(find(env, preset, 'rules_loaded')?.severity).toBe('FAIL')
    }
  })

  it('an unwritable ledger is a FAIL and a stale ledger a WARN', () => {
    const unwritable: PostureEnv = { ...healthyEnv(), ledger: { writable: false, chainOk: true } }
    expect(find(unwritable, 'balanced', 'ledger_writable')?.severity).toBe('FAIL')
    const stale: PostureEnv = {
      ...healthyEnv(),
      ledger: { writable: true, chainOk: true, lastWriteAt: Date.now() - 25 * 3600 * 1000 },
    }
    expect(find(stale, 'balanced', 'ledger_writable')?.severity).toBe('WARN')
  })

  it('a broken hash chain is WARN in balanced and FAIL in hardened', () => {
    const env: PostureEnv = { ...healthyEnv(), ledger: { writable: true, chainOk: false } }
    expect(find(env, 'balanced', 'ledger_chain_ok')?.severity).toBe('WARN')
    expect(find(env, 'hardened', 'ledger_chain_ok')?.severity).toBe('FAIL')
  })

  it('a hardened deployment with the output guard off is a FAIL', () => {
    const hardened = runPostureChecks(resolveConfig({ preset: 'hardened', output: { mode: 'off' } }), healthyEnv())
    expect(hardened.find((item) => item.code === 'output_guard_off')?.severity).toBe('FAIL')
    const balanced = runPostureChecks(resolveConfig({ preset: 'balanced', output: { mode: 'off' } }), healthyEnv())
    expect(balanced.find((item) => item.code === 'output_guard_off')?.severity).toBe('OK')
  })

  it('an enabled judge with no provider/model is WARN/FAIL', () => {
    const env = healthyEnv()
    const balanced = runPostureChecks(resolveConfig({ preset: 'balanced', output: { judge: { enabled: true } } }), env)
    expect(balanced.find((item) => item.code === 'judge_unavailable')?.severity).toBe('WARN')
  })

  it('a host version mismatch is WARN in balanced and FAIL in hardened', () => {
    const env: PostureEnv = { ...healthyEnv(), versionMismatch: ['dsh-tools 1 != 2'] }
    expect(find(env, 'balanced', 'plugin_version_mismatch')?.severity).toBe('WARN')
    expect(find(env, 'hardened', 'plugin_version_mismatch')?.severity).toBe('FAIL')
  })

  it('the built-in engine is OK and an unprobed engine is SKIP, never OK', () => {
    expect(find(healthyEnv(), 'balanced', 'engine_sidecar_unavailable')?.severity).toBe('OK')
    const unprobed: PostureEnv = { ...healthyEnv(), engine: undefined }
    expect(find(unprobed, 'balanced', 'engine_sidecar_unavailable')?.severity).toBe('SKIP')
  })

  it('a configured sidecar that is not ready (or has stale rules) is a FAIL', () => {
    for (const env of [
      { ...healthyEnv(), engine: { kind: 'sidecar' as const, status: 'failed' as const } },
      { ...healthyEnv(), engine: { kind: 'sidecar' as const, status: 'idle' as const } },
      { ...healthyEnv(), engine: { kind: 'sidecar' as const, status: 'ready' as const, rulesStale: true } },
    ]) {
      expect(find(env, 'balanced', 'engine_sidecar_unavailable')?.severity).toBe('FAIL')
    }
    const ready = { ...healthyEnv(), engine: { kind: 'sidecar' as const, status: 'ready' as const } }
    expect(find(ready, 'balanced', 'engine_sidecar_unavailable')?.severity).toBe('OK')
  })

  it('the engine gate is part of the hardened failOn list and only fires on FAIL', () => {
    const config = resolveConfig({ preset: 'hardened' })
    const down: PostureEnv = { ...healthyEnv(), engine: { kind: 'sidecar', status: 'failed' } }
    expect(failOnHits(config, runPostureChecks(config, down))).toContain('engine_sidecar_unavailable')
    // Built-in deployments are unaffected by the new gate code.
    const builtin: PostureEnv = { ...healthyEnv(), engine: { kind: 'builtin', status: 'ready' } }
    expect(failOnHits(config, runPostureChecks(config, builtin))).toEqual([])
  })

  it('never exposes a secret-looking value in a detail string', () => {
    const env: PostureEnv = { ...healthyEnv(), versionMismatch: ['dsh-tools 1 != 2'] }
    const findings = runPostureChecks(resolveConfig({ preset: 'hardened' }), env)
    for (const item of findings) {
      expect(item.detail).not.toMatch(/sk-[A-Za-z0-9]{8,}/u)
      expect(item.detail).not.toMatch(/Bearer\s/u)
    }
  })
})

describe('failOnHits', () => {
  it('returns only codes that actually FAILed', () => {
    const config = resolveConfig({ preset: 'hardened' })
    const env: PostureEnv = { ...healthyEnv(), sandboxMode: 'danger-full-access', hmrEnabled: true }
    const findings = runPostureChecks(config, env)
    // hmr is WARN under hardened (not FAIL), so only the sandbox gate fires.
    expect(failOnHits(config, findings)).toEqual(['sandbox_danger_full_access'])
  })

  it('balanced has no gates by default', () => {
    const config = resolveConfig({ preset: 'balanced' })
    const env: PostureEnv = { ...healthyEnv(), sandboxMode: 'danger-full-access' }
    expect(failOnHits(config, runPostureChecks(config, env))).toEqual([])
  })
})
