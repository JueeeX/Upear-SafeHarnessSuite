/**
 * The panel's write path for the semantic judge and the drafting route.
 *
 * Reading is a plain projection of the resolved config + the host's model
 * catalog. Writing goes through the host's own `settings` service (the same
 * service the native Settings pages use), so a change lands in the profile
 * patch and hot-reloads through the normal loader path instead of this plugin
 * inventing a second configuration store.
 *
 * Everything here is defensive: a profile may compose no `llm` service, no
 * `settings` service, or expose no editable entry for this plugin. In all three
 * cases the tab stays readable and reports exactly why it is read-only.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Runtime } from '../runtime.js'
import type { Judge } from '../judge/client.js'
import { createJudgeFor } from '../hooks/llm.js'
import { JUDGE_PROBE_TEXT } from '../surface/commands.js'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveProviderIndexPath } from '../audit/paths.js'
import type {
  PanelCustomProvider,
  PanelDraftSettings,
  PanelJudgeFact,
  PanelJudgeProbe,
  PanelJudgeSettings,
  PanelModelOption,
  PanelProviderAdded,
  PanelProviderInput,
  PanelProviderOption,
  PanelProviderProtocol,
  PanelSettingsPatch,
  PanelSettingsValue,
} from './protocol.js'

/** Bounds keep a hostile or huge provider catalog out of the browser. */
const MAX_PROVIDERS = 24
const MAX_MODELS_PER_PROVIDER = 200
const MAX_MODEL_ROWS = 600
const MAX_ROUTE_CHARS = 200
const MODEL_CACHE_MS = 30_000

/** Judge input bounds accepted by a save (mirrors the config schema's intent). */
const MIN_MAX_CHARS = 500
const MAX_MAX_CHARS = 200_000
const MIN_TIMEOUT_MS = 500
const MAX_TIMEOUT_MS = 60_000

/** Custom-provider bounds and grammar. */
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/u
const MAX_DISPLAY_NAME = 80
const MAX_BASE_URL = 2_048
const MAX_MODEL_ID = 200
const MAX_API_KEY = 4_096
const PROVIDER_INDEX_VERSION = 1
const PROVIDER_PROTOCOLS: ReadonlySet<string> = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])

/** One persisted custom-provider record (the key itself is never stored here). */
interface CustomProviderRecord extends PanelCustomProvider {
  /** Credential reference name the route reads (`apiKeyEnv`). */
  readonly credentialRef: string
}

/** Structural slice of the host credential service (only the write paths used). */
interface CredentialsLike {
  set?: (ref: string, value: string) => Promise<void>
  unset?: (ref: string) => Promise<void>
}

/** Error codes the route maps to envelopes. */
export type PanelSettingsErrorCode =
  | 'settings_unavailable'
  | 'settings_readonly'
  | 'settings_invalid'
  | 'settings_write_failed'
  | 'probe_unavailable'
  | 'provider_unavailable'
  | 'provider_exists'
  | 'provider_in_use'
  | 'provider_not_found'

/** A typed failure the route turns into `{ ok: false, error }`. */
export class PanelSettingsError extends Error {
  readonly code: PanelSettingsErrorCode

