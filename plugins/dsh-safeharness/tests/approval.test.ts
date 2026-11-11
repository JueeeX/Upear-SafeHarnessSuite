/**
 * Approval bridge tests (T3.3, §6.7).
 *
 * The bridge is driven through the fake host's waterfall: `host.emit('approval/request',
 * request, next)` runs the plugin listener with a controllable answerer, which is
 * exactly the shape a host installs. What matters here is the coarse-policy
 * contract: one grant per session, deny what the tool surface already denies,
 * delegate the rest — and never auto-approve on a bug.
 * @module
 */
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { createFakeHost, readLedger } from './helpers/fake-host.js'
import { installApprovalHook } from '../src/hooks/approval.js'
import type { Runtime } from '../src/runtime.js'
import type { SafeHarnessConfig } from '../src/config.js'

/** One approval request as the host builds it (only these fields exist). */
interface RequestLike {
  toolName: string
  agent?: { session?: { id?: string } }
  callId?: string
  reason?: string
}

/** Build a host with the bridge installed and one canned answerer. */
function setup(
  config: SafeHarnessConfig,
  answer: (request: RequestLike) => ApprovalOutcome | Promise<ApprovalOutcome> = () => 'rejected',
): { host: ReturnType<typeof createFakeHost>['host']; runtime: Runtime; answerer: ReturnType<typeof vi.fn> } {
  const { host, runtime } = createFakeHost({ config })
  const answerer = vi.fn(async (request: RequestLike) => answer(request))
  expect(installApprovalHook(host.ctx as never, runtime)).toBe(true)
  return { host, runtime, answerer }
}

/** Ask one approval through the bridge and return the outcome. */
async function ask(
  host: ReturnType<typeof createFakeHost>['host'],
  answerer: (request: RequestLike) => Promise<ApprovalOutcome>,
  request: RequestLike,
): Promise<ApprovalOutcome> {
  return await host.emit('approval/request', request, () => answerer(request)) as ApprovalOutcome
}

/** Every ledger record (oldest first). */
async function records(runtime: Runtime): Promise<Record<string, unknown>[]> {
  return await readLedger(runtime) as Record<string, unknown>[]
}

describe('approval bridge — delegate mode', () => {
  it('passes the request to the real answerer untouched and records the pair', async () => {
    const { host, runtime, answerer } = setup({ preset: 'balanced' })
    answerer.mockResolvedValueOnce('allowed-once')
    const outcome = await ask(host, answerer, { toolName: 'bash', agent: { session: { id: 's1' } } })
    expect(outcome).toBe('allowed-once')
    expect(answerer).toHaveBeenCalledTimes(1)
    const ledger = await records(runtime)
    const asked = ledger.find((record) => record.kind === 'approval_asked')
    const decided = ledger.find((record) => record.kind === 'approval_decided')
    expect(asked?.labels).toMatchObject({ source: 'delegate' })
    expect(decided?.decision).toBe('allowed-once')
    expect(decided?.labels).toMatchObject({ source: 'delegate' })
    expect(decided?.tool).toBe('bash')
    expect(decided?.session).toBe('s1')
  })

  it('never overrides a denial in delegate mode', async () => {
    const { host, runtime } = setup({ preset: 'balanced', approval: { mode: 'delegate', allowOnce: ['bash'] } })
    const answerer = vi.fn(async () => 'rejected' as ApprovalOutcome)
    const outcome = await ask(host, answerer, { toolName: 'bash' })
    expect(outcome).toBe('rejected')
    expect(answerer).toHaveBeenCalledTimes(1)
    expect((await records(runtime)).find((record) => record.kind === 'approval_decided')?.decision).toBe('rejected')
  })
})

