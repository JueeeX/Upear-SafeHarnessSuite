/**
 * `src/engine/tool.ts` — name/tag policy, argument shape, chain rules and the
 * tool-result scan.
 *
 * Sentinel values only: every "secret" below is an obvious fake, and the tests
 * assert that findings never echo them back.
 * @module
 */

import { describe, expect, it } from 'vitest'

import type { ResolvedConfig } from '../src/config.js'
import {
  evaluateToolCall,
  matchNamePattern,
  MAX_RESULT_SCAN_CHARS,
  resolveTags,
  scanToolResult,
} from '../src/engine/tool.js'
import type {
  CompiledChainRule,
  CompiledRule,
  RuleSet,
  Severity,
  SessionView,
  ToolResultView,
  ToolView,
} from '../src/engine/types.js'
import { ReasonCode } from '../src/engine/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Sentinel secrets — fake by construction, asserted absent from findings. */
const SK_SENTINEL = 'sk-test-sentinel-0123456789abcdef'
const BEARER_SENTINEL = 'Bearer sentinel-token-0123456789'
const PEM_HEADER = '-----BEGIN RSA PRIVATE KEY-----'
const ENTROPY_SENTINEL = 'q9Zx7Vb3Nc8Lm2Kp5Rt1Yw4Hj6Gf0DsAeUiOaQwErTyUp'

/** Resolved `tools` config with per-test overrides. */
function toolsConfig(overrides: Partial<ResolvedConfig['tools']> = {}): ResolvedConfig['tools'] {
  return {
    mode: 'enforce',
    denyTools: [],
    askTools: [],
    denyTags: [],
    maxArgsBytes: 65_536,
    trajectory: true,
    tagOverrides: [],
    ...overrides,
  }
}

/** Resolved `results` config with per-test overrides. */
function resultsConfig(overrides: Partial<ResolvedConfig['results']> = {}): ResolvedConfig['results'] {
  return { mode: 'warn', blockOn: ['credential_leak'], ...overrides }
}

/** An engine view of one call. `argsBytes` defaults to the canonical JSON size. */
function toolView(name: string, args: unknown = {}, overrides: Partial<ToolView> = {}): ToolView {
  return {
    name,
    arguments: args,
    argsBytes: Buffer.byteLength(JSON.stringify(args ?? null), 'utf8'),
    tags: resolveTags(name, []),
    ...overrides,
  }
}

/** A session view over a trail of tool names (tags resolved, seq 1..n). */
function sessionView(names: readonly string[] = []): SessionView {
  return {
    sessionId: 'test-session',
    trail: names.map((name, index) => ({ name, tags: resolveTags(name, []), seq: index + 1 })),
    totalCalls: names.length,
  }
}

/** An engine view of one result. */
function resultView(text: string, valueText = ''): ToolResultView {
  return { name: 'bash', text, valueText, isError: false }
}

/** Build one compiled deny rule. */
function rule(id: string, source: string, severity: Severity = 'high', category = 'prompt-injection'): CompiledRule {
  return {
    id,
    name: id,
    source,
    regex: new RegExp(source, 'i'),
    severity,
    category,
    action: 'deny',
    reason: `test rule ${id}`,
    origin: 'inline',
  }
}

/** Build one compiled chain rule. */
function chain(overrides: Partial<CompiledChainRule> & { name: string }): CompiledChainRule {
  return {
    firstSource: undefined,
    first: undefined,
    thenSource: undefined,
    then: undefined,
    firstTags: [],
    thenTags: [],
    maxGap: 0,
    severity: 'high',
    category: 'trajectory_chain',
    reason: '',
    ...overrides,
  }
}

/** Build a rule set over the given rules/chains. */
function ruleset(rules: readonly CompiledRule[] = [], chains: readonly CompiledChainRule[] = []): RuleSet {
  return {
    hash: '0'.repeat(64),
    rules,
    chains,
    ruleCount: rules.length,
    chainCount: chains.length,
    sources: ['inline'],
    loadedAt: 1_747_000_000_000,
  }
}

