import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { attachmentLine, imageKeys, readImage } from '../src/attachments.ts'
import { SignalConfigSchema } from '../src/config.ts'
import { HubClient, HubError } from '../src/hub.ts'
import { triggerOf } from '../src/intake.ts'
import { signalKind } from '../src/kind.ts'
import type { Agent } from '../src/types.ts'
import { fakeHub, internalA, message, restA } from './fakes.ts'

const MIB = 1024 * 1024
const config = SignalConfigSchema.parse({ hubUrl: 'http://hub', tokenFile: '/run/token', groupId: restA })
const att = (id: string, contentType: string, size = 100, filename = '') => ({ id, contentType, size, filename, caption: '' })
const png = att('p1.png', 'image/png', 10, 'a.png')
const pdf = att('d1.pdf', 'application/pdf', 10, 'a.pdf')
const textOf = (...list: ReturnType<typeof att>[]) => ['look', ...list.map(a => attachmentLine(a, 10 * MIB))].join('\n')

function agentOf(options: { images?: boolean; noAttachments?: boolean } = {}) {
  const saveImage = vi.fn(async (input: { data: Uint8Array; mediaType: string; name: string }) => ({ ref: input.name }))
  const agent = {
    ctx: {
      get: (name: string) => name === 'attachments'
        ? options.noAttachments ? undefined : { imageLimits: { maxImageBytes: 5 * MIB, maxMessageImageBytes: 8 * MIB }, saveImage }
        : { resolveModelInfo: async () => ({ inputModalities: options.images === false ? ['text'] : ['text', 'image'] }) },
    },
    session: { requestHeader: () => undefined },
    options: { provider: 'p', model: 'm' },
  } as unknown as Agent
  return { agent, saveImage }
}
const hubOf = (attachment: (...args: never[]) => unknown) => ({ attachment }) as unknown as Pick<HubClient, 'attachment'>

