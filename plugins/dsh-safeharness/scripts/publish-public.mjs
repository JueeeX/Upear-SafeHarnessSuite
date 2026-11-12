#!/usr/bin/env node
/**
 * Build the public tree from this package directory.
 *
 * Why this exists: the public repo (`dsh` remote) is a **separate history** whose root
 * is the plugin package root, so publishing is "copy some files into a worktree".
 * Doing that by hand means the "which files must never be published" rule lives in a
 * human's head (or in a doc nobody re-reads). This script makes that rule executable:
 *
 * - `PUBLISH_TOP` lists the top-level entries that exist in the public tree;
 * - `NEVER_PUBLISH` is the denylist inside those entries (internal corpus, golden
 *   fixtures, evidence, build output, tarballs, ...);
 * - anything else under those entries is published automatically, so adding a new
 *   `src/*.ts` or `tests/*.test.ts` needs no edit here.
 *
 * `tests/publish-guard.test.ts` asserts the plan never selects a denied path and that
 * every planned file exists, so a mistake fails `pnpm test` instead of leaking.
 *
 * Usage:
 *   node scripts/publish-public.mjs --check                 # print the plan, copy nothing
 *   node scripts/publish-public.mjs --target <dir>          # copy the publishable tree
 *   node scripts/publish-public.mjs --target <dir> --check  # only scan <dir> for leaks
 *
 * @module publish-public
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package root (this script lives in `<root>/scripts/`). */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Top-level entries of the published package tree.
 *
 * Keep this in sync with what a stranger needs to clone, build and test the package.
 * `docs/` and `evidence/` are deliberately absent: they are internal assets.
 */
export const PUBLISH_TOP = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'tsconfig.json',
  '.npmrc',
  '.gitignore',
  '.gitattributes',
  'pnpm-lock.yaml',
  'rules',
  'src',
  'tests',
  'examples',
  'scripts',
  '.github',
]

/**
 * Paths that must never reach the public repo, even if they appear under a published
 * top-level entry. Every pattern is matched against a POSIX-style relative path.
 *
 * The internal assets are: the attack corpus and its golden fixtures (the corpus is
 * an internal asset, see README §8), the generator that produced the fixtures, the
 * evidence directory (machine paths, logs), and build output.
 */
export const NEVER_PUBLISH = [
  /(^|\/)evidence(\/|$)/u,
  /(^|\/)lib(\/|$)/u,
  /(^|\/)dist(\/|$)/u,
  /(^|\/)node_modules(\/|$)/u,
  /(^|\/)\.git(\/|$)/u,
  /\.tgz$/u,
  /(^|\/)\.env(\..*)?$/u,
  /(^|\/)tests\/acceptance-m2\.test\.ts$/u,
  /(^|\/)tests\/corpus\.ts$/u,
  /(^|\/)tests\/golden\.test\.ts$/u,
  /(^|\/)tests\/sidecar-parity\.test\.ts$/u,
  /(^|\/)tests\/fixtures\/golden\.json$/u,
  /(^|\/)tests\/fixtures\/benign(-borderline)?\.json$/u,
  /(^|\/)scripts\/gen_golden\.py$/u,
]

/** Normalise a relative path to POSIX separators (Windows runs this too). */
export function toPosix(path) {
  return path.split(sep).join('/')
}

/** Whether one POSIX-style relative path may be published. */
export function isPublishable(relativePath) {
  return !NEVER_PUBLISH.some((pattern) => pattern.test(relativePath))
}

/**
 * Compute the publish set without touching the filesystem outside `root`.
 *
 * @param {string} [root] - package root (tests pass a temp tree).
 * @returns {{ files: string[], skipped: string[] }} POSIX paths, sorted.
 */
export function planPublish(root = PACKAGE_ROOT) {
  /** @type {string[]} */
  const files = []
  /** @type {string[]} */
  const skipped = []
  /** @param {string} rel */
  const walk = (rel) => {
    const absolute = join(root, rel)
    const stats = statSync(absolute)
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute)) walk(`${rel}/${entry}`)
      return
    }
    const path = toPosix(rel)
    if (isPublishable(path)) files.push(path)
    else skipped.push(path)
  }
  for (const top of PUBLISH_TOP) {
    if (!existsSync(join(root, top))) {
      skipped.push(`${top} (missing)`)
      continue
    }
    walk(top)
  }
  files.sort()
  skipped.sort()
  return { files, skipped }
}

/**
 * Fail closed if the plan would publish an internal asset.
 *
 * @param {string} [root] - package root.
 * @param {string[]} [files] - plan to check (defaults to {@link planPublish}).
 * @returns {string[]} the same files, when clean.
 */
export function assertNoInternalAssets(root = PACKAGE_ROOT, files = planPublish(root).files) {
  const offenders = files.filter((file) => !isPublishable(file))
  if (offenders.length > 0) {
    throw new Error(`refusing to publish internal assets:\n  ${offenders.join('\n  ')}`)
  }
  return files
}

/**
 * Copy the publishable tree into `target` (usually a `git worktree` of `dsh/main`).
 *
 * @param {string} target - existing directory that becomes the public tree.
 * @param {string} [root] - package root.
 * @returns {{ files: string[], skipped: string[] }}
 */
export function publish(target, root = PACKAGE_ROOT) {
  const { files, skipped } = planPublish(root)
  assertNoInternalAssets(root, files)
  for (const relativePath of files) {
    const destination = join(target, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(join(root, relativePath), destination)
  }
  return { files, skipped }
}

/** Scan an existing directory for paths that must never be there. */
export function findLeaks(target) {
  /** @type {string[]} */
  const leaks = []
  /** @param {string} rel */
  const walk = (rel) => {
    const absolute = rel === '' ? target : join(target, rel)
    const stats = statSync(absolute)
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute)) walk(rel === '' ? entry : `${rel}/${entry}`)
      return
    }
    const path = toPosix(rel)
    if (!isPublishable(path)) leaks.push(path)
  }
  if (existsSync(target)) walk('')
  return leaks.sort()
}

/** CLI entry point. */
function main(argv) {
  const targetIndex = argv.indexOf('--target')
  const target = targetIndex === -1 ? undefined : argv[targetIndex + 1]
  const checkOnly = argv.includes('--check')
  if (checkOnly && target !== undefined) {
    const leaks = findLeaks(target)
    console.log(`leaks in ${target}: ${leaks.length}`)
    for (const leak of leaks) console.log(`  ${leak}`)
    process.exit(leaks.length === 0 ? 0 : 1)
  }
  if (checkOnly) {
    const { files, skipped } = planPublish()
    assertNoInternalAssets(PACKAGE_ROOT, files)
    console.log(`would publish ${files.length} file(s); skipping ${skipped.length}:`)
    for (const skip of skipped) console.log(`  - ${skip}`)
    return
  }
  if (target === undefined) {
    console.error('usage: node scripts/publish-public.mjs [--target <dir>] [--check]')
    process.exit(2)
  }
  const { files, skipped } = publish(target)
  console.log(`published ${files.length} file(s) into ${target}; skipped ${skipped.length} internal asset(s)`)
  const leaks = findLeaks(target)
  if (leaks.length > 0) {
    console.error('internal assets found in the target after copy:')
    for (const leak of leaks) console.error(`  ${leak}`)
    process.exit(1)
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
}
