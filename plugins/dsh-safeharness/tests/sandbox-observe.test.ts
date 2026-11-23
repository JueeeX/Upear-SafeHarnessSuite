/**
 * Sandbox observation across sessions (the P0 fix).
 *
 * The bug this file pins: `ctx.sandboxPolicy.resolve()` without a session returns
 * the deployment default, while DSH resolves the file-sandbox mode **per
 * session** — a session's own `sandbox/mode` event outranks that default. Posture
 * asked only the session-less question, so a deployment whose default is
 * `workspace-write` while a live conversation runs at `danger-full-access`
 * reported `sandbox: OK`, and `hardened`'s `sandbox_danger_full_access` gate
 * could never fire. A security check that says "confined" about an unrestricted
 * machine is worse than no check: it is a false assurance.
 *
 * Three properties are asserted here:
 *  1. a session that resolves wider than the default makes the deployment report
 *     the wider mode (the deployment answer is the weakest link);
 *  2. an unreadable session is never a clean pass — unknown is WARN/FAIL, not OK;
 *  3. the mode is resolved once per session (the resolver folds the whole event
 *     log, so per-event resolution would be quadratic), and a later
 *     `sandbox/mode` event still updates it.
 * @module
 */
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { apply, __matchingHostSurfaceForTests, __setHostSurfaceProbeForTests } from '../src/index.js'
import { createFakeHost } from './helpers/fake-host.js'
import { resolveSandboxMode, observeSandbox } from '../src/hooks/sandbox.js'
import { createRuntime } from '../src/runtime.js'
import { createEngine } from '../src/engine/index.js'
import { loadRuleSet } from '../src/engine/rules.js'
import { createLedger } from '../src/audit/ledger.js'
import { resolveConfig } from '../src/config.js'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A temp ledger directory (never inside the repo). */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'safeharness-sandbox-'))
}

/** A session-shaped value with an id, the way DSH hands it to a seam. */
function session(id: string): { id: string } {
  return { id }
}

/**
 * A policy service that answers the way DSH does: the session-less call returns
 * the deployment default, a session call returns that session's own mode.
 */
function policyService(defaultMode: string | undefined, perSession: (id: string) => string | undefined) {
  return {
    resolve(request?: { session?: { id?: string } }) {
      const id = request?.session?.id
      if (id === undefined) return defaultMode === undefined ? undefined : { mode: defaultMode }
      const mode = perSession(id)
      return mode === undefined ? undefined : { mode }
    },
  }
}

