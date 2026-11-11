/**
 * M3 surface wiring: the patrol tool (§6.12), the `/safeharness patrol` command,
 * and the judge/budget facts `safeharness_status` now reports.
 *
 * The patrol *logic* is covered by tests/patrol.test.ts; this file only proves the
 * composition root wired it the way an operator or the model reaches it.
 * @module
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createFakeHost, readLedger, type FakeHost } from './helpers/fake-host.js'
import { apply } from '../src/index.js'
import { patrolTool, statusTool } from '../src/surface/tools.js'
import { safeharnessCommand, type JudgeCommandTarget } from '../src/surface/commands.js'
import type { JudgeResult } from '../src/judge/client.js'
import type { PatrolReport } from '../src/patrol/index.js'
import type { Runtime } from '../src/runtime.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A temporary ledger directory (never inside the repo). */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'safeharness-surface-m3-'))
}

/** A clean patrol report with an optional override. */
function report(overrides: Partial<PatrolReport> = {}): PatrolReport {
  return {
    ranAt: new Date().toISOString(),
    findings: [{ code: 'audit_rate', severity: 'OK', detail: 'no denials in window' }],
    summary: { fail: 0, warn: 0, ok: 1, skip: 0, clean: true },
    exitCode: 0,
    notified: false,
    ...overrides,
  }
}

/** Invoke one registered tool definition. */
async function invoke(definition: unknown, args: unknown = {}): Promise<Record<string, unknown>> {
  const execute = (definition as { execute: (a: unknown, e: unknown) => Promise<unknown> }).execute
  return await execute(args, {}) as Record<string, unknown>
}

/** Build the command definition over a fake runtime (the factory is pure). */
function captureCommand(
  runtime: Runtime,
  patrol?: (options?: { include?: readonly string[] }) => Promise<PatrolReport>,
  judge?: JudgeCommandTarget,
): { definition: { handler: (invocation: unknown) => Promise<CommandResult> } } {
  const definition = safeharnessCommand(runtime, async () => ({
    ranAt: new Date().toISOString(),
    findings: [],
    summary: { fail: 0, warn: 0, ok: 0, skip: 0, clean: true },
  }), patrol, judge)
  return { definition: definition as unknown as { handler: (invocation: unknown) => Promise<CommandResult> } }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('safeharness_patrol tool (§6.12)', () => {
  it('runs the injected patrol and returns findings plus the exit code', async () => {
    const seen: (readonly string[] | undefined)[] = []
    const tool = patrolTool(async (options) => {
      seen.push(options?.include)
      return report({ exitCode: 1, summary: { fail: 1, warn: 0, ok: 0, skip: 0, clean: false } })
    })
    const value = await invoke(tool)
    expect(seen).toEqual([undefined])
    expect(value.exitCode).toBe(1)
    expect((value.summary as Record<string, unknown>).fail).toBe(1)
    expect(value.notified).toBe(false)
  })

  it('forwards a valid include filter and rejects non-strings at the schema boundary', async () => {
    const seen: (readonly string[] | undefined)[] = []
    const tool = patrolTool(async (options) => {
      seen.push(options?.include)
      return report()
    })
    // `notify` is a real patrol check, so the tool surface must accept it; otherwise
    // the notification path could only be reached by "run everything".
    await invoke(tool, { include: ['health_probe', 'notify'] })
    expect(seen).toEqual([['health_probe', 'notify']])
    // `defineTool` validates the declared parameter schema before the body runs, so
    // a malformed filter is refused rather than silently dropped.
    await expect(invoke(tool, { include: ['health_probe', 7, null] })).rejects.toThrow(/must be a string/u)
    expect(seen).toHaveLength(1)
  })

  it('surfaces a patrol-internal error without throwing', async () => {
    const tool = patrolTool(async () => report({ exitCode: 2, internalError: 'unknown check: nope' }))
    const value = await invoke(tool)
    expect(value.exitCode).toBe(2)
    expect(value.internalError).toBe('unknown check: nope')
  })
})

describe('/safeharness patrol command', () => {
  it('prints the exit code first and the findings after it', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const { definition } = captureCommand(runtime, async () => report({ notified: true }))
    const result = await definition.handler({ rawInput: 'patrol', commandId: 'c', agent: {}, signal: new AbortController().signal })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('patrol: exit=0')
    expect(result.text).toContain('[OK] audit_rate')
    expect(result.text).toContain('notified: yes')
  })

  it('forwards extra words as the include filter', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const seen: (readonly string[] | undefined)[] = []
    const { definition } = captureCommand(runtime, async (options) => {
      seen.push(options?.include)
      return report({ exitCode: 2, internalError: 'unknown check: bogus' })
    })
    const result = await definition.handler({ rawInput: 'patrol health_probe bogus', commandId: 'c', agent: {}, signal: new AbortController().signal })
    expect(seen).toEqual([['health_probe', 'bogus']])
    expect(result.kind).toBe('success')
    expect(result.text).toContain('exit=2')
    expect(result.text).toContain('internal: unknown check: bogus')
  })

  it('reports patrol as unavailable when no runner was wired', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const { definition } = captureCommand(runtime)
    const result = await definition.handler({ rawInput: 'patrol', commandId: 'c', agent: {}, signal: new AbortController().signal })
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/unavailable/u)
  })
})