describe('approval bridge — policy mode', () => {
  const policy = (extra: Partial<SafeHarnessConfig> = {}): SafeHarnessConfig => ({
    preset: 'hardened',
    approval: { mode: 'policy', allowOnce: ['safeharness_*'] },
    ...extra,
  })

  it('grants a configured tool exactly once per session', async () => {
    const { host, runtime } = setup(policy())
    const answerer = vi.fn(async () => 'rejected' as ApprovalOutcome)
    const first = await ask(host, answerer, { toolName: 'safeharness_posture', agent: { session: { id: 's1' } } })
    expect(first).toBe('allowed-once')
    expect(answerer).not.toHaveBeenCalled()
    // Second ask in the same session falls through to the human.
    const second = await ask(host, answerer, { toolName: 'safeharness_posture', agent: { session: { id: 's1' } } })
    expect(second).toBe('rejected')
    expect(answerer).toHaveBeenCalledTimes(1)
    const ledger = await records(runtime)
    expect(ledger.filter((record) => record.kind === 'approval_decided').map((record) => record.decision))
      .toEqual(['allowed-once', 'rejected'])
  })

  it('grants again in a different session', async () => {
    const { host } = setup(policy())
    const answerer = vi.fn(async () => 'rejected' as ApprovalOutcome)
    expect(await ask(host, answerer, { toolName: 'safeharness_status', agent: { session: { id: 'a' } } })).toBe('allowed-once')
    expect(await ask(host, answerer, { toolName: 'safeharness_status', agent: { session: { id: 'b' } } })).toBe('allowed-once')
    expect(answerer).not.toHaveBeenCalled()
  })

  it('rejects a tool the tool surface already denies by name', async () => {
    const { host } = setup(policy({ tools: { denyTools: ['bash*'] } }))
    const answerer = vi.fn(async () => 'allowed-once' as ApprovalOutcome)
    expect(await ask(host, answerer, { toolName: 'bash' })).toBe('rejected')
    expect(answerer).not.toHaveBeenCalled()
  })

  it('rejects a tool denied by semantic tag', async () => {
    const { host } = setup(policy({ tools: { denyTags: ['shell'] } }))
    const answerer = vi.fn(async () => 'allowed-once' as ApprovalOutcome)
    // `bash` carries the built-in `shell` tag.
    expect(await ask(host, answerer, { toolName: 'bash' })).toBe('rejected')
    expect(answerer).not.toHaveBeenCalled()
  })

  it('delegates a tool the policy does not classify', async () => {
    const { host } = setup(policy())
    const answerer = vi.fn(async () => 'cancelled' as ApprovalOutcome)
    expect(await ask(host, answerer, { toolName: 'web_fetch' })).toBe('cancelled')
    expect(answerer).toHaveBeenCalledTimes(1)
  })

  it('gives a configured grant precedence over the deny list and documents it', async () => {
    const { host } = setup(policy({ approval: { mode: 'policy', allowOnce: ['bash'] }, tools: { denyTools: ['bash'] } }))
    const answerer = vi.fn(async () => 'rejected' as ApprovalOutcome)
    // §6.7 lists allowOnce first; the ordering is deliberate (operator intent) and
    // locked here so a refactor cannot silently invert it.
    expect(await ask(host, answerer, { toolName: 'bash' })).toBe('allowed-once')
  })

  it('keeps the asker reason out of the ledger', async () => {
    const { host, runtime } = setup(policy())
    const secret = 'reason mentions sk-SENTINEL-0123456789 and /etc/passwd'
    await ask(host, () => Promise.resolve('rejected'), { toolName: 'web_fetch', reason: secret })
    const ledger = await records(runtime)
    expect(JSON.stringify(ledger)).not.toContain('SENTINEL')
    expect(JSON.stringify(ledger)).not.toContain('/etc/passwd')
    const decided = ledger.find((record) => record.kind === 'approval_decided')
    expect(decided?.detail_chars).toBe(secret.length)
  })

  it('audits an unknown tool name safely', async () => {
    const { host, runtime } = setup(policy())
    const answerer = vi.fn(async () => 'rejected' as ApprovalOutcome)
    expect(await ask(host, answerer, {} as RequestLike)).toBe('rejected')
    expect((await records(runtime)).find((record) => record.kind === 'approval_asked')?.tool).toBe('unknown')
  })

  it('delegates instead of granting when the answerer fails', async () => {
    const { host, runtime } = setup(policy())
    // First call throws, the delegated retry answers.
    let calls = 0
    const fallback = async (): Promise<ApprovalOutcome> => {
      calls += 1
      if (calls === 1) throw new Error('answerer exploded')
      return 'rejected'
    }
    const outcome = await host.emit('approval/request', { toolName: 'web_fetch' }, fallback) as ApprovalOutcome
    expect(outcome).toBe('rejected')
    expect((await records(runtime)).some((record) => record.reason_code === 'internal_error')).toBe(true)
  })

  it('returns unavailable rather than allowing when the delegated answerer also fails', async () => {
    const { host, runtime } = setup(policy())
    const failing = async (): Promise<ApprovalOutcome> => { throw new Error('always broken') }
    // The listener catches the first failure and retries once; a second failure must
    // surface as `unavailable` (the tool layer turns that into a deny, never a grant).
    const outcome = await host.emit('approval/request', { toolName: 'web_fetch' }, failing) as ApprovalOutcome
    expect(outcome).toBe('unavailable')
    expect((await records(runtime)).some((record) => record.reason_code === 'internal_error')).toBe(true)
  })
})
