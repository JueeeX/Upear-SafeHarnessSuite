/**
 * Rule-directory snapshots and one-click rollback (1.14.0).
 *
 * The kernel keeps ten versions of a hot-reloaded rule set in its database
 * (`rules_loader.py`). The plugin has no database, so the equivalent is a bounded
 * set of directory snapshots: every rule write first copies the live `rules.dir`
 * into `$DSH_HOME/safeharness/rules-writes/history/<id>/`, and the panel can
 * restore any of the last {@link MAX_SNAPSHOTS} with a loader gate in front.
 *
 * Safety rules, in order of importance:
 *
 *  - **Nothing is restored that would not load.** A snapshot is staged into a
 *    temporary directory and compiled with the real loader against the packaged +
 *    inline layers; a failure refuses the whole rollback and writes nothing.
 *  - **A rollback is itself reversible.** The state being replaced is snapshotted
 *    first (`trigger: 'pre-rollback'`), so "undo the undo" works.
 *  - **The directory ends up equal to the snapshot.** Files the snapshot does not
 *    contain are removed, but only `.yaml`/`.yml` at the top level — the loader
 *    reads exactly that set, so anything else (scripts, notes) is left alone.
 *  - **Snapshots are bounded.** {@link MAX_SNAPSHOTS} directories are kept and
 *    {@link MAX_SNAPSHOT_FILES} / {@link MAX_SNAPSHOT_BYTES} cap one capture; an
 *    oversized directory is skipped with a warning instead of copied.
 *  - **Integrity is checked on restore.** Every captured file carries a sha256 in
 *    the manifest; a mismatch refuses the rollback (`snapshot_corrupt`).
 *
 * Snapshots live outside `rules.dir` (under `$DSH_HOME`) so the loader and the
 * file watcher never see them, and they hold operator-authored rule text only —
 * never user content, tool results or credentials.
 * @module
 */
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { loadRuleSet } from '../engine/rules.js'
import type { LoggerLike, Runtime } from '../runtime.js'
import type {
  PanelRuleHistoryValue,
  PanelRuleRollbackValue,
  PanelRuleSnapshot,
} from './protocol.js'
import { RuleWriteError } from './rules-write.js'

/** How many snapshots are retained (the kernel keeps ten versions). */
export const MAX_SNAPSHOTS = 10
/** How many rule files one snapshot may capture. */
export const MAX_SNAPSHOT_FILES = 64
/** Largest single captured file (bytes); larger directories are skipped. */
export const MAX_SNAPSHOT_BYTES = 256 * 1024
/** Snapshot id: UTC timestamp plus a per-second counter. */
const SNAPSHOT_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9]{1,3}$/u
/** Only the loader's own file kinds are captured/restored/removed. */
const RULE_FILE_RE = /\.ya?ml$/iu

/** Manifest format version. */
const MANIFEST_VERSION = 1

