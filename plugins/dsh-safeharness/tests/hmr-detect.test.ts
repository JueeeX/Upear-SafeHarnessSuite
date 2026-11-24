/**
 * HMR detection against the host's real loader shape (the 1.16.3 fix).
 *
 * The bug this file pins: `detectHmr` scanned `loader.entries()` for `entry.name`
 * matching `/(^|\/)dsh-hmr$/u`. Two independent facts made that never match a real
 * profile, so `hmr_enabled` reported "not composed" for every deployment and the
 * `hardened` load gate that lists it could never fire:
 *
 *  1. `cordis-plugin-loader`'s `Entry` exposes `id`, `disabled`, `options`, `fiber`
 *     and `context` — there is no `name`; the package name is `options.name`.
 *  2. The shipped bundle composes `@deepseek-ai/cordis-plugin-hmr`; nothing has ever
 *     been called `dsh-hmr`.
 *
 * A check that reads the wrong field and tests the wrong string is the worst kind:
 * it reports a clean bill of health with total confidence. These cases use the real
 * entry shape (`options.name` + a `disabled` getter) so a future host rename shows up
 * here instead of in a deployment that believes it is hardened.
 * @module
 */
import { describe, expect, it } from 'vitest'

import { detectHmr } from '../src/index.js'

/** A loader context over a fixed entry list, shaped like the host's `Entry`. */
function loaderContext(entries: readonly unknown[]): { get(name: string): unknown } {
  return {
    get(name: string) {
      if (name !== 'loader') return undefined
      return {
        *entries() {
          for (const entry of entries) yield entry
        },
      }
    },
  }
}

/** One entry in the host's shape: the package name lives under `options`. */
function entry(packageName: string, options: { disabled?: boolean } = {}) {
  return { id: packageName.split('/').pop(), options: { name: packageName, id: 'hmr' }, disabled: options.disabled === true }
}

describe('detectHmr', () => {
  it('finds the package the shipped bundle actually composes', () => {
    // `dsh-base` inserts this row; `dsh-web-app` patches that same row to disabled.
    expect(detectHmr(loaderContext([entry('@deepseek-ai/cordis-plugin-hmr')]) as never)).toBe(true)
    expect(detectHmr(loaderContext([entry('@deepseek-ai/cordis-plugin-hmr', { disabled: true })]) as never)).toBe(false)
  })

  it('reports enabled when a profile composes the row twice and one is live', () => {
    // The real shape can carry both rows: base inserts it, a later layer re-declares
    // it. Only an enabled row means a reload actually happens, so "first match wins"
    // would answer from whichever row happened to come first in the store.
    const context = loaderContext([
      entry('@deepseek-ai/cordis-plugin-hmr', { disabled: true }),
      entry('@deepseek-ai/cordis-plugin-hmr'),
    ])
    expect(detectHmr(context as never)).toBe(true)
  })

  it('reads the legacy spelling too, in case a host renames back', () => {
    expect(detectHmr(loaderContext([entry('dsh-hmr')]) as never)).toBe(true)
    expect(detectHmr(loaderContext([entry('@deepseek-ai/dsh-hmr')]) as never)).toBe(true)
  })

  it('accepts a host that puts the name directly on the entry', () => {
    // Defensive: if a future Entry grows a `name` accessor, the scan still works.
    const direct = { name: '@deepseek-ai/cordis-plugin-hmr', disabled: false }
    expect(detectHmr(loaderContext([direct]) as never)).toBe(true)
  })

  it('is false when no HMR row is composed at all', () => {
    expect(detectHmr(loaderContext([entry('@deepseek-ai/dsh-llm')]) as never)).toBe(false)
    expect(detectHmr(loaderContext([]) as never)).toBe(false)
  })

  it('is undefined when the loader surface is missing or unreadable', () => {
    // "I could not look" must never read as "it was fine": posture grades undefined
    // as SKIP, and `hardened` lists this code in `failOn`, where only FAIL refuses.
    expect(detectHmr({ get: () => undefined } as never)).toBeUndefined()
    expect(detectHmr({ get: () => ({}) } as never)).toBeUndefined()
    expect(detectHmr({
      get: () => ({
        entries() {
          throw new Error('loader not settled')
        },
      }),
    } as never)).toBeUndefined()
  })

  it('is undefined when reading one entry throws, rather than silently false', () => {
    const hostile = {
      get: () => ({
        *entries() {
          yield { get options(): never { throw new Error('fiber gone') } }
        },
      }),
    }
    expect(detectHmr(hostile as never)).toBeUndefined()
  })

  it('does not match a lookalike package name', () => {
    // The regex is anchored at the end, so a name that merely contains "hmr" is not
    // HMR. This is what makes the constant safe to widen later.
    expect(detectHmr(loaderContext([entry('@deepseek-ai/cordis-plugin-hmr-helper')]) as never)).toBe(false)
    expect(detectHmr(loaderContext([entry('@deepseek-ai/dsh-hmr-stats')]) as never)).toBe(false)
  })
})
