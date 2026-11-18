/**
 * Browser half of the SafeHarness panel (T5.3, 1.9.3).
 *
 * It contributes the same workbench to three host surfaces:
 *
 * - `settings.plugins.tab` — the tab inside the Plugins settings section (since
 *   1.9.0, kept for profiles whose plugins page is not composed);
 * - `plugins.bundle.config` — the bundle's own page, keyed by npm package name
 *   and rendered between the description and the rows. This is the surface the
 *   bundle's page has for its own configuration, and without it the page falls
 *   back to the package README as its whole body (the 1.9.2 report);
 * - `plugins.row.config` — the row's page, keyed `<package>#<row id>`, which
 *   gives the `safeharness` row a Configure control;
 * - `plugins.detail.actions` — the head control that opens the full manual on
 *   GitHub. The host's detail document is plain Markdown (raw HTML and relative
 *   links are dropped), so the README above the workbench stays a short summary
 *   and the button is the way to the long form.
 *
 * Every registration goes through `ctx.slots.inject`, so it waits for the slot's
 * declaration instead of assuming it: a profile that does not compose the
 * settings plugins page (or a future host that renames a slot) leaves that
 * surface out of the UI instead of failing the browser boot.
 *
 * Deliberate dependencies: `react` only (a platform seed module). Every DSH
 * client package is avoided — the browser module table has exactly ten
 * specifiers and the ui-slots build seeded into the packaged shell is not
 * something this package can type against safely. The context is therefore read
 * structurally, and the component receives plain data through its inject face.
 * @module
 */
import type { ReactNode } from 'react'
import {
  PANEL_CHANNEL,
  PANEL_DRAFT_ENDPOINT,
  PANEL_EXPORT_ENDPOINT,
  PANEL_PATROL_ENDPOINT,
  PANEL_RELOAD_ENDPOINT,
  PANEL_RULE_WRITE_ENDPOINT,
  PANEL_SCHEDULE_ENDPOINT,
  PANEL_SETTINGS_ENDPOINT,
  PANEL_STATUS_ENDPOINT,
} from '../panel/protocol.js'
import type {
  PanelDraftResult,
  PanelDraftValue,
  PanelExportResult,
  PanelExportValue,
  PanelJudgeProbe,
  PanelPatrolReport,
  PanelPatrolResult,
  PanelPayload,
  PanelProbeResult,
  PanelProviderAdded,
  PanelProviderInput,
  PanelProviderResult,
  PanelReloadResult,
  PanelResult,
  PanelRuleWriteResult,
  PanelRuleWriteValue,
  PanelRuleHistoryResult,
  PanelRuleHistoryValue,
  PanelRuleRollbackResult,
  PanelRuleRollbackValue,
  PanelSchedule,
  PanelScheduleResult,
  PanelSettingsPatch,
  PanelSettingsResult,
  PanelSettingsValue,
} from '../panel/protocol.js'
import { SafeHarnessPanel } from './panel.js'

/**
 * What the host passes to a slot component besides the injected face.
 *
 * Only `view` is read: `'page'` is the full page body (ours), `'summary'` is the
 * title-side block some slots draw instead — we have nothing to say there.
 */
export interface SlotViewProps {
  /** `'page'` for a body with its own save controls, `'summary'` for a title-side block. */
  readonly view?: string
}

/** Options the host accepts for one slot registration. */
export interface SlotRegisterOptions {
  /** Slot name the registration is attached to. */
  readonly name: string
  /** List-entry registration id (owner-assigned); not used by the config slots. */
  readonly id?: string
  /** Key for a keyed slot: bundle package name, or `<package>#<row id>`. */
  readonly key?: string
  /** Locale namespace the host resolves the registration's labels in. */
  readonly locale?: string
  /** Ordering hint inside a slot. */
  readonly order?: number
  /** Static label for list slots. */
  readonly label?: () => string
  /** Face injected into the component (list slots only; keyed slots close over it). */
  readonly inject?: () => PanelFace
}

/** The slice of the browser plugin context this half uses. */
export interface ClientContextLike {
  readonly slots: {
    inject(name: string, callback: () => () => void): () => void
    register<P>(options: SlotRegisterOptions, component: (props: P) => ReactNode): () => void
  }
}

