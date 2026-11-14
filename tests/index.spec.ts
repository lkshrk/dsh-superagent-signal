import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachmentLine } from '../src/attachments.ts'
import type { SignalConfig } from '../src/config.ts'
import { apply, inject, name } from '../src/index.ts'
import { triggerOf } from '../src/intake.ts'
import type { Agent, SourceKind } from '../src/types.ts'
import { OWNER_UUID, type FakeHub, fakeContext, fakeHub, internalA, message, restA } from './fakes.ts'

it('names the plugin and the service it needs', () => {
  expect(name).toBe('dsh-superagent-signal')
  expect(inject).toEqual(['orchestrator'])
})

describe('apply', () => {
  let hub: FakeHub | undefined
  const disposers: (() => unknown)[] = []
  afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose()
    await hub?.close()
  })

  async function wired() {
    hub = await fakeHub()
    const dir = await mkdtemp(join(tmpdir(), 'signal-index-'))
    const tokenFile = join(dir, 'token')
    await writeFile(tokenFile, 'test-token-0123456789abcdefghijklmnopqrstuvwxyz')
    const ctx = fakeContext()
    ctx.configured = () => false
    ctx.config = (() => ({ hubUrl: hub!.url, tokenFile, groupId: restA })) as typeof ctx.config
    let kind: SourceKind<SignalConfig> | undefined
    apply({
      orchestrator: { sources: { register: registered => { kind = registered as SourceKind<SignalConfig>; return () => {} } }, context: () => ctx },
      effect: execute => { const dispose = execute(); if (dispose) disposers.push(dispose) },
    })
    return { kind: kind!, hub }
  }

  it('reports an escaped non-hub error by its name only', async () => {
    const ready = Promise.reject(new RangeError('secret words from the message'))
    ready.catch(() => {})
    const ctx = Object.assign(fakeContext(), { ready })
    const reports: { state: string; detail: string }[] = []
    ctx.report = (_entry, health) => { reports.push(health) }
    apply({
      orchestrator: { sources: { register: () => () => {} }, context: () => ctx },
      effect: execute => { const dispose = execute(); if (dispose) disposers.push(dispose) },
    })
    await vi.waitFor(() => expect(reports).toEqual([{ state: 'error', detail: 'RangeError' }]), { timeout: 1000, interval: 5 })
  })

  it('sends a Channel message through the hub', async () => {
    const { kind, hub } = await wired()
    hub.respond({ json: { timestamp: 5000, timestamps: [5000] } })
    const result = await kind.channel!.send(undefined, {
      id: 'm1', kind: 'reply', text: 'On it',
      channel: { source: 'signal', thread: `signal:${internalA}:1000`, address: { group: internalA, quoteTimestamp: '1000', quoteAuthor: OWNER_UUID } },
    })
    expect(result).toBe('sent')
    expect(hub.requests).toHaveLength(1)
    expect(hub.requests[0]).toMatchObject({ method: 'POST', path: '/v1/send' })
    expect(JSON.parse(hub.requests[0]!.body)).toEqual({ recipient: internalA, text: 'On it', quote: { timestamp: 1000, author: OWNER_UUID } })
  })

  it('reads an image through the hub', async () => {
    const { kind, hub } = await wired()
    const png = new Uint8Array([137, 80, 78, 71])
    hub.respond({ headers: { 'content-type': 'image/png' }, chunks: [png] })
    const saveImage = vi.fn(async (input: { name: string }) => ({ ref: input.name }))
    const agent = {
      ctx: { get: (service: string) => service === 'attachments'
        ? { imageLimits: { maxImageBytes: 1 << 20, maxMessageImageBytes: 1 << 20 }, saveImage }
        : { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } },
      session: { requestHeader: () => undefined },
      options: { provider: 'p', model: 'm' },
    } as unknown as Agent
    const attachment = { id: 'p1.png', contentType: 'image/png', size: 4, filename: 'a.png', caption: '' }
    const trigger = triggerOf(message({ text: 'look', attachments: [attachment] }), OWNER_UUID, `${internalA}:1`, internalA, 1 << 20)
    const text = `look\n${attachmentLine(attachment, 1 << 20)}`
    const result = await kind.threadContext!.image!(agent, undefined, trigger, { id: '1', text }, 'p1.png', '/state', new AbortController().signal)
    expect(hub.requests.map(request => request.path)).toEqual(['/v1/attachments/p1.png'])
    expect(saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png', data: png }))
    expect(result).toMatchObject({ image_key: 'p1.png' })
  })
})
