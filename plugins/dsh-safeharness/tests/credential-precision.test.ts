/**
 * `credential_assignment` precision: source code must stay readable (1.16.1).
 *
 * The rule exists because a real 14-char relay key was echoed in an answer
 * (2026-11-19). Its value-shaped alternatives are deliberately permissive, which is
 * why the repository's OWN sources kept tripping it: a `const secret = readSecret(…)`
 * declaration, a `"…": "${FAKE_KEY}"` test fixture and the plugin's own
 * `[REDACTED:credential]` placeholder all look like `name = <long token>`.
 *
 * Under `results.mode: enforce` + `blockOn: ['credential_leak']` that meant
 * **maintaining the plugin required fighting the plugin**: `edit` was reported as
 * blocked (after it had already written), and `read`/`grep` returned the block text
 * instead of the file. Fixing the false positive is what makes the true positive
 * usable.
 *
 * The fix is a tail guard on the unquoted alternative (the value must not be
 * immediately followed by `(`, i.e. it is a call target, not a literal) plus two
 * prefix exemptions on the quoted alternatives (`${…}` template placeholders and the
 * `[REDACTED` placeholder this plugin itself writes).
 *
 * Every fake key here is assembled at runtime: a literal one would be caught by this
 * very rule when the file is read back (see handoff §13).
 */
import { describe, expect, it } from 'vitest'
import { scanCredentialLeaks } from '../src/engine/tool.js'

/** A 24-char fake token, built at runtime so the file itself carries no literal. */
const FAKE_TOKEN = ['Kq7', 'Zr2', 'Wm9', 'Tb4', 'Lc6', 'Yd8'].join('')

describe('credential_assignment does not fire on source code', () => {
  it('ignores a declaration whose value is a call', () => {
    // The shape that started this: `const secret = readSecret(entry.secret, …)`.
    expect(scanCredentialLeaks(`const secret = readField(entry.secret, problems)`).ruleIds).toEqual([])
    expect(scanCredentialLeaks(`const accessToken = requireString(entry.accessToken)`).ruleIds).toEqual([])
    expect(scanCredentialLeaks(`const apiKey = lookupApiKey()`).ruleIds).toEqual([])
  })

  it('ignores a binding pattern; identifiers after a keyword are not secrets', () => {
    // `entry.secret` is a property read, not a value: the tail guard alone does not
    // help here, the dotted-reference lookahead does.
    expect(scanCredentialLeaks(`const { secret } = entry`).ruleIds).toEqual([])
    expect(scanCredentialLeaks(`password: entry.password,`).ruleIds).toEqual([])
  })

  it('ignores a template placeholder inside a quoted value', () => {
    // `"…": "${FAKE_KEY}"` is a fixture that assembles a key at runtime; the value
    // that reaches the model is the literal placeholder, not a secret.
    expect(scanCredentialLeaks('{"llm_api_key": "${FAKE_TOKEN}"}').ruleIds).toEqual([])
    expect(scanCredentialLeaks(`{"relay_api_key": '${'$'}{OTHER}'}`).ruleIds).toEqual([])
  })

  it('ignores this plugin’s own redaction placeholder', () => {
    expect(scanCredentialLeaks('{"llm_api_key": "[REDACTED:credential]"}').ruleIds).toEqual([])
    expect(scanCredentialLeaks(`{'api_key': '[REDACTED:credential]'}`).ruleIds).toEqual([])
  })
})

describe('credential_assignment still catches the real shapes', () => {
  it('catches a quoted literal value', () => {
    const leak = `{"llm_api_key": "${FAKE_TOKEN}"}`
    expect(scanCredentialLeaks(leak).ruleIds).toContain('credential_assignment')
  })

  it('catches an unquoted literal value', () => {
    const leak = `llm_api_key: ${FAKE_TOKEN}`
    expect(scanCredentialLeaks(leak).ruleIds).toContain('credential_assignment')
  })

  it('catches a quoted literal that merely looks like a placeholder', () => {
    // Only a value that STARTS with `${` is exempt; a real token containing `{`
    // somewhere else is still a token.
    const leak = `{"api_key": "${FAKE_TOKEN}{x}"}`
    expect(scanCredentialLeaks(leak).ruleIds).toContain('credential_assignment')
  })

  it('catches a value that is a bare word longer than 8 chars', () => {
    // The tail guard only refuses `(`, not ordinary prose.
    const leak = `password: hunter2hunter2`
    expect(scanCredentialLeaks(leak).ruleIds).toContain('credential_assignment')
  })
})
