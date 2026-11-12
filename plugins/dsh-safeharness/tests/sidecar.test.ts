/**
 * M5 T5.1 (step 1): the sidecar *transport*.
 *
 * No Python here and no engine semantics: the fake child speaks the same envelope,
 * so these tests are about the boundary itself — correlation, deadlines, fail-closed
 * teardown, and the rule that a failure never echoes prompt text or stderr.
 * @module
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Sidecar, SidecarError } from '../src/engine/sidecar.js'

const FAKE = fileURLToPath(new URL('./helpers/fake-sidecar.mjs', import.meta.url))

/** Start a transport over the fake child. */
async function started(overrides: { timeoutMs?: number; startTimeoutMs?: number; args?: string[] } = {}): Promise<Sidecar> {
  const sidecar = new Sidecar({
    command: process.execPath,
    args: overrides.args ?? [FAKE],
    timeoutMs: overrides.timeoutMs ?? 1000,
    startTimeoutMs: overrides.startTimeoutMs ?? 5000,
  })
  await sidecar.start()
  return sidecar
}

/** Await a rejection and return the SidecarError code. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SidecarError)
    return (error as SidecarError).code
  }
  throw new Error('expected the call to reject')
}

describe('sidecar transport: handshake and round trips', () => {
  it('starts, answers health and reports a pid', async () => {
    const sidecar = await started()
    try {
      expect(sidecar.status).toBe('ready')
      expect(typeof sidecar.pid).toBe('number')
      const health = await sidecar.request<{ ok: boolean; engine: string }>('health')
      expect(health.ok).toBe(true)
      expect(health.engine).toBe('fake')
      // The non-JSON banner is counted, not fatal.
      expect(sidecar.stats.badLines).toBe(1)
    } finally {
      await sidecar.stop()
    }
  })

  it('preserves parameters through a round trip', async () => {
    const sidecar = await started()
    try {
      const echoed = await sidecar.request<{ text: string; n: number }>('echo', { text: 'abc', n: 3 })
      expect(echoed).toEqual({ text: 'abc', n: 3 })
    } finally {
      await sidecar.stop()
    }
  })

  it('correlates concurrent requests by id', async () => {
    const sidecar = await started()
    try {
      const results = await Promise.all([
        sidecar.request<{ i: number }>('echo', { i: 1 }),
        sidecar.request<{ i: number }>('echo', { i: 2 }),
        sidecar.request<{ i: number }>('echo', { i: 3 }),
      ])
      expect(results.map((item) => item.i)).toEqual([1, 2, 3])
    } finally {
      await sidecar.stop()
    }
  })
})

describe('sidecar transport: fail-closed edges', () => {
  it('maps an error envelope to its coarse code without echoing the payload', async () => {
    const sidecar = await started()
    try {
      const code = await codeOf(sidecar.request('fail', { secret: 'SENTINEL-PAYLOAD' }))
      expect(code).toBe('bad_input')
      // The message is fixed text: no payload, no stderr.
      const error = await sidecar.request('fail', { secret: 'SENTINEL-PAYLOAD' }).catch((cause: unknown) => cause)
      expect(String(error)).not.toContain('SENTINEL-PAYLOAD')
    } finally {
      await sidecar.stop()
    }
  })

  it('times out and keeps the process usable afterwards', async () => {
    const sidecar = await started()
    try {
      const code = await codeOf(sidecar.request('slow', {}, 120))
      expect(code).toBe('sidecar_timeout')
      const echoed = await sidecar.request<{ ok: boolean }>('echo', { ok: true })
      expect(echoed).toEqual({ ok: true })
    } finally {
      await sidecar.stop()
    }
  })

  it('fails in-flight and future calls when the child dies', async () => {
    const sidecar = await started()
    try {
      const crashed = sidecar.request('crash')
      const code = await codeOf(crashed)
      expect(['sidecar_exited', 'sidecar_not_ready']).toContain(code)
      const later = await codeOf(sidecar.request('echo', { a: 1 }))
      expect(['sidecar_exited', 'sidecar_not_ready']).toContain(later)
      expect(sidecar.status).toBe('failed')
    } finally {
      await sidecar.stop()
    }
  })

  it('tolerates a non-envelope line in the middle of the stream', async () => {
    const sidecar = await started()
    try {
      const value = await sidecar.request('junk')
      expect(value).toBe('after-junk')
      expect(sidecar.stats.badLines).toBe(2)
    } finally {
      await sidecar.stop()
    }
  })

  it('refuses to start a binary that does not exist', async () => {
    const sidecar = new Sidecar({
      command: 'safeharness-definitely-not-a-real-binary',
      args: [],
      timeoutMs: 500,
      startTimeoutMs: 2000,
    })
    const code = await codeOf(sidecar.start())
    expect(['sidecar_spawn_failed', 'sidecar_unavailable']).toContain(code)
    expect(sidecar.status).toBe('failed')
  })

  it('rejects every call after stop', async () => {
    const sidecar = await started()
    await sidecar.stop()
    expect(sidecar.status).toBe('stopped')
    expect(await codeOf(sidecar.request('echo'))).toBe('sidecar_stopped')
  })
})

describe('sidecar transport: resource bounds', () => {
  it('refuses more concurrent requests than the cap instead of queueing without bound', async () => {
    const sidecar = new Sidecar({
      command: process.execPath,
      args: [FAKE],
      timeoutMs: 1000,
      startTimeoutMs: 5000,
      maxPending: 1,
    })
    await sidecar.start()
    try {
      const inFlight = sidecar.request('slow').catch((error: unknown) => error)
      const code = await codeOf(sidecar.request('echo', { a: 1 }))
      expect(code).toBe('sidecar_overloaded')
      // The in-flight call is unaffected by the rejection of the extra one.
      expect(await inFlight).toBeInstanceOf(SidecarError)
    } finally {
      await sidecar.stop()
    }
  })

  it('kills a child that streams an unterminated line past the cap', async () => {
    const sidecar = new Sidecar({
      command: process.execPath,
      args: [FAKE, '--mode', 'flood'],
      timeoutMs: 1000,
      startTimeoutMs: 5000,
      maxLineBytes: 4096,
    })
    const code = await codeOf(sidecar.start())
    expect(code).toBe('sidecar_unavailable')
    expect(sidecar.status).toBe('failed')
  })

  it('accepts CRLF-terminated frames', async () => {
    const sidecar = await started({ args: [FAKE, '--mode', 'crlf'] })
    try {
      expect(await sidecar.request('echo', { crlf: true })).toEqual({ crlf: true })
      expect(sidecar.stats.badLines).toBe(1)
    } finally {
      await sidecar.stop()
    }
  })

  it('can start again after a failed handshake (a previous child cannot poison it)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'safeharness-sidecar-'))
    const modeFile = join(dir, 'mode')
    writeFileSync(modeFile, 'no-health', 'utf8')
    const sidecar = new Sidecar({
      command: process.execPath,
      args: [FAKE, '--mode-file', modeFile],
      timeoutMs: 1000,
      startTimeoutMs: 300,
    })
    try {
      expect(await codeOf(sidecar.start())).toBe('sidecar_unavailable')
      expect(sidecar.status).toBe('failed')
      // Let the dead child's exit event settle before retrying: the generation guard
      // is what keeps that late event from failing the new handshake.
      await new Promise((resolve) => setTimeout(resolve, 150))
      writeFileSync(modeFile, 'normal', 'utf8')
      await sidecar.start()
      expect(sidecar.status).toBe('ready')
      const health = await sidecar.request<{ ok: boolean }>('health')
      expect(health.ok).toBe(true)
    } finally {
      await sidecar.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
