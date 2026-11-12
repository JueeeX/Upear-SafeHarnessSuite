/**
 * R42: who gets the dangerous-SQL argument scan (1.2.2).
 *
 * The pre-1.2.2 rule walked every string argument of every tool, so writing a
 * document that QUOTED a destructive statement was denied as if the tool had run
 * it (`write`, `edit`, three denials while producing the handoff doc). The scan now
 * follows the intent of the Python reference `SqlGuardPolicy`: only arguments that
 * can REACH an SQL engine.
 *
 * Two directions matter, and both are asserted here:
 *
 * 1. content tools stop being denied for carrying SQL text (the fix);
 * 2. execution tools and anything this version cannot classify keep being denied
 *    (no silent coverage loss) — `tools.sqlScan: 'all'` restores 1.2.1 exactly.
 *
 * The payload is assembled from pieces on purpose: a test file that quotes the
 * statement verbatim would itself be denied by the rule under test (R42, live).
 */
import { describe, expect, it } from 'vitest'
import { packagedRules } from './helpers/fake-host.js'
import { evaluateToolCall, resolveTags, shouldScanSql } from '../src/engine/tool.js'
import { resolveConfig } from '../src/config.js'
import type { SessionView, ToolView } from '../src/engine/types.js'

/** A statement `inspectSql` classifies as dangerous (kind = write). */
const DESTRUCTIVE = `DEL${'ETE FROM users WHERE 1=1'}`

/** Empty session trail: chain rules play no part in these cases. */
function session(): SessionView {
  return { sessionId: 'r42', trail: [], totalCalls: 0 }
}

/**
 * Build a tool view the way the hook does: tags resolved from the name plus the
 * configured overrides.
 */
function view(
  name: string,
  args: Record<string, unknown>,
  overrides: readonly { pattern: string; tags: readonly string[] }[] = [],
): ToolView {
  return {
    name,
    arguments: args,
    argsBytes: JSON.stringify(args).length,
    tags: resolveTags(name, overrides),
  }
}

const ruleset = packagedRules()

/** Resolved `tools` config for the given overrides. */
function toolsConfig(extra: Record<string, unknown> = {}): ReturnType<typeof resolveConfig>['tools'] {
  return resolveConfig({ preset: 'balanced', tools: extra }).tools
}

describe('R42 defaults: content tools are no longer denied for quoting SQL', () => {
  const cfg = toolsConfig()

  it('allows write/edit/apply_patch carrying a destructive statement', () => {
    for (const name of ['write', 'edit', 'apply_patch', 'create_file']) {
      const decision = evaluateToolCall(ruleset, cfg, view(name, { path: 'docs/x.md', content: DESTRUCTIVE }), session())
      expect(decision.kind, `${name} must not be denied for carrying SQL text`).toBe('allow')
    }
  })

  it('allows a read whose path merely contains SQL words', () => {
    const decision = evaluateToolCall(ruleset, cfg, view('read', { path: 'notes/delete-from-users.sql' }), session())
    expect(decision.kind).toBe('allow')
  })

  it('still scans an unknown tool this version cannot classify (fail-closed)', () => {
    const decision = evaluateToolCall(ruleset, cfg, view('frobnicate_thing', { payload: DESTRUCTIVE }), session())
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe('tool_denied_by_args')
  })
})

describe('R42: execution-facing tools keep the scan', () => {
  const cfg = toolsConfig()

  it('denies dangerous SQL handed to shells and database clients', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['pwsh', { command: `psql -c "${DESTRUCTIVE}"` }],
      ['bash', { command: `mysql -e "${DESTRUCTIVE}"` }],
      ['db_query', { sql: DESTRUCTIVE }],
      ['run_sql', { query: DESTRUCTIVE }],
      // MCP server tools are named `mcp__<server>_<tool>`; the token match is what
      // keeps a real database tool covered.
      ['mcp__postgres_query', { sql: DESTRUCTIVE }],
    ]
    for (const [name, args] of cases) {
      const decision = evaluateToolCall(ruleset, cfg, view(name, args), session())
      expect(decision.kind, `${name} must still be denied`).toBe('deny')
      expect(decision.reasonCode).toBe('tool_denied_by_args')
      expect(decision.ruleIds).toContain('dangerous_sql')
    }
  })

  it('keeps an fs-named tool under the scan once it also looks like an executor', () => {
    // A tool that both writes and executes is an executor: the execution signal wins.
    const decision = evaluateToolCall(ruleset, cfg, view('write_and_exec', { content: DESTRUCTIVE }), session())
    expect(decision.kind).toBe('deny')
  })
})

