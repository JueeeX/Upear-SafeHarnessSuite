/**
 * Where the audit ledger lives on disk.
 *
 * `audit.dir` is operator-supplied config, so this module is the one place that
 * turns it into an absolute directory. Two shapes are supported (§6.8):
 *
 *  - empty `audit.dir` → `$DSH_HOME/safeharness/audit`, so a default deployment
 *    writes its evidence next to the rest of DSH's state instead of the repo;
 *  - non-empty → used verbatim after `~` expansion and `cwd` resolution, which is
 *    what an operator typing `~/.safeharness` or `./evidence` expects.
 *
 * Nothing here reads or writes the filesystem beyond `process.cwd()`, `homedir()`
 * and the `DSH_HOME` environment variable: the resolution itself must be
 * side-effect free so posture checks can call it without touching the ledger.
 * @module
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Active ledger file name inside the resolved directory. */
export const LEDGER_FILENAME = 'ledger.ndjson'

/** Plugin-owned panel state (currently the patrol schedule). */
export const PANEL_STATE_FILENAME = 'panel-state.json'

/** Plugin-owned session metadata index (workspace/title per session id). */
export const SESSION_INDEX_FILENAME = 'sessions.json'

/** Environment slice {@link resolveLedgerDir} consults (injectable for tests). */
export interface LedgerPathEnv {
  readonly DSH_HOME?: string
}

/** First non-empty string among `candidates`, or `undefined`. */
function firstNonEmpty(...candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate
  }
  return undefined
}

/**
 * Expand a leading `~` (current user only) and resolve a relative path against
 * `process.cwd()`. `~` is not a shell concern here: an operator writing a config
 * value expects the same expansion the shell would have done.
 */
function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homedir(), input.slice(2))
  }
  return input
}

/**
 * Compute the absolute directory the ledger writes into.
 *
 * @param configuredDir - `config.audit.dir` exactly as the operator supplied it
 *   (may be empty, relative, `~`-prefixed or absolute).
 * @param env - optional environment override; defaults to `process.env`. Pass a
 *   value in tests instead of mutating the real environment.
 * @returns absolute directory path. Never throws: bad input degrades to the
 *   `$DSH_HOME` default rather than taking the caller down (callers that require
 *   evidence call `createLedger` with `required: true` to fail closed).
 */
export function resolveLedgerDir(configuredDir: string, env?: LedgerPathEnv): string {
  const configured = typeof configuredDir === 'string' ? configuredDir.trim() : ''
  if (configured.length > 0) {
    // `resolve` handles both absolute and relative input; a relative value is
    // anchored at `process.cwd()`, which is what an operator typing `./evidence`
    // means.
    return resolve(expandHome(configured))
  }
  // An empty DSH_HOME is not a home: fall through to the next candidate instead of
  // producing a cwd-relative `safeharness/audit` (which would write inside the repo).
  const home = firstNonEmpty(env?.DSH_HOME, process.env.DSH_HOME) ?? join(homedir(), '.dsh')
  return join(expandHome(home), 'safeharness', 'audit')
}

/**
 * Absolute path of the plugin-owned panel state file.
 *
 * Deliberately independent of `audit.dir`: the schedule is UI state, not
 * evidence, and pointing `audit.dir` at a shared/read-only evidence volume
 * must not break the panel's timer. It lives next to the default audit
 * directory under `$DSH_HOME`.
 *
 * @param env - optional environment override; defaults to `process.env`.
 */
export function resolvePanelStatePath(env?: LedgerPathEnv): string {
  const home = firstNonEmpty(env?.DSH_HOME, process.env.DSH_HOME) ?? join(homedir(), '.dsh')
  return join(expandHome(home), 'safeharness', PANEL_STATE_FILENAME)
}

/**
 * Absolute path of the plugin-owned session metadata index.
 *
 * Like {@link resolvePanelStatePath}, deliberately independent of `audit.dir`:
 * it holds display metadata (workspace path, latest title) used to label
 * conversations in the panel after a restart, not evidence. It never holds
 * prompt text, tool arguments or model output.
 *
 * @param env - optional environment override; defaults to `process.env`.
 */
export function resolveSessionIndexPath(env?: LedgerPathEnv): string {
  const home = firstNonEmpty(env?.DSH_HOME, process.env.DSH_HOME) ?? join(homedir(), '.dsh')
  return join(expandHome(home), 'safeharness', SESSION_INDEX_FILENAME)
}
