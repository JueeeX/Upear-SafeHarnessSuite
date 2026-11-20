// @vitest-environment jsdom
/**
 * The settings tab's save path (1.15.2).
 *
 * Background: from 1.10.0 to 1.15.1 not one panel save reached the ledger — the
 * bar sat on "没有修改" while the operator changed a control. The server half was
 * fine (a hand-written `op:save` landed and bumped the revision), so the gap is
 * on the browser side. These tests mount the real component in jsdom, move the
 * same controls an operator moves, and pin the three things that were untested:
 *
 *   1. every control reaches `buildPatch` (a control that does not is a dead knob);
 *   2. the bar / button follow that patch (dirty, enabled, invalid);
 *   3. an unsaved draft survives a Host remount — including one triggered by a
 *      volatile status flip (`judge.available`), which used to invalidate it.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsTab } from '../src/client/panel.js'
import type { PanelSettingsValue } from '../src/panel/protocol.js'
import type { PanelFace } from '../src/client/index.js'

/* React 19 only batches inside `act` when this flag is visible. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** One loaded value shaped like the real `/settings` answer. */
function settingsValue(overrides: Partial<PanelSettingsValue> = {}): PanelSettingsValue {
  return {
    preset: 'balanced',
    surfaces: { input: 'enforce', tools: 'enforce', results: 'enforce', output: 'warn', approval: 'delegate' },
    inputJudge: { mode: 'flagged', failClosed: false, normalize: true },
    toolDetection: { descriptorScan: 'warn', repeatedAttemptThreshold: 0, entropyThreshold: 0, entropyMinLength: 48, allowedTables: [] },
    pii: { enabled: true, classes: ['id_card', 'phone_cn', 'email', 'bank_card', 'api_key', 'jwt', 'doc_no', 'gov_serial', 'customer_id', 'internal_url'] },
    lists: { denyTools: [], askTools: [], denyTags: [], tagOverrides: [], blockOn: ['credential_leak'], allowOnce: [] },
    source: { rulesDir: 'C:\\ws\\safeharness\\rules', rulesWatch: true, patrolWindowMinutes: 10, patrolFactor: 5, patrolMinCount: 10 },
    facts: {
      engine: { kind: 'builtin', command: '' },
      rules: { inlineRules: 0, sources: 2 },
      audit: { format: 'ndjson', dir: '', rotateMb: 64, required: true, hashChain: true },
      posture: { onLoad: true, failOn: [] },
      patrolNotify: { channels: [], healthUrls: 0 },
    },
    judge: { enabled: true, scope: 'always', provider: 'liao', model: 'gpt-6-luna', maxChars: 12000, timeoutMs: 6000, available: true, configurable: true },
    draft: { enabled: true, provider: 'liao', model: '' },
    providers: [
      { id: 'liao', name: 'liao', models: [{ id: 'gpt-6-luna', name: 'gpt-6-luna' }] },
      { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] },
    ],
    customProviders: [],
    providerConfigurable: true,
    revision: 3,
    configPath: 'C:\\ws\\profiles\\desktop\\cordis.patch.yml',
    ...overrides,
  }
}

/** A face whose settings half is a recording fake; the rest is never called here. */
function fakeFace(value: PanelSettingsValue): PanelFace & { readonly saved: unknown[] } {
  const saved: unknown[] = []
  const unused = async (): Promise<never> => { throw new Error('unused in this test') }
  return {
    saved,
    load: unused,
    patrol: unused,
    draft: unused,
    schedule: unused,
    reloadRules: unused,
    writeRule: unused,
    ruleHistory: unused,
    rollbackRule: unused,
    exportLedger: unused,
    addProvider: unused,
    deleteProvider: unused,
    probeJudge: unused,
    loadSettings: async () => value,
    saveSettings: async (patch) => {
      saved.push(patch)
      const next = settingsValue({ judge: { ...value.judge, scope: 'flagged' }, revision: 4 })
      return next
    },
  } as unknown as PanelFace & { readonly saved: unknown[] }
}

/** Mount the tab and let its load promise settle. */
async function mount(face: PanelFace): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <SettingsTab
        face={face}
        active
        draftFact={{ enabled: true, maxChars: 500 }}
        onRefresh={() => {}}
      />,
    )
  })
  return { container, root }
}

/** The field wrapper whose label matches, then its control. */
function control(container: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const fields = [...container.querySelectorAll('.shp-field')]
  const field = fields.find((entry) => entry.querySelector('.shp-field-label')?.textContent?.trim() === label)
  if (field === undefined) throw new Error(`no field labelled ${label}`)
  const node = field.querySelector('input, select, textarea')
  if (node === null) throw new Error(`field ${label} has no control`)
  return node as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
}

