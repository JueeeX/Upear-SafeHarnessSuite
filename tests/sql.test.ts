/**
 * `src/engine/sql.ts` — port fidelity of `sql_guard.py:inspect_sql`.
 *
 * Every structural expectation in this file was measured by running the **real**
 * Python engine (`safeharness.policies.sql_guard.inspect_sql`, Python 3.13.5) over
 * the same inputs on 2026-11-11; the comments record surprising-but-faithful
 * behaviour so a future "fix" does not silently drift from the golden engine.
 * @module
 */

import { describe, expect, it } from 'vitest'

import { inspectSql } from '../src/engine/sql.js'

describe('inspectSql: destructive statements are dangerous', () => {
  it('DDL: DROP TABLE', () => {
    const verdict = inspectSql('Run this cleanup: DROP TABLE users')
    expect(verdict.isSql).toBe(true)
    expect(verdict.dangerous).toBe(true)
    expect(verdict.statementKinds).toEqual(['ddl'])
    expect(verdict.tables).toEqual(['users'])
    expect(verdict.multiStatement).toBe(false)
    expect(verdict.reasonCode).toBe('dangerous_sql_detected')
    expect(verdict.matchedTable).toBeUndefined()
  })

  it('DDL: TRUNCATE / ALTER / CREATE / RENAME', () => {
    for (const text of [
      'TRUNCATE TABLE incident_tickets',
      'TRUNCATE incident_tickets',
      'ALTER TABLE device_credentials ADD COLUMN stolen TEXT',
      'CREATE TABLE smuggled_data (id INT, payload TEXT)',
      'RENAME TABLE a TO b',
    ]) {
      const verdict = inspectSql(text)
      expect(verdict.dangerous, text).toBe(true)
      expect(verdict.statementKinds, text).toContain('ddl')
    }
  })

  it('write: DELETE with WHERE', () => {
    const verdict = inspectSql('DELETE FROM alarms WHERE 1=1')
    expect(verdict.dangerous).toBe(true)
    expect(verdict.statementKinds).toEqual(['write'])
    expect(verdict.tables).toEqual(['alarms'])
  })

  it('write: DELETE without WHERE is dangerous (the engine has no no-WHERE rule)', () => {
    // Parity note: Python has no "DELETE without WHERE" analysis at all — the bare
    // write shape is enough. A future refactor must not add such a rule.
    const verdict = inspectSql('DELETE FROM alarms')
    expect(verdict.dangerous).toBe(true)
    expect(verdict.statementKinds).toEqual(['write'])
  })

  it('write: INSERT / UPDATE ... SET / MERGE INTO / REPLACE INTO', () => {
    for (const text of [
      "INSERT INTO audit_log VALUES (999, 'fake entry', now())",
      "UPDATE alarms SET severity='low' WHERE severity='critical'",
      'MERGE INTO t USING s ON 1=1',
      'REPLACE INTO t VALUES (1)',
    ]) {
      const verdict = inspectSql(text)
      expect(verdict.dangerous, text).toBe(true)
      expect(verdict.statementKinds, text).toContain('write')
    }
  })

  it('admin: GRANT / REVOKE ... ON', () => {
    for (const text of [
      "GRANT ALL PRIVILEGES ON nms.* TO 'anon'@'%'",
      'REVOKE ALL ON alarms FROM reporting_role',
    ]) {
      const verdict = inspectSql(text)
      expect(verdict.dangerous, text).toBe(true)
      expect(verdict.statementKinds, text).toEqual(['admin'])
    }
  })

  it('exec: CALL ident( and EXEC sp_/xp_/fn_', () => {
    // Parity note: `execute dbo.fn_x()` does NOT match (the ident must be followed by
    // `(` or prefixed sp_/xp_/fn_), measured on Python — so it is not in this list.
    for (const text of ['CALL purge_job(30)', "EXEC sp_configure 'show advanced options', 1", "EXEC xp_cmdshell 'dir'", 'execute fn_cleanup()', 'EXEC fn_x']) {
      const verdict = inspectSql(text)
      expect(verdict.dangerous, text).toBe(true)
      expect(verdict.statementKinds, text).toContain('exec')
    }
  })

  it('read + exfiltration: SELECT ... INTO OUTFILE is dangerous though the kind is read', () => {
    const verdict = inspectSql("SELECT username, password FROM accounts INTO OUTFILE '/tmp/dump.csv'")
    expect(verdict.dangerous).toBe(true)
    expect(verdict.statementKinds).toEqual(['read'])
    expect(verdict.reasonCode).toBe('dangerous_sql_detected')
    // Parity quirk: the table extractor also captures `outfile` as a "table".
    expect(verdict.tables).toEqual(['accounts', 'outfile'])
  })

  it('exfiltration: LOAD_FILE( is dangerous even with no statement shape', () => {
    const verdict = inspectSql("SELECT LOAD_FILE('/etc/passwd')")
    expect(verdict.isSql).toBe(false)
    expect(verdict.dangerous).toBe(true)
    expect(verdict.statementKinds).toEqual([])
    expect(verdict.reasonCode).toBe('dangerous_sql_detected')
  })

  it('multi-statement: destructive segment makes the whole batch dangerous', () => {
    const verdict = inspectSql('SELECT * FROM a; DROP TABLE b')
    expect(verdict.dangerous).toBe(true)
    expect(verdict.multiStatement).toBe(true)
    expect(verdict.statementKinds).toEqual(['read', 'ddl'])
    expect(verdict.tables).toEqual(['a', 'b'])
  })

  it('multiStatement only counts shaped segments (SELECT 1; DROP ... is multi=false)', () => {
    // Parity note: `SELECT 1` has no FROM tail, so only one segment is shaped and
    // `multi_statement` stays false even though the batch has two statements.
    const verdict = inspectSql('SELECT 1; DROP TABLE device_credentials')
    expect(verdict.dangerous).toBe(true)
    expect(verdict.multiStatement).toBe(false)
    expect(verdict.statementKinds).toEqual(['ddl'])
  })
})

