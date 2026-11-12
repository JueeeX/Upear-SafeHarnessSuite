/**
 * Read-only model-facing tools (§6.12). Every tool here is side-effect free,
 * returns redacted data only, and is safe to call at any time.
 * @module
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Runtime } from '../runtime.js'
import type { PostureReport } from '../posture/report.js'
import type { PatrolReport } from '../patrol/index.js'
import type { AuditKind } from '../audit/types.js'
import type { DraftKind, DraftResult, RuleDrafter } from '../draft/rule.js'
import { VERSION } from '../version.js'

/**
 * JSON-serializable value.
 *
 * Declared here rather than imported: the published host types no longer export
 * `JsonValue`, while the profile-tree copy still does. The structural shape is the
 * one `defineTool` validates, so this alias compiles against both revisions.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Assert a tool payload is lossless JSON.
 *
 * `defineTool` declares `output.schema: {type:'json'}` and requires the canonical
 * value to be JSON; a round-trip both proves that and strips `undefined` fields,
 * so a status payload can never carry a non-serializable value into the log.
 */
function toJson(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    return { error: 'unserializable-result' }
  }
}

/** Render one JSON value as pretty text (the model reads it directly). */
function asText(value: unknown): { type: 'text'; text: string }[] {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return [{ type: 'text', text }]
}

/** `safeharness_status`: what is loaded, which preset, ledger health, counters. */
export function statusTool(
  runtime: Runtime,
  startedAt: number,
  host?: Record<string, { readonly version: string; readonly origin: string }>,
  seams?: Record<string, boolean>,
  facts?: {
    readonly judge?: () => { readonly enabled: boolean; readonly scope: string; readonly available: boolean; readonly provider: string; readonly model: string }
    readonly budget?: () => { readonly enabled: boolean; readonly limit: number; readonly sessions: number }
    readonly engine?: () => {
      readonly kind: 'builtin' | 'sidecar'
      readonly status: string
      readonly rulesStale: boolean
      readonly pending: number
      readonly badLines: number
      readonly lastError?: string
    }
  },
): ToolDefinition {
  return defineTool({
    name: 'safeharness_status',
    description:
      'Report the deployment security plugin status: loaded version, preset, rule-set hash and '
      + 'count, audit ledger health, and decision counters. Read-only.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => asText(value),
    },
    execute() {
      const stats = runtime.ledger.stats
      const counters = runtime.counters
      return Promise.resolve(toJson({
        loaded: true,
        version: VERSION,
        preset: runtime.config.preset,
        rulesetHash: runtime.engine.rulesetHash,
        ruleCount: runtime.engine.ruleCount,
        chainCount: runtime.engine.chainCount,
        uptimeMs: Date.now() - startedAt,
        sessions: runtime.state.size,
        ledger: {
          path: stats.path,
          enabled: stats.enabled,
          writable: stats.writable,
          records: stats.records,
          lastWriteAt: stats.lastWriteAt ?? null,
          failures: stats.failures,
        },
        counters: {
          allow: counters.allow,
          warn: counters.warn,
          deny: counters.deny,
          ask: counters.ask,
          auditBlocked: counters.auditBlocked,
          internalErrors: counters.internalErrors,
        },
        modes: {
          input: runtime.config.input.mode,
          tools: runtime.config.tools.mode,
          results: runtime.config.results.mode,
          output: runtime.config.output.mode,
          approval: runtime.config.approval.mode,
        },
        // Which copy of each host package the running process resolved; vital when
        // a host bundles its own copies.
        host: host ?? {},
        // Which optional seams this profile actually provided. A `false` here is
        // the honest answer to "why is /safeharness missing" in a headless profile.
        seams: seams ?? {},
        // M3 facts: the judge route is configuration (no credential), the budget is
        // the per-turn advisory cap, and both are read live so a hot reload shows.
        ...(facts?.judge === undefined ? {} : { judge: facts.judge() }),
        ...(facts?.budget === undefined ? {} : { budget: facts.budget() }),
        ...(facts?.engine === undefined ? {} : { engine: facts.engine() }),
      }))
    },
    isConcurrencySafe: () => true,
  })
}

/** `safeharness_posture`: run the deployment posture checks now. */
export function postureTool(run: () => Promise<PostureReport>): ToolDefinition {
  return defineTool({
    name: 'safeharness_posture',
    description:
      'Run the deployment posture self-check now (sandbox mode, approval policy, HMR, rule set, '
      + 'ledger writability and hash chain, output guard, judge availability, host version match). '
      + 'Read-only; reports codes and severities, never configuration values.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => asText(value),
    },
    async execute() {
      const report = await run()
      return toJson({
        ranAt: report.ranAt,
        summary: report.summary,
        findings: report.findings.map((item) => ({ code: item.code, severity: item.severity, detail: item.detail })),
      })
    },
    isConcurrencySafe: () => true,
  })
}

/**
 * Patrol check names accepted by the `include` parameter.
 *
 * Mirrors `PATROL_CODES`: an operator (or a test) must be able to name every check
 * the patrol can run, including `notify` — otherwise the only way to exercise the
 * notification path through the tool is "run everything".
 */
const PATROL_CHECKS: readonly string[] = ['audit_rate', 'health_probe', 'config_drift', 'ledger_reconcile', 'notify']

