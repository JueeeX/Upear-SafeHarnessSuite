/**
 * The panel's rule writer (D62): only `rules.dir`, only whitelisted names, no
 * overwrite by default, loader gate before any byte lands, atomic write, metadata
 * audit and a hot reload.
 *
 * Every fixture lives under the OS temp dir and is removed in `afterAll`; nothing
 * here writes inside the repository.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createRuleWriter, MAX_RULE_YAML_CHARS, RuleWriteError } from '../src/panel/rules-write.js'
import type { Runtime } from '../src/runtime.js'

const TEMP_ROOT = mkdtempSync(join(tmpdir(), 'safeharness-writer-'))
let counter = 0

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true })
})

/** A fresh directory under the temp root, optionally populated. */
function fixture(files: Readonly<Record<string, string>> = {}): string {
  counter += 1
  const directory = join(TEMP_ROOT, `dir-${counter}`)
  mkdirSync(directory, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text, 'utf8')
  return directory
}

/** The packaged layer: one valid rule, so the merged set is never inert. */
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

/** One valid operator document. */
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

/** A runtime stub with a *live* `rules.dir` (the writer re-reads it per call). */
function stubRuntime(initialDir: string): {
  readonly runtime: Runtime
  readonly setDir: (dir: string) => void
  readonly audit: ReturnType<typeof vi.fn>
} {
  let dir = initialDir
  const audit = vi.fn()
  const runtime = {
    get config() {
      return { rules: { dir, inline: [] as readonly unknown[] } }
    },
    audit,
  } as unknown as Runtime
  return { runtime, setDir: (next: string) => { dir = next }, audit }
}

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }

/** One writer plus its recording reload callback. */
function makeWriter(options: {
  readonly dir: string
  readonly packaged?: string
  readonly reload?: () => { readonly rules: number; readonly chains: number; readonly hash: string }
}): {
  readonly writer: ReturnType<typeof createRuleWriter>
  readonly setDir: (dir: string) => void
  readonly audit: ReturnType<typeof vi.fn>
  readonly reload: ReturnType<typeof vi.fn>
} {
  const { runtime, setDir, audit } = stubRuntime(options.dir)
  const reload = vi.fn(options.reload ?? (() => ({ rules: 2, chains: 1, hash: 'abc123456789' })))
  const writer = createRuleWriter({
    runtime,
    packagedRulesDir: options.packaged ?? packagedDir(),
    reload,
    logger,
  })
  return { writer, setDir, audit, reload }
}

describe('createRuleWriter: target selection', () => {
  it('refuses an unconfigured rules.dir', async () => {
    const { writer, audit } = makeWriter({ dir: '' })
    await expect(writer.write({ filename: 'a.yaml', yaml: ruleDocument('a'), overwrite: false }))
      .rejects.toMatchObject({ code: 'rules_dir_unconfigured' })
    expect(audit).not.toHaveBeenCalled()
  })

  it('refuses a relative rules.dir', async () => {
    const { writer } = makeWriter({ dir: 'relative/rules' })
    await expect(writer.write({ filename: 'a.yaml', yaml: ruleDocument('a'), overwrite: false }))
      .rejects.toMatchObject({ code: 'rules_dir_not_absolute' })
  })

  it('refuses a rules.dir inside the packaged directory', async () => {
    const packaged = packagedDir()
    for (const dir of [packaged, join(packaged, 'nested')]) {
      const { writer } = makeWriter({ dir, packaged })
      await expect(writer.write({ filename: 'a.yaml', yaml: ruleDocument('a'), overwrite: false }), dir)
        .rejects.toMatchObject({ code: 'rules_dir_packaged' })
    }
  })

  it('follows the live config when rules.dir changes after wiring', async () => {
    const first = fixture()
    const second = fixture()
    const { writer, setDir } = makeWriter({ dir: first })
    setDir(second)
    const value = await writer.write({ filename: 'live.yaml', yaml: ruleDocument('live_rule'), overwrite: false })
    expect(value.filename).toBe('live.yaml')
    expect(existsSync(join(second, 'live.yaml'))).toBe(true)
    expect(existsSync(join(first, 'live.yaml'))).toBe(false)
  })
})

