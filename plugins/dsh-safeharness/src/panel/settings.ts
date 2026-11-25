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
import { isVolatileConfigPath, MAX_JUDGE_MAX_TOKENS, mergeConfigLayers } from '../config.js'
import { isSensitivePathClass } from '../engine/sensitive-path.js'
import { dirname } from 'node:path'
import { resolveProviderIndexPath } from '../audit/paths.js'
import { PII_CLASS_NAMES } from '../engine/pii.js'
import {
  compileArgSchemas,
  MAX_ARG_SCHEMAS,
  type ArgSchemaDeclaration,
} from '../engine/argschema.js'
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
  PanelSurfaceSettings,
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

/** Tool-detection bounds accepted by a save (1.12.0). */
const MAX_FAILURE_THRESHOLD = 1_000
const MAX_ENTROPY_THRESHOLD = 8
const MAX_ENTROPY_MIN_LENGTH = 1_000_000
const MAX_ALLOWED_TABLES = 200
const MAX_TABLE_CHARS = 128
/** A table reference the allowlist accepts: identifier chars, dots and dashes. */
const TABLE_PATTERN = /^[A-Za-z0-9_$.-]{1,128}$/u

/** List/pattern bounds accepted by a save (1.13.0). */
const MAX_LIST_ENTRIES = 200
const MAX_PATTERN_CHARS = 200
const MAX_TAG_CHARS = 64
const MAX_TAG_OVERRIDES = 50
const MAX_DIR_CHARS = 1_000
/** A semantic tag: lowercase-ish identifier, dots/colons allowed (`fs`, `egress`, `mcp:write`). */
const TAG_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u
/** Result categories `results.blockOn` may name (mirrors the config schema). */
const RESULT_CATEGORIES: readonly string[] = ['credential_leak', 'injection_marker', 'pii']
/** Patrol bounds (the check is a rate window; these are sanity limits, not policy). */
const MAX_PATROL_MINUTES = 10_080
const MAX_PATROL_FACTOR = 1_000
const MAX_PATROL_COUNT = 1_000_000

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
  | 'settings_conflict'
  | 'probe_unavailable'
  | 'provider_unavailable'
  | 'provider_exists'
  | 'provider_in_use'
  | 'provider_not_found'
  | 'provider_index_failed'

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
  /**
   * Persist a complete raw config and apply it through the normal Loader path
   * (1.17.2). This is the documented writer for *ordinary* config fields; the
   * `settings` service accepts live (`.volatile()`) fields only.
   */
  edit?: (
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ) => Promise<void>
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
  if (/[\r\n]/u.test(trimmed)) throw new PanelSettingsError('settings_invalid', `${name} must be a single line`)
  if (trimmed.length > MAX_ROUTE_CHARS) throw new PanelSettingsError('settings_invalid', `${name} is too long`)
  return trimmed
}

/**
 * Validate a finite number field (the entropy threshold is not an integer).
 *
 * @param value - candidate value from the browser.
 * @param name - dotted field name used in the refusal message.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the number, unchanged.
 */
function numberField(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new PanelSettingsError('settings_invalid', `${name} must be a number between ${min} and ${max}`)
  }
  return value
}

/**
 * Validate the SQL table allowlist.
 *
 * The engine compares entries case-insensitively and on the bare table name, so the
 * panel only has to refuse what could never be a table reference (whitespace, SQL
 * punctuation, control characters) and keep the list bounded. An empty list is
 * meaningful: it means "no restriction", exactly like the config default.
 */
