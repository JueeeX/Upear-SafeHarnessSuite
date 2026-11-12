/**
 * The panel route (T5.3): the browser fence, the response envelopes, and the
 * gates on every state-changing endpoint.
 *
 * The fence is the security-relevant half: the route is mounted on the same
 * HTTP carrier as the GUI, so it must answer only same-origin loopback calls.
 * These tests pin the three questions the shared `/api` fence asks, plus the
 * POST-only / single-flight / cooldown / body-limit gates.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createPanelHandler, isTrustedPanelRequest, registerPanelRoute } from '../src/panel/route.js'
import { createPatrolRunner } from '../src/panel/patrol-runner.js'
import type { Runtime } from '../src/runtime.js'
import type { PatrolReport } from '../src/patrol/index.js'
import type { DraftResult } from '../src/draft/rule.js'
import type { PatrolScheduler } from '../src/panel/schedule.js'
import type { PanelSettingsHost } from '../src/panel/settings.js'
import { PanelSettingsError } from '../src/panel/settings.js'
import type { PanelJudgeProbe, PanelSettingsValue } from '../src/panel/protocol.js'

/** One request, with an optional JSON body the handler can read. */
function request(
  headers: Record<string, string>,
  options: { method?: string; url?: string; body?: unknown; rawBody?: string } = {},
): IncomingMessage {
  const payload = options.rawBody !== undefined
    ? options.rawBody
    : options.body === undefined ? undefined : JSON.stringify(options.body)
  const req = {
    headers,
    method: options.method ?? 'POST',
    url: options.url ?? '/safeharness/status',
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield Buffer.from(payload)
    },
  }
  return req as unknown as IncomingMessage
}

/** A response recorder. */
function response(): { res: ServerResponse; status: number; headers: Record<string, string>; body: string } {
  const captured = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      captured.headers = headers ?? {}
      return res
    },
    end(body?: string) {
      captured.body = body ?? ''
      return res
    },
  } as unknown as ServerResponse
  return { res, get status() { return captured.status }, get headers() { return captured.headers }, get body() { return captured.body } }
}

/** A runtime stub the payload builder can read. */
function stubRuntime(options: { stateThrows?: boolean; draftEnabled?: boolean } = {}): Runtime {
  const ruleset = { hash: 'b'.repeat(64), rules: [], chains: [], ruleCount: 20, chainCount: 3, sources: [], loadedAt: 0 }
  return {
    config: {
      preset: 'balanced',
      input: { mode: 'enforce' },
      tools: { mode: 'enforce' },
      results: { mode: 'warn' },
      output: {
        mode: 'warn',
        judge: { enabled: false, scope: 'flagged', provider: '', model: '', maxChars: 12_000, timeoutMs: 4_000 },
      },
      approval: { mode: 'delegate' },
      draft: { enabled: options.draftEnabled ?? false, maxChars: 2_000, timeoutMs: 5_000, maxTokens: 200 },
      rules: { dir: '', inline: [] },
    },
    engine: {
      rulesetHash: 'b'.repeat(64),
      ruleCount: 20,
      chainCount: 3,
      ruleset,
    },
    ledger: {
      stats: { enabled: true, writable: true, records: 1, failures: 0, lastWriteAt: 5, path: 'C:\\x\\ledger.ndjson' },
      query: async () => [],
    },
    get state(): { size: number; list: () => unknown[] } {
      if (options.stateThrows === true) throw new Error('state exploded')
      return { size: 0, list: () => [] }
    },
    counters: { allow: 0, warn: 0, deny: 0, ask: 0, auditBlocked: 0, internalErrors: 0 },
    audit: () => undefined,
    internalError: () => undefined,
  } as unknown as Runtime
}

/** One patrol report with the fields the projection reads. */
function report(overrides: Partial<PatrolReport> = {}): PatrolReport {
  return {
    ranAt: '2026-11-12T04:00:00.000Z',
    exitCode: 0,
    summary: { fail: 0, warn: 0, ok: 2, skip: 3, clean: true },
    findings: [
      { code: 'audit_rate', severity: 'OK', detail: 'ok' },
      { code: 'health_probe', severity: 'SKIP', detail: 'none' },
    ],
    notified: false,
    ...overrides,
  } as PatrolReport
}

