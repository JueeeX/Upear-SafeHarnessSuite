/**
 * PII / sensitive-value classes: the TypeScript port of the ten hardcoded rules
 * in `SUMC/src/backend/core/memory/sanitizer.py` (`REDACT_PATTERNS`), one rule per
 * name, in the kernel's declaration order.
 *
 * Why this lives on the tool-result face: the kernel applies these patterns to the
 * text about to be *stored* (a memory write). The DSH plugin has no memory store,
 * but a tool result is the equivalent ingress — it is untrusted text on its way
 * into the model's context and into the transcript. Detection is therefore a
 * finding (`category: 'pii'`), never an automatic rewrite: rewriting a tool result
 * would corrupt the evidence a session is reasoning about. Blocking stays a
 * policy decision (`results.blockOn` including `pii`).
 *
 * Port notes (deliberate, documented in MANUAL §4.10):
 *
 * - Python's `\d` is Unicode-aware and JS's is ASCII-only. Every digit class is
 *   spelled `[0-9]` so a CJK/Arabic-Indic digit run cannot change the verdict
 *   between the two engines.
 * - Python's `\w` is Unicode-aware; `[\w.-]` in the intranet-URL rule is spelled
 *   `[\p{L}\p{N}_.-]` (and the trailing `\b` becomes an explicit lookahead) so the
 *   two agree on internationalised hostnames.
 * - No regex carries `g`: a shared pattern object must stay stateless.
 * - The pattern list is fixed and small, so there is no dynamic compilation and no
 *   cache to poison.
 *
 * Nothing here ever returns matched text: callers receive class names only, which
 * is what makes a `pii` finding safe to persist.
 * @module
 */

/** Severity attached to one class when it fires (finding-level maximum wins). */
export interface PiiClass {
  /** Rule name exactly as the kernel spells it (`id_card`, `phone_cn`, ...). */
  readonly name: string
  readonly severity: 'high' | 'medium'
  readonly regex: RegExp
}

/**
 * The ten kernel classes, in the kernel's order.
 *
 * `api_key` / `jwt` overlap the plugin's own `credential_leak` patterns on
 * purpose: the kernel scans for them here, and the credential face additionally
 * carries the entropy and assignment heuristics that the kernel does not have.
 */
export const PII_CLASSES: readonly PiiClass[] = [
  // Generic PII
  { name: 'id_card', severity: 'high', regex: /(?<![0-9])[1-9][0-9]{14}(?:[0-9]{2}[0-9Xx])?(?![0-9])/u },
  { name: 'phone_cn', severity: 'medium', regex: /(?<![0-9])1[3-9][0-9]{9}(?![0-9])/u },
  {
    name: 'email',
    severity: 'medium',
    // The kernel writes `[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+`. Both
    // quantifiers are bounded here (RFC 5321 limits: 64-char local part, 63-char
    // labels) because an unbounded `+` before a required `@` backtracks quadratically
    // over a 256 KiB tool result — measured: 111 s for one scan. Every real address
    // still matches.
    regex: /[A-Za-z0-9_.+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+/u,
  },
  { name: 'bank_card', severity: 'high', regex: /(?<![0-9])[0-9]{16,19}(?![0-9])/u },
  // Secrets
  { name: 'api_key', severity: 'high', regex: /(?:sk-|Bearer\s+)[A-Za-z0-9_-]{20,}/u },
  { name: 'jwt', severity: 'high', regex: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u },
  // Government
  { name: 'doc_no', severity: 'medium', regex: /[\u4e00-\u9fa5]{2,4}〔[0-9]{4}〕[0-9]+号/u },
  { name: 'gov_serial', severity: 'medium', regex: /[\u4e00-\u9fa5]{2,8}[字发]〔[0-9]{4}〕[0-9]+/u },
  // Enterprise
  { name: 'customer_id', severity: 'medium', regex: /(?:CUST|CID)[-_]?[0-9]{4,}/u },
  {
    name: 'internal_url',
    severity: 'medium',
    regex: /https?:\/\/[\p{L}\p{N}_.-]*\.(?:internal|corp|intra)(?![A-Za-z0-9_])/u,
  },
]

/** Every class name, in declaration order (config validation and the panel use it). */
export const PII_CLASS_NAMES: readonly string[] = PII_CLASSES.map((item) => item.name)

/** Severity ordering for "highest wins" reductions. */
const SEVERITY_RANK: Record<'high' | 'medium', number> = { high: 2, medium: 1 }

/** One PII scan result: class names only, never a matched value. */
export interface PiiHit {
  /** Matched class names, de-duplicated, in declaration order. */
  readonly classes: readonly string[]
  /** Highest severity among the matched classes (`undefined` when clean). */
  readonly severity?: 'high' | 'medium'
}

/** An empty hit, shared: callers must not mutate it. */
const NO_HIT: PiiHit = { classes: [] }

/**
 * Scan text for the kernel's PII classes.
 *
 * @param text - text to inspect (a tool result projection, never logged).
 * @param classes - enabled class names. `undefined` means "every class"; an empty
 *   array (or one naming no known class) disables the scan entirely.
 * @returns matched class names and the highest severity; never matched text.
 */
export function scanPii(text: string, classes?: readonly string[]): PiiHit {
  if (typeof text !== 'string' || text.length === 0) return NO_HIT
  const enabled = classes === undefined ? undefined : new Set(classes)
  const matched: string[] = []
  let severity: 'high' | 'medium' | undefined
  for (const item of PII_CLASSES) {
    if (enabled !== undefined && !enabled.has(item.name)) continue
    // Stateless by construction (no `g`), but reset defensively against a caller
    // that shared a mutated copy.
    if (item.regex.global || item.regex.sticky) item.regex.lastIndex = 0
    if (!item.regex.test(text)) continue
    matched.push(item.name)
    if (severity === undefined || SEVERITY_RANK[item.severity] > SEVERITY_RANK[severity]) severity = item.severity
  }
  if (matched.length === 0) return NO_HIT
  return { classes: matched, severity }
}
