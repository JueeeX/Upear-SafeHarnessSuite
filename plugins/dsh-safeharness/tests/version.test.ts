/**
 * Packaging invariants: the version stamped into every ledger record must match
 * package.json, and the export surface declared there must exist on disk after a
 * build (the latter is checked by `pnpm build`, this file covers the version).
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VERSION } from '../src/version.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('version', () => {
  it('matches package.json', () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as { version?: string }
    expect(manifest.version).toBe(VERSION)
  })

  it('is a plain semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/u)
  })
})

describe('package manifest', () => {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
    name?: string
    type?: string
    main?: string
    exports?: Record<string, unknown>
    peerDependencies?: Record<string, string>
    dependencies?: Record<string, string>
  }

  it('is the expected profile plugin package', () => {
    expect(manifest.name).toBe('@upear/dsh-safeharness')
    expect(manifest.type).toBe('module')
    expect(manifest.main).toBe('lib/index.js')
  })

  it('exports the plugin entry and the invariant companion', () => {
    expect(Object.keys(manifest.exports ?? {})).toEqual(expect.arrayContaining(['.', './invariant', './package.json']))
  })

  it('has zero runtime dependencies', () => {
    expect(manifest.dependencies ?? {}).toEqual({})
  })

  it('pins every DSH peer to an exact version (no ranges)', () => {
    const peers = manifest.peerDependencies ?? {}
    expect(Object.keys(peers).length).toBeGreaterThanOrEqual(7)
    for (const [name, range] of Object.entries(peers)) {
      expect(name.startsWith('@deepseek-ai/')).toBe(true)
      // rc-era packages drift: `^`, `~`, `*` or `latest` are all forbidden.
      expect(range).toMatch(/^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/u)
    }
  })
})
