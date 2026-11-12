/**
 * Plugin entry point: `apply()` only wires (§6.1.1). Every decision lives in the
 * engine, every record shape in the ledger, every check in posture — this module
 * is the composition root and the place where fail-closed policy is decided.
 *
 * Load contract: any construction step that cannot be completed throws, which
 * refuses the plugin load (fail-closed, §6.1.1). The single exception is the
 * `observe` preset, where a broken rule file or an unwritable ledger degrades to
 * a loud warning plus an empty rule set, because observation must never take the
 * host down (§7).
 * @module
 */
import { readFileSync, watch } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { createEngine, type Engine } from './engine/index.js'
import { createSidecarEngine, type SidecarEngine } from './engine/sidecar-engine.js'
import { Sidecar, SidecarError } from './engine/sidecar.js'
import type { RuleSet } from './engine/types.js'
import { tryLoadRuleSet } from './engine/rules.js'
import { resolveLedgerDir, resolvePanelStatePath, resolveSessionIndexPath } from './audit/paths.js'
import { createLedger } from './audit/ledger.js'
import { Config, resolveConfig, type SafeHarnessConfig, type ResolvedConfig } from './config.js'
import { createRuntime, type LoggerLike, type Runtime } from './runtime.js'
import { SessionStateStore } from './state.js'
import { installInputHook } from './hooks/input.js'
import { sessionCreatedAtOf, sessionIdOf, sessionTitleOf, sessionWorkspaceOf } from './hooks/context.js'
import { installToolHooks } from './hooks/tools.js'
import { installLlmHook, createJudgeFor, createDrafterFor } from './hooks/llm.js'
import { installApprovalHook } from './hooks/approval.js'
import { runPosture, enforceLoadTimePosture, type PostureProbe } from './posture/report.js'
import { runPatrol, type PatrolProbe, type PatrolReport } from './patrol/index.js'
import { statusTool, postureTool, auditQueryTool, patrolTool, draftRuleTool } from './surface/tools.js'
import { registerPromptSection } from './surface/prompt.js'
import { safeharnessCommand, JUDGE_PROBE_TEXT, type JudgeCommandTarget, type DraftCommandTarget } from './surface/commands.js'
import { registerPanelRoute } from './panel/route.js'
import { createPanelSettingsHost } from './panel/settings.js'
import { createPatrolRunner } from './panel/patrol-runner.js'
import { createPatrolScheduler } from './panel/schedule.js'
import { SAFEHARNESS_SERVICE, type HookFlags, type PluginHandle, type SafeHarnessService } from './service.js'
import { sha256Hex } from './util/hash.js'
import { VERSION } from './version.js'

export { Config }
export type { SafeHarnessConfig }
// Version and the pinned host surface are part of the package's public facts: the
// README, the compatibility matrix and tests/version.test.ts all quote them.
export { VERSION }

/** Plugin name shown in Cordis diagnostics. */
export const name = 'safeharness'

/**
 * Services this plugin cannot work without. Deliberately short: every additional
 * name is a way for the plugin to silently never start (a missing injected
 * service keeps the fiber PENDING). Optional seams (`settings`, `commands`,
 * `approval`, `llm`, `sandboxPolicy`, `loader`) are read with `ctx.get()` and
 * degrade instead.
 */
export const inject = ['tools', 'systemPrompt']

/** Settings namespace owning this plugin's user-editable config. */
const SETTINGS_NS = 'safeharness' as unknown as SettingsNamespace

/**
 * Host package versions this build was verified against — measured from the
 * RUNNING host, not from the profile tree: a DSH app resolves a plugin's bare
 * `@deepseek-ai/*` imports to its own bundled copies (0.2.2-rc.1 here), while the
 * profile's node_modules is only the build-time type source (0.1.0-rc.5).
 * `engines.dsh` is the coarse gate; this table is the
 * per-package detail `safeharness_status.host` and the posture check report.
 */
export const PINNED_VERSIONS: Readonly<Record<string, string>> = {
  '@deepseek-ai/cordis': '4.1.0',
  '@deepseek-ai/schemastery': '3.19.0',
  '@deepseek-ai/dsh-agent': '0.2.2-rc.1',
  '@deepseek-ai/dsh-commands': '0.2.2-rc.1',
  '@deepseek-ai/dsh-llm': '0.2.2-rc.1',
  '@deepseek-ai/dsh-session': '0.2.2-rc.1',
  '@deepseek-ai/dsh-settings': '0.2.2-rc.1',
  '@deepseek-ai/dsh-system-prompt': '0.2.2-rc.1',
  '@deepseek-ai/dsh-tools': '0.2.2-rc.1',
}

