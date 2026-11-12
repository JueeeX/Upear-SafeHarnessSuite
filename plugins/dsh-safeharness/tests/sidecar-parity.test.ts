/**
 * Behavioural parity between the built-in engine and the real Python sidecar
 * (M5 T5.1, step 2).
 *
 * INTERNAL ASSET: imports the private attack corpus (`tests/corpus.ts`), so it is
 * excluded from the public tree by `scripts/publish-public.mjs`. It is skipped
 * automatically when the Python framework checkout is not importable, which keeps
 * a clean `pnpm test` green on machines without Python.
 *
 * What it proves: for the same rule sources, the two engines return the same
 * `Decision` (kind, reason code, rule ids, severity, category) on the corpus. It
 * does not prove the corpus is representative — `golden.test.ts` owns that.
 * @module
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveConfig } from '../src/config.js'
import { evaluateInput } from '../src/engine/input.js'
import { createEngine } from '../src/engine/index.js'
import { loadRuleSet } from '../src/engine/rules.js'
import { createSidecarEngine } from '../src/engine/sidecar-engine.js'
import { Sidecar } from '../src/engine/sidecar.js'
import { loadCorpus, pluginRoot, repoRoot, type CorpusAttack } from './corpus.js'

/** Python executable: `SAFEHARNESS_PYTHON`, the known local install, or PATH. */
function pythonCommand(): string {
  const fromEnv = process.env['SAFEHARNESS_PYTHON']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const known = 'C:/Python314/python.exe'
  return existsSync(known) ? known : 'python'
}

const PYTHON = pythonCommand()
const FRAMEWORK = process.env['SAFEHARNESS_FRAMEWORK'] ?? join(repoRoot, 'src')
const SCRIPT = join(pluginRoot, 'scripts', 'safeharness_sidecar.py')

/** Can this machine import the SafeHarness framework at all? */
function frameworkAvailable(): boolean {
  const probe = spawnSync(
    PYTHON,
    ['-c', `import sys; sys.path.insert(0, r"${FRAMEWORK}"); from safeharness.policies.sql_guard import inspect_sql; print("ok")`],
    { encoding: 'utf8', timeout: 20000 },
  )
  return probe.status === 0 && (probe.stdout ?? '').includes('ok')
}

/** The internal corpus, or an empty list when this is a public clone. */
function corpusOrEmpty(): CorpusAttack[] {
  try {
    return loadCorpus()
  } catch {
    return []
  }
}

const corpus = corpusOrEmpty()
const available = frameworkAvailable() && corpus.length > 0 && existsSync(SCRIPT)

describe.skipIf(!available)('sidecar parity: built-in engine vs real Python engine', () => {
  it('agrees on every corpus attack, decision for decision', async () => {
    const config = resolveConfig({
      engine: {
        kind: 'sidecar',
        command: PYTHON,
        args: ['-u', SCRIPT, '--framework', FRAMEWORK],
        startTimeoutMs: 30000,
        timeoutMs: 5000,
      },
    })
    const ruleset = loadRuleSet({ packagedRulesDir: join(pluginRoot, 'rules') })
    expect(ruleset.ruleCount).toBe(20)
    const client = new Sidecar({
      command: config.engine.command,
      args: [...config.engine.args],
      cwd: pluginRoot,
      timeoutMs: 5000,
      startTimeoutMs: 30000,
    })
    const engine = createSidecarEngine({
      builtin: createEngine(ruleset, config),
      sidecar: client,
      timeoutMs: 5000,
    })
    try {
      await engine.prepare()
      expect(engine.rulesStale).toBe(false)
      for (const attack of corpus) {
        const expected = evaluateInput(ruleset, attack.text, { maxChars: config.input.maxChars }).decision
        const actual = await engine.evaluateInputAsync(attack.text)
        // Compare with the corpus coordinates so a failure names *which* attack
        // diverged without printing its text.
        expect({ suite: attack.suite, id: attack.id, decision: actual })
          .toEqual({ suite: attack.suite, id: attack.id, decision: expected })
      }
    } finally {
      await engine.stop()
    }
  }, 120_000)
})