/** One captured file's integrity record. */
interface ManifestFile {
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

/** The `manifest.json` written into every snapshot directory. */
interface Manifest {
  readonly v: number
  readonly id: string
  readonly createdAt: number
  readonly trigger: PanelRuleSnapshot['trigger']
  readonly files: readonly ManifestFile[]
}

/** What the history needs from the plugin. */
export interface RuleHistoryOptions {
  /** Directory that holds `history/<id>/`. */
  readonly root: string
  /** The packaged `rules/` directory (never snapshotted, never a target). */
  readonly packagedRulesDir: string
  /** Inline rules in force (they take part in the loader gate). */
  readonly inline: () => readonly unknown[]
  /** Re-read the rule directory and swap the engine. */
  readonly reload: () => { readonly rules: number; readonly chains: number; readonly hash: string }
  readonly runtime: Runtime
  readonly logger: LoggerLike
}

/** The history surface the route and the writer call. */
export interface RuleHistoryHost {
  /** Newest-first snapshot list for the rules tab. */
  list(): PanelRuleHistoryValue
  /** Restore one snapshot after the loader gate accepts it. */
  rollback(snapshotId: unknown): PanelRuleRollbackValue
  /**
   * Capture the live directory before a write.
   *
   * @returns the snapshot id, or `undefined` when there was nothing to capture or
   *   the capture was skipped/failed (the write itself still proceeds — the
   *   history is a safety net, not evidence, and blocking a validated write on a
   *   full disk would be worse than losing one undo point).
   */
  snapshotBeforeWrite(): string | undefined
}

/** UTC snapshot id for "now", with a counter so two captures in one second differ. */
function snapshotId(now: Date, seq: number): string {
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  return `${stamp}-${String(seq)}`
}

/** sha256 of one file's bytes. */
function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Rule files directly inside `dir` (the loader reads exactly this level). */
function ruleFilesIn(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.filter((name) => RULE_FILE_RE.test(name)).sort()
}

/** True when `child` resolves inside `parent` (same drive, no `..` escape). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Build the snapshot/rollback surface for one plugin instance.
 *
 * @param options - root directory, packaged rules, live-dir resolver and reload.
 * @returns the host the panel route and the rule writer share.
 */
export function createRuleHistory(options: RuleHistoryOptions): RuleHistoryHost {
  const { runtime, logger } = options
  const historyRoot = join(options.root, 'history')

  /** Refuse a `rules.dir` that is not a safe snapshot target. */
  const liveDir = (): string => {
    const configured = runtime.config.rules.dir.trim()
    if (configured === '') {
      throw new RuleWriteError('rules_dir_unconfigured', 'config rules.dir is empty: set an absolute rule directory and restart')
    }
    if (!isAbsolute(configured)) {
      throw new RuleWriteError('rules_dir_not_absolute', 'config rules.dir must be an absolute path')
    }
    const dir = resolve(configured)
    // A directory that contains the history root (or lives inside it) would make a
    // snapshot capture the snapshots; the packaged directory is never a target.
    if (isInside(dir, options.root) || isInside(options.root, dir) || isInside(options.packagedRulesDir, dir)) {
      throw new RuleWriteError('rules_dir_packaged', 'refusing to snapshot or restore an unsafe rules directory')
    }
    return dir
  }

  /** Read one manifest, or `undefined` when it is missing or malformed. */
  const readManifest = (id: string): Manifest | undefined => {
    const file = join(historyRoot, id, 'manifest.json')
    if (!existsSync(file)) return undefined
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Manifest>
      if (parsed.v !== MANIFEST_VERSION || typeof parsed.createdAt !== 'number' || !Array.isArray(parsed.files)) {
        return undefined
      }
      const files: ManifestFile[] = []
      for (const entry of parsed.files) {
        if (entry === null || typeof entry !== 'object') return undefined
        const record = entry as Partial<ManifestFile>
        if (typeof record.name !== 'string' || !RULE_FILE_RE.test(record.name)) return undefined
        if (typeof record.bytes !== 'number' || typeof record.sha256 !== 'string') return undefined
        files.push({ name: record.name, bytes: record.bytes, sha256: record.sha256 })
      }
      const trigger = parsed.trigger === 'manual' || parsed.trigger === 'pre-rollback' ? parsed.trigger : 'write'
      return { v: MANIFEST_VERSION, id, createdAt: parsed.createdAt, trigger, files }
    } catch {
      return undefined
    }
  }

  /** All manifests, newest first. */
  const allManifests = (): Manifest[] => {
    if (!existsSync(historyRoot)) return []
    let ids: string[]
    try {
      ids = readdirSync(historyRoot).filter((name) => SNAPSHOT_ID_RE.test(name))
    } catch {
      return []
    }
    return ids
      .map((id) => readManifest(id))
      .filter((manifest): manifest is Manifest => manifest !== undefined)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
  }

  /** Drop everything beyond {@link MAX_SNAPSHOTS}, oldest first. */
  const prune = (): void => {
    const manifests = allManifests()
    for (const stale of manifests.slice(MAX_SNAPSHOTS)) {
      try {
        rmSync(join(historyRoot, stale.id), { recursive: true, force: true })
      } catch (error) {
        logger.warn(`safeharness: could not prune rule snapshot ${stale.id} (${error instanceof Error ? error.name : 'error'})`)
      }
    }
  }

