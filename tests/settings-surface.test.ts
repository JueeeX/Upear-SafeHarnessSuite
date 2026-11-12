/**
 * Host settings surface (P3, 1.2.1).
 *
 * Measured on the real 0.2.2-rc.1 host: the `settings` service is a forms service
 * (`describe`/`configure`/`write`), not the older namespace-registration provider;
 * it appears only after the services this plugin injects; and only fields declared
 * `.volatile()` are editable live. The tests here lock down the three pieces this
 * plugin owns: the volatile subset, unwrapping live boxes, and the two update paths
 * (Loader `loader/volatile-update` for this host, legacy `register().watch` for a
 * host that still offers it).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.js'
import {
  Config,
  resolveConfig,
  unwrapVolatile,
  type SafeHarnessConfig,
} from '../src/config.js'
import { SAFEHARNESS_SERVICE, type SafeHarnessService } from '../src/service.js'
import {
  createFakeHost,
  flushLedger,
  readLedger,
  type FakeHost,
} from './helpers/fake-host.js'

/** Cross-copy protocol symbol a schemastery `.volatile()` reference carries. */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** A minimal stand-in for cosmokit's `Volatile<T>` box. */
function volatileBox<T>(initial: T): { get: () => T; set: (next: T) => void } & Record<symbol, boolean> {
  let current = initial
  return {
    [VOLATILE_WRITE]: true,
    get: () => current,
    set: (next: T) => {
      current = next
    },
  } as { get: () => T; set: (next: T) => void } & Record<symbol, boolean>
}

/** Temp audit dir so no test writes to `$DSH_HOME`. */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'safeharness-settings-'))
}

/** The running plugin's public facts. */
function serviceOf(host: FakeHost): SafeHarnessService {
  const service = host.services.get(SAFEHARNESS_SERVICE) as SafeHarnessService | undefined
  if (service === undefined) throw new Error('apply() did not provide the safeharness service')
  return service
}

/** Payload of the registered `safeharness_status` tool. */
async function statusOf(host: FakeHost): Promise<{ seams: Record<string, boolean>; modes: Record<string, string> }> {
  const tool = host.tools.get('safeharness_status')
  if (tool === undefined) throw new Error('apply() did not register safeharness_status')
  const execute = tool.definition['execute'] as (args: unknown, ctx: unknown) => Promise<{
    seams: Record<string, boolean>
    modes: Record<string, string>
  }>
  return execute({}, {})
}

/** Collect the dotted paths whose schema node is marked volatile. */
function volatilePaths(node: unknown, prefix = ''): string[] {
  // A schemastery schema is a callable object (`typeof === 'function'`).
  if (node === null || (typeof node !== 'object' && typeof node !== 'function')) return []
  const record = node as { meta?: { volatile?: boolean }; dict?: Record<string, unknown> }
  const here = record.meta?.volatile === true ? [prefix] : []
  const children = Object.entries(record.dict ?? {}).flatMap(([key, child]) =>
    volatilePaths(child, prefix.length === 0 ? key : `${prefix}.${key}`))
  return [...here, ...children]
}

describe('settings schema', () => {
  it('marks exactly the live-editable subset volatile', () => {
    const paths = volatilePaths(Config).sort()
    expect(paths).toEqual([
      'approval.mode',
      'budget.maxTokensPerTurn',
      'draft.enabled',
      'draft.maxChars',
      'draft.maxTokens',
      'draft.model',
      'draft.provider',
      'draft.timeoutMs',
      'input.maxChars',
      'input.mode',
      'output.bufferMaxChars',
      'output.bufferTimeoutMs',
      'output.judge.enabled',
      'output.judge.maxChars',
      'output.judge.model',
      'output.judge.provider',
      'output.judge.scope',
      'output.judge.timeoutMs',
      'output.mode',
      'results.mode',
      'tools.maxArgsBytes',
      'tools.mode',
      'tools.trajectory',
    ].sort())
  })

  it('keeps structural and credential-bearing fields patch-only', () => {
    const paths = new Set(volatilePaths(Config))
    for (const path of [
      'preset',
      'engine.command',
      'engine.kind',
      'rules.dir',
      'rules.inline',
      'audit.dir',
      'audit.format',
      'posture.failOn',
      'patrol.notify',
      'patrol.feishuWebhook',
      'tools.denyTools',
      'tools.askTools',
      'approval.allowOnce',
    ]) {
      expect(paths.has(path), `${path} must not be live-editable`).toBe(false)
    }
  })
})