describe('safeharness_status M3 facts', () => {
  it('reports the judge route and the budget cap when the composition root supplies them', async () => {
    const { runtime } = createFakeHost({
      config: { preset: 'hardened', output: { judge: { enabled: true, provider: 'p', model: 'm' } }, budget: { maxTokensPerTurn: 5000 } },
    })
    const tool = statusTool(runtime, Date.now(), undefined, undefined, {
      judge: () => ({ enabled: true, scope: 'flagged', available: true, provider: 'p', model: 'm' }),
      budget: () => ({ enabled: true, limit: 5000, sessions: 0 }),
    })
    const value = await invoke(tool)
    expect(value.judge).toMatchObject({ enabled: true, available: true, provider: 'p' })
    expect(value.budget).toMatchObject({ enabled: true, limit: 5000 })
  })

  it('omits the M3 facts when a bare status call supplies none (back-compatible)', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'observe' } })
    const value = await invoke(statusTool(runtime, Date.now()))
    expect(value.judge).toBeUndefined()
    expect(value.budget).toBeUndefined()
  })

  it('shows judge and budget lines in /safeharness status', async () => {
    const { runtime } = createFakeHost({
      config: { preset: 'balanced', output: { judge: { enabled: true, provider: 'p', model: 'm', scope: 'always' } }, budget: { maxTokensPerTurn: 100 } },
    })
    const { definition } = captureCommand(runtime)
    const result = await definition.handler({ rawInput: 'status', commandId: 'c', agent: {}, signal: new AbortController().signal })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('judge: on scope=always route=p/m')
    expect(result.text).toContain('budget: limit=100/turn')
  })
})