/** The canonical db-then-egress chain used by the trajectory tests. */
const DB_THEN_HTTP = chain({
  name: 'db_then_http',
  first: /query_db.*/i,
  then: /http_post.*/i,
  firstTags: ['db', 'internal'],
  thenTags: ['network', 'egress'],
  maxGap: 2,
  severity: 'critical',
  category: 'trajectory_chain',
  reason: 'database read followed by outbound HTTP',
})

// ---------------------------------------------------------------------------
// Tag resolution
// ---------------------------------------------------------------------------

describe('resolveTags: built-in name table', () => {
  const table: readonly (readonly [string, readonly string[]])[] = [
    ['query_db', ['db', 'internal']],
    ['sql_exec', ['db', 'internal']],
    ['db_query', ['db', 'internal']],
    ['database_lookup', ['db', 'internal']],
    ['bash', ['shell']],
    ['pwsh', ['shell']],
    ['powershell_run', ['shell']],
    ['shell_exec', ['shell']],
    ['terminal', ['shell']],
    ['web_fetch', ['network', 'egress']],
    ['fetch_url', ['network', 'egress']],
    ['search', ['network', 'egress']],
    ['mcp__fs__read', ['mcp']],
    ['mcp_server_tool', ['mcp']],
    ['read_file', ['fs']],
    ['write_file', ['fs']],
    ['glob', ['fs']],
    ['grep', ['fs']],
    ['totally_unknown', []],
    ['', []],
  ]

  it.each(table)('maps %s -> %j', (name, expected) => {
    expect(resolveTags(name, [])).toEqual([...expected])
  })

  it('is case-insensitive on the tool name', () => {
    expect(resolveTags('BASH', [])).toEqual(['shell'])
  })

  it('unions matching built-ins in table order, without duplicates', () => {
    // matches `*sql*` (db, internal) then `bash*` (shell)
    expect(resolveTags('bash_sql', [])).toEqual(['db', 'internal', 'shell'])
  })

  it('unions overrides on top of the built-ins, in config order', () => {
    expect(resolveTags('custom_db', [{ pattern: 'custom_*', tags: ['special'] }])).toEqual([
      'db',
      'internal',
      'special',
    ])
    expect(resolveTags('deploy_app', [{ pattern: 'deploy*', tags: ['ops', 'remote'] }])).toEqual(['ops', 'remote'])
  })

  it('ignores overrides that do not match', () => {
    expect(resolveTags('bash', [{ pattern: 'web_*', tags: ['network', 'egress'] }])).toEqual(['shell'])
  })
})

