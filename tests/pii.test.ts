/**
 * PII classes (1.12.0): the ten patterns ported from the kernel's
 * `memory/sanitizer.py`, applied on the tool-result face.
 *
 * What these tests pin:
 *  - every kernel class still fires on a representative sample, and the reported
 *    id is the kernel's own name (so a ledger row is traceable to the kernel rule);
 *  - the scan never returns matched text, only class names;
 *  - `results.pii: false` / `results.piiClasses` actually gate the scan;
 *  - `pii` is an accepted `results.blockOn` category (blocking stays policy).
 */
import { describe, expect, it } from 'vitest'
import { PII_CLASSES, PII_CLASS_NAMES, scanPii } from '../src/engine/pii.js'
import { resolveConfig } from '../src/config.js'
import { scanToolResult } from '../src/engine/tool.js'
import type { RuleSet, ToolResultView } from '../src/engine/types.js'

/** One rule set with no injection rules: this file is about the PII scan only. */
const EMPTY_RULESET: RuleSet = {
  hash: 'test',
  rules: [],
  chains: [],
  ruleCount: 0,
  chainCount: 0,
  sources: ['test'],
  loadedAt: 0,
}

/** A result view carrying arbitrary text. */
function resultView(text: string): ToolResultView {
  return { name: 'read_file', text, valueText: '', isError: false }
}

describe('scanPii classes', () => {
  const samples: Record<string, string> = {
    id_card: '身份证 11010519491231002X 已登记',
    phone_cn: '联系电话 13812345678',
    email: 'contact: alice@example.com',
    bank_card: '卡号 6222021234567890123',
    api_key: 'Authorization: Bearer abcdefghijklmnopqrstuvwx',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    doc_no: '沪府〔2024〕12号文件',
    gov_serial: '国办发〔2024〕7号',
    customer_id: 'CUST-10245',
    internal_url: 'https://wiki.internal/pages/1',
  }

  it('declares the kernel vocabulary in the kernel order', () => {
    expect(PII_CLASS_NAMES).toEqual([
      'id_card', 'phone_cn', 'email', 'bank_card', 'api_key',
      'jwt', 'doc_no', 'gov_serial', 'customer_id', 'internal_url',
    ])
    expect(PII_CLASSES).toHaveLength(10)
  })

  for (const [name, sample] of Object.entries(samples)) {
    it(`fires ${name} on its kernel sample`, () => {
      expect(scanPii(sample).classes).toContain(name)
    })
  }

  it('returns no class and no severity for clean text', () => {
    expect(scanPii('the build finished in 12s')).toEqual({ classes: [] })
  })

  it('never returns matched text', () => {
    const hit = scanPii(samples.email ?? '')
    expect(hit.classes).toEqual(['email'])
    // The only content-bearing strings on the result are class names; `severity`
    // is a fixed vocabulary word.
    for (const value of hit.classes) expect(PII_CLASS_NAMES).toContain(value)
    expect(hit.severity === undefined || ['high', 'medium'].includes(hit.severity)).toBe(true)
    expect(JSON.stringify(hit)).not.toContain('alice')
  })

  it('honours an explicit class subset', () => {
    const sample = 'alice@example.com / 13812345678'
    expect(scanPii(sample, ['email']).classes).toEqual(['email'])
    expect(scanPii(sample, []).classes).toEqual([])
  })

  it('reports the highest severity across the matched classes', () => {
    // phone (medium) + id_card (high)
    expect(scanPii('13812345678 11010519491231002X').severity).toBe('high')
    expect(scanPii('contact alice@example.com').severity).toBe('medium')
  })
})

describe('pii on the result face', () => {
  it('adds a pii finding when the scan is on', () => {
    const cfg = resolveConfig({ preset: 'balanced' }).results
    expect(cfg.pii).toBe(true)
    const findings = scanToolResult(EMPTY_RULESET, cfg, resultView('mail alice@example.com'))
    const pii = findings.find((item) => item.category === 'pii')
    expect(pii).toBeDefined()
    expect(pii?.ruleIds).toEqual(['email'])
    expect(pii?.detail).not.toContain('alice')
  })

  it('stays silent when results.pii is false', () => {
    const cfg = resolveConfig({ preset: 'balanced', results: { pii: false } }).results
    const findings = scanToolResult(EMPTY_RULESET, cfg, resultView('mail alice@example.com'))
    expect(findings.some((item) => item.category === 'pii')).toBe(false)
  })

  it('honours results.piiClasses', () => {
    const cfg = resolveConfig({ preset: 'balanced', results: { piiClasses: ['id_card'] } }).results
    const findings = scanToolResult(EMPTY_RULESET, cfg, resultView('mail alice@example.com 13812345678'))
    expect(findings.some((item) => item.category === 'pii')).toBe(false)
    const hit = scanToolResult(EMPTY_RULESET, cfg, resultView('11010519491231002X'))
    expect(hit.find((item) => item.category === 'pii')?.ruleIds).toEqual(['id_card'])
  })

  it('accepts pii as a blocking category', () => {
    const cfg = resolveConfig({ preset: 'balanced', results: { mode: 'enforce', blockOn: ['pii'] } }).results
    expect(cfg.blockOn).toContain('pii')
  })

  it('rejects an unknown pii class name at load time', () => {
    expect(() => resolveConfig({ preset: 'balanced', results: { piiClasses: ['passport_number'] } }))
      .toThrow(/piiClasses/)
  })
})
