/**
 * fake-openai — a dependency-free, deterministic OpenAI-compatible Chat
 * Completions server that replays scripted model behaviour from
 * `fake-llm-scenarios.json`.
 *
 * Purpose: let the DSH plugin's execution surfaces (pre-execute / guard /
 * post-execute / llm-stream) be exercised end-to-end in a real profile without a
 * paid model or network access. Node builtins only (`node:http`, `node:crypto`,
 * `node:fs`, `node:path`, `node:url`).
 *
 * Wire contract (standard Chat Completions):
 *   POST /v1/chat/completions   {model, messages[], tools[], stream, ...}
 *     stream:true  -> `text/event-stream`, frames `data: {...}\n\n`, then `data: [DONE]\n\n`
 *     stream:false -> one `chat.completion` JSON body
 *   GET  /v1/models             -> `{object:"list", data:[{id,...}]}`
 *   GET  /health                -> fake server status (scenario names only)
 *
 * Scenario choice: a `[[scenario:NAME]]` token in the **last user message** wins;
 * otherwise the `--scenario` / `startFakeServer({scenario})` default; otherwise
 * the table's `defaultScenario`. An unknown name is a 400 with the known names.
 *
 * Determinism: the same request to the same scenario produces the same frame
 * sequence and the same content bytes. `created` is a fixed fake epoch (table
 * `created`), ids are `chatcmpl-fake-<seq>` / `call_fake_<seq>_<index>` where
 * `<seq>` is a per-server request counter (so replayed ids stay unique inside a
 * session); `resetSequence()` gives byte-identical replays.
 *
 * Privacy: request logging records roles, lengths and sha256 digests only —
 * never message content and never the Authorization value. Content is hashed
 * over the message payload JSON (`{content,tool_calls,tool_call_id,name}`), so a
 * test can prove what the plugin sent without the log being able to leak it.
 *
 * CLI:
 *   node scripts/fake-openai.mjs [--port 0] [--scenario <name>] [--log <path>]
 *                                [--host 127.0.0.1] [--scenarios <path>] [--quiet]
 * Prints exactly `fake-openai listening on http://127.0.0.1:<port>` on stdout.
 *
 * @module fake-openai
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Scenario used when neither a trigger token nor a default names one. */
export const DEFAULT_SCENARIO = 'text'
/** Opening token of the per-request scenario selector. */
export const TRIGGER_OPEN = '[[scenario:'
/** Closing token of the per-request scenario selector. */
export const TRIGGER_CLOSE = ']]'
/** Fake key sentinel operators point a profile at; never a real credential. */
export const FAKE_API_KEY = 'sk-fake-sentinel'
/**
 * Marker every `@upear/dsh-safeharness` semantic-judge prompt carries
 * (`src/judge/client.ts`). A request whose last user message contains it is a
 * judge call and is served the table's `judge` scenario instead of the default
 * one — that is how an end-to-end run can script "the judge says block" while the
 * conversation itself stays a different script.
 */
export const JUDGE_PROMPT_MARKER = '[safeharness-judge]'
/** Hard cap on a request body; a longer one is refused with 413. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024
/** Fallback fake `created` epoch (2026-01-01T00:00:00Z) when the table omits one. */
const FIXED_CREATED = 1_767_225_600
/** Built-in scenario table location (next to this script). */
export const DEFAULT_SCENARIOS_PATH = fileURLToPath(new URL('./fake-llm-scenarios.json', import.meta.url))

