import { readFile } from 'node:fs/promises'
import { z } from 'zod'

export interface HubMessage {
  seq: number
  receivedAt: string
  timestamp: number
  kind: 'message' | 'edit' | 'reaction' | 'poll_vote'
  sender: { number: string; uuid: string; name: string; device: number }
  group: { id: string; internalId: string; restId: string; name: string } | null
  text: string
  quote: { timestamp: number; author: { number: string; uuid: string }; text: string } | null
  attachments: { id: string; contentType: string; size: number; filename: string; caption: string }[]
  editOf: number
}
export interface Pull { messages: HubMessage[]; next: number; missed: number; reset: boolean }
export interface SendInput { recipient: string; text: string; quote?: { timestamp: number; author: string } }
export interface SendFailure { number: string; uuid: string; reason: string }
export interface SendResult { timestamps: number[]; failures: SendFailure[] }

export class HubError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'HubError'
  }
}

const identity = z.object({ number: z.string(), uuid: z.string() }).loose()
const MessageSchema = z.object({
  seq: z.number().int(),
  receivedAt: z.string(),
  timestamp: z.number(),
  kind: z.enum(['message', 'edit', 'reaction', 'poll_vote']),
  sender: identity.extend({ name: z.string(), device: z.number() }),
  group: z.object({ id: z.string(), internalId: z.string(), restId: z.string(), name: z.string() }).loose().nullable(),
  text: z.string(),
  quote: z.object({ timestamp: z.number(), author: identity, text: z.string() }).loose().nullable(),
  attachments: z.array(z.object({ id: z.string(), contentType: z.string(), size: z.number(), filename: z.string(), caption: z.string() }).loose()),
  editOf: z.number(),
}).loose()
const PullSchema = z.object({ messages: z.array(MessageSchema), next: z.number().int(), missed: z.number().int(), reset: z.boolean() })

const MIN_TOKEN_LENGTH = 32
const SEND_TIMEOUT_MS = 30_000
const ATTACHMENT_TIMEOUT_MS = 60_000

export class HubClient {
  constructor(
    private readonly options: () => { url: string; tokenFile: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async pull(after: number | undefined, wait: number, limit: number, signal: AbortSignal): Promise<Pull> {
    const query = new URLSearchParams()
    if (after !== undefined) query.set('after', String(after))
    query.set('wait', String(wait))
    query.set('limit', String(limit))
    const response = await this.request(`/v1/messages?${query}`, { method: 'GET' }, (wait + 15) * 1000, signal)
    const parsed = PullSchema.safeParse(await readJson<unknown>(response))
    if (!parsed.success) throw new HubError('the hub answered with a malformed pull response', 502)
    return parsed.data as Pull
  }

  async send(input: SendInput, signal?: AbortSignal): Promise<SendResult> {
    const response = await this.request('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }, SEND_TIMEOUT_MS, signal)
    const body = await readJson<{ timestamps?: number[]; failures?: SendFailure[] }>(response)
    return { timestamps: body.timestamps ?? [], failures: body.failures ?? [] }
  }

  async attachment(id: string, maxBytes: number, signal?: AbortSignal): Promise<{ data: Uint8Array; contentType: string }> {
    const tooLarge = () => new HubError(`attachment exceeds ${maxBytes} bytes`, 413)
    const controller = new AbortController()
    const response = await this.request(`/v1/attachments/${encodeURIComponent(id)}`, { method: 'GET' }, ATTACHMENT_TIMEOUT_MS,
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) {
      controller.abort()
      throw tooLarge()
    }
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      const reader = response.body?.getReader()
      for (;;) {
        const chunk = await reader?.read()
        if (!chunk || chunk.done) break
        size += chunk.value.byteLength
        if (size > maxBytes) {
          controller.abort()
          throw tooLarge()
        }
        chunks.push(chunk.value)
      }
    } catch (error) {
      throw error instanceof HubError ? error : transportError(error)
    }
    const data = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { data, contentType: response.headers.get('content-type') ?? 'application/octet-stream' }
  }

  private async token(tokenFile: string): Promise<string> {
    let raw: string
    try {
      raw = await readFile(tokenFile, 'utf8')
    } catch {
      throw new HubError('the token file cannot be read', 0)
    }
    const token = raw.trim()
    if (token.length < MIN_TOKEN_LENGTH) throw new HubError('the token file holds fewer than 32 characters', 0)
    return token
  }

  private async request(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const { url, tokenFile } = this.options()
    const token = await this.token(tokenFile)
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(`${url.replace(/\/+$/, '')}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch (error) {
      throw transportError(error)
    }
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined
      await response.body?.cancel().catch(() => undefined)
      throw new HubError(typeof body?.error === 'string' && body.error !== '' ? body.error : response.statusText, response.status)
    }
    return response
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    throw new HubError('the hub answered with invalid JSON', response.status)
  }
}

function transportError(error: unknown): HubError {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError') return new HubError('the hub request timed out', 0)
  if (name === 'AbortError') return new HubError('the hub request was aborted', 0)
  return new HubError('the hub request failed', 0)
}