/** A scheduler stub capturing what the route asked for. */
function stubScheduler(calls: Array<{ enabled: boolean; intervalMinutes: number | null }>): PatrolScheduler {
  return {
    snapshot: () => ({ enabled: false, intervalMinutes: null, nextAt: null, lastRunAt: null, persisted: true }),
    set: (enabled, intervalMinutes) => {
      calls.push({ enabled, intervalMinutes })
      return { enabled, intervalMinutes, nextAt: enabled ? 1 : null, lastRunAt: null, persisted: true }
    },
    dispose: () => undefined,
  }
}

/** A successful draft, as the drafter would answer it. */
function draftResult(): DraftResult {
  return {
    status: 'ok',
    draft: {
      kind: 'inform',
      name: 'curl_pipe_sh',
      severity: 'high',
      category: 'network',
      reason: 'downloaded script piped into a shell',
      yaml: 'rules:\n  - name: curl_pipe_sh\n',
      summary: "inform rule 'curl_pipe_sh' [high] network",
      warnings: ['pattern looks close to an exact match'],
    },
    metrics: { durationMs: 12, promptChars: 300, replyChars: 200 },
  }
}

describe('isTrustedPanelRequest', () => {
  it('accepts same-origin loopback requests', () => {
    expect(isTrustedPanelRequest(request({ host: '127.0.0.1:61112' }))).toBe(true)
    expect(isTrustedPanelRequest(request({ host: '127.0.0.1:61112', origin: 'http://127.0.0.1:61112' }))).toBe(true)
    expect(isTrustedPanelRequest(request({ host: 'localhost:61112' }))).toBe(true)
    expect(isTrustedPanelRequest(request({ host: '[::1]:61112' }))).toBe(true)
    expect(isTrustedPanelRequest(request({ host: '127.0.0.42:61112' }))).toBe(true)
  })

  it('refuses a rebound Host, a cross-site marker and a foreign Origin', () => {
    expect(isTrustedPanelRequest(request({ host: 'evil.example' }))).toBe(false)
    expect(isTrustedPanelRequest(request({ host: '127.0.0.1:61112', 'sec-fetch-site': 'cross-site' }))).toBe(false)
    expect(isTrustedPanelRequest(request({ host: '127.0.0.1:61112', origin: 'http://evil.example' }))).toBe(false)
    expect(isTrustedPanelRequest(request({}))).toBe(false)
  })

  it('refuses an unparsable Host or Origin', () => {
    expect(isTrustedPanelRequest(request({ host: 'http://[bad' }))).toBe(false)
    expect(isTrustedPanelRequest(request({ host: '127.0.0.1:61112', origin: 'not a url' }))).toBe(false)
  })
})

describe('createPanelHandler', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const options = { runtime: stubRuntime(), startedAt: Date.now(), logger }

  it('serves the payload envelope for the status endpoint', async () => {
    const handler = createPanelHandler(options)
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }), out.res)
    expect(out.status).toBe(200)
    expect(out.headers['cache-control']).toBe('no-store')
    const envelope = JSON.parse(out.body) as { ok: boolean; value: { preset: string; rulesDetail: unknown[]; schedule: { enabled: boolean } } }
    expect(envelope.ok).toBe(true)
    expect(envelope.value.preset).toBe('balanced')
    expect(envelope.value.rulesDetail).toEqual([])
    expect(envelope.value.schedule.enabled).toBe(false)
  })

  it('refuses an untrusted request before reading anything', async () => {
    const out = response()
    await createPanelHandler(options)(request({ host: 'evil.example' }), out.res)
    expect(out.status).toBe(403)
    expect(out.body).toBe('forbidden')
  })

  it('rejects other methods', async () => {
    const out = response()
    await createPanelHandler(options)(request({ host: '127.0.0.1:61112' }, { method: 'DELETE' }), out.res)
    expect(out.status).toBe(405)
  })

  it('answers unknown endpoints with a coded envelope', async () => {
    const out = response()
    await createPanelHandler(options)(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/other' }), out.res)
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: { code: 'unknown_endpoint', message: 'unknown panel endpoint' } })
  })

  it('never leaks an internal failure as a stack or a message', async () => {
    const failing = createPanelHandler({ ...options, runtime: stubRuntime({ stateThrows: true }) })
    const out = response()
    await failing(request({ host: '127.0.0.1:61112' }), out.res)
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: { code: 'panel_failed', message: 'panel payload unavailable' } })
  })
})

