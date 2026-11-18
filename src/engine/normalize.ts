/**
 * Input normalization before rule matching (1.11.0).
 *
 * Ported from the Python `InformPolicy` cleaning order: strip zero-width
 * characters, drop HTML comments, then NFKC-fold. The point is to close the
 * "invisible character splits a keyword" bypass (`ig\u200bnore all rules`) and
 * the full-width lookalike bypass, without inventing new detection semantics:
 * the same rule set is applied to the cleaned text.
 *
 * Purity: no IO, no state, always total. A changed result is not a finding by
 * itself — the caller decides whether the cleaned text is denied or rewritten.
 * @module
 */

/** Invisible characters that would split a keyword or hide it from a viewer. */
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/gu

/** HTML comments: often used to hide instructions from a human reading the text. */
const HTML_COMMENT = /<!--[\s\S]*?-->/gu

/** What normalization changed. */
export interface NormalizedInput {
  /** The cleaned text (NFKC after removals). */
  readonly text: string
  /** True when the cleaned text differs from the input. */
  readonly changed: boolean
  /** Zero-width characters removed, for the ledger's size-only metrics. */
  readonly zeroWidth: number
  /** HTML comments removed. */
  readonly comments: number
}

/**
 * Clean one text block.
 *
 * @param text - untrusted text; non-strings are treated as empty.
 * @returns the cleaned text plus size-only counts.
 */
export function normalizeInput(text: string): NormalizedInput {
  const raw = typeof text === 'string' ? text : ''
  let zeroWidth = 0
  let comments = 0
  const stripped = raw.replace(ZERO_WIDTH, () => {
    zeroWidth += 1
    return ''
  })
  const uncommented = stripped.replace(HTML_COMMENT, () => {
    comments += 1
    return ''
  })
  // NFKC folds full-width letters/punctuation and compatibility forms, so
  // `ＩＧＮＯＲＥ` and `ｉｇｎｏｒｅ` match the same rule as `ignore`.
  const folded = uncommented.normalize('NFKC')
  return {
    text: folded,
    changed: folded !== raw,
    zeroWidth,
    comments,
  }
}
