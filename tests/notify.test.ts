/**
 * Notification channels: envelope shapes, signing, multi-channel delivery and the
 * privacy ceiling (no URL, no secret, no response body ever leaves this module).
 *
 * The patrol's notify finding is covered separately in tests/patrol.test.ts; this
 * file owns the adapter layer itself.
 * @module
 */
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  buildNotificationRequest,
  deliverNotifications,
  summarizeDelivery,
  type NotifyChannel,
  type NotifyFetch,
} from '../src/notify/channels.js'

const TEXT = 'Upear SafeHarness: 1 FAIL / 0 WARN'

/** A channel with sensible defaults; override what the test cares about. */
function channel(overrides: Partial<NotifyChannel> = {}): NotifyChannel {
  return { type: 'feishu', webhook: 'https://hook.example/path', ...overrides }
}

/** Parse a built request body. */
function bodyOf(request: { body: string }): Record<string, unknown> {
  return JSON.parse(request.body) as Record<string, unknown>
}

describe('buildNotificationRequest', () => {
  it('feishu: msg_type/text envelope, counts-only sentence, no URL in the body', () => {
    const request = buildNotificationRequest(channel({ webhook: 'https://open.feishu.cn/hook/SECRET' }), TEXT)
    expect(request.url).toBe('https://open.feishu.cn/hook/SECRET')
    expect(bodyOf(request)).toEqual({ msg_type: 'text', content: { text: TEXT } })
    expect(request.body).not.toContain('SECRET')
    expect(request.headers['content-type']).toContain('application/json')
  })

  it('dingtalk: msgtype/text envelope and no signature when no secret is configured', () => {
    const request = buildNotificationRequest(channel({ type: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=T' }), TEXT)
    expect(request.url).toBe('https://oapi.dingtalk.com/robot/send?access_token=T')
    expect(bodyOf(request)).toEqual({ msgtype: 'text', text: { content: TEXT } })
  })

  it('dingtalk: signs timestamp\\nsecret with HMAC-SHA256 and keeps the query string intact', () => {
    const secret = 'SECdeadbeef'
    const now = 1_700_000_000_000
    const request = buildNotificationRequest(
      channel({ type: 'dingtalk', webhook: 'https://oapi.dingtalk.com/robot/send?access_token=T', secret }),
      TEXT,
      now,
    )
    const expected = encodeURIComponent(
      createHmac('sha256', secret).update(`${now}\n${secret}`).digest('base64'),
    )
    expect(request.url).toBe(`https://oapi.dingtalk.com/robot/send?access_token=T&timestamp=${now}&sign=${expected}`)
    // The signature travels in the URL only; the body stays the plain envelope.
    expect(request.body).not.toContain(expected)
  })

  it('wecom: msgtype/text envelope', () => {
    const request = buildNotificationRequest(channel({ type: 'wecom', webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=K' }), TEXT)
    expect(bodyOf(request)).toEqual({ msgtype: 'text', text: { content: TEXT } })
  })

  it('onebot (QQ bridge): send_group_msg with a numeric group id', () => {
    const request = buildNotificationRequest(
      channel({ type: 'onebot', webhook: 'http://127.0.0.1:5700/', groupId: '123456' }),
      TEXT,
    )
    expect(bodyOf(request)).toEqual({
      action: 'send_group_msg',
      params: { group_id: 123456, message: TEXT },
      echo: 'safeharness',
    })
    expect(request.headers['authorization']).toBeUndefined()
  })

  it('onebot: keeps a non-numeric group id as a string and adds the bearer token', () => {
    const request = buildNotificationRequest(
      channel({ type: 'onebot', webhook: 'http://127.0.0.1:5700/', groupId: 'group-a', accessToken: 'TOKEN' }),
      TEXT,
    )
    expect((bodyOf(request).params as Record<string, unknown>).group_id).toBe('group-a')
    expect(request.headers['authorization']).toBe('Bearer TOKEN')
    expect(request.body).not.toContain('TOKEN')
  })

  it('generic: default {"text":…} body and a {{text}} template with JSON escaping', () => {
    const plain = buildNotificationRequest(channel({ type: 'generic', webhook: 'https://bot.example/x' }), TEXT)
    expect(bodyOf(plain)).toEqual({ text: TEXT })

    const templated = buildNotificationRequest(
      channel({ type: 'generic', webhook: 'https://bot.example/x', body: '{"text":"{{text}}","channel":"ops"}' }),
      'quote " and \\ backslash',
    )
    expect(bodyOf(templated)).toEqual({ text: 'quote " and \\ backslash', channel: 'ops' })
  })

  it('merges channel headers over the default content-type', () => {
    const request = buildNotificationRequest(
      channel({ type: 'generic', webhook: 'https://bot.example/x', headers: { 'X-Bot-Key': 'K', 'content-type': 'application/vnd.custom+json' } }),
      TEXT,
    )
    expect(request.headers['X-Bot-Key']).toBe('K')
    expect(request.headers['content-type']).toBe('application/vnd.custom+json')
  })
})

describe('deliverNotifications', () => {
  it('returns one result per channel and isolates a failure', async () => {
    const seen: string[] = []
    const fetchImpl: NotifyFetch = async (url) => {
      seen.push(url)
      if (url.includes('bad')) return { status: 500 }
      return { status: 204 }
    }
    const results = await deliverNotifications(
      [
        channel({ type: 'dingtalk', webhook: 'https://a.example/ding' }),
        channel({ type: 'wecom', webhook: 'https://bad.example/wecom' }),
        channel({ type: 'feishu', webhook: 'https://c.example/feishu' }),
      ],
      TEXT,
      { fetchImpl },
    )
    expect(seen).toHaveLength(3)
    expect(results).toEqual([
      { type: 'dingtalk', ok: true },
      { type: 'wecom', ok: false, reason: 'http_500' },
      { type: 'feishu', ok: true },
    ])
    expect(summarizeDelivery(results)).toBe('2/3 channels delivered; 1 failed (wecom: http_500)')
    // Nothing in the tally can identify the destination.
    expect(summarizeDelivery(results)).not.toMatch(/https?:|\/\/|key=/u)
  })

  it('maps a transport rejection to `network` without quoting its message', async () => {
    const fetchImpl: NotifyFetch = async () => {
      throw new Error('connect ECONNREFUSED https://a.example/secret')
    }
    const results = await deliverNotifications([channel()], TEXT, { fetchImpl })
    expect(results).toEqual([{ type: 'feishu', ok: false, reason: 'network' }])
  })

  it('maps an aborted request to `timeout`', async () => {
    const fetchImpl: NotifyFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
    const results = await deliverNotifications([channel()], TEXT, { fetchImpl, timeoutMs: 5 })
    expect(results).toEqual([{ type: 'feishu', ok: false, reason: 'timeout' }])
  })

  it('returns an empty list for no channels and never calls the transport', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }))
    await expect(deliverNotifications([], TEXT, { fetchImpl })).resolves.toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('delivers every envelope over a real HTTP connection', async () => {
    const received: { url: string; body: string }[] = []
    const server = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        received.push({ url: request.url ?? '', body })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    const base = `http://127.0.0.1:${port}`
    try {
      const results = await deliverNotifications([
        { type: 'feishu', webhook: `${base}/feishu` },
        { type: 'dingtalk', webhook: `${base}/dingtalk?access_token=T`, secret: 'S' },
        { type: 'wecom', webhook: `${base}/wecom?key=K` },
        { type: 'onebot', webhook: `${base}/onebot`, groupId: '9', accessToken: 'TOK' },
        { type: 'generic', webhook: `${base}/generic`, body: '{"m":"{{text}}"}' },
      ], TEXT, { timeoutMs: 2000 })
      expect(results.every((item) => item.ok)).toBe(true)
      expect(received).toHaveLength(5)
      const byPath = new Map(received.map((item) => [item.url.split('?')[0] ?? '', item.body]))
      expect(JSON.parse(byPath.get('/feishu') ?? '{}').msg_type).toBe('text')
      expect(JSON.parse(byPath.get('/dingtalk') ?? '{}').msgtype).toBe('text')
      expect(received.find((item) => item.url.startsWith('/dingtalk'))?.url).toContain('sign=')
      expect(JSON.parse(byPath.get('/wecom') ?? '{}').msgtype).toBe('text')
      expect(JSON.parse(byPath.get('/onebot') ?? '{}').action).toBe('send_group_msg')
      expect(JSON.parse(byPath.get('/generic') ?? '{}').m).toBe(TEXT)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('summarizeDelivery', () => {
  it('reports success without naming the route', () => {
    expect(summarizeDelivery([{ type: 'feishu', ok: true }])).toBe('1/1 channels delivered')
  })

  it('groups repeated failures by type and reason', () => {
    expect(summarizeDelivery([
      { type: 'dingtalk', ok: false, reason: 'http_500' },
      { type: 'dingtalk', ok: false, reason: 'http_500' },
      { type: 'wecom', ok: false, reason: 'timeout' },
      { type: 'feishu', ok: true },
    ])).toBe('1/4 channels delivered; 3 failed (dingtalk,wecom: http_500,timeout)')
  })
})