describe('volatile unwrapping', () => {
  it('replaces nested boxes with their current plain values', () => {
    const raw = {
      preset: 'balanced',
      input: { mode: volatileBox('off'), maxChars: volatileBox(1234) },
      output: { judge: { model: volatileBox('judge-model'), enabled: volatileBox(true) } },
      budget: { maxTokensPerTurn: volatileBox(7) },
    }
    const plain = unwrapVolatile(raw) as Record<string, unknown>
    expect(plain).toEqual({
      preset: 'balanced',
      input: { mode: 'off', maxChars: 1234 },
      output: { judge: { model: 'judge-model', enabled: true } },
      budget: { maxTokensPerTurn: 7 },
    })
    // The box is untouched: unwrapping is a read, not a write.
    expect(raw.input.mode.get()).toBe('off')
  })

  it('resolveConfig accepts the live boxes the host hands apply()', () => {
    const raw = {
      preset: 'observe',
      input: { mode: volatileBox('enforce'), maxChars: volatileBox(2048) },
      budget: { maxTokensPerTurn: volatileBox(11) },
    } as unknown as SafeHarnessConfig
    const config = resolveConfig(raw)
    expect(config.input.mode).toBe('enforce')
    expect(config.input.maxChars).toBe(2048)
    expect(config.budget.maxTokensPerTurn).toBe(11)
  })
})

describe('settings seam', () => {
  it('reports settings only once the host service appears, then answers status', async () => {
    const { host } = createFakeHost()
    await apply(host.ctx as never, { preset: 'observe', audit: { dir: tempDir() } })
    // A real host starts `settings` after the services this plugin injects.
    expect(serviceOf(host).handle.hooks.settings).toBe(false)

    host.activateService('settings', {
      configure: () => () => undefined,
      describe: () => [],
    })

    expect(serviceOf(host).handle.hooks.settings).toBe(true)
    expect((await statusOf(host)).seams.settings).toBe(true)
  })

  it('keeps the legacy register().watch() host working', async () => {
    const { host } = createFakeHost()
    await apply(host.ctx as never, { preset: 'observe', audit: { dir: tempDir() } })

    let watch: ((next: SafeHarnessConfig) => void) | undefined
    let registeredNamespace = ''
    host.activateService('settings', {
      register(namespace: string) {
        registeredNamespace = namespace
        return {
          watch(callback: (next: SafeHarnessConfig) => void) {
            watch = callback
            return () => undefined
          },
        }
      },
    })

    expect(registeredNamespace).toBe('safeharness')
    expect(serviceOf(host).handle.hooks.settings).toBe(true)
    watch?.({ preset: 'balanced', input: { mode: 'enforce' } })
    expect(serviceOf(host).handle.runtime.config.input.mode).toBe('enforce')
  })
})

describe('live config updates', () => {
  it('applies a Loader volatile update and audits the rule-set swap', async () => {
    const { host } = createFakeHost()
    const config: SafeHarnessConfig = { preset: 'balanced', input: { maxChars: 1000 }, audit: { dir: tempDir() } }
    await apply(host.ctx as never, config)
    const runtime = serviceOf(host).handle.runtime
    expect(runtime.config.input.maxChars).toBe(1000)

    config.input = { maxChars: 1234 }
    host.emitSync('loader/volatile-update')

    expect(runtime.config.input.maxChars).toBe(1234)
    // One settings write can reach the listener more than once; the duplicate must
    // not append a second `rules_reloaded` record.
    host.emitSync('loader/volatile-update')
    await flushLedger(runtime)
    const records = await readLedger(runtime)
    expect(records.filter((record) => record.kind === 'rules_reloaded')).toHaveLength(1)
  })

  it('keeps the previous config when a live update no longer validates', async () => {
    const { host } = createFakeHost()
    const config: SafeHarnessConfig = { preset: 'balanced', input: { maxChars: 1000 }, audit: { dir: tempDir() } }
    await apply(host.ctx as never, config)
    const runtime = serviceOf(host).handle.runtime

    config.input = { maxChars: 0 }
    host.emitSync('loader/volatile-update')

    expect(runtime.config.input.maxChars).toBe(1000)
    await flushLedger(runtime)
    const records = await readLedger(runtime)
    expect(records.some((record) => record.kind === 'rules_reloaded')).toBe(false)
  })
})
