/**
 * Rule-directory snapshots and rollback (1.14.0).
 *
 * The kernel keeps ten versions of a hot-reloaded rule set in its database; the
 * plugin has no database, so the equivalent is a bounded set of directory
 * snapshots. What these tests pin:
 *
 *  - every capture is a real copy (content hash in the manifest, verified on restore);
 *  - restoring refuses a snapshot that does not load, and writes nothing in that case;
 *  - restoring restores "the directory as it was": files the snapshot does not have
 *    are removed, and the state being replaced is snapshotted first so the rollback
 *    is itself reversible;
 *  - the history is bounded (old snapshots are pruned) and a failed capture never
 *    blocks a validated write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuleHistory, MAX_SNAPSHOTS } from '../src/panel/rules-history.js'
import { createRuleWriter, RuleWriteError } from '../src/panel/rules-write.js'
import type { Runtime } from '../src/runtime.js'

/** The packaged rules this install ships (the loader needs a non-empty baseline). */
const PACKAGED = fileURLToPath(new URL('../rules', import.meta.url))

/** A content-free logger. */
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

/** One temp workspace per test. */
interface Workspace {
  readonly base: string
  readonly rulesDir: string
  readonly historyRoot: string
}

let workspace: Workspace

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'safeharness-history-'))
  workspace = { base, rulesDir: join(base, 'rules'), historyRoot: join(base, 'rules-writes') }
  mkdirSync(workspace.rulesDir, { recursive: true })
})

afterEach(() => {
  rmSync(workspace.base, { recursive: true, force: true })
})

/** A runtime-shaped stub over one rule directory. */
function stubRuntime(rulesDir: string, inline: unknown[] = []): Runtime {
  return {
    config: { rules: { dir: rulesDir, watch: true, inline } },
    audit: vi.fn(),
    internalError: vi.fn(),
  } as unknown as Runtime
}

/** One valid rule file body. */
function ruleYaml(name: string, pattern: string): string {
  return `rules:\n  - name: ${name}\n    pattern: '${pattern}'\n    severity: high\n    category: prompt_injection\n    reason: test rule\n`
}

/** Build the history over the current workspace. */
function historyFor(options: { inline?: unknown[]; reload?: () => { rules: number; chains: number; hash: string } } = {}) {
  const runtime = stubRuntime(workspace.rulesDir, options.inline ?? [])
  const history = createRuleHistory({
    root: workspace.historyRoot,
    packagedRulesDir: PACKAGED,
    inline: () => options.inline ?? [],
    reload: options.reload ?? (() => ({ rules: 21, chains: 3, hash: 'deadbeefcafe' })),
    runtime,
    logger,
  })
  return { history, runtime }
}

/** Write one rule file into the live directory. */
function liveFile(name: string, body: string): void {
  writeFileSync(join(workspace.rulesDir, name), body, 'utf8')
}

/** Names of the rule files currently in the live directory. */
function liveNames(): string[] {
  return readdirSync(workspace.rulesDir).filter((name) => /\.ya?ml$/iu.test(name)).sort()
}

describe('capture and list', () => {
  it('captures every rule file and reports it as the active snapshot', () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    liveFile('beta.yml', ruleYaml('beta_rule', 'beta-marker'))
    const { history } = historyFor()

    const id = history.snapshotBeforeWrite()
    expect(id).toMatch(/^[0-9]{8}T[0-9]{6}Z-1$/u)

    const listed = history.list()
    expect(listed.limit).toBe(MAX_SNAPSHOTS)
    expect(listed.snapshots).toHaveLength(1)
    expect(listed.snapshots[0]).toMatchObject({ id, trigger: 'write', files: 2, active: true })
    const snapshotDir = join(workspace.historyRoot, 'history', id ?? '')
    expect(existsSync(join(snapshotDir, 'manifest.json'))).toBe(true)
    expect(readFileSync(join(snapshotDir, 'alpha.yaml'), 'utf8')).toContain('alpha-marker')
  })

  it('returns undefined when there is nothing to capture', () => {
    const { history } = historyFor()
    expect(history.snapshotBeforeWrite()).toBeUndefined()
    expect(history.list().snapshots).toEqual([])
  })

  it('takes distinct ids for two captures in the same second', () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    const { history } = historyFor()
    const first = history.snapshotBeforeWrite()
    const second = history.snapshotBeforeWrite()
    expect(first).not.toBe(second)
    expect(history.list().snapshots).toHaveLength(2)
  })

  it('keeps only the newest snapshots', () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    const { history } = historyFor()
    for (let index = 0; index < MAX_SNAPSHOTS + 3; index += 1) history.snapshotBeforeWrite()
    const listed = history.list()
    expect(listed.snapshots).toHaveLength(MAX_SNAPSHOTS)
    const directories = readdirSync(join(workspace.historyRoot, 'history'))
    expect(directories).toHaveLength(MAX_SNAPSHOTS)
  })

  it('marks a snapshot inactive once the live directory differs', () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    const { history } = historyFor()
    const id = history.snapshotBeforeWrite()
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'changed-marker'))
    const entry = history.list().snapshots.find((item) => item.id === id)
    expect(entry?.active).toBe(false)
  })
})