  constructor(code: PanelSettingsErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Structural slice of the host `settings` service. */
interface SettingsServiceLike {
  readonly documentPath?: string
  describe?: (options?: { redactSecrets?: boolean }) => unknown
  update?: (ns: string, patch: Record<string, unknown>, expectedRevision?: number) => Promise<unknown>
  mutate?: (ns: string, ops: ReadonlyArray<{ readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }>, expectedRevision?: number) => Promise<unknown>
}

/** Structural slice of the host `configEditor` service. */
interface ConfigEditorLike {
  readonly documentPath?: string
  entries?: () => Array<{ options?: { id?: unknown; name?: unknown }; fiber?: unknown }>
}

/** Structural slice of the host `llm` service. */
interface LlmServiceLike {
  listProviders?: () => Array<Record<string, unknown>>
  listModels?: (provider: string) => Promise<Array<Record<string, unknown>>>
}

/** One provider/model catalog snapshot. */
interface Catalog {
  readonly at: number
  readonly providers: readonly PanelProviderOption[]
}

/** Read `id`/`name` off an unknown service row. */
function textOf(...values: readonly unknown[]): string | undefined {
  for (const value of values) if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

/** Resolve the profile entry id this plugin instance owns. */
function resolveNamespace(ctx: Context, settings: SettingsServiceLike, editor: ConfigEditorLike | undefined): string | undefined {
  try {
    const entries = editor?.entries?.() ?? []
    for (const entry of entries) {
      const name = typeof entry.options?.name === 'string' ? entry.options.name : ''
      if (name === '@upear/dsh-safeharness') {
        const id = entry.options?.id
        if (typeof id === 'string' && id.length > 0) return id
      }
    }
    // Fallback: the conventional entry id a profile uses for this plugin.
    if (entries.some(entry => entry.options?.id === 'safeharness')) return 'safeharness'
  } catch {
    // Fall through to the descriptor scan.
  }
  try {
    const described = settings.describe?.() as Array<{ ns?: unknown; schema?: unknown }> | undefined
    for (const descriptor of described ?? []) {
      if (typeof descriptor.ns !== 'string') continue
      const schema = JSON.stringify(descriptor.schema ?? {})
      if (schema.includes('"preset"') && schema.includes('"audit"') && schema.includes('"output"')) return descriptor.ns
    }
  } catch {
    // No editable entry: the caller reports read-only.
  }
  return undefined
}

/** Clamp an integer field, or throw a typed invalid-body error. */
function integerField(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new PanelSettingsError('settings_invalid', `${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

/** Validate an optional route string. */
function routeField(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new PanelSettingsError('settings_invalid', `${name} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > MAX_ROUTE_CHARS) throw new PanelSettingsError('settings_invalid', `${name} is too long`)
  return trimmed
}

/** Build the judge/probe surface the panel route calls. */
export interface PanelSettingsHost {
  /** Current judge facts (also used by the overview payload). */
  judgeFact(): PanelJudgeFact
  /** Read the editable settings plus the model catalog. */
  read(): Promise<PanelSettingsValue>
  /** Validate and persist a patch through the host settings service. */
  save(patch: PanelSettingsPatch): Promise<PanelSettingsValue>
  /** Add one hand-declared provider route (key goes to the credential store). */
  addProvider(input: PanelProviderInput): Promise<PanelProviderAdded>
  /** Remove one route this panel added. */
  deleteProvider(id: string): Promise<PanelProviderAdded>
  /** One real judge call over the configured route; status only. */
  probe(): Promise<PanelJudgeProbe>
}

/**
 * Build the settings host for one plugin instance.
 *
 * @param ctx - the plugin context (services are read lazily: `settings` is
 *   registered after this plugin in the real host).
 * @param runtime - shared runtime; judge/draft config is read through it so a
 *   hot reload is visible without rebuilding this object.
 * @param logger - plugin logger for persistence failures.
 */
export function createPanelSettingsHost(ctx: Context, runtime: Runtime, logger: { warn(message: string): void }): PanelSettingsHost {
  let catalog: Catalog | undefined
  let customProviders: CustomProviderRecord[] | undefined

  /** Read the plugin-owned provider index once (no key material in it). */
  const loadCustomProviders = (): CustomProviderRecord[] => {
    if (customProviders !== undefined) return customProviders
    const file = resolveProviderIndexPath()
    customProviders = []
    if (!existsSync(file)) return customProviders
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return customProviders
      const document = parsed as { version?: unknown; providers?: unknown }
      if (document.version !== PROVIDER_INDEX_VERSION || !Array.isArray(document.providers)) return customProviders
      for (const row of document.providers) {
        if (row === null || typeof row !== 'object') continue
        const value = row as Record<string, unknown>
        const id = value['id']
        const credentialRef = value['credentialRef']
        const api = value['api']
        const baseURL = value['baseURL']
        if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) continue
        if (typeof credentialRef !== 'string' || credentialRef.length === 0 || credentialRef.length > 200) continue
        if (typeof api !== 'string' || !PROVIDER_PROTOCOLS.has(api)) continue
        if (typeof baseURL !== 'string' || baseURL.length === 0) continue
        const models = Array.isArray(value['models'])
          ? value['models'].filter((model): model is string => typeof model === 'string' && model.length > 0)
          : []
        customProviders.push({
          id,
          displayName: typeof value['displayName'] === 'string' && value['displayName'].length > 0 ? value['displayName'] : id,
          api: api as PanelProviderProtocol,
          baseURL,
          models,
          addedAt: typeof value['addedAt'] === 'number' && Number.isFinite(value['addedAt']) ? value['addedAt'] : 0,
          credentialRef,
        })
      }
    } catch {
      // A broken index means "no routes known"; the host config remains the truth.
      customProviders = []
    }
    return customProviders
  }

  /** Persist the provider index atomically. */
  const writeCustomProviders = (rows: readonly CustomProviderRecord[]): void => {
    customProviders = [...rows]
    const file = resolveProviderIndexPath()
    try {
      mkdirSync(dirname(file), { recursive: true })
      const body = `${JSON.stringify({ version: PROVIDER_INDEX_VERSION, savedAt: Date.now(), providers: rows }, null, 0)}\n`
      const temporary = `${file}.tmp`
      writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, file)
    } catch (error) {
      logger.warn(`safeharness: could not write the provider index (${error instanceof Error ? error.message : String(error)})`)
    }
  }

