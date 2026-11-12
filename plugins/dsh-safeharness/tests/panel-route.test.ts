/**
 * The panel route (T5.3): the browser fence, the response envelope, and the
 * registration outcome the ledger records.
 *
 * The fence is the security-relevant half: the route is mounted on the same
 * HTTP carrier as the GUI, so it must answer only same-origin loopback calls.
 * These tests pin the three questions the shared `/api` fence asks.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createPanelHandler, isTrustedPanelRequest, registerPanelRoute } from '../src/panel/route.js'
import type { Runtime } from '../src/runtime.js'

/** One request's headers, cast to the Node shape the fence reads. */
function request(headers: Record<string, string>, options: { method?: string; url?: string } = {}): IncomingMessage {
  return { headers, method: options.method ?? 'POST', url: options.url ?? '/safeharness/status' } as unknown as IncomingMessage
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
function stubRuntime(options: { stateThrows?: boolean } = {}): Runtime {
  return {
    config: {
      preset: 'balanced',
      input: { mode: 'enforce' },
      tools: { mode: 'enforce' },
      results: { mode: 'warn' },
      output: { mode: 'warn' },
      approval: { mode: 'delegate' },
    },
    engine: { rulesetHash: 'b'.repeat(64), ruleCount: 20, chainCount: 3 },
    ledger: {
      stats: { enabled: true, writable: true, records: 1, failures: 0, lastWriteAt: 5 },
      query: async () => [],
    },
    get state(): { size: number } {
      if (options.stateThrows === true) throw new Error('state exploded')
      return { size: 0 }
    },
    counters: { allow: 0, warn: 0, deny: 0, ask: 0, auditBlocked: 0, internalErrors: 0 },
    internalError: () => undefined,
  } as unknown as Runtime
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
  const options = { runtime: stubRuntime(), startedAt: Date.now(), logger: { info: () => {}, warn: () => {}, error: () => {} } }

  it('serves the payload envelope for the status endpoint', async () => {
    const handler = createPanelHandler(options)
    const out = response()
    await handler(request({ host: '127.0.0.1:61112' }), out.res)
    expect(out.status).toBe(200)
    expect(out.headers['cache-control']).toBe('no-store')
    const envelope = JSON.parse(out.body) as { ok: boolean; value: { preset: string } }
    expect(envelope.ok).toBe(true)
    expect(envelope.value.preset).toBe('balanced')
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
    registerPanelRoute(ctx as unknown as never, {
      runtime,
      startedAt: Date.now(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    expect(mounted).toHaveLength(1)
    expect(mounted[0]?.kind).toBe('prefix')
    expect(mounted[0]?.path).toBe('/safeharness')
    expect(effects).toEqual(['safeharness: panel route'])
    expect(probes).toContainEqual(expect.objectContaining({
      reason_code: 'panel_route',
      labels: { state: 'route_registered' },
    }))
    dispose()
  })

  it('records a profile without the carrier instead of failing the load', () => {
    const probes: Record<string, unknown>[] = []
    const runtime = {
      ...stubRuntime(),
      audit: (_kind: string, fields: Record<string, unknown>) => { probes.push(fields) },
    } as unknown as Runtime
    // The inject callback never runs when the service is absent.
    const ctx = { inject: () => () => undefined }
    registerPanelRoute(ctx as unknown as never, {
      runtime,
      startedAt: Date.now(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    expect(probes).toEqual([])
  })
})