  /** Next free snapshot id for `now` (counter starts at 1). */
  const nextId = (now: Date): string => {
    for (let seq = 1; seq <= 999; seq += 1) {
      const candidate = snapshotId(now, seq)
      if (!existsSync(join(historyRoot, candidate))) return candidate
    }
    throw new RuleWriteError('rule_write_failed', 'too many rule snapshots in one second')
  }

  /**
   * Copy the rule files of `sourceDir` into one snapshot directory.
   *
   * @returns the manifest, or `undefined` when the capture was skipped (nothing to
   *   capture, too many files, or a file above the size cap).
   */
  const capture = (sourceDir: string, trigger: PanelRuleSnapshot['trigger'], now = new Date()): Manifest | undefined => {
    const names = ruleFilesIn(sourceDir)
    if (names.length === 0) return undefined
    if (names.length > MAX_SNAPSHOT_FILES) {
      logger.warn(`safeharness: rules directory has more than ${MAX_SNAPSHOT_FILES} rule files; snapshot skipped`)
      return undefined
    }
    const files: ManifestFile[] = []
    for (const name of names) {
      const path = join(sourceDir, name)
      try {
        const size = statSync(path).size
        if (size > MAX_SNAPSHOT_BYTES) {
          logger.warn(`safeharness: rule file ${name} is larger than ${MAX_SNAPSHOT_BYTES} bytes; snapshot skipped`)
          return undefined
        }
        files.push({ name, bytes: size, sha256: fileSha256(path) })
      } catch {
        return undefined
      }
    }
    const id = nextId(now)
    const target = join(historyRoot, id)
    try {
      mkdirSync(target, { recursive: true })
      for (const file of files) cpSync(join(sourceDir, file.name), join(target, file.name))
      const manifest: Manifest = { v: MANIFEST_VERSION, id, createdAt: now.getTime(), trigger, files }
      writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' })
      return manifest
    } catch (error) {
      // A half-written snapshot must not look restorable.
      rmSync(target, { recursive: true, force: true })
      logger.warn(`safeharness: rule snapshot failed (${error instanceof Error ? error.name : 'error'})`)
      return undefined
    }
  }

  const list = (): PanelRuleHistoryValue => {
    let current: string[] = []
    let currentHashes = new Map<string, string>()
    try {
      const dir = liveDir()
      current = ruleFilesIn(dir)
      currentHashes = new Map(current.map((name) => [name, fileSha256(join(dir, name))]))
    } catch {
      // An unconfigured/unsafe directory still lists history: the operator may be
      // about to point `rules.dir` somewhere and restore old content into it.
    }
    const manifests = allManifests()
    return {
      limit: MAX_SNAPSHOTS,
      snapshots: manifests.map((manifest) => {
        const same = manifest.files.length === current.length
          && manifest.files.every((file) => currentHashes.get(file.name) === file.sha256)
        return {
          id: manifest.id,
          createdAt: manifest.createdAt,
          trigger: manifest.trigger,
          files: manifest.files.length,
          bytes: manifest.files.reduce((total, file) => total + file.bytes, 0),
          active: same,
        }
      }),
    }
  }