  /** Resolve the profile entry id of the pi-ai provider plugin. */
  const resolveProviderNamespace = (editor: ConfigEditorLike | undefined): string | undefined => {
    try {
      const entries = editor?.entries?.() ?? []
      for (const entry of entries) {
        const name = typeof entry.options?.name === 'string' ? entry.options.name : ''
        if (name === '@deepseek-ai/dsh-llm-pi-ai') {
          const id = entry.options?.id
          if (typeof id === 'string' && id.length > 0) return id
        }
      }
      if (entries.some(entry => entry.options?.id === 'llm-pi-ai')) return 'llm-pi-ai'
    } catch {
      // Fall through: the caller reports read-only.
    }
    return undefined
  }

  /** Provider ids currently present in the live pi-ai config. */
  const liveProviderIds = (settings: SettingsServiceLike, piNs: string): Set<string> => {
    const ids = new Set<string>()
    try {
      const described = settings.describe?.() as Array<{ ns?: unknown; value?: unknown }> | undefined
      for (const descriptor of described ?? []) {
        if (descriptor.ns !== piNs) continue
        const value = descriptor.value as { providers?: unknown } | undefined
        const providers = value?.providers
        if (providers !== null && typeof providers === 'object' && !Array.isArray(providers)) {
          for (const id of Object.keys(providers)) ids.add(id)
        }
      }
    } catch {
      // The duplicate check also consults the plugin's own index below.
    }
    return ids
  }

  /** Credential reference name for a route id (POSIX-identifier shaped). */
  const credentialRefOf = (id: string): string => `SAFEHARNESS_${id.toUpperCase().replace(/-/gu, '_')}_API_KEY`

  const services = (): { settings?: SettingsServiceLike; editor?: ConfigEditorLike; llm?: LlmServiceLike; credentials?: CredentialsLike } => {
    const get = (name: string): unknown => {
      try {
        return ctx.get(name)
      } catch {
        return undefined
      }
    }
    return {
      settings: get('settings') as SettingsServiceLike | undefined,
      editor: get('configEditor') as ConfigEditorLike | undefined,
      llm: get('llm') as LlmServiceLike | undefined,
      credentials: get('credentials') as CredentialsLike | undefined,
    }
  }

  const judgeFact = (): PanelJudgeFact => {
    const cfg = runtime.config.output.judge
    const { llm } = services()
    return {
      enabled: cfg.enabled,
      scope: cfg.scope,
      provider: cfg.provider,
      model: cfg.model,
      available: llm !== undefined,
    }
  }

  const loadCatalog = async (llm: LlmServiceLike | undefined): Promise<readonly PanelProviderOption[]> => {
    if (llm === undefined || typeof llm.listProviders !== 'function') return []
    if (catalog !== undefined && Date.now() - catalog.at < MODEL_CACHE_MS) return catalog.providers
    const providers: PanelProviderOption[] = []
    let rows = 0
    try {
      for (const raw of llm.listProviders().slice(0, MAX_PROVIDERS)) {
        const id = textOf(raw['id'], raw['provider'])
        if (id === undefined) continue
        const name = textOf(raw['displayName'], raw['name'], raw['label'], id) ?? id
        let models: PanelModelOption[] = []
        if (typeof llm.listModels === 'function' && rows < MAX_MODEL_ROWS) {
          try {
            const advertised = await llm.listModels(id)
            models = advertised
              .slice(0, MAX_MODELS_PER_PROVIDER)
              .flatMap(model => {
                const modelId = textOf(model['id'])
                if (modelId === undefined) return []
                const modelName = textOf(model['name'], model['displayName'], modelId) ?? modelId
                return [{ id: modelId, name: modelName }]
              })
            rows += models.length
          } catch {
            // A provider that cannot enumerate models is still selectable by id.
          }
        }
        providers.push({ id, name, models })
      }
    } catch (error) {
      logger.warn(`safeharness: model catalog unavailable (${error instanceof Error ? error.message : String(error)})`)
    }
    catalog = { at: Date.now(), providers }
    return providers
  }