/** Hex sha256 of a UTF-8 string. */
function sha256Hex(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * The only per-request content record this server may keep: a digest and a
 * length. The payload is canonical enough to be stable for the same request.
 * @param {unknown} value - the message (or any request fragment) to digest.
 * @returns {{sha256: string, chars: number}} digest + payload length in chars.
 */
function contentDigest(value) {
  const payload = JSON.stringify(value ?? null) ?? 'null'
  return { sha256: sha256Hex(payload), chars: payload.length }
}

/**
 * Read and parse the built-in (or an operator-supplied) scenario table.
 * @param {string} [path] - scenario JSON path; defaults to the file beside this script.
 * @returns {{version?: number, created?: number, defaultModel?: string, models?: string[], defaultScenario?: string, trigger?: {open?: string, close?: string}, scenarios: Record<string, any>, path: string}} parsed table.
 * @throws {Error} when the file is unreadable, not JSON, or not shaped like a table.
 */
export function loadScenarioTable(path = DEFAULT_SCENARIOS_PATH) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`fake-openai: cannot read scenario table ${path}: ${error?.message ?? error}`)
  }
  let table
  try {
    table = JSON.parse(raw)
  } catch (error) {
    throw new Error(`fake-openai: scenario table ${path} is not valid JSON: ${error?.message ?? error}`)
  }
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    throw new Error(`fake-openai: scenario table ${path} must be a JSON object`)
  }
  const scenarios = table.scenarios
  if (scenarios === null || typeof scenarios !== 'object' || Array.isArray(scenarios)
    || Object.keys(scenarios).length === 0) {
    throw new Error(`fake-openai: scenario table ${path} must define a non-empty "scenarios" object`)
  }
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) {
      throw new Error(`fake-openai: scenario "${name}" must be an object`)
    }
    const kind = scenario.kind ?? 'chat'
    if (kind !== 'chat' && kind !== 'error' && kind !== 'hang') {
      throw new Error(`fake-openai: scenario "${name}" has unknown kind ${JSON.stringify(kind)} (chat|error|hang)`)
    }
    if (kind === 'chat' && !Array.isArray(scenario.chunks)) {
      throw new Error(`fake-openai: scenario "${name}" (kind=chat) must have a "chunks" array`)
    }
    if (kind === 'chat' && scenario.chunks.length === 0) {
      throw new Error(`fake-openai: scenario "${name}" must script at least one chunk`)
    }
  }
  return { ...table, path }
}

/** Known scenario names, in table order (used by the 400 diagnostic and /health). */
function scenarioNames(table) {
  return Object.keys(table.scenarios ?? {})
}

/**
 * Text a message carries, whether its `content` is a bare string or an
 * OpenAI content-part array. Used only to find the trigger token.
 * @param {any} message - one wire message.
 * @returns {string} the message's text, or ''.
 */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(part => part !== null && typeof part === 'object' && part.type === 'text'
        && typeof part.text === 'string')
      .map(part => part.text)
      .join('')
  }
  return ''
}

/**
 * Find a `[[scenario:NAME]]` trigger in the last user message of the request.
 * @param {unknown} messages - the wire `messages` array.
 * @param {{open?: string, close?: string}} [trigger] - token pair from the table.
 * @returns {string | undefined} the requested scenario name, if any.
 */
export function findScenarioTrigger(messages, trigger) {
  const open = trigger?.open ?? TRIGGER_OPEN
  const close = trigger?.close ?? TRIGGER_CLOSE
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role !== 'user') continue
    const text = messageText(message)
    const start = text.indexOf(open)
    if (start < 0) return undefined
    const end = text.indexOf(close, start + open.length)
    if (end < 0) return undefined
    return text.slice(start + open.length, end).trim()
  }
  return undefined
}

/**
 * Text of the last user-role message, or ''.
 * @param {unknown} messages - the request's wire messages.
 * @returns {string} the text of the newest user message.
 */
function lastUserMessageText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') return messageText(message)
  }
  return ''
}
/**
 * Materialize one scripted `delta` into verbatim OpenAI shape: unknown keys are
 * dropped, `function.arguments` is forced to a JSON **string**, and a tool-call
 * id is generated when the table pins none.
 * @param {any} delta - the table's delta.
 * @param {number} seq - per-server request counter used for generated ids.
 * @returns {Record<string, any>} the wire delta.
 */
