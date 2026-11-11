/**
 * Settings hot reload (T2.1): a new config may recompile rules and swap modes live,
 * but a bad update must never half-apply — the previous rule set keeps running and
 * the failure is logged. Audit-sink moves are refused without a restart.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyHotConfig } from '../src/index.js'
import { resolveConfig } from '../src/config.js'
import { createEngine } from '../src/engine/index.js'
import { createRuntime } from '../src/runtime.js'
import { createLedger } from '../src/audit/ledger.js'
import { loadRuleSet } from '../src/engine/rules.js'
import { readLedger, flushLedger, tempLedgerDir } from './helpers/fake-host.js'
import type { LoggerLike } from '../src/runtime.js'
import type { RuleSet } from '../src/engine/types.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagedRulesDir = join(pluginRoot, 'rules')

/** A logger that records every line so we can assert the operator was told. */
function recordingLogger(): LoggerLike & { lines: string[] } {
  const lines: string[] = []
  return {
    lines,
    info: (message: string) => lines.push(`info:${message}`),
    warn: (message: string) => lines.push(`warn:${message}`),
    error: (message: string) => lines.push(`error:${message}`),
  }
}

/** Build a live runtime over a temp ledger. */
function buildRuntime(config = resolveConfig({ preset: 'balanced' })) {
  const ruleset = loadRuleSet({ packagedRulesDir })
  const ledger = createLedger({
    dir: tempLedgerDir(),
    format: 'ndjson',
    redact: true,
    hashChain: true,
    required: false,
    rotateMb: 64,
    pluginVersion: 'test',
    rulesetHash: ruleset.hash,
  })
  const engine = createEngine(ruleset, config)
  const logger = recordingLogger()
  const runtime = createRuntime({ config, engine, ledger, logger })
  return { runtime, logger, ruleset }
}

/** A rules dir containing one extra rule. */
function rulesDirWith(name: string, pattern: string): { dir: string; ruleset: RuleSet } {
  const dir = mkdtempSync(join(tmpdir(), 'safeharness-rules-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.yaml`), [
    'rules:',
    `  - name: ${name}`,
    `    pattern: '${pattern}'`,
    '    severity: high',
    '    category: test',
    '    action: deny',
    "    reason: 'hot reload test rule'",
    '',
  ].join('\n'), 'utf8')
  const ruleset = loadRuleSet({ packagedRulesDir, dir })
  return { dir, ruleset }
}

/** A rules dir that cannot compile. */
function brokenRulesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'safeharness-broken-'))
  writeFileSync(join(dir, 'broken.yaml'), 'rules:\n  - name: broken\n    pattern: "(?P<named>bad"\n', 'utf8')
  return dir
}

describe('applyHotConfig', () => {
  it('recompiles rules and swaps the live config on a valid update', async () => {
    const { runtime } = buildRuntime()
    const before = runtime.engine.rulesetHash
    const extra = rulesDirWith('hot_added_rule', 'hot-reload-sentinel-phrase')
    const next = resolveConfig({ preset: 'balanced', rules: { dir: extra.dir, watch: false } })

    applyHotConfig(runtime, next, { packagedRulesDir, dir: extra.dir, inline: [] }, runtime.logger)

    expect(runtime.engine.rulesetHash).toBe(extra.ruleset.hash)
    expect(runtime.engine.rulesetHash).not.toBe(before)
    expect(runtime.config.rules.dir).toBe(extra.dir)
    // The new rule is live immediately.
    expect(runtime.engine.evaluateInput('please hot-reload-sentinel-phrase now').kind).toBe('deny')

    await flushLedger(runtime)
    const records = await readLedger(runtime)
    const reload = records.find((record) => record.kind === 'rules_reloaded')
    expect(reload?.ruleset_hash).toBe(extra.ruleset.hash)
  })

  it('keeps the previous rule set when the new rules cannot compile', async () => {
    const { runtime, logger } = buildRuntime()
    const before = runtime.engine.rulesetHash
    const broken = brokenRulesDir()
    const next = resolveConfig({ preset: 'balanced', rules: { dir: broken, watch: false } })

    applyHotConfig(runtime, next, { packagedRulesDir, dir: broken, inline: [] }, logger)

    // The engine still runs the audited rule set…
    expect(runtime.engine.rulesetHash).toBe(before)
    expect(runtime.engine.ruleCount).toBeGreaterThan(0)
    // …the operator was told why, and nothing was recorded as a successful reload.
    expect(logger.lines.some((line) => line.startsWith('warn:') && line.includes('keeping previous rule set'))).toBe(true)
    await flushLedger(runtime)
    const records = await readLedger(runtime)
    expect(records.some((record) => record.kind === 'rules_reloaded')).toBe(false)
  })

  it('warns that an audit sink move needs a restart but still applies the rest', () => {
    const { runtime, logger } = buildRuntime()
    const next = resolveConfig({ preset: 'balanced', audit: { dir: 'D:/somewhere/else' } })

    applyHotConfig(runtime, next, { packagedRulesDir, dir: '', inline: [] }, logger)

    expect(runtime.config.audit.dir).toBe('D:/somewhere/else')
    expect(logger.lines.some((line) => line.includes('restart is required to move the ledger'))).toBe(true)
  })

  it('applies mode changes without touching the rule set', () => {
    const { runtime } = buildRuntime(resolveConfig({ preset: 'observe' }))
    const before = runtime.engine.rulesetHash
    const next = resolveConfig({ preset: 'balanced' })

    applyHotConfig(runtime, next, { packagedRulesDir, dir: '', inline: [] }, runtime.logger)

    expect(runtime.config.input.mode).toBe('enforce')
    expect(runtime.engine.rulesetHash).toBe(before)
  })

  it('accepts inline rules on hot update (they override the files)', () => {
    const { runtime } = buildRuntime()
    const inline = [{
      rules: [{
        name: 'hot_inline_rule',
        pattern: 'inline-sentinel-phrase',
        severity: 'critical',
        category: 'test',
        action: 'deny',
        reason: 'inline hot rule',
      }],
    }]
    const next = resolveConfig({ preset: 'balanced', rules: { inline, watch: false } })

    applyHotConfig(runtime, next, { packagedRulesDir, dir: '', inline }, runtime.logger)

    expect(runtime.engine.evaluateInput('inline-sentinel-phrase').kind).toBe('deny')
    expect(runtime.engine.ruleCount).toBe(21)
  })
})
