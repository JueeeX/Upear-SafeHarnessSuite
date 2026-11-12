/**
 * The panel's judge/drafting settings host: read projection, validation of every
 * save field, and the exact path through the host settings service.
 */
import { describe, expect, it, vi } from 'vitest'
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
function stubSettings(update = vi.fn(async () => undefined), describe?: () => unknown) {
  return {
    documentPath: 'C:\\profile\\cordis.patch.yml',
    update,
    ...(describe === undefined ? {} : { describe }),
  }
}

/** The logger seam. */
const logger = { warn: () => undefined }

describe('createPanelSettingsHost', () => {
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
