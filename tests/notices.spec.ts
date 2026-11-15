import { describe, expect, it } from 'vitest'
import { SignalConfigSchema } from '../src/config.ts'
import { ticketThreadId } from '../src/intake.ts'
import { originLabel } from '../src/labels.ts'
import { HOST_HEALTH_ENTRIES, type NoticeCounts, noticeRound, noticeText, transitionOf } from '../src/notices.ts'
import { KEYS, type NotifiedRecord, prune } from '../src/state.ts'
import type { Health, OutboundMessage, Ticket, TicketChange, TicketCursor, TicketStage, Trigger } from '../src/types.ts'
import { fakeContext, internalA, restA } from './fakes.ts'

const T0 = new Date('2026-11-14T12:00:00.000Z')
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000)
const iso = (seconds: number) => at(seconds).toISOString()
const config = SignalConfigSchema.parse({ hubUrl: 'http://hub', tokenFile: '/run/token', groupId: restA })

function ticket(id: string, overrides: Partial<Ticket> = {}): Ticket {
  return { id, title: 'Fix login', channels: [], origin: { triggerId: `trigger-${id}`, triggerIds: [`trigger-${id}`] }, assignments: [], updatedAt: iso(1), ...overrides }
}

const linearTrigger = (id: string): Trigger => ({
  id, source: 'linear', threads: [], actor: { source: 'linear', id: 'u1' }, human: true, at: iso(0), text: 'x', meta: { identifier: 'ENG-12' },
})
const signalChannel = { source: 'signal', thread: `signal:${internalA}:1763114400000`, address: { group: internalA, quoteTimestamp: '1763114400000', quoteAuthor: 'owner' } }
const signalTrigger = (id: string): Trigger => ({
  id, source: 'signal', threads: [], actor: { source: 'signal', id: 'owner' }, human: true, at: iso(0), text: 'x', channel: signalChannel, meta: {},
})

function setup(seed?: Map<string, unknown>) {
  const ctx = fakeContext()
  for (const [k, v] of seed ?? []) ctx.store.set(k, structuredClone(v))
  const changes: TicketChange[] = []
  const triggers = new Map<string, Trigger>()
  const threads = new Map<string, Record<string, unknown>>()
  const health: Record<string, Health> = {}
  const sent: OutboundMessage[] = []
  const reads: TicketCursor[] = []
  const key = (c: { at: string; id: string }) => `${c.at}\u0000${c.id}`
  ctx.tickets.changed = (after, limit) => {
    reads.push(after)
    const items = [...changes].sort((a, b) => key({ at: a.ticket.updatedAt, id: a.ticket.id }) < key({ at: b.ticket.updatedAt, id: b.ticket.id }) ? -1 : 1)
      .filter(change => key({ at: change.ticket.updatedAt, id: change.ticket.id }) > key(after)).slice(0, limit)
    const last = items.at(-1)?.ticket
    return { items, next: last ? { at: last.updatedAt, id: last.id } : after }
  }
  ctx.triggers.get = id => triggers.get(id)
  ctx.threads.get = id => { const meta = threads.get(id); return meta ? { meta } : undefined }
  ctx.health = () => health
  ctx.notify = message => { sent.push(message) }
  const counts: NoticeCounts = { posted: 0 }
  const round = (now: Date, c = config) => noticeRound(ctx, c, now, counts)
  const put = (t: Ticket, stage: TicketStage, trigger: Trigger = linearTrigger(t.origin.triggerId)) => {
    const index = changes.findIndex(change => change.ticket.id === t.id)
    if (index >= 0) changes.splice(index, 1)
    changes.push({ ticket: t, stage })
    triggers.set(trigger.id, trigger)
  }
  return { ctx, changes, triggers, threads, health, sent, reads, counts, round, put }
}

