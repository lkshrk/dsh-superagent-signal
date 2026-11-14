import { describe, expect, it } from 'vitest'
import { SignalConfigSchema } from '../src/config.ts'
import { ticketThreadId } from '../src/intake.ts'
import { HOST_HEALTH_ENTRIES, type NoticeCounts, noticeRound, originLabel, transitionOf } from '../src/notices.ts'
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

function setup() {
  const ctx = fakeContext()
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

describe('transitionOf', () => {
  it('maps stages to notice keys', () => {
    expect(transitionOf({ ticket: ticket('T1', { attention: { id: 'a1', question: 'q' } }), stage: question })).toEqual({ key: 'attention:a1', kind: 'question' })
    expect(transitionOf({ ticket: ticket('T1', { assignments: [report('old', iso(1)), report('new', iso(5))] }), stage: blocked })).toEqual({ key: `blocked:${iso(5)}`, kind: 'blocked' })
    expect(transitionOf({ ticket: ticket('T1', { ended: { at: iso(9), by: 'executor', outcome: 'completed' } }), stage: ended })).toEqual({ key: `ended:${iso(9)}`, kind: 'ended' })
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
    expect(s.sent).toHaveLength(1)
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

  it('announces an end with the pull request link', () => {
    const s = setup()
    started(s)
    s.threads.set('github:12', { url: 'https://github.com/o/r/pull/12' })
    s.threads.set('github:13', { url: 'https://github.com/o/r/pull/13' })
    s.put(ticket('T1', { ended: { at: iso(4), by: 'executor', outcome: 'merged' }, follows: [{ thread: 'github:13', own: false }, { thread: 'github:12', own: true }] }), ended)
    s.round(at(5))
    expect(s.sent).toHaveLength(1)
    expect(s.sent[0]?.id).toBe(`signal:notice:T1:ended:${iso(4)}`)
    expect(s.sent[0]?.text).toBe('Linear ENG-12 "Fix login" is merged: https://github.com/o/r/pull/12.\n\nQuote this message to follow up.')
    expect(s.ctx.state.get<NotifiedRecord>(KEYS.notified('T1'))).toEqual({ keys: [`ended:${iso(4)}`], ended: iso(4) })
  })

  it('words every end', () => {
    const s = setup()
    started(s)
    const outcomes = { completed: 'is done', closed: 'was closed without merging', dropped: 'was dropped: nothing to do' } as const
    for (const [outcome, word] of Object.entries(outcomes)) {
      s.put(ticket(outcome, { ended: { at: iso(4), by: 'executor', outcome: outcome as keyof typeof outcomes } }), ended)
      s.round(at(5))
      expect(s.sent.at(-1)?.text).toBe(`Linear ENG-12 "Fix login" ${word}.\n\nQuote this message to follow up.`)
    }
  })

  it('announces a stop by a person', () => {
    const s = setup()
    started(s)
    s.put(ticket('T1', { ended: { at: iso(4), by: 'human', outcome: 'stopped' } }), ended)
    s.round(at(5))
    expect(s.sent.map(m => [m.id, m.text])).toEqual([[`signal:notice:T1:ended:${iso(4)}`, 'Linear ENG-12 "Fix login" was stopped by a person.\n\nQuote this message to follow up.']])
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

  it('announces a question and the ends the host does not post on a Signal request', () => {
    const s = setup()
    started(s)
    s.put(ticket('T1', { attention: { id: 'a1', question: 'Which repo?' } }), question, signalTrigger('trigger-T1'))
    s.put(ticket('T2', { ended: { at: iso(4), by: 'executor', outcome: 'completed' } }), ended, signalTrigger('trigger-T2'))
    s.put(ticket('T3', { ended: { at: iso(4), by: 'human', outcome: 'stopped' } }), ended, signalTrigger('trigger-T3'))
    s.put(ticket('T4', { ended: { at: iso(4), by: 'executor', outcome: 'merged' }, follows: [{ thread: 'github:12', own: true }] }), ended, signalTrigger('trigger-T4'))
    s.round(at(5))
    expect(s.sent.map(m => m.id)).toEqual(['signal:notice:T1:attention:a1', `signal:notice:T2:ended:${iso(4)}`, `signal:notice:T3:ended:${iso(4)}`, `signal:notice:T4:ended:${iso(4)}`])
    expect(s.sent.every(m => m.channel === signalChannel)).toBe(true)
    expect(s.sent[0]?.text).toBe('Question on Signal request "Fix login":\nWhich repo?\n\nQuote this message to answer.')
  })

  it('leaves a merged or closed end of a closed own pull request on a Signal request to the host', () => {
    const s = setup()
    started(s)
    const closedPull = (outcome: 'merged' | 'closed') => [{ thread: 'github:12', own: true, closed: { at: iso(3), outcome } }]
    s.put(ticket('T1', { ended: { at: iso(4), by: 'executor', outcome: 'merged' }, follows: closedPull('merged') }), ended, signalTrigger('trigger-T1'))
    s.put(ticket('T2', { ended: { at: iso(4), by: 'executor', outcome: 'closed' }, follows: closedPull('closed') }), ended, signalTrigger('trigger-T2'))
    s.round(at(5))
    expect(s.sent).toEqual([])
    s.put(ticket('T3', { ended: { at: iso(4), by: 'executor', outcome: 'merged' }, follows: closedPull('merged') }), ended)
    s.round(at(6))
    expect(s.sent.map(m => m.id)).toEqual([`signal:notice:T3:ended:${iso(4)}`])
  })

  it('leaves the end to the host when the only closed pull request is one the ticket only follows', () => {
    const s = setup()
    started(s)
    const follows = [{ thread: 'github:o/r#7', own: false, closed: { at: iso(3), outcome: 'merged' as const } }]
    s.put(ticket('T1', { ended: { at: iso(4), by: 'executor', outcome: 'merged' }, follows }), ended, signalTrigger('trigger-T1'))
    s.round(at(5))
    expect(s.sent).toEqual([])
  })

  it('announces a Signal end whose closed follow is no pull request', () => {
    const s = setup()
    started(s)
    const follows = [{ thread: 'github:ci:main', own: true, closed: { at: iso(3), outcome: 'closed' as const } }, { thread: 'linear:ENG-1', own: false, closed: { at: iso(3), outcome: 'closed' as const } }]
    s.put(ticket('T1', { ended: { at: iso(4), by: 'executor', outcome: 'closed' }, follows }), ended, signalTrigger('trigger-T1'))
    s.round(at(5))
    expect(s.sent.map(m => m.id)).toEqual([`signal:notice:T1:ended:${iso(4)}`])
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

  it('skips what the host does not offer', () => {
    const s = setup()
    delete s.ctx.tickets.changed
    delete s.ctx.health
    expect(() => s.round(T0)).not.toThrow()
    expect(s.sent).toEqual([])
  })
})
