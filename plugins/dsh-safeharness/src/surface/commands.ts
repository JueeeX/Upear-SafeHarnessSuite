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
import type { JudgeResult } from '../judge/client.js'
import type { DraftKind, DraftResult } from '../draft/rule.js'
import { VERSION } from '../version.js'
import { MAX_TRAIL } from '../state.js'

/** Command name without the leading slash. */
export const COMMAND_NAME = 'safeharness'

/** Subcommand help line shown for an unknown argument. */
const USAGE = 'usage: /safeharness status | posture | rules | audit [n] | patrol [check...] | judge [probe] | draft <what to catch> [--chain]'

/**
 * The canary text a `/safeharness judge probe` sends.
 *
 * Deliberately tiny and unambiguous: the judge prompt already asks for a one-word
 * JSON verdict, so a reachable route answers in a handful of tokens and the probe
 * stays cheap. It never carries operator or session content.
 */
export const JUDGE_PROBE_TEXT = 'safeharness judge connectivity self-check'

/**
 * Read-only view of the judge for the operator command: current route plus a
 * one-shot probe. `handler` never returns reviewed content, so a probe cannot
 * leak through the command result.
 */
export interface JudgeCommandTarget {
  /** Current judge facts (read live: a settings reload changes the route). */
  state(): { enabled: boolean; scope: string; provider: string; model: string; available: boolean }
  /** One real judge call over the production route; content never returned. */
  probe(): Promise<JudgeResult>
}

/** One-line rendering of a probe result: status/verdict and sizes only. */
function formatJudgeProbe(result: JudgeResult, route: string): string {
  const labels = Object.entries(result.labels)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
  const metrics = Object.entries(result.metrics)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
  const bits = [`status=${result.status}`, `verdict=${result.verdict}`, `blocked=${result.blocked ? 'yes' : 'no'}`]
  return [`judge probe: ${bits.join(' ')} route=${route}`, `  ${[...labels, ...metrics].join(' ') || '(no detail)'}`].join('\n')
}

/**
 * Drafting for the operator command (M5 T5.2).
 *
 * Same handle the model-facing tool uses, so `/safeharness draft` prints exactly what
 * `safeharness_draft_rule` would return. The command never applies anything either.
 */
export interface DraftCommandTarget {
  /** Whether drafting is enabled in the live config. */
  readonly enabled: boolean
  /** One drafting attempt; the result is a draft, never a rule-set change. */
  draft(description: string, kind: DraftKind): Promise<DraftResult>
}

/** Format one draft result: status line, metrics, then the paste-ready YAML. */
function formatDraft(result: DraftResult): string {
  const metrics = `duration_ms=${result.metrics.durationMs} prompt_chars=${result.metrics.promptChars} reply_chars=${result.metrics.replyChars}`
  if (result.status !== 'ok') {
    return [`draft: ${result.status} (nothing applied)`, `  ${result.reason}`, `  ${metrics}`].join('\n')
  }
  const warnings = result.draft.warnings.length === 0
    ? []
    : ['  warnings:', ...result.draft.warnings.map((warning) => `    - ${warning}`)]
  return [
    `draft: ok (nothing applied)`,
    `  ${result.draft.summary}`,
    `  ${metrics}`,
    ...warnings,
    '  next: save the YAML below into a .yml file under `rules.dir` (or add it to `rules.inline`) and reload',
    result.draft.yaml.trimEnd(),
  ].join('\n')
}

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
 * @param judge - judge diagnostics target (optional: a profile with no `llm`
 *   service, or a test that only exercises other subcommands, may omit it).
 * @param draft - rule-drafting target (optional for the same reasons; a draft is
 *   never applied, only printed).
 * @returns the command definition to register.
 */
export function safeharnessCommand(
  runtime: Runtime,
  runPosture: () => Promise<PostureReport>,
  runPatrol?: (options?: { include?: readonly string[] }) => Promise<PatrolReport>,
  judge?: JudgeCommandTarget,
  draft?: DraftCommandTarget,
): CommandDefinition {
  return {
    name: COMMAND_NAME,
    description: 'Inspect the security layer: status, posture, rules, audit tail, patrol, judge, draft.',
    input: { hint: 'status | posture | rules | audit [n] | patrol [check...] | judge [probe] | draft <what to catch> [--chain]' },
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
          case 'judge': {
            const live = judge?.state()
            const route = `${runtime.config.output.judge.provider}/${runtime.config.output.judge.model}`
            const state = [
              `judge: ${runtime.config.output.judge.enabled ? `on scope=${runtime.config.output.judge.scope}` : 'off'} route=${route}`,
              `  available: ${live?.available === true ? 'yes' : 'no'}${live?.available === true ? '' : ' (this profile composes no llm service)'}`,
            ]
            if (rest[0] !== 'probe') {
              return {
                kind: 'success',
                text: [
                  ...state,
                  '  probe: /safeharness judge probe  (one real call over this route; prints status only)',
                ].join('\n'),
              }
            }
            if (judge === undefined || live === undefined) {
              return { kind: 'error', text: 'judge probe: no judge handle in this build' }
            }
            if (!live.available) {
              return { kind: 'error', text: 'judge probe: this profile composes no llm service, nothing to probe' }
            }
            // The canary travels the same `ctx.llm` route the output guard uses, so a
            // green probe proves the configured provider/model/key actually answer.
            const result = await judge.probe()
            return { kind: result.status === 'ok' ? 'success' : 'error', text: formatJudgeProbe(result, route) }
          }
          case 'draft': {
            if (draft === undefined) {
              return { kind: 'error', text: 'draft: unavailable in this build (no drafting handle registered)' }
            }
            if (!draft.enabled) {
              return { kind: 'error', text: 'draft: disabled by configuration (`draft.enabled: false`)' }
            }
            const kind: DraftKind = rest.includes('--chain') ? 'chain' : 'inform'
            const description = rest.filter((part) => part !== '--chain').join(' ').trim()
            if (description.length === 0) {
              return {
                kind: 'error',
                text: 'draft: describe what to catch, e.g. /safeharness draft curl piping a downloaded script into sh',
              }
            }
            const result = await draft.draft(description, kind)
            return {
              kind: result.status === 'ok' ? 'success' : 'error',
              text: formatDraft(result),
            }
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