function materializeDelta(delta, seq) {
  if (delta === null || typeof delta !== 'object') return {}
  const out = {}
  if (typeof delta.role === 'string') out.role = delta.role
  if (typeof delta.content === 'string') out.content = delta.content
  if (Array.isArray(delta.tool_calls)) {
    out.tool_calls = delta.tool_calls.map((call, position) => {
      const index = Number.isInteger(call?.index) ? call.index : position
      const fn = call?.function ?? {}
      const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {})
      return {
        index,
        id: typeof call?.id === 'string' && call.id.length > 0 ? call.id : `call_fake_${seq}_${index}`,
        type: typeof call?.type === 'string' ? call.type : 'function',
        function: { name: typeof fn.name === 'string' ? fn.name : '', arguments: args },
      }
    })
  }
  return out
}

/**
 * Fold a scripted chunk list into the single assistant message a non-streaming
 * call returns (arguments are concatenated per tool-call index, as OpenAI
 * streams them).
 * @param {any} scenario - the chat scenario.
 * @param {number} seq - per-server request counter used for generated ids.
 * @returns {{role: string, content: string, toolCalls: any[], finishReason: string, usage?: any}} folded message.
 */
function foldScenarioMessage(scenario, seq) {
  let role = 'assistant'
  let content = ''
  let finishReason = 'stop'
  let usage
  /** @type {Map<number, {id?: string, type: string, name: string, arguments: string}>} */
  const calls = new Map()
  for (const event of scenario.chunks ?? []) {
    if (event?.usage !== undefined && event.usage !== null) {
      usage = event.usage
      continue
    }
    const delta = materializeDelta(event?.delta, seq)
    if (typeof delta.role === 'string') role = delta.role
    if (typeof delta.content === 'string') content += delta.content
    for (const call of delta.tool_calls ?? []) {
      const acc = calls.get(call.index) ?? { type: 'function', name: '', arguments: '' }
      if (typeof call.id === 'string' && call.id.length > 0) acc.id = call.id
      if (typeof call.type === 'string') acc.type = call.type
      if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
        acc.name += call.function.name
      }
      if (typeof call.function?.arguments === 'string') acc.arguments += call.function.arguments
      calls.set(call.index, acc)
    }
    if (typeof event?.finish_reason === 'string' && event.finish_reason.length > 0) {
      finishReason = event.finish_reason
    }
  }
  const toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      id: call.id ?? `call_fake_${seq}_${index}`,
      type: call.type,
      function: { name: call.name, arguments: call.arguments },
    }))
  return { role, content, toolCalls, finishReason, usage }
}

/**
 * Deterministic usage for a scenario that scripts none: character-count based,
 * so the same request always reports the same numbers.
 * @param {any} messages - the request's wire messages.
 * @param {string} completion - the folded completion text.
 * @returns {{prompt_tokens: number, completion_tokens: number, total_tokens: number}} usage.
 */
function estimateUsage(messages, completion) {
  const promptChars = JSON.stringify(Array.isArray(messages) ? messages : []).length
  const prompt = Math.max(1, Math.ceil(promptChars / 4))
  const output = Math.max(1, Math.ceil(String(completion ?? '').length / 4))
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output }
}

/** OpenAI-shaped error body. */
function errorBody(type, message, param = null, code = null) {
  return { error: { message, type, param, code } }
}

/**
 * Write one JSON response. `Date` is suppressed by the caller so replay bytes
 * stay comparable.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 * @param {Record<string, string>} [extraHeaders] - scenario-specific headers.
 * @returns {void}
 */
function sendJson(res, status, body, extraHeaders) {
  if (res.writableEnded) return
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

/**
 * Read the request body as UTF-8 text, refusing oversize bodies.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<string>} the raw body.
 */
function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('request body too large')
        error.code = 'body_too_large'
        rejectBody(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
  })
}

