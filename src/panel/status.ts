/**
 * The panel payload builder: the same facts `safeharness_status` reports, in
 * the shape the Settings tab renders (T5.3).
 *
 * Zero-echo discipline holds here too: nothing in this payload may carry input
 * text, tool arguments, model output, a credential or a webhook URL. The only
 * free-form data is the denial projection (timestamp, kind, reason code, tool
 * name, rule count), all of which are coarse codes the ledger already stores.
 * @module
 */
import type { Runtime } from '../runtime.js'
import { VERSION } from '../version.js'
import type { PanelDenial, PanelEngine, PanelPayload } from './protocol.js'

/** How many newest denials the panel shows. */
export const PANEL_RECENT_LIMIT = 10

/** Display width of the rule-set hash (the ledger keeps the full one). */
const HASH_PREFIX_CHARS = 12

/** Live facts `apply()` owns but the runtime does not: the engine's health. */
export interface PanelFacts {
  /** Engine identity/health; defaults to the built-in engine when absent. */
  readonly engine?: () => PanelEngine
}

/**
 * Build one panel payload from live runtime state.
 *
 * Every read is defensive: a ledger that cannot answer (closed, unreadable)
 * reports an empty denial list rather than failing the whole panel, because the
 * panel's primary job is to show that the plugin is alive.
 *
 * @param runtime - the plugin runtime.
 * @param startedAt - epoch ms recorded by `apply()`.
 * @param facts - optional live facts.
 * @returns a JSON-serializable payload.
 */
export async function buildPanelPayload(
  runtime: Runtime,
  startedAt: number,
  facts: PanelFacts = {},
): Promise<PanelPayload> {
  const stats = runtime.ledger.stats
  const counters = runtime.counters
  let recentDenials: PanelDenial[] = []
  try {
    const records = await runtime.ledger.query({ limit: PANEL_RECENT_LIMIT, decision: 'deny' })
    recentDenials = records.map(record => ({
      ts: record.ts,
      kind: record.kind,
      reasonCode: record.reason_code ?? '',
      ...(record.tool === undefined ? {} : { tool: record.tool }),
      rules: record.rule_ids?.length ?? 0,
    }))
  } catch {
    recentDenials = []
  }
  return {
    generatedAt: new Date().toISOString(),
    version: VERSION,
    preset: runtime.config.preset,
    uptimeMs: Date.now() - startedAt,
    sessions: runtime.state.size,
    rules: {
      hash: runtime.engine.rulesetHash.slice(0, HASH_PREFIX_CHARS),
      count: runtime.engine.ruleCount,
      chains: runtime.engine.chainCount,
    },
    modes: {
      input: runtime.config.input.mode,
      tools: runtime.config.tools.mode,
      results: runtime.config.results.mode,
      output: runtime.config.output.mode,
      approval: runtime.config.approval.mode,
    },
    counters: {
      allow: counters.allow,
      warn: counters.warn,
      deny: counters.deny,
      ask: counters.ask,
      auditBlocked: counters.auditBlocked,
      internalErrors: counters.internalErrors,
    },
    ledger: {
      enabled: stats.enabled,
      writable: stats.writable,
      records: stats.records,
      failures: stats.failures,
      lastWriteAt: stats.lastWriteAt ?? null,
    },
    engine: facts.engine?.() ?? { kind: 'builtin', status: 'ready', rulesStale: false, pending: 0, badLines: 0 },
    recentDenials,
  }
}