/** The save bar's status line. */
function barText(container: HTMLElement): string {
  return container.querySelector('.shp-savebar')?.textContent ?? ''
}

/** The primary save button. */
function saveButton(container: HTMLElement): HTMLButtonElement {
  const buttons = [...container.querySelectorAll('.shp-savebar button')]
  const button = buttons.find((entry) => entry.textContent?.includes('保存'))
  if (button === undefined) throw new Error('no save button')
  return button as HTMLButtonElement
}

/** Set a native control's value the way a browser would. */
async function change(node: HTMLElement, next: string, event = 'change'): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new Event('focus', { bubbles: false }))
    if (node instanceof HTMLInputElement && node.type === 'checkbox') {
      node.click()
      return
    }
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value')?.set
    setter?.call(node, next)
    node.dispatchEvent(new Event(event, { bubbles: true }))
  })
}

describe('settings tab save path', () => {
  beforeEach(() => { window.sessionStorage.clear() })
  afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

  it('turns the bar dirty and saves when the judge scope moves', async () => {
    const face = fakeFace(settingsValue())
    const { container, root } = await mount(face)
    expect(barText(container)).toContain('没有修改')
    expect(saveButton(container).disabled).toBe(true)

    await change(control(container, '评审范围'), 'flagged')

    expect(barText(container)).toContain('有未保存的修改')
    expect(saveButton(container).disabled).toBe(false)

    await act(async () => { saveButton(container).click() })
    expect((face as unknown as { saved: unknown[] }).saved).toEqual([
      { expectedRevision: 3, judge: { scope: 'flagged' } },
    ])
    expect(barText(container)).toContain('已保存')
    await act(async () => { root.unmount() })
  })

  it('turns the bar dirty for a switch, a number and a per-surface mode', async () => {
    const face = fakeFace(settingsValue())
    const { container, root } = await mount(face)

    await change(control(container, '送入评审的最大字符数'), '9000', 'input')
    expect(barText(container)).toContain('有未保存的修改')

    await change(control(container, '输入'), 'warn')
    expect(barText(container)).toContain('有未保存的修改')

    const toggle = container.querySelector('.shp-switch-row input[type=checkbox]') as HTMLInputElement
    await change(toggle, '')
    expect(barText(container)).toContain('有未保存的修改')
    await act(async () => { root.unmount() })
  })

  it('refuses to save an invalid number and says why in the bar itself', async () => {
    const face = fakeFace(settingsValue())
    const { container, root } = await mount(face)

    await change(control(container, '评审超时（毫秒）'), '0', 'input')
    expect(saveButton(container).disabled).toBe(true)
    // The reason lives inside the bar (it used to render below it, past the fold).
    expect(barText(container)).toContain('正整数')
    expect(barText(container)).toContain('有未保存的修改')
    expect(saveButton(container).title).toContain('不合法')
    await act(async () => { root.unmount() })
  })

  it('saves the patrol window at its default 10 minutes', async () => {
    // Regression: the entropy helper's hard-wired [0, 8] cap was reused for the
    // patrol window, so the default form was "invalid" and no save could happen.
    const face = fakeFace(settingsValue())
    const { container, root } = await mount(face)
    expect(barText(container)).toContain('没有修改')

    await change(control(container, '巡检窗口（分钟）'), '15', 'input')
    expect(barText(container)).toContain('有未保存的修改')
    expect(saveButton(container).disabled).toBe(false)
    await act(async () => { saveButton(container).click() })
    expect((face as unknown as { saved: unknown[] }).saved).toEqual([
      { expectedRevision: 3, source: { patrolWindowMinutes: 15 } },
    ])
    await act(async () => { root.unmount() })
  })

  it('keeps an unsaved draft across a remount that flips a volatile status', async () => {
    const first = fakeFace(settingsValue())
    const mounted = await mount(first)
    await change(control(mounted.container, '评审范围'), 'flagged')
    expect(barText(mounted.container)).toContain('有未保存的修改')
    await act(async () => { mounted.root.unmount() })

    // The Host hot-reloaded the entry: same config, but the llm probe now reports
    // available=false. The value is otherwise identical, so the draft must survive.
    const second = fakeFace(settingsValue({ judge: { ...settingsValue().judge, available: false } }))
    const again = await mount(second)
    expect(barText(again.container)).toContain('有未保存的修改')
    await act(async () => { again.root.unmount() })
  })
})
