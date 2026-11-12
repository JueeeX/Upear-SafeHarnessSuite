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
import type {
  PanelDraftSettings,
  PanelJudgeFact,
  PanelJudgeProbe,
  PanelJudgeSettings,
  PanelModelOption,
  PanelProviderOption,
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

/** Error codes the route maps to envelopes. */
export type PanelSettingsErrorCode =
  | 'settings_unavailable'
  | 'settings_readonly'
  | 'settings_invalid'
  | 'settings_write_failed'
  | 'probe_unavailable'

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

  const services = (): { settings?: SettingsServiceLike; editor?: ConfigEditorLike; llm?: LlmServiceLike } => {
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
    return {
      preset: cfg.preset,
      judge,
      draft,
      providers: await loadCatalog(llm),
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

  return { judgeFact, read, save, probe }
}
