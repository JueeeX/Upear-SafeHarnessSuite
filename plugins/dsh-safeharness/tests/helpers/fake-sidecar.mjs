/**
 * Test double for the Python engine process.
 *
 * Speaks the same newline-delimited JSON envelope as the real sidecar
 * (`src/engine/sidecar.ts`), so the transport can be tested without Python and
 * without the repository's engine: `health`, `echo`, `fail`, `slow`, `crash`,
 * `junk`. It also prints a non-JSON banner on startup on purpose — a real child
 * (interpreter warnings, a stray `print`) does that too, and the transport must
 * ignore it instead of corrupting the protocol.
 */
import { createInterface } from 'node:readline'

const send = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
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
  switch (request.method) {
    case 'health':
      send({ v: 1, id, ok: true, result: { ok: true, engine: 'fake' } })
      return
    case 'echo':
      send({ v: 1, id, ok: true, result: request.params ?? null })
      return
    case 'fail':
      send({ v: 1, id, ok: false, error: { code: 'bad_input', message: 'rejected by the fake engine' } })
      return
    case 'slow':
      // Never answer: the transport must time out on its own.
      return
    case 'junk':
      process.stdout.write('this line is not JSON either\n')
      send({ v: 1, id, ok: true, result: 'after-junk' })
      return
    case 'crash':
      process.exit(3)
      return
    default:
      send({ v: 1, id, ok: false, error: { code: 'unknown_method', message: 'no such method' } })
  }
})
