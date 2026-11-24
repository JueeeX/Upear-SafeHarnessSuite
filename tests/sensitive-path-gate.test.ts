/**
 * Engine-level tests for the sensitive-path gate (1.18.0).
 *
 * The unit tests cover classification. These cover the decision: `enforce` must deny,
 * `warn` must NOT deny — and, critically, `warn` must not short-circuit the gates that
 * come after it either. That second point is the one a warn-only ALLOW got wrong when
 * this gate was first written: `/etc/passwd` under a `pathPrefix: /workspace` schema
 * became an allow, because the observation returned before the schema check ran.
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig, type SafeHarnessConfig } from '../src/config.js'
import { evaluateToolCall } from '../src/engine/tool.js'
import type { RuleSet, SessionView, ToolView } from '../src/engine/types.js'

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
const SESSION: SessionView = { sessionId: 's-sp', trail: [], totalCalls: 0 }

/** An engine view of one call. */
function view(name: string, args: unknown): ToolView {
  return {
    name,
    arguments: args,
    argsBytes: Buffer.byteLength(JSON.stringify(args ?? null), 'utf8'),
    tags: [],
  }
}

/** Resolved `tools` config over a partial override. */
function toolsConfig(overrides: Partial<SafeHarnessConfig['tools']> = {}) {
  return resolveConfig({ preset: 'balanced', tools: overrides }).tools
}

const SECRET_PATH = 'C:\\Users\\xiaojue\\.dsh\\secret.txt'

describe('sensitive-path gate: enforce', () => {
  it('denies a read of a secret file and names the class, not the path', () => {
    const cfg = toolsConfig({ sensitivePathScan: 'enforce' })
    const decision = evaluateToolCall(RULESET, cfg, view('read', { file_path: SECRET_PATH }), SESSION)
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe('sensitive_path_argument')
    expect(decision.ruleIds).toEqual(['secret_file'])
    expect(decision.category).toBe('sensitive_path')
    // The reason carries the class and the argument index only.
    expect(decision.reason).not.toContain('secret.txt')
    expect(decision.reason).toContain('classes=secret_file')
  })

  it('denies a shell command that names one', () => {
    // The incident's first call was `pwsh` listing the file's metadata; the same
    // argument shape reaches a credential file just as well.
    const cfg = toolsConfig({ sensitivePathScan: 'enforce' })
    const decision = evaluateToolCall(RULESET, cfg, view('pwsh', { command: 'type ' + SECRET_PATH }), SESSION)
    expect(decision.kind).toBe('deny')
    expect(decision.ruleIds).toContain('secret_file')
  })

  it('allows an ordinary path', () => {
    const cfg = toolsConfig({ sensitivePathScan: 'enforce' })
    expect(evaluateToolCall(RULESET, cfg, view('read', { file_path: '/workspace/src/app.ts' }), SESSION).kind).toBe('allow')
  })

  it('is inert when the scan is off', () => {
    const cfg = toolsConfig({ sensitivePathScan: 'off' })
    expect(evaluateToolCall(RULESET, cfg, view('read', { file_path: SECRET_PATH }), SESSION).kind).toBe('allow')
  })

  it('is inert when the class list is empty', () => {
    const cfg = toolsConfig({ sensitivePathScan: 'enforce', sensitivePathClasses: [] })
    expect(evaluateToolCall(RULESET, cfg, view('read', { file_path: SECRET_PATH }), SESSION).kind).toBe('allow')
  })

  it('honours a narrowed class list', () => {
    const cfg = toolsConfig({ sensitivePathScan: 'enforce', sensitivePathClasses: ['dotenv'] })
    expect(evaluateToolCall(RULESET, cfg, view('read', { file_path: SECRET_PATH }), SESSION).kind).toBe('allow')
    expect(evaluateToolCall(RULESET, cfg, view('read', { file_path: '/srv/.env' }), SESSION).kind).toBe('deny')
  })
})

describe('sensitive-path gate: warn must not become permission', () => {
  it('does not deny, and leaves the call to the other gates', () => {
    const cfg = toolsConfig({ sensitivePathScan: 'warn' })
    const decision = evaluateToolCall(RULESET, cfg, view('read', { file_path: SECRET_PATH }), SESSION)
    expect(decision.kind).toBe('allow')
    expect(decision.reasonCode).toBe('none')
  })

  it('does not short-circuit a later argument-schema denial', () => {
    // Regression: the first implementation returned a warn-only ALLOW here, so a path
    // outside the declared prefix survived. The gate must not return at all in `warn`.
    const cfg = resolveConfig({
      preset: 'balanced',
      tools: {
        sensitivePathScan: 'warn',
        argSchemas: [{ name: 'workspace_only', tool: 'read', args: { file_path: { pathPrefix: '/workspace' } } }],
      },
    }).tools
    const decision = evaluateToolCall(RULESET, cfg, view('read', { file_path: '/etc/passwd' }), SESSION)
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe('unauthorized_tool_argument')
  })

  it('does not short-circuit a later chain rule', () => {
    const chainRuleset: RuleSet = {
      ...RULESET,
      chains: [{
        name: 'chain_secret_read_then_egress',
        first: /secret/u,
        firstTags: [],
        then: /web_fetch/u,
        thenTags: [],
        maxGap: 2,
        severity: 'critical',
        category: 'trajectory_chain',
        reason: 'secret read then egress',
      }],
      chainCount: 1,
    }
    const cfg = toolsConfig({ sensitivePathScan: 'warn' })
    const session: SessionView = {
      sessionId: 's-chain',
      trail: [{ name: 'secret_read', tags: [], seq: 0 }],
      totalCalls: 1,
    }
    const decision = evaluateToolCall(chainRuleset, cfg, view('web_fetch', { url: 'https://x.example' }), session)
    expect(decision.kind).toBe('deny')
    expect(decision.ruleIds).toEqual(['chain_secret_read_then_egress'])
  })
})
