/**
 * Notification channels for patrol (§6.10 #5, extended from Feishu-only).
 *
 * One dirty patrol is worth telling an operator about, and different deployments
 * live in different chat products: Feishu/Lark, DingTalk, WeCom, and self-hosted
 * QQ bridges (OneBot) all accept a plain-text message over an HTTP webhook, but
 * their envelopes differ. This module owns that mapping.
 *
 * Two rules shape the code:
 *
 * - **A webhook URL and any signing secret are credentials.** They are never
 *   logged, never returned, never written to the ledger, and never quoted in an
 *   error: {@link deliverNotifications} returns only a type and a coarse reason.
 * - **One channel's failure must not hide another's success.** Delivery returns one
 *   result per channel; the caller decides what `notified` means.
 *
 * @module
 */
import { createHmac } from 'node:crypto'

/** Envelope families this build knows how to speak. */
export type NotifyChannelType = 'feishu' | 'dingtalk' | 'wecom' | 'onebot' | 'generic'

/** One configured destination. */
export interface NotifyChannel {
  /** Which envelope to build. */
  readonly type: NotifyChannelType
  /** Webhook URL (credential: never printed or logged). */
  readonly webhook: string
  /** DingTalk signing secret (only meaningful for `dingtalk`). */
  readonly secret?: string
  /** Extra request headers (e.g. a bot's own authorization header). */
  readonly headers?: Readonly<Record<string, string>>
  /** `generic` body template; `{{text}}` is replaced by the JSON-escaped text. */
  readonly body?: string
  /** `onebot`: the group id to post into. */
  readonly groupId?: string
  /** `onebot`: bearer token for the bridge, when it requires one. */
  readonly accessToken?: string
}

/** Outcome of one channel's delivery; never carries the URL or the response body. */
export interface NotifyResult {
  /** Which envelope was attempted. */
  readonly type: NotifyChannelType
  /** True only for a 2xx response. */
  readonly ok: boolean
  /** Coarse failure reason: `timeout`, `network`, `http_<status>` or `invalid`. */
  readonly reason?: string
}

/** Transport seam so tests (and a future proxy) can replace `fetch`. */
export type NotifyFetch = (url: string, init: {
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly signal: AbortSignal
}) => Promise<{ status: number }>

/** Options for {@link deliverNotifications}. */
export interface DeliverOptions {
  /** Wall-clock cap per channel. */
  readonly timeoutMs?: number
  /** Clock, injectable for the DingTalk signature tests. */
  readonly now?: number
  /** Replace the network transport (tests). */
  readonly fetchImpl?: NotifyFetch
}

/** Cap per channel so one hung webhook cannot stall the patrol. */
const DEFAULT_TIMEOUT_MS = 3000

/**
 * JSON-escape a string for safe embedding inside a JSON string literal.
 *
 * `JSON.stringify` wraps the result in quotes; slicing them off yields the escaped
 * interior, which is exactly what a `{{text}}` placeholder inside a JSON body needs.
 */
function jsonEscape(text: string): string {
  return JSON.stringify(text).slice(1, -1)
}

/** Base64 HMAC-SHA256 over `timestamp\nsecret`, as DingTalk's signer requires. */
function dingtalkSign(secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
}

/**
 * Append DingTalk's `timestamp`/`sign` pair to a webhook URL.
 *
 * Done with string concatenation (not `URL`) so an existing query string is kept
 * verbatim and the secret never round-trips through a parser that could normalise it.
 */
function signedDingtalkUrl(webhook: string, secret: string, timestamp: number): string {
  const separator = webhook.includes('?') ? '&' : '?'
  const sign = encodeURIComponent(dingtalkSign(secret, timestamp))
  return `${webhook}${separator}timestamp=${timestamp}&sign=${sign}`
}

/**
 * Build the request for one channel. Pure: no I/O, no clock reads unless asked.
 *
 * @param channel - destination and envelope family.
 * @param text - the counts-only notification sentence.
 * @param now - epoch milliseconds used for the DingTalk signature.
 * @returns the URL, headers and JSON body to POST.
 */
