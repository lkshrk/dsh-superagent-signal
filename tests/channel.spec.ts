import { describe, expect, it, vi } from 'vitest'
import { sendSignal } from '../src/channel.ts'
import { SignalConfigSchema, SOURCE } from '../src/config.ts'
import { HubError, type HubClient, type SendInput, type SendResult } from '../src/hub.ts'
import { signalKind } from '../src/kind.ts'
import { pollSignal } from '../src/intake.ts'
import { KEYS, lookup } from '../src/state.ts'
import type { OutboundMessage } from '../src/types.ts'
import { OWNER_UUID, fakeContext, internalA, message, restA } from './fakes.ts'

const config = SignalConfigSchema.parse({ hubUrl: 'http://hub', tokenFile: '/run/token', groupId: restA })

function hubOf(...results: (SendResult | HubError)[]) {
  const send = vi.fn(async (_input: SendInput): Promise<SendResult> => {
    const next = results.shift() ?? { timestamps: [], failures: [] }
    if (next instanceof HubError) throw next
    return next
  })
  return { hub: { send } as unknown as HubClient, send }
}
const ok = (...timestamps: number[]): SendResult => ({ timestamps, failures: [] })
const log = () => ({ info: vi.fn(), warn: vi.fn() })

const reply = (overrides: Partial<OutboundMessage> = {}, address: Record<string, string> = { group: internalA, quoteTimestamp: '1000', quoteAuthor: OWNER_UUID }): OutboundMessage => ({
  id: 'm1',
  channel: { source: SOURCE, thread: `signal:${internalA}:1000`, address },
  text: 'On it',
  kind: 'reply',
  ticketId: 'T1',
  ...overrides,
})