const started = (s: ReturnType<typeof setup>) => { s.round(T0); expect(s.sent).toEqual([]) }
const question = { stage: 'person', action: 'answer' } as const
const blocked = { stage: 'person', action: 'blocked' } as const
const failed = { stage: 'person', action: 'failed' } as const
const ended = { stage: 'ended' } as const
const report = (summary: string, when: string) => ({ report: { state: 'blocked', summary, at: when } })
const working = { stage: 'working' } as const
const queued = { stage: 'working', action: 'queued' } as const
const review = { stage: 'person', action: 'review' } as const
const linear = (id: string, identifier: string, meta: Record<string, unknown> = {}, text = 'x'): Trigger => ({ ...linearTrigger(id), text, meta: { identifier, ...meta } })
const endOf = (outcome: NonNullable<Ticket['ended']>['outcome'], seconds: number, by: 'executor' | 'human' = 'executor') => ({ at: iso(seconds), by, outcome })
const batchChannel = { source: 'signal', thread: `signal:${internalA}:batch`, address: { group: internalA } }
const H = 3600

describe('transitionOf', () => {
  it('maps stages to notice keys', () => {
    expect(transitionOf({ ticket: ticket('T1', { attention: { id: 'a1', question: 'q' } }), stage: question })).toEqual({ key: 'attention:a1', kind: 'question' })
    expect(transitionOf({ ticket: ticket('T1', { assignments: [report('old', iso(1)), report('new', iso(5))] }), stage: blocked })).toEqual({ key: `blocked:${iso(5)}`, kind: 'blocked' })
    expect(transitionOf({ ticket: ticket('T1', { ended: { at: iso(9), by: 'executor', outcome: 'completed' } }), stage: ended })).toBeUndefined()
    expect(transitionOf({ ticket: ticket('T1'), stage: { stage: 'working' } })).toBeUndefined()
    expect(transitionOf({ ticket: ticket('T1'), stage: { stage: 'person', action: 'review' } })).toBeUndefined()
  })

  it('labels origins', () => {
    expect(originLabel(linearTrigger('x'))).toBe('Linear ENG-12')
    expect(originLabel({ ...linearTrigger('x'), source: 'github', url: 'https://github.com/o/r/issues/3' })).toBe('GitHub https://github.com/o/r/issues/3')
    expect(originLabel(signalTrigger('x'))).toBe('Signal request')
    expect(originLabel({ ...linearTrigger('x'), source: 'feishu' })).toBe('Feishu')
    expect(originLabel({ ...linearTrigger('x'), source: 'jira' })).toBe('jira')
  })
})

describe('notice title', () => {
  it('drops the identifier prefix the origin label already carries', () => {
    const text = noticeText('question', ticket('T1', { title: 'XXX-429: Change the footer text', attention: { id: 'a1', question: 'Which?' } }), 'Linear XXX-429')
    expect(text.startsWith('Question on Linear XXX-429 "Change the footer text":')).toBe(true)
  })

  it('leaves a title without the prefix unchanged', () => {
    expect(noticeText('failed', ticket('T1', { title: 'Change the footer text' }), 'Linear XXX-429')).toContain('Linear XXX-429 "Change the footer text" failed')
    expect(noticeText('failed', ticket('T1', { title: 'XXX-4290: other' }), 'Linear XXX-429')).toContain('"XXX-4290: other"')
  })
})

