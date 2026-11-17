/**
 * `validateRuleCandidate`: the compiler behind the panel's write gate (D62).
 *
 * The gate is only worth having if "would this file load?" and "does this file load?"
 * are the same answer, so the central test writes the candidate and then runs the
 * real loader over the directory, asserting an identical rule-set hash.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadRuleSet, validateRuleCandidate } from '../src/engine/rules.js'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'safeharness-candidate-'))
let counter = 0

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

/** A fresh fixture directory under the temp root, optionally populated. */
function fixture(files: Readonly<Record<string, string>> = {}): string {
  counter += 1
  const directory = join(TEMP_ROOT, `case-${counter}`)
  mkdirSync(directory, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text, 'utf8')
  return directory
}

/** The packaged layer every case starts from: one valid rule. */
function packagedDir(): string {
  return fixture({
    'base.yaml': [
      'rules:',
      '  - name: pkg_base',
      "    pattern: 'pkg-base'",
      '    severity: high',
      '    category: test',
      '',
    ].join('\n'),
  })
}

/** One valid `rules:` document. */
function ruleDocument(name: string, pattern = `pattern-${name}`): string {
  return [
    'rules:',
    `  - name: ${name}`,
    `    pattern: '${pattern}'`,
    '    severity: high',
    '    category: test',
    '',
  ].join('\n')
}

describe('validateRuleCandidate', () => {
  it('accepts a new file into an empty operator directory', () => {
    const operator = fixture()
    const result = validateRuleCandidate({
      packagedRulesDir: packagedDir(),
      dir: operator,
      filename: 'operator-one.yaml',
      yaml: ruleDocument('operator_one'),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Packaged base + the candidate: one more rule than the packaged set alone.
    expect(result.ruleset.ruleCount).toBe(2)
    expect(result.ruleset.sources).toContain('dir/operator-one.yaml')
  })

  it('predicts exactly the hash the real loader produces after the write', () => {
    const packaged = packagedDir()
    const operator = fixture()
    const yaml = ruleDocument('operator_hash')
    const predicted = validateRuleCandidate({ packagedRulesDir: packaged, dir: operator, filename: 'hash.yaml', yaml })
    expect(predicted.ok).toBe(true)
    if (!predicted.ok) return

    writeFileSync(join(operator, 'hash.yaml'), yaml, 'utf8')
    const loaded = loadRuleSet({ packagedRulesDir: packaged, dir: operator })
    expect(loaded.hash).toBe(predicted.ruleset.hash)
    expect(loaded.ruleCount).toBe(predicted.ruleset.ruleCount)
  })

  it('treats an overwrite as replacing the file, not duplicating its names', () => {
    // The same rule name in the same file must stay legal: the old file is replaced.
    const operator = fixture({ 'same.yaml': ruleDocument('operator_same') })
    const result = validateRuleCandidate({
      packagedRulesDir: packagedDir(),
      dir: operator,
      filename: 'same.yaml',
      yaml: ruleDocument('operator_same', 'pattern-changed'),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ruleset.rules.filter(rule => rule.name === 'operator_same')).toHaveLength(1)
  })

  it('rejects a name already used by another operator file', () => {
    const operator = fixture({ 'other.yaml': ruleDocument('operator_dup') })
    const result = validateRuleCandidate({
      packagedRulesDir: packagedDir(),
      dir: operator,
      filename: 'candidate.yaml',
      yaml: ruleDocument('operator_dup'),
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.join('\n')).toMatch(/duplicate rule name 'operator_dup'/u)
  })

  it('can repair a broken operator file by overwriting it', () => {
    // The broken file is the overwrite target, so its old syntax error is irrelevant:
    // reading it would make every repair via the panel impossible.
    const operator = fixture({ 'broken.yaml': "rules:\n  - name: [unterminated\n" })
    expect(() => loadRuleSet({ packagedRulesDir: packagedDir(), dir: operator })).toThrow()
    const result = validateRuleCandidate({
      packagedRulesDir: packagedDir(),
      dir: operator,
      filename: 'broken.yaml',
      yaml: ruleDocument('repaired'),
    })
    expect(result.ok).toBe(true)
  })

  it('still reports a broken file that the candidate does not replace', () => {
    const operator = fixture({ 'broken.yaml': "rules:\n  - name: [unterminated\n" })
    const result = validateRuleCandidate({
      packagedRulesDir: packagedDir(),
      dir: operator,
      filename: 'new.yaml',
      yaml: ruleDocument('operator_new'),
    })
    expect(result.ok).toBe(false)
  })

  it('rejects a pattern the loader cannot compile', () => {
    const cases: readonly string[] = [
      // Python-only global inline flag: the loader already applies `i`.
      ruleDocument('bad_flag', '(?i)secret'),
      // Invalid in JS under the `u` flag.
      ruleDocument('bad_escape', '\\-'),
      // Unterminated group.
      ruleDocument('bad_group', '(unclosed'),
    ]
    for (const yaml of cases) {
      const result = validateRuleCandidate({
        packagedRulesDir: packagedDir(),
        dir: fixture(),
        filename: 'bad.yaml',
        yaml,
      })
      expect(result.ok, yaml).toBe(false)
    }
  })

  it('rejects a document that carries no rules or chains', () => {
    const empty = validateRuleCandidate({
      packagedRulesDir: packagedDir(),
      dir: fixture(),
      filename: 'empty.yaml',
      yaml: 'rules: []\n',
    })
    expect(empty.ok).toBe(false)
    if (empty.ok) return
    expect(empty.problems.join('\n')).toMatch(/contains no rules or chain rules/u)

    const unrelated = validateRuleCandidate({
      packagedRulesDir: packagedDir(),
      dir: fixture(),
      filename: 'unrelated.yaml',
      yaml: 'description: nothing to load\n',
    })
    expect(unrelated.ok).toBe(false)
  })

  it('rejects YAML that does not parse', () => {
    const result = validateRuleCandidate({
      packagedRulesDir: packagedDir(),
      dir: fixture(),
      filename: 'syntax.yaml',
      yaml: 'rules:\n  - name: [unterminated\n',
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a chain-only file', () => {
    const operator = fixture()
    const yaml = [
      'chain_rules:',
      '  - name: operator_chain',
      "    first: '(?:^|_)fetch_'",
      "    then: '(?:^|_)shell_'",
      '    max_gap: 1',
      '    severity: high',
      '    category: trajectory_chain',
      '',
    ].join('\n')
    const result = validateRuleCandidate({ packagedRulesDir: packagedDir(), dir: operator, filename: 'chain.yaml', yaml })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.ruleset.chainCount).toBe(1)
    expect(readdirSync(operator)).toEqual([])
  })
})