describe('sendSignal', () => {
  it('posts quoting the message it answers and maps the returned timestamps', async () => {
    const ctx = fakeContext()
    const { hub, send } = hubOf(ok(5000))
    expect(await sendSignal(ctx, hub, config, reply(), log())).toBe('sent')
    expect(send).toHaveBeenCalledWith({ recipient: internalA, text: 'On it', quote: { timestamp: 1000, author: OWNER_UUID } })
    expect(lookup(ctx, 5000)).toMatchObject({ thread: `${internalA}:1000`, ticketId: 'T1' })
    expect(ctx.state.get(KEYS.sent('m1'))).toMatchObject({ timestamps: [5000] })
  })

  it('keeps a map entry that already exists for a returned timestamp', async () => {
    const ctx = fakeContext()
    const first = { thread: 'first', ticketId: 'T0', at: new Date().toISOString() }
    ctx.state.set(KEYS.map(5000), first)
    const { hub } = hubOf(ok(5000, 5001))
    await sendSignal(ctx, hub, config, reply(), log())
    expect(ctx.state.get(KEYS.map(5000))).toEqual(first)
    expect(lookup(ctx, 5001)).toMatchObject({ ticketId: 'T1' })
  })

  it('posts without a quote when the address has none', async () => {
    const ctx = fakeContext()
    const { hub, send } = hubOf(ok(5000))
    await sendSignal(ctx, hub, config, reply({}, { group: internalA }), log())
    expect(send).toHaveBeenCalledWith({ recipient: internalA, text: 'On it' })
  })

  it('throws while the hub is down and posts once when it is back', async () => {
    const ctx = fakeContext()
    const { hub, send } = hubOf(new HubError('bad gateway', 502), ok(5000))
    await expect(sendSignal(ctx, hub, config, reply(), log())).rejects.toMatchObject({ status: 502 })
    expect(ctx.state.keys('signal-')).toEqual([])
    expect(await sendSignal(ctx, hub, config, reply(), log())).toBe('sent')
    expect(send).toHaveBeenCalledTimes(2)
    expect(ctx.state.keys('signal-sent:')).toEqual([KEYS.sent('m1')])
  })

  it('does not post again for a message already sent', async () => {
    const ctx = fakeContext()
    ctx.state.set(KEYS.sent('m1'), { timestamps: [5000], at: new Date().toISOString() })
    const { hub, send } = hubOf(ok(6000))
    expect(await sendSignal(ctx, hub, config, reply(), log())).toBe('sent')
    expect(send).not.toHaveBeenCalled()
  })

  it('a quote of a ticketless reply goes to the request\'s thread', async () => {
    const ctx = fakeContext()
    const { hub } = hubOf(ok(5000))
    expect(await sendSignal(ctx, hub, config, reply({ ticketId: undefined }), log())).toBe('sent')
    expect(lookup(ctx, 5000)).toEqual({ thread: `${internalA}:1000`, at: expect.any(String) })
    const quoting = message({ seq: 2, timestamp: 6000, text: 'Yes', quote: { timestamp: 5000, author: { number: '', uuid: 'bot' }, text: 'Which test?' } })
    const pull = vi.fn(async () => ({ messages: [quoting], next: 2, missed: 0, reset: false }))
    await pollSignal(ctx, { pull } as unknown as HubClient, config, new AbortController().signal, { taken: 0, refused: 0, ignored: 0, missed: 0 }, { log: log() })
    expect(ctx.received[0]!.threads).toEqual([{ source: SOURCE, id: `${internalA}:1000` }])
  })

  it('does not map a health notice, so a quote of it starts a new request', async () => {
    const ctx = fakeContext()
    const { hub } = hubOf(ok(5000))
    const notice = reply({ kind: 'notice', ticketId: undefined, channel: { source: SOURCE, thread: `signal:${internalA}:health`, address: { group: internalA } } })
    expect(await sendSignal(ctx, hub, config, notice, log())).toBe('sent')
    expect(lookup(ctx, 5000)).toBeUndefined()
    expect(ctx.state.get(KEYS.sent('m1'))).toMatchObject({ timestamps: [5000] })
  })

  it('counts a send with some failed recipients as sent and logs ids and reasons only', async () => {
    const ctx = fakeContext()
    const logger = log()
    const { hub } = hubOf({ timestamps: [5000], failures: [{ number: '+49151999', uuid: 'u-2', reason: 'unregistered' }] })
    expect(await sendSignal(ctx, hub, config, reply({ text: 'secret words' }), logger)).toBe('sent')
    const lines = [...logger.warn.mock.calls, ...logger.info.mock.calls].map(call => String(call[0]))
    expect(lines.join('\n')).toContain('unregistered')
    expect(lines.join('\n')).toContain('u-2')
    expect(lines.join('\n')).not.toContain('secret words')
  })

  it('throws when the hub reached nobody', async () => {
    const ctx = fakeContext()
    const { hub } = hubOf({ timestamps: [], failures: [{ number: '', uuid: 'u-2', reason: 'unregistered' }] })
    await expect(sendSignal(ctx, hub, config, reply(), log())).rejects.toBeInstanceOf(HubError)
    expect(ctx.state.keys('signal-')).toEqual([])
  })

  it.each([0, 502, 429, 403])('throws on hub status %i so the Outbox retries', async status => {
    const ctx = fakeContext()
    const { hub } = hubOf(new HubError('nope', status))
    await expect(sendSignal(ctx, hub, config, reply(), log())).rejects.toMatchObject({ status })
    expect(ctx.state.keys('signal-')).toEqual([])
  })

  it.each([400, 413])('gives up on hub status %i with a warning that names the message and status', async status => {
    const ctx = fakeContext()
    const logger = log()
    const { hub } = hubOf(new HubError('nope', status))
    expect(await sendSignal(ctx, hub, config, reply({ text: 'secret words' }), logger)).toBe('gone')
    const line = String(logger.warn.mock.calls[0]?.[0])
    expect(line).toContain('m1')
    expect(line).toContain(String(status))
    expect(line).not.toContain('secret words')
    expect(ctx.state.keys('signal-')).toEqual([])
  })
})

describe('channel', () => {
  const kind = signalKind({ send: async () => 'sent', context: () => undefined })
  it('only allows the configured group', () => {
    const other = Buffer.alloc(32, 7).toString('base64')
    expect(kind.channel!.allowed!({ group: internalA }, config)).toBe(true)
    expect(kind.channel!.allowed!({ group: other }, config)).toBe(false)
  })

  it('sends through the injected send and links nowhere', async () => {
    const send = vi.fn(async () => 'sent' as const)
    const { channel } = signalKind({ send, context: () => undefined })
    const message = reply()
    expect(await channel!.send(undefined, message)).toBe('sent')
    expect(send).toHaveBeenCalledWith(message)
    expect(channel!.link({})).toEqual({ url: '', label: { zh: 'Signal', en: 'Signal' } })
  })
})
