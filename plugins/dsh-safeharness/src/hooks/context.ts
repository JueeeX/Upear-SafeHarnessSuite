/**
 * Translation helpers between DSH's execution objects and the engine's plain
 * views. All DSH type imports are `import type`, so this module erases to plain
 * field access and the engine stays host-free (§6.14).
 * @module
 */
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ToolResultView, ToolView } from '../engine/types.js'
import type { ResolvedConfig } from '../config.js'
import { resolveTags } from '../engine/tool.js'
import { canonicalJson } from '../util/hash.js'

/** Concatenate the text blocks of one content array. */
export function blocksText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined || blocks.length === 0) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'reasoning') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Text of the messages a step would enter, restricted to genuine end-user input.
 *
 * Tool results are `role: 'user'` too (`source.kind === 'tool'`); scanning them
 * as "user input" would double-report and could deny a turn because a *tool*
 * returned something suspicious — that belongs to the result surface, not here.
 */
export function userInputText(messages: readonly Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    const source = message.source as { kind?: string } | undefined
    if (source?.kind !== 'user') continue
    parts.push(blocksText(message.content))
  }
  return parts.join('\n')
}

/**
 * Count the messages a step would enter that carry no text at all.
 *
 * This is a **read-only signal**, never a rewrite (1.21.0).
 *
 * Why it exists: on 2026-11-25 the host's "retry this turn" appended a user message
 * with `content: []` and `source.kind: 'retry'` to the persisted history. Strict
 * endpoints then rejected every later request with
 * `400 empty_message_content param=messages[N]`, including turns whose own input was
 * perfectly normal — the session was unrecoverable. The plugin could not see it at
 * all: `userInputText` only reads `source.kind === 'user'`, and the failure happens
 * between the host and the provider, past every seam (`incident-2026-11-25.md` §4).
 *
 * Counting it turns "the session is broken and the ledger says nothing" into one
 * queryable number. It deliberately does **not** rewrite the history: a security
 * plugin that silently edits the host's conversation is a larger risk than this bug.
 *
 * @param messages - the messages the step would enter.
 * @returns how many user-role messages have no non-whitespace text, split by whether
 *   they are the retry artefact (`retry`) or something else (`other`).
 */
export function emptyUserMessages(messages: readonly Message[]): { readonly retry: number; readonly other: number } {
  let retry = 0
  let other = 0
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (blocksText(message.content).trim().length > 0) continue
    const source = message.source as { kind?: string } | undefined
    if (source?.kind === 'retry') retry += 1
    else other += 1
  }
  return { retry, other }
}

/**
 * Rewrite the text blocks of genuine end-user messages.
 *
 * The input guard's MODIFY path uses this after normalization: only user turns
 * with `source.kind === 'user'` are rewritten (tool results are `role: 'user'`
 * too and must not be touched here), and every untouched message is returned by
 * reference.
 *
 * @param messages - the messages the step would enter.
 * @param rewrite - pure text transform (normalization).
 * @returns the new list plus whether anything actually changed.
 */
export function rewriteUserText<T extends Message>(
  messages: readonly T[],
  rewrite: (text: string) => string,
): { readonly messages: T[]; readonly changed: boolean } {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'user') return message
    const source = message.source as { kind?: string } | undefined
    if (source?.kind !== 'user') return message
    if (!Array.isArray(message.content)) return message
    let touched = false
    const content = (message.content as readonly ContentBlock[]).map((block) => {
      if (block.type !== 'text') return block
      const text = rewrite(block.text)
      if (text === block.text) return block
      touched = true
      return { ...block, text }
    })
    if (!touched) return message
    changed = true
    return { ...message, content } as T
  })
  return { messages: next, changed }
}

/** Session id of an agent, when it has one. */export function sessionIdOf(agent: { session?: { id?: unknown } } | undefined): string | undefined {
  const id = agent?.session?.id
  return typeof id === 'string' ? id : undefined
}

/** Agent id (== its session id in DSH, kept separate for clarity in the ledger). */
export function agentIdOf(agent: { id?: unknown } | undefined): string | undefined {
  const id = agent?.id
  return typeof id === 'string' ? id : undefined
}

/** The structural slice of a live agent's session header this module reads. */
export interface SessionHeaderLike {
  readonly session?: {
    readonly header?: { readonly cwd?: unknown; readonly createdAt?: unknown }
    /** Older hosts exposed the header as `meta`; kept for compatibility. */
    readonly meta?: { readonly cwd?: unknown; readonly createdAt?: unknown }
  }
}

