/**
 * Replay a REAL session log through the fixed posture path.
 *
 * Why: the P0 fix cannot be verified by restarting the desktop app from inside a
 * session (that would kill the session being fixed). But everything the fix
 * depends on is in the session log — the `sandbox/mode` event and the header cwd —
 * so the honest test is to rebuild that session's shape from its own log, hand it
 * to the host's real `SandboxPolicyService`, and run the plugin's real
 * `resolveSandboxMode` / `observeSessionSandbox` / `observeSandbox` over it.
 *
 * Usage: node scripts/replay-sandbox-posture.mjs <session-dir>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** Split one buffer into concatenated zstd frames by scanning for the magic. */
function frames(buffer) {
  const offsets = []
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(index) === ZSTD_MAGIC) offsets.push(index)
  }
  const out = []
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index]
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length
    try {
      out.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch {
      // A false-positive magic match inside compressed data: skip it.
    }
  }
  return out
}

/** Rebuild the session-shaped value DSH hands to `sandboxPolicy.resolve`. */
function sessionFromLog(dir) {
  const file = statSync(dir).isDirectory()
    ? join(dir, readdirSync(dir).find((name) => name.endsWith('.zstd')) ?? '')
    : dir
  const text = frames(readFileSync(file)).map((chunk) => chunk.toString('utf8')).join('\n')
  const events = []
  let header = undefined
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed.type === 'session' && header === undefined) {
      header = parsed
      continue
    }
    events.push(parsed)
  }
  if (header === undefined) throw new Error('no session header in the log')
  return { id: header.id, header: { cwd: header.cwd, createdAt: header.createdAt }, events }
}

const dir = process.argv[2]
if (dir === undefined) {
  console.error('usage: node scripts/replay-sandbox-posture.mjs <session-dir>')
  process.exit(2)
}

const session = sessionFromLog(dir)
const switches = session.events.filter((event) => event.type === 'sandbox/mode')
console.log(`session ${session.id}`)
console.log(`  cwd       : ${session.header.cwd}`)
console.log(`  events    : ${session.events.length}`)
console.log(`  sandbox/mode events: ${switches.length} → ${JSON.stringify(switches.map((event) => event.data?.mode ?? null))}`)

const { Context } = await import('@deepseek-ai/cordis')
const { SandboxPolicyService } = await import('@deepseek-ai/dsh-sandbox-policy')
/**
 * The deployment default the desktop profile actually carries
 * (`permission.presets.defaultPreset: danger-full-access` in cordis.patch.yml).
 * The interesting question is not what the default is, but whether a session's
 * own log changes the answer — so both defaults are exercised below.
 */
const build = (defaultMode) => {
  const ctx = new Context()
  return new SandboxPolicyService(ctx, { mode: defaultMode, workspaceRoot: session.header.cwd })
}

const { resolveSandboxMode } = await import('../lib/hooks/sandbox.js')

console.log('\n--- what 1.16.1 asked (session-less) vs what 1.16.2 asks (with the session) ---')
for (const defaultMode of ['workspace-write', 'danger-full-access']) {
  const service = build(defaultMode)
  const ctx = { get: (name) => (name === 'sandboxPolicy' ? service : undefined) }
  const legacy = service.resolve({}).mode
  const fixed = resolveSandboxMode(ctx, session)
  console.log(`  default ${defaultMode.padEnd(18)} legacy=${String(legacy).padEnd(18)} fixed=${fixed}`)
}

console.log('\n--- the posture verdict this session would now produce ---')
{
  const service = build('workspace-write')
  const ctx = { get: (name) => (name === 'sandboxPolicy' ? service : undefined) }
  const { createRuntime } = await import('../lib/runtime.js')
  const { createEngine } = await import('../lib/engine/index.js')
  const { loadRuleSet } = await import('../lib/engine/rules.js')
  const { createLedger } = await import('../lib/audit/ledger.js')
  const { resolveConfig } = await import('../lib/config.js')
  const { observeSandbox, observeSessionSandbox } = await import('../lib/hooks/sandbox.js')
  const { runPostureChecks } = await import('../lib/posture/checks.js')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')

  const config = resolveConfig({ preset: 'balanced' })
  const ruleset = loadRuleSet({ packagedRulesDir: join(process.cwd(), 'rules') })
  const runtime = createRuntime({
    config,
    engine: createEngine(ruleset, config),
    ledger: createLedger({
      dir: mkdtempSync(join(tmpdir(), 'safeharness-replay-')),
      format: 'ndjson', redact: true, hashChain: true, required: false,
      rotateMb: 64, pluginVersion: 'replay', rulesetHash: ruleset.hash,
    }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })

  observeSessionSandbox(runtime, ctx, session)
  const observation = observeSandbox(ctx, runtime)
  console.log('  observation:', JSON.stringify(observation))
  // The observation is what posture consumes; print the finding it produces.
  const withSandbox = runPostureChecks(config, {
    sandbox: observation,
    rules: { loaded: true, hash: ruleset.hash, ruleCount: ruleset.ruleCount },
  }).find((item) => item.code === 'sandbox_danger_full_access')
  console.log(`  finding   : ${withSandbox?.severity} — ${withSandbox?.detail}`)
}