describe('inspectSql: benign reads stay benign', () => {
  it('SELECT ... FROM is SQL but not dangerous', () => {
    const verdict = inspectSql('SELECT a FROM alarms')
    expect(verdict.isSql).toBe(true)
    expect(verdict.dangerous).toBe(false)
    expect(verdict.statementKinds).toEqual(['read'])
    expect(verdict.tables).toEqual(['alarms'])
    expect(verdict.reasonCode).toBeUndefined()
  })

  it('multi-line SELECT is still read (the read shape spans newlines)', () => {
    const verdict = inspectSql('SELECT\n  a,\n  b\nFROM alarms')
    expect(verdict.statementKinds).toEqual(['read'])
    expect(verdict.dangerous).toBe(false)
  })

  it('SHOW / DESCRIBE are read shapes and not dangerous', () => {
    expect(inspectSql('SHOW TABLES').statementKinds).toEqual(['read'])
    expect(inspectSql('describe tables').statementKinds).toEqual(['read'])
  })

  it('read-only batch "SELECT 1; SELECT 2" is not SQL-shaped at all (no FROM)', () => {
    // Parity note: each shape needs a structural tail, so two bare SELECTs produce no
    // kinds and therefore isSql === false.
    const verdict = inspectSql('SELECT 1; SELECT 2')
    expect(verdict.isSql).toBe(false)
    expect(verdict.dangerous).toBe(false)
    expect(verdict.multiStatement).toBe(false)
  })

  it('prose and bare keywords never match', () => {
    for (const text of ['please update the ticket', 'select from', 'DELETE FROM', 'we dropped the call']) {
      const verdict = inspectSql(text)
      expect(verdict.isSql, text).toBe(false)
      expect(verdict.dangerous, text).toBe(false)
    }
  })

  it('bracketed identifiers are not recognised (Python class excludes `[`)', () => {
    // Parity note: `[`'"]?` is the Python char class {backtick, quote, dquote}; `[` is
    // NOT a member, so `[alarms]` does not match. Measured on the Python engine.
    const verdict = inspectSql('SELECT * FROM [alarms]')
    expect(verdict.isSql).toBe(false)
    expect(verdict.tables).toEqual([])
  })

  it('quoted and dotted identifiers are extracted, deduped, lowercased', () => {
    expect(inspectSql('SELECT a FROM "alarms"').tables).toEqual(['alarms'])
    expect(inspectSql('SELECT a FROM dbo.alarms').tables).toEqual(['dbo.alarms'])
    expect(inspectSql('INSERT INTO `x` VALUES (1)').tables).toEqual(['x'])
    expect(inspectSql('SELECT * FROM alarms JOIN alarms ON 1=1').tables).toEqual(['alarms'])
  })

  it('empty and whitespace-only input yields the all-false verdict', () => {
    for (const text of ['', '   ', '\n\t ']) {
      const verdict = inspectSql(text)
      expect(verdict).toEqual({
        isSql: false,
        dangerous: false,
        statementKinds: [],
        tables: [],
        multiStatement: false,
        reasonCode: undefined,
        matchedTable: undefined,
      })
    }
  })
})

