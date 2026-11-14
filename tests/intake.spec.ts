import { describe, expect, it, vi } from 'vitest'
import { SignalConfigSchema } from '../src/config.ts'
import type { HubClient, Pull } from '../src/hub.ts'
import { type IntakeCounts, pollSignal, threadId, ticketThreadId, triggerId } from '../src/intake.ts'
import { KEYS, MAP_HORIZON_MS, PRUNE_INTERVAL_MS, lookup, prune, remember } from '../src/state.ts'
import type { Ticket } from '../src/types.ts'
import { OWNER_NUMBER, OWNER_UUID, fakeContext, internalA, message, restA } from './fakes.ts'

const NOW = new Date('2026-11-14T12:00:00.000Z')
const DAY = 24 * 3600_000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const config = SignalConfigSchema.parse({ hubUrl: 'http://hub', tokenFile: '/run/token', groupId: restA, pollWaitSeconds: 30, pollLimit: 100 })

function hubOf(...pages: Partial<Pull>[]) {
  const pull = vi.fn(async (_after: number | undefined, _wait: number, _limit: number, _signal: AbortSignal): Promise<Pull> => {
    const page = pages.shift() ?? {}
    const messages = page.messages ?? []
    return { messages, next: page.next ?? messages.at(-1)?.seq ?? 0, missed: page.missed ?? 0, reset: page.reset ?? false }
  })
  return { hub: { pull } as unknown as HubClient, pull }
}

const counts = (): IntakeCounts => ({ taken: 0, refused: 0, ignored: 0, missed: 0 })
const log = () => ({ info: vi.fn(), warn: vi.fn() })
const run = (ctx: ReturnType<typeof fakeContext>, hub: HubClient, c = counts(), logger = log()) =>
  pollSignal(ctx, hub, config, new AbortController().signal, c, { now: () => NOW, log: logger })