describe('patrol endpoint', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} }

  it('runs one patrol on POST and projects the report', async () => {
    let calls = 0
    const runner = createPatrolRunner(async () => { calls += 1; return report() })
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger, patrolRunner: runner })
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/patrol' }), out.res)
    expect(calls).toBe(1)
    const envelope = JSON.parse(out.body) as { ok: boolean; value: { exitCode: number; findings: unknown[]; summary: { clean: boolean } } }
    expect(envelope.ok).toBe(true)
    expect(envelope.value.exitCode).toBe(0)
    expect(envelope.value.findings).toHaveLength(2)
    expect(envelope.value.summary.clean).toBe(true)
  })

  it('refuses GET (navigation cannot start it)', async () => {
    let calls = 0
    const runner = createPatrolRunner(async () => { calls += 1; return report() })
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger, patrolRunner: runner })
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }, { method: 'GET', url: '/safeharness/patrol' }), out.res)
    expect(calls).toBe(0)
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: { code: 'method_not_allowed', message: 'patrol requires POST' } })
  })

  it('enforces the cooldown window between operator-triggered runs', async () => {
    let clock = 1_000
    let calls = 0
    const runner = createPatrolRunner(async () => { calls += 1; return report() }, { now: () => clock })
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger, patrolRunner: runner })
    const first = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/patrol' }), first.res)
    const second = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/patrol' }), second.res)
    expect(JSON.parse(first.body)).toMatchObject({ ok: true })
    expect(JSON.parse(second.body)).toEqual({ ok: false, error: { code: 'patrol_cooldown', message: 'patrol ran moments ago; try again shortly' } })
    expect(calls).toBe(1)
    clock += 6_000
    const third = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/patrol' }), third.res)
    expect(JSON.parse(third.body)).toMatchObject({ ok: true })
    expect(calls).toBe(2)
  })

  it('runs a single patrol at a time', async () => {
    let release: (() => void) | undefined
    const runner = createPatrolRunner(() => new Promise<PatrolReport>((resolve) => {
      release = () => { resolve(report()) }
    }))
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger, patrolRunner: runner })
    const first = response()
    const pending = handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/patrol' }), first.res)
    const second = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/patrol' }), second.res)
    expect(JSON.parse(second.body)).toMatchObject({ ok: false, error: { code: 'patrol_in_progress' } })
    release?.()
    await pending
    expect(JSON.parse(first.body)).toMatchObject({ ok: true })
  })

  it('turns a runner throw into a coded envelope and reports unavailability', async () => {
    const throwing = createPanelHandler({
      runtime: stubRuntime(),
      startedAt: 0,
      logger,
      patrolRunner: createPatrolRunner(async () => { throw new Error('boom') }),
    })
    const out = response()
    await throwing(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/patrol' }), out.res)
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: { code: 'patrol_failed', message: 'patrol failed' } })

    const unwired = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger })
    const missing = response()
    await unwired(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/patrol' }), missing.res)
    expect(JSON.parse(missing.body)).toMatchObject({ ok: false, error: { code: 'patrol_unavailable' } })
  })
})

