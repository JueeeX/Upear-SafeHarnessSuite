/**
 * The panel's one disk write: land a single operator rule file in `rules.dir`.
 *
 * This is the compromise decision D62 records. The rule set is the plugin's trust
 * root, so the write path is deliberately narrow:
 *
 *  - **only `rules.dir`** is ever written. The packaged `rules/` is never a target
 *    (an upgrade replaces it, and it is the built-in baseline), and a `rules.dir`
 *    that resolves inside it is refused;
 *  - the file name is a whitelisted token, never a path, so `..`/separators/drive
 *    letters cannot escape the directory;
 *  - an existing file is refused unless the caller explicitly asked to overwrite;
 *  - **the loader gate runs first**: the candidate is compiled against the current
 *    packaged + operator + inline layers, so a rule file that would make the set
 *    unloadable never reaches the disk;
 *  - the write is atomic (`tmp` + rename) inside the target directory, and the
 *    audit record carries the file name, its size and the resulting counts only.
 *
 * There is no model-facing tool for this and the endpoint is loopback + same-origin
 * fenced, so "the model cannot change its own guardrails" still holds: a human
 * clicks the button.
 * @module
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { validateRuleCandidate } from '../engine/rules.js'
import type { LoggerLike, Runtime } from '../runtime.js'

/** Longest YAML body accepted (the route's 16 KiB body cap is the outer bound). */
export const MAX_RULE_YAML_CHARS = 12_000

/** A landing file name: lowercase token, YAML suffix, no separators or leading dot. */
const RULE_FILENAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}\.ya?ml$/u

/** Windows device names cannot be created as ordinary files even with a suffix. */
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

/** Error codes the route maps to envelopes. */
export type RuleWriteErrorCode =
  | 'rules_dir_unconfigured'
  | 'rules_dir_not_absolute'
  | 'rules_dir_packaged'
  | 'rules_dir_unwritable'
  | 'filename_invalid'
  | 'rule_content_invalid'
  | 'rule_exists'
  | 'rule_write_failed'

/** A typed failure the route turns into `{ ok: false, error }`. */
export class RuleWriteError extends Error {
  readonly code: RuleWriteErrorCode
  /** Loader problems, when the gate rejected the content (operator-facing text). */
  readonly problems: readonly string[]

  constructor(code: RuleWriteErrorCode, message: string, problems: readonly string[] = []) {
    super(message)
    this.code = code
    this.problems = problems
  }
}

/** One write request as the route receives it. */
export interface RuleWriteRequest {
  /** Bare file name inside `rules.dir` (validated against the whitelist). */
  readonly filename: string
  /** Complete YAML body of the file. */
  readonly yaml: string
  /** True only after the operator confirmed replacing an existing file. */
  readonly overwrite: boolean
}
/** What a successful write did. */
export interface RuleWriteValue {
  readonly filename: string
  /** Bytes written (UTF-8), never the content. */
  readonly bytes: number
  /** Rules in force after the write (the reload's counts when it ran). */
  readonly rules: number
  /** Chain rules in force after the write. */
  readonly chains: number
  /** Rule-set hash prefix in force after the write. */
  readonly hash: string
  /** False when the file replaced an existing one. */
  readonly created: boolean
  /** False when the file landed but the hot reload kept the previous set. */
  readonly reloaded: boolean
  /** Snapshot taken before this write (1.14.0), when the history was writable. */
  readonly snapshot?: string
}

/** The write surface the panel route calls. */
export interface RuleWriterHost {
  /** Validate, land and reload one operator rule file. */
  write(request: RuleWriteRequest): Promise<RuleWriteValue>
}

/** What `apply()` may wire. */
export interface RuleWriterOptions {
  /** Runtime: live config (`rules.dir`/`rules.inline`) and the audit sink. */
  readonly runtime: Runtime
  /** The packaged `rules/` directory this install ships (never writable). */
  readonly packagedRulesDir: string
  /** Re-read the rule directory and swap the engine; the loader's own gate decides. */
  readonly reload: () => { readonly rules: number; readonly chains: number; readonly hash: string }
  /** Plugin logger (content-free messages only). */
  readonly logger: LoggerLike
  /**
   * Capture the live directory before the write (1.14.0 rollback support).
   *
   * @returns the snapshot id to report, or `undefined` when nothing was captured.
   */
  readonly beforeWrite?: () => string | undefined
}

/** One-line, content-free description of a filesystem failure. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}, ${error.message.length} chars` : 'non-error'
}

/**
 * Build the rule writer for one plugin instance.
 *
 * @param options - runtime, packaged directory, reload callback and logger.
 * @returns the write surface the route calls.
 */
