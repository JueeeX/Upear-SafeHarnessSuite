/**
 * The audit vocabulary is one closed list.
 *
 * `AuditKind` derives from `AUDIT_KINDS`, and `safeharness_audit_query` takes its
 * parameter enum from the same array — 1.9.0 shipped `rules_written` into the
 * ledger while the tool still carried its own copy of the list, so filtering by
 * the new kind was rejected. These assertions pin the single source of truth, and
 * `tests/hooks.test.ts` additionally pins the tool's enum to this array.
 */
import { describe, expect, it } from 'vitest'
import { AUDIT_KINDS } from '../src/audit/types.js'

describe('AUDIT_KINDS', () => {
  it('is unique and closed', () => {
    expect(new Set(AUDIT_KINDS).size).toBe(AUDIT_KINDS.length)
    expect(AUDIT_KINDS.length).toBeGreaterThanOrEqual(20)
  })

  it('includes the rule-lifecycle kinds the ledger actually writes', () => {
    expect(AUDIT_KINDS).toContain('rules_reloaded')
    expect(AUDIT_KINDS).toContain('rules_written')
  })
})
