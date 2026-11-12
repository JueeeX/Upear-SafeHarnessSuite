/**
 * Host events this package listens to that the pinned Cordis type surface does
 * not declare yet.
 *
 * `loader/volatile-update` is emitted by the DSH Loader when a settings write
 * touched only schema-declared `.volatile()` fields: the running fiber's config
 * references are updated in place, and the event carries the changed paths. The
 * emit is filtered to listeners owned by the updated fiber, so the plugin only
 * sees its own entry's updates.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: string[][]): void
  }
}

export {}
