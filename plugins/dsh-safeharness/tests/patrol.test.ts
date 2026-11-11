/**
 * Patrol (plan §6.10, T3.4): three-state behaviour of every check, the exit-code
 * contract, include filtering, the exact notification body and the ledger record.
 *
 * Nothing here touches the network: `fetchImpl`, `notifyImpl` and `now` are always
 * injected, and the ledger clock is driven explicitly so the rate windows can be
 * seeded without sleeping.
 */
import { describe, expect, it, vi } from 'vitest'
import { createLedger } from '../src/audit/ledger.js'
import type { AuditFields, AuditKind } from '../src/audit/types.js'
import { resolveConfig, type ResolvedConfig, type SafeHarnessConfig } from '../src/config.js'
import type { Runtime } from '../src/runtime.js'
import {
  createFakeHost,
  flushLedger,
  packagedRules,
  readLedger,
  tempLedgerDir,
} from './helpers/fake-host.js'
import {
  PATROL_CODES,
  PATROL_EXIT,
  runPatrol,
  type PatrolProbe,
} from '../src/patrol/index.js'

/** Injected "now" for every test: deterministic and far from wall time. */
const NOW = Date.parse('2026-11-11T00:00:00.000Z')
const MIN = 60_000

/** A test runtime whose ledger clock can be moved to seed historical records. */
interface Harness {
  readonly runtime: Runtime
  readonly config: ResolvedConfig
  /** Append one ledger record stamped at `at` (defaults to {@link NOW}). */
  append(kind: AuditKind, fields: AuditFields, at?: number): Promise<void>
}

/** Build runtime + real NDJSON ledger with an injectable clock. */
function makeHarness(options: { config?: SafeHarnessConfig; resolved?: ResolvedConfig } = {}): Harness {
  const ruleset = packagedRules()
  let clock = NOW
  const ledger = createLedger({
    dir: tempLedgerDir(),
    format: 'ndjson',
    redact: true,
    hashChain: true,
    required: false,
    rotateMb: 64,
    pluginVersion: 'test',
    rulesetHash: ruleset.hash,
    clock: () => clock,
  })
  const created = createFakeHost({ config: options.config, resolved: options.resolved, ledger })
  return {
    runtime: created.runtime,
    config: created.config,
    async append(kind, fields, at) {
      clock = at ?? NOW
      try {
        await ledger.append(kind, fields)
      } finally {
        clock = NOW
      }
    },
  }
}

/** Probe with a fixed clock; tests override the seams they exercise. */
function probeFor(overrides: Partial<PatrolProbe> = {}): PatrolProbe {
  return { now: () => NOW, ...overrides }
}

/** Append `count` deny records at `at`. */
async function seedDenies(
  h: Harness,
  count: number,
  at: number,
  reasonCode = 'tool_denied_by_rule',
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await h.append('tool_denied', { decision: 'deny', reason_code: reasonCode }, at)
  }
}

/** Append `count` approval asks at `at` (what the tool guard writes for an ask). */
async function seedAsks(h: Harness, count: number, at: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await h.append('tool_asked', { decision: 'ask', reason_code: 'tool_ask_required' }, at)
  }
}

/** Read the single `patrol_report` record the last run wrote. */
async function readPatrolRecord(h: Harness): Promise<Record<string, unknown> | undefined> {
  await flushLedger(h.runtime)
  const records = await readLedger(h.runtime)
  return records.find((record) => record.kind === 'patrol_report')
}

// ---------------------------------------------------------------------------
// The report itself
// ---------------------------------------------------------------------------

