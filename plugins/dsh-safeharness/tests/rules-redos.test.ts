/**
 * The loader's catastrophic-backtracking gate (1.15.0).
 *
 * Input rules run **synchronously** inside `agent/pre-step`; a JS regex cannot be
 * interrupted once it starts backtracking. A rule such as `(a+)+` therefore does not
 * "slow down" the agent, it hangs it — on one message, before any judge or ledger
 * can intervene. The drafting path always refused that shape; 1.15.0 moved the same
 * check down into the loader so a hand-written file cannot smuggle it past.
 *
 * These tests pin the gate from both sides: the dangerous shapes are rejected by
 * every entry point (compile, dir file, inline, chain legs), and ordinary grouped
 * patterns are not.
 * @module
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

import { compileChain, compileRule, loadRuleSet, tryLoadRuleSet } from '../src/engine/rules.js'
import { RuleLoadError } from '../src/engine/types.js'
import type { RawChainRule, RawRule } from '../src/engine/types.js'

/** The packaged rules directory that ships with the plugin. */
const PACKAGED_RULES_DIR = fileURLToPath(new URL('../rules', import.meta.url))

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'safeharness-redos-'))
let fixtureCounter = 0

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

/** One raw inform rule with the given pattern. */
function rule(pattern: string, name = 'candidate'): RawRule {
  return {
    name,
    pattern,
    severity: 'high',
    category: 'prompt_injection',
    action: 'deny',
    reason: 'fixture',
    origin: 'inline',
  }
}

/** One raw chain rule with the given first leg. */
function chain(first: string): RawChainRule {
  return {
    name: 'candidate_chain',
    first,
    then: 'web_fetch',
    firstTags: [],
    thenTags: [],
    maxGap: 0,
    severity: 'high',
    category: 'trajectory_chain',
    reason: 'fixture',
    origin: 'inline',
  }
}

/** Write one rule file into a fresh fixture directory. */
function writeRuleDir(files: Readonly<Record<string, string>>): string {
  fixtureCounter += 1
  const directory = join(TEMP_ROOT, `fixture-${fixtureCounter}`)
  mkdirSync(directory, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const target = join(directory, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content, 'utf8')
  }
  return directory
}

/** A minimal packaged rule set: one benign rule, so `loadRuleSet` has a valid floor. */
function minimalPackagedDir(): string {
  return writeRuleDir({
    'base.yaml': [
      'rules:',
      '  - name: pkg_base',
      "    pattern: 'pkg-base'",
      '    severity: high',
      '    category: test',
      '    action: deny',
      "    reason: 'base rule'",
      '',
    ].join('\n'),
  })
}

/** One YAML rule document with the given pattern. */
function ruleYaml(pattern: string): string {
  return [
    'rules:',
    '  - name: unsafe_candidate',
    `    pattern: '${pattern}'`,
    '    severity: high',
    '    category: prompt_injection',
    '    action: deny',
    "    reason: 'fixture'",
    '',
  ].join('\n')
}

describe('loader rejects catastrophic backtracking shapes', () => {
  it('compileRule refuses a quantified group that already quantifies', () => {
    expect(() => compileRule(rule('(a+)+'))).toThrow(RuleLoadError)
    try {
      compileRule(rule('(a+)+'))
    } catch (error) {
      expect(error).toBeInstanceOf(RuleLoadError)
      expect((error as RuleLoadError).problems.join('\n')).toContain('repeats a group')
      // The message says why it matters, not just "bad pattern".
      expect((error as RuleLoadError).problems.join('\n')).toContain('synchronously')
    }
  })

  it('rejects the other classic forms too', () => {
    for (const pattern of ['(.*)*', '([a-z]+)*', '(\\w+x?)+', '(a{2,}){3,}']) {
      expect(() => compileRule(rule(pattern)), pattern).toThrow(RuleLoadError)
    }
  })

  it('refuses a hand-written rules.dir file (the gap this closes)', () => {
    const dir = writeRuleDir({ 'operator.yaml': ruleYaml('(a+)+') })
    const problem = (() => {
      try {
        loadRuleSet({ packagedRulesDir: minimalPackagedDir(), dir })
        return ''
      } catch (error) {
        return error instanceof RuleLoadError ? error.problems.join('\n') : String(error)
      }
    })()
    expect(problem).toContain('catastrophic backtracking risk')
  })

  it('refuses an inline rule as well (config is not a bypass)', () => {
    const result = tryLoadRuleSet({
      packagedRulesDir: minimalPackagedDir(),
      inline: [rule('(x+)+', 'inline_unsafe')],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.problems.join('\n')).toContain('catastrophic backtracking risk')
  })

  it('refuses a chain leg with the shape', () => {
    expect(() => compileChain(chain('(a+)+'))).toThrow(RuleLoadError)
  })
})

describe('ordinary grouped patterns still load', () => {
  it('accepts bounded grouping, alternation and character classes', () => {
    for (const pattern of ['(?:curl|wget)\\s+http', '(abc)+', '[a-z0-9]+', '(foo|bar)+', 'a{2,4}', '(\\d{3}){2}']) {
      expect(() => compileRule(rule(pattern)), pattern).not.toThrow()
    }
  })

  it('the shipped 20-rule set still passes the new gate', () => {
    // A false positive here would refuse to load the plugin itself.
    const ruleset = loadRuleSet({ packagedRulesDir: PACKAGED_RULES_DIR })
    expect(ruleset.ruleCount).toBe(20)
  })
})