/** What the registration injects into the component. */
export interface PanelFace {
  /** Read one fresh payload from the Host. */
  readonly load: () => Promise<PanelPayload>
  /** Run one patrol on the Host (POST; the Host enforces single-flight + cooldown). */
  readonly patrol: () => Promise<PanelPatrolReport>
  /** Ask the drafting route for one candidate rule (never applied). */
  readonly draft: (input: { readonly description: string; readonly kind: 'inform' | 'chain' }) => Promise<PanelDraftValue>
  /** Arm/disarm the optional patrol timer. */
  readonly schedule: (input: { readonly enabled: boolean; readonly intervalMinutes: number | null }) => Promise<PanelSchedule>
  /** Re-read the rule directory without restarting the host. */
  readonly reloadRules: () => Promise<{ readonly rules: number; readonly chains: number; readonly hash: string }>
  /**
   * Land one drafted rule as a file in `rules.dir` and hot-reload it. The Host owns
   * every gate (whitelist, loader pre-check, atomic write, no-overwrite default).
   */
  readonly writeRule: (input: {
    readonly filename: string
    readonly yaml: string
    readonly overwrite: boolean
  }) => Promise<PanelRuleWriteValue>
  /** List the retained rule-directory snapshots (1.14.0). */
  readonly ruleHistory: () => Promise<PanelRuleHistoryValue>
  /** Restore one snapshot; the Host runs the loader gate before touching the disk. */
  readonly rollbackRule: (snapshot: string) => Promise<PanelRuleRollbackValue>
  /** Read the judge/drafting routes and the provider catalog (1.7.0 `settings` endpoint). */
  readonly loadSettings: () => Promise<PanelSettingsValue>
  /** Save a partial route change; the Host validates and hot-reloads it. */
  readonly saveSettings: (patch: PanelSettingsPatch) => Promise<PanelSettingsValue>
  /** Add one hand-declared provider route (URL + protocol + model; key write-only). */
  readonly addProvider: (input: PanelProviderInput) => Promise<PanelProviderAdded>
  /** Remove one route this panel added. */
  readonly deleteProvider: (id: string) => Promise<PanelProviderAdded>
  /** Probe the judge route once; returns status and timing only, never the reply. */
  readonly probeJudge: () => Promise<PanelJudgeProbe>
  /** Bounded NDJSON slice of the already-redacted ledger. */
  readonly exportLedger: (limit?: number) => Promise<PanelExportValue>
}

/** Slot this tab is contributed to (owned by the plugins settings section). */
const TAB_SLOT = 'settings.plugins.tab'

/** Bundle-detail slot: keyed by the bundle's npm package name. */
const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config'

/** Row-detail slot: keyed `<package>#<row id>`. */
const ROW_CONFIG_SLOT = 'plugins.row.config'

/**
 * Detail-page head slot (list): the docs button.
 *
 * The plugin page renders the package README above the bundle's configuration,
 * and the host's detail document is plain Markdown — raw HTML (so no in-page
 * `<details>` fold) and relative links are dropped. The head control is the one
 * clickable affordance outside that document, so the full manual opens from here.
 */
const DETAIL_ACTIONS_SLOT = 'plugins.detail.actions'

/** Full manual on GitHub (absolute: the detail document only links absolutes). */
const DOCS_URL = 'https://github.com/JueeeX/JueeeX-Upear-SafeHarnessSuite-dsh/blob/main/MANUAL.md'

/** Package name used as the bundle key (also the registration id of the tab). */
const PACKAGE_NAME = '@upear/dsh-safeharness'

/** Row id this bundle's patch declares, used as the row key. */
const ROW_ID = 'safeharness'

/** Subject a detail-page contribution is rendered with (the parts this half reads). */
export interface DetailSubject {
  /** `bundle` / `row` / `item`, as the host names the open page. */
  readonly kind: 'bundle' | 'row' | 'item'
  /** The bundle the page is about, for bundle and row pages. */
  readonly pkg?: { readonly name: string }
}

/** Owner props of a `plugins.detail.actions` entry. */
export interface DetailActionProps {
  /** The page's subject; an entry renders null for a subject it has nothing for. */
  readonly subject: DetailSubject
}

/**
 * The docs control shown at the head of this plugin's own detail pages.
 *
 * It renders only for our bundle (or one of its rows): the slot is shared by
 * every plugin's detail page, and a contribution that ignored the subject would
 * put a SafeHarness link on strangers' pages.
 *
 * @param props - the page's subject.
 * @returns an external link styled as a small button, or null.
 */
function DocsAction({ subject }: DetailActionProps): ReactNode {
  if (subject.pkg?.name !== PACKAGE_NAME) return null
  return (
    <a
      href={DOCS_URL}
      target="_blank"
      rel="noreferrer"
      title="在浏览器打开完整手册（GitHub）"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: '28px',
        padding: '0 12px',
        border: '1px solid currentColor',
        borderRadius: '6px',
        color: 'inherit',
        font: 'inherit',
        fontSize: '12px',
        textDecoration: 'none',
        opacity: 0.85,
      }}
    >
      完整文档
    </a>
  )
}

/** Services this plugin needs from the browser context. */
export const inject = ['slots']

/** Any envelope the panel endpoints answer with. */
type Envelope =
  | PanelResult
  | PanelPatrolResult
  | PanelDraftResult
  | PanelScheduleResult
  | PanelReloadResult
  | PanelRuleWriteResult
  | PanelRuleHistoryResult
  | PanelRuleRollbackResult
  | PanelSettingsResult
  | PanelProbeResult
  | PanelProviderResult
  | PanelExportResult