/** Digest of a request's messages: role + sha256 + length, never the text. */
function messageLogRecord(message) {
  const { sha256, chars } = contentDigest({
    content: message?.content ?? null,
    tool_calls: message?.tool_calls ?? null,
    tool_call_id: message?.tool_call_id ?? null,
    name: message?.name ?? null,
  })
  return { role: typeof message?.role === 'string' ? message.role : null, sha256, chars }
}

/** Digest of the Authorization header: presence, scheme, key sha256 + length. */
function authLogRecord(headers) {
  const raw = headers?.authorization
  if (typeof raw !== 'string' || raw.length === 0) return { present: false }
  const separator = raw.indexOf(' ')
  const scheme = separator < 0 ? raw : raw.slice(0, separator)
  const key = separator < 0 ? '' : raw.slice(separator + 1)
  return {
    present: true,
    scheme: scheme.toLowerCase(),
    key_sha256: sha256Hex(key),
    key_chars: key.length,
  }
}

/** Request-side tool metadata: names only (never a description or schema). */
function toolsLogRecord(tools) {
  if (!Array.isArray(tools)) return { count: 0, names: [] }
  const names = tools
    .map(tool => (typeof tool?.function?.name === 'string' ? tool.function.name : null))
    .filter(name => name !== null)
  return { count: tools.length, names }
}

/**
 * Whether the request's history already carries a tool result, i.e. the model
 * is being asked again after the agent executed (or denied) a call. Used only by
 * a scenario's optional `followUp`: replaying the same tool call forever would
 * keep an end-to-end turn from ever finishing.
 * @param {unknown} messages - the request's wire messages.
 * @returns {boolean} true when at least one `tool` role message is present.
 */
function hasToolResult(messages) {
  return Array.isArray(messages) && messages.some(message => message?.role === 'tool')
}

/**
 * Start the fake OpenAI server.
 *
 * @param {object} [options] - server options.
 * @param {number} [options.port] - listen port; 0 (default) picks an ephemeral one.
 * @param {string} [options.host] - bind address; defaults to `127.0.0.1` (loopback only).
 * @param {string} [options.scenario] - default scenario when a request carries no trigger token.
 * @param {string} [options.logPath] - NDJSON request log path; parent dirs are created.
 * @param {string} [options.scenariosPath] - alternate scenario table path.
 * @param {any} [options.scenarios] - an already-parsed scenario table (takes precedence over scenariosPath).
 * @param {boolean} [options.quiet] - suppress the per-request stderr notice.
 * @returns {Promise<{url: string, port: number, host: string, logPath: string | undefined, scenario: string | undefined, close: () => Promise<void>, resetSequence: () => void, requests: ReadonlyArray<Record<string, any>>}>} a running server handle.
 */
