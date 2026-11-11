/**
 * M4 acceptance tests: the release-candidate contracts that are cheap to assert
 * without a host.
 *
 * Live verification (tarball install → cold start → attack interception → patrol →
 * uninstall) is done manually against a real host; this file locks the parts that
 * would otherwise regress silently: the load-time gate leaving nothing wired, and
 * the published package shape.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, VERSION, PINNED_VERSIONS } from '../src/index.js'
import { createFakeHost } from './helpers/fake-host.js'
import { __matchingHostSurfaceForTests, __setHostSurfaceProbeForTests } from '../src/index.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** A temp ledger dir (never inside the repo). */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'safeharness-m4-'))
}

/** Read the built package manifest. */
function manifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as Record<string, unknown>
}

describe('M4: hardened load gate leaves no partial wiring (R36)', () => {
  it('refuses the load and registers no listener, tool, prompt or service', async () => {
    // Danger-full-access is a `hardened.posture.failOn` code; the fake host's
    // sandboxPolicy returns exactly that.
    const { host } = createFakeHost({
      config: { preset: 'hardened' },
      services: { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } },
    })
    __setHostSurfaceProbeForTests(__matchingHostSurfaceForTests)
    try {
      await expect(apply(host.ctx as never, { preset: 'hardened', audit: { dir: tempDir() } }))
        .rejects.toThrow(/refusing to load/u)

      // The invariant companion injects `safeharness`; providing it here would make
      // the companion run for a refused plugin.
      expect(host.services.has('safeharness')).toBe(false)
      for (const event of ['agent/pre-step', 'tools/pre-execute', 'tools/post-execute', 'tools/result', 'llm/stream', 'approval/request']) {
        expect(host.listeners.get(event), event).toBeUndefined()
      }
      expect(host.guards).toHaveLength(0)
      expect(host.tools.size).toBe(0)
      expect(host.promptSections).toHaveLength(0)
    } finally {
      __setHostSurfaceProbeForTests(undefined)
    }
  })

  it('still writes plugin_loaded + posture_report before refusing (evidence survives)', async () => {
    const { host } = createFakeHost({
      config: { preset: 'hardened' },
      services: { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } },
    })
    const dir = tempDir()
    __setHostSurfaceProbeForTests(__matchingHostSurfaceForTests)
    try {
      await expect(apply(host.ctx as never, { preset: 'hardened', audit: { dir } })).rejects.toThrow()
      // Read the ledger the plugin actually wrote (apply creates its own sink).
      const lines = readFileSync(join(dir, 'ledger.ndjson'), 'utf8').split('\n').filter((line) => line.length > 0)
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(records.map((record) => record.kind)).toEqual(['plugin_loaded', 'posture_report'])
      expect(records[1]?.['decision']).toBe('fail')
      expect(records[1]?.['rule_ids']).toContain('sandbox_danger_full_access')
    } finally {
      __setHostSurfaceProbeForTests(undefined)
    }
  })

  it('loads hardened when the posture is clean', async () => {
    const { host } = createFakeHost({
      config: { preset: 'hardened' },
      services: { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) } },
    })
    __setHostSurfaceProbeForTests(__matchingHostSurfaceForTests)
    try {
      await apply(host.ctx as never, { preset: 'hardened', audit: { dir: tempDir() } })
      expect(host.services.has('safeharness')).toBe(true)
      expect(host.tools.size).toBe(4)
    } finally {
      __setHostSurfaceProbeForTests(undefined)
    }
  })
})

describe('M4: published package shape', () => {
  it('reports the release-candidate version everywhere', () => {
    expect(VERSION).toBe('1.0.0-rc.1')
    expect(manifest()['version']).toBe(VERSION)
  })

  it('keeps the coarse dsh compatibility gate', () => {
    const engines = manifest()['engines'] as Record<string, string>
    expect(engines['dsh']).toBe('>=0.2.2-rc.1 <0.3.0')
    expect(engines['node']).toBe('>=24')
  })

  it('ships only lib, rules and README', () => {
    expect(manifest()['files']).toEqual(['lib', 'rules', 'README.md'])
  })

  it('declares no runtime dependencies', () => {
    expect(manifest()['dependencies']).toEqual({})
  })

  it('pins every host package it imports at runtime', () => {
    // The pin table is what posture compares against; a package added to the
    // runtime surface without a pin would silently skip the version check.
    expect(Object.keys(PINNED_VERSIONS)).toContain('@deepseek-ai/dsh-tools')
    expect(Object.keys(PINNED_VERSIONS)).toContain('@deepseek-ai/cordis')
    for (const version of Object.values(PINNED_VERSIONS)) expect(version).toMatch(/^\d+\.\d+\.\d+/u)
  })

  it('ships a copy-paste example patch using the insert shape', () => {
    const example = readFileSync(join(pluginRoot, 'examples', 'cordis.patch.example.yml'), 'utf8')
    expect(example).toContain('- insert:')
    expect(example).toContain('name: "@upear/dsh-safeharness"')
    // The M0 finding R22: an entry with only `id:` is a config override, not a mount.
    expect(example).not.toMatch(/^- id: safeharness\n\s+name:/mu)
  })
})
