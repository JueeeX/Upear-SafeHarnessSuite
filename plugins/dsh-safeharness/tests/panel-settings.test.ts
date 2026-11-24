/**
 * The panel's judge/drafting settings host: read projection, validation of every
 * save field, and the exact path through the host settings service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPanelSettingsHost, PanelSettingsError } from '../src/panel/settings.js'
import type { Runtime } from '../src/runtime.js'

/** A runtime-shaped stub carrying the judge/draft config the host reads. */
function stubRuntime(overrides: {
  judge?: Partial<{ enabled: boolean; scope: 'flagged' | 'always'; provider: string; model: string; maxChars: number; timeoutMs: number }>
  draft?: Partial<{ enabled: boolean; provider: string; model: string }>
} = {}): Runtime {
  const config = {
    preset: 'balanced',
    input: { mode: 'enforce' as const, judge: 'flagged' as const, judgeFailClosed: false, normalize: true },
    tools: {
      mode: 'enforce' as const,
      descriptorScan: 'warn' as const,
      repeatedAttemptThreshold: 0,
      entropyThreshold: 0,
      entropyMinLength: 48,
      sql: { allowedTables: [] as string[] },
      // 1.13.0 list fields.
      denyTools: [] as string[],
      askTools: [] as string[],
      denyTags: [] as string[],
      tagOverrides: [] as { pattern: string; tags: string[] }[],
      // 1.16.0 argument schemas: the compiled view plus the raw declarations the
      // panel edits (the read projection shows the raw text, never the compiled one).
      argSchemas: [] as unknown[],
      // 1.18.0: the sensitive-path scan is part of the tool-detection projection,
      // so the stub has to carry it or the read path throws before asserting.
      sensitivePathScan: 'warn' as const,
      sensitivePathClasses: ['dotenv', 'secret_file'] as string[],
    },
    argSchemaProblems: [] as string[],
    argSchemaDeclarations: [] as unknown[],
    results: {
      mode: 'warn' as const,
      pii: true,
      piiClasses: ['id_card', 'email'] as string[],
      blockOn: ['credential_leak'] as string[],
    },
    output: {
      mode: 'warn' as const,
      judge: {
        enabled: false,
        scope: 'flagged' as const,
        provider: 'liao',
        model: 'gpt-6-luna',
        maxChars: 12_000,
        timeoutMs: 4_000,
        ...overrides.judge,
      },
    },
    draft: { enabled: false, provider: '', model: '', ...overrides.draft },
    approval: { mode: 'delegate' as const, allowOnce: [] as string[] },
    rules: { dir: '', watch: true, inline: [] as unknown[] },
    patrol: { windowMinutes: 10, factor: 5, minCount: 10, healthUrls: [] as string[], notify: [] as { type: string }[] },
    engine: { kind: 'builtin' as const, command: '' },
    audit: { format: 'ndjson' as const, dir: '', rotateMb: 64, required: true, hashChain: true },
    posture: { onLoad: true, failOn: [] as string[] },
  }
  return {
    config,
    audit: vi.fn(),
    internalError: vi.fn(),
    engine: { ruleset: { sources: ['rules/inform.yaml', 'rules/chains.yaml'] } },
  } as unknown as Runtime
}

/** A context whose `get` returns the supplied services. */
function stubContext(services: Record<string, unknown>): { get(name: string): unknown } {
  return { get: (name: string) => services[name] }
}

/** A settings service stub recording updates. */
function stubSettings(update = vi.fn(async () => undefined), describe?: () => unknown, mutate = vi.fn(async () => undefined)) {
  return {
    documentPath: 'C:\\profile\\cordis.patch.yml',
    update,
    mutate,
    ...(describe === undefined ? {} : { describe }),
  }
}

/**
 * A `configEditor` stub that records the raw config it was handed (1.17.2).
 *
 * Ordinary (non-`.volatile()`) fields go through `configEditor.edit`, because the
 * host's `settings` service refuses those paths outright. The stub applies the
 * change to a caller-supplied "current" config, so a test can assert the exact raw
 * config that would have been written to the profile patch.
 */