  const read = async (): Promise<PanelSettingsValue> => {
    const { settings, editor, llm } = services()
    const cfg = runtime.config
    const ns = settings === undefined ? undefined : resolveNamespace(ctx, settings, editor)
    const configurable = settings !== undefined && typeof settings.update === 'function' && ns !== undefined
    const piNs = resolveProviderNamespace(editor)
    const providerConfigurable = settings !== undefined && typeof settings.update === 'function' && piNs !== undefined
    const judge: PanelJudgeSettings = {
      enabled: cfg.output.judge.enabled,
      scope: cfg.output.judge.scope,
      provider: cfg.output.judge.provider,
      model: cfg.output.judge.model,
      maxChars: cfg.output.judge.maxChars,
      timeoutMs: cfg.output.judge.timeoutMs,
      available: llm !== undefined,
      configurable,
    }
    const draft: PanelDraftSettings = {
      enabled: cfg.draft.enabled,
      provider: cfg.draft.provider,
      model: cfg.draft.model,
    }
    const custom = loadCustomProviders().map(({ credentialRef: _credentialRef, ...row }) => row)
    return {
      preset: cfg.preset,
      judge,
      draft,
      providers: await loadCatalog(llm),
      customProviders: custom,
      providerConfigurable,
      configPath: configurable
        ? (settings?.documentPath ?? editor?.documentPath ?? null)
        : null,
    }
  }