/** `safeharness_patrol`: run the deployment patrol now (§6.10, T3.4). */
export function patrolTool(run: (options?: { include?: readonly string[] }) => Promise<PatrolReport>): ToolDefinition {
  return defineTool({
    name: 'safeharness_patrol',
    description:
      'Run the deployment patrol now: audit denial rate, health endpoints, posture drift against the '
      + 'last report, and ledger reconciliation. Read-only; returns finding codes and an exit code '
      + '(0 clean, 1 FAIL, 2 patrol error).',
    parameters: {
      include: {
        type: 'array',
        items: { type: 'string', enum: [...PATROL_CHECKS] },
        description: `Only run these checks (default: all of ${PATROL_CHECKS.join(', ')}).`,
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => asText(value),
    },
    async execute(args) {
      const include = Array.isArray(args.include)
        ? args.include.filter((item): item is string => typeof item === 'string')
        : undefined
      const report = await run(include === undefined ? {} : { include })
      return toJson({
        ranAt: report.ranAt,
        exitCode: report.exitCode,
        summary: report.summary,
        notified: report.notified,
        findings: report.findings.map((item) => ({ code: item.code, severity: item.severity, detail: item.detail })),
        ...(report.internalError === undefined ? {} : { internalError: report.internalError }),
      })
    },
    isConcurrencySafe: () => true,
  })
}

/** Live drafting limits (read per call so a settings reload takes effect). */
export interface DraftToolLimits {
  readonly enabled: boolean
  readonly maxChars: number
  readonly timeoutMs: number
  readonly maxTokens: number
}

/**
 * `safeharness_draft_rule`: turn a plain-language description into one validated
 * rule draft (M5 T5.2).
 *
 * The tool is deliberately *not* an actuator: it returns a YAML snippet and says
 * `applied: false`. Adding the rule stays a human action (write a file in
 * `rules.dir`, or edit `rules.inline`), so a model — or a prompt injection aimed at
 * the model — can never widen or narrow the rule set by calling a tool.
 */
export function draftRuleTool(drafter: RuleDrafter, limits: () => DraftToolLimits): ToolDefinition {
  return defineTool({
    name: 'safeharness_draft_rule',
    description:
      'Draft ONE candidate deny rule for this deployment from a plain-language description of the '
      + 'risky behaviour. Returns a validated, ready-to-paste YAML snippet, or the loader problems '
      + 'that make the candidate unusable. Nothing is written or applied: an operator must add the '
      + 'rule to a rules file (config `rules.dir` or `rules.inline`) and reload.',
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'What to catch, in plain language, e.g. "curl piping a downloaded script into sh".',
      },
      kind: {
        type: 'string',
        enum: ['inform', 'chain'],
        description: "Rule family: 'inform' matches untrusted user/model text (default); 'chain' matches tool A then tool B.",
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => asText(value),
    },
    async execute(args) {
      const cfg = limits()
      if (!cfg.enabled) {
        return toJson({ applied: false, status: 'disabled', detail: 'rule drafting is disabled (config `draft.enabled: false`)' })
      }
      const kind: DraftKind = args.kind === 'chain' ? 'chain' : 'inform'
      const description = typeof args.description === 'string' ? args.description : ''
      if (description.trim().length === 0) {
        return toJson({ applied: false, status: 'invalid', reason: 'a non-empty description is required', metrics: {} })
      }
      const result: DraftResult = await drafter.draft({ description, kind }, {
        timeoutMs: cfg.timeoutMs,
        maxChars: cfg.maxChars,
        maxTokens: cfg.maxTokens,
      })
      return toJson({
        applied: false,
        status: result.status,
        ...(result.status === 'ok' ? { draft: result.draft } : { reason: result.reason }),
        metrics: result.metrics,
        next: 'Nothing was applied. Save the YAML into a .yml file under `rules.dir`, or add it to `rules.inline`, then reload.',
      })
    },
    // Pure: it spends one model call and touches no shared state.
    isConcurrencySafe: () => true,
  })
}

/** Valid audit kinds, for parameter validation and documentation. */
const AUDIT_KINDS: readonly string[] = [
  'plugin_loaded',
  'plugin_unloaded',
  'posture_report',
  'input_checked',
  'input_denied',
  'tool_checked',
  'tool_denied',
  'tool_asked',
  'tool_executed',
  'tool_result',
  'tool_result_flagged',
  'output_reviewed',
  'approval_asked',
  'approval_decided',
  'rules_reloaded',
  'patrol_report',
  'invariant_probe',
  'budget_exceeded',
  'error',
]

/** Default and maximum record counts for the query tool. */
const QUERY_DEFAULT = 50
const QUERY_MAX = 500

/** `safeharness_audit_query`: tail the ledger, filtered, already redacted. */
export function auditQueryTool(runtime: Runtime): ToolDefinition {
  return defineTool({
    name: 'safeharness_audit_query',
    description:
      'Read the newest audit ledger records (already redacted: hashes and lengths only). '
      + 'Optional filters: session id, decision, record kind. Newest last.',
    parameters: {
      limit: {
        type: 'integer',
        description: `How many records to return (default ${QUERY_DEFAULT}, max ${QUERY_MAX}).`,
      },
      session: { type: 'string', description: 'Only records for this session id.' },
      decision: { type: 'string', description: 'Only records with this decision (allow/deny/warn/block/...).' },
      kind: { type: 'string', enum: [...AUDIT_KINDS], description: 'Only records of this kind.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => asText(value),
    },
    async execute(args) {
      const requested = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.trunc(args.limit) : QUERY_DEFAULT
      const limit = Math.min(QUERY_MAX, Math.max(1, requested))
      const records = await runtime.ledger.query({
        limit,
        ...(typeof args.session === 'string' && args.session.length > 0 ? { session: args.session } : {}),
        ...(typeof args.decision === 'string' && args.decision.length > 0 ? { decision: args.decision } : {}),
        ...(typeof args.kind === 'string' && args.kind.length > 0 ? { kind: args.kind as AuditKind } : {}),
      })
      return toJson({ count: records.length, limit, records })
    },
    isConcurrencySafe: () => true,
  })
}
