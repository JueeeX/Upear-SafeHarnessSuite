/**
 * Sensitive-path detection for tool arguments (1.18.0).
 *
 * Why this exists: on 2026-11-24 a session read `C:\Users\xiaojue\.dsh\secret.txt` and
 * put the value on screen with no finding anywhere. The engine had three content
 * detectors and not one of them could see it — the value was 13 characters (below the
 * 40-char entropy floor), carried no key name (`1: XcX7ChLE4LZpj` is not an
 * assignment), and had no PII structure. Meanwhile the *path* said "secret" in plain
 * text and nothing looked at paths at all.
 *
 * So this detector judges intent from the path a tool was asked to touch, not only
 * from the bytes it would return. It never reports a path: findings carry the class
 * and the argument index, so the ledger gains evidence without gaining a path.
 *
 * Precision is the whole design problem here. A bare substring test for "secret"
 * matches `secrets-management.md` and a substring test for "token" matches
 * `tokenizer.ts`; either would make the detector the reason a legitimate read fails.
 * Every rule below is therefore anchored to a path *component*, and a string is only
 * considered a path when it cannot be a sentence.
 * @module
 */

/** The closed vocabulary of path classes. Mirrors the kernel's secret-file taxonomy. */
export const SENSITIVE_PATH_CLASSES = [
  /** `.env`, `.env.local`, `production.env`; templates are excluded. */
  'dotenv',
  /** `id_rsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`. */
  'private_key',
  /** Anything under an `.ssh` directory. */
  'ssh_material',
  /** `.aws/credentials`, `.config/gcloud/`, `.kube/config`, `.docker/config.json`. */
  'cloud_credential',
  /** A basename whose own words say it holds a secret. */
  'secret_file',
  /** `.kdbx`, `.keychain`, `.ovpn`. */
  'key_store',
] as const

/** One member of {@link SENSITIVE_PATH_CLASSES}. */
export type SensitivePathClass = (typeof SENSITIVE_PATH_CLASSES)[number]

const CLASS_SET: ReadonlySet<string> = new Set(SENSITIVE_PATH_CLASSES)

/** Default enabled classes: every one, because each names a file nobody reads by accident. */
export const DEFAULT_SENSITIVE_PATH_CLASSES: readonly SensitivePathClass[] = SENSITIVE_PATH_CLASSES

/**
 * Longest string still treated as a path candidate.
 *
 * A real path is short. Without a cap, a 4 MB string argument that happens to embed
 * `/.ssh/` inside a blob of prose would be reported as a path read.
 */
const MAX_PATH_CANDIDATE = 512

/** Templates and public keys: the same names, without the secret. */
const HARMLESS_BASENAMES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults'])

/** Words that name a secret when they appear as a whole component of the basename. */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'secret',
  'secrets',
  'credential',
  'credentials',
  'password',
  'passwd',
  'passwords',
  'apikey',
  'token',
  'tokens',
  'privatekey',
  'netrc',
  'pgpass',
  'htpasswd',
])

/**
 * Extensions that mean "this file is source or prose, not stored secrets".
 *
 * This is the difference between a detector an operator keeps and one they turn off.
 * Without it, `token-meter.ts` and `secrets-management.md` both fire — and because the
 * tool surface defaults to `enforce`, that would deny reading the host's own source,
 * which is exactly the "maintaining the plugin is blocked by the plugin" failure this
 * package spent 1.16.1 removing.
 *
 * `.txt` is deliberately NOT here: the incident this detector was written for was
 * `secret.txt`.
 */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  'md', 'ts', 'tsx', 'js', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'cs', 'php', 'html', 'css', 'scss', 'vue', 'svelte', 'sql', 'sh', 'ps1', 'bat',
])

/** Extension of a basename, lower-cased and without the dot; empty when there is none. */
function extensionOf(basename: string): string {
  const at = basename.lastIndexOf('.')
  if (at <= 0) return ''
  return basename.slice(at + 1).toLowerCase()
}

/** One argument-level finding. Never carries the path or the value. */
export interface SensitivePathFinder {
  /** Classes matched by one argument string. */
  readonly classes: readonly SensitivePathClass[]
  /** Index of the offending argument string (the value itself is never reported). */
  readonly argumentIndex: number
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u
const WHITESPACE = /\s/u

/**
 * Whether one string should be read as a filesystem path at all.
 *
 * A path either contains a separator or is a single token with no whitespace. That
 * admits `C:\x\.ssh\id_rsa`, `/etc/.env` and `.env`, and rejects `add it to .env
 * before deploying` — the sentence in a document that must not be reported as a read.
 *
 * @param value - one string argument.
 * @returns `true` when the string can be treated as a path.
 */
function isPathLike(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PATH_CANDIDATE) return false
  // Control characters (including newlines) mean prose, a multi-line blob, or junk.
  if (CONTROL_CHARS.test(value)) return false
  if (value.includes('/') || value.includes('\\')) return true
  return !WHITESPACE.test(value)
}

