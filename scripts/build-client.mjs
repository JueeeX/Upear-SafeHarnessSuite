#!/usr/bin/env node
/**
 * Build the panel's browser half (T5.3) into `lib/client.js`.
 *
 * The DSH web shell does not import client plugins as ES modules. It fetches a
 * classic script whose whole side effect is one registration call:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * and materializes it later by calling `factory(require)`, where `require` walks
 * the browser module table (see `platform-modules.mjs`). So the bundle is CJS,
 * wrapped by a banner/footer, and every dependency outside the table is
 * inlined. A `require` the table cannot answer is a runtime throw, hence the
 * allowlist check in `tests/client-bundle.test.ts`.
 */
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLATFORM_MODULES } from './platform-modules.mjs'

/** Package name, stamped into the registration call. */
export const PLUGIN_ID = '@upear/dsh-safeharness'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Run the bundle build.
 * @returns the esbuild result after a successful build.
 */
export async function buildClient() {
  const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: ['src/client/index.tsx'],
    outfile: 'lib/client.js',
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    // The shell seeds React's automatic runtime; JSX compiles to
    // `require('react/jsx-runtime')`, which the table answers.
    jsx: 'automatic',
    external: [...PLATFORM_MODULES],
    legalComments: 'none',
    logLevel: 'silent',
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
    },
    footer: { js: 'return module.exports; } });' },
  })
  return result
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  buildClient().then(
    () => { console.log('build:client: wrote lib/client.js') },
    (error) => {
      console.error(`build:client: failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    },
  )
}