export function buildNotificationRequest(
  channel: NotifyChannel,
  text: string,
  now: number = Date.now(),
): { readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body: string } {
  const baseHeaders: Record<string, string> = { 'content-type': 'application/json' }
  switch (channel.type) {
    case 'feishu':
      return { url: channel.webhook, headers: { ...baseHeaders, ...channel.headers }, body: JSON.stringify({ msg_type: 'text', content: { text } }) }
    case 'dingtalk': {
      const url = channel.secret === undefined || channel.secret.length === 0
        ? channel.webhook
        : signedDingtalkUrl(channel.webhook, channel.secret, now)
      return { url, headers: { ...baseHeaders, ...channel.headers }, body: JSON.stringify({ msgtype: 'text', text: { content: text } }) }
    }
    case 'wecom':
      return { url: channel.webhook, headers: { ...baseHeaders, ...channel.headers }, body: JSON.stringify({ msgtype: 'text', text: { content: text } }) }
    case 'onebot': {
      const groupId = channel.groupId ?? ''
      const numeric = /^\d+$/u.test(groupId) ? Number(groupId) : groupId
      const headers: Record<string, string> = { ...baseHeaders, ...channel.headers }
      if (channel.accessToken !== undefined && channel.accessToken.length > 0) {
        headers['authorization'] = `Bearer ${channel.accessToken}`
      }
      return {
        url: channel.webhook,
        headers,
        body: JSON.stringify({ action: 'send_group_msg', params: { group_id: numeric, message: text }, echo: 'safeharness' }),
      }
    }
    case 'generic': {
      const template = channel.body === undefined || channel.body.length === 0
        ? '{"text":"{{text}}"}'
        : channel.body
      return {
        url: channel.webhook,
        headers: { ...baseHeaders, ...channel.headers },
        body: template.split('{{text}}').join(jsonEscape(text)),
      }
    }
  }
}

/** Default transport: one POST with an abort deadline; only the status is read. */
async function defaultFetch(url: string, init: {
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly signal: AbortSignal
}): Promise<{ status: number }> {
  const response = await fetch(url, { method: init.method, headers: { ...init.headers }, body: init.body, signal: init.signal })
  return { status: response.status }
}

/** Classify a thrown transport error without quoting anything it carries. */
function failureReason(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout'
  return 'network'
}

/**
 * Deliver one notification to every configured channel.
 *
 * Never throws: a bad channel becomes an `ok: false` result so the caller can report
 * "1 of 3 failed" without losing the two that worked. Channels run sequentially —
 * a handful of small POSTs, and sequential keeps a hung endpoint from holding more
 * than its own deadline.
 *
 * @param channels - normalized destinations; empty means "nothing configured".
 * @param text - the counts-only notification sentence.
 * @param options - deadline, clock and transport seams.
 * @returns one result per channel, in configuration order.
 */
export async function deliverNotifications(
  channels: readonly NotifyChannel[],
  text: string,
  options: DeliverOptions = {},
): Promise<readonly NotifyResult[]> {
  const fetchImpl = options.fetchImpl ?? defaultFetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now()
  const results: NotifyResult[] = []
  for (const channel of channels) {
    let request: ReturnType<typeof buildNotificationRequest>
    try {
      request = buildNotificationRequest(channel, text, now)
    } catch {
      results.push({ type: channel.type, ok: false, reason: 'invalid' })
      continue
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
      try {
        const response = await fetchImpl(request.url, {
          method: 'POST',
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        })
        results.push(response.status >= 200 && response.status < 300
          ? { type: channel.type, ok: true }
          : { type: channel.type, ok: false, reason: `http_${response.status}` })
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      results.push({ type: channel.type, ok: false, reason: failureReason(error) })
    }
  }
  return results
}

/** Count successes and failures per envelope family for the patrol finding detail. */
export function summarizeDelivery(results: readonly NotifyResult[]): string {
  const total = results.length
  const failed = results.filter((item) => !item.ok)
  if (failed.length === 0) return `${total}/${total} channels delivered`
  const types = [...new Set(failed.map((item) => item.type))].join(',')
  const reasons = [...new Set(failed.map((item) => item.reason ?? 'error'))].join(',')
  return `${total - failed.length}/${total} channels delivered; ${failed.length} failed (${types}: ${reasons})`
}