describe('inspectSql: comment pre-pass (obfuscation)', () => {
  it('block comment between keywords is stripped to a space', () => {
    const verdict = inspectSql('DELETE /* maintenance */ FROM alarms')
    expect(verdict.dangerous).toBe(true)
    expect(verdict.statementKinds).toEqual(['write'])
    expect(verdict.tables).toEqual(['alarms'])
  })

  it('line comment between keywords is stripped (DELETE -- x\\nFROM)', () => {
    const verdict = inspectSql('DELETE -- x\nFROM alarms')
    expect(verdict.dangerous).toBe(true)
    expect(verdict.statementKinds).toEqual(['write'])
  })

  it('# line comment is stripped (aggressive Python behaviour)', () => {
    const verdict = inspectSql('DELETE # note\nFROM alarms')
    expect(verdict.dangerous).toBe(true)
    expect(verdict.statementKinds).toEqual(['write'])
  })

  it('a # cuts the rest of its line, so anything after it is invisible', () => {
    // Digest §9.8 / measured: `#` truncates the line, so `C# code here; DROP ...` is
    // entirely eaten and stays undetected. Faithful parity, not a bug to "fix" here.
    const verdict = inspectSql('C# code here; DROP TABLE t')
    expect(verdict.dangerous).toBe(false)
    expect(verdict.isSql).toBe(false)
  })

  it('DEL/**/ETE becomes "DEL ETE" and therefore does not match (Python parity)', () => {
    // The pre-pass replaces the block comment with a SPACE, which breaks the keyword
    // rather than reassembling it. The Python engine behaves identically (measured);
    // the table reference is still extracted. Do not "improve" this to detect it
    // without also changing the golden fixture.
    const verdict = inspectSql('DEL/**/ETE FROM alarms')
    expect(verdict.isSql).toBe(false)
    expect(verdict.dangerous).toBe(false)
    expect(verdict.tables).toEqual(['alarms'])
  })

  it('a leading block comment does not hide a statement', () => {
    const verdict = inspectSql('/* c */ DROP TABLE t')
    expect(verdict.dangerous).toBe(true)
    expect(verdict.statementKinds).toEqual(['ddl'])
  })
})

describe('inspectSql: table allowlist', () => {
  it('undefined allowlist disables table checks entirely', () => {
    expect(inspectSql('SELECT a FROM secrets').reasonCode).toBeUndefined()
  })

  it('allows a matching table by full or bare (schema-stripped) name', () => {
    for (const allowed of [['alarms'], ['dbo.alarms'], ['other', 'alarms']]) {
      for (const text of ['SELECT a FROM alarms', 'SELECT a FROM dbo.alarms', 'SELECT a FROM public.alarms']) {
        const verdict = inspectSql(text, { allowedTables: allowed })
        expect(verdict.reasonCode, `${text} allowed=${allowed.join('|')}`).toBeUndefined()
      }
    }
  })

  it('flags the first unlisted table with unauthorized_sql_table', () => {
    const verdict = inspectSql('SELECT a FROM alarms JOIN secrets ON 1=1', { allowedTables: ['alarms'] })
    expect(verdict.reasonCode).toBe('unauthorized_sql_table')
    expect(verdict.matchedTable).toBe('secrets')
    expect(verdict.dangerous).toBe(false)
  })

  it('an empty allowlist rejects every table reference', () => {
    const verdict = inspectSql('SELECT a FROM alarms', { allowedTables: [] })
    expect(verdict.reasonCode).toBe('unauthorized_sql_table')
    expect(verdict.matchedTable).toBe('alarms')
  })

  it('dangerous always wins over the allowlist', () => {
    const verdict = inspectSql('DROP TABLE secrets', { allowedTables: ['secrets'] })
    expect(verdict.dangerous).toBe(true)
    expect(verdict.reasonCode).toBe('dangerous_sql_detected')
    expect(verdict.matchedTable).toBeUndefined()
  })

  it('a benign read with no table reference is never an allowlist violation', () => {
    expect(inspectSql('SHOW TABLES', { allowedTables: [] }).reasonCode).toBeUndefined()
  })
})

describe('inspectSql: bounded work on hostile input', () => {
  it('the read shape keeps Python\'s 600-character bound', () => {
    const tooFar = `SELECT ${'a'.repeat(700)} FROM t`
    expect(inspectSql(tooFar).statementKinds).toEqual([])
    const justInside = `SELECT ${'a'.repeat(500)} FROM t`
    expect(inspectSql(justInside).statementKinds).toEqual(['read'])
  })

  it('handles 256 KiB of text quickly and still detects a trailing DROP', () => {
    const blob = `${'aaa '.repeat(64 * 1024)} DROP TABLE z`
    const started = Date.now()
    const verdict = inspectSql(blob)
    const elapsed = Date.now() - started
    console.log(`inspectSql 256 KiB plain: ${elapsed} ms`)
    expect(verdict.dangerous).toBe(true)
    expect(verdict.statementKinds).toContain('ddl')
    expect(elapsed).toBeLessThan(2000)
  })

  it('handles 256 KiB of dotted identifiers (backtracking probe) quickly', () => {
    const blob = `update t set ${'a.'.repeat(100 * 1024)}`
    const started = Date.now()
    const verdict = inspectSql(blob)
    const elapsed = Date.now() - started
    console.log(`inspectSql 256 KiB dotted: ${elapsed} ms`)
    expect(verdict.dangerous).toBe(true)
    expect(elapsed).toBeLessThan(2000)
  })
})