describe('/safeharness judge command', () => {
  /** A judge target whose probe returns one fixed result (no model call). */
  function target(overrides: Partial<JudgeResult> = {}, available = true): JudgeCommandTarget & { calls: number } {
    const state = {
      calls: 0,
      state: () => ({ enabled: true, scope: 'flagged', provider: 'p', model: 'm', available }),
      probe: async (): Promise<JudgeResult> => {
        state.calls += 1
        return {
          status: 'ok',
          verdict: 'allow',
          blocked: false,
          labels: {},
          metrics: { duration_ms: 7, prompt_chars: 80 },
          ...overrides,
        }
      },
    }
    return state
  }

  it('shows the route and whether an llm service is composed, without probing', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced', output: { judge: { enabled: true, provider: 'p', model: 'm' } } } })
    const judge = target()
    const { definition } = captureCommand(runtime, undefined, judge)
    const result = await definition.handler({ rawInput: 'judge', commandId: 'c', agent: {}, signal: new AbortController().signal })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('judge: on scope=flagged route=p/m')
    expect(result.text).toContain('available: yes')
    expect(result.text).toContain('/safeharness judge probe')
    expect(judge.calls).toBe(0)
  })

  it('probes the configured route once and prints status/verdict/latency only', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced', output: { judge: { enabled: true, provider: 'p', model: 'm' } } } })
    const judge = target({ metrics: { duration_ms: 42 } })
    const { definition } = captureCommand(runtime, undefined, judge)
    const result = await definition.handler({ rawInput: 'judge probe', commandId: 'c', agent: {}, signal: new AbortController().signal })
    expect(judge.calls).toBe(1)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('judge probe: status=ok verdict=allow blocked=no route=p/m')
    expect(result.text).toContain('duration_ms=42')
    // The judge result deliberately carries no reviewed content; the command must not invent any.
    expect(result.text).not.toMatch(/prompt|content|reply/iu)
  })

  it('reports a provider failure as an error but still describes the status honestly', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced', output: { judge: { enabled: true, provider: 'p', model: 'm' } } } })
    const judge = target({ status: 'timeout', verdict: 'unknown', blocked: false, labels: { reason: 'timeout' }, metrics: { timeout_ms: 4000 } })
    const { definition } = captureCommand(runtime, undefined, judge)
    const result = await definition.handler({ rawInput: 'judge probe', commandId: 'c', agent: {}, signal: new AbortController().signal })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('status=timeout')
    expect(result.text).toContain('reason=timeout')
  })

  it('refuses to probe when the profile composes no llm service', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced', output: { judge: { enabled: true, provider: 'p', model: 'm' } } } })
    const judge = target({}, false)
    const { definition } = captureCommand(runtime, undefined, judge)
    const result = await definition.handler({ rawInput: 'judge probe', commandId: 'c', agent: {}, signal: new AbortController().signal })
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/no llm service/iu)
    expect(judge.calls).toBe(0)
  })

  it('reports the missing handle when the command is built without a judge target', async () => {
    const { runtime } = createFakeHost({ config: { preset: 'balanced' } })
    const { definition } = captureCommand(runtime)
    const result = await definition.handler({ rawInput: 'judge probe', commandId: 'c', agent: {}, signal: new AbortController().signal })
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/no judge handle/iu)
  })
})

describe('composition root wiring', () => {
  it('registers all four read-only tools, the approval listener and the patrol tool', async () => {
    const { host } = createFakeHost({ config: { preset: 'balanced' } })
    await apply(host.ctx as never, { preset: 'balanced', audit: { dir: tempDir() } })
    const names = [...host.tools.keys()].sort()
    expect(names).toEqual(['safeharness_audit_query', 'safeharness_patrol', 'safeharness_posture', 'safeharness_status'])
    expect(host.listeners.get('approval/request')?.length).toBe(1)
    const status = await invoke(host.tools.get('safeharness_status')?.definition)
    expect((status.seams as Record<string, boolean>).approval).toBe(true)
  })

  it('runs a real patrol through the registered tool with a stubbed network', async () => {
    const fetchStub = vi.fn(async () => ({ status: 204, ok: true }) as Response)
    vi.stubGlobal('fetch', fetchStub)
    const { host } = createFakeHost({ config: { preset: 'balanced', patrol: { healthUrls: ['https://health.invalid/ok'] } } })
    await apply(host.ctx as never, { preset: 'balanced', audit: { dir: tempDir() }, patrol: { healthUrls: ['https://health.invalid/ok'] } })
    const value = await invoke(host.tools.get('safeharness_patrol')?.definition, { include: ['health_probe'] })
    expect(fetchStub).toHaveBeenCalled()
    expect(value.exitCode).toBe(0)
    const codes = (value.findings as { code: string }[]).map((finding) => finding.code)
    expect(codes).toContain('health_probe')
  })

  it('writes a patrol_report record when the tool runs', async () => {
    const { host } = createFakeHost({ config: { preset: 'balanced' } })
    await apply(host.ctx as never, { preset: 'balanced', audit: { dir: tempDir() } })
    await invoke(host.tools.get('safeharness_patrol')?.definition, { include: ['audit_rate'] })
    const runtime = (host.services.get('safeharness') as { handle: { runtime: Runtime } }).handle.runtime
    const ledger = await readLedger(runtime)
    expect(ledger.some((record) => record.kind === 'patrol_report')).toBe(true)
  })
})
