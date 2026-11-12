/**
 * Minimal in-memory stand-in for a Cordis `Context`, enough to drive the hook
 * layer without booting a host.
 *
 * The point is to assert *wiring*, not to reimplement Cordis: listeners are stored
 * per event name, `effect` bodies run immediately, and services are a plain map.
 * Any event name a hook subscribes to but this helper does not model would show up
 * as a missing listener in the tests that drive it.
 * @module
 */
import type { AuditKind, Ledger } from '../../src/audit/types.js'
import type { Runtime } from '../../src/runtime.js'
import { createRuntime } from '../../src/runtime.js'
import { createEngine } from '../../src/engine/index.js'
import { createLedger } from '../../src/audit/ledger.js'
import { loadRuleSet } from '../../src/engine/rules.js'
import { resolveConfig, type ResolvedConfig, type SafeHarnessConfig } from '../../src/config.js'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { RuleSet } from '../../src/engine/types.js'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** One captured listener registration. */
export interface CapturedListener {
  readonly event: string
  readonly handler: (...args: unknown[]) => unknown
}

/** A registered tool definition captured from `ctx.tools.register`. */
export interface CapturedTool {
  readonly name: string
  readonly definition: Record<string, unknown>
}

/** The fake context plus everything a test needs to drive it. */
export interface FakeHost {
  /** The object handed to hooks as `ctx`. */
  readonly ctx: Record<string, unknown>
  /** Listeners in registration order per event. */
  readonly listeners: Map<string, CapturedListener[]>
  /** Synchronous guards registered through `ctx.tools.guard`. */
  readonly guards: ((exec: unknown) => string | undefined)[]
  /** Tools registered through `ctx.tools.register`, by name. */
  readonly tools: Map<string, CapturedTool>
  /** Prompt sections registered. */
  readonly promptSections: { name: string; order: number; text: string; complete?: boolean }[]
  /** Effects registered (their disposers). */
  readonly disposers: (() => unknown)[]
  /** Services readable through `ctx.get`. */
  readonly services: Map<string, unknown>
  /** Invoke every listener of one event with a `next` waterfall. */
  emit(event: string, ...args: unknown[]): Promise<unknown>
  /**
   * Invoke every `llm/stream` listener. Unlike the promise waterfall, the stream
   * seam hands `next` back as a *synchronous* factory of an `AsyncIterable`, so it
   * needs its own composition path.
   */
  emitStream<T>(event: string, options: unknown, source: () => AsyncIterable<T>): AsyncIterable<T>
  /** Invoke every listener of one event synchronously (for emit-mode events). */
  emitSync(event: string, ...args: unknown[]): void
}

/** Options for {@link createFakeHost}. */
export interface FakeHostOptions {
  readonly config?: SafeHarnessConfig
  /** Override the resolved config (after preset expansion). */
  readonly resolved?: ResolvedConfig
  /** Replace the rule set (defaults to the packaged rules). */
  readonly ruleset?: RuleSet
  /** Replace the engine (defaults to the built-in engine over `ruleset`). */
  readonly engine?: import('../../src/engine/index.js').Engine
  /** Services exposed to `ctx.get`. */
  readonly services?: Record<string, unknown>
  /** Ledger instance to use (defaults to a temp-dir ledger). */
  readonly ledger?: Ledger
}

/** Load the packaged rule set once per test file. */
let packaged: RuleSet | undefined
export function packagedRules(): RuleSet {
  if (packaged === undefined) packaged = loadRuleSet({ packagedRulesDir: join(pluginRoot, 'rules') })
  return packaged
}

/** Create a temp ledger directory (never inside the repo). */
export function tempLedgerDir(): string {
  return mkdtempSync(join(tmpdir(), 'safeharness-hooks-'))
}

/** Build the runtime + fake context for one test. */
export function createFakeHost(options: FakeHostOptions = {}): { host: FakeHost; runtime: Runtime; config: ResolvedConfig } {
  const config = options.resolved ?? resolveConfig({ preset: 'observe', ...options.config })
  const ruleset = options.ruleset ?? packagedRules()
  const ledger = options.ledger ?? createLedger({
    dir: tempLedgerDir(),
    format: 'ndjson',
    redact: true,
    hashChain: true,
    required: false,
    rotateMb: 64,
    pluginVersion: 'test',
    rulesetHash: ruleset.hash,
  })
  const engine = options.engine ?? createEngine(ruleset, config)
  const runtime = createRuntime({
    config,
    engine,
    ledger,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })

  const listeners = new Map<string, CapturedListener[]>()
  const guards: ((exec: unknown) => string | undefined)[] = []
  const tools = new Map<string, CapturedTool>()
  const promptSections: { name: string; order: number; text: string; complete?: boolean }[] = []
  const disposers: (() => unknown)[] = []
  const services = new Map<string, unknown>(Object.entries(options.services ?? {}))

  const ctx: Record<string, unknown> = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = listeners.get(event) ?? []
      list.push({ event, handler })
      listeners.set(event, list)
      return () => {}
    },
    effect(execute: () => unknown) {
      const disposer = execute()
      if (typeof disposer === 'function') disposers.push(disposer as () => unknown)
      return () => Promise.resolve()
    },
    get(name: string) {
      return services.get(name)
    },
    provide(name: string, value: unknown) {
      services.set(name, value)
      return () => {}
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: {
      register(definition: Record<string, unknown>) {
        tools.set(String(definition.name), { name: String(definition.name), definition })
        return () => {}
      },
      get(name: string) {
        return tools.get(name)?.definition
      },
      guard(guard: (exec: unknown) => string | undefined) {
        guards.push(guard)
        return () => {}
      },
    },
    systemPrompt: {
      section(section: { name: string; order: number; text: string; complete?: boolean }) {
        promptSections.push(section)
        return () => {}
      },
    },
  }

  const host: FakeHost = {
    ctx,
    listeners,
    guards,
    tools,
    promptSections,
    disposers,
    services,
    async emit(event, ...args) {
      const list = listeners.get(event) ?? []
      if (list.length === 0) throw new Error(`no listener registered for ${event}`)
      // Build a waterfall: last "next" resolves to the fallback (third argument).
      const fallback = args[args.length - 1] as () => unknown
      const payload = args.slice(0, -1)
      let index = 0
      const next = async (): Promise<unknown> => {
        if (index >= list.length) return fallback()
        const current = list[index]
        index += 1
        return await current.handler(...payload, next)
      }
      return await next()
    },
    emitStream(event, options, source) {
      const list = listeners.get(event) ?? []
      if (list.length === 0) throw new Error(`no listener registered for ${event}`)
      let factory: () => AsyncIterable<unknown> = source as () => AsyncIterable<unknown>
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const handler = list[index]?.handler
        const inner = factory
        factory = () => handler?.(options, inner) as AsyncIterable<unknown>
      }
      return factory() as AsyncIterable<never>
    },
    emitSync(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener.handler(...args)
    },
  }

  return { host, runtime, config }
}

/** Await all queued best-effort ledger writes by appending and reading back. */
export async function flushLedger(runtime: Runtime): Promise<void> {
  await runtime.ledger.append('invariant_probe', { decision: 'ok', reason_code: 'flush' })
}

/** Read every record of the runtime's ledger, oldest first. */
export async function readLedger(runtime: Runtime): Promise<Record<string, unknown>[]> {
  const records = await runtime.ledger.query({ limit: 500 })
  return records as unknown as Record<string, unknown>[]
}

/** Filter records by kind for assertions. */
export function kinds(records: Record<string, unknown>[]): AuditKind[] {
  return records.map((record) => record.kind as AuditKind)
}