describe('intake', () => {
  it('lists attachments in the Trigger text and marks the oversized one', async () => {
    const ctx = fakeContext()
    const small = { id: 's.jpg', contentType: 'image/jpeg', size: 48213, filename: 'shot.jpg', caption: '' }
    const big = { id: 'b.png', contentType: 'image/png', size: config.attachmentMaxBytes + 1, filename: 'big.png', caption: '' }
    const { hub } = hubOf({ messages: [message({ text: 'look', attachments: [small, big] })] })
    await run(ctx, hub)
    expect(ctx.received[0]!.text).toBe(`look\n[attachment signal:s.jpg shot.jpg image/jpeg 48213 bytes]\n[attachment signal:b.png big.png image/png ${big.size} bytes] (too large to read)`)
  })

  it('starts from the head and stores the cursor after each message', async () => {
    const ctx = fakeContext()
    const { hub, pull } = hubOf({ messages: [message({ seq: 5, timestamp: 1000 }), message({ seq: 6, timestamp: 1001 })], next: 6 })
    const cursors: unknown[] = []
    ctx.onReceive = () => { cursors.push(ctx.state.get(KEYS.cursor)); return 'stored' }
    const c = counts()
    await run(ctx, hub, c)
    expect(pull).toHaveBeenCalledWith(undefined, 30, 100, expect.any(AbortSignal))
    expect(cursors).toEqual([undefined, 5])
    expect(ctx.state.get(KEYS.cursor)).toBe(6)
    expect(c.taken).toBe(2)
  })

  it('pulls after the stored cursor', async () => {
    const ctx = fakeContext()
    ctx.state.set(KEYS.cursor, 41)
    const { hub, pull } = hubOf({ messages: [], next: 41 })
    await run(ctx, hub)
    expect(pull).toHaveBeenCalledWith(41, 30, 100, expect.any(AbortSignal))
  })

  it('makes one thread and Trigger per unquoted message', async () => {
    const ctx = fakeContext()
    const { hub } = hubOf({ messages: [message({ seq: 7, timestamp: 1763114400000, receivedAt: '2026-11-14T10:00:01.000Z' })] })
    await run(ctx, hub)
    expect(ctx.received).toHaveLength(1)
    const trigger = ctx.received[0]!
    expect(trigger.id).toBe(`signal:${OWNER_UUID}:1763114400000`)
    expect(trigger.id).toBe(triggerId(OWNER_UUID, 1763114400000))
    expect(trigger.source).toBe('signal')
    expect(trigger.threads).toEqual([{ source: 'signal', id: `${internalA}:1763114400000` }])
    expect(trigger.actor).toEqual({ source: 'signal', id: OWNER_UUID })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('direct')
    expect(trigger.at).toBe('2026-11-14T10:00:01.000Z')
    expect(trigger.text).toBe('Fix the flaky test')
    expect(trigger.channel).toEqual({
      source: 'signal',
      thread: `signal:${internalA}:1763114400000`,
      address: { group: internalA, quoteTimestamp: '1763114400000', quoteAuthor: OWNER_UUID },
    })
    expect(trigger.meta).toEqual({
      group: internalA, timestamp: 1763114400000, seq: 7, kind: 'message',
      sender: { uuid: OWNER_UUID, number: OWNER_NUMBER, name: 'Owner' },
    })
    expect(lookup(ctx, 1763114400000, NOW)).toEqual({ thread: `${internalA}:1763114400000`, at: NOW.toISOString() })
  })

  it('keeps two quick unquoted messages apart', async () => {
    const ctx = fakeContext()
    const { hub } = hubOf({ messages: [message({ seq: 1, timestamp: 1000 }), message({ seq: 2, timestamp: 1001 })] })
    await run(ctx, hub)
    expect(ctx.received.map(t => t.id)).toEqual([triggerId(OWNER_UUID, 1000), triggerId(OWNER_UUID, 1001)])
    const threads = ctx.received.map(t => t.threads[0]!.id)
    expect(threads).toEqual([threadId(internalA, 1000), threadId(internalA, 1001)])
    expect(new Set(threads).size).toBe(2)
  })

  it("routes a quote of a mapped message to that message's thread", async () => {
    const ctx = fakeContext()
    remember(ctx, 900, { thread: `${internalA}:800`, ticketId: 't-1', at: ago(DAY) })
    const quote = { timestamp: 900, author: { number: '', uuid: 'dsh-uuid' }, text: 'Working on it' }
    const { hub } = hubOf({ messages: [message({ seq: 3, timestamp: 1200, quote })] })
    await run(ctx, hub)
    const trigger = ctx.received[0]!
    expect(trigger.threads[0]!.id).toBe(`${internalA}:800`)
    expect(trigger.channel!.thread).toBe(`signal:${internalA}:800`)
    expect(trigger.text).toBe('Fix the flaky test\n\n> quoted: Working on it')
    expect(trigger.meta.quote).toBe(900)
    expect(lookup(ctx, 1200, NOW)).toEqual({ thread: `${internalA}:800`, ticketId: 't-1', at: NOW.toISOString() })
  })

  it('routes a quote of a mapped ticket thread to that thread', async () => {
    const ctx = fakeContext()
    remember(ctx, 900, { thread: ticketThreadId(internalA, 't-9'), ticketId: 't-9', at: ago(DAY) })
    const quote = { timestamp: 900, author: { number: '', uuid: 'dsh-uuid' }, text: 'Ticket ended' }
    const { hub } = hubOf({ messages: [message({ seq: 3, timestamp: 1200, quote })] })
    await run(ctx, hub)
    expect(ctx.received[0]!.threads[0]!.id).toBe(`${internalA}:ticket:t-9`)
  })

  it('quote of an unmapped message starts a new request carrying the quoted text', async () => {
    const ctx = fakeContext()
    remember(ctx, 900, { thread: `${internalA}:800`, at: ago(15 * DAY) })
    const stale = { timestamp: 900, author: { number: '', uuid: 'dsh-uuid' }, text: 'Tests failed' }
    const unknown = { timestamp: 950, author: { number: '', uuid: 'dsh-uuid' }, text: 'Hub unreachable' }
    const { hub } = hubOf({ messages: [message({ seq: 3, timestamp: 1200, quote: stale, text: 'Why?' }), message({ seq: 4, timestamp: 1300, quote: unknown, text: 'Still?' })] })
    const c = counts()
    await run(ctx, hub, c)
    expect(c.taken).toBe(2)
    const [first, second] = ctx.received
    expect(first!.threads[0]!.id).toBe(threadId(internalA, 1200))
    expect(first!.text).toBe('Why?\n\n> quoted: Tests failed')
    expect(first!.text.endsWith('\n\n> quoted: Tests failed')).toBe(true)
    expect(second!.threads[0]!.id).toBe(threadId(internalA, 1300))
    expect(second!.text).toBe('Still?\n\n> quoted: Hub unreachable')
  })

  it('routes an edit of a mapped message to its thread as an edit', async () => {
    const ctx = fakeContext()
    const { hub } = hubOf(
      { messages: [message({ seq: 1, timestamp: 1000 })] },
      { messages: [message({ seq: 2, timestamp: 1500, kind: 'edit', editOf: 1000, text: 'Fix the flaky test in CI' })] },
    )
    await run(ctx, hub)
    await run(ctx, hub)
    const edit = ctx.received[1]!
    expect(edit.threads[0]!.id).toBe(threadId(internalA, 1000))
    expect(edit.text).toBe('(edited) Fix the flaky test in CI')
    expect(edit.id).toBe(triggerId(OWNER_UUID, 1500))
    expect(edit.meta.kind).toBe('edit')
    expect(edit.channel!.address.quoteTimestamp).toBe('1000')
    expect(lookup(ctx, 1500, NOW)?.thread).toBe(threadId(internalA, 1000))
  })

  it('counts an edit of an unknown message as ignored and moves on', async () => {
    const ctx = fakeContext()
    const logger = log()
    const c = counts()
    const { hub } = hubOf({ messages: [message({ seq: 9, timestamp: 1500, kind: 'edit', editOf: 777 })], next: 9 })
    await run(ctx, hub, c, logger)
    expect(c.ignored).toBe(1)
    expect(ctx.received).toHaveLength(0)
    expect(ctx.state.get(KEYS.cursor)).toBe(9)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('edit of an unknown message'))
  })

  it('refuses people not on the list without taking them in', async () => {
    const ctx = fakeContext()
    const logger = log()
    const c = counts()
    const stranger = { number: '+4917600000000', uuid: 'stranger-uuid', name: 'Stranger', device: 1 }
    const { hub } = hubOf({ messages: [message({ seq: 4, sender: stranger, text: 'secret words' })], next: 4 })
    await run(ctx, hub, c, logger)
    expect(c.refused).toBe(1)
    expect(ctx.received).toHaveLength(0)
    expect(ctx.state.get(KEYS.cursor)).toBe(4)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('stranger-uuid'))
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toContain('secret words')
  })

  it('refuses everyone when the host cannot tell who is admitted', async () => {
    const ctx = fakeContext()
    delete ctx.admits
    const c = counts()
    const { hub } = hubOf({ messages: [message({ seq: 4 })] })
    await run(ctx, hub, c)
    expect(c.refused).toBe(1)
    expect(ctx.received).toHaveLength(0)
  })

  it('admits by number when the uuid is not listed', async () => {
    const ctx = fakeContext()
    ctx.admitted = new Set(['+4915187654321'])
    const sender = { number: '+4915187654321', uuid: 'unlisted-uuid', name: 'Owner', device: 1 }
    const c = counts()
    const { hub } = hubOf({ messages: [message({ seq: 4, timestamp: 2000, sender })] })
    await run(ctx, hub, c)
    expect(c.taken).toBe(1)
    const trigger = ctx.received[0]!
    expect(trigger.actor.id).toBe('+4915187654321')
    expect(trigger.id).toBe(triggerId('+4915187654321', 2000))
    expect(trigger.channel!.address.quoteAuthor).toBe('+4915187654321')
  })

  it('ignores other groups, reactions and poll votes', async () => {
    const ctx = fakeContext()
    const other = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64')
    const c = counts()
    const { hub } = hubOf({
      messages: [
        message({ seq: 1, group: { id: other, internalId: other, restId: 'x', name: 'other' } }),
        message({ seq: 2, kind: 'reaction' }),
        message({ seq: 3, kind: 'poll_vote' }),
        message({ seq: 4, kind: 'story' }),
        message({ seq: 5, group: null }),
      ],
      next: 8,
    })
    await run(ctx, hub, c)
    expect(c.ignored).toBe(5)
    expect(c.taken).toBe(0)
    expect(ctx.received).toHaveLength(0)
    expect(ctx.state.get(KEYS.cursor)).toBe(8)
  })

  it('leaves the cursor at the last message taken in when receive throws', async () => {
    const ctx = fakeContext()
    ctx.state.set(KEYS.cursor, 4)
    ctx.onReceive = trigger => { if (trigger.meta.seq === 6) throw new Error('engine down'); return 'stored' }
    const { hub, pull } = hubOf(
      { messages: [message({ seq: 5, timestamp: 1000 }), message({ seq: 6, timestamp: 1001 })], next: 6 },
      { messages: [message({ seq: 6, timestamp: 1001 })], next: 6 },
    )
    await expect(run(ctx, hub)).rejects.toThrow('engine down')
    expect(ctx.state.get(KEYS.cursor)).toBe(5)
    ctx.onReceive = () => 'stored'
    await run(ctx, hub)
    expect(pull.mock.calls[1]![0]).toBe(5)
    expect(ctx.state.get(KEYS.cursor)).toBe(6)
  })

  it('replays harmlessly after a hub reset and shows it', async () => {
    const ctx = fakeContext()
    const logger = log()
    const c = counts()
    const { hub } = hubOf(
      { messages: [message({ seq: 100, timestamp: 1000 }), message({ seq: 101, timestamp: 1001 })], next: 101 },
      { messages: [message({ seq: 1, timestamp: 1000 }), message({ seq: 2, timestamp: 1001 })], next: 2, reset: true },
    )
    await run(ctx, hub, c, logger)
    expect(c.reset).toBeUndefined()
    await run(ctx, hub, c, logger)
    expect(ctx.results).toEqual(['stored', 'stored', 'duplicate', 'duplicate'])
    expect(ctx.received[2]!.id).toBe(ctx.received[0]!.id)
    expect(ctx.received[3]!.id).toBe(ctx.received[1]!.id)
    expect(c.reset).toBe(NOW.toISOString())
    expect(c.taken).toBe(4)
    expect(ctx.state.get(KEYS.cursor)).toBe(2)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('hub log was reset; replaying from its oldest message'))
  })

  it('never moves the cursor backwards without a reset', async () => {
    const ctx = fakeContext()
    ctx.state.set(KEYS.cursor, 50)
    const { hub } = hubOf({ messages: [], next: 10 })
    await run(ctx, hub)
    expect(ctx.state.get(KEYS.cursor)).toBe(50)
  })

  it('keeps the first map entry of a message when it is replayed', async () => {
    const ctx = fakeContext()
    remember(ctx, 900, { thread: 'thread-y', at: ago(DAY) })
    remember(ctx, 1200, { thread: 'thread-x', ticketId: 't-x', at: ago(2 * DAY) })
    const quote = { timestamp: 900, author: { number: '', uuid: 'dsh-uuid' }, text: 'Working on it' }
    const { hub } = hubOf({ messages: [message({ seq: 3, timestamp: 1200, quote })], reset: true })
    await run(ctx, hub)
    expect(ctx.state.get(KEYS.map(1200))).toEqual({ thread: 'thread-x', ticketId: 't-x', at: ago(2 * DAY) })
    expect(ctx.received[0]!.threads[0]!.id).toBe('thread-x')
  })

  it('adds missed messages to the count', async () => {
    const ctx = fakeContext()
    const logger = log()
    const c = counts()
    const { hub } = hubOf({ messages: [], next: 30, missed: 4 }, { messages: [], next: 30, missed: 1 })
    await run(ctx, hub, c, logger)
    expect(c.missed).toBe(4)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('4'))
    await run(ctx, hub, c, logger)
    expect(c.missed).toBe(5)
    expect(ctx.state.get(KEYS.cursor)).toBe(30)
  })

  it('logs no message text', async () => {
    const ctx = fakeContext()
    const logger = log()
    const quote = { timestamp: 1, author: { number: '', uuid: 'x' }, text: 'quoted secret' }
    const { hub } = hubOf({ messages: [message({ seq: 1, text: 'body secret', quote }), message({ seq: 2, kind: 'edit', editOf: 3, text: 'edit secret' })], reset: true, missed: 2 })
    await run(ctx, hub, counts(), logger)
    const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])
    expect(logged).not.toMatch(/secret/)
  })

  it('prunes the map once an hour', async () => {
    const ctx = fakeContext()
    remember(ctx, 1, { thread: 'a', at: ago(15 * DAY) })
    remember(ctx, 2, { thread: 'b', at: ago(DAY) })
    expect(prune(ctx, NOW)).toBe(1)
    expect(ctx.state.get(KEYS.map(1))).toBeUndefined()
    expect(ctx.state.get(KEYS.map(2))).toBeDefined()
    remember(ctx, 3, { thread: 'c', at: ago(20 * DAY) })
    expect(prune(ctx, new Date(NOW.getTime() + PRUNE_INTERVAL_MS - 1))).toBe(0)
    expect(prune(ctx, new Date(NOW.getTime() + PRUNE_INTERVAL_MS))).toBe(1)
  })

  it('prunes sent records past the horizon and notified records of ended tickets', () => {
    const ctx = fakeContext()
    ctx.state.set(KEYS.sent('old'), { timestamps: [1], at: ago(MAP_HORIZON_MS + 1) })
    ctx.state.set(KEYS.sent('new'), { timestamps: [2], at: ago(DAY) })
    ctx.ticketStore.set('t-ended', ticket('t-ended', ago(DAY)))
    ctx.state.set(KEYS.notified('t-ended'), { keys: ['a'], ended: ago(15 * DAY) })
    expect(prune(ctx, NOW)).toBe(2)
    expect(ctx.state.keys('signal-sent:')).toEqual([KEYS.sent('new')])
    expect(ctx.state.get(KEYS.notified('t-ended'))).toBeUndefined()
  })

  it('prunes notified records of tickets that are gone or quiet past the horizon', () => {
    const ctx = fakeContext()
    ctx.ticketStore.set('t-quiet', ticket('t-quiet', ago(15 * DAY)))
    ctx.ticketStore.set('t-live', ticket('t-live', ago(DAY)))
    ctx.state.set(KEYS.notified('t-gone'), { keys: ['a'] })
    ctx.state.set(KEYS.notified('t-quiet'), { keys: ['a'] })
    ctx.state.set(KEYS.notified('t-live'), { keys: ['a'], ended: ago(DAY) })
    expect(prune(ctx, NOW)).toBe(2)
    expect(ctx.state.keys('signal-notified:')).toEqual([KEYS.notified('t-live')])
  })

  it('prunes at the end of each round', async () => {
    const ctx = fakeContext()
    remember(ctx, 1, { thread: 'a', at: ago(15 * DAY) })
    const { hub } = hubOf({ messages: [] })
    await run(ctx, hub)
    expect(ctx.state.get(KEYS.map(1))).toBeUndefined()
    expect(ctx.state.get(KEYS.pruned)).toBe(NOW.toISOString())
  })

  it('treats map entries past the horizon as unknown', () => {
    const ctx = fakeContext()
    remember(ctx, 1, { thread: 'a', at: ago(MAP_HORIZON_MS + 1) })
    remember(ctx, 2, { thread: 'b', at: ago(MAP_HORIZON_MS - 1) })
    expect(lookup(ctx, 1, NOW)).toBeUndefined()
    expect(lookup(ctx, 2, NOW)?.thread).toBe('b')
    expect(lookup(ctx, 3, NOW)).toBeUndefined()
  })
})

