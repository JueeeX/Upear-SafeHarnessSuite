/**
 * Tests for the sensitive-path detector (1.18.0).
 *
 * The detector exists because three content rules all missed a 13-character secret whose
 * PATH said "secret". So the tests are weighted toward the two failure modes that matter
 * for a path heuristic:
 *
 *   1. the miss — the incident shape, plus each class's own canonical example;
 *   2. the false positive — source files, documentation and ordinary paths that merely
 *      contain the word. A detector that fires on `token-meter.ts` gets switched off, and
 *      a switched-off detector protects nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SENSITIVE_PATH_CLASSES,
  SENSITIVE_PATH_CLASSES,
  classifySensitivePath,
  isSensitivePathClass,
  resolveSensitivePathClasses,
  scanSensitivePaths,
} from '../src/engine/sensitive-path.js'

describe('sensitive-path: the incident shape', () => {
  it('classifies the file the 2026-11-24 session read', () => {
    // `C:\Users\xiaojue\.dsh\secret.txt` — read verbatim, nothing fired.
    expect(classifySensitivePath('C:\\Users\\xiaojue\\.dsh\\secret.txt')).toEqual(['secret_file'])
  })

  it('finds it among a call\'s arguments and names only the index', () => {
    const found = scanSensitivePaths(
      ['a description', 'C:\\Users\\xiaojue\\.dsh\\secret.txt'],
      DEFAULT_SENSITIVE_PATH_CLASSES,
    )
    expect(found).toBeDefined()
    expect(found?.argumentIndex).toBe(1)
    expect(found?.classes).toEqual(['secret_file'])
    // The finding must not carry the path: `JSON.stringify` of it is the whole object.
    expect(JSON.stringify(found)).not.toContain('secret.txt')
  })
})

describe('sensitive-path: each class', () => {
  const cases: Array<[string, string, string]> = [
    ['dotenv', '/srv/app/.env', 'dotenv'],
    ['dotenv suffix', '/srv/app/production.env', 'dotenv'],
    ['private key', '/home/u/.ssh/id_rsa', 'private_key'],
    ['pem', '/etc/certs/server.pem', 'private_key'],
    ['key store', '/home/u/.config/keys/db.kdbx', 'key_store'],
    ['cloud', '/home/u/.aws/credentials', 'cloud_credential'],
    ['kube', '/home/u/.kube/config', 'cloud_credential'],
    ['secret word', '/opt/app/password.txt', 'secret_file'],
  ]
  for (const [label, path, expected] of cases) {
    it(`classifies ${label}`, () => {
      expect(classifySensitivePath(path)).toContain(expected)
    })
  }

  it('covers every class in the vocabulary with at least one example', () => {
    // Guards against adding a class and forgetting to teach the detector about it.
    const seen = new Set<string>()
    for (const path of [
      '/a/.env',
      '/a/id_rsa',
      '/a/.ssh/known_hosts',
      '/a/.aws/credentials',
      '/a/secrets.yaml',
      '/a/store.kdbx',
    ]) for (const name of classifySensitivePath(path)) seen.add(name)
    expect([...seen].sort()).toEqual([...SENSITIVE_PATH_CLASSES].sort())
  })
})

describe('sensitive-path: false positives are the real risk', () => {
  const harmless = [
    // Source and documentation that merely contain a triggering word.
    '/repo/packages/llm/token-meter/src/index.ts',
    '/repo/docs/secrets-management.md',
    '/repo/scripts/rotate-credentials.py',
    '/repo/packages/settings/settings-file/src/index.ts',
    // Templates are not secrets.
    '/repo/.env.example',
    '/repo/.env.sample',
    // An ordinary path.
    '/workspace/src/app.ts',
    '/tmp/report.csv',
    // A sentence that mentions a credential file — not a path.
    'add it to .env before deploying',
  ]
  for (const path of harmless) {
    it(`ignores ${path}`, () => {
      expect(classifySensitivePath(path)).toEqual([])
    })
  }

  it('treats prose as prose, not as a path', () => {
    // A 4 MB document quoting `/.ssh/` must not be reported as a path read.
    expect(scanSensitivePaths(['see the docs about .ssh handling for details'], DEFAULT_SENSITIVE_PATH_CLASSES))
      .toBeUndefined()
    expect(scanSensitivePaths(['x'.repeat(4000) + '/.ssh/id_rsa'], DEFAULT_SENSITIVE_PATH_CLASSES))
      .toBeUndefined()
  })
})

describe('sensitive-path: deliberate near-misses', () => {
  it('flags the public half inside .ssh as key material, but not as a private key', () => {
    // Everything under .ssh is treated as material because `known_hosts`, `config`
    // and `authorized_keys` live there too; an allowlist inside that directory would
    // be a list to forget. The `private_key` class still excludes `.pub`.
    expect(classifySensitivePath('/home/u/.ssh/id_rsa.pub')).toEqual(['ssh_material'])
  })

  it('flags a bare .env', () => {
    // Not harmless: `.env` is the canonical place a real secret sits.
    expect(classifySensitivePath('.env')).toEqual(['dotenv'])
  })
})

describe('sensitive-path: configuration', () => {
  it('treats an absent class list as every class, and an empty one as none', () => {
    expect(resolveSensitivePathClasses(undefined)).toEqual(DEFAULT_SENSITIVE_PATH_CLASSES)
    expect(resolveSensitivePathClasses([])).toEqual([])
  })

  it('drops unknown class names instead of failing the load', () => {
    // A profile written for a newer release must still boot here.
    expect(resolveSensitivePathClasses(['dotenv', 'future_class'])).toEqual(['dotenv'])
  })

  it('scans nothing when the vocabulary is empty', () => {
    expect(scanSensitivePaths(['/a/.env'], [])).toBeUndefined()
  })

  it('honours a narrowed vocabulary', () => {
    expect(scanSensitivePaths(['/a/.env'], ['secret_file'])).toBeUndefined()
    expect(scanSensitivePaths(['/a/.env'], ['dotenv'])?.classes).toEqual(['dotenv'])
  })

  it('validates class names for config diagnosis', () => {
    expect(isSensitivePathClass('dotenv')).toBe(true)
    expect(isSensitivePathClass('nope')).toBe(false)
    expect(isSensitivePathClass(42)).toBe(false)
  })
})
