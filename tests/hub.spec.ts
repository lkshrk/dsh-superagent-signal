import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HubClient, HubError } from '../src/hub.ts'
import { fakeHub, type FakeHub } from './fakes.ts'

const TOKEN = 'a'.repeat(32)
let hub: FakeHub
let dir: string
let tokenFile: string
let client: HubClient

beforeEach(async () => {
  hub = await fakeHub()
  dir = mkdtempSync(join(tmpdir(), 'hub-spec-'))
  tokenFile = join(dir, 'token')
  writeFileSync(tokenFile, `${TOKEN}\n`)
  client = new HubClient(() => ({ url: hub.url, tokenFile }))
})

afterEach(async () => {
  await hub.close()
  rmSync(dir, { recursive: true, force: true })
})

const signal = () => new AbortController().signal
const rejection = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error)

describe('pull', () => {
  it('pulls with the cursor, wait and limit and the bearer token', async () => {
    hub.respond({ json: { messages: [], next: 41, missed: 0, reset: false } })
    await client.pull(41, 30, 100, signal())
    const [request] = hub.requests
    expect(request?.method).toBe('GET')
    expect(request?.path).toBe('/v1/messages?after=41&wait=30&limit=100')
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('omits after on the first pull', async () => {
    hub.respond({ json: { messages: [], next: 9, missed: 0, reset: false } })
    await client.pull(undefined, 0, 50, signal())
    const url = new URL(hub.requests[0]!.path, 'http://x')
    expect(url.searchParams.has('after')).toBe(false)
    expect(url.searchParams.get('limit')).toBe('50')
  })

  it('returns reset and missed as given', async () => {
    hub.respond({ json: { messages: [], next: 7, missed: 3, reset: true } })
    expect(await client.pull(99, 0, 100, signal())).toEqual({ messages: [], next: 7, missed: 3, reset: true })
  })

  it('reads the token on every call', async () => {
    hub.respond({ json: { messages: [], next: 1, missed: 0, reset: false } }, { json: { messages: [], next: 1, missed: 0, reset: false } })
    await client.pull(0, 0, 1, signal())
    writeFileSync(tokenFile, `${'b'.repeat(40)}\n`)
    await client.pull(0, 0, 1, signal())
    expect(hub.requests.map(r => r.headers.authorization)).toEqual([`Bearer ${TOKEN}`, `Bearer ${'b'.repeat(40)}`])
  })

  it('stops when the caller aborts', async () => {
    hub.respond({ hold: true })
    const controller = new AbortController()
    const pending = rejection(client.pull(1, 30, 100, controller.signal))
    await hub.requested(1)
    controller.abort()
    expect(await pending).toBeInstanceOf(Error)
  })
})

describe('pull validation', () => {
  const valid = {
    seq: 1, receivedAt: '2026-11-14T10:00:00.123Z', timestamp: 1763114400000, kind: 'message',
    sender: { number: '+49', uuid: 'u', name: 'Owner', device: 1 }, group: null, text: 'hi', quote: null, attachments: [], editOf: 0, mentions: [],
  }

  it('keeps extra keys on valid messages', async () => {
    hub.respond({ json: { messages: [valid], next: 2, missed: 0, reset: false } })
    const pulled = await client.pull(0, 0, 1, signal())
    expect(pulled.messages[0]).toEqual(valid)
  })

  it('passes unknown kinds through', async () => {
    const sticker = { ...valid, kind: 'sticker' }
    hub.respond({ json: { messages: [sticker], next: 2, missed: 0, reset: false } })
    expect((await client.pull(0, 0, 1, signal())).messages).toEqual([sticker])
  })

  it('fails with 502 when a message entry is malformed', async () => {
    const { sender: _sender, ...broken } = valid
    hub.respond({ json: { messages: [valid, broken], next: 3, missed: 0, reset: false } })
    const error = await rejection(client.pull(0, 0, 2, signal()))
    expect(error).toBeInstanceOf(HubError)
    expect(error).toMatchObject({ status: 502 })
  })

  it('fails with 502 when the cursor is missing', async () => {
    hub.respond({ json: { messages: [] } })
    expect(await rejection(client.pull(0, 0, 1, signal()))).toMatchObject({ status: 502 })
  })

  it('throws a HubError with the response status for an invalid JSON body', async () => {
    hub.respond({ headers: { 'content-type': 'application/json' }, chunks: [new TextEncoder().encode('{nope')] })
    const error = await rejection(client.pull(0, 0, 1, signal()))
    expect(error).toBeInstanceOf(HubError)
    expect(error).toMatchObject({ status: 200, message: 'the hub answered with invalid JSON' })
  })
})

describe('transport', () => {
  it('reports an abort while the body streams as aborted, not as invalid JSON', async () => {
    let opened!: () => void
    const bodyOpen = new Promise<void>(resolve => { opened = resolve })
    const streaming = (async (_url, init) => {
      const response = new Response(new ReadableStream({
        start: stream => { init?.signal?.addEventListener('abort', () => stream.error(init.signal?.reason)) },
      }), { status: 200 })
      opened()
      return response
    }) as typeof fetch
    const aborting = new HubClient(() => ({ url: hub.url, tokenFile }), streaming)
    const controller = new AbortController()
    const pending = rejection(aborting.pull(1, 30, 100, controller.signal))
    await bodyOpen
    controller.abort()
    const error = await pending
    expect(error).toBeInstanceOf(HubError)
    expect(error).toMatchObject({ status: 0, message: 'the hub request was aborted' })
  })

  it('joins a hubUrl with a trailing slash without doubling it', async () => {
    hub.respond({ json: { messages: [], next: 1, missed: 0, reset: false } })
    await new HubClient(() => ({ url: `${hub.url}/`, tokenFile })).pull(1, 0, 1, signal())
    expect(hub.requests[0]?.path).toBe('/v1/messages?after=1&wait=0&limit=1')
  })
})

describe('send', () => {
  it('sends a quote reply and returns the timestamps', async () => {
    hub.respond({ json: { timestamp: 5, timestamps: [5] } })
    const quote = { timestamp: 1763114400000, author: '0b6a1f2e-0000-4000-8000-000000000000' }
    const result = await client.send({ recipient: 'internalA', text: 'Done', quote })
    const [request] = hub.requests
    expect(request?.method).toBe('POST')
    expect(request?.path).toBe('/v1/send')
    expect(request?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(request?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(request!.body)).toEqual({ recipient: 'internalA', text: 'Done', quote })
    expect(result).toEqual({ timestamps: [5], failures: [] })
  })

  it('returns the failed recipients', async () => {
    const failures = [{ number: '+492', uuid: '', reason: 'UNREGISTERED' }]
    hub.respond({ json: { timestamp: 6, timestamps: [6], failures } })
    expect(await client.send({ recipient: 'internalA', text: 'Hi' })).toEqual({ timestamps: [6], failures })
  })
})

describe('errors', () => {
  it('throws HubError with the status and error text', async () => {
    hub.respond({ status: 401, json: { error: 'unauthorized' } }, { status: 502, json: { error: 'upstream error' } })
    const unauthorized = await rejection(client.pull(1, 0, 1, signal()))
    expect(unauthorized).toBeInstanceOf(HubError)
    expect(unauthorized).toMatchObject({ status: 401, message: 'unauthorized' })
    const upstream = await rejection(client.send({ recipient: 'x', text: 'y' }))
    expect(upstream).toMatchObject({ status: 502, message: 'upstream error' })
  })

  it('falls back to the status text when the body has no error', async () => {
    hub.respond({ status: 503 })
    expect(await rejection(client.pull(1, 0, 1, signal()))).toMatchObject({ status: 503, message: 'Service Unavailable' })
  })

  it('refuses a short token without calling the hub', async () => {
    writeFileSync(tokenFile, `${'a'.repeat(31)}\n`)
    const error = await rejection(client.pull(1, 0, 1, signal()))
    expect(error).toBeInstanceOf(HubError)
    expect(error).toMatchObject({ status: 0, message: 'the token file holds fewer than 32 characters' })
    expect(hub.requests).toHaveLength(0)
  })

  it('reports transport failures with status 0 and no token', async () => {
    const dead = new HubClient(() => ({ url: 'http://127.0.0.1:1', tokenFile }))
    const error = await rejection(dead.pull(1, 0, 1, signal()))
    expect(error).toBeInstanceOf(HubError)
    expect((error as HubError).status).toBe(0)
    expect((error as HubError).message).not.toContain(TOKEN)
  })

  it('does not put the token in an error for an unreadable token file', async () => {
    const missing = new HubClient(() => ({ url: hub.url, tokenFile: join(dir, 'missing') }))
    const error = await rejection(missing.pull(1, 0, 1, signal()))
    expect(error).toBeInstanceOf(HubError)
    expect((error as HubError).status).toBe(0)
  })
})

describe('attachment', () => {
  it('streams an attachment and stops at the byte limit', async () => {
    hub.respond(
      { headers: { 'content-type': 'image/png' }, chunks: [new Uint8Array([1, 2, 3])] },
      { headers: { 'content-type': 'image/png' }, chunks: [new Uint8Array(6), new Uint8Array(5)] },
    )
    const ok = await client.attachment('abc', 10)
    expect(ok.data).toEqual(new Uint8Array([1, 2, 3]))
    expect(ok.contentType).toBe('image/png')
    expect(hub.requests[0]?.path).toBe('/v1/attachments/abc')
    expect(hub.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    const tooBig = await rejection(client.attachment('abd', 10))
    expect(tooBig).toBeInstanceOf(HubError)
    expect(tooBig).toMatchObject({ status: 413, message: 'attachment exceeds 10 bytes' })
  })

  it('refuses on Content-Length before reading the body', async () => {
    hub.respond({ headers: { 'content-type': 'image/png', 'content-length': '11' }, chunks: [new Uint8Array(11)] })
    expect(await rejection(client.attachment('abc', 10))).toMatchObject({ status: 413, message: 'attachment exceeds 10 bytes' })
  })

  it('encodes the id in the path', async () => {
    hub.respond({ chunks: [new Uint8Array(1)] })
    await client.attachment('a/b c', 10)
    expect(hub.requests[0]?.path).toBe('/v1/attachments/a%2Fb%20c')
  })

  it('treats a 404 as a HubError', async () => {
    hub.respond({ status: 404, json: { error: 'not found' } })
    const error = await rejection(client.attachment('gone', 10))
    expect(error).toBeInstanceOf(HubError)
    expect(error).toMatchObject({ status: 404, message: 'not found' })
  })
})