  const rollback = (rawId: unknown): PanelRuleRollbackValue => {
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    if (!SNAPSHOT_ID_RE.test(id)) {
      throw new RuleWriteError('rule_write_failed', 'snapshot id is not a valid handle')
    }
    const manifest = readManifest(id)
    if (manifest === undefined) {
      throw new RuleWriteError('rule_write_failed', 'that snapshot does not exist or is unreadable')
    }
    const dir = liveDir()
    const snapshotDir = join(historyRoot, id)

    // 1) Integrity: the snapshot must still be exactly what was captured.
    for (const file of manifest.files) {
      const path = join(snapshotDir, file.name)
      if (!existsSync(path) || fileSha256(path) !== file.sha256) {
        throw new RuleWriteError('rule_write_failed', `snapshot ${id} is corrupt (${file.name} does not match its manifest)`)
      }
    }

    // 2) Loader gate on a staging copy: never touch the live directory until the
    //    restored set is known to compile against the packaged + inline layers.
    const staging = join(options.root, `staging-${String(process.pid)}-${String(Date.now())}`)
    try {
      mkdirSync(staging, { recursive: true })
      for (const file of manifest.files) cpSync(join(snapshotDir, file.name), join(staging, file.name))
      try {
        loadRuleSet({
          packagedRulesDir: options.packagedRulesDir,
          dir: staging,
          inline: options.inline(),
        })
      } catch (error) {
        const problems = error instanceof Error && 'problems' in error
          ? (error as { problems?: readonly string[] }).problems ?? []
          : []
        throw new RuleWriteError(
          'rule_content_invalid',
          'the snapshot does not load against the current packaged and inline rules',
          problems.slice(0, 8),
        )
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }

    // 3) Undo point for the state we are about to replace.
    const preRollback = capture(dir, 'pre-rollback')

    // 4) Apply: restore the snapshot's files atomically, then drop rule files the
    //    snapshot does not contain (the directory must equal the snapshot).
    const restored = new Set(manifest.files.map((file) => file.name))
    let bytes = 0
    for (const file of manifest.files) {
      const source = join(snapshotDir, file.name)
      const target = join(dir, file.name)
      const temporary = join(dir, `${file.name}.tmp-${String(process.pid)}-${String(Date.now())}`)
      try {
        mkdirSync(dir, { recursive: true })
        cpSync(source, temporary)
        renameSync(temporary, target)
        bytes += file.bytes
      } catch (error) {
        rmSync(temporary, { force: true })
        logger.warn(`safeharness: rollback write failed (${error instanceof Error ? error.name : 'error'})`)
        throw new RuleWriteError('rule_write_failed', 'the snapshot could not be restored (a partial restore may have landed)')
      }
    }
    const removed: string[] = []
    for (const name of ruleFilesIn(dir)) {
      if (restored.has(name)) continue
      try {
        rmSync(join(dir, name), { force: true })
        removed.push(name)
      } catch {
        logger.warn('safeharness: rollback could not remove a rule file the snapshot does not contain')
      }
    }

    // 5) Evidence, then the hot reload (the disk is the truth).
    runtime.audit('rules_written', {
      decision: 'ok',
      reason_code: 'panel_rule_rollback',
      labels: { mode: 'rollback', snapshot: id, pre_rollback: preRollback?.id ?? 'none' },
      metrics: { files: manifest.files.length, bytes, removed: removed.length },
    })

    let reloaded = false
    let counts = { rules: 0, chains: 0, hash: '' }
    try {
      counts = options.reload()
      reloaded = true
    } catch (error) {
      logger.warn(`safeharness: snapshot restored but the reload failed (${error instanceof Error ? error.name : 'error'})`)
      runtime.audit('invariant_probe', {
        decision: 'warn',
        reason_code: 'panel_rule_reload',
        labels: { state: 'reload_failed', snapshot: id },
      })
    }

    prune()
    return {
      snapshot: id,
      preRollback: preRollback?.id ?? null,
      files: manifest.files.length,
      bytes,
      removed,
      rules: counts.rules,
      chains: counts.chains,
      hash: counts.hash,
      reloaded,
    }
  }

  const snapshotBeforeWrite = (): string | undefined => {
    try {
      const manifest = capture(liveDir(), 'write')
      if (manifest === undefined) return undefined
      prune()
      return manifest.id
    } catch (error) {
      // The write itself was already validated; a missing undo point must not block it.
      logger.warn(`safeharness: could not snapshot the rules directory before a write (${error instanceof Error ? error.name : 'error'})`)
      runtime.audit('invariant_probe', {
        decision: 'warn',
        reason_code: 'panel_rule_snapshot',
        labels: { state: 'snapshot_failed' },
      })
      return undefined
    }
  }

  return { list, rollback, snapshotBeforeWrite }
}
