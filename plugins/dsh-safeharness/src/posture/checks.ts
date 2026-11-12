/**
 * Deployment posture checks (plan §6.9). Each check is a pure function of the
 * observed environment plus our own config; none of them print a value that
 * could be a secret (modes, codes, counts only).
 * @module
 */
import type { ResolvedConfig } from '../config.js'
import type { PostureEnv, PostureFinding, PostureSeverity } from '../engine/types.js'

/** Every posture code this version can emit; `posture.failOn` matches these. */
export const POSTURE_CODES = [
  'sandbox_danger_full_access',
  'approval_never',
  'hmr_enabled',
  'rules_loaded',
  'ledger_writable',
  'ledger_chain_ok',
  'output_guard_off',
  'judge_unavailable',
  'plugin_version_mismatch',
  'engine_sidecar_unavailable',
] as const

/** One known posture code. */
export type PostureCode = (typeof POSTURE_CODES)[number]

/** Hours after which "no ledger write" becomes a warning. */
const LEDGER_STALE_HOURS = 24

/** Build a finding. */
function finding(code: PostureCode, severity: PostureSeverity, detail: string): PostureFinding {
  return { code, severity, detail }
}

/**
 * Run every posture check.
 *
 * @param config - resolved config (the checks care about preset, modes and failOn).
 * @param env - observed environment; absent observations degrade to SKIP, never to OK.
 * @returns findings in {@link POSTURE_CODES} order.
 */