function tableListField(value: unknown): string[] {
  if (!Array.isArray(value)) throw new PanelSettingsError('settings_invalid', 'toolDetection.allowedTables must be an array')
  if (value.length > MAX_ALLOWED_TABLES) {
    throw new PanelSettingsError('settings_invalid', `toolDetection.allowedTables accepts at most ${MAX_ALLOWED_TABLES} entries`)
  }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new PanelSettingsError('settings_invalid', 'toolDetection.allowedTables entries must be strings')
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    if (trimmed.length > MAX_TABLE_CHARS || !TABLE_PATTERN.test(trimmed)) {
      throw new PanelSettingsError('settings_invalid', 'toolDetection.allowedTables entries must be table identifiers (letters, digits, _ $ . -)')
    }
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** Validate the enabled PII class subset against the kernel vocabulary. */
function piiClassesField(value: unknown): string[] {
  if (!Array.isArray(value)) throw new PanelSettingsError('settings_invalid', 'pii.classes must be an array')
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !PII_CLASS_NAMES.includes(entry)) {
      throw new PanelSettingsError('settings_invalid', `pii.classes only accepts ${PII_CLASS_NAMES.join(', ')}`)
    }
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

/**
 * Validate one tool-name glob list (`denyTools` / `askTools` / `allowOnce`).
 *
 * The matcher only treats `*` as a wildcard and every other character literally, so
 * validation is about shape: a single-line, bounded, non-empty entry. An empty list
 * is legal and means "match nothing".
 */
function globListField(value: unknown, name: string): string[] {
  return listField(value, name, (entry) => {
    if (/[\r\n\u0000]/u.test(entry)) throw new PanelSettingsError('settings_invalid', `${name} entries must be single-line`)
    if (entry.length > MAX_PATTERN_CHARS) throw new PanelSettingsError('settings_invalid', `${name} entries are too long`)
  })
}

/** Validate a semantic-tag list (`denyTags`): identifiers only. */
function tagListField(value: unknown, name: string): string[] {
  return listField(value, name, (entry) => {
    if (!TAG_PATTERN.test(entry)) {
      throw new PanelSettingsError('settings_invalid', `${name} only accepts tag identifiers (letters, digits, _ . : -)`)
    }
  })
}

/** Shared list plumbing: array of strings → trimmed, de-duplicated, bounded. */
function listField(value: unknown, name: string, check: (entry: string) => void): string[] {
  if (!Array.isArray(value)) throw new PanelSettingsError('settings_invalid', `${name} must be an array`)
  if (value.length > MAX_LIST_ENTRIES) {
    throw new PanelSettingsError('settings_invalid', `${name} accepts at most ${MAX_LIST_ENTRIES} entries`)
  }
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new PanelSettingsError('settings_invalid', `${name} entries must be strings`)
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    check(trimmed)
    if (!out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** Validate `tools.tagOverrides`: one `{ pattern, tags[] }` per entry, tags non-empty. */
function tagOverridesField(value: unknown): { pattern: string; tags: string[] }[] {
  if (!Array.isArray(value)) throw new PanelSettingsError('settings_invalid', 'lists.tagOverrides must be an array')
  if (value.length > MAX_TAG_OVERRIDES) {
    throw new PanelSettingsError('settings_invalid', `lists.tagOverrides accepts at most ${MAX_TAG_OVERRIDES} entries`)
  }
  const out: { pattern: string; tags: string[] }[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') {
      throw new PanelSettingsError('settings_invalid', 'lists.tagOverrides entries need { pattern, tags }')
    }
    const record = entry as { pattern?: unknown; tags?: unknown }
    if (typeof record.pattern !== 'string') {
      throw new PanelSettingsError('settings_invalid', 'lists.tagOverrides[].pattern must be a string')
    }
    const pattern = record.pattern.trim()
    if (pattern.length === 0 || pattern.length > MAX_PATTERN_CHARS || /[\r\n\u0000]/u.test(pattern)) {
      throw new PanelSettingsError('settings_invalid', 'lists.tagOverrides[].pattern must be a non-empty single line')
    }
    const tags = tagListField(record.tags, 'lists.tagOverrides[].tags')
    if (tags.length === 0) {
      throw new PanelSettingsError('settings_invalid', 'lists.tagOverrides[].tags needs at least one tag')
    }
    if (tags.some((tag) => tag.length > MAX_TAG_CHARS)) {
      throw new PanelSettingsError('settings_invalid', 'lists.tagOverrides[].tags entries are too long')
    }
    out.push({ pattern, tags })
  }
  return out
}

/** Validate `results.blockOn` against the closed category vocabulary. */
function blockOnField(value: unknown): string[] {
  if (!Array.isArray(value)) throw new PanelSettingsError('settings_invalid', 'lists.blockOn must be an array')
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !RESULT_CATEGORIES.includes(entry)) {
      throw new PanelSettingsError('settings_invalid', `lists.blockOn only accepts ${RESULT_CATEGORIES.join(', ')}`)
    }
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

/**
 * Validate the `tools.argSchemas` declarations a save would write (1.17.0).
 *
 * Why validate at all when the loader already drops a bad schema: dropping is the
 * right behaviour for a hand-edited profile (one typo must not block the load), and
 * the wrong behaviour for a form. An operator who types a schema into a form and
 * presses save must not be told "saved" while the plugin quietly discarded it — so
 * this runs the loader's own compiler and refuses the whole write when any entry
 * fails. `compileArgSchemas` is the same function the deployment uses, so the form
 * and the loader can never disagree about what compiles.
 *
 * The bounds mirror the schema's own caps (declaration count, args per declaration,
 * bounds per argument, list entries) so a hostile payload cannot reach the compiler
 * at all, and every message names the schema, the argument and the keyword — never
 * a value.
 */
function argSchemasField(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new PanelSettingsError('settings_invalid', 'tools.argSchemas must be an array')
  }
  if (value.length > MAX_ARG_SCHEMAS) {
    throw new PanelSettingsError('settings_invalid', `tools.argSchemas accepts at most ${MAX_ARG_SCHEMAS} entries`)
  }
  // A shallow structural guard first: the compiler tolerates junk by dropping it,
  // but a form submission should be refused before anything is persisted.
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new PanelSettingsError('settings_invalid', 'tools.argSchemas entries must be objects')
    }
  }
  const { problems } = compileArgSchemas(value as ArgSchemaDeclaration[])
  if (problems.length > 0) {
    // Name the first problem only (the rest are in the posture report if this ever
    // reaches the loader); a form refusal should read like one sentence.
    const [first] = problems
    throw new PanelSettingsError('settings_invalid', `tools.argSchemas: ${first ?? 'declaration did not compile'}`)
  }
  return value as unknown[]
}

/**
 * Serialise the declarations for the panel form: pretty JSON, one schema per block.
 *
 * JSON rather than the YAML the profile uses, because the browser half has no YAML
 * emitter and the plugin's own parser rejects flow sequences (`[https]`), which is
 * exactly the shape a compact schema wants. JSON is also what `JSON.parse` in the
 * browser can round-trip without a second grammar, so the form can validate the
 * text before it is sent (and refuse to save text it cannot even parse).
 */
function argSchemasText(declarations: readonly unknown[]): string {
  return declarations.length === 0 ? '' : JSON.stringify(declarations, null, 2)
}


function directoryField(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new PanelSettingsError('settings_invalid', `${name} must be a string`)
  const trimmed = value.trim()
  if (trimmed.length > MAX_DIR_CHARS) throw new PanelSettingsError('settings_invalid', `${name} is too long`)
  if (/[\r\n\u0000]/u.test(trimmed)) throw new PanelSettingsError('settings_invalid', `${name} must be a single line`)
  return trimmed
}

/**
 * Log-safe description of a host failure.
 *
 * The plugin's zero-echo rule (README §6) covers logs too: a host error message can
 * quote a profile path, a config value or a fragment of the document it refused, so
 * only the error name, a machine code (when short) and the message *length* are
 * logged. The ledger records the same coarse facts; an operator who needs the text
 * reads the host's own log.
 *
 * @param error - whatever a host call threw.
 * @returns a short, content-free description.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return `non-error/${String(error).length} chars`
  const code = (error as { code?: unknown }).code
  const parts = [
    error.name.length > 0 ? error.name : 'Error',
    typeof code === 'string' && code.length > 0 && code.length <= 64 ? code : '',
    `${error.message.length} chars`,
  ]
  return parts.filter(part => part.length > 0).join(', ')
}

/**
 * Longest host diagnostic quoted back to the operator.
 *
 * Sized so the whole envelope message stays under the route's 200-char cap:
 * "the host rejected the configuration write — " is 46, an `Error [CODE]: ` prefix
 * is at most ~40, so 110 leaves room. Truncating is better than letting the route
 * cut the tail, which would drop the part that names the cause.
 */
