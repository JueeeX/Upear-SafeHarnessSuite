/**
 * T2.7 — fake OpenAI-compatible SSE server tests.
 *
 * These tests are the contract for `scripts/fake-openai.mjs`: the wire shape a
 * real `@deepseek-ai/dsh-llm-pi-ai` profile will see, the seven scripted
 * scenarios, deterministic replay, and the privacy rule that the request log
 * carries sha256 + length but never the prompt (or the fake key).
 *
 * Every server is started on port 0 in-process and closed in `afterEach`; log
 * files live under `os.tmpdir()` so nothing is written inside the repository.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// `scripts/fake-openai.mjs` is deliberately untyped plain JS (Node builtins
// only) and lives outside tsconfig's `src` include; the cast below is the seam.
// @ts-ignore -- no declaration file for the plain-JS scenario server (by design)
import * as fakeOpenAI from '../scripts/fake-openai.mjs'

/** The handle `startFakeServer` returns. */
interface FakeServerHandle {
  url: string
  port: number
  host: string
  logPath: string | undefined
  scenario: string | undefined
  close(): Promise<void>
  resetSequence(): void
  requests: ReadonlyArray<Record<string, any>>
}

/** The options `startFakeServer` accepts. */
interface FakeServerOptions {
  port?: number
  host?: string
  scenario?: string
  logPath?: string
  scenariosPath?: string
  quiet?: boolean
}

const { startFakeServer, loadScenarioTable } = fakeOpenAI as unknown as {
  startFakeServer(options?: FakeServerOptions): Promise<FakeServerHandle>
  loadScenarioTable(path?: string): { scenarios: Record<string, any>, path: string }
}

/** A request/response pair seen by the test fetch helper. */
interface ChatReply {
  status: number
  contentType: string | null
  body: string
  json: any
}

const servers: FakeServerHandle[] = []
const tempDirs: string[] = []

/** Start a fake server on an ephemeral port, tracked for `afterEach`. */
async function start(options: FakeServerOptions = {}): Promise<FakeServerHandle> {
  const server = await startFakeServer({ port: 0, quiet: true, ...options })
  servers.push(server)
  return server
}