/**
 * POST one panel endpoint and unwrap its envelope.
 *
 * Same-origin with credentials: the panel route is fenced by the Host's loopback
 * + Origin checks, and the session cookie rides along.
 *
 * @param endpoint - channel-relative endpoint name.
 * @param body - small JSON body (never content; the route caps it).
 * @returns the envelope's `value` on success.
 */
async function call(endpoint: string, body: unknown = {}): Promise<unknown> {
  const response = await fetch(`${PANEL_CHANNEL}/${endpoint}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`panel_http_${response.status}`)
  const result = (await response.json()) as Envelope
  if (!result.ok) {
    // Keep the server's coarse reason: the panel explains a timeout / empty reply
    // instead of showing one generic "unavailable" line for every failure. A rule
    // write may also carry the loader's problems, which the operator needs verbatim.
    const failure = new Error(result.error.code) as Error & { detail?: string; problems?: readonly string[] }
    failure.detail = result.error.message
    if (result.error.problems !== undefined) failure.problems = result.error.problems
    throw failure
  }
  return result.value
}

/**
 * Register the panel tab.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContextLike): void {
  const face: PanelFace = {
    load: async () => (await call(PANEL_STATUS_ENDPOINT)) as PanelPayload,
    patrol: async () => (await call(PANEL_PATROL_ENDPOINT)) as PanelPatrolReport,
    draft: async (input) => (await call(PANEL_DRAFT_ENDPOINT, input)) as PanelDraftValue,
    schedule: async (input) => (await call(PANEL_SCHEDULE_ENDPOINT, input)) as PanelSchedule,
    reloadRules: async () => (await call(PANEL_RELOAD_ENDPOINT)) as { rules: number; chains: number; hash: string },
    writeRule: async (input) => (await call(PANEL_RULE_WRITE_ENDPOINT, input)) as PanelRuleWriteValue,
    ruleHistory: async () => (await call(PANEL_RULE_WRITE_ENDPOINT, { op: 'history' })) as PanelRuleHistoryValue,
    rollbackRule: async (snapshot) => (await call(PANEL_RULE_WRITE_ENDPOINT, { op: 'rollback', snapshot })) as PanelRuleRollbackValue,
    // The settings endpoint is new in 1.7.0: on an older Host build the route
    // answers `unknown_endpoint`, which the settings tab renders as a readable
    // "server not ready" notice instead of breaking the panel.
    loadSettings: async () => (await call(PANEL_SETTINGS_ENDPOINT, { op: 'read' })) as PanelSettingsValue,
    saveSettings: async (patch) => (await call(PANEL_SETTINGS_ENDPOINT, { op: 'save', patch })) as PanelSettingsValue,
    addProvider: async (input: PanelProviderInput) => (await call(PANEL_SETTINGS_ENDPOINT, { op: 'add-provider', provider: input })) as PanelProviderAdded,
    deleteProvider: async (id) => (await call(PANEL_SETTINGS_ENDPOINT, { op: 'delete-provider', id })) as PanelProviderAdded,
    probeJudge: async () => (await call(PANEL_SETTINGS_ENDPOINT, { op: 'probe' })) as PanelJudgeProbe,
    exportLedger: async (limit) => (await call(PANEL_EXPORT_ENDPOINT, limit === undefined ? {} : { limit })) as PanelExportValue,
  }
  ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({
    name: TAB_SLOT,
    id: ROW_ID,
    // After the configurable (0) and inventory (10) tabs: this one is
    // informational, not part of the configuration flow.
    order: 20,
    label: () => 'SafeHarness',
    inject: () => face,
  }, SafeHarnessPanel))

  // The bundle's own page: this is what "click the plugin" opens. Without it the
  // page body is only the package README, which reads as "the plugin has no UI".
  // `view: 'page'` is the full body; the host draws the title, icon, and crumb.
  ctx.slots.inject(BUNDLE_CONFIG_SLOT, () => ctx.slots.register<SlotViewProps>({
    name: BUNDLE_CONFIG_SLOT,
    key: PACKAGE_NAME,
    locale: 'safeHarness',
  }, ({ view }) => (view === 'page' ? <SafeHarnessPanel {...face} /> : null)))

  // Same workbench on the `safeharness` row's page, reached through the row's
  // Configure control. The patch declares the row under `ROW_ID`, which is what
  // the host keys this slot with.
  ctx.slots.inject(ROW_CONFIG_SLOT, () => ctx.slots.register<SlotViewProps>({
    name: ROW_CONFIG_SLOT,
    key: `${PACKAGE_NAME}#${ROW_ID}`,
    locale: 'safeHarness',
  }, ({ view }) => (view === 'page' ? <SafeHarnessPanel {...face} /> : null)))

  // The head control: the host renders the package README (plain Markdown, no
  // raw HTML, no relative links) above the configuration, so the full manual is
  // one click away from the page head rather than buried in the document.
  ctx.slots.inject(DETAIL_ACTIONS_SLOT, () => ctx.slots.register<DetailActionProps>({
    name: DETAIL_ACTIONS_SLOT,
    id: 'safeharness-docs',
    order: 10,
  }, DocsAction))
}