describe('ticket notices', () => {
  it('starts at now without announcing history', () => {
    const s = setup()
    s.put(ticket('T1', { attention: { id: 'a1', question: 'Which repo?' }, updatedAt: iso(-10) }), question)
    s.round(T0)
    expect(s.sent).toEqual([])
    expect(s.ctx.state.get(KEYS.ticketCursor)).toEqual({ at: T0.toISOString(), id: '' })
  })

  it('announces a question once, with origin, title and how to answer', () => {
    const s = setup()
    started(s)
    s.put(ticket('T1', { attention: { id: 'a1', question: 'Which repo?' } }), question)
    s.round(at(5))
    expect(s.sent).toEqual([{
      id: 'signal:notice:T1:attention:a1',
      channel: { source: 'signal', thread: `signal:${internalA}:ticket:T1`, address: { group: internalA } },
      text: 'Question on Linear ENG-12 "Fix login":\nWhich repo?\n\nQuote this message to answer.',
      kind: 'notice',
      ticketId: 'T1',
    }])
    expect(s.sent[0]?.channel.thread).toBe(`signal:${ticketThreadId(internalA, 'T1')}`)
    s.round(at(10))
    expect(s.sent).toHaveLength(1)
    expect(s.counts.posted).toBe(1)
  })

  it('does not repeat a question that waited past the horizon when the ticket is touched again', () => {
    const s = setup()
    started(s)
    const waiting = ticket('T1', { attention: { id: 'a1', question: 'Which repo?' } })
    s.ctx.ticketStore.set('T1', waiting)
    s.put(waiting, question)
    s.round(at(5))
    expect(s.sent).toHaveLength(1)
    const later = 15 * 24 * 3600
    prune(s.ctx, at(later))
    const touched = { ...waiting, updatedAt: iso(later) }
    s.ctx.ticketStore.set('T1', touched)
    s.put(touched, question)
    s.round(at(later + 5))
    expect(s.sent.filter(m => m.id.startsWith('signal:notice:'))).toHaveLength(1)
  })

  it('announces blocked and failed reports keyed by the report time', () => {
    const s = setup()
    started(s)
    s.put(ticket('T1', { assignments: [report('No access to the repo', iso(2))], updatedAt: iso(2) }), blocked)
    s.round(at(5))
    s.put(ticket('T1', { assignments: [report('No access to the repo', iso(2)), report('Tests crash', iso(6))], updatedAt: iso(6) }), failed)
    s.round(at(10))
    expect(s.sent.map(m => m.id)).toEqual([`signal:notice:T1:blocked:${iso(2)}`, `signal:notice:T1:failed:${iso(6)}`])
    expect(s.sent[0]?.text).toBe('Linear ENG-12 "Fix login" is blocked:\nNo access to the repo\n\nQuote this message to answer.')
    expect(s.sent[1]?.text).toBe('Linear ENG-12 "Fix login" failed:\nTests crash\n\nQuote this message to answer.')
  })

  it('answers a Signal ticket on its own request', () => {
    const s = setup()
    started(s)
    s.put(ticket('T1', { assignments: [report('No access', iso(2))] }), blocked, signalTrigger('trigger-T1'))
    s.round(at(5))
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]?.channel).toEqual(signalChannel)
    expect(s.sent[0]?.text).toBe('Signal request "Fix login" is blocked:\nNo access\n\nQuote this message to answer.')
  })

  it('answers a question on a Signal request on that request', () => {
    const s = setup()
    started(s)
    s.put(ticket('T1', { attention: { id: 'a1', question: 'Which repo?' } }), question, signalTrigger('trigger-T1'))
    s.round(at(5))
    expect(s.sent.map(m => m.id)).toEqual(['signal:notice:T1:attention:a1'])
    expect(s.sent[0]?.channel).toBe(signalChannel)
    expect(s.sent[0]?.text).toBe('Question on Signal request "Fix login":\nWhich repo?\n\nQuote this message to answer.')
  })
  it('reads every page of changes', () => {
    const s = setup()
    started(s)
    for (let i = 0; i < 250; i++) s.put(ticket(`T${String(i).padStart(3, '0')}`, { attention: { id: `a${i}`, question: 'q' }, updatedAt: iso(1 + i / 1000) }), question)
    s.round(at(5))
    expect(s.sent).toHaveLength(250)
    expect(s.ctx.state.get(KEYS.ticketCursor)).toEqual({ at: iso(1.249), id: 'T249' })
  })

  it('re-reads tickets that share the last timestamp, so a late write in the same millisecond is not lost', () => {
    const s = setup()
    started(s)
    s.put(ticket('T2', { attention: { id: 'a2', question: 'q' }, updatedAt: iso(1) }), question)
    s.round(at(5))
    expect(s.ctx.state.get(KEYS.ticketCursor)).toEqual({ at: iso(1), id: 'T2' })
    s.put(ticket('T1', { attention: { id: 'a1', question: 'q' }, updatedAt: iso(1) }), question)
    s.round(at(10))
    expect(s.reads.at(-1)).toEqual({ at: iso(1), id: '' })
    expect(s.sent.map(m => m.id)).toEqual(['signal:notice:T2:attention:a2', 'signal:notice:T1:attention:a1'])
  })

  it('keeps the last 20 keys of a ticket', () => {
    const s = setup()
    started(s)
    for (let i = 0; i < 25; i++) {
      s.put(ticket('T1', { attention: { id: `a${i}`, question: 'q' }, updatedAt: iso(1 + i) }), question)
      s.round(at(30 + i))
    }
    const keys = s.ctx.state.get<NotifiedRecord>(KEYS.notified('T1'))?.keys
    expect(keys).toHaveLength(20)
    expect(keys?.at(0)).toBe('attention:a5')
    expect(keys?.at(-1)).toBe('attention:a24')
  })
})