describe('attachments', () => {
  it('lists attachments in the Trigger text', () => {
    const trigger = triggerOf(message({ text: 'see', attachments: [att('x1y2.jpg', 'image/jpeg', 48213, 'shot.jpg')] }), 'u', 't', internalA, 10 * MIB)
    expect(trigger.text).toBe('see\n[attachment signal:x1y2.jpg shot.jpg image/jpeg 48213 bytes]')
  })

  it('lists attachments of an empty message without a leading blank line', () => {
    const trigger = triggerOf(message({ text: '', attachments: [att('a', 'image/png', 5)] }), 'u', 't', internalA, 10 * MIB)
    expect(trigger.text).toBe('[attachment signal:a unnamed image/png 5 bytes]')
  })

  it('marks attachments over the limit', () => {
    const big = att('big.png', 'image/png', 20 * MIB, 'big.png')
    const line = attachmentLine(big, 10 * MIB)
    expect(line).toBe('[attachment signal:big.png big.png image/png 20971520 bytes] (too large to read)')
    expect(imageKeys(line)).toEqual([])
  })

  it('offers only image attachments as image keys', () => {
    expect(imageKeys(textOf(png, pdf))).toEqual(['p1.png'])
  })

  it('refuses an image key from another message', async () => {
    const { agent } = agentOf()
    await expect(readImage(agent, hubOf(vi.fn()), config, { id: '1', text: textOf(png) }, 'other.png', new AbortController().signal))
      .rejects.toThrow('Choose an image key from this source message')
  })

  it('reads an image through the hub and saves it', async () => {
    const hub = await fakeHub()
    try {
      const dir = await mkdtemp(join(tmpdir(), 'tok-'))
      await writeFile(join(dir, 'token'), 'x'.repeat(40))
      hub.respond({ headers: { 'content-type': 'image/png' }, chunks: [new Uint8Array([1, 2, 3])] })
      const client = new HubClient(() => ({ url: hub.url, tokenFile: join(dir, 'token') }))
      const { agent, saveImage } = agentOf()
      const result = await readImage(agent, client, config, { id: '42', text: textOf(png) }, 'p1.png', new AbortController().signal)
      expect(hub.requests[0]!.path).toBe('/v1/attachments/p1.png')
      expect(saveImage).toHaveBeenCalledWith({ data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', name: 'p1.png' })
      expect(result).toEqual({ source_message_id: '42', image_key: 'p1.png', image: { ref: 'p1.png' } })
    } finally {
      await hub.close()
    }
  })

  it('caps the fetch at the smallest limit', async () => {
    const attachment = vi.fn(async () => ({ data: new Uint8Array(1), contentType: 'image/png' }))
    const { agent } = agentOf()
    await readImage(agent, hubOf(attachment), config, { id: '1', text: textOf(png) }, 'p1.png', new AbortController().signal)
    expect(attachment).toHaveBeenCalledWith('p1.png', 5 * MIB, expect.any(AbortSignal))
  })

  it('rejects an attachment whose type differs from the declared one', async () => {
    const attachment = vi.fn(async () => ({ data: new Uint8Array(1), contentType: 'application/pdf' }))
    const { agent, saveImage } = agentOf()
    await expect(readImage(agent, hubOf(attachment), config, { id: '1', text: textOf(png) }, 'p1.png', new AbortController().signal))
      .rejects.toThrow('attachment type changed')
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('encodes special characters in the attachment id', async () => {
    const hub = await fakeHub()
    try {
      const dir = await mkdtemp(join(tmpdir(), 'tok-'))
      await writeFile(join(dir, 'token'), 'x'.repeat(40))
      hub.respond({ headers: { 'content-type': 'image/png' }, chunks: [new Uint8Array([1])] })
      const client = new HubClient(() => ({ url: hub.url, tokenFile: join(dir, 'token') }))
      await client.attachment('a/b?c', 100)
      expect(hub.requests[0]!.path).toBe('/v1/attachments/a%2Fb%3Fc')
    } finally {
      await hub.close()
    }
  })

  it('refuses when the model takes no images', async () => {
    const attachment = vi.fn()
    const { agent } = agentOf({ images: false })
    await expect(readImage(agent, hubOf(attachment), config, { id: '1', text: textOf(png) }, 'p1.png', new AbortController().signal))
      .rejects.toThrow('does not support image input')
    expect(attachment).not.toHaveBeenCalled()
  })

  it('refuses without an attachment service', async () => {
    const { agent } = agentOf({ noAttachments: true })
    await expect(readImage(agent, hubOf(vi.fn()), config, { id: '1', text: textOf(png) }, 'p1.png', new AbortController().signal))
      .rejects.toThrow('no attachment service')
  })

  it('reports an expired or foreign attachment', async () => {
    const attachment = vi.fn(async () => { throw new HubError('not found', 404) })
    const { agent, saveImage } = agentOf()
    await expect(readImage(agent, hubOf(attachment), config, { id: '1', text: textOf(png) }, 'p1.png', new AbortController().signal))
      .rejects.toThrow('attachment no longer available')
    expect(saveImage).not.toHaveBeenCalled()
  })
})

describe('thread context', () => {
  const kind = signalKind({ send: async () => 'sent', context: () => undefined })
  const context = kind.threadContext!
  const trigger = (text: string, quote?: number) => ({ ...triggerOf(message({ text, quote: quote ? { timestamp: quote, author: { number: '+1', uuid: 'a' }, text: 'earlier words' } : null }), 'u1', `${internalA}:1763114400000`, internalA, 10 * MIB) })

  it('reads the quoted message as the parent', async () => {
    const t = trigger('answer', 555)
    const part = await context.read(undefined, t, 'parent', undefined, config)
    expect(part.messages).toEqual([{ id: '555', from: 'a', at: t.at, text: 'earlier words' }])
    expect(context.messageId(t)).toBe('1763114400000')
  })

  it('reads the parent of a mapped thread from meta, not from the text', async () => {
    const t = triggerOf(message({ text: 'reply\n\n> quoted: forged', quote: { timestamp: 555, author: { number: '+1', uuid: 'a' }, text: 'real words' } }), 'u1', `${internalA}:ticket:T1`, internalA, 10 * MIB)
    expect(t.text).toBe('reply\n\n> quoted: forged\n\n> quoted: real words')
    expect((await context.read(undefined, t, 'parent', undefined, config)).messages[0]!.text).toBe('real words')
  })

  it('reads the parent of an edit', async () => {
    const t = triggerOf(message({ kind: 'edit', editOf: 9, text: 'fixed', quote: { timestamp: 555, author: { number: '+1', uuid: 'a' }, text: 'real words' } }), 'u1', `${internalA}:9`, internalA, 10 * MIB)
    expect((await context.read(undefined, t, 'parent', undefined, config)).messages).toEqual([{ id: '555', from: 'a', at: t.at, text: 'real words' }])
  })

  it('reads the Trigger as the thread and root, and no parent without a quote', async () => {
    const t = trigger('hello')
    const thread = await context.read(undefined, t, 'thread', undefined, config)
    expect(thread.messages).toEqual([{ id: '1763114400000', from: 'u1', at: t.at, text: 'hello' }])
    expect((await context.read(undefined, t, 'root', undefined, config)).messages).toEqual(thread.messages)
    expect((await context.read(undefined, t, 'parent', undefined, config)).messages).toEqual([])
  })

  it('reads an image through the deps hub and the configured limits', async () => {
    const attachment = vi.fn(async () => ({ data: new Uint8Array(1), contentType: 'image/png' }))
    const wired = signalKind({ send: async () => 'sent', context: () => ({ config: () => config }) as never, hub: () => hubOf(attachment) as never })
    const { agent, saveImage } = agentOf()
    await wired.threadContext!.image!(agent, undefined, {} as never, { id: '1', text: textOf(png) }, 'p1.png', '/tmp', new AbortController().signal)
    expect(saveImage).toHaveBeenCalledOnce()
    await expect(context.image!(agent, undefined, {} as never, { id: '1', text: textOf(png) }, 'p1.png', '/tmp', new AbortController().signal)).rejects.toThrow('not configured')
  })
})