/** A fresh temporary directory, removed in `afterEach`. */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-llm-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  // Close first: a `hang` scenario leaves a live socket that would keep the
  // worker alive (and vitest would report an open handle).
  await Promise.all(servers.splice(0).map(server => server.close()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One `POST /v1/chat/completions`, buffered (SSE bodies fit comfortably). */
async function chat(
  server: FakeServerHandle,
  body: Record<string, any>,
  options: { headers?: Record<string, string>, signal?: AbortSignal } = {},
): Promise<ChatReply> {
  const response = await fetch(`${server.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
    signal: options.signal,
  })
  const text = await response.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, contentType: response.headers.get('content-type'), body: text, json }
}

/** Split an SSE body into frame payloads; throws (not asserts) so failures read clearly. */
function sseFrames(body: string): string[] {
  if (!body.endsWith('\n\n')) throw new Error(`SSE body does not end with a blank line: ${JSON.stringify(body.slice(-16))}`)
  const blocks = body.slice(0, -2).split('\n\n')
  return blocks.map((block) => {
    if (!block.startsWith('data: ')) throw new Error(`SSE frame does not start with "data: ": ${JSON.stringify(block)}`)
    if (block.includes('\n')) throw new Error(`SSE frame spans multiple lines: ${JSON.stringify(block)}`)
    return block.slice('data: '.length)
  })
}

/** Parsed `chat.completion.chunk` payloads, excluding the `[DONE]` sentinel. */
function chunks(frames: string[]): any[] {
  return frames.filter(frame => frame !== '[DONE]').map(frame => JSON.parse(frame))
}

/** Concatenated `delta.content` of a streamed reply. */
function streamedText(frames: string[]): string {
  return chunks(frames)
    .map(chunk => chunk.choices?.[0]?.delta?.content ?? '')
    .join('')
}

/** Every `tool_calls` delta in a streamed reply, flattened in arrival order. */
function streamedToolCalls(frames: string[]): any[] {
  return chunks(frames).flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? [])
}

/** Hex sha256, the same digest the server logs. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
describe('OpenAI shape', () => {
  it('non-streaming text reply is a chat.completion with message, finish_reason and usage', async () => {
    const server = await start()
    const reply = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'say hello' }],
      stream: false,
    })

    expect(reply.status).toBe(200)
    expect(reply.contentType).toContain('application/json')
    expect(reply.json.object).toBe('chat.completion')
    expect(reply.json.id).toMatch(/^chatcmpl-fake-\d+$/)
    expect(reply.json.created).toBe(1767225600)
    expect(reply.json.model).toBe('fake-model')
    expect(reply.json.choices).toHaveLength(1)
    expect(reply.json.choices[0].index).toBe(0)
    expect(reply.json.choices[0].message).toEqual({ role: 'assistant', content: 'Hello from the fake model.' })
    expect(reply.json.choices[0].finish_reason).toBe('stop')
    expect(Number.isInteger(reply.json.usage.prompt_tokens)).toBe(true)
    expect(Number.isInteger(reply.json.usage.completion_tokens)).toBe(true)
    expect(reply.json.usage.total_tokens)
      .toBe(reply.json.usage.prompt_tokens + reply.json.usage.completion_tokens)
  })

  it('streaming text reply is SSE, reassembles the scripted text and ends with data: [DONE]', async () => {
    const server = await start()
    const reply = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'say hello' }],
      stream: true,
    })

    expect(reply.status).toBe(200)
    expect(reply.contentType).toContain('text/event-stream')
    const frames = sseFrames(reply.body)
    expect(frames.at(-1)).toBe('[DONE]')
    expect(frames).toHaveLength(5) // role + 2 content deltas + finish + [DONE]
    expect(streamedText(frames)).toBe('Hello from the fake model.')

    const parsed = chunks(frames)
    expect(parsed.map(chunk => chunk.object)).toEqual(Array(4).fill('chat.completion.chunk'))
    expect(parsed[0].choices[0].delta).toEqual({ role: 'assistant' })
    expect(parsed[0].choices[0].finish_reason).toBeNull()
    expect(parsed[3].choices[0].finish_reason).toBe('stop')
    expect(parsed[3].choices[0].delta).toEqual({})
  })

  it('streaming frames are byte-plausible OpenAI SSE frames', async () => {
    const server = await start()
    const reply = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'say hello' }],
      stream: true,
    })

    expect(reply.body).not.toContain('\r')
    expect(reply.body).not.toContain('event:')
    expect(reply.body.endsWith('data: [DONE]\n\n')).toBe(true)
    // One `data: {...}` per line, one space after the colon, blank-line framed.
    for (const block of reply.body.slice(0, -2).split('\n\n')) {
      expect(block).toMatch(/^data: .+$/)
    }
    for (const chunk of chunks(sseFrames(reply.body))) {
      expect(chunk.id).toMatch(/^chatcmpl-fake-\d+$/)
      expect(chunk.choices[0].delta).toBeTypeOf('object')
    }
  })

  it('replays byte-identically after resetSequence()', async () => {
    const server = await start()
    const request = { model: 'fake-model', messages: [{ role: 'user', content: 'same' }], stream: true }

    const first = await chat(server, request)
    server.resetSequence()
    const second = await chat(server, request)

    expect(second.body).toBe(first.body)
    expect(second.status).toBe(first.status)
  })

  it('GET /v1/models lists the fake model', async () => {
    const server = await start()
    const reply = await fetch(`${server.url}/v1/models`)
    const body = await reply.json() as any

    expect(reply.status).toBe(200)
    expect(body.object).toBe('list')
    expect(body.data[0]).toEqual({
      id: 'fake-model',
      object: 'model',
      created: 1767225600,
      owned_by: 'fake-openai',
    })
  })

  it('GET /health reports the scenario names and the active default', async () => {
    const server = await start({ scenario: 'usage' })
    const body = await fetch(`${server.url}/health`).then(reply => reply.json()) as any

    expect(body.ok).toBe(true)
    expect(body.scenario).toBe('usage')
    expect(body.scenarios).toEqual([
      'text',
      'tool-call-bash',
      'tool-call-three-parallel',
      'code-mode',
      'error-500',
      'hang',
      'judge-allow',
      'judge-block',
      'tool-call-patrol',
      'tool-call-patrol-notify',
      'tool-call-patrol-notify-usage',
      'usage',
    ])
  })
})

// ---------------------------------------------------------------------------
describe('judge request routing (T3.1 end-to-end support)', () => {
  /** A request shaped like the plugin's judge call (marker in the user prompt). */
  const judgeRequest = (marker = '[safeharness-judge]'): Record<string, any> => ({
    model: 'fake-model',
    messages: [
      { role: 'system', content: 'judge instructions' },
      { role: 'user', content: `${marker}\nPlease review the following answer.\n<answer>hi</answer>` },
    ],
    stream: true,
  })

  it('serves the judge scenario to a request carrying the judge marker', async () => {
    const server = await start({ scenario: 'text' })
    const reply = await chat(server, judgeRequest())
    const frames = sseFrames(reply.body)
    expect(streamedText(frames)).toBe('{"verdict":"allow"}')
    const record = server.requests.at(-1)
    expect(record?.scenario_served).toBe('judge-allow')
    expect(record?.scenario_source).toBe('judge')
  })

  it('honours a per-run judge scenario override (block)', async () => {
    const server = await start({ scenario: 'text', judgeScenario: 'judge-block' })
    const reply = await chat(server, judgeRequest())
    const text = streamedText(sseFrames(reply.body))
    expect(JSON.parse(text)).toEqual({ verdict: 'block', reason: 'credential leak' })
    expect(server.requests.at(-1)?.scenario_served).toBe('judge-block')
  })

  it('leaves ordinary requests on their own scenario', async () => {
    const server = await start({ scenario: 'text' })
    const reply = await chat(server, { model: 'fake-model', messages: [{ role: 'user', content: 'hello' }], stream: true })
    expect(streamedText(sseFrames(reply.body))).toBe('Hello from the fake model.')
    expect(server.requests.at(-1)?.scenario_source).toBe('default')
  })

  it('refuses an unknown judge scenario at startup', async () => {
    await expect(start({ judgeScenario: 'no-such-scenario' })).rejects.toThrow(/judgeScenario/u)
  })
})

describe('scripted tool calls', () => {
  it('tool-call-bash streams one bash call whose arguments are a JSON string', async () => {
    const server = await start({ scenario: 'tool-call-bash' })
    const reply = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'run a destructive command' }],
      stream: true,
    })

    const frames = sseFrames(reply.body)
    const calls = streamedToolCalls(frames)
    expect(calls).toHaveLength(1)
    expect(calls[0].index).toBe(0)
    expect(calls[0].id).toMatch(/^call_fake_\d+_0$/)
    expect(calls[0].type).toBe('function')
    expect(calls[0].function.name).toBe('bash')
    // OpenAI puts the JSON in `arguments` as a STRING, never as an object.
    expect(calls[0].function.arguments).toBeTypeOf('string')
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: 'rm -rf /tmp/x' })
    expect(streamedText(frames)).toBe('')
    expect(chunks(frames).at(-1)?.choices[0].finish_reason).toBe('tool_calls')
  })

  it('tool-call-three-parallel yields bash + web_fetch + todo_write in one response', async () => {
    const server = await start({ scenario: 'tool-call-three-parallel' })
    const reply = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'three calls' }],
      stream: true,
    })

    const frames = sseFrames(reply.body)
    const calls = streamedToolCalls(frames)
    expect(calls.map(call => call.index)).toEqual([0, 1, 2])
    expect(calls.map(call => call.function.name)).toEqual(['bash', 'web_fetch', 'todo_write'])
    expect(calls.map(call => JSON.parse(call.function.arguments))).toEqual([
      { command: 'rm -rf /tmp/x' },
      { url: 'https://example.invalid' },
      { todos: [] },
    ])
    expect(new Set(calls.map(call => call.id)).size).toBe(3)
    expect(chunks(frames).filter(chunk => chunk.choices[0].finish_reason === 'tool_calls')).toHaveLength(1)
  })

  it('code-mode scripts the shipped run_code schema (code + description, tools.<name> binding)', async () => {
    const server = await start({ scenario: 'code-mode' })
    const reply = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'echo hi in code mode' }],
      stream: true,
    })

    const calls = streamedToolCalls(sseFrames(reply.body))
    expect(calls).toHaveLength(1)
    expect(calls[0].function.name).toBe('run_code')
    const args = JSON.parse(calls[0].function.arguments)
    // The real dsh-tools schema requires BOTH parameters (code-mode.ts:305-312).
    expect(Object.keys(args).sort()).toEqual(['code', 'description'])
    expect(args.code).toBeTypeOf('string')
    // Windows host: the shell tool is `pwsh` (bash-sandbox is disabled there), and
    // the plugin denies pwsh by name — which is exactly what makes this scenario
    // usable as the Code Mode sub-dispatch proof (§12 R30/R34).
    expect(args.code).toContain('tools.pwsh(')
    expect(args.code).toContain('await ')
    expect(args.description.trim().length).toBeGreaterThan(0)
  })

  it('non-streaming tool call folds fragments into one assistant message', async () => {
    const server = await start({ scenario: 'tool-call-three-parallel' })
    const reply = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'three calls' }],
      stream: false,
    })

    const message = reply.json.choices[0].message
    expect(message.role).toBe('assistant')
    expect(message.content).toBeNull()
    expect(message.tool_calls).toHaveLength(3)
    expect(message.tool_calls[0].function.name).toBe('bash')
    expect(typeof message.tool_calls[0].function.arguments).toBe('string')
    expect(reply.json.choices[0].finish_reason).toBe('tool_calls')
  })
})

// ---------------------------------------------------------------------------
describe('error, hang and unknown scenarios', () => {
  it('error-500 returns HTTP 500 with an OpenAI-style error body', async () => {
    const server = await start({ scenario: 'error-500' })
    const reply = await chat(server, { model: 'fake-model', messages: [{ role: 'user', content: 'boom' }] })

    expect(reply.status).toBe(500)
    expect(reply.contentType).toContain('application/json')
    expect(reply.json.error).toBeTypeOf('object')
    expect(reply.json.error.type).toBe('server_error')
    expect(reply.json.error.code).toBe('fake_server_error')
    expect(reply.json.error.message).toContain('error-500')
  })

  it('unknown scenario name returns 400 naming the known scenarios', async () => {
    const server = await start()
    const reply = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'try [[scenario:not-a-scenario]] please' }],
    })

    expect(reply.status).toBe(400)
    expect(reply.json.error.code).toBe('unknown_scenario')
    expect(reply.json.error.param).toBe('scenario')
    expect(reply.json.error.message).toContain('not-a-scenario')
    expect(reply.json.error.message).toContain('tool-call-bash')
  })

  it('hang accepts the request and never answers; the client times out and close() still settles', async () => {
    const server = await start({ scenario: 'hang' })

    await expect(chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hang please' }],
    }, { signal: AbortSignal.timeout(150) })).rejects.toThrow(/timeout|abort/i)

    // The request was accepted and recorded before the hang.
    const last = server.requests.at(-1)
    expect(last?.scenario).toBe('hang')
    expect(last?.response.kind).toBe('hang')

    // A hung socket must not keep close() (or the process) waiting.
    await expect(Promise.race([
      server.close(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('close() hung')), 2000).unref()),
    ])).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
describe('scenario selection', () => {
  it('a trigger token in the last user message overrides the server default', async () => {
    const server = await start({ scenario: 'text' })

    const triggered = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'use [[scenario:tool-call-bash]]' }],
      stream: true,
    })
    expect(streamedToolCalls(sseFrames(triggered.body))[0]?.function.name).toBe('bash')

    const plain = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'no trigger here' }],
      stream: true,
    })
    expect(streamedText(sseFrames(plain.body))).toBe('Hello from the fake model.')
  })

  it('a tool-call scenario follows up with text once the history carries a tool result', async () => {
    const logPath = join(tempDir(), 'requests.ndjson')
    const server = await start({ scenario: 'tool-call-bash', logPath })
    const first = await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: 'run it' }],
      stream: true,
    })
    expect(streamedToolCalls(sseFrames(first.body))[0]?.function.name).toBe('bash')

    // The agent executed (or denied) the call and asked the model again: the
    // history now carries a tool result, so the followUp scenario answers and the
    // turn can finish instead of replaying the same tool call forever.
    const second = await chat(server, {
      model: 'fake-model',
      messages: [
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_fake_1_0',
            type: 'function',
            function: { name: 'bash', arguments: '{"command":"rm -rf /tmp/x"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_fake_1_0', content: 'blocked by policy' },
      ],
      stream: true,
    })
    expect(streamedToolCalls(sseFrames(second.body))).toHaveLength(0)
    expect(streamedText(sseFrames(second.body))).toBe('Hello from the fake model.')

    const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(entries.map(entry => [entry.scenario, entry.scenario_served])).toEqual([
      ['tool-call-bash', 'tool-call-bash'],
      ['tool-call-bash', 'text'],
    ])
  })

  it('the shipped scenario table declares exactly the documented scenarios', () => {
    const table = loadScenarioTable()
    expect(Object.keys(table.scenarios).sort()).toEqual([
      'code-mode',
      'error-500',
      'hang',
      'judge-allow',
      'judge-block',
      'text',
      'tool-call-bash',
      'tool-call-patrol',
      'tool-call-patrol-notify',
      'tool-call-patrol-notify-usage',
      'tool-call-three-parallel',
      'usage',
    ])
    for (const [name, scenario] of Object.entries(table.scenarios)) {
      const kind = scenario.kind ?? 'chat'
      expect(['chat', 'error', 'hang'], `scenario ${name}`).toContain(kind)
      if (kind === 'chat') expect(Array.isArray(scenario.chunks) && scenario.chunks.length > 0, name).toBe(true)
    }
    // Every scripted tool call ships `arguments` as a JSON string.
    for (const scenario of Object.values(table.scenarios)) {
      for (const chunk of scenario.chunks ?? []) {
        for (const call of chunk.delta?.tool_calls ?? []) {
          expect(typeof call.function.arguments, scenario.description).toBe('string')
          expect(() => JSON.parse(call.function.arguments)).not.toThrow()
        }
      }
    }
  })
})

// ---------------------------------------------------------------------------
describe('request log privacy', () => {
  it('records sha256 + length per message, never the prompt and never the fake key', async () => {
    const logPath = join(tempDir(), 'requests.ndjson')
    const server = await start({ logPath })
    const prompt = 'PROMPT-SENTINEL-2f7c9a1b: please do the thing'
    const systemText = 'SYSTEM-SENTINEL-8d1e: you are a test'

    await chat(server, {
      model: 'fake-model',
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: prompt },
      ],
      tools: [{ type: 'function', function: { name: 'bash', description: 'run a command', parameters: {} } }],
    }, { headers: { authorization: 'Bearer sk-fake-sentinel' } })

    const raw = readFileSync(logPath, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(server.logPath).toBe(logPath)

    // The load-bearing assertion: no raw content, no raw key.
    expect(raw).not.toContain('PROMPT-SENTINEL')
    expect(raw).not.toContain('SYSTEM-SENTINEL')
    expect(raw).not.toContain('sk-fake-sentinel')
    expect(raw).not.toContain('please do the thing')

    const entries = raw.trim().split('\n').map(line => JSON.parse(line))
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry.method).toBe('POST')
    expect(entry.path).toBe('/v1/chat/completions')
    expect(entry.scenario).toBe('text')
    expect(entry.stream).toBe(false)
    expect(entry.model).toBe('fake-model')
    expect(entry.message_count).toBe(2)
    expect(entry.messages.map((message: any) => message.role)).toEqual(['system', 'user'])

    // The digests are exactly the payload digests, so evidence can correlate a
    // logged request with a prompt the test still holds.
    const userPayload = JSON.stringify({ content: prompt, tool_calls: null, tool_call_id: null, name: null })
    expect(entry.messages[1].sha256).toBe(sha256(userPayload))
    expect(entry.messages[1].chars).toBe(userPayload.length)
    expect(entry.messages[1].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(entry.messages[0].sha256).not.toBe(entry.messages[1].sha256)

    // The fake key is only ever a digest, but its identity is still provable.
    expect(entry.auth).toEqual({
      present: true,
      scheme: 'bearer',
      key_sha256: sha256('sk-fake-sentinel'),
      key_chars: 'sk-fake-sentinel'.length,
    })

    expect(entry.tools.count).toBe(1)
    expect(entry.tools.names).toEqual(['bash'])
    expect(entry.response).toEqual({ kind: 'chat', status: 200, stream: false, frames: 1 })
  })

  it('logs the 400 of an unknown scenario too', async () => {
    const logPath = join(tempDir(), 'requests.ndjson')
    const server = await start({ logPath })

    await chat(server, {
      model: 'fake-model',
      messages: [{ role: 'user', content: '[[scenario:ghost]]' }],
    })

    const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(entries).toHaveLength(1)
    expect(entries[0].scenario).toBe('ghost')
    expect(entries[0].response).toEqual({ kind: 'error', status: 400, stream: false, frames: 0 })
  })
})