describe('batch notices', () => {
  const login = (overrides: Partial<Ticket> = {}) => ticket('T1', { title: 'ENG-1: Fix login', ...overrides })
  const footer = (overrides: Partial<Ticket> = {}) => ticket('T2', { title: 'Fix footer', updatedAt: iso(60), ...overrides })
  const eng1 = linear('trigger-T1', 'ENG-1')
  const eng2 = linear('trigger-T2', 'ENG-2')
  const startTwo = (s: ReturnType<typeof setup>) => {
    started(s)
    s.put(login(), working, eng1)
    s.round(at(5))
    s.put(footer(), working, eng2)
    s.round(at(60))
  }

  it('posts one start message for tickets that start within the settle window', () => {
    const s = setup()
    startTwo(s)
    s.round(at(179))
    expect(s.sent).toEqual([])
    s.round(at(180))
    expect(s.sent).toEqual([{ id: `signal:batch:${iso(5)}:start:1`, channel: batchChannel,
      text: 'Started: 2 tickets\nLinear ENG-1 "Fix login"\nLinear ENG-2 "Fix footer"', kind: 'notice' }])
    s.round(at(400))
    expect(s.sent).toHaveLength(1)
    expect(s.counts.posted).toBe(1)
  })

  it('posts a second start message for a ticket that starts after the window', () => {
    const s = setup()
    startTwo(s)
    s.round(at(180))
    s.put(ticket('T3', { title: 'Fix header', updatedAt: iso(300) }), working, linear('trigger-T3', 'ENG-3'))
    s.round(at(300))
    s.round(at(420))
    expect(s.sent.map(m => [m.id, m.text])).toEqual([
      [`signal:batch:${iso(5)}:start:1`, 'Started: 2 tickets\nLinear ENG-1 "Fix login"\nLinear ENG-2 "Fix footer"'],
      [`signal:batch:${iso(5)}:start:2`, 'Started: 1 ticket\nLinear ENG-3 "Fix header"'],
    ])
  })

  it('counts a ticket as started once a worker is on it, not while it is queued', () => {
    const s = setup()
    started(s)
    s.put(login(), queued, eng1)
    s.round(at(5))
    s.round(at(200))
    expect(s.sent).toEqual([])
    expect(s.ctx.state.get(KEYS.batch)).toBeUndefined()
    s.put(login({ updatedAt: iso(210) }), review, eng1)
    s.round(at(210))
    s.round(at(330))
    expect(s.sent.map(m => m.text)).toEqual(['Started: 1 ticket\nLinear ENG-1 "Fix login"'])
  })

  it('posts no message per ended ticket and one summary once the last one ended and the window passed', () => {
    const s = setup()
    startTwo(s)
    s.round(at(180))
    s.threads.set('github:12', { url: 'https://github.com/o/r/pull/12' })
    s.put(login({ ended: endOf('merged', 300), follows: [{ thread: 'github:12', own: true }], updatedAt: iso(300) }), ended, eng1)
    s.round(at(300))
    s.put(footer({ ended: endOf('completed', 400), updatedAt: iso(400) }), ended, eng2)
    s.round(at(400))
    s.round(at(519))
    expect(s.sent).toHaveLength(1)
    s.round(at(520))
    expect(s.sent.at(-1)).toEqual({ id: `signal:batch:${iso(5)}:summary:1`, channel: batchChannel,
      text: 'Finished: 2 tickets\nLinear ENG-1 "Fix login" is merged: https://github.com/o/r/pull/12\nLinear ENG-2 "Fix footer" is done', kind: 'notice' })
    expect(s.ctx.state.get(KEYS.batch)).toBeUndefined()
    s.round(at(900))
    expect(s.sent).toHaveLength(2)
  })

  it('words every outcome and lists a ticket that ended without starting only in the summary', () => {
    const s = setup()
    started(s)
    s.put(ticket('T1', { title: 'One', ended: endOf('closed', 2) }), ended, linear('trigger-T1', 'ENG-1'))
    s.put(ticket('T2', { title: 'Two', ended: endOf('dropped', 2) }), ended, linear('trigger-T2', 'ENG-2'))
    s.put(ticket('T3', { title: 'Three', ended: endOf('stopped', 2, 'human') }), ended, linear('trigger-T3', 'ENG-3'))
    s.round(at(5))
    s.round(at(125))
    expect(s.sent.map(m => m.text)).toEqual(['Finished: 3 tickets\nLinear ENG-1 "One" was closed without merging\nLinear ENG-2 "Two" was dropped: nothing to do\nLinear ENG-3 "Three" was stopped by a person'])
  })

  it('does not summarize an ended ticket again when it changes after its batch closed', () => {
    const s = setup()
    started(s)
    s.put(login({ ended: endOf('completed', 2) }), ended, eng1)
    s.round(at(5))
    s.round(at(125))
    s.put(login({ ended: endOf('completed', 2), updatedAt: iso(200) }), ended, eng1)
    s.round(at(200))
    s.round(at(400))
    expect(s.sent).toHaveLength(1)
    expect(s.ctx.state.get(KEYS.batch)).toBeUndefined()
  })

  it('groups the sub-issues of an epic under it, with a count in the summary', () => {
    const s = setup()
    started(s)
    const parentText = 'Parent: ENG-10 https://linear.app/x/issue/ENG-10\nSub-issues: ENG-11 (open)\n\nbody'
    const sub = (id: string, identifier: string) => linear(`trigger-${id}`, identifier, { issue: `i-${identifier}`, parent: 'i-ENG-10' }, parentText)
    s.put(ticket('T1', { title: 'ENG-11: Add form', updatedAt: iso(1) }), working, sub('T1', 'ENG-11'))
    s.put(ticket('T2', { title: 'Fix footer', updatedAt: iso(2) }), working, linear('trigger-T2', 'ENG-20'))
    s.put(ticket('T3', { title: 'ENG-12: Wire API', updatedAt: iso(3) }), working, sub('T3', 'ENG-12'))
    s.round(at(5))
    s.round(at(125))
    expect(s.sent.map(m => m.text)).toEqual(['Started: 3 tickets\nEpic ENG-10:\n  Linear ENG-11 "Add form"\n  Linear ENG-12 "Wire API"\nLinear ENG-20 "Fix footer"'])
    s.threads.set('github:11', { url: 'https://github.com/o/r/pull/11' })
    s.put(ticket('T0', { title: 'ENG-10: Login revamp', ended: endOf('completed', 150), updatedAt: iso(150) }), ended, linear('trigger-T0', 'ENG-10', { issue: 'i-ENG-10' }))
    s.put(ticket('T1', { title: 'ENG-11: Add form', ended: endOf('merged', 151), follows: [{ thread: 'github:11', own: true }], updatedAt: iso(151) }), ended, sub('T1', 'ENG-11'))
    s.put(ticket('T2', { title: 'Fix footer', ended: endOf('merged', 152), updatedAt: iso(152) }), ended, linear('trigger-T2', 'ENG-20'))
    s.put(ticket('T3', { title: 'ENG-12: Wire API', ended: endOf('closed', 153), updatedAt: iso(153) }), ended, sub('T3', 'ENG-12'))
    s.round(at(160))
    s.round(at(280))
    expect(s.sent.at(-1)?.text).toBe([
      'Finished: 4 tickets',
      'Epic ENG-10 "Login revamp": 1 of 2 sub-issues merged',
      '  Linear ENG-11 "Add form" is merged: https://github.com/o/r/pull/11',
      '  Linear ENG-12 "Wire API" was closed without merging',
      'Linear ENG-20 "Fix footer" is merged',
      'Linear ENG-10 "Login revamp" is done',
    ].join('\n'))
  })

  it('still posts a question, block or failure at once, per ticket, while the ticket is in a batch', () => {
    const s = setup()
    startTwo(s)
    s.put(login({ attention: { id: 'a1', question: 'Which repo?' }, updatedAt: iso(70) }), question, eng1)
    s.put(footer({ assignments: [report('No access', iso(71))], updatedAt: iso(71) }), blocked, eng2)
    s.round(at(75))
    expect(s.sent.map(m => [m.id, m.channel.thread])).toEqual([
      ['signal:notice:T1:attention:a1', `signal:${internalA}:ticket:T1`],
      [`signal:notice:T2:blocked:${iso(71)}`, `signal:${internalA}:ticket:T2`],
    ])
    s.put(login({ assignments: [report('Tests crash', iso(80))], updatedAt: iso(80) }), failed, eng1)
    s.round(at(80))
    expect(s.sent.at(-1)?.id).toBe(`signal:notice:T1:failed:${iso(80)}`)
    s.round(at(180))
    expect(s.sent.at(-1)?.id).toBe(`signal:batch:${iso(5)}:start:1`)
  })

  it('sends a partial summary after batchMaxHours while tickets still run, and the batch goes on', () => {
    const s = setup()
    startTwo(s)
    s.round(at(180))
    s.put(login({ ended: endOf('completed', 200), updatedAt: iso(200) }), ended, eng1)
    s.round(at(200))
    s.round(at(200 + 4 * H - 1))
    expect(s.sent).toHaveLength(1)
    s.round(at(200 + 4 * H))
    expect(s.sent.at(-1)).toEqual({ id: `signal:batch:${iso(5)}:summary:1`, channel: batchChannel,
      text: '1 of 2 done, still running: Linear ENG-2 "Fix footer"\nLinear ENG-1 "Fix login" is done', kind: 'notice' })
    s.round(at(200 + 9 * H))
    expect(s.sent).toHaveLength(2)
    s.put(footer({ ended: endOf('completed', 10 * H), updatedAt: iso(10 * H) }), ended, eng2)
    s.round(at(10 * H))
    s.round(at(10 * H + 120))
    expect(s.sent.at(-1)?.id).toBe(`signal:batch:${iso(5)}:summary:2`)
    expect(s.sent.at(-1)?.text).toBe('Finished: 2 tickets\nLinear ENG-1 "Fix login" is done\nLinear ENG-2 "Fix footer" is done')
  })

  it('posts no ended notice for a Signal request but lists it in the start and summary messages', () => {
    const s = setup()
    started(s)
    s.put(ticket('T1'), working, signalTrigger('trigger-T1'))
    s.round(at(5))
    s.round(at(125))
    s.put(ticket('T1', { ended: endOf('merged', 200), follows: [{ thread: 'github:12', own: true, closed: { at: iso(199), outcome: 'merged' } }], updatedAt: iso(200) }), ended, signalTrigger('trigger-T1'))
    s.round(at(200))
    expect(s.sent).toHaveLength(1)
    s.round(at(320))
    expect(s.sent.map(m => [m.text, m.channel])).toEqual([
      ['Started: 1 ticket\nSignal request "Fix login"', batchChannel],
      ['Finished: 1 ticket\nSignal request "Fix login" is merged', batchChannel],
    ])
  })

  it('reuses the message id after a crash between notify and the state write, so the outbox drops the repeat', () => {
    const s = setup()
    startTwo(s)
    const outbox = new Map<string, OutboundMessage>()
    s.ctx.notify = message => { s.sent.push(message); if (!outbox.has(message.id)) outbox.set(message.id, message) }
    const crashed = (now: Date) => {
      const before = structuredClone(s.ctx.store)
      s.round(now)
      s.ctx.store.clear()
      for (const [k, v] of before) s.ctx.store.set(k, v)
      s.round(now)
    }
    crashed(at(180))
    s.put(login({ ended: endOf('completed', 200), updatedAt: iso(200) }), ended, eng1)
    s.put(footer({ ended: endOf('completed', 201), updatedAt: iso(201) }), ended, eng2)
    s.round(at(201))
    crashed(at(321))
    expect(s.sent.map(m => m.id)).toEqual([`signal:batch:${iso(5)}:start:1`, `signal:batch:${iso(5)}:start:1`, `signal:batch:${iso(5)}:summary:1`, `signal:batch:${iso(5)}:summary:1`])
    expect(s.sent[0]?.text).toBe(s.sent[1]?.text)
    expect(s.sent[2]?.text).toBe(s.sent[3]?.text)
    expect([...outbox.keys()]).toEqual([`signal:batch:${iso(5)}:start:1`, `signal:batch:${iso(5)}:summary:1`])
  })

  it('continues the batch after a restart', () => {
    const first = setup()
    started(first)
    first.put(login(), working, eng1)
    first.round(at(5))
    const s = setup(first.ctx.store)
    s.put(login(), working, eng1)
    s.put(footer(), working, eng2)
    s.round(at(60))
    s.round(at(180))
    expect(s.sent.map(m => [m.id, m.text])).toEqual([[`signal:batch:${iso(5)}:start:1`, 'Started: 2 tickets\nLinear ENG-1 "Fix login"\nLinear ENG-2 "Fix footer"']])
  })

  it('stores one batch record', () => {
    const s = setup()
    startTwo(s)
    expect(s.ctx.state.get(KEYS.batch)).toEqual({ id: iso(5), starts: 0, summaries: 0, lastStart: iso(60), tickets: [
      { id: 'T1', origin: 'Linear ENG-1', title: 'ENG-1: Fix login', started: iso(5) },
      { id: 'T2', origin: 'Linear ENG-2', title: 'Fix footer', started: iso(60) },
    ] })
  })
})