export function runPostureChecks(config: ResolvedConfig, env: PostureEnv): PostureFinding[] {
  const hardened = config.preset === 'hardened'
  const findings: PostureFinding[] = []

  // --- sandbox -----------------------------------------------------------------
  if (env.sandboxMode === undefined) {
    findings.push(finding('sandbox_danger_full_access', 'SKIP', 'sandbox policy service not composed; mode unknown'))
  } else if (env.sandboxMode === 'danger-full-access') {
    findings.push(finding(
      'sandbox_danger_full_access',
      hardened ? 'FAIL' : 'WARN',
      'sandbox mode is danger-full-access: the file sandbox is disabled for this session',
    ))
  } else {
    findings.push(finding('sandbox_danger_full_access', 'OK', `sandbox mode is ${env.sandboxMode}`))
  }

  // --- approval ----------------------------------------------------------------
  if (env.approvalPolicy === undefined) {
    findings.push(finding('approval_never', 'SKIP', 'approval policy not resolvable without a session; re-run with an active session'))
  } else if (env.approvalPolicy === 'never' && config.approval.mode === 'delegate') {
    findings.push(finding(
      'approval_never',
      hardened ? 'FAIL' : 'WARN',
      'approval policy is never while the bridge delegates: no human gate can stop an ask',
    ))
  } else {
    findings.push(finding('approval_never', 'OK', `approval policy is ${env.approvalPolicy}`))
  }

  // --- HMR ---------------------------------------------------------------------
  if (env.hmrEnabled === undefined) {
    findings.push(finding('hmr_enabled', 'SKIP', 'loader entries not readable; HMR state unknown'))
  } else if (env.hmrEnabled) {
    findings.push(finding(
      'hmr_enabled',
      hardened ? 'WARN' : 'OK',
      'hot-module reload is enabled: a reload briefly drops every guard listener (close it for hardened deployments)',
    ))
  } else {
    findings.push(finding('hmr_enabled', 'OK', 'HMR not composed'))
  }

  // --- rules -------------------------------------------------------------------
  if (env.rules === undefined || !env.rules.loaded) {
    findings.push(finding('rules_loaded', 'FAIL', 'no rule set is loaded; every detection surface is inert'))
  } else {
    findings.push(finding(
      'rules_loaded',
      'OK',
      `${env.rules.ruleCount} rule(s) loaded (ruleset ${env.rules.hash.slice(0, 12)})`,
    ))
  }

  // --- ledger writability ------------------------------------------------------
  if (env.ledger === undefined) {
    findings.push(finding('ledger_writable', 'SKIP', 'ledger not probed'))
  } else if (!env.ledger.writable) {
    findings.push(finding('ledger_writable', 'FAIL', 'the audit ledger is not writable; evidence cannot be recorded'))
  } else {
    const last = env.ledger.lastWriteAt
    if (last !== undefined && Date.now() - last > LEDGER_STALE_HOURS * 3600 * 1000) {
      findings.push(finding('ledger_writable', 'WARN', `no ledger write in the last ${LEDGER_STALE_HOURS}h`))
    } else {
      findings.push(finding('ledger_writable', 'OK', 'ledger writable'))
    }
  }

  // --- ledger chain ------------------------------------------------------------
  if (env.ledger === undefined) {
    findings.push(finding('ledger_chain_ok', 'SKIP', 'ledger not probed'))
  } else if (!env.ledger.chainOk) {
    findings.push(finding(
      'ledger_chain_ok',
      hardened ? 'FAIL' : 'WARN',
      'the audit hash chain does not verify; the ledger was modified or truncated',
    ))
  } else {
    findings.push(finding('ledger_chain_ok', 'OK', 'ledger hash chain verifies'))
  }

  // --- output guard ------------------------------------------------------------
  if (hardened && config.output.mode === 'off') {
    findings.push(finding('output_guard_off', 'FAIL', 'hardened deployment has the output guard switched off'))
  } else {
    findings.push(finding('output_guard_off', 'OK', `output mode is ${config.output.mode}`))
  }

  // --- judge -------------------------------------------------------------------
  if (config.output.judge.enabled && (config.output.judge.provider === '' || config.output.judge.model === '')) {
    findings.push(finding(
      'judge_unavailable',
      hardened ? 'FAIL' : 'WARN',
      'the semantic judge is enabled but provider/model is empty; output review degrades to regex-only',
    ))
  } else {
    findings.push(finding('judge_unavailable', 'OK', config.output.judge.enabled ? 'judge configured' : 'judge disabled'))
  }

  // --- version mismatch --------------------------------------------------------
  if (env.versionMismatch !== undefined && env.versionMismatch.length > 0) {
    findings.push(finding(
      'plugin_version_mismatch',
      hardened ? 'FAIL' : 'WARN',
      `${env.versionMismatch.length} DSH package version mismatch(es): ${env.versionMismatch.join(', ')}`,
    ))
  } else {
    findings.push(finding('plugin_version_mismatch', 'OK', 'host package versions match the pinned peers'))
  }

  // --- input engine ------------------------------------------------------------
  // A configured-but-unusable engine is a FAIL regardless of preset: the operator
  // asked for this control and it is not running. Whether that blocks the load is
  // `posture.failOn`'s business (hardened includes this code by default).
  if (env.engine === undefined) {
    findings.push(finding('engine_sidecar_unavailable', 'SKIP', 'input engine not probed'))
  } else if (env.engine.kind === 'builtin') {
    findings.push(finding('engine_sidecar_unavailable', 'OK', 'built-in input engine'))
  } else if (env.engine.status === 'ready' && env.engine.rulesStale !== true) {
    findings.push(finding('engine_sidecar_unavailable', 'OK', 'python input engine ready'))
  } else {
    const stale = env.engine.rulesStale === true ? ', rules=stale' : ''
    findings.push(finding(
      'engine_sidecar_unavailable',
      'FAIL',
      `the configured python input engine is not ready (status=${env.engine.status}${stale})`,
    ))
  }

  return findings
}

/** Summary block, small enough to paste into a status response. */
export interface PostureSummary {
  readonly fail: number
  readonly warn: number
  readonly ok: number
  readonly skip: number
  /** True when there is no FAIL and no WARN. */
  readonly clean: boolean
}

/** Fold findings into counts plus a `clean` flag. */
export function summarize(findings: readonly PostureFinding[]): PostureSummary {
  let fail = 0
  let warn = 0
  let ok = 0
  let skip = 0
  for (const item of findings) {
    if (item.severity === 'FAIL') fail += 1
    else if (item.severity === 'WARN') warn += 1
    else if (item.severity === 'OK') ok += 1
    else skip += 1
  }
  return { fail, warn, ok, skip, clean: fail === 0 && warn === 0 }
}

/**
 * Codes from `posture.failOn` that actually FAILed right now.
 *
 * @param config - resolved config carrying the failOn list.
 * @param findings - the current report.
 * @returns the offending codes (empty means "load may proceed").
 */
export function failOnHits(config: ResolvedConfig, findings: readonly PostureFinding[]): string[] {
  if (config.posture.failOn.length === 0) return []
  const failed = new Set(findings.filter((item) => item.severity === 'FAIL').map((item) => item.code))
  return config.posture.failOn.filter((code) => failed.has(code))
}