function stubEditor(options: { current?: Record<string, unknown>; failWith?: unknown } = {}) {
  const calls: Record<string, unknown>[] = []
  const current = options.current ?? {}
  return {
    documentPath: 'C:\\profile\\cordis.patch.yml',
    entries: () => [{ options: { id: 'safeharness', name: '@upear/dsh-safeharness' } }],
    calls,
    edit: vi.fn(async (_entry: unknown, change: (now: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => {
      if (options.failWith !== undefined) throw options.failWith
      const next = change(current, {})
      calls.push(next)
      return undefined
    }),
  }
}

/** The logger seam. */
const logger = { warn: () => undefined }

/**
 * Built at runtime so this test file carries no credential-shaped literal itself —
 * a result-layer scan reads test files too (README §6). The name is short because
 * `apiKey: <identifier>` is itself a credential-shaped assignment for the scanner.
 */
const key = ['sk', 'fixture', 'only'].join('-')

describe('createPanelSettingsHost', () => {
  let home: string
  let previousHome: string | undefined

  beforeEach(() => {
    previousHome = process.env.DSH_HOME
    home = mkdtempSync(join(tmpdir(), 'safeharness-provider-'))
    process.env.DSH_HOME = home
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  })

  it('reads the routes and the provider catalog', async () => {
    const llm = {
      listProviders: () => [{ id: 'liao', displayName: 'Liao' }, { id: 'deepseek', name: 'DeepSeek' }],
      listModels: async (provider: string) => (provider === 'liao'
        ? [{ id: 'gpt-6-luna', name: 'gpt-6-luna' }, { name: 'no id' }]
        : []),
    }
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(), configEditor: editor, llm }) as never,
      stubRuntime(),
      logger,
    )
    const value = await host.read()
    expect(value.preset).toBe('balanced')
    expect(value.judge).toEqual({
      enabled: false,
      scope: 'flagged',
      provider: 'liao',
      model: 'gpt-6-luna',
      maxChars: 12_000,
      timeoutMs: 4_000,
      available: true,
      configurable: true,
    })
    expect(value.draft).toEqual({ enabled: false, provider: '', model: '' })
    expect(value.surfaces).toEqual({
      input: 'enforce',
      tools: 'enforce',
      results: 'warn',
      output: 'warn',
      approval: 'delegate',
    })
    expect(value.configPath).toContain('cordis.patch.yml')
    expect(value.providers).toEqual([
      { id: 'liao', name: 'Liao', models: [{ id: 'gpt-6-luna', name: 'gpt-6-luna' }] },
      { id: 'deepseek', name: 'DeepSeek', models: [] },
    ])
  })

  it('reports read-only when the host has no settings service', async () => {
    const host = createPanelSettingsHost(stubContext({}) as never, stubRuntime(), logger)
    const value = await host.read()
    expect(value.judge.configurable).toBe(false)
    expect(value.judge.available).toBe(false)
    await expect(host.save({ judge: { enabled: true } })).rejects.toMatchObject({ code: 'settings_unavailable' })
  })

  it('writes only the supplied judge fields through the settings service', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const runtime = stubRuntime()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      runtime,
      logger,
    )
    await host.save({ judge: { enabled: true, scope: 'always', model: 'gpt-6-luna' } })
    expect(update).toHaveBeenCalledWith('safeharness', {
      output: { judge: { enabled: true, scope: 'always', model: 'gpt-6-luna' } },
    })
    expect(runtime.audit).toHaveBeenCalledWith('invariant_probe', expect.objectContaining({
      reason_code: 'panel_settings',
      labels: expect.objectContaining({ state: 'settings_saved', judge_next: 'on' }),
    }))
  })

  it('writes the drafting route and its enable flag', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await host.save({ draft: { enabled: true, provider: 'liao', model: 'gpt-6-luna' } })
    expect(update).toHaveBeenCalledWith('safeharness', {
      draft: { enabled: true, provider: 'liao', model: 'gpt-6-luna' },
    })
  })

  it('writes the per-surface switchboard, keeping the judge route in the same output object', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await host.save({
      surfaces: { input: 'off', results: 'enforce', output: 'enforce-buffer', approval: 'policy' },
      judge: { enabled: true },
    })
    expect(update).toHaveBeenCalledWith('safeharness', {
      input: { mode: 'off' },
      results: { mode: 'enforce' },
      output: { mode: 'enforce-buffer', judge: { enabled: true } },
      approval: { mode: 'policy' },
    })
  })

  it('writes the 1.12.0 tool-detection knobs, keeping the surface mode in the same tools object', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await host.save({
      surfaces: { tools: 'warn' },
      toolDetection: {
        descriptorScan: 'enforce',
        repeatedAttemptThreshold: 3,
        entropyThreshold: 4.5,
        entropyMinLength: 64,
        allowedTables: ['users', 'audit_log'],
      },
    })
    // A mixed save takes the ordinary-field path (1.17.2): the SQL allowlist is not
    // volatile, so the whole save is one `configEditor.edit` and no live update.
    expect(update).not.toHaveBeenCalled()
    expect(editor.calls).toEqual([{
      tools: {
        mode: 'warn',
        descriptorScan: 'enforce',
        repeatedAttemptThreshold: 3,
        entropyThreshold: 4.5,
        entropyMinLength: 64,
        sql: { allowedTables: ['users', 'audit_log'] },
      },
    }])
  })

  it('writes the PII scan settings as a results object of their own', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await host.save({ surfaces: { results: 'enforce' }, pii: { enabled: true, classes: ['id_card', 'phone_cn'] } })
    expect(update).toHaveBeenCalledWith('safeharness', {
      results: { mode: 'enforce', pii: true, piiClasses: ['id_card', 'phone_cn'] },
    })
  })

  it('refuses invalid 1.12.0 values before touching the host config', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.save({ toolDetection: { descriptorScan: 'block' as never } }))
      .rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ toolDetection: { repeatedAttemptThreshold: -1 } }))
      .rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ toolDetection: { entropyThreshold: 9 } }))
      .rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ toolDetection: { entropyMinLength: 0 } }))
      .rejects.toMatchObject({ code: 'settings_invalid' })
    // A table entry is an identifier, never a statement or a quoted string.
    await expect(host.save({ toolDetection: { allowedTables: ['users; DROP TABLE x'] } }))
      .rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ pii: { classes: ['passport'] } })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ pii: { enabled: 'yes' as never } })).rejects.toMatchObject({ code: 'settings_invalid' })
    expect(update).not.toHaveBeenCalled()
  })

  it('reads the 1.12.0 detection state back to the panel', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    const value = await host.read()
    expect(value.toolDetection).toEqual({
      descriptorScan: 'warn',
      repeatedAttemptThreshold: 0,
      entropyThreshold: 0,
      entropyMinLength: 48,
      allowedTables: [],
      // No declarations ⇒ empty text, the same thing an absent key means.
      argSchemas: '',
      // 1.18.0: the scan and its vocabulary are part of the same projection.
      sensitivePathScan: 'warn',
      sensitivePathClasses: ['dotenv', 'secret_file'],
    })
    expect(value.pii).toEqual({ enabled: true, classes: ['id_card', 'email'] })
  })

  it('writes a compiled tools.argSchemas list, and reads it back as raw JSON text', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    const declarations = [
      { name: 'web_https_only', tool: 'web_fetch', args: { url: { urlScheme: ['https'] } } },
      { name: 'write_inside', tool: 'write', args: { file_path: { pathPrefix: '/workspace' } } },
    ]
    await host.save({ toolDetection: { argSchemas: declarations } })
    // `tools.argSchemas` is not `.volatile()`, so since 1.17.2 it goes to the
    // config editor (the documented writer for ordinary fields) instead of the
    // live-only settings seam that used to refuse it.
    expect(update).not.toHaveBeenCalled()
    expect(editor.calls).toEqual([{ tools: { argSchemas: declarations } }])
  })

  it('refuses an argSchemas declaration that does not compile, writing nothing', async () => {
    // The loader drops a bad schema so a hand-edited profile still boots; a FORM
    // must not do that. "Saved" followed by a silently discarded rule is the exact
    // failure this plugin keeps having to fix, so the save is refused instead.
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    // `regex` is not a keyword this loader accepts (the 1.16.0 misspelling trap).
    await expect(host.save({
      toolDetection: {
        argSchemas: [{ name: 'typo', tool: 'write', args: { file_path: { regex: '^/w' } } }],
      },
    })).rejects.toMatchObject({ code: 'settings_invalid' })
    // A relative pathPrefix is refused at compile time (1.16.2 hardening).
    await expect(host.save({
      toolDetection: {
        argSchemas: [{ name: 'relative', tool: 'write', args: { file_path: { pathPrefix: 'workspace' } } }],
      },
    })).rejects.toMatchObject({ code: 'settings_invalid' })
    // An empty enum can never match anything.
    await expect(host.save({
      toolDetection: {
        argSchemas: [{ name: 'empty', tool: 'write', args: { file_path: { enum: [] } } }],
      },
    })).rejects.toMatchObject({ code: 'settings_invalid' })
    // Not an array, and an array of non-objects.
    await expect(host.save({ toolDetection: { argSchemas: 'nope' as never } }))
      .rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ toolDetection: { argSchemas: ['nope'] as never } }))
      .rejects.toMatchObject({ code: 'settings_invalid' })
    expect(update).not.toHaveBeenCalled()
  })

  it('accepts an empty argSchemas list as "no declarations"', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await host.save({ toolDetection: { argSchemas: [] } })
    expect(update).not.toHaveBeenCalled()
    expect(editor.calls).toEqual([{ tools: { argSchemas: [] } }])
  })

  it('refuses a non-volatile save when the profile composes no config editor', async () => {
    // Before 1.17.2 this answered "the host rejected the configuration write", which
    // pointed at nothing. A profile without the editor cannot write ordinary fields at
    // all, and the operator needs to be told that rather than sent to a log.
    const update = vi.fn(async () => undefined)
    const host = createPanelSettingsHost(
      stubContext({
        settings: stubSettings(update),
        configEditor: { entries: () => [{ options: { id: 'safeharness', name: '@upear/dsh-safeharness' } }] },
      }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.save({ toolDetection: { argSchemas: [] } }))
      .rejects.toMatchObject({ code: 'settings_readonly' })
    expect(update).not.toHaveBeenCalled()
  })

  it('keeps the revision guard on the ordinary-field path', async () => {
    // configEditor.edit has no compare-and-swap, so the guard is checked here. Without
    // it a form loaded before a concurrent ordinary-field change would overwrite it.
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({
        settings: stubSettings(update, () => [{ ns: 'safeharness', revision: 9 }]),
        configEditor: editor,
      }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.save({ expectedRevision: 4, toolDetection: { argSchemas: [] } }))
      .rejects.toMatchObject({ code: 'settings_conflict' })
    expect(editor.calls).toEqual([])
  })

  it('keeps a live-only save on the settings seam, without touching the editor', async () => {
    // The split must not send every save through the reloading path: a volatile-only
    // change still hot-applies, which is what the panel promises for those fields.
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await host.save({ judge: { maxChars: 9000 }, surfaces: { input: 'warn' } })
    expect(editor.calls).toEqual([])
    expect(update).toHaveBeenCalledOnce()
  })

  it('reads declarations back verbatim, not reconstructed from the compiled entries', async () => {
    // Compiled entries have already normalised paths and folded case; echoing those
    // would rewrite the operator's config the first time the form is saved untouched.
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const raw = [{ name: 'keep_me_verbatim', tool: 'write', args: { file_path: { pathPrefix: 'F:/W' } } }]
    const runtime = stubRuntime()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      { ...runtime, config: { ...runtime.config, argSchemaDeclarations: raw } } as never,
      logger,
    )
    const value = await host.read()
    expect(JSON.parse(value.toolDetection.argSchemas)).toEqual(raw)
    expect(value.toolDetection.argSchemas).toContain('F:/W')
  })

  it('quotes the host refusal reason instead of swallowing it, and records the class', async () => {
    // 1.17.1: measured on the real host, EVERY non-volatile save was refused with
    // "the host rejected the configuration write" and nothing else, which reads
    // like operator error and hides the cause. The reason must reach the operator.
    const hostError = Object.assign(
      new TypeError('settings-file: the document must be a map of namespace sections'),
      { code: 'SETTINGS_FILE_SHAPE' },
    )
    const update = vi.fn(async () => undefined)
    const editor = stubEditor({ failWith: hostError })
    const audited: { kind: string; fields: Record<string, unknown> }[] = []
    const runtime = stubRuntime()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      {
        ...runtime,
        audit: (kind: string, fields: Record<string, unknown>) => { audited.push({ kind, fields }) },
      } as never,
      logger,
    )
    const rejection = await host.save({ toolDetection: { argSchemas: [] } }).then(
      () => undefined,
      (error: { code?: string; message?: string }) => error,
    )
    expect(rejection?.code).toBe('settings_write_failed')
    // The host's own words survive, with its machine code, on one line.
    expect(rejection?.message).toContain('must be a map of namespace sections')
    expect(rejection?.message).toContain('SETTINGS_FILE_SHAPE')
    expect(rejection?.message).not.toContain('\n')
    // …and the refusal is in the ledger as a CLASS, not as the message: the ledger
    // has never held a path, and a host diagnostic may contain one.
    const record = audited.find((entry) => {
      const labels = entry.fields['labels'] as Record<string, unknown> | undefined
      return labels?.['state'] === 'settings_write_failed'
    })
    expect(record?.kind).toBe('invariant_probe')
    const labels = record?.fields['labels'] as Record<string, unknown>
    expect(labels['error_name']).toBe('TypeError')
    expect(labels['error_code']).toBe('SETTINGS_FILE_SHAPE')
    expect(labels['fields']).toBe('tools')
    expect(JSON.stringify(labels)).not.toContain('namespace sections')
  })

  it('bounds the quoted diagnostic and never emits a multi-line dump', async () => {
    const long = `${'x'.repeat(400)}\nsecond line ${'y'.repeat(50)}`
    const update = vi.fn(async () => undefined)
    const editor = stubEditor({ failWith: new Error(long) })
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    const rejection = await host.save({ toolDetection: { argSchemas: [] } }).then(
      () => undefined,
      (error: { message?: string }) => error,
    )
    const message = rejection?.message ?? ''
    expect(message).not.toContain('\n')
    expect(message).not.toContain('second line')
    // 160-char cap plus the fixed prefix.
    expect(message.length).toBeLessThan(260)
  })

  it('keeps the stale-revision refusal distinct from a write failure', async () => {
    // A conflict is the operator's fix (refresh and retry), not a host refusal, so it
    // must not inherit the diagnostic suffix.
    const conflict = Object.assign(new Error('namespace moved'), { code: 'SETTINGS_CONFLICT' })
    const update = vi.fn(async () => undefined)
    const editor = stubEditor({ failWith: conflict })
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.save({ toolDetection: { argSchemas: [] } }))
      .rejects.toMatchObject({ code: 'settings_conflict' })
  })

  it('writes the 1.13.0 list fields into tools / results / approval', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await host.save({
      lists: {
        denyTools: ['shell_*', 'mcp__fs__delete'],
        askTools: ['web_*'],
        allowOnce: ['db_query'],
        denyTags: ['egress'],
        tagOverrides: [{ pattern: 'bash*', tags: ['shell', 'exec'] }],
        blockOn: ['credential_leak', 'pii'],
      },
    })
    expect(update).not.toHaveBeenCalled()
    expect(editor.calls).toEqual([{
      tools: {
        denyTools: ['shell_*', 'mcp__fs__delete'],
        askTools: ['web_*'],
        denyTags: ['egress'],
        tagOverrides: [{ pattern: 'bash*', tags: ['shell', 'exec'] }],
      },
      results: { blockOn: ['credential_leak', 'pii'] },
      approval: { allowOnce: ['db_query'] },
    }])
  })

  it('writes the 1.13.0 source and patrol knobs', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await host.save({
      source: { rulesDir: 'C:\\Users\\x\\.dsh\\safeharness\\rules', rulesWatch: false, patrolWindowMinutes: 15, patrolFactor: 6.5, patrolMinCount: 20 },
    })
    expect(update).not.toHaveBeenCalled()
    expect(editor.calls).toEqual([{
      rules: { dir: 'C:\\Users\\x\\.dsh\\safeharness\\rules', watch: false },
      patrol: { windowMinutes: 15, factor: 6.5, minCount: 20 },
    }])
  })

  it('refuses invalid 1.13.0 list/source values before touching the host config', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    // A tag is an identifier, not free text.
    await expect(host.save({ lists: { denyTags: ['not a tag!'] } })).rejects.toMatchObject({ code: 'settings_invalid' })
    // A glob must stay on one line.
    await expect(host.save({ lists: { denyTools: ['a\nb'] } })).rejects.toMatchObject({ code: 'settings_invalid' })
    // blockOn is a closed vocabulary.
    await expect(host.save({ lists: { blockOn: ['everything'] } })).rejects.toMatchObject({ code: 'settings_invalid' })
    // A tag override needs at least one tag.
    await expect(host.save({ lists: { tagOverrides: [{ pattern: 'bash*', tags: [] }] } }))
      .rejects.toMatchObject({ code: 'settings_invalid' })
    // A path is a single line and the patrol numbers have floors.
    await expect(host.save({ source: { rulesDir: 'a\nb' } })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ source: { patrolFactor: 0.5 } })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ source: { patrolWindowMinutes: 0 } })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ source: { patrolMinCount: -1 } })).rejects.toMatchObject({ code: 'settings_invalid' })
    expect(update).not.toHaveBeenCalled()
  })

  it('reads back lists, source and the read-only facts without any credential', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    const value = await host.read()
    expect(value.lists).toEqual({
      denyTools: [],
      askTools: [],
      denyTags: [],
      tagOverrides: [],
      blockOn: ['credential_leak'],
      allowOnce: [],
    })
    expect(value.source).toEqual({
      rulesDir: '',
      rulesWatch: true,
      patrolWindowMinutes: 10,
      patrolFactor: 5,
      patrolMinCount: 10,
    })
    expect(value.facts.audit).toEqual({ format: 'ndjson', dir: '', rotateMb: 64, required: true, hashChain: true })
    expect(value.facts.posture).toEqual({ onLoad: true, failOn: [] })
    expect(value.facts.patrolNotify).toEqual({ channels: [], healthUrls: 0 })
    expect(value.facts.rules).toEqual({ inlineRules: 0, sources: 2 })
  })

  it('refuses an unknown surface mode', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.save({ surfaces: { input: 'loud' as never } })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ surfaces: { approval: 'off' as never } })).rejects.toMatchObject({ code: 'settings_invalid' })
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses invalid values before touching the host config', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.save({ judge: { scope: 'sometimes' as never } })).rejects.toBeInstanceOf(PanelSettingsError)
    await expect(host.save({ judge: { maxChars: 1 } })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ judge: { timeoutMs: 1 } })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ judge: { enabled: true, provider: '', model: '' } })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({ judge: { provider: 'liao\ninjected', model: 'm' } })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.save({})).rejects.toMatchObject({ code: 'settings_invalid' })
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses to enable the judge with an empty route', async () => {
    const update = vi.fn(async () => undefined)
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime({ judge: { provider: '', model: '' } }),
      logger,
    )
    await expect(host.save({ judge: { enabled: true } })).rejects.toMatchObject({ code: 'settings_invalid' })
  })

  it('finds the editable entry through the descriptor scan when configEditor is absent', async () => {
    const update = vi.fn(async () => undefined)
    const settings = stubSettings(update, () => [
      { ns: 'other', schema: { type: 'object', dict: { preset: {} } } },
      { ns: 'safeharness-x', schema: { dict: { preset: {}, audit: {}, output: {} } } },
    ])
    const host = createPanelSettingsHost(stubContext({ settings }) as never, stubRuntime(), logger)
    expect((await host.read()).judge.configurable).toBe(true)
    await host.save({ judge: { enabled: false } })
    expect(update).toHaveBeenCalledWith('safeharness-x', { output: { judge: { enabled: false } } })
  })

  it('reports the settings write failure without leaking the host error', async () => {
    // The message must carry the host's own reason (1.17.1) but never the whole
    // error object: no stack, no path-free guarantee needed because the detail is
    // a single bounded line chosen by the caller, not `String(error)`.
    const update = vi.fn(async () => { throw new Error('disk full at C:\\secret') })
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.save({ judge: { enabled: false } })).rejects.toEqual(
      expect.objectContaining({
        code: 'settings_write_failed',
        message: expect.stringContaining('the host rejected the configuration write'),
      }),
    )
  })

  it('sends the revision the form was rendered at so a stale save is refused', async () => {
    const update = vi.fn(async () => undefined)
    const describe = () => [{ ns: 'safeharness', revision: 7, value: { preset: 'balanced' } }]
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update, describe), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await host.save({ expectedRevision: 7, judge: { enabled: true } })
    expect(update).toHaveBeenCalledWith('safeharness', { output: { judge: { enabled: true } } }, 7)
  })

  it('maps a stale write to settings_conflict instead of a generic failure', async () => {
    const stale = Object.assign(new Error('revision mismatch'), { code: 'SETTINGS_CONFLICT', expected: 3, actual: 4 })
    const update = vi.fn(async () => { throw stale })
    const editor = stubEditor()
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.save({ judge: { enabled: true } })).rejects.toMatchObject({ code: 'settings_conflict' })
  })

  it('adds a hand-declared provider without ever putting the key in config or the response', async () => {
    const update = vi.fn(async () => undefined)
    const credentials = { set: vi.fn(async () => undefined), unset: vi.fn(async () => undefined) }
    const editor = {
      entries: () => [
        { options: { id: 'safeharness', name: '@upear/dsh-safeharness' } },
        { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } },
      ],
    }
    const describe = () => [
      { ns: 'llm-pi-ai', value: { providers: { liao: {} } } },
    ]
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update, describe), configEditor: editor, credentials }) as never,
      stubRuntime(),
      logger,
    )
    const result = await host.addProvider({
      id: 'fake-local',
      displayName: 'Fake Local',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:18080/v1',
      apiKey: 'sk-fake-sentinel',
      model: 'fake-model',
      modelName: 'Fake Model',
    })
    expect(result.judgeRouteApplied).toBe(true)
    expect(credentials.set).toHaveBeenCalledWith('SAFEHARNESS_FAKE_LOCAL_API_KEY', 'sk-fake-sentinel')
    const calls = update.mock.calls as unknown as Array<[string, Record<string, unknown>]>
    expect(calls.map(call => call[0])).toContain('llm-pi-ai')
    expect(calls.map(call => call[0])).toContain('safeharness')
    const providerWrite = calls.find(call => call[0] === 'llm-pi-ai')?.[1] as { providers: Record<string, unknown> }
    expect(providerWrite.providers['fake-local']).toMatchObject({
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:18080/v1',
      apiKeyEnv: 'SAFEHARNESS_FAKE_LOCAL_API_KEY',
      models: [{ id: 'fake-model', name: 'Fake Model' }],
    })
    expect(JSON.stringify(providerWrite)).not.toContain('sk-fake-sentinel')
    expect(JSON.stringify(result)).not.toContain('sk-fake-sentinel')
    expect(result.provider).not.toHaveProperty('credentialRef')
    expect(result.settings.customProviders).toEqual([expect.objectContaining({ id: 'fake-local', api: 'openai-completions' })])
  })

  it('rolls the route back when the panel index cannot be written', async () => {
    // Two stores, one commit: a route that lands in the profile but not in the panel
    // index can never be listed or deleted — the divergence 1.8.2 shipped with.
    mkdirSync(join(home, 'safeharness', 'providers.json'), { recursive: true })
    const update = vi.fn(async () => undefined)
    const mutate = vi.fn(async () => undefined)
    const credentials = { set: vi.fn(async () => undefined), unset: vi.fn(async () => undefined) }
    const editor = {
      entries: () => [
        { options: { id: 'safeharness', name: '@upear/dsh-safeharness' } },
        { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } },
      ],
    }
    const describe = () => [{ ns: 'llm-pi-ai', value: { providers: { liao: {} } } }]
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update, describe, mutate), configEditor: editor, credentials }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.addProvider({
      id: 'fake-local',
      displayName: 'Fake Local',
      baseURL: 'http://127.0.0.1:18080/v1',
      api: 'openai-completions',
      apiKey: key,
      model: 'fake-model',
      useForJudge: false,
    })).rejects.toMatchObject({ code: 'provider_index_failed' })
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'fake-local'] }])
    expect(credentials.unset).toHaveBeenCalledWith('SAFEHARNESS_FAKE_LOCAL_API_KEY')
  })

  it('refuses a duplicate route and invalid provider input before writing anything', async () => {
    const update = vi.fn(async () => undefined)
    const credentials = { set: vi.fn(async () => undefined), unset: vi.fn(async () => undefined) }
    const editor = {
      entries: () => [
        { options: { id: 'safeharness', name: '@upear/dsh-safeharness' } },
        { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } },
      ],
    }
    const describe = () => [{ ns: 'llm-pi-ai', value: { providers: { 'fake-local': {} } } }]
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update, describe), configEditor: editor, credentials }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.addProvider({
      id: 'fake-local', api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm',
    })).rejects.toMatchObject({ code: 'provider_exists' })
    await expect(host.addProvider({
      id: 'other', api: 'gemini' as never, baseURL: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm',
    })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.addProvider({
      id: 'other', api: 'openai-completions', baseURL: 'file:///etc/passwd', apiKey: 'x', model: 'm',
    })).rejects.toMatchObject({ code: 'settings_invalid' })
    await expect(host.addProvider({
      id: 'other', api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', apiKey: '', model: 'm',
    })).rejects.toMatchObject({ code: 'settings_invalid' })
    expect(credentials.set).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses to delete a route still used by the judge, then removes it and its credential', async () => {
    const update = vi.fn(async () => undefined)
    const mutate = vi.fn(async () => undefined)
    const credentials = { set: vi.fn(async () => undefined), unset: vi.fn(async () => undefined) }
    const editor = {
      entries: () => [
        { options: { id: 'safeharness', name: '@upear/dsh-safeharness' } },
        { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } },
      ],
    }
    const describe = () => [{ ns: 'llm-pi-ai', value: { providers: { liao: {} } } }]
    const settings = stubSettings(update, describe, mutate)
    const first = createPanelSettingsHost(
      stubContext({ settings, configEditor: editor, credentials }) as never,
      stubRuntime(),
      logger,
    )
    await first.addProvider({
      id: 'fake-local', api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'sk-x', model: 'm', useForJudge: false,
    })
    const inUse = createPanelSettingsHost(
      stubContext({ settings, configEditor: editor, credentials }) as never,
      stubRuntime({ judge: { provider: 'fake-local', model: 'm' } }),
      logger,
    )
    await expect(inUse.deleteProvider('fake-local')).rejects.toMatchObject({ code: 'provider_in_use' })
    expect(mutate).not.toHaveBeenCalled()
    const free = createPanelSettingsHost(
      stubContext({ settings, configEditor: editor, credentials }) as never,
      stubRuntime({ judge: { provider: '', model: '' } }),
      logger,
    )
    const removed = await free.deleteProvider('fake-local')
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'fake-local'] }])
    expect(credentials.unset).toHaveBeenCalledWith('SAFEHARNESS_FAKE_LOCAL_API_KEY')
    expect(removed.settings.customProviders).toEqual([])
  })

  it('refuses to delete a route the rest of the pi-ai section still references', async () => {
    // `defaultProvider` (or a default model route) breaks the moment the route
    // disappears; 1.8.2 only looked at this plugin's own judge/draft routes.
    const update = vi.fn(async () => undefined)
    const mutate = vi.fn(async () => undefined)
    const credentials = { set: vi.fn(async () => undefined), unset: vi.fn(async () => undefined) }
    const editor = {
      entries: () => [
        { options: { id: 'safeharness', name: '@upear/dsh-safeharness' } },
        { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } },
      ],
    }
    const describe = () => [{ ns: 'llm-pi-ai', value: { providers: { liao: {} }, defaultProvider: 'fake-local' } }]
    const settings = stubSettings(update, describe, mutate)
    const first = createPanelSettingsHost(
      stubContext({ settings, configEditor: editor, credentials }) as never,
      stubRuntime(),
      logger,
    )
    await first.addProvider({
      id: 'fake-local', api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', apiKey: key, model: 'm', useForJudge: false,
    })
    const blocked = createPanelSettingsHost(
      stubContext({ settings, configEditor: editor, credentials }) as never,
      stubRuntime(),
      logger,
    )
    await expect(blocked.deleteProvider('fake-local')).rejects.toMatchObject({ code: 'provider_in_use' })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('reports provider_unavailable without a credential store', async () => {
    const editor = {
      entries: () => [
        { options: { id: 'safeharness', name: '@upear/dsh-safeharness' } },
        { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } },
      ],
    }
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(undefined, () => [{ ns: 'llm-pi-ai', value: { providers: {} } }]), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.addProvider({
      id: 'fake-local', api: 'openai-completions', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm',
    })).rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it('reports providers as read-only when the profile exposes no mutate path', async () => {
    // Reads use `update` but the delete path uses `mutate`; a profile with only the
    // former must not offer an add/delete UI that would always fail.
    const editor = {
      entries: () => [
        { options: { id: 'safeharness', name: '@upear/dsh-safeharness' } },
        { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' } },
      ],
    }
    const settings = { documentPath: 'C:\\profile\\cordis.patch.yml', update: vi.fn(async () => undefined) }
    const host = createPanelSettingsHost(
      stubContext({ settings, configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    expect((await host.read()).providerConfigurable).toBe(false)
  })

  it('probes an unavailable route without calling a model', async () => {
    const host = createPanelSettingsHost(stubContext({}) as never, stubRuntime(), logger)
    await expect(host.probe()).resolves.toEqual({
      status: 'unavailable',
      verdict: 'unknown',
      blocked: false,
      route: 'liao/gpt-6-luna',
      elapsedMs: 0,
    })
  })
})