describe('rollback', () => {
  it('restores the snapshot content and removes files it does not contain', () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    const { history, runtime } = historyFor()
    const id = history.snapshotBeforeWrite()

    // Drift: change the captured file and add one the snapshot never had.
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'drifted-marker'))
    liveFile('gamma.yaml', ruleYaml('gamma_rule', 'gamma-marker'))

    const result = history.rollback(id)
    expect(result.snapshot).toBe(id)
    expect(result.files).toBe(1)
    expect(result.removed).toEqual(['gamma.yaml'])
    expect(liveNames()).toEqual(['alpha.yaml'])
    expect(readFileSync(join(workspace.rulesDir, 'alpha.yaml'), 'utf8')).toContain('alpha-marker')
    expect(result.reloaded).toBe(true)
    expect(runtime.audit).toHaveBeenCalledWith('rules_written', expect.objectContaining({
      reason_code: 'panel_rule_rollback',
      labels: expect.objectContaining({ mode: 'rollback', snapshot: id }),
    }))
  })

  it('snapshots the replaced state first, so a rollback can be undone', () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    const { history } = historyFor()
    const id = history.snapshotBeforeWrite()
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'drifted-marker'))

    const result = history.rollback(id)
    expect(result.preRollback).toMatch(/^[0-9]{8}T[0-9]{6}Z-[0-9]+$/u)
    const pre = history.list().snapshots.find((item) => item.id === result.preRollback)
    expect(pre?.trigger).toBe('pre-rollback')

    // Undo the undo: the drifted content comes back.
    history.rollback(result.preRollback)
    expect(readFileSync(join(workspace.rulesDir, 'alpha.yaml'), 'utf8')).toContain('drifted-marker')
  })

  it('refuses a corrupt snapshot and writes nothing', () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    const { history } = historyFor()
    const id = history.snapshotBeforeWrite()
    // Tamper with the captured file (the manifest hash no longer matches).
    writeFileSync(join(workspace.historyRoot, 'history', id ?? '', 'alpha.yaml'), ruleYaml('alpha_rule', 'tampered'), 'utf8')
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'drifted-marker'))

    expect(() => history.rollback(id)).toThrow(RuleWriteError)
    expect(readFileSync(join(workspace.rulesDir, 'alpha.yaml'), 'utf8')).toContain('drifted-marker')
  })

  it('refuses a snapshot that would not load, and leaves the directory alone', () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    // An inline rule the loader cannot compile takes part in the same gate, so the
    // restored set is rejected no matter what the snapshot itself contains.
    const inline = [{ name: 'broken_inline', pattern: '(unclosed', severity: 'high', category: 'prompt_injection' }]
    const { history } = historyFor({ inline })
    const id = history.snapshotBeforeWrite()
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'drifted-marker'))

    expect(() => history.rollback(id)).toThrow(/does not load/u)
    expect(readFileSync(join(workspace.rulesDir, 'alpha.yaml'), 'utf8')).toContain('drifted-marker')
    // The refused rollback must not leave an undo point behind either.
    expect(history.list().snapshots.filter((item) => item.trigger === 'pre-rollback')).toHaveLength(0)
  })

  it('rejects an invalid handle', () => {
    const { history } = historyFor()
    expect(() => history.rollback('../../etc')).toThrow(RuleWriteError)
    expect(() => history.rollback(42)).toThrow(RuleWriteError)
  })

  it('reports a reload failure without pretending the restore failed', () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    const { history } = historyFor({
      reload: () => {
        throw new Error('boom')
      },
    })
    const id = history.snapshotBeforeWrite()
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'drifted-marker'))
    const result = history.rollback(id)
    expect(result.reloaded).toBe(false)
    expect(readFileSync(join(workspace.rulesDir, 'alpha.yaml'), 'utf8')).toContain('alpha-marker')
  })
})

describe('snapshot-before-write integration', () => {
  it('a panel rule write records the snapshot it took first', async () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    const runtime = stubRuntime(workspace.rulesDir)
    const history = createRuleHistory({
      root: workspace.historyRoot,
      packagedRulesDir: PACKAGED,
      inline: () => [],
      reload: () => ({ rules: 21, chains: 3, hash: 'deadbeefcafe' }),
      runtime,
      logger,
    })
    const writer = createRuleWriter({
      runtime,
      packagedRulesDir: PACKAGED,
      reload: () => ({ rules: 21, chains: 3, hash: 'deadbeefcafe' }),
      logger,
      beforeWrite: () => history.snapshotBeforeWrite(),
    })

    const value = await writer.write({
      filename: 'delta.yaml',
      yaml: ruleYaml('delta_rule', 'delta-marker'),
      overwrite: false,
    })
    expect(value.created).toBe(true)
    expect(value.snapshot).toBeDefined()
    expect(history.list().snapshots.map((item) => item.id)).toContain(value.snapshot)
    // The snapshot holds the state *before* the write, not after.
    const snapshotDir = join(workspace.historyRoot, 'history', value.snapshot ?? '')
    expect(readdirSync(snapshotDir).sort()).toEqual(['alpha.yaml', 'manifest.json'])
  })

  it('a skipped capture does not block a validated write', async () => {
    liveFile('alpha.yaml', ruleYaml('alpha_rule', 'alpha-marker'))
    const runtime = stubRuntime(workspace.rulesDir)
    const writer = createRuleWriter({
      runtime,
      packagedRulesDir: PACKAGED,
      reload: () => ({ rules: 21, chains: 3, hash: 'deadbeefcafe' }),
      logger,
      // The history returns undefined when it skipped the capture (nothing to
      // snapshot, oversized directory, or a full disk it already logged).
      beforeWrite: () => undefined,
    })
    const value = await writer.write({
      filename: 'echo.yaml',
      yaml: ruleYaml('echo_rule', 'echo-marker'),
      overwrite: false,
    })
    expect(value.created).toBe(true)
    expect(value.snapshot).toBeUndefined()
    expect(readFileSync(join(workspace.rulesDir, 'echo.yaml'), 'utf8')).toContain('echo-marker')
  })
})