describe('runPatrol report', () => {
  it('a fresh clean deployment is all-SKIP, exit 0 and not notified', async () => {
    const h = makeHarness()
    const report = await runPatrol(h.runtime, probeFor())
    expect(report.findings.map((item) => item.code)).toEqual([...PATROL_CODES])
    expect(report.findings.map((item) => item.severity)).toEqual(['SKIP', 'SKIP', 'SKIP', 'SKIP', 'SKIP'])
    expect(report.summary).toEqual({ fail: 0, warn: 0, ok: 0, skip: 5, clean: true })
    expect(report.exitCode).toBe(PATROL_EXIT.clean)
    expect(report.notified).toBe(false)
    expect(report.internalError).toBeUndefined()
    expect(report.ranAt).toBe(new Date(NOW).toISOString())
  })

  it('records patrol_report with non-OK codes, counts and exit labels', async () => {
    const h = makeHarness()
    await runPatrol(h.runtime, probeFor())
    const record = await readPatrolRecord(h)
    expect(record).toBeDefined()
    expect(record?.kind).toBe('patrol_report')
    expect(record?.decision).toBe('ok')
    // SKIP means "did not observe", so it stays in rule_ids (never an OK silence).
    expect(record?.rule_ids).toEqual([...PATROL_CODES])
    expect(record?.metrics).toEqual({ fail: 0, warn: 0, ok: 0, skip: 5 })
    expect(record?.labels).toEqual({ exit_code: '0', notified: 'false' })
  })

  it('include runs only the requested checks, in canonical order, de-duplicated', async () => {
    const h = makeHarness({ config: { patrol: { healthUrls: ['https://a.example/health'] } } })
    const fetchImpl = vi.fn(async () => ({ status: 200 }))
    const report = await runPatrol(
      h.runtime,
      probeFor({ fetchImpl }),
      { include: ['notify', 'health_probe', 'health_probe'] },
    )
    expect(report.findings.map((item) => item.code)).toEqual(['health_probe', 'notify'])
    expect(report.findings.map((item) => item.severity)).toEqual(['OK', 'SKIP'])
    expect(report.exitCode).toBe(PATROL_EXIT.clean)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('an unknown include entry is an internal error (exit 2) and runs nothing', async () => {
    const h = makeHarness()
    const report = await runPatrol(h.runtime, probeFor(), { include: ['audit_rate', 'no_such_check'] })
    expect(report.exitCode).toBe(PATROL_EXIT.error)
    expect(report.internalError).toMatch(/unknown check/u)
    expect(report.findings).toEqual([])
    const record = await readPatrolRecord(h)
    expect(record?.decision).toBe('error')
    expect(record?.labels).toEqual({ exit_code: '2', notified: 'false' })
  })

  it('an invalid resolved patrol config is an internal error (exit 2)', async () => {
    const base = resolveConfig({ preset: 'observe' })
    const broken = { ...base, patrol: { ...base.patrol, factor: 0 } } as ResolvedConfig
    const h = makeHarness({ resolved: broken })
    const report = await runPatrol(h.runtime, probeFor())
    expect(report.exitCode).toBe(PATROL_EXIT.error)
    expect(report.internalError).toBe('patrol: invalid configuration')
  })

  it('a throwing check is an internal error that does not leak the raw message', async () => {
    const h = makeHarness()
    const report = await runPatrol(
      h.runtime,
      probeFor({
        posture: async () => {
          throw new Error('posture failed with sandbox mode workspace-write')
        },
      }),
      { include: ['config_drift'] },
    )
    expect(report.exitCode).toBe(PATROL_EXIT.error)
    expect(report.internalError).toBe('patrol: config_drift check failed')
    expect(report.findings).toEqual([])
    expect(report.internalError).not.toContain('workspace-write')
  })
})

// ---------------------------------------------------------------------------
// audit_rate
// ---------------------------------------------------------------------------

describe('patrol audit_rate', () => {
  it('SKIPs when the ledger has no records at all', async () => {
    const h = makeHarness()
    const report = await runPatrol(h.runtime, probeFor(), { include: ['audit_rate'] })
    expect(report.findings[0]?.severity).toBe('SKIP')
    expect(report.findings[0]?.detail).toContain('no ledger records')
  })

  it('is OK while denials stay below minCount', async () => {
    const h = makeHarness({ config: { patrol: { minCount: 10 } } })
    await seedDenies(h, 2, NOW - MIN)
    const report = await runPatrol(h.runtime, probeFor(), { include: ['audit_rate'] })
    expect(report.findings[0]?.severity).toBe('OK')
    expect(report.exitCode).toBe(PATROL_EXIT.clean)
  })

  it('is OK (not SKIP) when records exist but none are denials', async () => {
    const h = makeHarness()
    await h.append('tool_checked', { decision: 'allow' }, NOW - MIN)
    await h.append('input_checked', { decision: 'allow' }, NOW - MIN)
    const report = await runPatrol(h.runtime, probeFor(), { include: ['audit_rate'] })
    expect(report.findings[0]?.severity).toBe('OK')
    expect(report.findings[0]?.detail).toContain('0')
  })

  it('FAILs at minCount denies in the current window (exit 1)', async () => {
    const h = makeHarness({ config: { patrol: { minCount: 10, windowMinutes: 10, factor: 5 } } })
    await seedDenies(h, 10, NOW - MIN)
    const report = await runPatrol(h.runtime, probeFor(), { include: ['audit_rate'] })
    expect(report.findings[0]?.severity).toBe('FAIL')
    expect(report.findings[0]?.detail).toContain('10')
    expect(report.exitCode).toBe(PATROL_EXIT.fail)
  })

  it('FAILs on factor × baseline-window mean, not only minCount', async () => {
    const patrol = { windowMinutes: 10, baselineWindows: 3, factor: 5, minCount: 10 }
    /** 4 denies in each of the 3 baseline windows → mean 4 → threshold max(10, 20). */
    const seedBaseline = async (h: Harness): Promise<void> => {
      for (const at of [NOW - 15 * MIN, NOW - 25 * MIN, NOW - 35 * MIN]) await seedDenies(h, 4, at)
    }

    const failing = makeHarness({ config: { patrol } })
    await seedBaseline(failing)
    await seedDenies(failing, 20, NOW - MIN)
    const failReport = await runPatrol(failing.runtime, probeFor(), { include: ['audit_rate'] })
    expect(failReport.findings[0]?.severity).toBe('FAIL')
    expect(failReport.exitCode).toBe(PATROL_EXIT.fail)

    const passing = makeHarness({ config: { patrol } })
    await seedBaseline(passing)
    await seedDenies(passing, 19, NOW - MIN)
    const okReport = await runPatrol(passing.runtime, probeFor(), { include: ['audit_rate'] })
    expect(okReport.findings[0]?.severity).toBe('OK')
  })
})

// ---------------------------------------------------------------------------
// health_probe
// ---------------------------------------------------------------------------

describe('patrol health_probe', () => {
  it('SKIPs when no health endpoint is configured', async () => {
    const h = makeHarness()
    const report = await runPatrol(h.runtime, probeFor(), { include: ['health_probe'] })
    expect(report.findings[0]?.severity).toBe('SKIP')
    expect(report.findings[0]?.detail).toContain('no health endpoint')
  })

  it('is OK for any status below 500 (401/403 included) and probes with GET/manual', async () => {
    const h = makeHarness({
      config: { patrol: { healthUrls: ['https://a.example/health', 'https://b.example/admin'] } },
    })
    const calls: { url: string; init: { method: string; signal: AbortSignal; redirect: string } }[] = []
    const report = await runPatrol(
      h.runtime,
      probeFor({
        fetchImpl: async (url, init) => {
          calls.push({ url, init })
          return { status: url.includes('admin') ? 403 : 200 }
        },
      }),
      { include: ['health_probe'] },
    )
    expect(report.findings[0]?.severity).toBe('OK')
    expect(calls).toHaveLength(2)
    expect(calls[0]?.init.method).toBe('GET')
    expect(calls[0]?.init.redirect).toBe('manual')
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
    // The detail must not name the endpoint.
    expect(report.findings[0]?.detail).not.toMatch(/https?:|a\.example|b\.example/u)
  })

  it('FAILs on a 5xx response (exit 1)', async () => {
    const h = makeHarness({ config: { patrol: { healthUrls: ['https://a.example/health'] } } })
    const report = await runPatrol(
      h.runtime,
      probeFor({ fetchImpl: async () => ({ status: 503 }) }),
      { include: ['health_probe'] },
    )
    expect(report.findings[0]?.severity).toBe('FAIL')
    expect(report.exitCode).toBe(PATROL_EXIT.fail)
  })

  it('FAILs on a timeout/refused connection without leaking the host', async () => {
    const h = makeHarness({
      config: { patrol: { healthUrls: ['https://down.example/health', 'https://up.example/health'] } },
    })
    const report = await runPatrol(
      h.runtime,
      probeFor({
        fetchImpl: async (url) => {
          if (url.includes('down')) throw new Error('connect ECONNREFUSED 127.0.0.1:9')
          return { status: 200 }
        },
      }),
      { include: ['health_probe'] },
    )
    expect(report.findings[0]?.severity).toBe('FAIL')
    expect(report.findings[0]?.detail).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|down\.example/u)
  })
})

// ---------------------------------------------------------------------------
// config_drift
// ---------------------------------------------------------------------------

describe('patrol config_drift', () => {
  it('SKIPs when no posture probe is available', async () => {
    const h = makeHarness()
    const report = await runPatrol(h.runtime, probeFor(), { include: ['config_drift'] })
    expect(report.findings[0]?.severity).toBe('SKIP')
    expect(report.findings[0]?.detail).toContain('posture probe')
  })

  it('SKIPs when the ledger has no previous posture report', async () => {
    const h = makeHarness()
    const report = await runPatrol(
      h.runtime,
      probeFor({ posture: async () => ({ findings: [] }) }),
      { include: ['config_drift'] },
    )
    expect(report.findings[0]?.severity).toBe('SKIP')
    expect(report.findings[0]?.detail).toContain('no previous posture report')
  })

  it('is OK when the current non-OK code set matches the recorded one', async () => {
    const h = makeHarness()
    await h.append(
      'posture_report',
      { decision: 'warn', rule_ids: ['sandbox_danger_full_access', 'ledger_writable'] },
      NOW - 5 * MIN,
    )
    const report = await runPatrol(
      h.runtime,
      probeFor({
        posture: async () => ({
          findings: [
            { code: 'sandbox_danger_full_access', severity: 'WARN' },
            { code: 'ledger_writable', severity: 'SKIP' },
            { code: 'rules_loaded', severity: 'OK' },
          ],
        }),
      }),
      { include: ['config_drift'] },
    )
    expect(report.findings[0]?.severity).toBe('OK')
  })

  it('WARNs on a one-sided difference and names only codes', async () => {
    const h = makeHarness()
    await h.append('posture_report', { decision: 'warn', rule_ids: ['sandbox_danger_full_access'] }, NOW - 5 * MIN)
    const report = await runPatrol(
      h.runtime,
      probeFor({
        posture: async () => ({
          findings: [
            { code: 'sandbox_danger_full_access', severity: 'OK' },
            { code: 'ledger_writable', severity: 'FAIL' },
          ],
        }),
      }),
      { include: ['config_drift'] },
    )
    expect(report.findings[0]?.severity).toBe('WARN')
    expect(report.findings[0]?.detail).toContain('sandbox_danger_full_access')
    expect(report.findings[0]?.detail).toContain('ledger_writable')
    expect(report.exitCode).toBe(PATROL_EXIT.clean)
    // No configured value, only finding codes.
    expect(report.findings[0]?.detail).not.toMatch(/warn|fail|skip|ok\b/iu)
  })
})

// ---------------------------------------------------------------------------
// ledger_reconcile
// ---------------------------------------------------------------------------

describe('patrol ledger_reconcile', () => {
  it('SKIPs when neither side has a record in the window (both zero)', async () => {
    const h = makeHarness()
    const report = await runPatrol(h.runtime, probeFor(), { include: ['ledger_reconcile'] })
    expect(report.findings[0]?.severity).toBe('SKIP')
    expect(report.findings[0]?.detail).toContain('no ask or approval-decision records')
  })

  it('reconciles in delegate mode too (the bridge records the pair in both modes)', async () => {
    const h = makeHarness() // observe preset → approval.mode = delegate
    await seedAsks(h, 6, NOW - MIN)
    for (let index = 0; index < 6; index += 1) {
      await h.append('approval_decided', { decision: 'rejected', reason_code: 'approval_rejected' }, NOW - MIN)
    }
    const report = await runPatrol(h.runtime, probeFor(), { include: ['ledger_reconcile'] })
    expect(report.findings[0]?.severity).toBe('OK')
    expect(report.findings[0]?.detail).toContain('6 vs 6')
    expect(report.exitCode).toBe(PATROL_EXIT.clean)
  })

  it('is OK in policy mode when both counters agree within 10%', async () => {
    const h = makeHarness({ config: { approval: { mode: 'policy' } } })
    await seedAsks(h, 10, NOW - MIN)
    // The right side counts every approval decision, not only `rejected`.
    for (let index = 0; index < 6; index += 1) {
      await h.append('approval_decided', { decision: 'rejected', reason_code: 'approval_rejected' }, NOW - 2 * MIN)
    }
    for (let index = 0; index < 4; index += 1) {
      await h.append('approval_decided', { decision: 'allowed-once', reason_code: 'approval_allowed_once' }, NOW - 2 * MIN)
    }
    await seedDenies(h, 7, NOW - 2 * MIN) // plain denials are not asks: ignored
    const report = await runPatrol(h.runtime, probeFor(), { include: ['ledger_reconcile'] })
    expect(report.findings[0]?.severity).toBe('OK')
    expect(report.findings[0]?.detail).toContain('10 vs 10')
    expect(report.exitCode).toBe(PATROL_EXIT.clean)
  })

  it('tolerates exactly 10% but WARNs beyond it', async () => {
    const within = makeHarness({ config: { approval: { mode: 'policy' } } })
    await seedAsks(within, 10, NOW - MIN)
    for (let index = 0; index < 9; index += 1) {
      await within.append('approval_decided', { decision: 'rejected' }, NOW - MIN)
    }
    const withinReport = await runPatrol(within.runtime, probeFor(), { include: ['ledger_reconcile'] })
    expect(withinReport.findings[0]?.severity).toBe('OK')

    const beyond = makeHarness({ config: { approval: { mode: 'policy' } } })
    await seedAsks(beyond, 10, NOW - MIN)
    for (let index = 0; index < 5; index += 1) {
      await beyond.append('approval_decided', { decision: 'rejected' }, NOW - MIN)
    }
    const beyondReport = await runPatrol(beyond.runtime, probeFor(), { include: ['ledger_reconcile'] })
    expect(beyondReport.findings[0]?.severity).toBe('WARN')
    expect(beyondReport.findings[0]?.detail).toContain('10 vs 5')
    // A WARN never fails the process.
    expect(beyondReport.exitCode).toBe(PATROL_EXIT.clean)
  })
})

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------

describe('patrol notify', () => {
  it('SKIPs when no webhook is configured, even on a dirty report', async () => {
    const h = makeHarness({ config: { patrol: { healthUrls: ['https://a.example/health'] } } })
    const notifyImpl = vi.fn(async () => {})
    const report = await runPatrol(
      h.runtime,
      probeFor({ notifyImpl, fetchImpl: async () => ({ status: 500 }) }),
      { include: ['health_probe', 'notify'] },
    )
    const notify = report.findings.find((item) => item.code === 'notify')
    expect(notify?.severity).toBe('SKIP')
    expect(notify?.detail).toContain('no webhook')
    expect(notifyImpl).not.toHaveBeenCalled()
    expect(report.notified).toBe(false)
  })

  it('SKIPs without sending when the report is clean', async () => {
    const h = makeHarness({ config: { patrol: { feishuWebhook: 'https://hook.example/secret' } } })
    const notifyImpl = vi.fn(async () => {})
    const report = await runPatrol(h.runtime, probeFor({ notifyImpl }))
    const notify = report.findings.find((item) => item.code === 'notify')
    expect(notify?.severity).toBe('SKIP')
    expect(notify?.detail).toContain('clean')
    expect(notifyImpl).not.toHaveBeenCalled()
    expect(report.notified).toBe(false)
  })

  it('sends the exact plain-text sentence and records the run', async () => {
    const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/SEKRET-TOKEN'
    const h = makeHarness({
      config: { patrol: { minCount: 10, windowMinutes: 10, feishuWebhook: webhook } },
    })
    await seedDenies(h, 10, NOW - MIN)
    const sent: { webhook: string; text: string }[] = []
    const report = await runPatrol(
      h.runtime,
      probeFor({
        notifyImpl: async (target, text) => {
          sent.push({ webhook: target, text })
        },
      }),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]?.webhook).toBe(webhook)
    expect(sent[0]?.text).toBe('Upear SafeHarness: 1 FAIL / 0 WARN')
    // Counts only: no payload, no path, no secret, no tool/session names.
    for (const forbidden of ['SEKRET', 'http', 'hook', 'session', 'tool']) {
      expect(sent[0]?.text).not.toContain(forbidden)
    }
    const notify = report.findings.find((item) => item.code === 'notify')
    expect(notify?.severity).toBe('OK')
    expect(report.notified).toBe(true)
    expect(report.exitCode).toBe(PATROL_EXIT.fail)

    const record = await readPatrolRecord(h)
    expect(record?.decision).toBe('fail')
    // SKIP is non-OK, so the unobserved checks are listed too (same as posture_report).
    expect(record?.rule_ids).toEqual(['audit_rate', 'health_probe', 'config_drift', 'ledger_reconcile'])
    expect(record?.labels).toEqual({ exit_code: '1', notified: 'true' })
  })

  it('default sender posts the Feishu JSON envelope with a counts-only text', async () => {
    const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/SEKRET-WEBHOOK'
    const h = makeHarness({
      config: { patrol: { minCount: 10, windowMinutes: 10, feishuWebhook: webhook } },
    })
    await seedDenies(h, 10, NOW - MIN)
    const calls: {
      url: string
      init: { method?: string; headers?: Record<string, string>; body?: string }
    }[] = []
    const fetchStub = vi.fn(
      async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
        calls.push({ url, init })
        return { ok: true, status: 200 }
      },
    )
    // The default sender is the only network seam this run uses (health list empty).
    vi.stubGlobal('fetch', fetchStub)
    try {
      const report = await runPatrol(h.runtime, probeFor()) // no notifyImpl → default sender
      expect(report.notified).toBe(true)
      expect(fetchStub).toHaveBeenCalledTimes(1)
      const [call] = calls
      expect(call?.url).toBe(webhook)
      expect(call?.init.method).toBe('POST')
      const contentType = Object.entries(call?.init.headers ?? {})
        .find(([key]) => key.toLowerCase() === 'content-type')?.[1]
      expect(contentType).toContain('application/json')
      const body = String(call?.init.body ?? '')
      const parsed = JSON.parse(body) as { msg_type: string; content: { text: string } }
      expect(parsed.msg_type).toBe('text')
      expect(parsed.content.text).toBe('Upear SafeHarness: 1 FAIL / 0 WARN')
      // Zero payload: the body carries only the sentence, no target/session/tool.
      for (const forbidden of ['SEKRET', 'http', 'hook', 'session', 'tool']) {
        expect(body).not.toContain(forbidden)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a delivery failure is WARN notify_failed, never FAIL and never a throw', async () => {
    const h = makeHarness({
      config: { patrol: { minCount: 10, windowMinutes: 10, feishuWebhook: 'https://hook.example/x' } },
    })
    await seedDenies(h, 10, NOW - MIN)
    const report = await runPatrol(
      h.runtime,
      probeFor({
        notifyImpl: async () => {
          throw new Error('network down')
        },
      }),
    )
    const notify = report.findings.find((item) => item.code === 'notify')
    expect(notify?.severity).toBe('WARN')
    expect(notify?.detail).toContain('notify_failed')
    expect(report.notified).toBe(false)
    // The failure does not add a FAIL, so the exit code stays the audit_rate FAIL.
    expect(report.summary.fail).toBe(1)
    expect(report.exitCode).toBe(PATROL_EXIT.fail)
  })

  it('notifies on a WARN-only report with the warn count (exit stays 0)', async () => {
    const h = makeHarness({ config: { patrol: { feishuWebhook: 'https://hook.example/x' } } })
    await h.append('posture_report', { decision: 'warn', rule_ids: ['sandbox_danger_full_access'] }, NOW - 5 * MIN)
    const sent: string[] = []
    const report = await runPatrol(
      h.runtime,
      probeFor({
        posture: async () => ({ findings: [] }),
        notifyImpl: async (_target, text) => {
          sent.push(text)
        },
      }),
      { include: ['config_drift', 'notify'] },
    )
    expect(sent).toEqual(['Upear SafeHarness: 0 FAIL / 1 WARN'])
    expect(report.notified).toBe(true)
    expect(report.exitCode).toBe(PATROL_EXIT.clean)
  })

  it('a failed notification on a WARN-only report is still exit 0', async () => {
    const h = makeHarness({ config: { patrol: { feishuWebhook: 'https://hook.example/x' } } })
    await h.append('posture_report', { decision: 'warn', rule_ids: ['sandbox_danger_full_access'] }, NOW - 5 * MIN)
    const report = await runPatrol(
      h.runtime,
      probeFor({
        posture: async () => ({ findings: [] }),
        notifyImpl: async () => {
          throw new Error('network down')
        },
      }),
      { include: ['config_drift', 'notify'] },
    )
    expect(report.findings.map((item) => item.severity)).toEqual(['WARN', 'WARN'])
    expect(report.summary).toMatchObject({ fail: 0, warn: 2, clean: false })
    expect(report.exitCode).toBe(PATROL_EXIT.clean)
  })
})

// ---------------------------------------------------------------------------
// Content discipline
// ---------------------------------------------------------------------------

describe('patrol content discipline', () => {
  it('never puts a webhook, URL, path or secret into a finding or a notification', async () => {
    const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/SEKRET-WEBHOOK'
    const h = makeHarness({
      config: {
        patrol: {
          minCount: 10,
          windowMinutes: 10,
          factor: 5,
          baselineWindows: 6,
          healthUrls: ['https://ops.internal/health/SEKRET-PATH'],
          feishuWebhook: webhook,
        },
      },
    })
    await seedDenies(h, 10, NOW - MIN)
    const sent: string[] = []
    const report = await runPatrol(
      h.runtime,
      probeFor({
        fetchImpl: async () => ({ status: 503 }),
        notifyImpl: async (_target, text) => {
          sent.push(text)
        },
      }),
    )
    expect(report.internalError).toBeUndefined()
    expect(report.findings).toHaveLength(PATROL_CODES.length)
    for (const item of report.findings) {
      expect(item.detail).not.toMatch(/SEKRET|https?:|ops\.internal|feishu/iu)
    }
    expect(sent).toEqual(['Upear SafeHarness: 2 FAIL / 0 WARN'])
    expect(sent[0]).not.toMatch(/SEKRET|https?:|ops\.internal|feishu/iu)
  })
})

// ---------------------------------------------------------------------------
// notify — multiple channels
// ---------------------------------------------------------------------------

describe('patrol notify — multiple channels', () => {
  /** A dirty-config harness with the given destinations. */
  function multi(notify: NonNullable<SafeHarnessConfig['patrol']>['notify']): Harness {
    return makeHarness({ config: { patrol: { minCount: 10, windowMinutes: 10, notify } } })
  }

  it('delivers to every channel, tallies failures by type and never leaks a URL', async () => {
    const h = multi([
      { type: 'dingtalk', webhook: 'https://a.example/ding' },
      { type: 'wecom', webhook: 'https://b.example/wecom' },
      { type: 'feishu', webhook: 'https://c.example/feishu' },
    ])
    await seedDenies(h, 10, NOW - MIN)
    const calls: string[] = []
    const fetchStub = vi.fn(async (url: string) => {
      calls.push(url)
      const failed = url.includes('b.example')
      return { ok: !failed, status: failed ? 500 : 200 }
    })
    vi.stubGlobal('fetch', fetchStub)
    try {
      const report = await runPatrol(h.runtime, probeFor())
      expect(calls).toHaveLength(3)
      const notify = report.findings.find((item) => item.code === 'notify')
      expect(notify?.severity).toBe('WARN')
      expect(notify?.detail).toBe('notify_failed: 2/3 channels delivered; 1 failed (wecom: http_500)')
      expect(report.notified).toBe(false)
      for (const item of report.findings) expect(item.detail).not.toMatch(/https?:|a\.example|b\.example/u)

      const records = await readLedger(h.runtime)
      const patrolRecord = records.find((record) => record.kind === 'patrol_report')
      expect(patrolRecord?.labels?.notified).toBe('false')
      const serialized = JSON.stringify(records)
      for (const forbidden of ['a.example', 'b.example', 'c.example', 'ding', 'wecom']) {
        expect(serialized).not.toContain(forbidden)
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('marks notified true only when every channel succeeded', async () => {
    const h = multi([
      { type: 'dingtalk', webhook: 'https://a.example/ding' },
      { type: 'onebot', webhook: 'http://127.0.0.1:5700/', groupId: '7' },
    ])
    await seedDenies(h, 10, NOW - MIN)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 204 })))
    try {
      const report = await runPatrol(h.runtime, probeFor())
      const notify = report.findings.find((item) => item.code === 'notify')
      expect(notify?.severity).toBe('OK')
      expect(notify?.detail).toBe('notification sent (2/2 channels delivered)')
      expect(report.notified).toBe(true)
      const record = (await readLedger(h.runtime)).find((item) => item.kind === 'patrol_report')
      expect(record?.labels?.notified).toBe('true')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
