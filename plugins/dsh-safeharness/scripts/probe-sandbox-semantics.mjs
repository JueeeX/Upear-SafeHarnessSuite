/**
 * Real-machine semantics check for the P0 fix.
 *
 * The fix rests on one host fact: `sandboxPolicy.resolve({ session })` folds that
 * session's own `sandbox/mode` events over the deployment default, while a
 * session-less `resolve()` returns only the default. This script drives the
 * ACTUAL installed `@deepseek-ai/dsh-sandbox-policy` service (from the plugin's
 * node_modules) on a real Cordis context, so the claim is measured against the
 * host's code rather than against my reading of it.
 */
import { Context } from '@deepseek-ai/cordis'

let SandboxPolicyService
try {
  ({ SandboxPolicyService } = await import('@deepseek-ai/dsh-sandbox-policy'))
} catch {
  console.error('skip: @deepseek-ai/dsh-sandbox-policy is not installed next to this package')
  console.error('      (it is a host package, not a dependency of this plugin: run this where a DSH profile is linked)')
  process.exit(0)
}

/** A fake session shape: `header.cwd` + an event log, which is all `resolve` reads. */
function fakeSession(id, events, cwd = process.cwd()) {
  return { id, header: { cwd }, events }
}

const ctx = new Context()
const service = new SandboxPolicyService(ctx, { mode: 'workspace-write', workspaceRoot: process.cwd() })

const cases = [
  ['deployment default only', fakeSession('s-plain', [])],
  ['session switched to danger-full-access', fakeSession('s-open', [
    { type: 'turn/start', seq: 1, time: 1, data: {} },
    { type: 'sandbox/mode', seq: 2, time: 2, data: { mode: 'danger-full-access' } },
  ])],
  ['switch, then switch back to read-only', fakeSession('s-back', [
    { type: 'sandbox/mode', seq: 1, time: 1, data: { mode: 'danger-full-access' } },
    { type: 'sandbox/mode', seq: 2, time: 2, data: { mode: 'read-only' } },
  ])],
]

console.log('--- session-less resolve() ---')
console.log('  ', JSON.stringify(service.resolve().mode), '(this is all 1.16.1 ever asked)')
console.log('--- resolve({}) — literally what 1.16.1 passed ---')
console.log('  ', JSON.stringify(service.resolve({}).mode))

console.log('--- resolve({ session }) — what 1.16.2 asks ---')
for (const [label, session] of cases) {
  console.log('  ', label, '=>', JSON.stringify(service.resolve({ session }).mode))
}

console.log('--- overrideOf(session), without the default ---')
for (const [label, session] of cases) {
  console.log('  ', label, '=>', JSON.stringify(service.overrideOf(session)))
}
