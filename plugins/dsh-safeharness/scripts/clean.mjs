#!/usr/bin/env node
/**
 * Remove build output (`lib/`) so a build never leaves stale artifacts behind.
 * Only touches this package's own `lib` directory.
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(pluginRoot, 'lib')
if (!existsSync(lib)) {
  console.log('clean: nothing to do (lib/ absent)')
  process.exit(0)
}
// Guard against a mis-resolved root: only delete a directory literally named lib
// directly under the plugin root.
if (dirname(lib) !== pluginRoot) {
  console.error(`clean: refusing to delete unexpected path ${lib}`)
  process.exit(1)
}
rmSync(lib, { recursive: true, force: true })
console.log('clean: removed lib/')