describe('createRuleWriter: file names', () => {
  it('rejects anything that is not one lower-case YAML token', async () => {
    const { writer, audit } = makeWriter({ dir: fixture() })
    const bad = [
      '../escape.yaml',
      '..\\escape.yaml',
      'nested/file.yaml',
      'nested\\file.yaml',
      'C:\\abs.yaml',
      'Upper.yaml',
      '.hidden.yaml',
      'con.yaml',
      'rule.txt',
      'rule',
      `${'a'.repeat(70)}.yaml`,
      '',
    ]
    for (const filename of bad) {
      await expect(writer.write({ filename, yaml: ruleDocument('x'), overwrite: false }), JSON.stringify(filename))
        .rejects.toMatchObject({ code: 'filename_invalid' })
    }
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('createRuleWriter: content gate', () => {
  it('writes nothing when the loader rejects the rule', async () => {
    const dir = fixture()
    const { writer, audit, reload } = makeWriter({ dir })
    const failure = writer.write({ filename: 'bad.yaml', yaml: ruleDocument('bad', '(?i)secret'), overwrite: false })
    await expect(failure).rejects.toBeInstanceOf(RuleWriteError)
    await expect(failure).rejects.toMatchObject({ code: 'rule_content_invalid' })
    // The problems ride along so the operator can fix the draft.
    const error = await failure.catch((cause: unknown) => cause) as RuleWriteError
    expect(error.problems.length).toBeGreaterThan(0)
    expect(readdirSync(dir)).toEqual([])
    expect(audit).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('rejects an empty or oversized body before touching the disk', async () => {
    const dir = fixture()
    const { writer } = makeWriter({ dir })
    await expect(writer.write({ filename: 'empty.yaml', yaml: '   \n', overwrite: false }))
      .rejects.toMatchObject({ code: 'rule_content_invalid' })
    await expect(writer.write({ filename: 'huge.yaml', yaml: `# ${'x'.repeat(MAX_RULE_YAML_CHARS)}\n`, overwrite: false }))
      .rejects.toMatchObject({ code: 'rule_content_invalid' })
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('createRuleWriter: landing a file', () => {
  it('writes the exact bytes, audits metadata and reloads', async () => {
    const dir = fixture()
    const { writer, audit, reload } = makeWriter({ dir })
    const yaml = ruleDocument('operator_landed')
    const value = await writer.write({ filename: 'landed.yaml', yaml, overwrite: false })

    expect(readFileSync(join(dir, 'landed.yaml'), 'utf8')).toBe(yaml)
    expect(value).toEqual({
      filename: 'landed.yaml',
      bytes: Buffer.byteLength(yaml, 'utf8'),
      rules: 2,
      chains: 1,
      hash: 'abc123456789',
      created: true,
      reloaded: true,
    })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith('rules_written', expect.objectContaining({
      decision: 'ok',
      reason_code: 'panel_rule_write',
      labels: expect.objectContaining({ file: 'landed.yaml', mode: 'create' }),
      metrics: expect.objectContaining({ bytes: Buffer.byteLength(yaml, 'utf8') }),
    }))
    // No temporary file survives the rename.
    expect(readdirSync(dir)).toEqual(['landed.yaml'])
  })

  it('refuses to replace an existing file unless the write is confirmed', async () => {
    const dir = fixture({ 'existing.yaml': ruleDocument('existing_rule') })
    const { writer } = makeWriter({ dir })

    await expect(writer.write({ filename: 'existing.yaml', yaml: ruleDocument('replacement'), overwrite: false }))
      .rejects.toMatchObject({ code: 'rule_exists' })
    // Nothing changed on disk.
    expect(readFileSync(join(dir, 'existing.yaml'), 'utf8')).toBe(ruleDocument('existing_rule'))

    const value = await writer.write({ filename: 'existing.yaml', yaml: ruleDocument('replacement'), overwrite: true })
    expect(value.created).toBe(false)
    expect(readFileSync(join(dir, 'existing.yaml'), 'utf8')).toBe(ruleDocument('replacement'))
  })

  it('keeps the file when the reload fails, and says so', async () => {
    const dir = fixture()
    const { writer, audit } = makeWriter({
      dir,
      reload: () => { throw new Error('loader refused the merged set') },
    })
    const value = await writer.write({ filename: 'landed.yaml', yaml: ruleDocument('operator_landed'), overwrite: false })
    expect(value.reloaded).toBe(false)
    // Counts fall back to the validated candidate (the previous set is still live).
    expect(value.rules).toBe(2)
    expect(existsSync(join(dir, 'landed.yaml'))).toBe(true)
    const kinds = audit.mock.calls.map(call => call[0] as string)
    expect(kinds).toContain('rules_written')
    expect(kinds).toContain('invariant_probe')
  })

  it('creates the rules directory when it does not exist yet', async () => {
    const parent = fixture()
    const dir = join(parent, 'operator-rules')
    const { writer } = makeWriter({ dir })
    await writer.write({ filename: 'first.yaml', yaml: ruleDocument('first_rule'), overwrite: false })
    expect(existsSync(join(dir, 'first.yaml'))).toBe(true)
  })
})