const MAX_WRITE_DIAGNOSTIC = 110

/**
 * The operator-facing half of a refused settings write (1.17.1).
 *
 * Why this exists: until 1.17.0 the panel answered every refusal with "the host
 * rejected the configuration write" and nothing else. That is the same failure this
 * plugin keeps having to fix — a useless message that reads like operator error and
 * hides the actual reason. Measured 2026-11-24: *every* non-volatile save (deny
 * lists, tag overrides, the SQL allowlist, `rules.dir`, `argSchemas`) was refused
 * while every `volatile` field saved, and the message made that indistinguishable
 * from a typo.
 *
 * What may be quoted: the host's own diagnostic, bounded and trimmed to one line.
 * Those messages are configuration validation ("... must be a map of namespace
 * sections", "tools.argSchemas.0.args: Expected string") — paths and keywords, the
 * operator's own config, never model content or a credential. This is the same
 * surface that already returns `rulesDir` and `configPath`.
 *
 * What must not: a message that could carry a value. `settings_invalid` from this
 * file is built here and is safe; anything else is truncated before it leaves.
 *
 * @param error - whatever the host threw.
 * @returns the error name, its machine code, and a bounded single-line message.
 */
function describeWriteFailure(error: unknown): string {
  if (!(error instanceof Error)) return `host threw a non-Error (${String(error).slice(0, 40)})`
  const code = (error as { code?: unknown }).code
  const label = [
    error.name.length > 0 ? error.name : 'Error',
    typeof code === 'string' && code.length > 0 && code.length <= 64 ? `[${code}]` : '',
  ].filter(part => part.length > 0).join(' ')
  // First line only: a zod/aggregate message can be a multi-line dump, and the
  // panel renders one line.
  const firstLine = error.message.split(/\r?\n/u)[0]?.trim() ?? ''
  const message = firstLine.length > MAX_WRITE_DIAGNOSTIC
    ? `${firstLine.slice(0, MAX_WRITE_DIAGNOSTIC)}…`
    : firstLine
  return message.length === 0 ? label : `${label}: ${message}`
}


/**
 * Whether a host settings write was refused as stale.
 *
 * Recognised structurally because the class belongs to the host: `SettingsConflictError`
 * carries the stable machine code `SETTINGS_CONFLICT` and never reaches a browser, so
 * this plugin maps it to its own coarser `settings_conflict`.
 */
function isSettingsConflict(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'SETTINGS_CONFLICT'
}

/**
 * Revision of one profile entry's raw config, as `describe()` reports it.
 *
 * Sent back as `expectedRevision` so a stale editor is refused instead of silently
 * overwriting a concurrent change. `undefined` when the host exposes no revision
 * (older builds, a stub in tests): the write then proceeds exactly as before.
 */
function revisionOf(settings: SettingsServiceLike, ns: string): number | undefined {
  try {
    const described = settings.describe?.() as Array<{ ns?: unknown; revision?: unknown }> | undefined
    for (const descriptor of described ?? []) {
      if (descriptor.ns !== ns) continue
      if (typeof descriptor.revision === 'number' && Number.isSafeInteger(descriptor.revision)) return descriptor.revision
    }
  } catch {
    // A host that cannot describe its entries simply has no revision to offer.
  }
  return undefined
}

/** True for a plain non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Write config fields the host will not accept through its live-only `settings` seam.
 *
 * Why a second path exists at all: the host's `settings` service is deliberately
 * restricted to `.volatile()` fields (it threw `Config field "tools.argSchemas" is
 * not volatile` for everything else, measured 2026-11-24). Its own documentation
 * names the writer for the rest — `ctx.configEditor.edit()`, "callers that edit
 * complete configuration can use `configEditor.edit()`; ordinary fields retain
 * Loader's normal lifecycle". That method validates the next config through the
 * plugin's own schema (`fiber.resolveConfig`), persists atomically, reconciles
 * through the Loader, and rolls the document back if the reload fails. So this is
 * the supported seam, not a workaround around one.
 *
 * What this function must NOT do is restate the whole config: `edit` merges the
 * returned value over the entry's current raw config. We hand back only `update`,
 * so keys the operator never touched stay exactly as they are — the difference
 * between this and `replace()`, which would pin every inherited value into the
 * profile patch.
 *
 * @param settings - the settings service (used for the revision CAS only).
 * @param editor - the `configEditor` service; must expose `edit`.
 * @param ns - the profile entry id this plugin owns.
 * @param update - the fields to write, nested by config section.
 * @param expected - revision the caller read; refused when the entry moved past it.
 */
