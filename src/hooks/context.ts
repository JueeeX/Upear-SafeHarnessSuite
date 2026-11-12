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

/** Session id of an agent, when it has one. */
export function sessionIdOf(agent: { session?: { id?: unknown } } | undefined): string | undefined {
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