describe('draft endpoint', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} }

  it('returns the validated draft without applying it', async () => {
    const handler = createPanelHandler({
      runtime: stubRuntime({ draftEnabled: true }),
      startedAt: 0,
      logger,
      draft: async () => draftResult(),
    })
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/draft', body: { description: 'curl | sh' } }), out.res)
    const envelope = JSON.parse(out.body) as { ok: boolean; value: { name: string; yaml: string; warnings: string[] } }
    expect(envelope.ok).toBe(true)
    expect(envelope.value.name).toBe('curl_pipe_sh')
    expect(envelope.value.yaml).toContain('rules:')
    expect(envelope.value.warnings).toHaveLength(1)
  })

  it('refuses when drafting is disabled, unavailable, or the body is bad', async () => {
    const disabled = createPanelHandler({ runtime: stubRuntime({ draftEnabled: false }), startedAt: 0, logger, draft: async () => draftResult() })
    const disabledOut = response()
    await disabled(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/draft', body: { description: 'x' } }), disabledOut.res)
    expect(JSON.parse(disabledOut.body)).toMatchObject({ ok: false, error: { code: 'draft_disabled' } })

    const unwired = createPanelHandler({ runtime: stubRuntime({ draftEnabled: true }), startedAt: 0, logger })
    const unwiredOut = response()
    await unwired(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/draft', body: { description: 'x' } }), unwiredOut.res)
    expect(JSON.parse(unwiredOut.body)).toMatchObject({ ok: false, error: { code: 'draft_unavailable' } })

    const enabled = createPanelHandler({ runtime: stubRuntime({ draftEnabled: true }), startedAt: 0, logger, draft: async () => draftResult() })
    const empty = response()
    await enabled(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/draft', body: {} }), empty.res)
    expect(JSON.parse(empty.body)).toMatchObject({ ok: false, error: { code: 'invalid_body' } })

    const long = response()
    await enabled(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/draft', body: { description: 'x'.repeat(2_001) } }), long.res)
    expect(JSON.parse(long.body)).toMatchObject({ ok: false, error: { code: 'invalid_body' } })

    const broken = response()
    await enabled(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/draft', rawBody: 'not json' }), broken.res)
    expect(JSON.parse(broken.body)).toMatchObject({ ok: false, error: { code: 'invalid_body' } })
  })

  it('runs a single draft at a time', async () => {
    let release: (() => void) | undefined
    const handler = createPanelHandler({
      runtime: stubRuntime({ draftEnabled: true }),
      startedAt: 0,
      logger,
      draft: () => new Promise<DraftResult>((resolve) => {
        release = () => { resolve(draftResult()) }
      }),
    })
    const first = response()
    const pending = handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/draft', body: { description: 'a' } }), first.res)
    const second = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/draft', body: { description: 'b' } }), second.res)
    expect(JSON.parse(second.body)).toMatchObject({ ok: false, error: { code: 'draft_in_progress' } })
    release?.()
    await pending
    expect(JSON.parse(first.body)).toMatchObject({ ok: true })
  })
})

describe('schedule endpoint', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} }

  it('arms and disarms the persisted timer', async () => {
    const calls: Array<{ enabled: boolean; intervalMinutes: number | null }> = []
    const handler = createPanelHandler({
      runtime: stubRuntime(),
      startedAt: 0,
      logger,
      schedule: stubScheduler(calls),
    })
    const enabled = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/schedule', body: { enabled: true, intervalMinutes: 30 } }), enabled.res)
    expect(JSON.parse(enabled.body)).toMatchObject({ ok: true, value: { enabled: true, intervalMinutes: 30 } })

    const disabled = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/schedule', body: { enabled: false } }), disabled.res)
    expect(JSON.parse(disabled.body)).toMatchObject({ ok: true, value: { enabled: false, intervalMinutes: null } })
    expect(calls).toEqual([
      { enabled: true, intervalMinutes: 30 },
      { enabled: false, intervalMinutes: null },
    ])
  })

  it('rejects an out-of-range interval and a bad body', async () => {
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger, schedule: stubScheduler([]) })
    for (const intervalMinutes of [3, 1_441, '30']) {
      const out = response()
      await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/schedule', body: { enabled: true, intervalMinutes } }), out.res)
      expect(JSON.parse(out.body)).toMatchObject({ ok: false, error: { code: 'invalid_body' } })
    }
    const noFlag = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/schedule', body: { intervalMinutes: 30 } }), noFlag.res)
    expect(JSON.parse(noFlag.body)).toMatchObject({ ok: false, error: { code: 'invalid_body' } })
  })

  it('reports unavailability without a scheduler', async () => {
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger })
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/schedule', body: { enabled: true, intervalMinutes: 30 } }), out.res)
    expect(JSON.parse(out.body)).toMatchObject({ ok: false, error: { code: 'schedule_unavailable' } })
  })
})

