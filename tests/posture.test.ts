/**
 * Posture checks: three-state behaviour per check and the hardened gate.
 * These are pure functions, so every branch is cheap to exercise.
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { failOnHits, runPostureChecks, summarize } from '../src/posture/checks.js'
import type { PostureEnv } from '../src/engine/types.js'

/**
 * What posture sees for the sandbox: the deployment default plus the modes the
 * sessions this process observed actually resolved to.
 */
function sandboxOf(
  defaultMode: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined,
  sessionMode?: 'read-only' | 'workspace-write' | 'danger-full-access',
  extra?: { unknownSessions?: number; census?: Partial<Record<'read-only' | 'workspace-write' | 'danger-full-access', number>> },
) {
  const census = { 'read-only': 0, 'workspace-write': 0, 'danger-full-access': 0, ...extra?.census }
  if (sessionMode !== undefined) census[sessionMode] += 1
  return {
    defaultMode,
    sessionMode,
    observedSessions: census['read-only'] + census['workspace-write'] + census['danger-full-access'],
    unknownSessions: extra?.unknownSessions ?? 0,
    census,
  }
}

/** A healthy environment: everything observable and clean. */
function healthyEnv(): PostureEnv {
  return {
    // One observed session matching the default: OK is only reachable once a
    // session was actually resolved (a default on its own is SKIP, see §5.2).
    sandbox: sandboxOf('workspace-write', 'workspace-write'),
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
      'arg_schema_invalid',
    ])
  })

  it('reports a dropped argument schema as WARN, never as a clean pass', () => {
    const broken = resolveConfig({
      preset: 'balanced',
      tools: {
        argSchemas: [
          // `regex` is not a keyword this loader accepts: the declaration is dropped.
          { name: 'fs_write_path', tool: 'fs_write*', args: { path: { regex: '^/workspace/.+' } } },
        ],
      } as never,
    })
    // The declaration itself is out of the type system's reach (it came from YAML),
    // so the refusal has to come from the compiler, not from TypeScript.
    expect(broken.argSchemaProblems.length).toBe(1)
    expect(broken.tools.argSchemas).toEqual([])
    const finding = runPostureChecks(broken, healthyEnv()).find((item) => item.code === 'arg_schema_invalid')
    expect(finding?.severity).toBe('WARN')
    // The message counts entries; it must not quote the mistyped key back verbatim
    // beyond naming it (that is operator-authored config, never model input).
    expect(finding?.detail).toContain('1 tools.argSchemas entry')
  })

  it('reports OK when every declared argument schema compiled', () => {
    const good = resolveConfig({
      preset: 'balanced',
      tools: {
        argSchemas: [
          { name: 'fs_write_path', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } },
        ],
      } as never,
    })
    expect(good.argSchemaProblems).toEqual([])
    expect(good.tools.argSchemas).toHaveLength(1)
    const finding = runPostureChecks(good, healthyEnv()).find((item) => item.code === 'arg_schema_invalid')
    expect(finding?.severity).toBe('OK')
  })

  it('danger-full-access is WARN in balanced and FAIL in hardened', () => {
    const env = { ...healthyEnv(), sandbox: sandboxOf('danger-full-access') }
    expect(find(env, 'balanced', 'sandbox_danger_full_access')?.severity).toBe('WARN')
    expect(find(env, 'hardened', 'sandbox_danger_full_access')?.severity).toBe('FAIL')
  })

  it('a dangerous SESSION mode outranks a clean deployment default', () => {
    // The regression this file exists for: the deployment default is
    // `workspace-write`, but a live session resolved to `danger-full-access`.
    // Asking `resolve()` without a session used to report the default and call
    // the deployment clean while an unrestricted conversation was running.
    const env = { ...healthyEnv(), sandbox: sandboxOf('workspace-write', 'danger-full-access') }
    const balanced = find(env, 'balanced', 'sandbox_danger_full_access')
    expect(balanced?.severity).toBe('WARN')
    expect(balanced?.detail).toContain('danger-full-access')
    // …and it gates hardened exactly like a dangerous default would.
    expect(find(env, 'hardened', 'sandbox_danger_full_access')?.severity).toBe('FAIL')
    expect(failOnHits(resolveConfig({ preset: 'hardened' }), runPostureChecks(resolveConfig({ preset: 'hardened' }), env)))
      .toContain('sandbox_danger_full_access')
  })

  it('an unreadable session mode is never a clean pass', () => {
    // A composed service that could not resolve one session is evidence of
    // nothing: those sessions may be running unrestricted.
    const env = { ...healthyEnv(), sandbox: sandboxOf('workspace-write', undefined, { unknownSessions: 2 }) }
    const balanced = find(env, 'balanced', 'sandbox_danger_full_access')
    expect(balanced?.severity).toBe('WARN')
    expect(balanced?.detail).toContain('unverified')
    expect(find(env, 'hardened', 'sandbox_danger_full_access')?.severity).toBe('FAIL')
  })

  it('an unknown sandbox mode is SKIP, never OK', () => {
    const env: PostureEnv = { ...healthyEnv(), sandbox: undefined }
    expect(find(env, 'balanced', 'sandbox_danger_full_access')?.severity).toBe('SKIP')
  })

  it('a composed service that resolved nothing is SKIP, never OK', () => {
    const env: PostureEnv = { ...healthyEnv(), sandbox: sandboxOf(undefined) }
    const finding = find(env, 'balanced', 'sandbox_danger_full_access')
    expect(finding?.severity).toBe('SKIP')
    expect(finding?.detail).toContain('never resolved')
  })

  it('the deployment default alone is SKIP, never OK', () => {
    // The load-time gate runs before any seam is wired, so it can only see the
    // default. That is not evidence about the sessions which will run under it —
    // reporting OK there is the same false assurance the per-session fix removed.
    const env: PostureEnv = { ...healthyEnv(), sandbox: sandboxOf('workspace-write') }
    const finding = find(env, 'balanced', 'sandbox_danger_full_access')
    expect(finding?.severity).toBe('SKIP')
    expect(finding?.detail).toContain('workspace-write')
    expect(finding?.detail).toContain('no session has been observed')
    // …and a default is not enough to gate hardened either.
    expect(failOnHits(resolveConfig({ preset: 'hardened' }), runPostureChecks(resolveConfig({ preset: 'hardened' }), env)))
      .toEqual([])
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

  it('HMR is fatal under hardened (the preset gates it) and informational elsewhere', () => {
    const env = { ...healthyEnv(), hmrEnabled: true }
    expect(find(env, 'balanced', 'hmr_enabled')?.severity).toBe('OK')
    expect(find(env, 'hardened', 'hmr_enabled')?.severity).toBe('FAIL')
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
    const env: PostureEnv = { ...healthyEnv(), sandbox: sandboxOf('danger-full-access') }
    const findings = runPostureChecks(config, env)
    // HMR is off in a healthy env, so only the sandbox gate fires.
    expect(failOnHits(config, findings)).toEqual(['sandbox_danger_full_access'])
  })

  it('gates HMR under hardened only', () => {
    const config = resolveConfig({ preset: 'hardened' })
    const findings = runPostureChecks(config, { ...healthyEnv(), hmrEnabled: true })
    expect(failOnHits(config, findings)).toEqual(['hmr_enabled'])
  })

  it('balanced has no gates by default', () => {
    const config = resolveConfig({ preset: 'balanced' })
    const env: PostureEnv = { ...healthyEnv(), sandbox: sandboxOf('danger-full-access') }
    expect(failOnHits(config, runPostureChecks(config, env))).toEqual([])
  })
})