  const save = async (patch: PanelSettingsPatch): Promise<PanelSettingsValue> => {
    const { settings, editor } = services()
    if (settings === undefined || typeof settings.update !== 'function') {
      throw new PanelSettingsError('settings_unavailable', 'this profile composes no settings service')
    }
    const ns = resolveNamespace(ctx, settings, editor)
    if (ns === undefined) {
      throw new PanelSettingsError('settings_readonly', 'no editable profile entry was found for this plugin')
    }
    const cfg = runtime.config
    const update: Record<string, unknown> = {}

    if (patch.judge !== undefined && patch.judge !== null) {
      const judge = patch.judge
      const next: Record<string, unknown> = {}
      if (judge.enabled !== undefined) {
        if (typeof judge.enabled !== 'boolean') throw new PanelSettingsError('settings_invalid', 'judge.enabled must be a boolean')
        next['enabled'] = judge.enabled
      }
      if (judge.scope !== undefined) {
        if (judge.scope !== 'flagged' && judge.scope !== 'always') throw new PanelSettingsError('settings_invalid', 'judge.scope must be flagged or always')
        next['scope'] = judge.scope
      }
      if (judge.provider !== undefined) next['provider'] = routeField(judge.provider, 'judge.provider')
      if (judge.model !== undefined) next['model'] = routeField(judge.model, 'judge.model')
      if (judge.maxChars !== undefined) next['maxChars'] = integerField(judge.maxChars, 'judge.maxChars', MIN_MAX_CHARS, MAX_MAX_CHARS)
      if (judge.timeoutMs !== undefined) next['timeoutMs'] = integerField(judge.timeoutMs, 'judge.timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const enabled = next['enabled'] === undefined ? cfg.output.judge.enabled : next['enabled'] === true
      const provider = typeof next['provider'] === 'string' ? next['provider'] : cfg.output.judge.provider
      const model = typeof next['model'] === 'string' ? next['model'] : cfg.output.judge.model
      if (enabled && (provider.length === 0 || model.length === 0)) {
        throw new PanelSettingsError('settings_invalid', 'enabling the judge requires both a provider and a model')
      }
      update['output'] = { judge: next }
    }

    if (patch.draft !== undefined && patch.draft !== null) {
      const draft = patch.draft
      const next: Record<string, unknown> = {}
      if (draft.enabled !== undefined) {
        if (typeof draft.enabled !== 'boolean') throw new PanelSettingsError('settings_invalid', 'draft.enabled must be a boolean')
        next['enabled'] = draft.enabled
      }
      if (draft.provider !== undefined) next['provider'] = routeField(draft.provider, 'draft.provider')
      if (draft.model !== undefined) next['model'] = routeField(draft.model, 'draft.model')
      update['draft'] = next
    }

    if (Object.keys(update).length === 0) throw new PanelSettingsError('settings_invalid', 'no supported field was supplied')

    try {
      await settings.update(ns, update)
    } catch (error) {
      logger.warn(`safeharness: settings write failed (${error instanceof Error ? error.message : String(error)})`)
      throw new PanelSettingsError('settings_write_failed', 'the host rejected the configuration write')
    }

    runtime.audit('invariant_probe', {
      decision: 'info',
      reason_code: 'panel_settings',
      labels: {
        state: 'settings_saved',
        judge: cfg.output.judge.enabled ? 'was_on' : 'was_off',
        ...(patch.judge?.enabled === undefined ? {} : { judge_next: patch.judge.enabled ? 'on' : 'off' }),
        ...(patch.draft === undefined ? {} : { draft_route: 'changed' }),
      },
    })
    // The loader reconcile is asynchronous; the caller sees the value it can
    // trust immediately and the panel refreshes on its next poll.
    return read()
  }

  /** Validate one hand-declared provider input; throws a typed error. */
  const validateProvider = (input: PanelProviderInput): { id: string; displayName: string; api: PanelProviderProtocol; baseURL: string; apiKey: string; model: string; modelName: string } => {
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!PROVIDER_ID_PATTERN.test(id)) throw new PanelSettingsError('settings_invalid', 'provider id must match [a-z][a-z0-9-]{1,39}')
    const api = input.api
    if (typeof api !== 'string' || !PROVIDER_PROTOCOLS.has(api)) {
      throw new PanelSettingsError('settings_invalid', 'api must be openai-completions, openai-responses or anthropic-messages')
    }
    const baseURL = typeof input.baseURL === 'string' ? input.baseURL.trim() : ''
    if (baseURL.length === 0 || baseURL.length > MAX_BASE_URL) throw new PanelSettingsError('settings_invalid', 'baseURL is empty or too long')
    let parsed: URL
    try {
      parsed = new URL(baseURL)
    } catch {
      throw new PanelSettingsError('settings_invalid', 'baseURL must be an absolute http(s) URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new PanelSettingsError('settings_invalid', 'baseURL must use http or https')
    if (parsed.username.length > 0 || parsed.password.length > 0) throw new PanelSettingsError('settings_invalid', 'baseURL must not embed credentials')
    const model = typeof input.model === 'string' ? input.model.trim() : ''
    if (model.length === 0 || model.length > MAX_MODEL_ID) throw new PanelSettingsError('settings_invalid', 'model id is required and bounded')
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    if (apiKey.length === 0 || apiKey.length > MAX_API_KEY || /[\r\n]/u.test(apiKey)) {
      throw new PanelSettingsError('settings_invalid', 'API key is required, bounded and must be a single line')
    }
    const displayName = (typeof input.displayName === 'string' ? input.displayName.trim() : '').slice(0, MAX_DISPLAY_NAME) || id
    const modelName = (typeof input.modelName === 'string' ? input.modelName.trim() : '').slice(0, MAX_MODEL_ID) || model
    return { id, displayName, api: api as PanelProviderProtocol, baseURL, apiKey, model, modelName }
  }

  /** Strip the credential reference before a record crosses the wire. */
  const publicProvider = (record: CustomProviderRecord): PanelCustomProvider => {
    const { credentialRef: _credentialRef, ...row } = record
    return row
  }

  /** Add one route to pi-ai and store its key in the host credential store. */
  const addProvider = async (input: PanelProviderInput): Promise<PanelProviderAdded> => {
    const value = validateProvider(input)
    const { settings, editor, credentials } = services()
    if (settings === undefined || typeof settings.update !== 'function' || typeof settings.describe !== 'function') {
      throw new PanelSettingsError('settings_unavailable', 'this profile composes no settings service')
    }
    const piNs = resolveProviderNamespace(editor)
    if (piNs === undefined) throw new PanelSettingsError('provider_unavailable', 'no editable pi-ai provider entry was found')
    if (liveProviderIds(settings, piNs).has(value.id) || loadCustomProviders().some(row => row.id === value.id)) {
      throw new PanelSettingsError('provider_exists', 'a provider route with that id already exists')
    }
    if (credentials === undefined || typeof credentials.set !== 'function') {
      throw new PanelSettingsError('provider_unavailable', 'this profile composes no writable credential store')
    }
    const credentialRef = credentialRefOf(value.id)
    try {
      await credentials.set(credentialRef, value.apiKey)
    } catch (error) {
      logger.warn(`safeharness: could not store the provider credential (${error instanceof Error ? error.message : String(error)})`)
      throw new PanelSettingsError('provider_unavailable', 'the host credential store rejected the key')
    }
    const profile = {
      api: value.api,
      baseURL: value.baseURL,
      apiKeyEnv: credentialRef,
      displayName: value.displayName,
      models: [{ id: value.model, name: value.modelName }],
      defaultInput: ['text'],
    }
    try {
      await settings.update(piNs, { providers: { [value.id]: profile } })
    } catch (error) {
      logger.warn(`safeharness: could not add the provider route (${error instanceof Error ? error.message : String(error)})`)
      try {
        await credentials.unset?.(credentialRef)
      } catch {
        // The orphan credential is harmless; the route was never written.
      }
      throw new PanelSettingsError('settings_write_failed', 'the host rejected the provider configuration')
    }
    const record: CustomProviderRecord = {
      id: value.id,
      displayName: value.displayName,
      api: value.api,
      baseURL: value.baseURL,
      models: [value.model],
      addedAt: Date.now(),
      credentialRef,
    }
    writeCustomProviders([...loadCustomProviders(), record])
    catalog = undefined
    runtime.audit('invariant_probe', {
      decision: 'info',
      reason_code: 'panel_provider',
      labels: { state: 'provider_added', provider: value.id, api: value.api },
    })
    let judgeRouteApplied = false
    if (input.useForJudge !== false) {
      try {
        await save({ judge: { enabled: true, provider: value.id, model: value.model } })
        judgeRouteApplied = true
      } catch (error) {
        logger.warn(`safeharness: provider added but the judge route was not applied (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    return { provider: publicProvider(record), settings: await read(), judgeRouteApplied }
  }

  /** Remove one route this panel added, and its credential. */
  const deleteProvider = async (id: string): Promise<PanelProviderAdded> => {
    const routeId = typeof id === 'string' ? id.trim() : ''
    const record = loadCustomProviders().find(row => row.id === routeId)
    if (record === undefined) throw new PanelSettingsError('provider_not_found', 'that route was not added by this panel')
    if (runtime.config.output.judge.provider === routeId || runtime.config.draft.provider === routeId) {
      throw new PanelSettingsError('provider_in_use', 'the route is still selected by the judge or the drafting route')
    }
    const { settings, editor, credentials } = services()
    if (settings === undefined || typeof settings.mutate !== 'function') {
      throw new PanelSettingsError('settings_unavailable', 'this profile composes no settings service')
    }
    const piNs = resolveProviderNamespace(editor)
    if (piNs === undefined) throw new PanelSettingsError('provider_unavailable', 'no editable pi-ai provider entry was found')
    try {
      await settings.mutate(piNs, [{ op: 'unset', path: ['providers', routeId] }])
    } catch (error) {
      logger.warn(`safeharness: could not remove the provider route (${error instanceof Error ? error.message : String(error)})`)
      throw new PanelSettingsError('settings_write_failed', 'the host rejected the provider removal')
    }
    try {
      await credentials?.unset?.(record.credentialRef)
    } catch {
      // Removing the route is the security-relevant half; an orphan key is inert.
    }
    writeCustomProviders(loadCustomProviders().filter(row => row.id !== routeId))
    catalog = undefined
    runtime.audit('invariant_probe', {
      decision: 'info',
      reason_code: 'panel_provider',
      labels: { state: 'provider_removed', provider: routeId },
    })
    return { provider: publicProvider(record), settings: await read(), judgeRouteApplied: false }
  }


  const probe = async (): Promise<PanelJudgeProbe> => {
    const started = Date.now()
    const cfg = runtime.config.output.judge
    const route = `${cfg.provider}/${cfg.model}`
    let judge: Judge
    try {
      judge = createJudgeFor(ctx, runtime)
    } catch {
      throw new PanelSettingsError('probe_unavailable', 'no judge handle in this profile')
    }
    if (!judge.available) {
      return { status: 'unavailable', verdict: 'unknown', blocked: false, route, elapsedMs: 0 }
    }
    const result = await judge.review(JUDGE_PROBE_TEXT, {
      maxChars: 4_096,
      timeoutMs: Math.max(MIN_TIMEOUT_MS, cfg.timeoutMs),
    })
    return {
      status: result.status,
      verdict: result.verdict,
      blocked: result.blocked,
      route,
      elapsedMs: Date.now() - started,
    }
  }

  return { judgeFact, read, save, addProvider, deleteProvider, probe }
}
