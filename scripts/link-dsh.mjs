#!/usr/bin/env node
/**
 * Junction the DSH host packages this plugin imports into the plugin's own
 * `node_modules`, so that:
 *
 *   1. `tsc` can typecheck against the exact types the host runs, and
 *   2. at plugin load time Node resolves each `@deepseek-ai/*` bare specifier to
 *      the SAME real path the host already loaded (module identity preserved).
 *
 * Why not `pnpm add`? The installed DSH versions (0.1.0-rc.5 etc.) are not
 * published to the public npm registry — `npm view @deepseek-ai/dsh-tools@0.1.0-rc.5`
 * answers E404. The DSH install
 * tree at `$DSH_HOME/profiles/node_modules` is the only source of truth.
 *
 * Usage:
 *   node scripts/link-dsh.mjs            # create/refresh junctions
 *   node scripts/link-dsh.mjs --check    # exit 1 if any link is missing
 *   node scripts/link-dsh.mjs --dry-run  # print what would happen
 *
 * Env:
 *   DSH_HOME          override the host home (default: %USERPROFILE%\.dsh / $HOME/.dsh)
 *   DSH_NODE_MODULES  override the host package root
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Packages this plugin imports from the host at build or run time. */
const HOST_PACKAGES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-sandbox-policy',
]

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hostHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
  ? resolve(process.env.DSH_HOME)
  : join(homedir(), '.dsh')
const hostModules = process.env.DSH_NODE_MODULES && process.env.DSH_NODE_MODULES.length > 0
  ? resolve(process.env.DSH_NODE_MODULES)
  : join(hostHome, 'profiles', 'node_modules')

const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const dryRun = args.has('--dry-run')

/** Create a directory link (junction on Windows, plain symlink elsewhere). */
function linkDir(target, path) {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    throw new Error(`cannot link ${path} -> ${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** A link pointing at `target`, or a real directory that already is the target. */
function alreadyLinked(path, target) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return false
  }
  if (!stat) return false
  if (stat.isSymbolicLink()) {
    try {
      const current = readlinkSync(path)
      return resolve(dirname(path), current) === resolve(target)
    } catch {
      return false
    }
  }
  try {
    return realpathish(path) === realpathish(target)
  } catch {
    return false
  }
}

/** realpath that also works for junction points on Windows. */
function realpathish(path) {
  return statSync(path).isDirectory() ? resolve(path) : resolve(path)
}

if (!existsSync(hostModules)) {
  console.error(`link-dsh: host package root not found: ${hostModules}`)
  console.error('link-dsh: set DSH_HOME (or DSH_NODE_MODULES) to the DeepSeek Harness home directory.')
  process.exit(1)
}

let missing = 0
let created = 0
for (const name of HOST_PACKAGES) {
  const target = join(hostModules, ...name.split('/'))
  const path = join(pluginRoot, 'node_modules', ...name.split('/'))
  if (!existsSync(target)) {
    console.error(`link-dsh: MISSING in host tree: ${target}`)
    missing += 1
    continue
  }
  if (alreadyLinked(path, target)) continue
  if (checkOnly) {
    console.error(`link-dsh: missing link: ${path} -> ${target}`)
    missing += 1
    continue
  }
  if (dryRun) {
    console.log(`link-dsh: would link ${path} -> ${target}`)
    continue
  }
  mkdirSync(dirname(path), { recursive: true })
  if (existsSync(path) || lstatSyncSafe(path)) rmSync(path, { recursive: true, force: true })
  linkDir(target, path)
  created += 1
}

if (checkOnly) {
  if (missing > 0) process.exit(1)
  console.log(`link-dsh: all ${HOST_PACKAGES.length} host packages linked`)
} else {
  console.log(`link-dsh: ${created} link(s) created, ${HOST_PACKAGES.length - missing - created} already in place, ${missing} missing`)
  if (missing > 0) process.exit(1)
}

/** lstat that returns undefined instead of throwing. */
function lstatSyncSafe(path) {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}
