/**
 * Per-tool argument schemas (1.16.0): the argument-schema half of the kernel's
 * `policies/constrain.py`.
 *
 * What is ported, in kernel terms:
 *  - `_schema.py#validate_arguments` refuses a call whose arguments do not satisfy
 *    the declared shape (`invalid_tool_arguments`). Here that becomes
 *    `unauthorized_tool_argument`, and "shape" means one of a fixed set of bounds
 *    (pattern / enum / byte size / path prefix / URL scheme / command allowlist)
 *    rather than a JSON-Schema engine.
 *  - The **catalog** half (`ToolCatalog.resolve` → `unknown_tool`) has no DSH
 *    equivalent and stays with `tools.denyTools` / `denyTags`.
 *  - The **capability authority** half is the forged-token world this package does
 *    not reproduce (MANUAL §8).
 *
 * Three properties this file exists to pin, because each has already been a bug
 * somewhere in this package's history:
 *  1. a declaration that cannot compile is **reported**, never silently dropped;
 *  2. a violation **never** carries the offending value anywhere a record could see
 *     it (only schema id + argument name + constraint kind);
 *  3. the pattern gate is the **same** ReDoS gate the rule loader uses, because a
 *     schema pattern is matched against up to `tools.maxArgsBytes` of model text.
 */
import { describe, expect, it } from 'vitest'
import { resolveConfig, type SafeHarnessConfig } from '../src/config.js'
import {
  checkArgSchema,
  compileArgSchemas,
  MAX_ARG_SCHEMAS,
  MAX_PATTERN_CHARS,
} from '../src/engine/argschema.js'
import { evaluateToolCall } from '../src/engine/tool.js'
import { ReasonCode } from '../src/engine/types.js'
import type { RuleSet, SessionView, ToolView } from '../src/engine/types.js'

/** No rules and no chains: an argument schema is independent of the rule set. */
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
const SESSION: SessionView = { sessionId: 's-argschema', trail: [], totalCalls: 0 }

/** An engine view of one call; `argsBytes` is the canonical JSON size. */
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

/** A config carrying exactly one argument schema. */
function cfgWith(schema: Record<string, unknown>) {
  return toolsConfig({ argSchemas: [schema] } as never)
}

describe('tools.argSchemas: compilation', () => {
  it('compiles nothing when the operator declared nothing', () => {
    const cfg = toolsConfig()
    expect(cfg.argSchemas).toEqual([])
    expect(resolveConfig({ preset: 'balanced' }).argSchemaProblems).toEqual([])
  })

  it('names an unnamed schema by its index so a denial is still attributable', () => {
    const { entries } = compileArgSchemas([
      { tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } } as never,
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]?.name).toBe('arg_schema_0')
  })

  it('refuses an unknown keyword instead of ignoring it', () => {
    // An operator who writes `regex:` instead of `pattern:` must not get a schema
    // that compiles to nothing and silently checks nothing.
    const { entries, problems } = compileArgSchemas([
      { name: 'fs_write_path', tool: 'fs_write*', args: { path: { regex: '^/workspace/.+' } } } as never,
    ])
    expect(entries).toEqual([])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('unsupported keyword')
    expect(problems[0]).toContain('regex')
  })

  it('refuses an argument that declares no bound at all', () => {
    const { problems } = compileArgSchemas([
      { name: 'empty', tool: 'fs_write*', args: { path: {} } } as never,
    ])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('needs at least one bound')
  })

  it(`caps the schema count at ${MAX_ARG_SCHEMAS}`, () => {
    const tooMany = Array.from({ length: MAX_ARG_SCHEMAS + 1 }, (_, index) => ({
      name: `s${index}`,
      tool: `tool${index}`,
      args: { path: { maxBytes: 10 } },
    }))
    const { entries, problems } = compileArgSchemas(tooMany as never)
    expect(entries).toEqual([])
    expect(problems[0]).toContain('at most')
  })

  it('drops the bad declaration and keeps the good ones', () => {
    // The fail-loud rule for this surface is per declaration: one typo must not
    // switch off every other schema, but it must be reported.
    const { entries, problems } = compileArgSchemas([
      { name: 'good', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } },
      { name: 'bad', tool: 'fs_write*', args: { path: { pattern: '' } } },
      { name: 'also_good', tool: 'http_*', args: { url: { urlScheme: ['https'] } } },
    ] as never)
    expect(entries.map((entry) => entry.name)).toEqual(['good', 'also_good'])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('bad')
  })

  it('lets resolveConfig keep loading when a schema is unusable', () => {
    // A malformed *config* refuses the load; an unusable *optional schema* does not.
    // Conflating the two would turn one typo into "the plugin will not start".
    const cfg = resolveConfig({
      preset: 'balanced',
      tools: { argSchemas: [{ name: 'bad', tool: 'fs_*', args: { path: { enum: [] } } }] } as never,
    })
    expect(cfg.tools.argSchemas).toEqual([])
    expect(cfg.argSchemaProblems).toHaveLength(1)
  })

  it('caches one compile per declaration array identity', () => {
    const declarations = [
      { name: 'cached', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } },
    ] as never
    const first = compileArgSchemas(declarations)
    const second = compileArgSchemas(declarations)
    expect(second).toBe(first)
  })
})