/** First value that is a non-empty string, or undefined. */
function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** First value that is a finite number, or undefined. */
function firstNumber(...values: readonly unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * Absolute project directory a session was created in, when the host exposes it.
 *
 * The session header's `cwd` is durable session metadata (not conversation
 * content), so the panel may show it to tell two conversations apart. It is
 * read structurally: a host that stops exposing `header.cwd` degrades the panel
 * to the session id alone instead of failing a hook.
 */
export function sessionWorkspaceOf(agent: SessionHeaderLike | undefined): string | undefined {
  return firstString(agent?.session?.header?.cwd, agent?.session?.meta?.cwd)
}

/** Session creation time (epoch ms) from the session header, when exposed. */
export function sessionCreatedAtOf(agent: SessionHeaderLike | undefined): number | undefined {
  return firstNumber(agent?.session?.header?.createdAt, agent?.session?.meta?.createdAt)
}

/** Structural slice of the host's title service (0.2.2 `sessionTitle`). */
export interface SessionTitleServiceLike {
  get?: (session: unknown) => { readonly title?: unknown } | undefined
}

/**
 * Latest session title the host's title service reports, when available.
 *
 * A title is session metadata (an explicit user rename, or a title-provider
 * suggestion) that the panel shows so operators can pick a conversation by
 * name instead of a UUID. It is captured structurally and defensively: a host
 * without the service, a disposed service, or a session that is not live all
 * degrade to `undefined` rather than failing the hook.
 */
export function sessionTitleOf(
  ctx: { get(name: string): unknown },
  agent: { session?: unknown } | undefined,
): string | undefined {
  try {
    const service = ctx.get('sessionTitle') as SessionTitleServiceLike | undefined
    if (service === undefined || typeof service.get !== 'function') return undefined
    const title = service.get(agent?.session)?.title
    if (typeof title !== 'string') return undefined
    const trimmed = title.trim()
    return trimmed.length === 0 ? undefined : trimmed.slice(0, 100)
  } catch {
    return undefined
  }
}

/** Call id of a tool execution as a plain string. */
export function callIdOf(exec: { callId?: unknown }): string | undefined {
  const id = exec.callId
  return typeof id === 'string' ? id : undefined
}

/** UTF-8 byte length of the canonical JSON form of the arguments. */
export function argsByteLength(args: unknown): number {
  try {
    return Buffer.byteLength(canonicalJson(args), 'utf8')
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * Build the engine's view of one tool call.
 *
 * @param exec - the registry's execution object.
 * @param config - resolved config (tag overrides).
 * @param knownTools - name lookup for descriptions (`ctx.tools.get`), optional.
 * @returns the plain view the engine evaluates.
 */
export function toolViewOf(
  exec: Pick<ToolExecution, 'name' | 'arguments' | 'callId'>,
  config: ResolvedConfig,
  knownTools?: { get(name: string): { description?: string } | undefined },
): ToolView {
  const description = knownTools?.get(exec.name)?.description
  const callId = callIdOf(exec)
  const view: ToolView = {
    name: exec.name,
    arguments: exec.arguments,
    argsBytes: argsByteLength(exec.arguments),
    tags: resolveTags(exec.name, config.tools.tagOverrides),
  }
  if (description !== undefined) return { ...view, description }
  if (callId !== undefined) return { ...view, callId }
  return view
}

/** Maximum characters of a tool value we scan (bounds the post-execute cost). */
export const MAX_SCAN_CHARS = 256 * 1024

/** Build the engine's view of one tool result. */
export function toolResultViewOf(exec: Pick<ToolExecution, 'name' | 'callId'>, result: ToolExecutionResult): ToolResultView {
  const text = blocksText(result.content)
  let valueText = ''
  const value = (result as { value?: unknown }).value
  if (typeof value === 'string') {
    valueText = value.slice(0, MAX_SCAN_CHARS)
  } else if (value !== undefined) {
    try {
      valueText = canonicalJson(value).slice(0, MAX_SCAN_CHARS)
    } catch {
      valueText = ''
    }
  }
  const view: ToolResultView = {
    name: exec.name,
    text: text.slice(0, MAX_SCAN_CHARS),
    valueText,
    isError: result.isError,
  }
  const callId = callIdOf(exec)
  return callId === undefined ? view : { ...view, callId }
}
