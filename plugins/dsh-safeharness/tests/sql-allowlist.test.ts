/**
 * SQL table allowlist (1.12.0): the `allowed_tables` half of the kernel's
 * `SqlGuardPolicy` (`policies/sql_guard.py`), which the plugin's `inspectSql` port
 * already supported but nothing fed.
 *
 * Kernel semantics ported here:
 *  - `None`/empty means "no table restriction"; a non-empty list denies a SQL read
 *    that touches a table the list does not name (`unauthorized_sql_table`);
 *  - a schema-qualified name matches on its bare table name too;
 *  - a DESTRUCTIVE statement still wins over the allowlist (`dangerous_sql_detected`),
 *    because `inspect_sql` only checks tables when the statement is otherwise benign;
 *  - only tools that can execute SQL are scanned (`tools.sqlScan: 'execution'`, R42).
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { evaluateToolCall } from '../src/engine/tool.js'
import { ReasonCode } from '../src/engine/types.js'
import type { RuleSet, SessionView, ToolView } from '../src/engine/types.js'
import type { SafeHarnessConfig } from '../src/config.js'

/** No rules and no chains: the SQL scan is independent of the rule set. */
const RULESET: RuleSet = {
  hash: 'test',
  rules: [],
  chains: [],
  ruleCount: 0,
  chainCount: 0,
  sources: ['test'],
  loadedAt: 0,
}

/** A no-trail session. */
const SESSION: SessionView = { sessionId: 's-sql', trail: [], totalCalls: 0 }

/** A database tool call carrying one SQL string. */
function sqlView(sql: string, name = 'db_query'): ToolView {
  return { name, arguments: { sql }, argsBytes: sql.length, tags: [] }
}

/** Resolved `tools` config over a partial override. */
function toolsConfig(overrides: Partial<SafeHarnessConfig['tools']> = {}) {
  return resolveConfig({ preset: 'balanced', tools: overrides }).tools
}

describe('tools.sql.allowedTables', () => {
  it('defaults to an empty list, which disables the table check', () => {
    const cfg = toolsConfig()
    expect(cfg.sql.allowedTables).toEqual([])
    const decision = evaluateToolCall(RULESET, cfg, sqlView('SELECT * FROM anything'), SESSION)
    expect(decision.reasonCode).toBe(ReasonCode.None)
  })

  it('allows a read of a listed table', () => {
    const cfg = toolsConfig({ sql: { allowedTables: ['users'] } })
    const decision = evaluateToolCall(RULESET, cfg, sqlView('SELECT id FROM users WHERE id = 1'), SESSION)
    expect(decision.kind).toBe('allow')
    expect(decision.reasonCode).toBe(ReasonCode.None)
  })

  it('denies a read of an unlisted table', () => {
    const cfg = toolsConfig({ sql: { allowedTables: ['users'] } })
    const decision = evaluateToolCall(RULESET, cfg, sqlView('SELECT * FROM secrets'), SESSION)
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe(ReasonCode.ToolSqlTable)
    expect(decision.ruleIds).toEqual(['sql_table_allowlist'])
    expect(decision.reason).toContain('secrets')
  })

  it('matches a schema-qualified name on its bare table name', () => {
    const cfg = toolsConfig({ sql: { allowedTables: ['users'] } })
    const decision = evaluateToolCall(RULESET, cfg, sqlView('SELECT * FROM public.users'), SESSION)
    expect(decision.reasonCode).toBe(ReasonCode.None)
  })

  it('checks every table reference, including joins', () => {
    const cfg = toolsConfig({ sql: { allowedTables: ['users'] } })
    const decision = evaluateToolCall(RULESET, cfg, sqlView('SELECT * FROM users JOIN payments ON users.id = payments.user_id'), SESSION)
    expect(decision.reasonCode).toBe(ReasonCode.ToolSqlTable)
    expect(decision.reason).toContain('payments')
  })

  it('lets a destructive statement keep its own reason code', () => {
    const cfg = toolsConfig({ sql: { allowedTables: ['users', 'audit'] } })
    const decision = evaluateToolCall(RULESET, cfg, sqlView('DELETE FROM users WHERE id = 1'), SESSION)
    expect(decision.reasonCode).toBe(ReasonCode.ToolArgs)
    expect(decision.ruleIds).toEqual(['dangerous_sql'])
  })

  it('does not scan a content-landing tool', () => {
    const cfg = toolsConfig({ sql: { allowedTables: ['users'] } })
    const decision = evaluateToolCall(RULESET, cfg, sqlView('SELECT * FROM secrets', 'write_file'), SESSION)
    expect(decision.reasonCode).toBe(ReasonCode.None)
  })

  it('scans every tool under sqlScan: all', () => {
    const cfg = toolsConfig({ sqlScan: 'all', sql: { allowedTables: ['users'] } })
    const decision = evaluateToolCall(RULESET, cfg, sqlView('SELECT * FROM secrets', 'write_file'), SESSION)
    expect(decision.reasonCode).toBe(ReasonCode.ToolSqlTable)
  })

  it('is validated as a string list', () => {
    expect(() => resolveConfig({ preset: 'balanced', tools: { sql: { allowedTables: 'users' as never } } }))
      .toThrow(/allowedTables/)
  })
})