describe('reload-rules endpoint', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} }

  it('reports the reloaded identity', async () => {
    const handler = createPanelHandler({
      runtime: stubRuntime(),
      startedAt: 0,
      logger,
      reloadRules: () => ({ rules: 20, chains: 3, hash: 'c'.repeat(12) }),
    })
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/reload-rules' }), out.res)
    expect(JSON.parse(out.body)).toMatchObject({ ok: true, value: { rules: 20, chains: 3 } })
  })

  it('maps a loader failure to a coded envelope and reports unavailability', async () => {
    const failing = createPanelHandler({
      runtime: stubRuntime(),
      startedAt: 0,
      logger,
      reloadRules: () => { throw new Error('rules: bad yaml') },
    })
    const out = response()
    await failing(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/reload-rules' }), out.res)
    expect(JSON.parse(out.body)).toEqual({ ok: false, error: { code: 'reload_failed', message: 'rule reload failed' } })

    const unwired = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger })
    const missing = response()
    await unwired(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/reload-rules' }), missing.res)
    expect(JSON.parse(missing.body)).toMatchObject({ ok: false, error: { code: 'reload_unavailable' } })
  })
})

describe('settings endpoint', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} }
  const value: PanelSettingsValue = {
    preset: 'balanced',
    judge: {
      enabled: false,
      scope: 'flagged',
      provider: 'liao',
      model: 'gpt-6-luna',
      maxChars: 12_000,
      timeoutMs: 4_000,
      available: true,
      configurable: true,
    },
    draft: { enabled: false, provider: '', model: '' },
    providers: [{ id: 'liao', name: 'liao', models: [{ id: 'gpt-6-luna', name: 'gpt-6-luna' }] }],
    configPath: 'C:\\Users\\x\\.dsh\\profiles\\desktop\\cordis.patch.yml',
  }
  const probe: PanelJudgeProbe = {
    status: 'ok',
    verdict: 'allow',
    blocked: false,
    route: 'liao/gpt-6-luna',
    elapsedMs: 42,
  }

  function stubSettings(saved: Record<string, unknown>[] = [], failure?: Error): PanelSettingsHost {
    return {
      judgeFact: () => ({
        enabled: value.judge.enabled,
        scope: value.judge.scope,
        provider: value.judge.provider,
        model: value.judge.model,
        available: value.judge.available,
      }),
      read: async () => value,
      save: async (patch) => {
        if (failure !== undefined) throw failure
        saved.push(patch as unknown as Record<string, unknown>)
        return value
      },
      probe: async () => probe,
    }
  }

  it('reads the judge/drafting settings and the catalog', async () => {
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger, settings: stubSettings() })
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/settings', body: { op: 'read' } }), out.res)
    expect(JSON.parse(out.body)).toMatchObject({
      ok: true,
      value: { preset: 'balanced', judge: { configurable: true, available: true }, providers: [{ id: 'liao' }] },
    })
  })

  it('saves a patch through the host settings service', async () => {
    const saved: Record<string, unknown>[] = []
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger, settings: stubSettings(saved) })
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }, {
      url: '/safeharness/settings',
      body: { op: 'save', patch: { judge: { enabled: true, model: 'gpt-6-luna' } } },
    }), out.res)
    expect(JSON.parse(out.body)).toMatchObject({ ok: true })
    expect(saved).toEqual([{ judge: { enabled: true, model: 'gpt-6-luna' } }])
  })

  it('probes the configured judge route without echoing its reply', async () => {
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger, settings: stubSettings() })
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/settings', body: { op: 'probe' } }), out.res)
    expect(JSON.parse(out.body)).toEqual({ ok: true, value: probe })
  })

  it('refuses a bad op, a non-object patch and an unwired surface', async () => {
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger, settings: stubSettings() })
    const badOp = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/settings', body: { op: 'delete' } }), badOp.res)
    expect(JSON.parse(badOp.body)).toMatchObject({ ok: false, error: { code: 'settings_invalid' } })

    const badPatch = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/settings', body: { op: 'save', patch: [] } }), badPatch.res)
    expect(JSON.parse(badPatch.body)).toMatchObject({ ok: false, error: { code: 'settings_invalid' } })

    const unwired = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger })
    const missing = response()
    await unwired(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/settings', body: { op: 'read' } }), missing.res)
    expect(JSON.parse(missing.body)).toMatchObject({ ok: false, error: { code: 'settings_unavailable' } })
  })

  it('maps a typed settings failure to its code', async () => {
    const failing = stubSettings([], new PanelSettingsError('settings_readonly', 'read only'))
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger, settings: failing })
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }, {
      url: '/safeharness/settings',
      body: { op: 'save', patch: { judge: { enabled: true } } },
    }), out.res)
    expect(JSON.parse(out.body)).toMatchObject({ ok: false, error: { code: 'settings_readonly' } })
  })
})