/** Strip surrounding quotes and trailing punctuation a shell/JSON wrapper may leave. */
function normalizePath(value: string): string {
  return value.trim().replace(/^["'`]+|["'`,;:]+$/gu, '')
}

/** Last non-empty path component, lower-cased. */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]+/u)
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part !== undefined && part.length > 0) return part.toLowerCase()
  }
  return ''
}

/** Whole-word components of a basename (`secrets.yaml` → `secrets`, `yaml`). */
function wordComponents(basename: string): readonly string[] {
  return basename.split(/[^a-z0-9]+/u).filter(part => part.length > 0)
}

/**
 * Classify one already-normalized path.
 *
 * @param path - path-like string, first see {@link isPathLike}.
 * @returns every class the path belongs to, in vocabulary order (empty = clean).
 */
export function classifySensitivePath(path: string): readonly SensitivePathClass[] {
  const basename = basenameOf(path)
  if (basename.length === 0) return []
  if (HARMLESS_BASENAMES.has(basename)) return []

  const matched = new Set<SensitivePathClass>()
  const lower = path.toLowerCase()

  // dotenv: `.env`, `.env.local`, `production.env`. A template was excluded above.
  if (basename === '.env' || basename.startsWith('.env.') || basename.endsWith('.env')) {
    matched.add('dotenv')
  }

  // private_key: a key file, but a `.pub` companion is the public half and is not one.
  if (!basename.endsWith('.pub')) {
    if (/^id_(?:rsa|dsa|ecdsa|ed25519)/u.test(basename) || /\.(?:pem|key|p12|pfx|jks|keystore)$/u.test(basename)) {
      matched.add('private_key')
    }
  }

  // ssh_material: any file inside a directory literally named `.ssh`.
  if (/(?:^|[\\/])\.ssh[\\/]/u.test(lower)) matched.add('ssh_material')

  // cloud_credential: the well-known credential locations of the major CLIs.
  if (
    /\.aws[\\/](?:credentials|config)$/u.test(lower)
    || /\.config[\\/]gcloud[\\/]/u.test(lower)
    || /\.kube[\\/]config$/u.test(lower)
    || /\.docker[\\/]config\.json$/u.test(lower)
    || /\.azure[\\/]/u.test(lower)
  ) matched.add('cloud_credential')

  // key_store: binary containers that hold many secrets.
  if (/\.(?:kdbx|keychain|ovpn)$/u.test(basename)) matched.add('key_store')

  // secret_file: the basename says so, as a whole word. `secrets.yaml` still matches
  // on `secrets` — intended, because the alternative (substring matching) is what makes
  // `tokenizer.ts` and `secretary.md` fire — but a source/prose extension wins: a `.ts`
  // or `.md` file named `token` is documentation, not a credential store.
  if (!CODE_EXTENSIONS.has(extensionOf(basename))) {
    const words = wordComponents(basename)
    if (words.some(word => SECRET_WORDS.has(word))) matched.add('secret_file')
    // `api_key.txt` tokenizes to `api` + `key`, so the pair is checked explicitly.
    if (basename.includes('api_key') || basename.includes('api-key') || basename.includes('api.key')) {
      matched.add('secret_file')
    }
  }

  return SENSITIVE_PATH_CLASSES.filter(name => matched.has(name))
}

/** Narrow operator config to the known vocabulary; unknown names are ignored. */
export function resolveSensitivePathClasses(enabled: readonly string[] | undefined): readonly SensitivePathClass[] {
  if (enabled === undefined) return DEFAULT_SENSITIVE_PATH_CLASSES
  const kept = SENSITIVE_PATH_CLASSES.filter(name => enabled.includes(name))
  // An explicit empty list means "no class enabled" (the operator turned it off);
  // only `undefined` (absent) means "every class".
  return kept
}

/**
 * Scan every string argument for sensitive-path intent.
 *
 * @param strings - the call's string arguments, in collection order.
 * @param enabled - enabled classes, from {@link resolveSensitivePathClasses}.
 * @returns the first argument that names a sensitive path, or `undefined`.
 */
export function scanSensitivePaths(
  strings: readonly string[],
  enabled: readonly SensitivePathClass[],
): SensitivePathFinder | undefined {
  if (enabled.length === 0) return undefined
  const wanted = new Set<string>(enabled)
  for (let index = 0; index < strings.length; index += 1) {
    const raw = strings[index]
    if (raw === undefined || !isPathLike(raw)) continue
    const classes = classifySensitivePath(normalizePath(raw)).filter(name => wanted.has(name))
    if (classes.length > 0) return { classes, argumentIndex: index }
  }
  return undefined
}

/** Whether a configured class name is in the vocabulary (for config validation). */
export function isSensitivePathClass(value: unknown): value is SensitivePathClass {
  return typeof value === 'string' && CLASS_SET.has(value)
}
