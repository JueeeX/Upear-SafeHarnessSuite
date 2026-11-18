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

/** The stub automatic JSX runtime; element type/props are recorded, not rendered. */
const JSX_STUB = {
  jsx: (type: unknown, props: unknown) => ({ type, props }),
  jsxs: (type: unknown, props: unknown) => ({ type, props }),
  Fragment: 'fragment',
}

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
    readonly id?: string
    readonly key?: string
    readonly locale?: string
    readonly order?: number
    readonly label?: () => string
    readonly inject?: () => {
      readonly load: () => Promise<unknown>
      readonly patrol: () => Promise<unknown>
      readonly draft: (input: { readonly description: string; readonly kind: 'inform' | 'chain' }) => Promise<unknown>
      readonly reloadRules: () => Promise<unknown>
      readonly writeRule: (input: { readonly filename: string; readonly yaml: string; readonly overwrite: boolean }) => Promise<unknown>
    }
  }
  readonly component: (props: Record<string, unknown>) => unknown
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

/** The tab's injected face; the keyed slots close over theirs instead. */
function faceOf(entry: SlotRegistration): NonNullable<SlotRegistration['options']['inject']> {
  const inject = entry.options.inject
  if (inject === undefined) throw new Error('the settings tab registration must inject a face')
  return inject
}

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

  it('materializes into a cordis plugin that registers the workbench on four surfaces', () => {
    const exported = materialize()
    expect(exported.inject).toEqual(['slots'])
    expect(typeof exported.apply).toBe('function')

    const { injectedSlots, registrations } = register(exported)
    expect(injectedSlots).toEqual([
      'settings.plugins.tab',
      'plugins.bundle.config',
      'plugins.row.config',
      'plugins.detail.actions',
    ])
    expect(registrations).toHaveLength(4)

    const [tab, bundle, row, docs] = registrations as [
      SlotRegistration,
      SlotRegistration,
      SlotRegistration,
      SlotRegistration,
    ]
    expect(tab.options.name).toBe('settings.plugins.tab')
    expect(tab.options.id).toBe('safeharness')
    expect(tab.options.order).toBe(20)
    expect(tab.options.label?.()).toBe('SafeHarness')
    expect(typeof tab.component).toBe('function')

    // The bundle page is keyed by the npm package name: the host looks that key
    // up while drawing the page between the description and the rows, and the
    // page body is otherwise the package README (the 1.9.2 report).
    expect(bundle.options.name).toBe('plugins.bundle.config')
    expect(bundle.options.key).toBe('@upear/dsh-safeharness')
    expect(bundle.options.locale).toBe('safeHarness')
    expect(typeof bundle.component).toBe('function')

    // The row page is keyed `<package>#<row id>`, matching cordis.patch.yml.
    expect(row.options.name).toBe('plugins.row.config')
    expect(row.options.key).toBe('@upear/dsh-safeharness#safeharness')
    expect(row.options.locale).toBe('safeHarness')
    expect(typeof row.component).toBe('function')

    // The head control that opens the manual: a list entry, so it needs an id.
    expect(docs.options.name).toBe('plugins.detail.actions')
    expect(docs.options.id).toBe('safeharness-docs')
    expect(docs.options.order).toBe(10)
    expect(typeof docs.component).toBe('function')
  })

  it('shows the docs button on its own pages only', () => {
    const { registrations } = register(materialize())
    const docs = registrations[3] as SlotRegistration
    // The slot is shared by every plugin's detail page.
    expect(docs.component({ subject: { kind: 'bundle', pkg: { name: '@deepseek-ai/dsh-web-app' } } })).toBeNull()
    expect(docs.component({ subject: { kind: 'item', id: 'web-search' } })).toBeNull()

    for (const subject of [
      { kind: 'bundle', pkg: { name: '@upear/dsh-safeharness' } },
      { kind: 'row', pkg: { name: '@upear/dsh-safeharness' } },
    ]) {
      const link = docs.component({ subject }) as { type: string; props: Record<string, unknown> } | null
      expect(link?.type).toBe('a')
      // The detail document drops relative links, so this one must be absolute.
      expect(String(link?.props.href)).toMatch(/^https:\/\/github\.com\//u)
      expect(link?.props.target).toBe('_blank')
    }
  })

  it('draws the workbench as the page body and nothing in the summary slot', () => {
    const { registrations } = register(materialize())
    const bundle = registrations[1] as SlotRegistration
    const row = registrations[2] as SlotRegistration
    // `summary` is the title-side block some slots draw; we have nothing for it.
    expect(bundle.component({ view: 'summary' })).toBeNull()
    expect(row.component({ view: 'summary' })).toBeNull()

    // `page` must mount the panel with its whole face, not an empty shell.
    for (const entry of [bundle, row]) {
      const element = entry.component({ view: 'page' }) as { type: unknown; props: Record<string, unknown> } | null
      expect(typeof element?.type).toBe('function')
      expect(typeof element?.props.load).toBe('function')
      expect(typeof element?.props.writeRule).toBe('function')
      expect(typeof element?.props.exportLedger).toBe('function')
    }
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
    await expect(faceOf(entry)().load()).resolves.toEqual(payload)
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
    await expect(faceOf(entry)().patrol()).resolves.toEqual(report)
    expect(fetchStub).toHaveBeenCalledWith('/safeharness/patrol', expect.objectContaining({ method: 'POST' }))
  })

  it('posts one rule file and unwraps the landing result', async () => {
    const value = { filename: 'draft.yaml', bytes: 42, rules: 21, chains: 3, hash: 'abc123456789', created: true, reloaded: true }
    const fetchStub = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, value }) }))
    vi.stubGlobal('fetch', fetchStub)
    const { registrations } = register(materialize())
    const entry = registrations[0] as SlotRegistration
    await expect(faceOf(entry)().writeRule({ filename: 'draft.yaml', yaml: 'rules: []', overwrite: false }))
      .resolves.toEqual(value)
    expect(fetchStub).toHaveBeenCalledWith('/safeharness/write-rule', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ filename: 'draft.yaml', yaml: 'rules: []', overwrite: false }),
    }))
  })
  it('surfaces a refused or failed read instead of rendering stale data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: false, error: { code: 'panel_failed' } }) })))
    const failed = register(materialize())
    await expect(faceOf(failed.registrations[0] as SlotRegistration)().load()).rejects.toThrow(/panel_failed/u)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })))
    const refused = register(materialize())
    await expect(faceOf(refused.registrations[0] as SlotRegistration)().load()).rejects.toThrow(/panel_http_403/u)
  })
})