describe('tools.argSchemas: pattern bound', () => {
  it('accepts a value that matches and refuses one that does not', () => {
    const cfg = cfgWith({ name: 'ticket_id', tool: 'issue_*', args: { id: { pattern: '^[A-Z]{2}-\\d{4}$' } } })
    expect(evaluateToolCall(RULESET, cfg, view('issue_get', { id: 'AB-1234' }), SESSION).kind).toBe('allow')
    const denied = evaluateToolCall(RULESET, cfg, view('issue_get', { id: 'AB-12' }), SESSION)
    expect(denied.kind).toBe('deny')
    expect(denied.reasonCode).toBe(ReasonCode.ToolArgument)
    expect(denied.ruleIds).toEqual(['ticket_id'])
    expect(denied.category).toBe('tool_argument')
  })

  it('uses the rule loader gate, so a ReDoS shape is refused at compile time', () => {
    // The same `(a+)+` the rule loader refuses: this pattern runs per call against
    // up to `tools.maxArgsBytes` of model-controlled text, so the exposure is the
    // same as a rule file's, not milder.
    const { entries, problems } = compileArgSchemas([
      { name: 'redos', tool: 'x*', args: { v: { pattern: '(a+)+' } } } as never,
    ])
    expect(entries).toEqual([])
    expect(problems[0]).toContain('catastrophic backtracking')
  })

  it('refuses Python-only constructs the JS engine cannot reproduce', () => {
    const { problems } = compileArgSchemas([
      { name: 'py', tool: 'x*', args: { v: { pattern: '(?P<n>a)' } } } as never,
    ])
    expect(problems[0]).toContain('rejected by the rule loader')
  })

  it(`caps the pattern source at ${MAX_PATTERN_CHARS} characters`, () => {
    const { problems } = compileArgSchemas([
      { name: 'long', tool: 'x*', args: { v: { pattern: 'a'.repeat(MAX_PATTERN_CHARS + 1) } } } as never,
    ])
    expect(problems[0]).toContain('at most')
  })

  it('repeated tests are stateless (no lastIndex carry-over)', () => {
    const cfg = cfgWith({ name: 'g', tool: 'x*', args: { v: { pattern: 'abc' } } })
    for (let index = 0; index < 3; index += 1) {
      expect(evaluateToolCall(RULESET, cfg, view('x', { v: 'abc' }), SESSION).kind).toBe('allow')
    }
  })
})

