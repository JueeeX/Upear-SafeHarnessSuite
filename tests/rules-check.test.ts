/**
 * `/safeharness rules check [dir]` (1.15.0).
 *
 * Kernel parity with `rules_check.py`: an operator editing a rules directory by hand
 * can ask "would this load?" *before* a reload. A failed reload keeps the old rule set,
 * so without this the failure is easy to miss — the check runs the same loader the
 * reload path runs (packaged + `rules.dir` + `rules.inline`) and changes nothing.
 *
 * The tests drive the command handler, not a helper, because the contract is the text
 * and `kind` an operator sees.
 * @module
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { CommandResult } from '@deepseek-ai/dsh-commands'

import { createFakeHost } from './helpers/fake-host.js'
import { safeharnessCommand } from '../src/surface/commands.js'
import type { PostureReport } from '../src/posture/report.js'
import type { Runtime } from '../src/runtime.js'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'safeharness-rules-check-'))
let counter = 0

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

/** A directory with the given YAML files. */
function dirWith(files: Readonly<Record<string, string>>): string {
  counter += 1
  const directory = join(TEMP_ROOT, `rules-${counter}`)
  mkdirSync(directory, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content, 'utf8')
  return directory
}

/** One valid inform rule document. */
function validRule(name: string, pattern: string): string {
  return [
    'rules:',
    `  - name: ${name}`,
    `    pattern: '${pattern}'`,
    '    severity: high',
    '    category: prompt_injection',
    '    action: deny',
    "    reason: 'fixture'",
    '',
  ].join('\n')
}

/** A posture report the command factory requires but this surface never uses. */
function stubPosture(): PostureReport {
  return {
    ranAt: new Date().toISOString(),
    findings: [],
    summary: { fail: 0, warn: 0, ok: 0, skip: 0, clean: true },
  }
}

/** Build the command over one fake runtime. */
function commandOver(runtime: Runtime) {
  return safeharnessCommand(runtime, async () => stubPosture())
}

/** Run `/safeharness <raw>` through the real handler. */
async function run(runtime: Runtime, raw: string): Promise<CommandResult> {
  return commandOver(runtime).handler({
    rawInput: raw,
    commandId: 'c',
    agent: {},
    signal: new AbortController().signal,
  } as never) as Promise<CommandResult>
}

describe('/safeharness rules check', () => {
  it('passes a directory that loads, and reports the merged counts', async () => {
    const dir = dirWith({ 'good.yaml': validRule('op_good', 'ignore previous instructions') })
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const result = await run(runtime, `rules check ${dir}`)
    expect(result.kind).toBe('success')
    // 20 packaged rules + 1 operator rule; the check evaluates the merged set.
    expect(result.text).toContain('rules check: ok')
    expect(result.text).toContain('21 rules')
    expect(result.text).toContain('given directory')
  })

  it('fails a directory whose rule would be refused by the loader', async () => {
    const dir = dirWith({ 'bad.yaml': validRule('op_bad', '(a+)+') })
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const result = await run(runtime, `rules check ${dir}`)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('rules check: failed')
    expect(result.text).toContain('repeats a group')
    // The text says what did *not* happen, so the operator does not fear a partial apply.
    expect(result.text).toContain('nothing was loaded or changed')
  })

  it('defaults to the configured rules.dir when no argument is given', async () => {
    const dir = dirWith({ 'good.yaml': validRule('op_good', 'ignore previous instructions') })
    const { runtime } = createFakeHost({ config: { preset: 'balanced', rules: { dir } } })
    const result = await run(runtime, 'rules check')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('rules.dir')
    expect(result.text).toContain(dir)
  })

  it('refuses to check when nothing is configured and no argument was given', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced', rules: { dir: '' } } })
    const result = await run(runtime, 'rules check')
    expect(result.kind).toBe('error')
    expect(result.text).toContain('not configured')
    expect(result.text).toContain('/safeharness rules check <dir>')
  })

  it('treats a missing directory as an error, never as an empty pass', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const result = await run(runtime, `rules check ${join(TEMP_ROOT, 'does-not-exist')}`)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('directory not found')
  })

  it('does not disturb the plain `rules` listing', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const result = await run(runtime, 'rules')
    expect(result.kind).toBe('success')
    expect(result.text).toContain('ruleset')
  })
})
