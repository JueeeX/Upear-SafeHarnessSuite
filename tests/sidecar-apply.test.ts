/**
 * `apply()` with the optional Python engine (M5 T5.1, step 2).
 *
 * The composition root owns the load contract, so these tests assert it end to
 * end against the fake context: a healthy child loads and is reported by
 * `safeharness_status`, a dead child is a posture FAIL that hardened refuses,
 * and a refused load leaves nothing of ours active (R36).
 * @module
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { apply, __matchingHostSurfaceForTests, __setHostSurfaceProbeForTests } from '../src/index.js'
import { readLedger } from './helpers/fake-host.js'
import { createFakeHost } from './helpers/fake-host.js'

const FAKE = fileURLToPath(new URL('./helpers/fake-sidecar.mjs', import.meta.url))

let dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'safeharness-sidecar-apply-'))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  __setHostSurfaceProbeForTests(() => __matchingHostSurfaceForTests())
})

afterEach(() => {
  __setHostSurfaceProbeForTests(undefined)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

interface StatusValue {
  readonly engine?: { readonly kind: string; readonly status: string; readonly rulesStale: boolean }
}

/** Execute a registered read-only tool. */
async function runTool<T>(host: ReturnType<typeof createFakeHost>['host'], name: string): Promise<T> {
  const tool = host.tools.get(name)
  if (tool === undefined) throw new Error(`apply() did not register ${name}`)
  const execute = tool.definition['execute'] as (args: unknown, ctx: unknown) => Promise<T>
  return execute({}, {})
}

/** Engine config block shared by the tests. */
function engineConfig(args: string[] = [FAKE]): Record<string, unknown> {
  return { kind: 'sidecar', command: process.execPath, args, startTimeoutMs: 1500 }
}

describe('apply() with the sidecar engine', () => {
  it('loads, reports the engine in status, and stops the child on dispose', async () => {
    const { host } = createFakeHost({ config: { preset: 'balanced' } })
    await apply(host.ctx as never, {
      preset: 'balanced',
      engine: engineConfig(),
      audit: { dir: tempDir() },
    })
    const status = await runTool<StatusValue>(host, 'safeharness_status')
    expect(status.engine).toMatchObject({ kind: 'sidecar', status: 'ready', rulesStale: false })

    // The load record says which engine judged, so evidence is attributable.
    const records = await readLedger(runtimeOf(host))
    const loaded = records.find((record) => record.kind === 'plugin_loaded')
    expect((loaded?.labels as Record<string, unknown>)?.engine).toBe('sidecar')

    // Fiber disposal stops the child (no orphan Python process per reload).
    for (const dispose of host.disposers) await dispose?.()
  })

  it('hardened refuses to load when the configured sidecar is unusable, and leaves nothing active', async () => {
    const { host } = createFakeHost({ config: { preset: 'hardened' } })
    await expect(apply(host.ctx as never, {
      preset: 'hardened',
      engine: engineConfig([FAKE, '--mode', 'bad-health']),
      audit: { dir: tempDir() },
    })).rejects.toThrow(/engine_sidecar_unavailable/u)
    // R36: a refused gate must not leave hooks/tools/prompt behind.
    expect(host.listeners.size).toBe(0)
    expect(host.guards.length).toBe(0)
    expect(host.tools.size).toBe(0)
    expect(host.promptSections.length).toBe(0)
  })

  it('balanced loads with a dead sidecar and reports it as a posture FAIL', async () => {
    const { host } = createFakeHost({ config: { preset: 'balanced' } })
    await apply(host.ctx as never, {
      preset: 'balanced',
      engine: engineConfig([FAKE, '--mode', 'bad-health']),
      audit: { dir: tempDir() },
    })
    const status = await runTool<StatusValue>(host, 'safeharness_status')
    expect(status.engine).toMatchObject({ kind: 'sidecar', status: 'failed' })

    const posture = await runTool<{ findings: { code: string; severity: string }[] }>(host, 'safeharness_posture')
    const engine = posture.findings.find((item) => item.code === 'engine_sidecar_unavailable')
    expect(engine?.severity).toBe('FAIL')
    for (const dispose of host.disposers) await dispose?.()
  })
})

/** The runtime behind a fake host (recorded by `createFakeHost`). */
function runtimeOf(host: ReturnType<typeof createFakeHost>['host']): ReturnType<typeof createFakeHost>['runtime'] {
  const service = host.services.get('safeharness') as { handle: { runtime: ReturnType<typeof createFakeHost>['runtime'] } } | undefined
  if (service === undefined) throw new Error('safeharness service not provided')
  return service.handle.runtime
}