describe('tools.argSchemas: size bounds', () => {
  it('refuses a value over maxBytes and accepts one at the bound', () => {
    const cfg = cfgWith({ name: 'note', tool: 'note_*', args: { body: { maxBytes: 8 } } })
    expect(evaluateToolCall(RULESET, cfg, view('note_add', { body: '12345678' }), SESSION).kind).toBe('allow')
    expect(evaluateToolCall(RULESET, cfg, view('note_add', { body: '123456789' }), SESSION).kind).toBe('deny')
  })

  it('counts UTF-8 bytes, not UTF-16 units', () => {
    const cfg = cfgWith({ name: 'note', tool: 'note_*', args: { body: { maxBytes: 8 } } })
    // Four CJK characters are 4 UTF-16 units but 12 UTF-8 bytes: the bound is bytes.
    expect(evaluateToolCall(RULESET, cfg, view('note_add', { body: '一二三四' }), SESSION).kind).toBe('deny')
  })

  it('enforces minBytes', () => {
    const cfg = cfgWith({ name: 'note', tool: 'note_*', args: { body: { minBytes: 4 } } })
    expect(evaluateToolCall(RULESET, cfg, view('note_add', { body: 'abc' }), SESSION).kind).toBe('deny')
    expect(evaluateToolCall(RULESET, cfg, view('note_add', { body: 'abcd' }), SESSION).kind).toBe('allow')
  })
})

describe('tools.argSchemas: path bound', () => {
  it('accepts a path inside the prefix and refuses one outside it', () => {
    const cfg = cfgWith({ name: 'workspace_only', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } })
    expect(evaluateToolCall(RULESET, cfg, view('fs_write', { path: '/workspace/a/b.md' }), SESSION).kind).toBe('allow')
    expect(evaluateToolCall(RULESET, cfg, view('fs_write', { path: '/etc/passwd' }), SESSION).kind).toBe('deny')
  })

  it('refuses a traversal even when the joined path looks contained', () => {
    // `/workspace/../../etc/passwd` normalizes to `/etc/passwd`; a prefix test that
    // only looks at the leading text would pass it. Any `..` segment is refused.
    const cfg = cfgWith({ name: 'workspace_only', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } })
    for (const path of [
      '/workspace/../etc/passwd',
      '/workspace/a/../../etc/passwd',
      '../etc/passwd',
      '/workspace\\..\\..\\etc\\passwd',
    ]) {
      const decision = evaluateToolCall(RULESET, cfg, view('fs_write', { path }), SESSION)
      expect(decision.kind, path).toBe('deny')
    }
  })

  it('does not treat a sibling directory with the same prefix as contained', () => {
    // "/workspace-evil/x" starts with "/workspace" as text but is not under it.
    const cfg = cfgWith({ name: 'workspace_only', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } })
    expect(evaluateToolCall(RULESET, cfg, view('fs_write', { path: '/workspace-evil/x' }), SESSION).kind).toBe('deny')
  })

  it('normalizes Windows separators before comparing', () => {
    const cfg = cfgWith({
      name: 'workspace_only',
      tool: 'fs_write*',
      args: { path: { pathPrefix: 'C:\\work\\ws' } },
    })
    expect(evaluateToolCall(RULESET, cfg, view('fs_write', { path: 'C:\\work\\ws\\a.md' }), SESSION).kind).toBe('allow')
    expect(evaluateToolCall(RULESET, cfg, view('fs_write', { path: 'C:/work/ws/a.md' }), SESSION).kind).toBe('allow')
    expect(evaluateToolCall(RULESET, cfg, view('fs_write', { path: 'C:\\work\\ws-evil\\a.md' }), SESSION).kind).toBe('deny')
  })

  it('refuses a prefix that itself contains a traversal or names the root', () => {
    for (const prefix of ['/workspace/../etc', '/']) {
      const { problems } = compileArgSchemas([
        { name: 'bad_prefix', tool: 'fs_*', args: { path: { pathPrefix: prefix } } } as never,
      ])
      expect(problems.length, prefix).toBeGreaterThan(0)
    }
  })
})

