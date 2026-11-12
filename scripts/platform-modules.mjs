/**
 * The browser module table's seeded specifiers (T5.3).
 *
 * Copied verbatim from the DSH source tree
 * `packages/client/web/src/platform.ts` (`PLATFORM_MODULES`, version
 * 0.2.2-rc.1 app bundle). A client bundle may `require` exactly these and
 * nothing else: the lazy CJS table answers any other specifier with a throw at
 * materialization time, which in the packaged shell is a blank GUI.
 *
 * Keep this list a copy, not a dependency: the host packages are not on the
 * public registry, and the list is a wire contract rather than an API.
 */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]
