/**
 * Browser half of the SafeHarness panel (T5.3).
 *
 * It contributes one tab to the host's Plugins settings section. The tab is
 * registered through `ctx.slots.inject`, so it waits for that section's
 * declaration instead of assuming it: a profile that does not compose the
 * settings plugins package (or a future host that renames the slot) leaves the
 * panel out of the UI instead of failing the browser boot.
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
  PANEL_PATROL_ENDPOINT,
  PANEL_RELOAD_ENDPOINT,
  PANEL_SCHEDULE_ENDPOINT,
  PANEL_SETTINGS_ENDPOINT,
  PANEL_STATUS_ENDPOINT,
} from '../panel/protocol.js'
import type {
  PanelDraftResult,
  PanelDraftValue,
  PanelJudgeProbe,
  PanelPatrolReport,
  PanelPatrolResult,
  PanelPayload,
  PanelProbeResult,
  PanelReloadResult,
  PanelResult,
  PanelSchedule,
  PanelScheduleResult,
  PanelSettingsPatch,
  PanelSettingsResult,
  PanelSettingsValue,
} from '../panel/protocol.js'
import { SafeHarnessPanel } from './panel.js'

/** The slice of the browser plugin context this half uses. */
export interface ClientContextLike {
  readonly slots: {
    inject(name: string, callback: () => () => void): () => void
    register(options: {
      readonly name: string
      readonly id: string
      readonly order: number
      readonly label: () => string
      readonly inject: () => PanelFace
    }, component: (props: PanelFace) => ReactNode): () => void
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
  /** Read the judge/drafting routes and the provider catalog (1.7.0 `settings` endpoint). */
  readonly loadSettings: () => Promise<PanelSettingsValue>
  /** Save a partial route change; the Host validates and hot-reloads it. */
  readonly saveSettings: (patch: PanelSettingsPatch) => Promise<PanelSettingsValue>
  /** Probe the judge route once; returns status and timing only, never the reply. */
  readonly probeJudge: () => Promise<PanelJudgeProbe>
}

/** Slot this tab is contributed to (owned by the plugins settings section). */
const TAB_SLOT = 'settings.plugins.tab'

/** Services this plugin needs from the browser context. */
export const inject = ['slots']

/** Any envelope the panel endpoints answer with. */
type Envelope =
  | PanelResult
  | PanelPatrolResult
  | PanelDraftResult
  | PanelScheduleResult
  | PanelReloadResult
  | PanelSettingsResult
  | PanelProbeResult

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
  if (!result.ok) throw new Error(result.error.code)
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
    // The settings endpoint is new in 1.7.0: on an older Host build the route
    // answers `unknown_endpoint`, which the settings tab renders as a readable
    // "server not ready" notice instead of breaking the panel.
    loadSettings: async () => (await call(PANEL_SETTINGS_ENDPOINT, { op: 'read' })) as PanelSettingsValue,
    saveSettings: async (patch) => (await call(PANEL_SETTINGS_ENDPOINT, { op: 'save', patch })) as PanelSettingsValue,
    probeJudge: async () => (await call(PANEL_SETTINGS_ENDPOINT, { op: 'probe' })) as PanelJudgeProbe,
  }
  ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({
    name: TAB_SLOT,
    id: 'safeharness',
    // After the configurable (0) and inventory (10) tabs: this one is
    // informational, not part of the configuration flow.
    order: 20,
    label: () => 'SafeHarness',
    inject: () => face,
  }, SafeHarnessPanel))
}