describe('tools.argSchemas: URL bound', () => {
  it('accepts a listed scheme and refuses everything else', () => {
    const cfg = cfgWith({ name: 'https_only', tool: 'http_*', args: { url: { urlScheme: ['https'] } } })
    expect(evaluateToolCall(RULESET, cfg, view('http_get', { url: 'https://example.test/a' }), SESSION).kind).toBe('allow')
    for (const url of [
      'http://example.test/a',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>',
      // The cloud metadata endpoint: the reason this bound exists at all.
      'http://169.254.169.254/latest/meta-data/',
    ]) {
      expect(evaluateToolCall(RULESET, cfg, view('http_get', { url }), SESSION).kind, url).toBe('deny')
    }
  })

  it('refuses a value with no scheme at all', () => {
    const cfg = cfgWith({ name: 'https_only', tool: 'http_*', args: { url: { urlScheme: ['https'] } } })
    expect(evaluateToolCall(RULESET, cfg, view('http_get', { url: 'example.test/a' }), SESSION).kind).toBe('deny')
  })

  it('refuses a scheme list that is not bare scheme names', () => {
    const { problems } = compileArgSchemas([
      { name: 'bad_scheme', tool: 'http_*', args: { url: { urlScheme: ['https://'] } } } as never,
    ])
    expect(problems[0]).toContain('bare scheme names')
  })
})

describe('tools.argSchemas: command bound', () => {
  it('accepts an allowlisted first token and refuses the rest', () => {
    const cfg = cfgWith({ name: 'git_only', tool: 'sh_*', args: { cmd: { commandAllowlist: ['git', 'ls'] } } })
    expect(evaluateToolCall(RULESET, cfg, view('sh_run', { cmd: 'git status' }), SESSION).kind).toBe('allow')
    expect(evaluateToolCall(RULESET, cfg, view('sh_run', { cmd: 'rm -rf /' }), SESSION).kind).toBe('deny')
  })

  it('refuses any shell metacharacter before looking at the first token', () => {
    // "git status; rm -rf /" starts with an allowlisted command but runs a second.
    const cfg = cfgWith({ name: 'git_only', tool: 'sh_*', args: { cmd: { commandAllowlist: ['git'] } } })
    for (const cmd of [
      'git status; rm -rf /',
      'git status && curl http://x',
      'git status | sh',
      'git $(whoami)',
      'git `id`',
      'git status > /etc/passwd',
      'git status\nrm -rf /',
    ]) {
      expect(evaluateToolCall(RULESET, cfg, view('sh_run', { cmd }), SESSION).kind, cmd).toBe('deny')
    }
  })

  it('refuses an environment assignment smuggled in front', () => {
    const cfg = cfgWith({ name: 'git_only', tool: 'sh_*', args: { cmd: { commandAllowlist: ['git'] } } })
    expect(evaluateToolCall(RULESET, cfg, view('sh_run', { cmd: 'LD_PRELOAD=x git status' }), SESSION).kind).toBe('deny')
  })

  it('matches the command case-insensitively', () => {
    const cfg = cfgWith({ name: 'git_only', tool: 'sh_*', args: { cmd: { commandAllowlist: ['git'] } } })
    expect(evaluateToolCall(RULESET, cfg, view('sh_run', { cmd: 'GIT status' }), SESSION).kind).toBe('allow')
  })
})

