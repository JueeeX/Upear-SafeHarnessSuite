/**
 * Test double for the Python engine process.
 *
 * Speaks the same newline-delimited JSON envelope as the real sidecar
 * (`src/engine/sidecar.ts`), so the transport can be tested without Python and
 * without the repository's engine.
 *
 * Methods: `health`, `echo`, `fail`, `slow`, `crash`, `junk`, `set_rules`,
 * `evaluate_input`, `inspect_sql`, `inform_match`. It also prints a non-JSON
 * banner on startup on purpose — a real child (interpreter warnings, a stray
 * `print`) does that too, and the transport must ignore it instead of corrupting
 * the protocol.
 *
 * Modes (`--mode <name>`, or `--mode-file <path>` so a test can switch between two
 * `start()` attempts of the same transport):
 * - `normal`  answer everything;
 * - `no-health` never answer `health` (handshake timeout);
 * - `bad-health` answer `health` with an error envelope;
 * - `flood` write an unterminated line larger than the transport's cap;
 * - `crlf` terminate frames with `\r\n`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
/** Value after one argv flag, or undefined. */
const argValue = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

let mode = argValue('--mode') ?? 'normal'
const modeFile = argValue('--mode-file')

/** Re-read the mode file (if any) so a test can change behaviour between starts. */
function currentMode() {
  if (modeFile !== undefined && existsSync(modeFile)) {
    try {
      const text = readFileSync(modeFile, 'utf8').trim()
      if (text.length > 0) mode = text
    } catch {
      // keep the previous mode
    }
  }
  return mode
}

const send = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/** Rules installed by `set_rules` (name + source), used by the evaluate methods. */
let rules = []

/** Dangerous-SQL heuristic good enough for transport tests (never shipped). */
function inspectSql(text) {
  const dangerous = /drop\s+table|truncate\s+table|delete\s+from/i.test(text)
  return { is_sql: dangerous, dangerous, statement_kinds: dangerous ? ['ddl'] : [] }
}

/** Names of the installed rules whose pattern matches `text`. */
function matchedRules(text) {
  const matched = []
  for (const rule of rules) {
    try {
      if (new RegExp(rule.pattern, 'iu').test(text)) matched.push(rule.name)
    } catch {
      // a broken pattern simply never matches here; set_rules is what validates it
    }
  }
  return matched
}

process.stdout.write('fake sidecar booting (this line is intentionally not JSON)\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  const id = request.id
  const params = request.params ?? {}
  const terminate = currentMode() === 'crlf' ? '\r\n' : '\n'
  const reply = (payload) => process.stdout.write(`${JSON.stringify(payload)}${terminate}`)

  switch (request.method) {
    case 'health':
      if (currentMode() === 'no-health') return
      if (currentMode() === 'bad-health') {
        reply({ v: 1, id, ok: false, error: { code: 'python_framework_missing', message: 'no framework' } })
        return
      }
      if (currentMode() === 'flood') {
        // One unterminated line (8 MiB) — the transport must kill us, not buffer it.
        process.stdout.write(Buffer.alloc(8 * 1024 * 1024, 0x78))
        return
      }
      reply({ v: 1, id, ok: true, result: { ok: true, engine: 'fake', patterns: rules.length, sql: true } })
      return
    case 'set_rules': {
      const incoming = Array.isArray(params.rules) ? params.rules : []
      const rejected = []
      const accepted = []
      for (const rule of incoming) {
        if (typeof rule?.pattern !== 'string' || rule.pattern.includes('BADREGEX')) {
          rejected.push({ name: String(rule?.name ?? 'unknown'), code: 'bad_regex' })
        } else {
          accepted.push(rule)
        }
      }
      rules = accepted
      reply({ v: 1, id, ok: true, result: { accepted: accepted.length, rejected } })
      return
    }
    case 'evaluate_input': {
      const text = typeof params.text === 'string' ? params.text : ''
      if (currentMode() === 'bogus-rule') {
        reply({ v: 1, id, ok: true, result: { rules: ['a_rule_nobody_installed'], sql: { dangerous: false } } })
        return
      }
      const matched = matchedRules(text)
      reply({ v: 1, id, ok: true, result: { rules: matched, sql: inspectSql(text) } })
      return
    }
    case 'inspect_sql': {
      const text = typeof params.text === 'string' ? params.text : ''
      reply({ v: 1, id, ok: true, result: inspectSql(text) })
      return
    }
    case 'inform_match': {
      const text = typeof params.text === 'string' ? params.text : ''
      reply({ v: 1, id, ok: true, result: { rules: matchedRules(text) } })
      return
    }
    case 'echo':
      reply({ v: 1, id, ok: true, result: params })
      return
    case 'fail':
      reply({ v: 1, id, ok: false, error: { code: 'bad_input', message: 'rejected by the fake engine' } })
      return
    case 'slow':
      // Never answer: the transport must time out on its own.
      return
    case 'junk':
      process.stdout.write('this line is not JSON either\n')
      reply({ v: 1, id, ok: true, result: 'after-junk' })
      return
    case 'crash':
      process.exit(3)
      return
    default:
      reply({ v: 1, id, ok: false, error: { code: 'unknown_method', message: 'no such method' } })
  }
})
