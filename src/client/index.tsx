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
import { PANEL_CHANNEL, PANEL_PATROL_ENDPOINT, PANEL_STATUS_ENDPOINT } from '../panel/protocol.js'
import type { PanelPatrolReport, PanelPatrolResult, PanelPayload, PanelResult } from '../panel/protocol.js'
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
}

/** Slot this tab is contributed to (owned by the plugins settings section). */
const TAB_SLOT = 'settings.plugins.tab'

/** Services this plugin needs from the browser context. */
export const inject = ['slots']

/**
 * POST one panel endpoint and unwrap its envelope.
 *
 * Same-origin with credentials: the panel route is fenced by the Host's loopback
 * + Origin checks, and the session cookie rides along.
 *
 * @param endpoint - channel-relative endpoint name.
 * @returns the envelope's `value` on success.
 */
async function call(endpoint: string): Promise<unknown> {
  const response = await fetch(`${PANEL_CHANNEL}/${endpoint}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) throw new Error(`panel_http_${response.status}`)
  const result = (await response.json()) as PanelResult | PanelPatrolResult
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