describe('tools.argSchemas: precedence and shape', () => {
  it('lets denyTools win over an argument schema', () => {
    // Name denial is cheaper and unambiguous; the operator should see that reason.
    const cfg = toolsConfig({
      denyTools: ['fs_*'],
      argSchemas: [{ name: 'workspace_only', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } }],
    } as never)
    const decision = evaluateToolCall(RULESET, cfg, view('fs_write', { path: '/etc/passwd' }), SESSION)
    expect(decision.reasonCode).toBe(ReasonCode.ToolName)
  })

  it('lets the SQL gate win over an argument schema', () => {
    const cfg = toolsConfig({
      argSchemas: [{ name: 'workspace_only', tool: 'db_*', args: { q: { maxBytes: 8 } } }],
    } as never)
    const decision = evaluateToolCall(RULESET, cfg, view('db_query', { q: 'DROP TABLE users' }), SESSION)
    expect(decision.reasonCode).toBe(ReasonCode.ToolArgs)
  })

  it('does not constrain an argument the call did not pass', () => {
    // A schema constrains the shape of what IS passed; making arguments mandatory is
    // the tool's own parameter schema's job, not this control's.
    const cfg = cfgWith({ name: 'workspace_only', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } })
    expect(evaluateToolCall(RULESET, cfg, view('fs_write', { content: 'hi' }), SESSION).kind).toBe('allow')
  })

  it('leaves a tool that no schema names alone', () => {
    const cfg = cfgWith({ name: 'workspace_only', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } })
    expect(evaluateToolCall(RULESET, cfg, view('read', { path: '/etc/passwd' }), SESSION).kind).toBe('allow')
  })

  it('refuses a declared string bound applied to a structured value', () => {
    // A non-string cannot be shown to satisfy a text bound, so it fails closed.
    const cfg = cfgWith({ name: 'paths', tool: 'fs_*', args: { path: { pathPrefix: '/workspace' } } })
    const decision = evaluateToolCall(RULESET, cfg, view('fs_write', { path: { evil: '/etc/passwd' } }), SESSION)
    expect(decision.kind).toBe('deny')
    expect(decision.reasonCode).toBe(ReasonCode.ToolArgument)
  })

  it('uses the first matching schema per tool', () => {
    const cfg = toolsConfig({
      argSchemas: [
        { name: 'first', tool: 'fs_write*', args: { path: { maxBytes: 4 } } },
        { name: 'second', tool: 'fs_*', args: { path: { maxBytes: 1000 } } },
      ],
    } as never)
    const decision = evaluateToolCall(RULESET, cfg, view('fs_write', { path: '/workspace/a.md' }), SESSION)
    expect(decision.ruleIds).toEqual(['first'])
  })

  it('matches the tool by glob, not by exact name', () => {
    const cfg = cfgWith({ name: 'all_fs_writes', tool: 'fs_write*', args: { path: { maxBytes: 4 } } })
    expect(evaluateToolCall(RULESET, cfg, view('fs_write_file', { path: '/workspace/a.md' }), SESSION).kind).toBe('deny')
    expect(evaluateToolCall(RULESET, cfg, view('fs_read_file', { path: '/workspace/a.md' }), SESSION).kind).toBe('allow')
  })

  it('never puts the offending value into the decision', () => {
    const secret = 'ghp_' + 'A'.repeat(36)
    const cfg = cfgWith({ name: 'no_tokens', tool: 'x*', args: { v: { maxBytes: 8 } } })
    const decision = evaluateToolCall(RULESET, cfg, view('x', { v: secret }), SESSION)
    expect(decision.kind).toBe('deny')
    const rendered = JSON.stringify(decision)
    expect(rendered).not.toContain(secret)
    expect(rendered).not.toContain('ghp_')
  })
})

describe('checkArgSchema: direct unit coverage', () => {
  it('reports the argument name and the constraint kind', () => {
    const { entries } = compileArgSchemas([
      { name: 'workspace_only', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } },
    ] as never)
    const entry = entries[0]
    expect(entry).toBeDefined()
    const violation = checkArgSchema(entry as never, { path: '/etc/passwd' })
    expect(violation).toEqual({ schema: 'workspace_only', argument: 'path', constraint: 'pathPrefix' })
  })

  it('returns undefined when every declared argument passes', () => {
    const { entries } = compileArgSchemas([
      { name: 'ok', tool: 'fs_write*', args: { path: { pathPrefix: '/workspace' } } },
    ] as never)
    expect(checkArgSchema(entries[0] as never, { path: '/workspace/a.md' })).toBeUndefined()
  })

  it('refuses a call whose arguments are not an object', () => {
    const { entries } = compileArgSchemas([
      { name: 'needs_object', tool: 'x*', args: { v: { maxBytes: 8 } } },
    ] as never)
    expect(checkArgSchema(entries[0] as never, 'not-an-object')?.constraint).toBe('type')
    expect(checkArgSchema(entries[0] as never, ['a'] as never)?.constraint).toBe('type')
    expect(checkArgSchema(entries[0] as never, null)?.constraint).toBe('type')
  })
})
