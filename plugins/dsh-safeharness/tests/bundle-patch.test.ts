/**
 * Bundle packaging: the panel is only reachable when the host treats this package
 * as a DSH *bundle* (a `package.json` that declares `dsh.bundle.patch`). Without it
 * the plugin still loads as a plain dependency, but the plugins page has no entry to
 * hang the `settings.plugins.tab` contribution on — that was the 1.9.1 gap.
 *
 * These tests pin the four things that make the difference, so a future packaging
 * change cannot silently regress the panel entry:
 *   1. the manifest declares a bundle patch,
 *   2. the patch file exists and parses as a loader patch list,
 *   3. the patch inserts exactly this package under a stable id,
 *   4. the patch ships in the tarball (`files`).
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseYaml } from '../src/util/yaml.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface Manifest {
  name?: string
  dsh?: {
    bundle?: { patch?: string }
    client?: { platform?: string; inject?: string[] }
  }
  files?: string[]
}

const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as Manifest

describe('bundle patch', () => {
  it('declares dsh.bundle.patch', () => {
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('ships the patch inside the package', () => {
    expect(manifest.files ?? []).toContain('cordis.patch.yml')
  })

  it('keeps the browser half declared', () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.dsh?.client?.inject ?? []).toEqual(
      expect.arrayContaining(['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-connection']),
    )
  })

  it('parses as a loader patch list that inserts this package once', () => {
    const patchPath = manifest.dsh?.bundle?.patch ?? './cordis.patch.yml'
    const text = readFileSync(join(pluginRoot, patchPath), 'utf8')
    const parsed = parseYaml(text, patchPath)
    expect(Array.isArray(parsed)).toBe(true)
    const entries = parsed as Array<{ insert?: Array<{ id?: string; name?: string }> }>
    expect(entries.length).toBe(1)
    const rows = entries[0]?.insert ?? []
    expect(rows.length).toBe(1)
    expect(rows[0]?.id).toBe('safeharness')
    expect(rows[0]?.name).toBe(manifest.name)
  })
})