export function createRuleWriter(options: RuleWriterOptions): RuleWriterHost {
  const { runtime, logger } = options

  /** Resolve the live `rules.dir`, refusing anything that is not a safe target. */
  const targetDir = (): string => {
    const configured = runtime.config.rules.dir.trim()
    if (configured === '') {
      throw new RuleWriteError('rules_dir_unconfigured', 'config rules.dir is empty: set an absolute rule directory and restart')
    }
    if (!isAbsolute(configured)) {
      throw new RuleWriteError('rules_dir_not_absolute', 'config rules.dir must be an absolute path')
    }
    const dir = resolve(configured)
    // `relative` is the containment test: '' means the same directory, a result
    // without '..' means inside it, and an absolute result means a different drive.
    const inside = relative(resolve(options.packagedRulesDir), dir)
    if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
      throw new RuleWriteError('rules_dir_packaged', 'refusing to write inside the packaged rules directory')
    }
    return dir
  }

  /** Validate the requested file name; throws a typed error. */
  const validateFilename = (raw: unknown): string => {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (!RULE_FILENAME_RE.test(name) || WINDOWS_RESERVED_RE.test(name)) {
      throw new RuleWriteError(
        'filename_invalid',
        'file name must match [a-z0-9][a-z0-9._-]{0,63}.yaml (lowercase, no path separators)',
      )
    }
    return name
  }

  const write = async (request: RuleWriteRequest): Promise<RuleWriteValue> => {
    const dir = targetDir()
    const filename = validateFilename(request.filename)
    const yaml = typeof request.yaml === 'string' ? request.yaml : ''
    if (yaml.trim().length === 0) {
      throw new RuleWriteError('rule_content_invalid', 'the rule file is empty', ['the file is empty'])
    }
    if (yaml.length > MAX_RULE_YAML_CHARS) {
      throw new RuleWriteError('rule_content_invalid', `the rule file is larger than ${MAX_RULE_YAML_CHARS} characters`)
    }

    // 1) Loader gate first. `validateRuleCandidate` runs the real loader over the
    //    candidate plus every other source, so the write cannot break the set.
    const candidate = validateRuleCandidate({
      packagedRulesDir: options.packagedRulesDir,
      dir,
      inline: runtime.config.rules.inline,
      filename,
      yaml,
    })
    if (!candidate.ok) {
      throw new RuleWriteError(
        'rule_content_invalid',
        'the rule file does not pass the loader gate',
        candidate.problems.slice(0, 8),
      )
    }

    // 2) Existence policy: replacing a file is a separate, explicit request.
    const finalPath = join(dir, filename)
    const exists = existsSync(finalPath)
    if (exists && request.overwrite !== true) {
      throw new RuleWriteError('rule_exists', 'a rule file with that name already exists')
    }

    // 3) Atomic write inside the target directory. The temporary name does not end
    //    in .yaml/.yml, so a watcher tick can never load a half-written file.
    //
    // Before touching the disk, capture the current directory: the write is already
    // validated, so this is the undo point for the operator, and a failed capture
    // must not block a validated write.
    const snapshot = options.beforeWrite?.()
    try {
      mkdirSync(dir, { recursive: true })
    } catch (error) {
      logger.warn(`safeharness: rules directory is not writable (${describe(error)})`)
      throw new RuleWriteError('rules_dir_unwritable', 'the rules directory cannot be created')
    }
    const temporary = join(dir, `${filename}.tmp-${String(process.pid)}-${String(Date.now())}`)
    let bytes: number
    try {
      writeFileSync(temporary, yaml, { encoding: 'utf8' })
      bytes = Buffer.byteLength(yaml, 'utf8')
      renameSync(temporary, finalPath)
    } catch (error) {
      rmSync(temporary, { force: true })
      logger.warn(`safeharness: rule file write failed (${describe(error)})`)
      throw new RuleWriteError('rule_write_failed', 'the rule file could not be written')
    }

    // Evidence before the reload: the write happened even if the reload cannot run.
    runtime.audit('rules_written', {
      decision: 'ok',
      reason_code: 'panel_rule_write',
      labels: { file: filename, mode: exists ? 'overwrite' : 'create', ...(snapshot === undefined ? {} : { snapshot }) },
      metrics: { bytes, rules: candidate.ruleset.ruleCount, chains: candidate.ruleset.chainCount },
    })

    // 4) Hot reload: the disk is the truth, so re-read it rather than trusting the
    //    candidate. A failure keeps the previous set and is reported as `reloaded:false`.
    let reloaded = false
    let counts = {
      rules: candidate.ruleset.ruleCount,
      chains: candidate.ruleset.chainCount,
      hash: candidate.ruleset.hash.slice(0, 12),
    }
    try {
      counts = options.reload()
      reloaded = true
    } catch (error) {
      logger.warn(`safeharness: rule file written but the reload failed (${describe(error)})`)
      runtime.audit('invariant_probe', {
        decision: 'warn',
        reason_code: 'panel_rule_reload',
        labels: { state: 'reload_failed', file: filename },
      })
    }

    return {
      filename,
      bytes,
      rules: counts.rules,
      chains: counts.chains,
      hash: counts.hash,
      created: !exists,
      reloaded,
      ...(snapshot === undefined ? {} : { snapshot }),
    }
  }

  return { write }
}
