/**
 * Where the packaged rule directory lives at runtime.
 *
 * One definition for the composition root (`lib/index.js` → `../rules`) and the
 * command surface (`lib/surface/commands.js` → `../../rules`): both are siblings of
 * their module file, so the same relative jump does not work from two depths. Keeping
 * the jump in this module means every caller resolves the same directory — a second
 * hand-written copy is exactly how "reload reads one dir, check reads another" bugs
 * happen.
 * @module
 */
import { fileURLToPath } from 'node:url'

/**
 * Absolute path of the `rules/` directory shipped inside the package.
 *
 * `src/util/packaged.ts` and `lib/util/packaged.js` are both two levels below the
 * package root, so `../../rules/` is correct in the source tree and after the build.
 */
export function packagedRulesDir(): string {
  return fileURLToPath(new URL('../../rules/', import.meta.url))
}