export async function startFakeServer(options = {}) {
  const loaded = options.scenarios ?? loadScenarioTable(options.scenariosPath)
  // `judgeScenario` is overridable per run (CLI `--judge-scenario`) so one table can
  // script both a clearing judge and a blocking one.
  const table = typeof options.judgeScenario === 'string'
    ? { ...loaded, judgeScenario: options.judgeScenario }
    : loaded
  if (typeof table.judgeScenario === 'string' && table.scenarios[table.judgeScenario] === undefined) {
    throw new Error(`fake-openai: judgeScenario ${JSON.stringify(table.judgeScenario)} is not in the scenario table`)
  }
  const host = options.host ?? '127.0.0.1'
  const logPath = options.logPath === undefined ? undefined : resolve(options.logPath)
  const quiet = options.quiet === true
  if (logPath !== undefined) mkdirSync(dirname(logPath), { recursive: true })

  /** @type {{seq: number, closed: boolean, requests: Record<string, any>[], closePromise?: Promise<void>}} */
  const state = { seq: 0, closed: false, requests: [] }
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()

  /** Append one digest-only NDJSON record; never throws into the request path. */
  const recordRequest = (record) => {
    state.requests.push(record)
    if (logPath === undefined) return
    try {
      appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      if (!quiet) console.error(`fake-openai: cannot append to log ${logPath}: ${error?.message ?? error}`)
    }
  }

  // ---- request handling ---------------------------------------------------
  const server = createServer()
  /**
   * The whole request pipeline: resolve a scenario, log a digest-only record,
   * then answer.
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @returns {Promise<void>} resolves once the response is written (or held, for `hang`).
   */
  const handle = async (req, res) => {
    res.sendDate = false
    const seq = ++state.seq
    const method = req.method ?? 'GET'
    let path = '/'
    try {
      path = new URL(req.url ?? '/', `http://${host}`).pathname
    } catch {
      path = req.url ?? '/'
    }
    const record = {
      ts: new Date().toISOString(),
      seq,
      method,
      path,
      scenario: null,
      scenario_source: 'default',
      stream: false,
      model: null,
      message_count: 0,
      messages: [],
      tools: { count: 0, names: [] },
      auth: authLogRecord(req.headers),
      response: { kind: 'error', status: 0, stream: false, frames: 0 },
    }

    try {
      // --- non-completion routes -------------------------------------------
      if (method === 'GET' && (path === '/health' || path === '/v1/health')) {
        record.scenario = options.scenario ?? table.defaultScenario ?? DEFAULT_SCENARIO
        record.response = { kind: 'health', status: 200, stream: false, frames: 0 }
        recordRequest(record)
        const body = {
          ok: true,
          service: 'fake-openai',
          scenario: record.scenario,
          scenarios: scenarioNames(table),
          models: (table.models ?? [table.defaultModel ?? 'fake-model']),
        }
        if (!quiet) console.error(`[fake-openai] #${seq} ${method} ${path}`)
        sendJson(res, 200, body)
        return
      }
      if (method === 'GET' && path === '/v1/models') {
        record.response = { kind: 'models', status: 200, stream: false, frames: 0 }
        recordRequest(record)
        const created = typeof table.created === 'number' ? table.created : FIXED_CREATED
        const ids = Array.isArray(table.models) && table.models.length > 0
          ? table.models
          : [table.defaultModel ?? 'fake-model']
        if (!quiet) console.error(`[fake-openai] #${seq} ${method} ${path}`)
        sendJson(res, 200, {
          object: 'list',
          data: ids.map(id => ({ id, object: 'model', created, owned_by: 'fake-openai' })),
        })
        return
      }
      if (path !== '/v1/chat/completions') {
        record.response = { kind: 'error', status: 404, stream: false, frames: 0 }
        recordRequest(record)
        if (!quiet) console.error(`[fake-openai] #${seq} ${method} ${path} -> 404`)
        sendJson(res, 404, errorBody('invalid_request_error',
          `fake-openai: no route for ${method} ${path}; supported: POST /v1/chat/completions, GET /v1/models, GET /health`,
          null, 'not_found'))
        return
      }
      if (method !== 'POST') {
        record.response = { kind: 'error', status: 405, stream: false, frames: 0 }
        recordRequest(record)
        if (!quiet) console.error(`[fake-openai] #${seq} ${method} ${path} -> 405`)
        sendJson(res, 405, errorBody('invalid_request_error',
          `fake-openai: /v1/chat/completions accepts POST, not ${method}`, null, 'method_not_allowed'))
        return
      }

      // --- body ------------------------------------------------------------
      let raw
      try {
        raw = await readBody(req)
      } catch (error) {
        const tooLarge = error?.code === 'body_too_large'
        record.response = { kind: 'error', status: tooLarge ? 413 : 400, stream: false, frames: 0 }
        recordRequest(record)
        if (!quiet) console.error(`[fake-openai] #${seq} POST ${path} -> ${record.response.status} (${error?.message ?? error})`)
        sendJson(res, tooLarge ? 413 : 400, errorBody('invalid_request_error',
          `fake-openai: ${error?.message ?? error}`, null, tooLarge ? 'body_too_large' : 'invalid_request'))
        return
      }
      let body
      try {
        body = raw.length === 0 ? {} : JSON.parse(raw)
      } catch {
        record.response = { kind: 'error', status: 400, stream: false, frames: 0 }
        recordRequest(record)
        if (!quiet) console.error(`[fake-openai] #${seq} POST ${path} -> 400 (invalid JSON)`)
        sendJson(res, 400, errorBody('invalid_request_error',
          'fake-openai: request body is not valid JSON', null, 'invalid_json'))
        return
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        record.response = { kind: 'error', status: 400, stream: false, frames: 0 }
        recordRequest(record)
        sendJson(res, 400, errorBody('invalid_request_error',
          'fake-openai: request body must be a JSON object', null, 'invalid_request'))
        return
      }

      // --- scenario resolution --------------------------------------------
      const trigger = findScenarioTrigger(body.messages, table.trigger)
      // The security plugin's judge call is a normal chat completion whose prompt
      // carries a stable marker; serving it the conversation's script would make an
      // end-to-end judge test meaningless, so it takes the `judge` scenario when the
      // table defines one. Everything else is unchanged.
      const judgeRequest = typeof table.judgeScenario === 'string'
        && table.scenarios[table.judgeScenario] !== undefined
        && lastUserMessageText(body.messages).includes(table.judgeTrigger ?? JUDGE_PROMPT_MARKER)
      const name = judgeRequest
        ? table.judgeScenario
        : trigger ?? options.scenario ?? table.defaultScenario ?? DEFAULT_SCENARIO
      const scenario = table.scenarios[name]
      const stream = body.stream === true
      const model = typeof body.model === 'string' && body.model.length > 0
        ? body.model
        : table.defaultModel ?? 'fake-model'
      record.scenario = name
      record.scenario_served = name
      record.scenario_source = judgeRequest ? 'judge' : trigger === undefined ? 'default' : 'trigger'
      record.stream = stream
      record.model = model
      record.message_count = Array.isArray(body.messages) ? body.messages.length : 0
      record.messages = Array.isArray(body.messages) ? body.messages.map(messageLogRecord) : []
      record.tools = toolsLogRecord(body.tools)

      if (scenario === undefined) {
        const known = scenarioNames(table).join(', ')
        record.response = { kind: 'error', status: 400, stream, frames: 0 }
        recordRequest(record)
        if (!quiet) console.error(`[fake-openai] #${seq} POST ${path} -> 400 (unknown scenario "${name}")`)
        sendJson(res, 400, errorBody('invalid_request_error',
          `fake-openai: unknown scenario ${JSON.stringify(name)}; known scenarios: ${known}`, 'scenario', 'unknown_scenario'))
        return
      }

      // A scenario may name a `followUp` served once the request history already
      // carries a tool result. Without it, replaying one scripted tool call
      // forever would leave an end-to-end turn with no way to finish. The
      // decision is a pure function of the request, so replay stays
      // deterministic; `record.scenario_served` shows which branch answered.
      let servedName = name
      let served = scenario
      if (typeof scenario.followUp === 'string' && hasToolResult(body.messages)) {
        servedName = scenario.followUp
        served = table.scenarios[servedName]
        if (served === undefined) {
          record.response = { kind: 'error', status: 400, stream, frames: 0 }
          recordRequest(record)
          if (!quiet) console.error(`[fake-openai] #${seq} POST ${path} -> 400 (unknown followUp "${servedName}")`)
          sendJson(res, 400, errorBody('invalid_request_error',
            `fake-openai: scenario ${JSON.stringify(name)} names followUp ${JSON.stringify(servedName)}, which is not in the table`,
            'scenario', 'unknown_follow_up'))
          return
        }
        record.scenario_served = servedName
      }

      const kind = served.kind ?? 'chat'

      // --- error / hang ----------------------------------------------------
      if (kind === 'error') {
        const status = Number.isInteger(served.status) ? served.status : 500
        record.response = { kind: 'error', status, stream: false, frames: 0 }
        recordRequest(record)
        if (!quiet) console.error(`[fake-openai] #${seq} POST ${path} scenario=${servedName} -> ${status}`)
        const error = served.error ?? {
          message: `fake-openai: scripted error (scenario ${servedName})`,
          type: 'server_error',
          param: null,
          code: 'fake_server_error',
        }
        sendJson(res, status, { error }, served.headers)
        return
      }
      if (kind === 'hang') {
        // Drain the body, then never answer. No timer is created, so nothing
        // keeps the loop alive beyond the accepted socket; close() destroys it.
        req.resume()
        record.response = { kind: 'hang', status: 0, stream, frames: 0 }
        recordRequest(record)
        if (!quiet) console.error(`[fake-openai] #${seq} POST ${path} scenario=${servedName} -> hang (no response)`)
        return
      }

      // --- chat ------------------------------------------------------------
      const created = typeof table.created === 'number' ? table.created : FIXED_CREATED
      const id = `chatcmpl-fake-${seq}`
      const folded = foldScenarioMessage(served, seq)
      const usage = folded.usage ?? estimateUsage(body.messages, folded.content)
      const extraHeaders = served.headers ?? {}

      if (!stream) {
        // A tool-calling assistant message carries `content: null` beside
        // `tool_calls` (OpenAI's shape); a text reply carries the string.
        const message = { role: folded.role, content: folded.toolCalls.length > 0 ? null : folded.content }
        if (folded.toolCalls.length > 0) {
          message.tool_calls = folded.toolCalls.map(call => ({
            id: call.id,
            type: call.type,
            function: { name: call.function.name, arguments: call.function.arguments },
          }))
        }
        record.response = { kind: 'chat', status: 200, stream: false, frames: 1 }
        recordRequest(record)
        if (!quiet) console.error(`[fake-openai] #${seq} POST ${path} scenario=${servedName} stream=false -> 200`)
        sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [{ index: 0, message, finish_reason: folded.finishReason, logprobs: null }],
          usage,
        }, extraHeaders)
        return
      }

      record.response = { kind: 'chat', status: 200, stream: true, frames: served.chunks.length + 1 }
      recordRequest(record)
      if (!quiet) console.error(`[fake-openai] #${seq} POST ${path} scenario=${servedName} stream=true -> 200`)
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...extraHeaders,
      })
      res.flushHeaders?.()
      for (const event of served.chunks) {
        let payload
        if (event?.usage !== undefined && event.usage !== null) {
          // OpenAI include_usage final chunk: empty choices, top-level usage.
          payload = { id, object: 'chat.completion.chunk', created, model, choices: [], usage: event.usage }
        } else {
          payload = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: materializeDelta(event?.delta, seq),
              finish_reason: typeof event?.finish_reason === 'string' ? event.finish_reason : null,
            }],
          }
        }
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      record.response = { kind: 'error', status: 500, stream: false, frames: 0 }
      recordRequest(record)
      if (!quiet) console.error(`[fake-openai] #${seq} internal error: ${error?.stack ?? error}`)
      if (!res.headersSent && !res.writableEnded) {
        sendJson(res, 500, errorBody('server_error',
          `fake-openai: internal error: ${error?.message ?? error}`, null, 'internal_error'))
      } else if (!res.writableEnded) {
        res.destroy()
      }
    }
  }

  server.on('request', (req, res) => {
    handle(req, res).catch((error) => {
      if (!quiet) console.error(`fake-openai: unhandled request failure: ${error?.stack ?? error}`)
      if (!res.writableEnded) res.destroy()
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  // A malformed client must not take the server down; drop the socket instead.
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed) socket.destroy()
  })
  server.on('error', (error) => {
    if (!quiet) console.error(`fake-openai: server error: ${error?.message ?? error}`)
  })

  // ---- listen -------------------------------------------------------------
  const port = Number.isInteger(options.port) ? options.port : 0
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      rejectListen(new Error(`fake-openai: cannot listen on ${host}:${port}: ${error?.message ?? error}`))
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  const url = `http://${host}:${actualPort}`

  /** Close the listener and destroy every live socket (including a `hang` request). */
  const close = () => {
    if (state.closePromise !== undefined) return state.closePromise
    state.closed = true
    state.closePromise = new Promise((resolveClose, rejectClose) => {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      server.closeAllConnections?.()
      server.close((error) => {
        if (error !== undefined && error !== null) rejectClose(error)
        else resolveClose()
      })
    })
    return state.closePromise
  }

  return {
    url,
    port: actualPort,
    host,
    logPath,
    scenario: options.scenario,
    close,
    resetSequence: () => { state.seq = 0 },
    requests: state.requests,
  }
}