/** Build a runtime over an in-memory ledger, for the pure-function tests. */
function testRuntime() {
  const config = resolveConfig({ preset: 'balanced' })
  const ruleset = loadRuleSet({ packagedRulesDir: join(pluginRoot, 'rules') })
  return createRuntime({
    config,
    engine: createEngine(ruleset, config),
    ledger: createLedger({
      dir: tempDir(),
      format: 'ndjson',
      redact: true,
      hashChain: true,
      required: false,
      rotateMb: 64,
      pluginVersion: 'test',
      rulesetHash: ruleset.hash,
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
}

describe('sandbox observation', () => {
  it('never asks the resolver without a session when one is available', () => {
    // The old call was `resolve({})`: no session, so the answer was always the
    // deployment default. A session call must be forwarded as such.
    const seen: (string | undefined)[] = []
    const ctx = {
      get(name: string) {
        if (name !== 'sandboxPolicy') return undefined
        return {
          resolve(request?: { session?: { id?: string } }) {
            seen.push(request?.session?.id)
            return { mode: 'danger-full-access' }
          },
        }
      },
    }
    expect(resolveSandboxMode(ctx as never, session('s-1'))).toBe('danger-full-access')
    expect(seen).toEqual(['s-1'])
  })

  it('falls back to the deployment default only when no session is passed', () => {
    const ctx = {
      get() {
        return { resolve: () => ({ mode: 'read-only' }) }
      },
    }
    expect(resolveSandboxMode(ctx as never)).toBe('read-only')
  })

  it('treats a missing service and a throwing resolver as unknown, not as confined', () => {
    const absent = { get: () => undefined }
    expect(resolveSandboxMode(absent as never, session('s-1'))).toBeUndefined()

    const throwing = {
      get: () => ({
        resolve() {
          throw new Error('not composed yet')
        },
      }),
    }
    expect(resolveSandboxMode(throwing as never, session('s-1'))).toBeUndefined()
  })

  it('reports the widest mode across sessions, not the deployment default', () => {
    const runtime = testRuntime()
    runtime.state.recordSandboxMode('s-restricted', 'read-only')
    runtime.state.recordSandboxMode('s-default', 'workspace-write')
    const summary = runtime.state.sandboxSummary()
    expect(summary.mode).toBe('workspace-write')
    expect(summary.census['read-only']).toBe(1)
    expect(summary.census['workspace-write']).toBe(1)

    runtime.state.recordSandboxMode('s-open', 'danger-full-access')
    expect(runtime.state.sandboxSummary().mode).toBe('danger-full-access')
  })

  it('counts a probed-but-unreadable session separately from an unobserved one', () => {
    const runtime = testRuntime()
    // Unobserved: created by another seam, never probed.
    runtime.state.of('s-unobserved')
    // Probed and unreadable: this is the one that must block a clean pass.
    runtime.state.recordSandboxMode('s-unknown', undefined)
    const summary = runtime.state.sandboxSummary()
    expect(summary.unknown).toBe(1)
    expect(summary.mode).toBeUndefined()
  })

  it('never asks a session twice, but still records a later mode switch', async () => {
    const { observeSessionSandbox, recordSandboxSwitch } = await import('../src/hooks/sandbox.js')
    let calls = 0
    const ctx = {
      get() {
        return {
          resolve(request?: { session?: { id?: string } }) {
            calls += 1
            return { mode: request?.session === undefined ? 'workspace-write' : 'workspace-write' }
          },
        }
      },
    }
    const runtime = testRuntime()
    observeSessionSandbox(runtime, ctx as never, session('s-1'))
    observeSessionSandbox(runtime, ctx as never, session('s-1'))
    expect(calls).toBe(1)
    expect(runtime.state.knownSandboxMode('s-1')).toBe('workspace-write')

    // The host logs a switch; the event is the authority, so no resolver call.
    recordSandboxSwitch(runtime, session('s-1'), { type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
    expect(calls).toBe(1)
    expect(runtime.state.knownSandboxMode('s-1')).toBe('danger-full-access')
  })

  it('stops retrying a session whose first probe was unreadable', async () => {
    const { observeSessionSandbox } = await import('../src/hooks/sandbox.js')
    let calls = 0
    const ctx = { get: () => ({ resolve: () => { calls += 1; return undefined } }) }
    const runtime = testRuntime()
    observeSessionSandbox(runtime, ctx as never, session('s-1'))
    observeSessionSandbox(runtime, ctx as never, session('s-1'))
    expect(calls).toBe(1)
    expect(runtime.state.sandboxSummary().unknown).toBe(1)
  })

  it('builds the observation posture consumes from default ∪ sessions', () => {
    const runtime = testRuntime()
    runtime.state.recordSandboxMode('s-1', 'workspace-write')
    runtime.state.recordSandboxMode('s-2', 'danger-full-access')
    const ctx = {
      get: () => ({ resolve: () => ({ mode: 'workspace-write' }) }),
    }
    const observation = observeSandbox(ctx as never, runtime)
    expect(observation?.defaultMode).toBe('workspace-write')
    expect(observation?.sessionMode).toBe('danger-full-access')
    expect(observation?.observedSessions).toBe(2)
    expect(observation?.unknownSessions).toBe(0)
  })

  it('returns undefined (→ SKIP) when the profile composes no policy service', () => {
    const runtime = testRuntime()
    expect(observeSandbox({ get: () => undefined } as never, runtime)).toBeUndefined()
  })

  it('counts an unreadable deployment default as unknown once sessions exist', () => {
    // Every session reads fine, but the default — what a *new* session would get —
    // could not be read. That is an unknown, not a clean pass.
    const runtime = testRuntime()
    runtime.state.recordSandboxMode('s-1', 'workspace-write')
    const ctx = {
      get: () => ({
        resolve(request?: { session?: unknown }) {
          return request?.session === undefined ? undefined : { mode: 'workspace-write' }
        },
      }),
    }
    const observation = observeSandbox(ctx as never, runtime)
    expect(observation?.defaultMode).toBeUndefined()
    expect(observation?.observedSessions).toBe(1)
    expect(observation?.unknownSessions).toBe(1)
  })

  it('keeps an evicted session\'s mode as a floor instead of forgetting it', () => {
    // MAX_SESSIONS is 256; a session that ran one tool at danger-full-access and was
    // then pushed out of the LRU must not turn the deployment back into a clean pass.
    const runtime = testRuntime()
    runtime.state.recordSandboxMode('s-open', 'danger-full-access')
    for (let index = 0; index < 300; index += 1) {
      runtime.state.recordSandboxMode(`s-filler-${index}`, 'read-only')
    }
    const summary = runtime.state.sandboxSummary()
    expect(summary.mode).toBe('danger-full-access')
    expect(runtime.state.knownSandboxMode('s-open')).toBeUndefined()
  })

  it('keeps an evicted unreadable session counted as unknown', () => {
    const runtime = testRuntime()
    runtime.state.recordSandboxMode('s-blind', undefined)
    for (let index = 0; index < 300; index += 1) {
      runtime.state.recordSandboxMode(`s-filler-${index}`, 'read-only')
    }
    expect(runtime.state.sandboxSummary().unknown).toBe(1)
  })
})

describe('the end-to-end wiring: a dangerous session fails the deployment', () => {
  /** Load the plugin under a preset with a service whose sessions resolve wider. */
  async function loadWith(defaultMode: string, sessionMode: string) {
    const host = createFakeHost({
      config: { preset: 'hardened' },
      services: { sandboxPolicy: policyService(defaultMode, () => sessionMode) },
    })
    __setHostSurfaceProbeForTests(__matchingHostSurfaceForTests)
    const dir = tempDir()
    await apply(host.host.ctx as never, { preset: 'hardened', audit: { dir } })
    return { host: host.host, dir }
  }

  it('cannot refuse the load for a per-session mode it has not seen yet, and says so', async () => {
    // The gate runs before any seam is wired (on purpose: a refused load must leave
    // nothing registered), so at that moment there is no session to ask about. It
    // must therefore NOT report the deployment default as OK — that was the bug —
    // and the same check must turn the session's mode into a FAIL once one is seen.
    const { host, dir } = await loadWith('workspace-write', 'danger-full-access')
    const first = readFileSync(join(dir, 'ledger.ndjson'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record['kind'] === 'posture_report')
    expect(first?.['rule_ids']).toContain('sandbox_danger_full_access')
    const tool = host.tools.get('safeharness_posture')
    const execute = (tool!.definition as { execute: (args: unknown, ctx: unknown) => Promise<unknown> }).execute
    const beforeAnySession = await execute({}, {}) as { findings: { code: string; severity: string; detail: string }[] }
    const before = beforeAnySession.findings.find((item) => item.code === 'sandbox_danger_full_access')
    expect(before?.severity).toBe('SKIP')
    expect(before?.detail).toContain('no session has been observed')
  })

  it('reports the session mode in the posture detail, not just the default', async () => {
    const { host } = await loadWith('workspace-write', 'danger-full-access')
    // A turn arrives, so the session's own mode is resolved.
    host.emitSync('session/event', session('s-live'), { type: 'turn/start', seq: 1, time: Date.now() })
    const tool = host.tools.get('safeharness_posture')
    expect(tool).toBeDefined()
    const execute = (tool!.definition as { execute: (args: unknown, ctx: unknown) => Promise<unknown> }).execute
    const report = await execute({}, {}) as {
      findings: { code: string; severity: string; detail: string }[]
      summary: { fail: number }
    }
    const finding = report.findings.find((item) => item.code === 'sandbox_danger_full_access')
    expect(finding?.severity).toBe('FAIL')
    expect(finding?.detail).toContain('danger-full-access')
    expect(report.summary.fail).toBeGreaterThan(0)
  })

  it('keeps the deployment clean when every session matches the default', async () => {
    const { host } = await loadWith('workspace-write', 'workspace-write')
    host.emitSync('session/event', session('s-live'), { type: 'turn/start', seq: 1, time: Date.now() })
    const tool = host.tools.get('safeharness_posture')
    const execute = (tool!.definition as { execute: (args: unknown, ctx: unknown) => Promise<unknown> }).execute
    const report = await execute({}, {}) as { findings: { code: string; severity: string }[] }
    expect(report.findings.find((item) => item.code === 'sandbox_danger_full_access')?.severity).toBe('OK')
  })

  it('records the switch from the session event without asking the resolver again', async () => {
    const { host } = await loadWith('workspace-write', 'workspace-write')
    host.emitSync('session/event', session('s-live'), { type: 'turn/start', seq: 1, time: Date.now() })
    host.emitSync('session/event', session('s-live'), { type: 'sandbox/mode', seq: 2, time: Date.now(), data: { mode: 'danger-full-access' } })
    const tool = host.tools.get('safeharness_posture')
    const execute = (tool!.definition as { execute: (args: unknown, ctx: unknown) => Promise<unknown> }).execute
    const report = await execute({}, {}) as { findings: { code: string; severity: string }[] }
    expect(report.findings.find((item) => item.code === 'sandbox_danger_full_access')?.severity).toBe('FAIL')
  })

  it('keeps the ledger free of any workspace path or session content', async () => {
    const { host, dir } = await loadWith('workspace-write', 'danger-full-access')
    host.emitSync('session/event', session('s-live'), { type: 'turn/start', seq: 1, time: Date.now() })
    // Run the posture tool so the report carrying the session mode is recorded.
    const tool = host.tools.get('safeharness_posture')
    const execute = (tool!.definition as { execute: (args: unknown, ctx: unknown) => Promise<unknown> }).execute
    await execute({}, {})
    const records = readFileSync(join(dir, 'ledger.ndjson'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const reported = records.filter((record) => record['kind'] === 'posture_report')
    const posture = reported[reported.length - 1]
    // Codes only: the report names the finding, never a workspace path.
    expect(posture?.['rule_ids']).toContain('sandbox_danger_full_access')
    expect(JSON.stringify(posture)).not.toContain('F:\\')
  })
})