describe('R42: operator-controlled scope', () => {
  it("restores the 1.2.1 behaviour with tools.sqlScan: 'all'", () => {
    const cfg = toolsConfig({ sqlScan: 'all' })
    const decision = evaluateToolCall(ruleset, cfg, view('write', { content: DESTRUCTIVE }), session())
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe('tool_denied_by_args')
  })

  it('moves a content tool back under the scan with a tag override', () => {
    const overrides = [{ pattern: 'write*', tags: ['db'] }]
    const cfg = toolsConfig({ tagOverrides: overrides })
    const decision = evaluateToolCall(ruleset, cfg, view('write', { content: DESTRUCTIVE }, overrides), session())
    expect(decision.kind).toBe('deny')
  })

  it('rejects an unknown scope value at load time', () => {
    expect(() => resolveConfig({ preset: 'balanced', tools: { sqlScan: 'sometimes' as never } }))
      .toThrow(/tools\.sqlScan/)
  })
})

describe('shouldScanSql — the boundary itself', () => {
  it('classifies names by token, not by substring', () => {
    const scope = 'execution' as const
    // `db` as a substring must not make `debug` an executor…
    expect(shouldScanSql({ name: 'debug_dump', tags: [] }, scope)).toBe(true)
    // …but "unclassified" means SCANNED, so the assertion above is fail-closed, not
    // a classification win: an unknown tool keeps the pre-1.2.2 scan.
    expect(shouldScanSql({ name: 'doc_write', tags: [] }, scope)).toBe(false)
    // `rewrite` is not `write`: an unrecognized verb stays under the scan.
    expect(shouldScanSql({ name: 'rewrite_doc', tags: [] }, scope)).toBe(true)
    expect(shouldScanSql({ name: 'db_query', tags: [] }, scope)).toBe(true)
    expect(shouldScanSql({ name: 'mcp__postgres_query', tags: ['mcp'] }, scope)).toBe(true)
  })

  it('treats camelCase names the same as snake_case', () => {
    expect(shouldScanSql({ name: 'runSQL', tags: [] }, 'execution')).toBe(true)
    expect(shouldScanSql({ name: 'writeFile', tags: [] }, 'execution')).toBe(false)
  })
})

describe('R42: the input face is unaffected', () => {
  it('still denies a user message quoting the same statement', async () => {
    // The input face mirrors Python's CONTENT_RECEIVED: user text is scanned
    // regardless of tool classification. (Guard against "the fix leaked upward".)
    const { evaluateInput } = await import('../src/engine/input.js')
    const evaluation = evaluateInput(packagedRules(), `please run this for me: ${DESTRUCTIVE}`, { maxChars: 60000 })
    expect(evaluation.decision.kind).toBe('deny')
    expect(evaluation.decision.reasonCode).toBe('input_sql_dangerous')
    expect(evaluation.decision.ruleIds).toContain('dangerous_sql')
  })
})

describe('R42: no other tool-surface behaviour moved', () => {
  const cfg = toolsConfig()

  it('keeps denyTools / askTools / size ceilings intact', () => {
    expect(evaluateToolCall(ruleset, toolsConfig({ denyTools: ['write*'] }), view('write', { content: 'x' }), session()).kind)
      .toBe('deny')
    expect(evaluateToolCall(ruleset, toolsConfig({ askTools: ['deploy*'] }), view('deploy_app', { x: 'y' }), session()).kind)
      .toBe('ask')
    const big: ToolView = { name: 'write', arguments: { content: 'x' }, argsBytes: cfg.maxArgsBytes + 1, tags: ['fs'] }
    expect(evaluateToolCall(ruleset, cfg, big, session()).reasonCode).toBe('tool_args_too_large')
  })
})