/**
 * Packages whose resolved version must match exactly, because the plugin either
 * imports them at runtime or builds objects the host validates (`schemastery`
 * schemas, `cordis` services). The rest are reported for diagnosis only: an
 * optional companion (e.g. `dsh-invariants`) may legitimately resolve from the
 * profile tree and is not a contract breach.
 */
const VERSION_CRITICAL: ReadonlySet<string> = new Set([
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-tools',
])

/** Absolute path of the packaged `rules/` directory (sibling of `lib/`). */
function packagedRulesDir(): string {
  return fileURLToPath(new URL('../rules/', import.meta.url))
}

/** An empty rule set for the observe-preset degrade path. */
function emptyRuleSet(reason: string): RuleSet {
  return {
    hash: sha256Hex(`empty:${reason}`),
    rules: [],
    chains: [],
    ruleCount: 0,
    chainCount: 0,
    sources: [],
    loadedAt: Date.now(),
  }
}

/** One-line summary of where the host packages came from (ledger label). */
function summarizeOrigin(surface: Record<string, HostSurfaceEntry>): string {
  const origins = new Set(Object.values(surface).map((entry) => entry.origin))
  if (origins.size === 1) return [...origins][0] ?? 'unknown'
  return 'mixed'
}

/** Human-readable surface list for the startup log (`dsh-tools=0.2.2-rc.1@app-bundle, …`). */
function describeSurface(surface: Record<string, HostSurfaceEntry>): string {
  return Object.entries(surface)
    .map(([packageName, entry]) => `${packageName.replace('@deepseek-ai/', '')}=${entry.version}@${entry.origin}`)
    .join(', ')
}

/**
 * Compact ledger labels for every host package we pin: the resolved version and
 * whether it came from the app bundle or the profile tree. One short string per
 * package keeps the whole `plugin_loaded` line small.
 */
function surfaceLabels(surface: Record<string, HostSurfaceEntry>): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const [packageName, entry] of Object.entries(surface)) {
    labels[`host_${packageName.replace('@deepseek-ai/', '').replace(/-/gu, '_')}`] = `${entry.version}@${entry.origin}`
  }
  return labels
}

/** Logger adapter over Cordis's logger (which is callable and has level methods). */
function loggerOf(ctx: Context): LoggerLike {
  const logger = ctx.logger as unknown as Partial<LoggerLike> & ((message: string) => void)
  const call = (level: 'info' | 'warn' | 'error') => (message: string): void => {
    const fn = logger[level]
    if (typeof fn === 'function') fn.call(logger, message)
    else logger(message)
  }
  return { info: call('info'), warn: call('warn'), error: call('error') }
}

/** Which copy of a host package the running process actually loaded. */
export interface HostSurfaceEntry {
  readonly version: string
  /** `app-bundle` = shipped inside the DSH app bundle; `profile` = the profile's node_modules. */
  readonly origin: 'app-bundle' | 'profile' | 'other' | 'unknown'
}

/**
 * Test-only override for {@link probeHostSurface}.
 *
 * The probe answers with what the *running* process resolves, which in a unit-test
 * process (vitest, Node) is the profile tree — not the host app bundle. Tests that
 * drive `apply()` under `hardened` (where a mismatch refuses the load by design)
 * use this to state the surface they are simulating. It is unreachable from config
 * and has no production caller.
 */
let hostSurfaceOverride: (() => Record<string, HostSurfaceEntry>) | undefined

/** Install (or clear) the test-only surface override. */
export function __setHostSurfaceProbeForTests(probe?: () => Record<string, HostSurfaceEntry>): void {
  hostSurfaceOverride = probe
}

/**
 * A surface that matches every pinned version — for tests that drive `apply()` in a
 * plain Node process (where real resolution lands on the profile tree and would
 * otherwise trip the hardened version gate).
 */
export function __matchingHostSurfaceForTests(): Record<string, HostSurfaceEntry> {
  const surface: Record<string, HostSurfaceEntry> = {}
  for (const [packageName, version] of Object.entries(PINNED_VERSIONS)) {
    surface[packageName] = { version, origin: 'app-bundle' }
  }
  return surface
}

