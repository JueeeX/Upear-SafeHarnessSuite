/**
 * The `/safeharness` user command (§6.12). Output never enters the model's
 * history: the command runs against the agent directly, so an operator can
 * inspect the security layer without spending context or teaching the model.
 * @module
 */
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Runtime } from '../runtime.js'
import type { PostureReport } from '../posture/report.js'
import type { PatrolReport } from '../patrol/index.js'
import { VERSION } from '../version.js'
import { MAX_TRAIL } from '../state.js'

/** Command name without the leading slash. */
export const COMMAND_NAME = 'safeharness'

/** Subcommand help line shown for an unknown argument. */
const USAGE = 'usage: /safeharness status | posture | rules | audit [n] | patrol [check...]'

/** Format one posture report as plain text. */
function formatPosture(report: PostureReport): string {
  const head = `posture: ${report.summary.fail} FAIL / ${report.summary.warn} WARN / ${report.summary.ok} OK / ${report.summary.skip} SKIP`
  const lines = report.findings.map((item) => `  [${item.severity}] ${item.code}: ${item.detail}`)
  return [head, ...lines].join('\n')
}

/** Format one patrol report as plain text, exit code first (it is the contract). */
function formatPatrol(report: PatrolReport): string {
  const head = `patrol: exit=${report.exitCode} ${report.summary.fail} FAIL / ${report.summary.warn} WARN / ${report.summary.ok} OK / ${report.summary.skip} SKIP`
  const lines = report.findings.map((item) => `  [${item.severity}] ${item.code}: ${item.detail}`)
  const extra = [report.notified ? '  notified: yes' : '  notified: no']
  if (report.internalError !== undefined) extra.push(`  internal: ${report.internalError}`)
  return [head, ...lines, ...extra].join('\n')
}

/**
 * Build the command definition.
 *
 * @param runtime - shared runtime.
 * @param runPosture - runs the posture checks (owned by the composition root).
 * @param runPatrol - runs the patrol checks (owned by the composition root).
 * @returns the command definition to register.
 */
export function safeharnessCommand(
  runtime: Runtime,
  runPosture: () => Promise<PostureReport>,
  runPatrol?: (options?: { include?: readonly string[] }) => Promise<PatrolReport>,
): CommandDefinition {
  return {
    name: COMMAND_NAME,
    description: 'Inspect the security layer: status, posture, rules, audit tail, patrol.',
    input: { hint: 'status | posture | rules | audit [n] | patrol [check...]' },
    // Operator diagnostics, not model input: keep it out of the model transcript.
    recordInput: true,
    async handler(invocation): Promise<CommandResult> {
      const [sub = 'status', ...rest] = invocation.rawInput.trim().split(/\s+/u).filter((part) => part.length > 0)
      try {
        switch (sub) {
          case 'status': {
            const stats = runtime.ledger.stats
            const counters = runtime.counters
            return {
              kind: 'success',
              text: [
                `safeharness ${VERSION} preset=${runtime.config.preset}`,
                `rules: ${runtime.engine.ruleCount} (hash ${runtime.engine.rulesetHash.slice(0, 12)}) chains: ${runtime.engine.chainCount}`,
                `modes: input=${runtime.config.input.mode} tools=${runtime.config.tools.mode} results=${runtime.config.results.mode} output=${runtime.config.output.mode} approval=${runtime.config.approval.mode}`,
                `judge: ${runtime.config.output.judge.enabled ? `on scope=${runtime.config.output.judge.scope} route=${runtime.config.output.judge.provider}/${runtime.config.output.judge.model}` : 'off'}`,
                `budget: ${runtime.budget.enabled ? `limit=${runtime.budget.limitValue}/turn sessions=${runtime.budget.size}` : 'off'}`,
                `output buffer: ${runtime.config.output.mode === 'enforce-buffer' ? `${runtime.config.output.bufferTimeoutMs}ms / ${runtime.config.output.bufferMaxChars} chars` : 'not buffering'}`,
                `ledger: ${stats.enabled ? stats.path : 'off'} records=${stats.records} writable=${stats.writable} failures=${stats.failures}`,
                `counters: allow=${counters.allow} warn=${counters.warn} deny=${counters.deny} ask=${counters.ask} auditBlocked=${counters.auditBlocked}`,
                `sessions tracked: ${runtime.state.size} (trail cap ${MAX_TRAIL})`,
              ].join('\n'),
            }
          }
          case 'posture':
            return { kind: 'success', text: formatPosture(await runPosture()) }
          case 'rules': {
            const ruleset = runtime.engine.ruleset
            const lines = ruleset.rules
              .slice()
              .sort((a, b) => a.id.localeCompare(b.id))
              .map((rule) => `  ${rule.id} [${rule.severity}] ${rule.category}`)
            return {
              kind: 'success',
              text: [`ruleset ${ruleset.hash} (${ruleset.ruleCount} rules, ${ruleset.chainCount} chains)`,
                `sources: ${ruleset.sources.join(', ') || '(inline only)'}`,
                ...lines].join('\n'),
            }
          }
          case 'audit': {
            const requested = rest[0] === undefined ? 10 : Number.parseInt(rest[0], 10)
            const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, requested)) : 10
            const records = await runtime.ledger.query({ limit })
            if (records.length === 0) return { kind: 'success', text: 'audit: no records yet' }
            const lines = records.map((record) => {
              const bits = [`#${record.seq}`, record.ts, record.kind]
              if (record.decision !== undefined) bits.push(`decision=${record.decision}`)
              if (record.tool !== undefined) bits.push(`tool=${record.tool}`)
              if (record.reason_code !== undefined) bits.push(`reason=${record.reason_code}`)
              return `  ${bits.join(' ')}`
            })
            return { kind: 'success', text: [`audit tail (${records.length}):`, ...lines].join('\n') }
          }
          case 'patrol': {
            if (runPatrol === undefined) {
              return { kind: 'error', text: 'patrol is unavailable in this build (no patrol runner registered)' }
            }
            const include = rest.filter((part) => part.length > 0)
            const report = await runPatrol(include.length === 0 ? {} : { include })
            return { kind: 'success', text: formatPatrol(report) }
          }
          default:
            return { kind: 'error', text: USAGE }
        }
      } catch (error) {
        return { kind: 'error', text: `safeharness: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}
