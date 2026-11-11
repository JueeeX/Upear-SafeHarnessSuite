/**
 * The service the plugin provides to the rest of the process.
 *
 * A companion (`./invariant`) is a *separate* Cordis plugin entry, so it cannot
 * reach the main plugin's closure. Declaring `inject: ['safeharness']` makes
 * Cordis order the two fibers for us — the companion waits until the service is
 * provided instead of racing it (which is exactly what a module singleton got
 * wrong the first time: the companion ran before `apply()` finished).
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Runtime } from './runtime.js'

/** Which seams the plugin actually wired, for the invariant companion. */
export interface HookFlags {
  input: boolean
  tools: boolean
  guard: boolean
  llm: boolean
  /** Approval bridge listener registered (T3.3). */
  approval: boolean
  prompt: boolean
  commands: boolean
  settings: boolean
}

/** The running plugin instance's public facts. */
export interface PluginHandle {
  readonly runtime: Runtime
  /** Epoch ms of `apply()` entry. */
  readonly startedAt: number
  /** Which listeners registered successfully (a seam may be missing in headless). */
  readonly hooks: HookFlags
  /** Names of the model-facing tools that registered successfully. */
  readonly registeredTools: string[]
  /** The rule-set hash recorded in the `plugin_loaded` ledger line. */
  readonly loadedRulesetHash: string
  /** Set once load-time posture completed without refusing the load. */
  postureChecked: boolean
}

/** The service value provided as `ctx.safeharness`. */
export interface SafeHarnessService {
  readonly version: string
  readonly rulesetHash: string
  readonly ruleCount: number
  readonly handle: PluginHandle
}

/** Service name, i.e. the key in `ctx.provide(name, value)` and `inject`. */
export const SAFEHARNESS_SERVICE = 'safeharness'

/**
 * Read the service without assuming it exists.
 *
 * @param ctx - any context (the caller should declare it in `inject` so Cordis
 *   orders the fibers; this accessor is for defensive reads).
 * @returns the service, or `undefined` when this plugin is not loaded.
 */
export function readSafeHarnessService(ctx: Context): SafeHarnessService | undefined {
  try {
    return (ctx as unknown as Record<string, SafeHarnessService | undefined>)[SAFEHARNESS_SERVICE]
  } catch {
    // Reading an un-injected service throws in Cordis; a companion probing for
    // availability must not crash because of it.
    return undefined
  }
}
