import { defineConfig } from 'vitest/config'

/**
 * Two projects, because two kinds of test need different machines.
 *
 * `unit` runs everything except the performance budgets: they are functional
 * assertions and may run in parallel, which is what keeps `npx vitest run` fast.
 *
 * `perf` runs ONLY `tests/perf.test.ts`, with file parallelism off. Those cases
 * assert wall-clock p99 budgets, and a budget that fails because eleven sibling
 * workers were using the CPU measures the machine, not the code path. Measured
 * 2026-11-23: the 61 KB `scanToolResult` budget (1.5 ms median against a 5 ms p99)
 * failed 13 of 16 full-suite runs and 0 of 13 runs of the file alone. Serialising
 * the perf project fixes the measurement without relaxing the budget — which is
 * the point: the budget is a regression watchdog and must stay strict.
 *
 * The panel tests need `esbuild.jsx: 'automatic'` (the bundle build compiles JSX
 * that way, so a `.tsx` test cannot render without it).
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.{ts,tsx}'],
          exclude: ['tests/perf.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'perf',
          include: ['tests/perf.test.ts'],
          // The whole reason this project exists: one file, no siblings.
          fileParallelism: false,
          maxWorkers: 1,
        },
      },
    ],
  },
})