async function writeOrdinaryFields(
  settings: SettingsServiceLike,
  editor: ConfigEditorLike | undefined,
  ns: string,
  update: Record<string, unknown>,
  expected: number | undefined,
): Promise<void> {
  if (editor === undefined || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
    throw new PanelSettingsError(
      'settings_readonly',
      'this profile composes no configEditor service, so ordinary configuration fields cannot be written from the panel',
    )
  }
  const entry = editor.entries().find(row => row.options?.id === ns)
  if (entry === undefined) {
    throw new PanelSettingsError('settings_readonly', 'the profile entry for this plugin is not addressable by the config editor')
  }
  // The revision guard exists on this path too: `edit` has no CAS of its own, and a
  // stale form overwriting a concurrent ordinary-field change is the same bug the
  // live path already refuses.
  if (expected !== undefined) {
    const current = revisionOf(settings, ns)
    if (current !== undefined && current !== expected) {
      throw new PanelSettingsError('settings_conflict', 'the profile configuration changed since it was read; reload and retry')
    }
  }
  await editor.edit(entry, (current) => mergeConfigLayers(current, update))
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

  /**
   * Persist the provider index atomically.
   *
   * Throws on failure instead of warning: this index and the host config are two
   * stores that must agree, and a swallowed failure leaves a route that exists in
   * the profile but can never be listed or deleted from the panel. The in-memory
   * cache is updated only after the rename succeeded, so a failed write cannot make
   * this process believe something the next restart will not.
   *
   * @param rows - the complete provider list to persist.
   * @throws whatever the filesystem threw.
   */
  const persistCustomProviders = (rows: readonly CustomProviderRecord[]): void => {
    const file = resolveProviderIndexPath()
    mkdirSync(dirname(file), { recursive: true })
    const body = `${JSON.stringify({ version: PROVIDER_INDEX_VERSION, savedAt: Date.now(), providers: rows }, null, 0)}\n`
    const temporary = `${file}.tmp`
    writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
    customProviders = [...rows]
  }

  /**
   * Resolve the profile entry id of the pi-ai provider plugin.
   *
   * Two independent sources, because the entry scan and the settings service can be
   * composed separately: the loader's entry list (authoritative when present), then
   * the conventional entry id in `describe()`. Without the second the panel could
   * read a configurable profile and still refuse every provider action.
   */
  const resolveProviderNamespace = (editor: ConfigEditorLike | undefined, settings?: SettingsServiceLike): string | undefined => {
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
      // Fall through to the descriptor scan.
    }
    try {
      const described = settings?.describe?.() as Array<{ ns?: unknown }> | undefined
      for (const descriptor of described ?? []) {
        if (typeof descriptor.ns === 'string' && /(?:^|\/)llm-pi-ai$/u.test(descriptor.ns)) return descriptor.ns
      }
    } catch {
      // No editable entry: the caller reports read-only.
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
      logger.warn(`safeharness: model catalog unavailable (${describeFailure(error)})`)
    }
    catalog = { at: Date.now(), providers }
    return providers
  }

  const read = async (): Promise<PanelSettingsValue> => {
    const { settings, editor, llm } = services()
    const cfg = runtime.config
    const ns = settings === undefined ? undefined : resolveNamespace(ctx, settings, editor)
    const configurable = settings !== undefined && typeof settings.update === 'function' && ns !== undefined
    const piNs = resolveProviderNamespace(editor, settings)
    // The delete path goes through `mutate` (it must not restate the secret fields
    // it never received), so a profile that exposes only `update` is not actually
    // configurable for providers — the flag has to describe both write paths or the
    // panel offers an action that will always fail.
    const providerConfigurable = settings !== undefined
      && typeof settings.update === 'function'
      && typeof settings.mutate === 'function'
      && piNs !== undefined
    const judge: PanelJudgeSettings = {
      enabled: cfg.output.judge.enabled,
      scope: cfg.output.judge.scope,
      provider: cfg.output.judge.provider,
      model: cfg.output.judge.model,
      maxChars: cfg.output.judge.maxChars,
      timeoutMs: cfg.output.judge.timeoutMs,
      // 1.21.0. `0` is shown as 0 rather than as the client's built-in 4096: the client
      // default is a code constant, not a deployment fact, and printing it here would
      // make an untouched form look like an explicit `maxTokens: 4096` save.
      maxTokens: cfg.output.judge.maxTokens,
      reasoningEffort: cfg.output.judge.reasoningEffort,
      available: llm !== undefined,
      configurable,
    }
    const draft: PanelDraftSettings = {
      enabled: cfg.draft.enabled,
      provider: cfg.draft.provider,
      model: cfg.draft.model,
    }
    const surfaces: PanelSurfaceSettings = {
      input: cfg.input.mode,
      tools: cfg.tools.mode,
      results: cfg.results.mode,
      output: cfg.output.mode,
      approval: cfg.approval.mode,
    }
    const inputJudge = {
      mode: cfg.input.judge,
      failClosed: cfg.input.judgeFailClosed,
      normalize: cfg.input.normalize,
      // 1.20.0. The *effective* deadline, i.e. `0` already replaced by the output
      // judge's value. Showing the resolved number is what lets the form answer "what
      // is in force"; because the client only sends fields it changed, an untouched
      // form never pins the fallback into the patch. "Inherit" stays a patch-only
      // spelling (`judgeTimeoutMs: 0`).
      timeoutMs: cfg.input.judgeTimeoutMs,
      // Same *shape* as the deadline (1.21.0), with one difference worth stating: this is
      // the inherited number, and it can legitimately be `0` when the output judge is
      // also `0` (both mean "use the client's built-in 4096"). The deadline has no such
      // sentinel because it resolves to a concrete 4000 default.
      maxTokens: cfg.input.judgeMaxTokens,
    }
    const toolDetection = {
      descriptorScan: cfg.tools.descriptorScan,
      repeatedAttemptThreshold: cfg.tools.repeatedAttemptThreshold,
      entropyThreshold: cfg.tools.entropyThreshold,
      entropyMinLength: cfg.tools.entropyMinLength,
      allowedTables: [...cfg.tools.sql.allowedTables],
      // The declarations as written, not the compiled entries: re-serialising a
      // compiled schema would normalise the operator's config on the first save.
      argSchemas: argSchemasText(cfg.argSchemaDeclarations),
      sensitivePathScan: cfg.tools.sensitivePathScan,
      sensitivePathClasses: [...cfg.tools.sensitivePathClasses],
    }
    const pii = { enabled: cfg.results.pii, classes: [...cfg.results.piiClasses] }
    const lists = {
      denyTools: [...cfg.tools.denyTools],
      askTools: [...cfg.tools.askTools],
      denyTags: [...cfg.tools.denyTags],
      tagOverrides: cfg.tools.tagOverrides.map((item) => ({ pattern: item.pattern, tags: [...item.tags] })),
      blockOn: [...cfg.results.blockOn],
      allowOnce: [...cfg.approval.allowOnce],
    }
    const source = {
      rulesDir: cfg.rules.dir,
      rulesWatch: cfg.rules.watch,
      patrolWindowMinutes: cfg.patrol.windowMinutes,
      patrolFactor: cfg.patrol.factor,
      patrolMinCount: cfg.patrol.minCount,
    }
    // Stage three: facts only. No credential crosses this block — notification
    // destinations are reduced to their channel types.
    const facts = {
      engine: { kind: cfg.engine.kind, command: cfg.engine.command },
      rules: { inlineRules: cfg.rules.inline.length, sources: runtime.engine.ruleset.sources.length },
      audit: {
        format: cfg.audit.format,
        dir: cfg.audit.dir,
        rotateMb: cfg.audit.rotateMb,
        required: cfg.audit.required,
        hashChain: cfg.audit.hashChain,
      },
      posture: { onLoad: cfg.posture.onLoad, failOn: [...cfg.posture.failOn] },
      patrolNotify: {
        channels: [...new Set(cfg.patrol.notify.map((channel) => channel.type))],
        healthUrls: cfg.patrol.healthUrls.length,
      },
    }
    const custom = loadCustomProviders().map(({ credentialRef: _credentialRef, ...row }) => row)
    return {
      preset: cfg.preset,
      surfaces,
      inputJudge,
      toolDetection,
      pii,
      lists,
      source,
      facts,
      judge,
      draft,
      providers: await loadCatalog(llm),
      customProviders: custom,
      providerConfigurable,
      // The revision the browser saw, echoed back on the next save so a concurrent
      // writer is refused instead of silently overwritten. Null when the host
      // exposes none (older builds) or this entry is not editable here.
      revision: settings === undefined || ns === undefined ? null : revisionOf(settings, ns) ?? null,
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
    // `input` carries both the surface mode and the judge knobs; collect them in
    // one object so a save that changes both does not drop either.
    const input: Record<string, unknown> = {}
    // `output` carries both the judge route and the surface mode; same reason.
    const output: Record<string, unknown> = {}
    // `tools` / `results` carry a surface mode *and* the 1.12.0 detection knobs, so
    // they are collected the same way (a save that changes both must not drop one).
    const tools: Record<string, unknown> = {}
    const results: Record<string, unknown> = {}
    // `approval`, `rules` and `patrol` gain list/number knobs in 1.13.0; they are
    // collected the same way so a save cannot drop the mode it did not touch.
    const approval: Record<string, unknown> = {}
    const rules: Record<string, unknown> = {}
    const patrol: Record<string, unknown> = {}

    if (patch.surfaces !== undefined && patch.surfaces !== null) {
      const surfaces = patch.surfaces
      if (surfaces.input !== undefined) {
        if (surfaces.input !== 'off' && surfaces.input !== 'warn' && surfaces.input !== 'enforce') {
          throw new PanelSettingsError('settings_invalid', 'surfaces.input must be off, warn or enforce')
        }
        input['mode'] = surfaces.input
      }
      if (surfaces.tools !== undefined) {
        if (surfaces.tools !== 'off' && surfaces.tools !== 'warn' && surfaces.tools !== 'enforce') {
          throw new PanelSettingsError('settings_invalid', 'surfaces.tools must be off, warn or enforce')
        }
        tools['mode'] = surfaces.tools
      }
      if (surfaces.results !== undefined) {
        if (surfaces.results !== 'off' && surfaces.results !== 'warn' && surfaces.results !== 'enforce') {
          throw new PanelSettingsError('settings_invalid', 'surfaces.results must be off, warn or enforce')
        }
        results['mode'] = surfaces.results
      }
      if (surfaces.output !== undefined) {
        if (surfaces.output !== 'off' && surfaces.output !== 'warn' && surfaces.output !== 'enforce-buffer') {
          throw new PanelSettingsError('settings_invalid', 'surfaces.output must be off, warn or enforce-buffer')
        }
        output['mode'] = surfaces.output
      }
      if (surfaces.approval !== undefined) {
        if (surfaces.approval !== 'delegate' && surfaces.approval !== 'policy') {
          throw new PanelSettingsError('settings_invalid', 'surfaces.approval must be delegate or policy')
        }
        approval['mode'] = surfaces.approval
      }
    }

    if (patch.inputJudge !== undefined && patch.inputJudge !== null) {
      const knobs = patch.inputJudge
      if (knobs.mode !== undefined) {
        if (knobs.mode !== 'off' && knobs.mode !== 'flagged' && knobs.mode !== 'always') {
          throw new PanelSettingsError('settings_invalid', 'inputJudge.mode must be off, flagged or always')
        }
        input['judge'] = knobs.mode
      }
      if (knobs.failClosed !== undefined) {
        if (typeof knobs.failClosed !== 'boolean') {
          throw new PanelSettingsError('settings_invalid', 'inputJudge.failClosed must be a boolean')
        }
        input['judgeFailClosed'] = knobs.failClosed
      }
      if (knobs.normalize !== undefined) {
        if (typeof knobs.normalize !== 'boolean') {
          throw new PanelSettingsError('settings_invalid', 'inputJudge.normalize must be a boolean')
        }
        input['normalize'] = knobs.normalize
      }
      if (knobs.timeoutMs !== undefined) {
        // 0 is meaningful here ("follow the output judge"), so the floor is 0 rather
        // than MIN_TIMEOUT_MS; any other value gets the same bounds as the output judge.
        const timeout = integerField(knobs.timeoutMs, 'inputJudge.timeoutMs', 0, MAX_TIMEOUT_MS)
        if (timeout !== 0 && timeout < MIN_TIMEOUT_MS) {
          throw new PanelSettingsError('settings_invalid', `inputJudge.timeoutMs must be 0 or at least ${MIN_TIMEOUT_MS}`)
        }
        input['judgeTimeoutMs'] = timeout
      }
      if (knobs.maxTokens !== undefined) {
        // 1.21.0. `0` means "inherit the output judge's budget", so the floor is 0.
        input['judgeMaxTokens'] = integerField(knobs.maxTokens, 'inputJudge.maxTokens', 0, MAX_JUDGE_MAX_TOKENS)
      }
    }

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
      if (judge.maxTokens !== undefined) next['maxTokens'] = integerField(judge.maxTokens, 'judge.maxTokens', 0, MAX_JUDGE_MAX_TOKENS)
      if (judge.reasoningEffort !== undefined) {
        // Free-form by nature: the host is the authority on which ids a route accepts,
        // and it refuses an unknown one before any provider I/O. Bounded here only so a
        // paste cannot put a paragraph into the profile patch.
        if (typeof judge.reasoningEffort !== 'string') {
          throw new PanelSettingsError('settings_invalid', 'judge.reasoningEffort must be a string')
        }
        const effort = judge.reasoningEffort.trim()
        if (effort.length > 64) {
          throw new PanelSettingsError('settings_invalid', 'judge.reasoningEffort must be at most 64 characters')
        }
        next['reasoningEffort'] = effort
      }
      const enabled = next['enabled'] === undefined ? cfg.output.judge.enabled : next['enabled'] === true
      const provider = typeof next['provider'] === 'string' ? next['provider'] : cfg.output.judge.provider
      const model = typeof next['model'] === 'string' ? next['model'] : cfg.output.judge.model
      if (enabled && (provider.length === 0 || model.length === 0)) {
        throw new PanelSettingsError('settings_invalid', 'enabling the judge requires both a provider and a model')
      }
      output['judge'] = next
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

    if (patch.toolDetection !== undefined && patch.toolDetection !== null) {
      const knobs = patch.toolDetection
      if (knobs.descriptorScan !== undefined) {
        if (knobs.descriptorScan !== 'off' && knobs.descriptorScan !== 'warn' && knobs.descriptorScan !== 'enforce') {
          throw new PanelSettingsError('settings_invalid', 'toolDetection.descriptorScan must be off, warn or enforce')
        }
        tools['descriptorScan'] = knobs.descriptorScan
      }
      if (knobs.repeatedAttemptThreshold !== undefined) {
        tools['repeatedAttemptThreshold'] = integerField(
          knobs.repeatedAttemptThreshold,
          'toolDetection.repeatedAttemptThreshold',
          0,
          MAX_FAILURE_THRESHOLD,
        )
      }
      if (knobs.entropyThreshold !== undefined) {
        tools['entropyThreshold'] = numberField(
          knobs.entropyThreshold,
          'toolDetection.entropyThreshold',
          0,
          MAX_ENTROPY_THRESHOLD,
        )
      }
      if (knobs.entropyMinLength !== undefined) {
        tools['entropyMinLength'] = integerField(
          knobs.entropyMinLength,
          'toolDetection.entropyMinLength',
          1,
          MAX_ENTROPY_MIN_LENGTH,
        )
      }
      if (knobs.allowedTables !== undefined) {
        tools['sql'] = { allowedTables: tableListField(knobs.allowedTables) }
      }
      if (knobs.argSchemas !== undefined && knobs.argSchemas !== null) {
        // Compiled here, before the write: a declaration that does not compile is a
        // refusal, not a silent drop (see `argSchemasField`).
        tools['argSchemas'] = argSchemasField(knobs.argSchemas)
      }
      if (knobs.sensitivePathScan !== undefined) {
        if (knobs.sensitivePathScan !== 'off' && knobs.sensitivePathScan !== 'warn' && knobs.sensitivePathScan !== 'enforce') {
          throw new PanelSettingsError('settings_invalid', 'toolDetection.sensitivePathScan must be off, warn or enforce')
        }
        tools['sensitivePathScan'] = knobs.sensitivePathScan
      }
      if (knobs.sensitivePathClasses !== undefined) {
        if (!Array.isArray(knobs.sensitivePathClasses)) {
          throw new PanelSettingsError('settings_invalid', 'toolDetection.sensitivePathClasses must be an array')
        }
        const unknown = knobs.sensitivePathClasses.filter(name => !isSensitivePathClass(name))
        if (unknown.length > 0) {
          // Closed vocabulary: a typo here would silently disable a class the operator
          // believed was on, which is the failure this package keeps having to fix.
          throw new PanelSettingsError('settings_invalid', `toolDetection.sensitivePathClasses has unknown names: ${unknown.slice(0, 3).join(', ')}`)
        }
        tools['sensitivePathClasses'] = [...knobs.sensitivePathClasses]
      }
    }

    if (patch.pii !== undefined && patch.pii !== null) {
      const pii = patch.pii
      if (pii.enabled !== undefined) {
        if (typeof pii.enabled !== 'boolean') throw new PanelSettingsError('settings_invalid', 'pii.enabled must be a boolean')
        results['pii'] = pii.enabled
      }
      if (pii.classes !== undefined) {
        results['piiClasses'] = piiClassesField(pii.classes)
      }
    }

    if (patch.lists !== undefined && patch.lists !== null) {
      const lists = patch.lists
      if (lists.denyTools !== undefined) tools['denyTools'] = globListField(lists.denyTools, 'lists.denyTools')
      if (lists.askTools !== undefined) tools['askTools'] = globListField(lists.askTools, 'lists.askTools')
      if (lists.denyTags !== undefined) tools['denyTags'] = tagListField(lists.denyTags, 'lists.denyTags')
      if (lists.tagOverrides !== undefined) tools['tagOverrides'] = tagOverridesField(lists.tagOverrides)
      if (lists.blockOn !== undefined) results['blockOn'] = blockOnField(lists.blockOn)
      if (lists.allowOnce !== undefined) approval['allowOnce'] = globListField(lists.allowOnce, 'lists.allowOnce')
    }

    if (patch.source !== undefined && patch.source !== null) {
      const source = patch.source
      if (source.rulesDir !== undefined) rules['dir'] = directoryField(source.rulesDir, 'source.rulesDir')
      if (source.rulesWatch !== undefined) {
        if (typeof source.rulesWatch !== 'boolean') throw new PanelSettingsError('settings_invalid', 'source.rulesWatch must be a boolean')
        rules['watch'] = source.rulesWatch
      }
      if (source.patrolWindowMinutes !== undefined) {
        patrol['windowMinutes'] = numberField(source.patrolWindowMinutes, 'source.patrolWindowMinutes', 1, MAX_PATROL_MINUTES)
      }
      if (source.patrolFactor !== undefined) {
        patrol['factor'] = numberField(source.patrolFactor, 'source.patrolFactor', 1, MAX_PATROL_FACTOR)
      }
      if (source.patrolMinCount !== undefined) {
        patrol['minCount'] = integerField(source.patrolMinCount, 'source.patrolMinCount', 0, MAX_PATROL_COUNT)
      }
    }

    if (Object.keys(input).length > 0) update['input'] = input
    if (Object.keys(output).length > 0) update['output'] = output
    if (Object.keys(tools).length > 0) update['tools'] = tools
    if (Object.keys(results).length > 0) update['results'] = results
    if (Object.keys(approval).length > 0) update['approval'] = approval
    if (Object.keys(rules).length > 0) update['rules'] = rules
    if (Object.keys(patrol).length > 0) update['patrol'] = patrol

    if (Object.keys(update).length === 0) throw new PanelSettingsError('settings_invalid', 'no supported field was supplied')

    // The browser echoes the revision it read. An internal caller (the provider
    // flow pointing the judge at a new route) sends none, and then the current
    // revision is read here: that still closes the read-modify-write window inside
    // this process, it just cannot catch a form that was loaded before a change.
    const expected = typeof patch.expectedRevision === 'number' && Number.isSafeInteger(patch.expectedRevision)
      ? patch.expectedRevision
      : revisionOf(settings, ns)

    // 1.17.2: split by the host's own rule.
    //
    // The host's `settings` service accepts `.volatile()` paths only — its docs say
    // so ("forms restricted to live fields"), and it threw exactly
    // `Config field "tools.argSchemas" is not volatile` for every other save. The
    // documented writer for ordinary fields is `configEditor.edit()`, which persists
    // the complete raw config and applies it through the normal Loader path. Until
    // this release the panel called `settings.update` for everything, so every
    // non-volatile field was refused outright.
    //
    // One save goes down exactly one path. Doing both would mean two writes and a
    // revision race against our own reload, and the ordinary path already reloads
    // the entry — which is what the panel's own copy promises for those fields.
    //
    // A leaf is volatile when its own path carries `.volatile()`. Arrays count as
    // leaves (`results.piiClasses` is volatile and is an array), and so do scalars.
    const leavesAreVolatile = Object.entries(update).every(([section, value]) => {
      if (!isPlainRecord(value)) return isVolatileConfigPath([section])
      return Object.entries(value).every(([key, child]) =>
        isPlainRecord(child)
          ? Object.keys(child).every(inner => isVolatileConfigPath([section, key, inner]))
          : isVolatileConfigPath([section, key]))
    })
    try {
      if (leavesAreVolatile) {
        // Omitted (not `undefined`) when the host exposes no revision, so a stub or an
        // older host sees exactly the two-argument call it always supported.
        if (expected === undefined) await settings.update(ns, update)
        else await settings.update(ns, update, expected)
      } else {
        await writeOrdinaryFields(settings, editor, ns, update, expected)
      }
    } catch (error) {
      // A typed refusal raised by this file (`settings_readonly` for a profile with no
      // config editor, `settings_conflict` from the ordinary path's revision guard) is
      // already the precise answer: re-wrapping it as "the host rejected the write"
      // would recreate the very defect 1.17.1 fixed one layer down.
      if (error instanceof PanelSettingsError) {
        runtime.audit('invariant_probe', {
          decision: 'warn',
          reason_code: 'panel_settings',
          labels: {
            state: 'settings_write_refused',
            fields: Object.keys(update).sort().join(',').slice(0, 120),
            error_code: error.code,
          },
        })
        throw error
      }
      const diagnostic = describeWriteFailure(error)
      logger.warn(`safeharness: settings write failed (${describeFailure(error)})`)
      // The ledger keeps its own discipline: identifiers only, never a message.
      // A host diagnostic can carry a path (`... cordis.patch.yml must be a map of
      // namespace sections`), and this ledger has never held a path. So the record
      // names the failure class and the fields that were being written; the reason
      // itself goes to the operator through the panel response, which already
      // carries `configPath` and `rulesDir` and stays on loopback.
      const code = (error as { code?: unknown } | null)?.code
      runtime.audit('invariant_probe', {
        decision: 'warn',
        reason_code: 'panel_settings',
        labels: {
          state: 'settings_write_failed',
          fields: Object.keys(update).sort().join(',').slice(0, 120),
          error_name: error instanceof Error ? error.name.slice(0, 64) : 'non-error',
          ...(typeof code === 'string' && code.length > 0 && code.length <= 64 ? { error_code: code } : {}),
          ...(typeof patch.expectedRevision === 'number' ? { expected_revision: String(patch.expectedRevision) } : {}),
        },
      })
      throw isSettingsConflict(error)
        ? new PanelSettingsError('settings_conflict', 'the profile configuration changed since it was read; reload and retry')
        : new PanelSettingsError('settings_write_failed', `the host rejected the configuration write — ${diagnostic}`)
    }

    runtime.audit('invariant_probe', {
      decision: 'info',
      reason_code: 'panel_settings',
      labels: {
        state: 'settings_saved',
        judge: cfg.output.judge.enabled ? 'was_on' : 'was_off',
        ...(patch.judge?.enabled === undefined ? {} : { judge_next: patch.judge.enabled ? 'on' : 'off' }),
        ...(patch.draft === undefined ? {} : { draft_route: 'changed' }),
        ...(patch.surfaces === undefined ? {} : { surfaces: 'changed' }),
        ...(patch.toolDetection === undefined ? {} : { tool_detection: 'changed' }),
        ...(patch.pii === undefined ? {} : { pii: 'changed' }),
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
    const piNs = resolveProviderNamespace(editor, settings)
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
      logger.warn(`safeharness: could not store the provider credential (${describeFailure(error)})`)
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
      const expected = revisionOf(settings, piNs)
      if (expected === undefined) await settings.update(piNs, { providers: { [value.id]: profile } })
      else await settings.update(piNs, { providers: { [value.id]: profile } }, expected)
    } catch (error) {
      logger.warn(`safeharness: could not add the provider route (${describeFailure(error)})`)
      try {
        await credentials.unset?.(credentialRef)
      } catch {
        // The orphan credential is harmless; the route was never written.
      }
      throw isSettingsConflict(error)
        ? new PanelSettingsError('settings_conflict', 'the profile configuration changed since it was read; reload and retry')
        : new PanelSettingsError('settings_write_failed', 'the host rejected the provider configuration')
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
    try {
      persistCustomProviders([...loadCustomProviders(), record])
    } catch (error) {
      // Two stores, one commit: if the panel's own index cannot be written, undo the
      // route and the credential too. Without this the profile carries a route that
      // the panel can never list or delete — the divergence 1.8.2 shipped with.
      logger.warn(`safeharness: provider index write failed (${describeFailure(error)}); rolling the route back`)
      const canRollBack = typeof settings.mutate === 'function'
      if (canRollBack) {
        try {
          await settings.mutate?.(piNs, [{ op: 'unset', path: ['providers', value.id] }])
        } catch (rollbackError) {
          // The route now exists in the profile but not in the index; a later delete
          // can still heal it, and the operator has the failure below either way.
          logger.warn(`safeharness: provider route rollback failed (${describeFailure(rollbackError)})`)
        }
      }
      try {
        await credentials.unset?.(credentialRef)
      } catch {
        // Same as above: an orphan key is inert without a route.
      }
      // Only claim a rollback when this profile actually gave us `mutate` to do it.
      throw new PanelSettingsError(
        'provider_index_failed',
        canRollBack
          ? 'the provider route could not be recorded; it was rolled back'
          : 'the provider route could not be recorded; remove it from the profile manually',
      )
    }
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
        logger.warn(`safeharness: provider added but the judge route was not applied (${describeFailure(error)})`)
      }
    }
    return { provider: publicProvider(record), settings: await read(), judgeRouteApplied }
  }

  /**
   * Collect the paths inside one described value that still name `routeId`.
   *
   * The route's own definition (`providers.<routeId>`) is skipped: that is what the
   * delete removes, not a reference to it. A dotted field path is configuration
   * vocabulary (allowed by the zero-echo rule), never a value.
   */
  function collectRouteReferences(value: unknown, routeId: string, path: readonly string[], found: string[], depth = 0): void {
    if (depth > 8) return
    if (typeof value === 'string') {
      if (value === routeId || value.startsWith(`${routeId}/`)) found.push(path.length === 0 ? '(root)' : path.join('.'))
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => collectRouteReferences(entry, routeId, [...path, String(index)], found, depth + 1))
      return
    }
    if (value === null || typeof value !== 'object') return
    const insideProviders = path.length > 0 && path[path.length - 1] === 'providers'
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (insideProviders && key === routeId) continue
      collectRouteReferences(child, routeId, [...path, key], found, depth + 1)
    }
  }

  /** Every field in the live pi-ai config that still points at `routeId`. */
  const providerReferences = (settings: SettingsServiceLike, piNs: string, routeId: string): string[] => {
    const found: string[] = []
    try {
      const described = settings.describe?.() as Array<{ ns?: unknown; value?: unknown }> | undefined
      for (const descriptor of described ?? []) {
        if (descriptor.ns !== piNs) continue
        collectRouteReferences(descriptor.value, routeId, [], found)
      }
    } catch {
      // A descriptor that cannot be read leaves the decision to the own-route checks.
    }
    return [...new Set(found)].sort()
  }

  /** Remove one route this panel added, and its credential. */
  const deleteProvider = async (id: string): Promise<PanelProviderAdded> => {
    const routeId = typeof id === 'string' ? id.trim() : ''
    const record = loadCustomProviders().find(row => row.id === routeId)
    if (record === undefined) throw new PanelSettingsError('provider_not_found', 'that route was not added by this panel')
    const ownUses: string[] = [
      ...(runtime.config.output.judge.provider === routeId ? ['the judge route'] : []),
      ...(runtime.config.draft.provider === routeId ? ['the drafting route'] : []),
    ]
    if (ownUses.length > 0) {
      throw new PanelSettingsError('provider_in_use', `the route is still selected by ${ownUses.join(' and ')}`)
    }
    const { settings, editor, credentials } = services()
    if (settings === undefined || typeof settings.mutate !== 'function') {
      throw new PanelSettingsError('settings_unavailable', 'this profile composes no settings service')
    }
    const piNs = resolveProviderNamespace(editor, settings)
    if (piNs === undefined) throw new PanelSettingsError('provider_unavailable', 'no editable pi-ai provider entry was found')
    // Other references in the pi-ai section (`defaultProvider`, a default model route,
    // …) break the moment the route disappears; the judge/draft check alone missed them.
    const references = providerReferences(settings, piNs, routeId)
    if (references.length > 0) {
      throw new PanelSettingsError('provider_in_use', `the route is still referenced by ${references.join(', ')}`)
    }
    try {
      const ops = [{ op: 'unset' as const, path: ['providers', routeId] }]
      const expected = revisionOf(settings, piNs)
      if (expected === undefined) await settings.mutate(piNs, ops)
      else await settings.mutate(piNs, ops, expected)
    } catch (error) {
      logger.warn(`safeharness: could not remove the provider route (${describeFailure(error)})`)
      throw isSettingsConflict(error)
        ? new PanelSettingsError('settings_conflict', 'the profile configuration changed since it was read; reload and retry')
        : new PanelSettingsError('settings_write_failed', 'the host rejected the provider removal')
    }
    try {
      persistCustomProviders(loadCustomProviders().filter(row => row.id !== routeId))
    } catch (error) {
      // The route is gone from the profile, so a retry can finish the job: the index
      // row (and therefore the credential reference) is still there to delete.
      logger.warn(`safeharness: provider index write failed (${describeFailure(error)}); the removal needs a retry`)
      throw new PanelSettingsError('provider_index_failed', 'the route was removed but the panel index was not; retry the delete')
    }
    try {
      await credentials?.unset?.(record.credentialRef)
    } catch {
      // Removing the route is the security-relevant half; an orphan key is inert.
    }
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
      // 1.21.0: a probe that used a different budget or effort than a real review would
      // not be evidence about this deployment — an unsupported effort is exactly the
      // failure the probe exists to surface.
      maxTokens: cfg.maxTokens,
      ...(cfg.reasoningEffort.length === 0 ? {} : { reasoningEffort: cfg.reasoningEffort }),
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