describe('health notices', () => {
  const healthChannel = { source: 'signal', thread: `signal:${internalA}:health`, address: { group: internalA } }

  it('announces a dependency error after the grace and its recovery once', () => {
    const s = setup()
    s.health.github = { state: 'error', detail: 'token expired' }
    s.round(T0)
    s.round(at(59))
    expect(s.sent).toEqual([])
    s.round(at(60))
    expect(s.sent).toEqual([{ id: `signal:health:github:error:${T0.toISOString()}`, channel: healthChannel, text: 'dsh: github is failing: token expired', kind: 'notice' }])
    s.round(at(61))
    expect(s.sent).toHaveLength(1)
    s.health.github = { state: 'ready', detail: '' }
    s.round(at(120))
    expect(s.sent.at(-1)).toEqual({ id: `signal:health:github:ok:${T0.toISOString()}`, channel: healthChannel, text: 'dsh: github works again.', kind: 'notice' })
    s.round(at(121))
    expect(s.sent).toHaveLength(2)
    expect(s.ctx.state.get(KEYS.health('github'))).toEqual({ state: 'ok' })
  })

  it('covers sync entries', () => {
    const s = setup()
    s.health['sync:lkshrk/example'] = { state: 'error', detail: 'clone failed' }
    s.round(T0)
    s.round(at(60))
    expect(s.sent.map(m => m.text)).toEqual(['dsh: sync:lkshrk/example is failing: clone failed'])
  })

  it('caps the detail at 300 characters', () => {
    const s = setup()
    s.health.github = { state: 'error', detail: 'x'.repeat(301) }
    s.round(T0)
    s.round(at(60))
    expect(s.sent[0]?.text).toBe(`dsh: github is failing: ${'x'.repeat(299)}…`)
    s.health.github = { state: 'ready', detail: '' }
    s.round(at(61))
    s.health.github = { state: 'error', detail: 'y'.repeat(300) }
    s.round(at(62))
    s.round(at(122))
    expect(s.sent.at(-1)?.text).toBe(`dsh: github is failing: ${'y'.repeat(300)}`)
  })

  it('cuts the detail by code point, never inside an emoji', () => {
    const s = setup()
    s.health.github = { state: 'error', detail: `${'x'.repeat(298)}😀😀z` }
    s.round(T0)
    s.round(at(60))
    const detail = s.sent[0]?.text.slice('dsh: github is failing: '.length) ?? ''
    expect(detail).toBe(`${'x'.repeat(298)}😀…`)
    expect([...detail]).toHaveLength(300)
    expect(detail.isWellFormed()).toBe(true)
  })

  it('stays quiet about an error that clears within the grace, its own entry, and starting or paused', () => {
    const s = setup()
    s.health.github = { state: 'error', detail: 'blip' }
    s.health.signal = { state: 'error', detail: 'hub down' }
    s.round(T0)
    s.health.github = { state: 'ready', detail: '' }
    s.round(at(30))
    expect(s.ctx.state.get(KEYS.health('github'))).toEqual({ state: 'ok' })
    s.health.github = { state: 'error', detail: 'again' }
    s.round(at(40))
    s.health.github = { state: 'starting', detail: '' }
    s.round(at(50))
    s.health.github = { state: 'paused', detail: '' }
    s.round(at(60))
    expect(s.ctx.state.get(KEYS.health('github'))).toEqual({ state: 'error', since: at(40).toISOString(), notified: false })
    s.round(at(200))
    expect(s.sent).toEqual([])
    expect(s.ctx.state.get(KEYS.health('signal'))).toBeUndefined()
  })

  it('ignores host-internal entries', () => {
    const s = setup()
    expect(HOST_HEALTH_ENTRIES).toEqual(expect.arrayContaining(['reply', 'relay', 'assessment', 'notice', 'runtime', 'evals', 'models', 'worker', 'launch', 'delivery', 'archive', 'signal']))
    s.health.reply = { state: 'error', detail: 'x' }
    s.health.runtime = { state: 'error', detail: 'x' }
    s.health.launch = { state: 'error', detail: 'x' }
    s.health.delivery = { state: 'error', detail: 'x' }
    s.health.archive = { state: 'error', detail: 'x' }
    s.round(T0)
    s.round(at(600))
    expect(s.sent).toEqual([])
  })
})