describe('quotes to tickets from other Sources', () => {
  const noticeThread = ticketThreadId(internalA, 'T9')
  const quote = { timestamp: 7000, author: { number: '', uuid: 'dsh-uuid' }, text: 'Needs you' }
  const setup = () => {
    const ctx = fakeContext()
    remember(ctx, 7000, { thread: noticeThread, ticketId: 'T9', at: ago(DAY) })
    const attach = vi.fn()
    ctx.tickets.attachThread = attach
    return { ctx, attach }
  }

  it("attaches a foreign ticket's thread before taking a quote to its notice in", async () => {
    const { ctx, attach } = setup()
    const order: string[] = []
    attach.mockImplementation(() => { order.push('attach') })
    ctx.onReceive = () => { order.push('receive'); return 'stored' }
    const { hub } = hubOf({ messages: [message({ seq: 3, timestamp: 7100, quote })] })
    await run(ctx, hub)
    expect(attach).toHaveBeenCalledWith('T9', { source: 'signal', id: noticeThread })
    expect(order).toEqual(['attach', 'receive'])
    expect(ctx.received[0]!.threads[0]).toEqual({ source: 'signal', id: noticeThread })
  })

  it('still takes the quote in when the ticket refuses the attach', async () => {
    const { ctx, attach } = setup()
    attach.mockImplementation(() => { throw new Error('A person stopped this ticket; new work needs an accept through orchestrator_route') })
    const logger = log()
    const c = counts()
    const { hub } = hubOf({ messages: [message({ seq: 3, timestamp: 7100, quote })] })
    await run(ctx, hub, c, logger)
    expect(ctx.received).toHaveLength(1)
    expect(ctx.received[0]!.threads[0]!.id).toBe(noticeThread)
    expect(c.taken).toBe(1)
    expect(logger.warn.mock.calls.map(call => String(call[0])).join('\n')).toContain('T9')
  })

  it('does not attach a thread a Signal request started', async () => {
    const { ctx, attach } = setup()
    remember(ctx, 7001, { thread: `${internalA}:800`, ticketId: 'T9', at: ago(DAY) })
    const { hub } = hubOf({ messages: [message({ seq: 3, timestamp: 7100, quote: { ...quote, timestamp: 7001 } })] })
    await run(ctx, hub)
    expect(attach).not.toHaveBeenCalled()
    expect(ctx.received).toHaveLength(1)
  })

  it('takes the quote in on a host without attachThread', async () => {
    const { ctx } = setup()
    delete ctx.tickets.attachThread
    const { hub } = hubOf({ messages: [message({ seq: 3, timestamp: 7100, quote })] })
    await run(ctx, hub)
    expect(ctx.received).toHaveLength(1)
  })
})

function ticket(id: string, updatedAt: string): Ticket {
  return { id, title: id, channels: [], origin: { triggerId: 'x', triggerIds: ['x'] }, assignments: [], updatedAt }
}
