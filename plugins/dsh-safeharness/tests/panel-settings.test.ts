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
    output: {
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
  }
  return {
    config,
    audit: vi.fn(),
    internalError: vi.fn(),
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
    const editor = { entries: () => [{ options: { id: 'safeharness', name: '@upear/dsh-safeharness' } }] }
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
    const editor = { entries: () => [{ options: { id: 'safeharness', name: '@upear/dsh-safeharness' } }] }
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
    const editor = { entries: () => [{ options: { id: 'safeharness', name: '@upear/dsh-safeharness' } }] }
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

  it('refuses invalid values before touching the host config', async () => {
    const update = vi.fn(async () => undefined)
    const editor = { entries: () => [{ options: { id: 'safeharness', name: '@upear/dsh-safeharness' } }] }
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
    const editor = { entries: () => [{ options: { id: 'safeharness', name: '@upear/dsh-safeharness' } }] }
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
    const update = vi.fn(async () => { throw new Error('disk full at C:\\secret') })
    const editor = { entries: () => [{ options: { id: 'safeharness', name: '@upear/dsh-safeharness' } }] }
    const host = createPanelSettingsHost(
      stubContext({ settings: stubSettings(update), configEditor: editor }) as never,
      stubRuntime(),
      logger,
    )
    await expect(host.save({ judge: { enabled: false } })).rejects.toEqual(
      expect.objectContaining({ code: 'settings_write_failed', message: 'the host rejected the configuration write' }),
    )
  })

  it('sends the revision the form was rendered at so a stale save is refused', async () => {
    const update = vi.fn(async () => undefined)
    const describe = () => [{ ns: 'safeharness', revision: 7, value: { preset: 'balanced' } }]
    const editor = { entries: () => [{ options: { id: 'safeharness', name: '@upear/dsh-safeharness' } }] }
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
    const editor = { entries: () => [{ options: { id: 'safeharness', name: '@upear/dsh-safeharness' } }] }
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
