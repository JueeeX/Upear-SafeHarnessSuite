/**
 * The client bundle contract (T5.3).
 *
 * The DSH web shell does not import client plugins: it serves `lib/client.js`
 * at `/plugins/<id>/client.js`, executes it as a classic script, and expects the
 * only side effect to be `window.__ModuleLoader__.load({id, factory})`. A
 * malformed bundle does not degrade one tab — the host's client-module registry
 * throws during its activation scan and the whole GUI fails to boot. So these
 * assertions are deliberately literal.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLATFORM_MODULES } from '../scripts/platform-modules.mjs'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8')) as {
  name: string
  exports?: Record<string, { default?: string }>
  dsh?: { client?: { platform?: string; inject?: string[] } }
}

const bundlePath = join(pluginRoot, 'lib', 'client.js')
const built = existsSync(bundlePath)
const source = built ? readFileSync(bundlePath, 'utf8') : ''

/** One captured registration call. */
interface CapturedLoad {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => Record<string, unknown>
}

/** The stub React surface the bundle requires at materialization. */
const REACT_STUB = {
  useState: () => [undefined, () => undefined],
  useEffect: () => undefined,
}

/** The stub automatic JSX runtime. */
const JSX_STUB = { jsx: () => null, jsxs: () => null, Fragment: 'fragment' }

/** Materialize the built bundle the way the shell's module table would. */
function materialize(): Record<string, unknown> {
  let captured: CapturedLoad | undefined
  new Function('window', source)({ __ModuleLoader__: { load: (options: CapturedLoad) => { captured = options } } })
  expect(captured).toBeDefined()
  const registration = captured as CapturedLoad
  expect(registration.id).toBe('@upear/dsh-safeharness')
  return registration.factory((id: string) => {
    if (id === 'react') return REACT_STUB
    if (id === 'react/jsx-runtime') return JSX_STUB
    throw new Error(`client bundle required an unseeded module: ${id}`)
  })
}

/** One slot registration captured from a fake browser context. */
interface SlotRegistration {
  readonly options: {
    readonly name: string
    readonly id: string
    readonly order: number
    readonly label: () => string
    readonly inject: () => { readonly load: () => Promise<unknown> }
  }
  readonly component: unknown
}

/** Run `apply` against a fake context and return what it contributed. */
function register(exported: Record<string, unknown>): { injectedSlots: string[]; registrations: SlotRegistration[] } {
  const injectedSlots: string[] = []
  const registrations: SlotRegistration[] = []
  const ctx = {
    slots: {
      inject: (name: string, callback: () => () => void) => {
        injectedSlots.push(name)
        callback()
        return () => undefined
      },
      register: (options: SlotRegistration['options'], component: unknown) => {
        registrations.push({ options, component })
        return () => undefined
      },
    },
  }
  ;(exported.apply as (context: unknown) => void)(ctx)
  return { injectedSlots, registrations }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('client half manifest', () => {
  it('declares a web client half that points at the built bundle', () => {
    expect(manifest.dsh?.client?.platform).toBe('web')
    expect(manifest.exports?.['./client']?.default).toBe('./lib/client.js')
    // The scan resolves `<name>/package.json` from the profile anchor; without
    // this subpath the package is cached as "not a client row" forever.
    expect(manifest.exports?.['./package.json']).toBe('./package.json')
  })
})

describe.skipIf(!built)('lib/client.js', () => {
  it('is a closure-factory registration, not an ES module', () => {
    expect(source.startsWith('window.__ModuleLoader__.load({ id: "@upear/dsh-safeharness", factory: (require) => {')).toBe(true)
    expect(source.trimEnd().endsWith('return module.exports; } });')).toBe(true)
    expect(source).not.toMatch(/^\s*(import|export)\s/mu)
  })

  it('only requires modules the browser module table seeds', () => {
    const required = [...source.matchAll(/require\("([^"]+)"\)/gu)].map(match => match[1] as string)
    const unexpected = [...new Set(required)].filter(id => !PLATFORM_MODULES.includes(id))
    expect(unexpected).toEqual([])
  })

  it('materializes into a cordis plugin that registers the settings tab', () => {
    const exported = materialize()
    expect(exported.inject).toEqual(['slots'])
    expect(typeof exported.apply).toBe('function')

    const { injectedSlots, registrations } = register(exported)
    expect(injectedSlots).toEqual(['settings.plugins.tab'])
    expect(registrations).toHaveLength(1)
    const entry = registrations[0] as SlotRegistration
    expect(entry.options.name).toBe('settings.plugins.tab')
    expect(entry.options.id).toBe('safeharness')
    expect(entry.options.order).toBe(20)
    expect(entry.options.label()).toBe('SafeHarness')
    expect(typeof entry.component).toBe('function')
  })

  it('loads the payload from the panel route and unwraps the envelope', async () => {
    const payload = { version: '9.9.9', preset: 'observe' }
    const fetchStub = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, value: payload }),
    }))
    vi.stubGlobal('fetch', fetchStub)

    const { registrations } = register(materialize())
    const entry = registrations[0] as SlotRegistration
    await expect(entry.options.inject().load()).resolves.toEqual(payload)
    expect(fetchStub).toHaveBeenCalledWith('/safeharness/status', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }))
  })

  it('posts the patrol endpoint and unwraps its report', async () => {
    const report = { ranAt: '2026-11-12T03:00:00.000Z', exitCode: 0, summary: { clean: true }, findings: [], notified: false }
    const fetchStub = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, value: report }) }))
    vi.stubGlobal('fetch', fetchStub)
    const { registrations } = register(materialize())
    const entry = registrations[0] as SlotRegistration
    await expect(entry.options.inject().patrol()).resolves.toEqual(report)
    expect(fetchStub).toHaveBeenCalledWith('/safeharness/patrol', expect.objectContaining({ method: 'POST' }))
  })
  it('surfaces a refused or failed read instead of rendering stale data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, error: { code: 'panel_failed' } }) })))
    const failed = register(materialize())
    await expect((failed.registrations[0] as SlotRegistration).options.inject().load()).rejects.toThrow(/panel_failed/u)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })))
    const refused = register(materialize())
    await expect((refused.registrations[0] as SlotRegistration).options.inject().load()).rejects.toThrow(/panel_http_403/u)
  })
})