/**
 * Resolve every host package the way the *running* process will.
 *
 * This is diagnostic gold: a DSH host may resolve a plugin's bare
 * `@deepseek-ai/*` imports to its own bundled copies (app.asar) instead of the
 * profile's node_modules. Recording which copy answered turns a mysterious
 * "missing export" crash into one ledger line.
 *
 * @returns package name → resolved version and origin.
 */
export function probeHostSurface(): Record<string, HostSurfaceEntry> {
  if (hostSurfaceOverride !== undefined) return hostSurfaceOverride()
  const surface: Record<string, HostSurfaceEntry> = {}
  for (const packageName of Object.keys(PINNED_VERSIONS)) {
    let url = ''
    try {
      url = import.meta.resolve(packageName)
    } catch {
      url = ''
    }
    if (url === '') {
      surface[packageName] = { version: 'unresolved', origin: 'unknown' }
      continue
    }
    const origin: HostSurfaceEntry['origin'] = url.includes('app.asar')
      ? 'app-bundle'
      : url.includes('.dsh/profiles') || url.includes('profiles/node_modules')
        ? 'profile'
        : 'other'
    let version = 'unknown'
    try {
      const manifestPath = fileURLToPath(new URL('../package.json', url))
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown }
      if (typeof manifest.version === 'string') version = manifest.version
    } catch {
      /* version stays unknown; origin is still useful */
    }
    surface[packageName] = { version, origin }
  }
  return surface
}

/** Detected DSH package version mismatches, e.g. `dsh-tools@x!=y`. */
function detectVersionMismatch(): readonly string[] {
  const problems: string[] = []
  for (const [packageName, entry] of Object.entries(probeHostSurface())) {
    if (!VERSION_CRITICAL.has(packageName)) continue
    const expected = PINNED_VERSIONS[packageName]
    if (expected === undefined) continue
    if (entry.version !== expected) problems.push(`${packageName} ${entry.version} != ${expected} (${entry.origin})`)
  }
  return problems
}

/** Whether the HMR plugin is composed in this profile (loader entry scan). */
function detectHmr(ctx: Context): boolean | undefined {
  const loader = ctx.get('loader') as { entries?: () => Generator<{ name?: unknown; disabled?: unknown }> } | undefined
  if (loader === undefined || typeof loader.entries !== 'function') return undefined
  try {
    for (const entry of loader.entries()) {
      if (typeof entry.name === 'string' && /(^|\/)dsh-hmr$/u.test(entry.name)) {
        return entry.disabled !== true
      }
    }
    return false
  } catch {
    return undefined
  }
}

/**
 * The host's `llm` service, when this profile composes one.
 *
 * The semantic judge calls the model through it (§6.6: never our own HTTP client),
 * so its presence is what decides `judge_unavailable` and the hardened load gate.
 */
function llmServiceOf(ctx: Context): { stream?: (options: unknown) => AsyncIterable<unknown> } | undefined {
  const service = ctx.get('llm') as { stream?: (options: unknown) => AsyncIterable<unknown> } | undefined
  if (service === undefined || typeof service.stream !== 'function') return undefined
  return service
}