describe('switches and old hosts', () => {
  it('skips ticket notices when notifyTickets is off and health notices when notifyHealth is off', () => {
    const s = setup()
    const off = SignalConfigSchema.parse({ ...config, notifyTickets: false, notifyHealth: false })
    s.round(T0, off)
    s.put(ticket('T1', { attention: { id: 'a1', question: 'q' } }), question)
    s.health.github = { state: 'error', detail: 'x' }
    s.round(at(1), off)
    s.round(at(600), off)
    expect(s.sent).toEqual([])
    expect(s.reads).toEqual([])
    expect(s.ctx.state.get(KEYS.ticketCursor)).toBeUndefined()
    expect(s.ctx.state.get(KEYS.health('github'))).toBeUndefined()
  })

  it('posts no start, stuck or summary message while notifyTickets is off', () => {
    const s = setup()
    const off = SignalConfigSchema.parse({ ...config, notifyTickets: false })
    s.round(T0)
    s.put(ticket('T1'), working)
    s.round(at(5))
    s.put(ticket('T1', { attention: { id: 'a1', question: 'q' }, updatedAt: iso(10) }), question)
    s.round(at(200), off)
    s.put(ticket('T1', { ended: endOf('completed', 300), updatedAt: iso(300) }), ended)
    s.round(at(300), off)
    s.round(at(900), off)
    expect(s.sent).toEqual([])
  })

  it('skips what the host does not offer', () => {
    const s = setup()
    delete s.ctx.tickets.changed
    delete s.ctx.health
    expect(() => s.round(T0)).not.toThrow()
    expect(s.sent).toEqual([])
  })
})
