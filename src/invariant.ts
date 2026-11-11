/**
 * Package-owned invariant companion for `@upear/dsh-safeharness` (§6.13).
 *
 * Mounted explicitly by the composition (`@upear/dsh-safeharness/invariant`)
 * alongside the invariants service — nothing auto-loads a package's `./invariant`
 * export. The companion injects the plugin's own service, so Cordis keeps it
 * pending until `apply()` has provided that service; it never races the plugin.
 * Each check throws through `fail`, which the registry turns into an
 * `InvariantError` carrying this package name; nothing here swallows a failure.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Type-only: resolves `ctx.tools` for the live status-tool probe below.
import type {} from '@deepseek-ai/dsh-tools'
import { readSafeHarnessService, SAFEHARNESS_SERVICE } from './service.js'

/** Full npm package name, used as the invariant reservation key. */
const PACKAGE_NAME = '@upear/dsh-safeharness'

/** Cordis companion plugin name. */
export const name = 'safeharness-invariant'

/**
 * Services required before the checks can run: the invariants registry that hosts
 * them, and the plugin instance they describe. Declaring the latter is what makes
 * the load order deterministic.
 */
export const inject = ['invariants', SAFEHARNESS_SERVICE]

/** Read-only tools the surface must have registered. */
const EXPECTED_TOOLS = ['safeharness_status', 'safeharness_posture', 'safeharness_audit_query'] as const

/**
 * The four invariants the plan requires:
 *
 * 1. a rule set is loaded AND the live hash appears in the ledger (`plugin_loaded`
 *    or a later `rules_reloaded`), so the running detectors are the audited ones;
 * 2. the synchronous guard is registered — it is the one seam that cannot be
 *    reordered away by another plugin — and the read-only tools are present;
 * 3. the ledger accepts a write and reads it back (evidence is being recorded);
 * 4. a `hardened` deployment has not switched off its output guard or made the
 *    audit ledger optional.
 */
const install: InvariantInstaller = async (ctx: Context, fail: InvariantFailure): Promise<void> => {  const service = readSafeHarnessService(ctx)
  if (service === undefined) {
    fail('the safeharness service is not provided, so no security surface is active')
    return
  }
  const { runtime, hooks, registeredTools } = service.handle

  // 1) ruleset loaded + audited
  const liveHash = runtime.engine.rulesetHash
  if (liveHash.length === 0 || runtime.engine.ruleCount === 0) {
    fail('no rule set is loaded; every detection surface would be inert')
    return
  }
  const loadedRecords = await runtime.ledger.query({ limit: 50, kind: 'plugin_loaded' })
  const reloadedRecords = await runtime.ledger.query({ limit: 50, kind: 'rules_reloaded' })
  const auditedHashes = new Set<string>()
  for (const record of [...loadedRecords, ...reloadedRecords]) {
    if (typeof record.ruleset_hash === 'string') auditedHashes.add(record.ruleset_hash)
  }
  if (!auditedHashes.has(liveHash)) {
    fail(`the live rule set (${liveHash.slice(0, 12)}) has no plugin_loaded/rules_reloaded record`)
    return
  }

  // 2) synchronous guard + read-only tools registered
  if (!hooks.guard) {
    fail('the synchronous ctx.tools.guard() is not registered')
    return
  }
  for (const toolName of EXPECTED_TOOLS) {
    if (!registeredTools.includes(toolName)) {
      fail(`tool ${toolName} is not registered`)
      return
    }
  }

  // 2b) the status tool really answers. Note this calls the registered tool
  // *definition* directly, not the host's batch executor: the executor's entry
  // shape changed between host builds (0.2.x takes a `{calls,…}` batch), and an
  // invariant must not be coupled to that. The full pipeline is exercised by the
  // live-session integration test instead.
  const status = await callStatusTool(ctx, fail)
  if (status === undefined) return
  if (status.loaded !== true) {
    fail('safeharness_status did not report loaded:true')
    return
  }
  if (typeof status.ruleCount !== 'number' || status.ruleCount === 0) {
    fail('safeharness_status reported no loaded rules')
    return
  }

  // 3) ledger writable + read back
  const before = runtime.ledger.stats.records
  try {
    await runtime.ledger.append('invariant_probe', {
      decision: 'ok',
      reason_code: 'invariant_probe',
      // Which optional seams this profile provided — the first thing to check when
      // a feature is "missing" in a headless assembly.
      labels: {
        seams: Object.entries(service.handle.hooks).filter(([, wired]) => wired).map(([name]) => name).join(','),
      },
    })
  } catch (error) {
    fail(`the audit ledger rejected an invariant probe: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (runtime.ledger.stats.records <= before) {
    fail('the audit ledger did not account for the invariant probe')
    return
  }

  // 4) hardened coherence
  const config = runtime.config
  if (config.preset === 'hardened') {
    if (config.output.mode === 'off') fail('hardened deployment has the output guard switched off')
    if (!config.audit.required) fail('hardened deployment made the audit ledger optional')
  }
}

/**
 * Call the registered `safeharness_status` definition and dig its canonical payload
 * out of whatever the host returns.
 *
 * @param ctx - child context carrying `tools`.
 * @param fail - reporter that throws an InvariantError.
 * @returns the status payload, or `undefined` when the probe already failed.
 */
async function callStatusTool(
  ctx: Context,
  fail: InvariantFailure,
): Promise<{ loaded?: unknown; ruleCount?: unknown; preset?: unknown } | undefined> {
  const definition = ctx.tools.get('safeharness_status')
  if (definition === undefined) {
    fail('safeharness_status is not resolvable from the registry')
    return undefined
  }
  let outcome: unknown
  try {
    const execute = definition.execute as unknown as (args: unknown, exec: unknown) => Promise<unknown>
    outcome = await execute({}, {})
  } catch (error) {
    fail(`safeharness_status probe threw: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
  const payload = findStatusPayload(outcome, 6)
  if (payload === undefined) {
    fail('safeharness_status probe returned no readable status payload')
    return undefined
  }
  return payload
}

/** Breadth-first search for the status payload inside an unknown reply envelope. */
function findStatusPayload(
  value: unknown,
  depth: number,
): { loaded?: unknown; ruleCount?: unknown; preset?: unknown } | undefined {
  if (depth < 0 || value === null || typeof value !== 'object') return undefined
  if (typeof (value as { loaded?: unknown }).loaded === 'boolean') {
    return value as { loaded?: unknown; ruleCount?: unknown; preset?: unknown }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStatusPayload(item, depth - 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = findStatusPayload(item, depth - 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The installer wrapped so the registry's child fiber can reach the plugin
 * service and the tool registry. `installer.inject` is the registry's documented
 * seam for exactly this; without it the child context cannot read
 * `ctx.safeharness` or `ctx.tools` even though the companion itself injected them.
 */
function installerWithServiceAccess(): InvariantInstaller {
  return Object.assign(install, {
    inject: [SAFEHARNESS_SERVICE, 'tools'],
  }) as unknown as InvariantInstaller
}

/**
 * Register the companion.
 *
 * @param ctx - context carrying the invariants service and our service.
 * @returns the registration disposer once setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, installerWithServiceAccess()))
