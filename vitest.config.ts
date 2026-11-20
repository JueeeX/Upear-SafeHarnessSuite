import { defineConfig } from 'vitest/config'

/**
 * Test config for the panel's browser half.
 *
 * The bundle build (`scripts/build-client.mjs`) compiles JSX with the automatic
 * runtime; the tests must agree or a `.tsx` test cannot render the component at
 * all (`React is not defined`). Everything else stays on Vitest's defaults.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
})