describe('export endpoint', () => {
  const logger = { info: () => {}, warn: () => {}, error: () => {} }

  it('returns a bounded NDJSON slice of the redacted ledger', async () => {
    const records = [
      { ts: '2026-11-12T01:00:00.000Z', seq: 1, kind: 'tool_denied', decision: 'deny', session: 'session-1' },
      { ts: '2026-11-12T01:00:01.000Z', seq: 2, kind: 'tool_executed', decision: 'ok', session: 'session-1' },
    ]
    const base = stubRuntime()
    const runtime = { ...base, ledger: { ...base.ledger, query: async () => records } } as unknown as Runtime
    const handler = createPanelHandler({ runtime, startedAt: 0, logger })
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/export', body: { limit: 2 } }), out.res)
    const envelope = JSON.parse(out.body) as { ok: boolean; value: { filename: string; count: number; content: string } }
    expect(envelope.ok).toBe(true)
    expect(envelope.value.count).toBe(2)
    expect(envelope.value.filename).toMatch(/^safeharness-ledger-.*\.ndjson$/u)
    expect(envelope.value.content.trim().split('\n')).toHaveLength(2)
    expect(envelope.value.content).not.toContain('password')
  })

  it('rejects an out-of-range limit, a bad body and a GET', async () => {
    const handler = createPanelHandler({ runtime: stubRuntime(), startedAt: 0, logger })
    const tooLarge = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/export', body: { limit: 5_000 } }), tooLarge.res)
    expect(JSON.parse(tooLarge.body)).toMatchObject({ ok: false, error: { code: 'invalid_body' } })

    const get = response()
    await handler(request({ host: '127.0.0.1:61112' }, { url: '/safeharness/export', method: 'GET' }), get.res)
    expect(JSON.parse(get.body)).toMatchObject({ ok: false, error: { code: 'method_not_allowed' } })
  })
})

describe('registerPanelRoute', () => {
  /** One route registration captured from the fake web server. */
  interface CapturedRoute {
    readonly kind: string
    readonly path: string
    readonly handler: (req: IncomingMessage, res: ServerResponse) => unknown
  }

  it('mounts one prefix route and records the outcome', () => {
    const mounted: CapturedRoute[] = []
    const probes: Record<string, unknown>[] = []
    const effects: string[] = []
    const webServer = {
      register(route: CapturedRoute) {
        mounted.push(route)
        return () => undefined
      },
    }
    const runtime = {
      ...stubRuntime(),
      audit: (_kind: string, fields: Record<string, unknown>) => { probes.push(fields) },
    } as unknown as Runtime
    const ctx = {
      inject(deps: string[], callback: (child: unknown) => void) {
        expect(deps).toEqual(['webServer'])
        callback({
          get: () => webServer,
          effect(execute: () => (() => void) | undefined, label: string) {
            effects.push(label)
            dispose = execute() ?? (() => undefined)
            return () => Promise.resolve()
          },
        })
        return () => undefined
      },
    }
    let dispose: () => void = () => undefined
    registerPanelRoute(ctx as unknown as never, { runtime, startedAt: Date.now(), logger: { info: () => {}, warn: () => {}, error: () => {} } })
    expect(mounted).toHaveLength(1)
    expect(mounted[0]?.kind).toBe('prefix')
    expect(mounted[0]?.path).toBe('/safeharness')
    expect(effects).toEqual(['safeharness: panel route'])
    expect(probes).toContainEqual(expect.objectContaining({
      decision: 'info',
      labels: { state: 'route_registered' },
    }))
    expect(typeof dispose).toBe('function')
  })

  it('records a profile without the carrier instead of failing the load', () => {
    const probes: Record<string, unknown>[] = []
    const runtime = {
      ...stubRuntime(),
      audit: (_kind: string, fields: Record<string, unknown>) => { probes.push(fields) },
    } as unknown as Runtime
    const ctx = {
      inject(_deps: string[], callback: (child: unknown) => void) {
        callback({ get: () => undefined })
        return () => undefined
      },
    }
    registerPanelRoute(ctx as unknown as never, { runtime, startedAt: 0, logger: { info: () => {}, warn: () => {}, error: () => {} } })
    expect(probes).toContainEqual(expect.objectContaining({ labels: { state: 'web_server_unavailable' } }))
  })
})
