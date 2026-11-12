/**
 * Posture report assembly: gathers the observable environment, runs the checks,
 * records the report in the ledger and (for hardened configs) enforces
 * `posture.failOn` by refusing plugin load (§6.9).
 * @module
 */
import type { PostureEnv, PostureFinding } from '../engine/types.js'
import type { Runtime } from '../runtime.js'
import type { ResolvedConfig } from '../config.js'
import { failOnHits, runPostureChecks, summarize, type PostureSummary } from './checks.js'
import { VERSION } from '../version.js'

/** Environment sources the report needs; each probe may return `undefined`. */
export interface PostureProbe {
  sandboxMode?(): 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
  approvalPolicy?(): 'ask' | 'never' | undefined
  hmrEnabled?(): boolean | undefined
  /** DSH package versions that disagree with our pinned peers (empty = match). */
  versionMismatch?(): readonly string[]
  /** Configured input engine and its live status. */
  engine?(): PostureEnv['engine']
}

/** One completed posture report. */
export interface PostureReport {
  readonly ranAt: string
  readonly findings: readonly PostureFinding[]
  readonly summary: PostureSummary
}

/** Collect the environment with every probe guarded (a bad probe is SKIP, not a crash). */
async function collectEnv(runtime: Runtime, probe: PostureProbe): Promise<PostureEnv> {
  const safe = <T>(what: string, fn: (() => T | undefined) | undefined): T | undefined => {
    if (fn === undefined) return undefined
    try {
      return fn()
    } catch (error) {
      runtime.internalError(`posture:${what}`, error)
      return undefined
    }
  }

  const ledgerStats = runtime.ledger.stats
  let chainOk = true
  try {
    // Verification is bounded: the last few hundred records are enough to prove
    // the chain is intact without reading a 64 MB file.
    const verification = await runtime.ledger.verifyChain(200)
    chainOk = verification.ok
  } catch (error) {
    runtime.internalError('posture:ledger_chain', error)
    chainOk = false
  }

  const env: PostureEnv = {
    sandboxMode: safe('sandbox', probe.sandboxMode),
    approvalPolicy: safe('approval', probe.approvalPolicy),
    hmrEnabled: safe('hmr', probe.hmrEnabled),
    versionMismatch: safe('version', probe.versionMismatch),
    engine: safe('engine', probe.engine),
    rules: {
      loaded: true,
      hash: runtime.engine.rulesetHash,
      ruleCount: runtime.engine.ruleCount,
    },
    ledger: {
      writable: ledgerStats.writable && ledgerStats.enabled,
      chainOk,
      ...(ledgerStats.lastWriteAt === undefined ? {} : { lastWriteAt: ledgerStats.lastWriteAt }),
    },
  }
  return env
}

/** Run one posture report and record it. */
export async function runPosture(runtime: Runtime, probe: PostureProbe): Promise<PostureReport> {
  const env = await collectEnv(runtime, probe)
  const findings = runPostureChecks(runtime.config, env)
  const summary = summarize(findings)
  const report: PostureReport = { ranAt: new Date().toISOString(), findings, summary }
  runtime.audit('posture_report', {
    decision: summary.clean ? 'ok' : summary.fail > 0 ? 'fail' : 'warn',
    rule_ids: findings.filter((item) => item.severity !== 'OK').map((item) => item.code),
    metrics: { fail: summary.fail, warn: summary.warn, ok: summary.ok, skip: summary.skip },
    labels: { plugin_version: VERSION },
  })
  return report
}

/**
 * Run the load-time posture gate.
 *
 * @param runtime - shared runtime (the report lands in the ledger).
 * @param probe - environment probes.
 * @param config - resolved config carrying `posture.failOn`.
 * @throws Error naming the offending codes when a `failOn` code FAILed; this
 *   propagates out of `apply()` and refuses plugin load (fail-closed).
 */
export async function enforceLoadTimePosture(
  runtime: Runtime,
  probe: PostureProbe,
  config: ResolvedConfig,
): Promise<PostureReport> {
  const report = await runPosture(runtime, probe)
  const hits = failOnHits(config, report.findings)
  if (hits.length > 0) {
    throw new Error(`safeharness: refusing to load: posture gate failed on ${hits.join(', ')}`)
  }
  return report
}