// ---- CLI ------------------------------------------------------------------

const USAGE = `Usage: node scripts/fake-openai.mjs [options]

Options:
  --port <n>          listen port (default 0 = ephemeral; the URL is printed on stdout)
  --host <addr>       bind address (default 127.0.0.1)
  --scenario <name>   default scenario when a request carries no [[scenario:NAME]] trigger
  --log <path>        append one NDJSON request record per request (roles + sha256 + lengths only)
  --scenarios <path>  scenario table (default: scripts/fake-llm-scenarios.json beside this script)
  --judge-scenario <name>
                      scenario served to a safeharness judge request (default: the table's judgeScenario)
  --quiet             do not print the one-line per-request notice on stderr
  -h, --help          show this help

The API key is a fake sentinel (e.g. ${FAKE_API_KEY}); it is never logged (sha256 only).
`

/** Parse CLI arguments; throws a message meant for the operator (exit code 2). */
function parseArgs(argv) {
  const options = { port: 0, host: '127.0.0.1', scenario: undefined, logPath: undefined, scenariosPath: undefined, judgeScenario: undefined, quiet: false }
  let i = 0
  const value = (flag) => {
    i += 1
    const next = argv[i]
    if (next === undefined) throw new Error(`missing value for ${flag}`)
    return next
  }
  while (i < argv.length) {
    const arg = argv[i]
    switch (arg) {
      case '--port': {
        const parsed = Number(value(arg))
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error('--port must be an integer 0-65535')
        options.port = parsed
        break
      }
      case '--host':
        options.host = value(arg)
        break
      case '--scenario':
        options.scenario = value(arg)
        break
      case '--judge-scenario':
        options.judgeScenario = value(arg)
        break
      case '--log':
        options.logPath = value(arg)
        break
      case '--scenarios':
        options.scenariosPath = value(arg)
        break
      case '--quiet':
        options.quiet = true
        break
      case '--help':
      case '-h':
        process.stdout.write(USAGE)
        process.exit(0)
        break
      default:
        throw new Error(`unknown argument ${JSON.stringify(arg)}\n\n${USAGE}`)
    }
    i += 1
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const table = loadScenarioTable(options.scenariosPath)
  if (options.scenario !== undefined && table.scenarios[options.scenario] === undefined) {
    throw new Error(`unknown scenario ${JSON.stringify(options.scenario)}; known scenarios: ${scenarioNames(table).join(', ')}`)
  }
  const server = await startFakeServer({ ...options, scenarios: table })
  process.stdout.write(`fake-openai listening on ${server.url}\n`)
  if (!options.quiet) {
    const extras = [
      `scenario=${options.scenario ?? table.defaultScenario ?? DEFAULT_SCENARIO}`,
      `scenarios=${server.url}/health`,
      options.logPath === undefined ? 'log=-' : `log=${server.logPath}`,
    ]
    console.error(`[fake-openai] ${extras.join(' ')}`)
  }
  const shutdown = () => {
    server.close().then(() => process.exit(0), () => process.exit(1))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`fake-openai: ${error?.message ?? error}`)
    process.exit(2)
  })
}