/** Current sandbox mode from the policy service, when composed. */
function detectSandboxMode(ctx: Context): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined {  const service = ctx.get('sandboxPolicy') as { resolve?: (request?: object) => { mode?: unknown } } | undefined
  if (service === undefined || typeof service.resolve !== 'function') return undefined
  try {
    const mode = service.resolve({}).mode
    if (mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access') return mode
  } catch {
    /* not composed in a usable way — reported as SKIP by the check */
  }
  return undefined
}

/**
 * Wire the plugin.
 *
 * @param ctx - the plugin's Cordis context.
 * @param config - entry config from the profile patch layer (validated by `Config`).
 * @throws ConfigError from `resolveConfig`, Error from the rule loader (balanced /
 *   hardened), the ledger constructor (when `audit.required`), the system prompt
 *   registration, or the hardened posture gate.
 */
export async function apply(ctx: Context, config: SafeHarnessConfig = {}): Promise<void> {
  const startedAt = Date.now()
  const logger = loggerOf(ctx)

  // 1) Config: preset expansion + validation. A bad config refuses the load.
  const cfg = resolveConfig(config)

  // 1b) Judge feasibility gate (§7): a hardened deployment that *requires* the
  // semantic judge cannot start without an `llm` service to call it through — the
  // plugin must never silently fall back to "judge disabled" in that preset.
  if (cfg.preset === 'hardened' && cfg.output.judge.enabled && llmServiceOf(ctx) === undefined) {
    throw new Error('safeharness: refusing to load: output.judge.enabled under hardened but this profile provides no llm service')
  }

  // 2) Rules: compile. observe degrades, balanced/hardened refuse.
  const rulesOptions = { packagedRulesDir: packagedRulesDir(), dir: cfg.rules.dir, inline: cfg.rules.inline }
  const loaded = tryLoadRuleSet(rulesOptions)
  let ruleset: RuleSet
  if (loaded.ok) {
    ruleset = loaded.ruleset
  } else if (cfg.preset === 'observe') {
    for (const problem of loaded.error.problems) logger.warn(`safeharness: rule problem (ignored in observe): ${problem}`)
    ruleset = emptyRuleSet('load-failed')
  } else {
    throw loaded.error
  }

  // 3) Ledger: construct. `required: true` refuses an unwritable sink.
  const ledger = createLedger({
    ...cfg.audit,
    dir: resolveLedgerDir(cfg.audit.dir),
    pluginVersion: VERSION,
    rulesetHash: ruleset.hash,
  })

  // 4) Engine + runtime. The optional Python sidecar serves ONLY the asynchronous
  // input path (§6.14): `tools.guard` is IO-free, so the built-in engine stays
  // authoritative for every synchronous surface and is the fallback when the child
  // is unavailable. A failed start does not throw here: posture reports
  // `engine_sidecar_unavailable` and `posture.failOn` decides whether that blocks
  // the load (hardened) or degrades to the built-in engine (observe/balanced).
  let sidecarEngine: SidecarEngine | undefined
  if (cfg.engine.kind === 'sidecar') {
    const client = new Sidecar({
      command: cfg.engine.command,
      args: cfg.engine.args,
      cwd: cfg.engine.cwd.length > 0 ? cfg.engine.cwd : undefined,
      timeoutMs: cfg.engine.timeoutMs,
      startTimeoutMs: cfg.engine.startTimeoutMs,
    })
    const candidate = createSidecarEngine({
      builtin: createEngine(ruleset, cfg),
      sidecar: client,
      timeoutMs: cfg.engine.timeoutMs,
      logger,
    })
    try {
      await candidate.prepare()
      sidecarEngine = candidate
    } catch (error) {
      const code = error instanceof SidecarError ? error.code : 'sidecar_error'
      logger.error(`safeharness: python input engine unavailable (${code}); posture will report it`)
      sidecarEngine = candidate
    }
  }
  const engine: Engine = sidecarEngine ?? createEngine(ruleset, cfg)
  // Metadata-only index: workspace path and latest session title, so the panel's
  // workspace/conversation filters still make sense after a restart. Never prompt
  // text, tool arguments or model output (see state.ts and README §limits).
  const sessionState = new SessionStateStore({ path: resolveSessionIndexPath(), logger })
  const runtime = createRuntime({ config: cfg, engine, ledger, logger, state: sessionState })

  const hooks: HookFlags = {
    input: false,
    tools: false,
    guard: false,
    llm: false,
    approval: false,
    prompt: false,
    commands: false,
    settings: false,
  }
  const handle: PluginHandle = {
    runtime,
    startedAt,
    hooks,
    registeredTools: [],
    loadedRulesetHash: ruleset.hash,
    postureChecked: false,
  }

  // 5) Host surface, load record, then the load-time posture gate.
  //
  // The gate deliberately runs BEFORE any seam is wired or the service is provided
  // (M4 fix, §12 R36). When it ran at the end (M0–M3), a hit did throw and the fiber
  // failed — but the listeners registered earlier in the same `apply()` stayed alive
  // in this Cordis version, so a "refused" plugin kept inspecting (`input_checked`,
  // `output_reviewed` in the ledger *after* `posture_report fail`). Running the gate
  // first makes "refuse to load" mean nothing of ours is active.
  const surface = probeHostSurface()
  logger.info(`safeharness: host surface ${describeSurface(surface)}`)
  const probe: PostureProbe = {
    sandboxMode: () => detectSandboxMode(ctx),
    hmrEnabled: () => detectHmr(ctx),
    versionMismatch: () => detectVersionMismatch(),
    // Approval policy has no session-free reader; the check reports SKIP until a
    // session exists (recorded as a known limitation in the M1 evidence).
    approvalPolicy: () => undefined,
    engine: () => (sidecarEngine === undefined
      ? { kind: 'builtin' as const, status: 'ready' as const }
      : { kind: 'sidecar' as const, status: sidecarEngine.sidecarStatus, rulesStale: sidecarEngine.rulesStale }),
  }

  await ledger.append('plugin_loaded', {
    decision: 'ok',
    reason_code: 'plugin_loaded',
    ruleset_hash: ruleset.hash,
    preset: cfg.preset,
    labels: {
      version: VERSION,
      host_surface: summarizeOrigin(surface),
      engine: sidecarEngine === undefined ? 'builtin' : 'sidecar',
      // The four packages whose identity actually decides compatibility; short
      // enough to stay a label (the ledger hashes anything over 256 chars).
      ...surfaceLabels(surface),
    },
    metrics: { rule_count: ruleset.ruleCount, chain_count: ruleset.chainCount, startup_ms: Date.now() - startedAt },
  })

  if (cfg.posture.onLoad) {
    try {
      await enforceLoadTimePosture(runtime, probe, cfg)
      handle.postureChecked = true
    } catch (error) {
      // Either a failOn gate hit (rethrow: refuse load) or the report itself
      // failed (observation surface: warn and continue).
      if (error instanceof Error && error.message.startsWith('safeharness: refusing to load')) {
        // Nothing of ours may stay active on a refused load, and that includes the
        // child process the engine gate just complained about.
        await sidecarEngine?.stop()
        throw error
      }
      runtime.internalError('posture:onLoad', error)
    }
  }

  // 6) Publish the service only after the gate passed. The invariant companion
  // injects it, so providing it last is what makes the companion observe a fully
  // wired plugin instead of racing `apply()`.
  const service: SafeHarnessService = {
    version: VERSION,
    rulesetHash: ruleset.hash,
    ruleCount: ruleset.ruleCount,
    handle,
  }
  ctx.provide(SAFEHARNESS_SERVICE, service)

  // Set during fiber teardown so a config update racing the disposal cannot touch
  // a ledger that is already closing.
  let disposed = false

  // Everything below is owned by the fiber: disposers are managed by Cordis.
  ctx.effect(() => () => {
    disposed = true
    // Flush the metadata index before the process goes away; the ledger closes
    // after it so a late record still lands.
    sessionState.dispose()
    // Stop the child first: after `ledger.close()` its records would be dropped.
    void sidecarEngine?.stop()
    void ledger.close()
  }, 'safeharness:teardown')

  ctx.on('session/event', (session, event) => {
    try {
      runtime.state.observe(event as { type: string; seq: number; time: number })
      // Titles are produced by the host's title provider as events arrive, not
      // before the first pre-step. Capturing on every event means the metadata
      // index learns a rename/suggestion without waiting for the next turn.
      runtime.state.describe(sessionIdOf({ session }), {
        workspace: sessionWorkspaceOf({ session }),
        createdAt: sessionCreatedAtOf({ session }),
        title: sessionTitleOf(ctx, { session }),
      })
    } catch (error) {
      runtime.internalError('session/event', error)
    }
  })

  installInputHook(ctx, runtime)
  hooks.input = true
  installToolHooks(ctx, runtime)
  hooks.tools = true
  hooks.guard = true
  installLlmHook(ctx, runtime)
  hooks.llm = true
  // Approval bridge (T3.3): always registered, mode read per event so a settings
  // change from delegate to policy applies without a restart.
  hooks.approval = installApprovalHook(ctx, runtime)

  // 7) Prompt clause.
  registerPromptSection(ctx, cfg)
  hooks.prompt = true

  // 8) Posture runner and patrol (both read the same probes).
  const posture = (): ReturnType<typeof runPosture> => runPosture(runtime, probe)

  // 8b) Patrol (T3.4): shares the posture runner for the drift check and reads the
  // ledger for the rate/reconciliation checks. Its own HTTP/notification calls are
  // the only network activity the plugin ever performs.
  const patrolProbe: PatrolProbe = {
    sandboxMode: probe.sandboxMode,
    approvalPolicy: probe.approvalPolicy,
    posture,
  }
  const patrol = (options?: { include?: readonly string[] }): Promise<PatrolReport> =>
    runPatrol(runtime, patrolProbe, options)

  // 9) Surfaces.
  const judgeFact = (): { enabled: boolean; scope: string; available: boolean; provider: string; model: string } => ({
    // Read through the runtime, not the load-time config: a settings hot-reload can
    // flip these without re-registering the hook.
    enabled: runtime.config.output.judge.enabled,
    scope: runtime.config.output.judge.scope,
    available: llmServiceOf(ctx) !== undefined,
    // Route ids are configuration, not secrets; the API key never appears here.
    provider: runtime.config.output.judge.provider,
    model: runtime.config.output.judge.model,
  })
  const budgetFact = (): { enabled: boolean; limit: number; sessions: number } => ({
    enabled: runtime.budget.enabled,
    limit: runtime.budget.limitValue,
    sessions: runtime.budget.size,
  })
  const engineFact = (): {
    kind: 'builtin' | 'sidecar'
    status: string
    rulesStale: boolean
    pending: number
    badLines: number
    lastError?: string
  } => {
    const lastError = sidecarEngine?.lastError
    return {
      kind: sidecarEngine === undefined ? 'builtin' : 'sidecar',
      status: sidecarEngine === undefined ? 'ready' : sidecarEngine.sidecarStatus,
      rulesStale: sidecarEngine === undefined ? false : sidecarEngine.rulesStale,
      pending: sidecarEngine === undefined ? 0 : sidecarEngine.sidecarStats.pending,
      badLines: sidecarEngine === undefined ? 0 : sidecarEngine.sidecarStats.badLines,
      ...(lastError === undefined ? {} : { lastError }),
    }
  }
  const facts = { judge: judgeFact, budget: budgetFact, engine: engineFact }
  // Rule drafting (M5 T5.2): one auxiliary call, validated with the loader's own gate,
  // returned as text. It is wired to both the model-facing tool and `/safeharness draft`
  // so there is exactly one implementation of "what a draft means".
  const drafter = createDrafterFor(ctx, runtime)
  const draftLimits = (): { enabled: boolean; maxChars: number; timeoutMs: number; maxTokens: number } => {
    const draft = runtime.config.draft
    return { enabled: draft.enabled, maxChars: draft.maxChars, timeoutMs: draft.timeoutMs, maxTokens: draft.maxTokens }
  }
  for (const definition of [
    statusTool(runtime, startedAt, surface, hooks as unknown as Record<string, boolean>, facts),
    postureTool(posture),
    patrolTool(patrol),
    auditQueryTool(runtime),
    draftRuleTool(drafter, draftLimits),
  ]) {
    ctx.tools.register(definition)
    handle.registeredTools.push(definition.name)
  }

  const commands = ctx.get('commands') as { register?: (definition: unknown) => () => void } | undefined
  if (commands !== undefined && typeof commands.register === 'function') {
    try {
      // The diagnostic probe reuses the output guard's own judge handle, so a green
      // `/safeharness judge probe` proves the configured provider/model/key really
      // answer over the route the guard would use. Only status/verdict/latency are
      // printed; the reviewed text and the credential are never surfaced.
      const judgeHandle = createJudgeFor(ctx, runtime)
      const judgeTarget: JudgeCommandTarget = {
        state: judgeFact,
        probe: () => judgeHandle.review(JUDGE_PROBE_TEXT, {
          maxChars: 512,
          timeoutMs: Math.max(1000, runtime.config.output.judge.timeoutMs),
        }),
      }
      const draftTarget: DraftCommandTarget = {
        // Read live, so flipping `draft.enabled` in settings takes effect without a reload.
        get enabled() {
          return runtime.config.draft.enabled
        },
        draft: (description, kind) => drafter.draft({ description, kind }, {
          timeoutMs: runtime.config.draft.timeoutMs,
          maxChars: runtime.config.draft.maxChars,
          maxTokens: runtime.config.draft.maxTokens,
        }),
      }
      commands.register(safeharnessCommand(runtime, posture, patrol, judgeTarget, draftTarget))
      hooks.commands = true
    } catch (error) {
      runtime.internalError('commands', error)
    }
  } else {
    logger.info('safeharness: command service absent in this profile; /safeharness is unavailable')
  }

  // 10) Live configuration.
  //
  // 10a) Host 0.2.2-rc.1 settings shape: the host derives settings pages from the
  // plugin's own `Config` and commits `.volatile()` fields into the running fiber
  // without a remount. The Loader then emits `loader/volatile-update` to listeners
  // owned by that fiber, so this listener sees only this entry's updates. `config`
  // is the resolved object `apply()` received; its volatile refs are updated in
  // place, which is why re-resolving it here reads the new values.
  //
  // A settings write can reach this listener more than once (the configuration
  // editor reconciles the patch, and the profile watcher may reload it again). The
  // cheap equality check keeps the ledger to one `rules_reloaded` per real change.
  ctx.on('loader/volatile-update', () => {
    if (disposed) return
    try {
      const next = resolveConfig(config)
      if (sameConfig(runtime.config, next)) return
      applyHotConfig(runtime, next, rulesOptions, logger)
    } catch (error) {
      // Same contract as the legacy path: keep the last good config, say so loudly.
      logger.warn(`safeharness: rejected live config update, keeping previous config: ${describe(error)}`)
    }
  })

  // 10b) Report the settings seam honestly. The service starts after the services
  // this plugin injects, so a load-time `ctx.get('settings')` is always undefined
  // in a real host; `ctx.inject` is the ordering-safe read. A host that still
  // exposes the older namespace-registration API gets the legacy watch path.
  ctx.inject(['settings'], (settingsCtx) => {
    const settingsService = settingsCtx.get('settings') as
      | {
        register?: (ns: SettingsNamespace, schema: unknown, options?: object) => { watch?: (cb: (next: SafeHarnessConfig) => void | Promise<void>) => () => void }
        configure?: (...args: unknown[]) => unknown
        describe?: (...args: unknown[]) => unknown
      }
      | undefined
    if (settingsService === undefined) return
    if (typeof settingsService.register === 'function') {
      try {
        const scope = settingsService.register(SETTINGS_NS, Config, { base: config })
        hooks.settings = true
        scope.watch?.((next) => {
          try {
            const nextCfg = resolveConfig(next)
            applyHotConfig(runtime, nextCfg, rulesOptions, logger)
          } catch (error) {
            // A rejected settings write is the settings service's problem; we keep
            // the last good config and say so loudly (§7, hot-update failure).
            logger.warn(`safeharness: rejected settings update, keeping previous config: ${describe(error)}`)
          }
        })
      } catch (error) {
        runtime.internalError('settings', error)
      }
      return
    }
    if (typeof settingsService.configure === 'function' && typeof settingsService.describe === 'function') {
      // The pages come from `Config` + the volatile fields; nothing to register.
      hooks.settings = true
      logger.info('safeharness: settings service detected; configuration pages are host-driven')
    }
  })

  // 10c) Optional Web-GUI panel (T5.3). The browser half ships in this package as
  // a prebuilt client bundle; this half serves it a read-only payload over a
  // private Connection RPC channel. Only profiles that compose the `connection`
  // service (the Web GUI bundle does; headless profiles do not) get a channel,
  // and the browser tab tolerates the channel being absent on its own.
  // The panel's actions share one patrol gate; the optional timer is a thin
  // wrapper around the same runner, so a click and a tick can never overlap.
  const patrolRunner = createPatrolRunner(patrol)
  const schedule = createPatrolScheduler({
    run: async () => {
      const outcome = await patrolRunner.runScheduled()
      if (!outcome.ok) logger.warn(`safeharness: scheduled patrol skipped (${outcome.code})`)
    },
    statePath: resolvePanelStatePath(),
    logger,
  })
  ctx.effect(() => () => { schedule.dispose() }, 'safeharness: panel schedule')
  const reloadRulesForPanel = (): { rules: number; chains: number; hash: string } => {
    const reloaded = tryLoadRuleSet(rulesOptions)
    if (!reloaded.ok) throw new Error(reloaded.error.problems.join('; ').slice(0, 200))
    runtime.engine.reloadRules(reloaded.ruleset)
    runtime.audit('rules_reloaded', {
      decision: 'ok',
      reason_code: 'panel_reload',
      labels: { source: 'panel' },
      metrics: { rules: reloaded.ruleset.ruleCount, chains: reloaded.ruleset.chainCount },
    })
    return {
      rules: reloaded.ruleset.ruleCount,
      chains: reloaded.ruleset.chainCount,
      hash: reloaded.ruleset.hash.slice(0, 12),
    }
  }
  // The judge/drafting settings tab writes through the host's own settings
  // service; every read is lazy because `settings` starts after this plugin.
  const panelSettings = createPanelSettingsHost(ctx, runtime, logger)
  registerPanelRoute(ctx, {
    runtime,
    startedAt,
    logger,
    facts: {
      engine: engineFact,
      rulesDir: () => runtime.config.rules.dir,
      draft: () => ({ enabled: runtime.config.draft.enabled, maxChars: runtime.config.draft.maxChars }),
      judge: () => panelSettings.judgeFact(),
      schedule: () => schedule.snapshot(),
    },
    patrolRunner,
    draft: input => drafter.draft(input, {
      timeoutMs: runtime.config.draft.timeoutMs,
      maxChars: runtime.config.draft.maxChars,
      maxTokens: runtime.config.draft.maxTokens,
    }),
    schedule,
    reloadRules: reloadRulesForPanel,
    settings: panelSettings,
  })
  // 11) Rule-file watch (failures keep the previous rule set, never half-apply).
  if (cfg.rules.watch) {
    const dir = cfg.rules.dir.length > 0 ? resolve(cfg.rules.dir) : packagedRulesDir()
    installRuleWatch(ctx, runtime, dir, rulesOptions, logger)
  }
}

/**
 * Apply a new config without a restart: recompile rules, swap config, keep the
 * ledger where it is (a directory change needs a restart; said so in the log).
 *
 * Exported for tests: the settings watcher is the only production caller, and the
 * "a bad hot update keeps the previous rule set" contract is worth a direct test.
 */
export function applyHotConfig(
  runtime: Runtime,
  next: ResolvedConfig,
  rulesOptions: { packagedRulesDir: string; dir: string; inline: readonly unknown[] },
  logger: LoggerLike,
): void {
  const previous = runtime.config
  if (next.audit.dir !== previous.audit.dir || next.audit.format !== previous.audit.format) {
    logger.warn('safeharness: audit sink settings changed; a profile restart is required to move the ledger')
  }
  const loaded = tryLoadRuleSet({ ...rulesOptions, dir: next.rules.dir, inline: next.rules.inline })
  if (!loaded.ok) {
    for (const problem of loaded.error.problems) logger.warn(`safeharness: keeping previous rule set: ${problem}`)
    runtime.reconfigure(next)
    return
  }
  runtime.engine.reloadRules(loaded.ruleset)
  runtime.reconfigure(next)
  runtime.audit('rules_reloaded', {
    decision: 'ok',
    reason_code: 'rules_reloaded',
    ruleset_hash: loaded.ruleset.hash,
    preset: next.preset,
    metrics: { rule_count: loaded.ruleset.ruleCount, chain_count: loaded.ruleset.chainCount },
  })
}

/** Watch the rule directory and reload on mtime-ish changes (debounced). */
function installRuleWatch(
  ctx: Context,
  runtime: Runtime,
  dir: string,
  rulesOptions: { packagedRulesDir: string; dir: string; inline: readonly unknown[] },
  logger: LoggerLike,
): void {
  let timer: NodeJS.Timeout | undefined
  ctx.effect(() => {
    let watcher: ReturnType<typeof watch> | undefined
    try {
      watcher = watch(dir, { persistent: false }, () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          const loaded = tryLoadRuleSet(rulesOptions)
          if (!loaded.ok) {
            for (const problem of loaded.error.problems) logger.warn(`safeharness: rule reload failed, keeping previous: ${problem}`)
            return
          }
          runtime.engine.reloadRules(loaded.ruleset)
          runtime.audit('rules_reloaded', {
            decision: 'ok',
            reason_code: 'rules_reloaded',
            ruleset_hash: loaded.ruleset.hash,
            labels: { trigger: 'watch' },
            metrics: { rule_count: loaded.ruleset.ruleCount },
          })
        }, 250)
      })
    } catch (error) {
      logger.warn(`safeharness: cannot watch rules directory ${dir}: ${describe(error)}`)
    }
    return () => {
      if (timer !== undefined) clearTimeout(timer)
      watcher?.close()
    }
  }, 'safeharness:rules-watch')
}

/** One-line error description for logs. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Cheap structural equality for two resolved configs.
 *
 * Every field is plain JSON data (no functions, no cycles) and the object is
 * small, so stringifying is safe here. Used only to swallow duplicate Loader
 * `loader/volatile-update` events produced by one settings write.
 */
function sameConfig(a: ResolvedConfig, b: ResolvedConfig): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
