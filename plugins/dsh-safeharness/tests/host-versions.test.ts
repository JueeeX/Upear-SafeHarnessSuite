/**
 * Host-version gate across DSH releases (1.14.1).
 *
 * DSH desktop updates land on the user's schedule, so one plugin release has to
 * keep working on the host it shipped with. The gate accepts the pinned version
 * plus every previously verified one, and refuses anything unmeasured under
 * `hardened` (the code is in `posture.failOn`). These tests drive the real
 * `apply()` gate rather than the posture helper, because the refusal path is the
 * behaviour that broke when the desktop moved 0.2.2-rc.3 → 0.2.2-rc.5.
 * @module
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  apply,
  PINNED_VERSIONS,
  __setHostSurfaceProbeForTests,
  type HostSurfaceEntry,
} from '../src/index.js'
import { createFakeHost } from './helpers/fake-host.js'

/** What the pinned table holds for every `@deepseek-ai/dsh-*` package. */
const PINNED_HOST = PINNED_VERSIONS['@deepseek-ai/dsh-tools'] as string
/** The release 1.14.0 shipped against; still accepted by 1.14.1. */
const VERIFIED_OLD = '0.2.2-rc.3'
/** A release never measured against this build. */
const UNVERIFIED = '0.2.2-rc.4'

let dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'safeharness-host-versions-'))
  dirs.push(dir)
  return dir
}

beforeEach(() => {
  // Every test states its own surface; a leaked override would hide the gate.
  __setHostSurfaceProbeForTests(undefined)
})

afterEach(() => {
  __setHostSurfaceProbeForTests(undefined)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

/**
 * A surface that matches the pins except for the `@deepseek-ai/dsh-*` packages,
 * which are moved to `dshVersion` together — the way a desktop update moves them.
 */
function surfaceAt(dshVersion: string): Record<string, HostSurfaceEntry> {
  const surface: Record<string, HostSurfaceEntry> = {}
  for (const [packageName, version] of Object.entries(PINNED_VERSIONS)) {
    const moved = packageName.startsWith('@deepseek-ai/dsh-')
    surface[packageName] = { version: moved ? dshVersion : version, origin: 'app-bundle' }
  }
  return surface
}

/** Ledger records written by one `apply()` into `dir`. */
function ledgerOf(dir: string): Record<string, unknown>[] {
  return readFileSync(join(dir, 'ledger.ndjson'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** The posture report as the ledger records it. */
function postureRecord(dir: string): Record<string, unknown> | undefined {
  return ledgerOf(dir).find((record) => record['kind'] === 'posture_report')
}

/** Load under `preset` with the given host surface. */
async function load(
  preset: 'balanced' | 'hardened',
  dshVersion: string,
): Promise<{ dir: string; host: ReturnType<typeof createFakeHost>['host'] }> {
  const { host } = createFakeHost({ config: { preset } })
  const dir = tempDir()
  __setHostSurfaceProbeForTests(() => surfaceAt(dshVersion))
  await apply(host.ctx as never, { preset, audit: { dir } })
  return { dir, host }
}

/** Call a registered read-only tool after a successful load. */
async function runTool<T>(host: ReturnType<typeof createFakeHost>['host'], name: string): Promise<T> {
  const tool = host.tools.get(name)
  if (tool === undefined) throw new Error(`apply() did not register ${name}`)
  const execute = tool.definition['execute'] as (args: unknown, ctx: unknown) => Promise<T>
  return execute({}, {})
}

describe('host version gate', () => {
  it('loads under hardened on the pinned host', async () => {
    const { dir, host } = await load('hardened', PINNED_HOST)
    expect(postureRecord(dir)?.['decision']).toBe('ok')
    expect(postureRecord(dir)?.['rule_ids'] ?? []).not.toContain('plugin_version_mismatch')
    for (const dispose of host.disposers) await dispose?.()
  })

  it('keeps the host it shipped with: rc.3 still loads under hardened', async () => {
    // 1.14.0 was measured on rc.3; dropping it here would break every operator
    // who has not taken the desktop update yet.
    const { dir, host } = await load('hardened', VERIFIED_OLD)
    expect(postureRecord(dir)?.['decision']).toBe('ok')
    for (const dispose of host.disposers) await dispose?.()
  })

  it('refuses an unmeasured host under hardened', async () => {
    const { host } = createFakeHost({ config: { preset: 'hardened' } })
    const dir = tempDir()
    __setHostSurfaceProbeForTests(() => surfaceAt(UNVERIFIED))
    await expect(apply(host.ctx as never, { preset: 'hardened', audit: { dir } }))
      .rejects.toThrow(/plugin_version_mismatch/u)
    expect(postureRecord(dir)?.['decision']).toBe('fail')
    expect(postureRecord(dir)?.['rule_ids']).toContain('plugin_version_mismatch')
    // Refusal is total: nothing of ours stays wired.
    expect(host.listeners.size).toBe(0)
    expect(host.guards.length).toBe(0)
    expect(host.tools.size).toBe(0)
  })

  it('only warns on an unmeasured host under balanced, listing both accepted versions', async () => {
    const { dir, host } = await load('balanced', UNVERIFIED)
    // Balanced does not gate on the version code: the load succeeds and the
    // finding is recorded as a warning, not a refusal.
    expect(postureRecord(dir)?.['decision']).not.toBe('fail')

    const posture = await runTool<{ findings: { code: string; severity: string; detail: string }[] }>(
      host,
      'safeharness_posture',
    )
    const finding = posture.findings.find((item) => item.code === 'plugin_version_mismatch')
    expect(finding?.severity).toBe('WARN')
    // The operator needs the fix in the message, not just "mismatch".
    expect(finding?.detail).toContain(PINNED_HOST)
    expect(finding?.detail).toContain(VERIFIED_OLD)
    for (const dispose of host.disposers) await dispose?.()
  })
})
