/**
 * Guard for the public tree: "which files must never be pushed" is a rule, not a
 * habit. `scripts/publish-public.mjs` owns the list; this file proves the plan it
 * produces never contains an internal asset, and that it still contains everything a
 * stranger needs to clone, build and test the package.
 * @module
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error - the publisher is a plain ESM script; it has no declaration file.
import { PACKAGE_ROOT, PUBLISH_TOP, isPublishable, planPublish } from '../scripts/publish-public.mjs'

/** The plan, computed once. */
const plan = planPublish() as { files: string[]; skipped: string[] }

/** Internal assets that exist in the full (private) checkout. */
const INTERNAL_ASSETS = [
  'tests/acceptance-m2.test.ts',
  'tests/corpus.ts',
  'tests/golden.test.ts',
  'tests/sidecar-parity.test.ts',
  'tests/fixtures/golden.json',
  'tests/fixtures/benign.json',
  'tests/fixtures/benign-borderline.json',
  'scripts/gen_golden.py',
]

describe('public tree plan: never selects internal assets', () => {
  it('selects nothing that the denylist rejects', () => {
    const offenders = plan.files.filter((file) => !isPublishable(file))
    expect(offenders).toEqual([])
  })

  it('skips every internal asset that exists in this checkout', () => {
    const present = INTERNAL_ASSETS.filter((file) => existsSync(join(PACKAGE_ROOT as string, file)))
    for (const file of present) expect(plan.skipped).toContain(file)
  })

  it('never publishes evidence, build output, tarballs or dotenv files', () => {
    const forbidden = plan.files.filter((file) => /(^|\/)(evidence|lib|dist|node_modules)\/|\.tgz$|(^|\/)\.env/u.test(file))
    expect(forbidden).toEqual([])
  })
})

describe('public tree plan: still contains what a stranger needs', () => {
  it('includes the package manifest, sources, rules and examples', () => {
    for (const file of [
      'package.json',
      'README.md',
      'CHANGELOG.md',
      'LICENSE',
      'tsconfig.json',
      'pnpm-lock.yaml',
      'src/index.ts',
      'src/engine/rules.ts',
      'rules/inform.yaml',
      'rules/chains.yaml',
      'examples/cordis.patch.example.yml',
      'scripts/fake-openai.mjs',
      'scripts/publish-public.mjs',
      '.github/workflows/ci.yml',
    ]) {
      expect(plan.files, file).toContain(file)
    }
  })

  it('publishes every source and rule file that exists here', () => {
    // The plan copies top-level entries wholesale, so a new `src/*.ts` needs no edit.
    for (const file of plan.files) {
      expect(existsSync(join(PACKAGE_ROOT as string, file)), file).toBe(true)
    }
    // Unpublished-but-local work (e.g. a WIP module held back for the next release)
    // must still be *planned*, never silently dropped.
    for (const file of ['src/engine/sidecar.ts', 'tests/sidecar.test.ts']) {
      if (existsSync(join(PACKAGE_ROOT as string, file))) expect(plan.files).toContain(file)
    }
  })

  it('includes the public test files (so CI has something to run)', () => {
    expect(plan.files).toContain('tests/version.test.ts')
    expect(plan.files).toContain('tests/draft.test.ts')
    for (const file of ['tests/sidecar.test.ts', 'tests/publish-guard.test.ts']) {
      if (existsSync(join(PACKAGE_ROOT as string, file))) expect(plan.files).toContain(file)
    }
  })

  it('every planned file exists on disk', () => {
    const missing = plan.files.filter((file) => !existsSync(join(PACKAGE_ROOT as string, file)))
    expect(missing).toEqual([])
  })

  it('top-level list has no internal directory', () => {
    for (const forbidden of ['evidence', 'docs', 'lib', 'dist', 'node_modules']) {
      expect(PUBLISH_TOP).not.toContain(forbidden)
    }
  })
})

describe('publishability rule', () => {
  it('rejects internal paths and accepts ordinary ones', () => {
    expect(isPublishable('evidence/M5-sidecar.md')).toBe(false)
    expect(isPublishable('lib/index.js')).toBe(false)
    expect(isPublishable('upear-dsh-safeharness-1.1.1.tgz')).toBe(false)
    expect(isPublishable('tests/corpus.ts')).toBe(false)
    expect(isPublishable('tests/fixtures/golden.json')).toBe(false)
    expect(isPublishable('scripts/gen_golden.py')).toBe(false)
    expect(isPublishable('src/engine/sidecar.ts')).toBe(true)
    expect(isPublishable('tests/sidecar.test.ts')).toBe(true)
    expect(isPublishable('scripts/fake-openai.mjs')).toBe(true)
  })
})