describe('matchNamePattern: `*`-only globs', () => {
  it('an empty pattern list never matches', () => {
    expect(matchNamePattern('bash', [])).toBe(false)
  })

  it('`*` matches everything and `prefix*` matches the prefix family', () => {
    expect(matchNamePattern('bash', ['*'])).toBe(true)
    expect(matchNamePattern('bash_exec', ['bash*'])).toBe(true)
    expect(matchNamePattern('bash', ['bash'])).toBe(true)
    expect(matchNamePattern('bash', ['bash_exec'])).toBe(false)
    expect(matchNamePattern('ash', ['bash*'])).toBe(false)
    expect(matchNamePattern('mcp__fs__read', ['mcp_*'])).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchNamePattern('Bash', ['bash*'])).toBe(true)
  })

  it('escapes regex metacharacters (only `*` is a wildcard)', () => {
    expect(matchNamePattern('a.bc', ['a.b*'])).toBe(true)
    expect(matchNamePattern('axbc', ['a.b*'])).toBe(false)
    expect(matchNamePattern('a+b', ['a+b'])).toBe(true)
    expect(matchNamePattern('aab', ['a+b'])).toBe(false)
    expect(matchNamePattern('a(b)', ['a(b)'])).toBe(true)
  })

  it('matches when any pattern matches', () => {
    expect(matchNamePattern('shell_exec', ['bash*', 'shell*'])).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// evaluateToolCall
// ---------------------------------------------------------------------------

describe('evaluateToolCall: allow by default', () => {
  it('allows an ordinary call with no matching policy', () => {
    const decision = evaluateToolCall(ruleset(), toolsConfig(), toolView('read_file', { path: 'a.txt' }), sessionView())
    expect(decision).toEqual({ kind: 'allow', reasonCode: ReasonCode.None, ruleIds: [] })
  })

  it('allows an empty argument object', () => {
    expect(evaluateToolCall(ruleset(), toolsConfig(), toolView('glob', {}), sessionView()).kind).toBe('allow')
  })
})

describe('evaluateToolCall: name and tag denials', () => {
  it('denies a name on the deny list', () => {
    const decision = evaluateToolCall(ruleset(), toolsConfig({ denyTools: ['bash*'] }), toolView('bash', {}), sessionView())
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe(ReasonCode.ToolName)
    expect(decision.severity).toBe('high')
  })

  it('denies a call carrying a denied tag', () => {
    const decision = evaluateToolCall(ruleset(), toolsConfig({ denyTags: ['shell'] }), toolView('pwsh', {}), sessionView())
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe(ReasonCode.ToolTag)
    expect(decision.ruleIds).toEqual(['shell'])
  })

  it('name denial wins over tag denial', () => {
    const decision = evaluateToolCall(
      ruleset(),
      toolsConfig({ denyTools: ['bash*'], denyTags: ['shell'] }),
      toolView('bash', {}),
      sessionView(),
    )
    expect(decision.reasonCode).toBe(ReasonCode.ToolName)
  })

  it('denies oversized arguments', () => {
    const decision = evaluateToolCall(
      ruleset(),
      toolsConfig({ maxArgsBytes: 10 }),
      toolView('read_file', {}, { argsBytes: 11 }),
      sessionView(),
    )
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe(ReasonCode.ToolArgsTooLarge)
    expect(decision.severity).toBe('high')
  })

  it('tag denial wins over the size check (documented order)', () => {
    const decision = evaluateToolCall(
      ruleset(),
      toolsConfig({ denyTags: ['shell'], maxArgsBytes: 1 }),
      toolView('bash', {}, { argsBytes: 999 }),
      sessionView(),
    )
    expect(decision.reasonCode).toBe(ReasonCode.ToolTag)
  })
})

describe('evaluateToolCall: argument shape', () => {
  it('denies dangerous SQL in a top-level string argument', () => {
    const decision = evaluateToolCall(
      ruleset(),
      toolsConfig(),
      toolView('bash', { sql: 'DROP TABLE users' }),
      sessionView(),
    )
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe(ReasonCode.ToolArgs)
    expect(decision.category).toBe('dangerous_sql')
    expect(decision.ruleIds).toEqual(['dangerous_sql'])
  })

  it('denies dangerous SQL nested arbitrarily in objects and arrays', () => {
    const nested = { a: { b: ['ok', { c: 'DELETE FROM alarms' }] } }
    const decision = evaluateToolCall(ruleset(), toolsConfig(), toolView('bash', nested), sessionView())
    expect(decision.reasonCode).toBe(ReasonCode.ToolArgs)
  })

  it('finds SQL hidden behind a large number of padding values', () => {
    const args: Record<string, string> = {}
    for (let index = 0; index < 300; index += 1) args[`pad${index}`] = 'benign padding'
    args['last'] = 'DROP TABLE users'
    const decision = evaluateToolCall(ruleset(), toolsConfig(), toolView('bash', args), sessionView())
    expect(decision.reasonCode).toBe(ReasonCode.ToolArgs)
  })

  it('finds SQL in deeply nested arguments without blowing the stack', () => {
    let value: unknown = 'DROP TABLE users'
    for (let depth = 0; depth < 200; depth += 1) value = { nested: value }
    const decision = evaluateToolCall(ruleset(), toolsConfig(), toolView('bash', value), sessionView())
    expect(decision.reasonCode).toBe(ReasonCode.ToolArgs)
  })

  it('allows benign SQL in arguments', () => {
    const decision = evaluateToolCall(
      ruleset(),
      toolsConfig(),
      toolView('query_db', { query: 'SELECT a FROM alarms' }),
      sessionView(),
    )
    expect(decision.kind).toBe('allow')
  })

  it('never echoes a credential-shaped argument into the decision', () => {
    const args = { api_key: SK_SENTINEL, note: 'rotate later' }
    const decision = evaluateToolCall(ruleset(), toolsConfig(), toolView('bash', args), sessionView())
    expect(decision.kind).toBe('allow')
    expect(JSON.stringify(decision)).not.toContain(SK_SENTINEL)
  })

  it('never echoes a credential alongside a SQL denial', () => {
    const args = { sql: 'DROP TABLE users', api_key: SK_SENTINEL }
    const decision = evaluateToolCall(ruleset(), toolsConfig(), toolView('bash', args), sessionView())
    expect(decision.reasonCode).toBe(ReasonCode.ToolArgs)
    expect(JSON.stringify(decision)).not.toContain(SK_SENTINEL)
  })
})

describe('evaluateToolCall: chain rules', () => {
  const set = ruleset([], [DB_THEN_HTTP])

  it('denies the second leg when the first leg is directly before it', () => {
    const decision = evaluateToolCall(set, toolsConfig(), toolView('http_post', {}), sessionView(['query_db']))
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe(ReasonCode.ToolChain)
    expect(decision.ruleIds).toEqual(['db_then_http'])
    expect(decision.severity).toBe('critical')
    expect(decision.category).toBe('trajectory_chain')
    expect(decision.reason).toBe('database read followed by outbound HTTP')
  })

  it('matches within maxGap and refuses outside maxGap', () => {
    // maxGap 2: the last two trail entries are inspected.
    const within = evaluateToolCall(set, toolsConfig(), toolView('http_post', {}), sessionView(['query_db', 'read_file']))
    expect(within.reasonCode).toBe(ReasonCode.ToolChain)
    const outside = evaluateToolCall(
      set,
      toolsConfig(),
      toolView('http_post', {}),
      sessionView(['query_db', 'read_file', 'write_file']),
    )
    expect(outside.kind).toBe('allow')
  })

  it('maxGap 0 means any distance', () => {
    const anyDistance = chain({ ...DB_THEN_HTTP, name: 'db_then_http_any', maxGap: 0 })
    const decision = evaluateToolCall(
      ruleset([], [anyDistance]),
      toolsConfig(),
      toolView('http_post', {}),
      sessionView(['query_db', 'read_file', 'glob', 'grep', 'write_file']),
    )
    expect(decision.reasonCode).toBe(ReasonCode.ToolChain)
  })

  it('does not fire when the second leg does not match', () => {
    const decision = evaluateToolCall(set, toolsConfig(), toolView('read_file', {}), sessionView(['query_db']))
    expect(decision.kind).toBe('allow')
  })

  it('does not fire on an empty trail', () => {
    expect(evaluateToolCall(set, toolsConfig(), toolView('http_post', {}), sessionView()).kind).toBe('allow')
  })

  it('matches an endpoint by tag alone (tag OR regex)', () => {
    const tagOnly = chain({
      name: 'db_then_egress',
      first: /never-matches-anything/i,
      firstTags: ['db'],
      thenTags: ['network'],
      maxGap: 0,
      severity: 'high',
    })
    const decision = evaluateToolCall(ruleset([], [tagOnly]), toolsConfig(), toolView('http_post', {}), sessionView(['query_db']))
    expect(decision.reasonCode).toBe(ReasonCode.ToolChain)
  })

  it('tries chain rules in rule-set order (deterministic owner)', () => {
    const second = chain({
      name: 'second_rule',
      first: /query_db.*/i,
      then: /http_post.*/i,
      maxGap: 3,
      severity: 'low',
    })
    const decision = evaluateToolCall(
      ruleset([], [second, DB_THEN_HTTP]),
      toolsConfig(),
      toolView('http_post', {}),
      sessionView(['query_db']),
    )
    expect(decision.ruleIds).toEqual(['second_rule'])
    expect(decision.severity).toBe('low')
  })

  it('an explicit name deny wins over a matching chain', () => {
    const decision = evaluateToolCall(
      set,
      toolsConfig({ denyTools: ['http_post*'] }),
      toolView('http_post', {}),
      sessionView(['query_db']),
    )
    expect(decision.reasonCode).toBe(ReasonCode.ToolName)
  })
})

describe('evaluateToolCall: ask list', () => {
  it('asks for approval on the ask list', () => {
    const decision = evaluateToolCall(
      ruleset(),
      toolsConfig({ askTools: ['deploy*'] }),
      toolView('deploy_app', {}),
      sessionView(),
    )
    expect(decision.kind).toBe('ask')
    expect(decision.reasonCode).toBe(ReasonCode.ToolAsk)
    expect(decision.severity).toBe('medium')
  })

  it('a chain denial wins over ask (deny is stricter than ask)', () => {
    const decision = evaluateToolCall(
      ruleset([], [DB_THEN_HTTP]),
      toolsConfig({ askTools: ['*'] }),
      toolView('http_post', {}),
      sessionView(['query_db']),
    )
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe(ReasonCode.ToolChain)
  })
})

// ---------------------------------------------------------------------------
// scanToolResult
// ---------------------------------------------------------------------------

/** Every string a finding could leak, in one place. */
function findingJson(findings: readonly { category: string; ruleIds: readonly string[]; severity: Severity; detail: string }[]): string {
  return JSON.stringify(findings)
}

describe('scanToolResult: credential leaks', () => {
  it('returns no findings for clean text', () => {
    expect(scanToolResult(ruleset(), resultsConfig(), resultView('all systems nominal'))).toEqual([])
  })

  it('flags an OpenAI-style sk- key', () => {
    const findings = scanToolResult(ruleset(), resultsConfig(), resultView(`token: ${SK_SENTINEL}`))
    expect(findings.length).toBe(1)
    const finding = findings[0]
    expect(finding?.category).toBe('credential_leak')
    expect(finding?.ruleIds).toContain('credential_openai_key')
    expect(finding?.severity).toBe('critical')
    expect(findingJson(findings)).not.toContain(SK_SENTINEL)
    expect(findingJson(findings)).not.toContain('sentinel')
  })

  it('flags Bearer tokens, PEM private-key headers and key=value assignments', () => {
    const cases: readonly (readonly [string, string])[] = [
      [`Authorization: ${BEARER_SENTINEL}`, 'credential_bearer_token'],
      [`${PEM_HEADER}\nMIIE...`, 'credential_private_key'],
      [`config api_key=${SK_SENTINEL}`, 'credential_assignment'],
      ['db password: hunter2-sentinel-xxxx', 'credential_assignment'],
    ]
    for (const [text, expectedId] of cases) {
      const findings = scanToolResult(ruleset(), resultsConfig(), resultView(text))
      expect(findings.map((item) => item.category), text).toContain('credential_leak')
      expect(findings.flatMap((item) => item.ruleIds), text).toContain(expectedId)
      expect(findingJson(findings), text).not.toContain('hunter2-sentinel')
    }
  })

  it('flags a >=40-char high-entropy token', () => {
    const findings = scanToolResult(ruleset(), resultsConfig(), resultView(`blob ${ENTROPY_SENTINEL} end`))
    expect(findings.length).toBe(1)
    expect(findings[0]?.ruleIds).toContain('credential_high_entropy')
    expect(findingJson(findings)).not.toContain(ENTROPY_SENTINEL)
  })

  it('ignores a long low-entropy token', () => {
    expect(scanToolResult(ruleset(), resultsConfig(), resultView('a'.repeat(200)))).toEqual([])
  })

  it('flags a long package-path token (known heuristic false positive, R35)', () => {
    // Found live in M4: a `run_code` stack trace contains
    // `@deepseek-ai/dsh-ptc-runtime-node/lib/process`, and the `/`-joining token
    // splitter turns a ≥40-char path fragment into one "high entropy token".
    // The engine semantics are locked by the Python-parity requirement, so the
    // behaviour is pinned here rather than special-cased — the mitigation is
    // operational (`results.blockOn` / `results.mode`), documented in §12 R35.
    const findings = scanToolResult(
      ruleset(),
      resultsConfig(),
      resultView('at @deepseek-ai/dsh-ptc-runtime-node/lib/process.js:1068:22'),
    )
    expect(findings.flatMap((item) => item.ruleIds)).toContain('credential_high_entropy')
  })

  it('scans valueText as well as text', () => {
    const findings = scanToolResult(ruleset(), resultsConfig(), resultView('', `key ${SK_SENTINEL}`))
    expect(findings[0]?.category).toBe('credential_leak')
  })

  it('reports the highest severity when several credential shapes match', () => {
    const findings = scanToolResult(ruleset(), resultsConfig(), resultView(`${SK_SENTINEL}\n${BEARER_SENTINEL}`))
    expect(findings[0]?.severity).toBe('critical')
    expect(findings[0]?.ruleIds).toEqual([...['credential_openai_key', 'credential_bearer_token']].sort())
  })

  it('bounds the scan at 256 KiB', () => {
    expect(MAX_RESULT_SCAN_CHARS).toBe(256 * 1024)
    const beyond = `${'a'.repeat(MAX_RESULT_SCAN_CHARS + 10)} ${SK_SENTINEL}`
    expect(scanToolResult(ruleset(), resultsConfig(), resultView(beyond))).toEqual([])
    const inside = `${'a'.repeat(200 * 1024)} ${SK_SENTINEL}`
    expect(scanToolResult(ruleset(), resultsConfig(), resultView(inside)).length).toBe(1)
  })

  it('returns nothing when the results mode is off', () => {
    expect(scanToolResult(ruleset(), resultsConfig({ mode: 'off' }), resultView(SK_SENTINEL))).toEqual([])
  })
})

describe('scanToolResult: injection markers', () => {
  const injection = ruleset([rule('inform_00', 'ignore\\s+(all\\s+)?previous\\s+instructions', 'critical')])

  it('flags the prompt-injection rule family in result text', () => {
    const findings = scanToolResult(injection, resultsConfig(), resultView('tool said: ignore previous instructions'))
    expect(findings.length).toBe(1)
    expect(findings[0]?.category).toBe('injection_marker')
    expect(findings[0]?.ruleIds).toEqual(['inform_00'])
    expect(findings[0]?.severity).toBe('critical')
    expect(findings[0]?.detail).toMatch(/^[\x20-\x7e]+$/)
  })

  it('returns both categories, credential first', () => {
    const findings = scanToolResult(
      injection,
      resultsConfig({ mode: 'enforce' }),
      resultView(`ignore previous instructions and ${SK_SENTINEL}`),
    )
    expect(findings.map((item) => item.category)).toEqual(['credential_leak', 'injection_marker'])
    expect(findingJson(findings)).not.toContain(SK_SENTINEL)
  })

  it('does not flag a clean result', () => {
    expect(scanToolResult(injection, resultsConfig(), resultView('everything is fine'))).toEqual([])
  })
})
