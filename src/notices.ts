import { HEALTH, SOURCE, groupInternalId, type SignalConfig } from './config.ts'
import { ticketThreadId } from './intake.ts'
import { KEYS, type NotifiedRecord } from './state.ts'
import type { ChannelRef, SourceContext, Ticket, TicketChange, TicketCursor, Trigger } from './types.ts'

export const NOTICE_INTERVAL_MS = 5000
export const HOST_HEALTH_ENTRIES: readonly string[] = ['reply', 'relay', 'assessment', 'notice', 'runtime', 'evals', 'models', 'worker', 'launch', 'delivery', 'archive', HEALTH]
const DETAIL_MAX = 300
const PAGE = 100
const KEPT_KEYS = 20

export interface NoticeCounts { posted: number }
export type NoticeKind = 'question' | 'blocked' | 'failed' | 'ended'
type HealthRecord = { state: 'error'; since: string; notified: boolean } | { state: 'ok' }

const ENDED_WORDS: Record<NonNullable<Ticket['ended']>['outcome'], string> = {
  completed: 'is done',
  merged: 'is merged',
  closed: 'was closed without merging',
  dropped: 'was dropped: nothing to do',
  stopped: 'was stopped by a person',
}

function latestReport(ticket: Ticket) {
  let latest: { summary: string; at: string } | undefined
  for (const { report } of ticket.assignments) if (report && (!latest || report.at > latest.at)) latest = report
  return latest
}

export function transitionOf(change: TicketChange): { key: string; kind: NoticeKind } | undefined {
  const { ticket, stage } = change
  if (stage.stage === 'person' && stage.action === 'answer') return ticket.attention ? { key: `attention:${ticket.attention.id}`, kind: 'question' } : undefined
  if (stage.stage === 'person' && (stage.action === 'blocked' || stage.action === 'failed')) {
    const report = latestReport(ticket)
    return report ? { key: `${stage.action}:${report.at}`, kind: stage.action } : undefined
  }
  if (stage.stage === 'ended' && ticket.ended) return { key: `ended:${ticket.ended.at}`, kind: 'ended' }
  return undefined
}

export function originLabel(trigger: Trigger | undefined): string {
  if (!trigger) return 'Ticket'
  switch (trigger.source) {
    case 'linear': return typeof trigger.meta.identifier === 'string' ? `Linear ${trigger.meta.identifier}` : 'Linear'
    case 'github': return trigger.url ? `GitHub ${trigger.url}` : 'GitHub'
    case 'signal': return 'Signal request'
    case 'feishu': return 'Feishu'
    default: return trigger.source
  }
}

export function noticeText(kind: NoticeKind, ticket: Ticket, origin: string, pull?: string): string {
  const subject = `${origin} "${ticket.title}"`
  const answer = '\n\nQuote this message to answer.'
  switch (kind) {
    case 'question': return `Question on ${subject}:\n${ticket.attention?.question ?? ''}${answer}`
    case 'blocked': return `${subject} is blocked:\n${latestReport(ticket)?.summary ?? ''}${answer}`
    case 'failed': return `${subject} failed:\n${latestReport(ticket)?.summary ?? ''}${answer}`
    case 'ended': return `${subject} ${ticket.ended ? ENDED_WORDS[ticket.ended.outcome] : 'ended'}${pull ? `: ${pull}` : ''}.\n\nQuote this message to follow up.`
  }
}

export function noticeRound(ctx: SourceContext, config: SignalConfig, now: Date, counts: NoticeCounts): void {
  const group = groupInternalId(config.groupId)
  if (group === undefined) return
  if (config.notifyTickets && ctx.tickets.changed) ticketRound(ctx, ctx.tickets.changed, group, now, counts)
  if (config.notifyHealth && ctx.health) healthRound(ctx, ctx.health(), group, config.healthGraceSeconds, now, counts)
}

type Changed = NonNullable<SourceContext['tickets']['changed']>

function ticketRound(ctx: SourceContext, changed: Changed, group: string, now: Date, counts: NoticeCounts): void {
  const stored = ctx.state.get<TicketCursor>(KEYS.ticketCursor)
  if (!stored) {
    ctx.state.set<TicketCursor>(KEYS.ticketCursor, { at: now.toISOString(), id: '' })
    return
  }
  // Re-read the whole last millisecond: a ticket with a smaller id may have been written there after the last read.
  let cursor: TicketCursor = { at: stored.at, id: '' }
  for (;;) {
    const page = changed(cursor, PAGE)
    for (const change of page.items) announce(ctx, change, group, counts)
    cursor = page.next
    ctx.state.set(KEYS.ticketCursor, cursor)
    if (page.items.length < PAGE) return
  }
}

function announce(ctx: SourceContext, change: TicketChange, group: string, counts: NoticeCounts): void {
  const transition = transitionOf(change)
  if (!transition) return
  const { ticket } = change
  const trigger = ctx.triggers.get(ticket.origin.triggerId)
  const fromSignal = trigger?.source === SOURCE
  if (fromSignal && transition.kind === 'ended' && hostPostsEnd(ticket)) return
  const record = ctx.state.get<NotifiedRecord>(KEYS.notified(ticket.id)) ?? { keys: [] }
  if (record.keys.includes(transition.key)) return
  const channel: ChannelRef = fromSignal && trigger.channel
    ? trigger.channel
    : { source: SOURCE, thread: `${SOURCE}:${ticketThreadId(group, ticket.id)}`, address: { group } }
  const text = noticeText(transition.kind, ticket, originLabel(trigger), transition.kind === 'ended' ? pullOf(ctx, ticket) : undefined)
  ctx.notify({ id: `signal:notice:${ticket.id}:${transition.key}`, channel, text, kind: 'notice', ticketId: ticket.id })
  counts.posted++
  const ended = ticket.ended?.at ?? record.ended
  ctx.state.set<NotifiedRecord>(KEYS.notified(ticket.id), { keys: [...record.keys, transition.key].slice(-KEPT_KEYS), ...ended ? { ended } : {} })
}

// The host posts merged and closed ends of a closed own pull request on the request's channel itself.
function hostPostsEnd(ticket: Ticket): boolean {
  const outcome = ticket.ended?.outcome
  return (outcome === 'merged' || outcome === 'closed') && (ticket.follows ?? []).some(follow => follow.own && follow.closed)
}

const capped = (detail: string) => detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX - 1)}…` : detail

function pullOf(ctx: SourceContext, ticket: Ticket): string | undefined {
  const own = ticket.follows?.find(follow => follow.own)
  const url = own ? ctx.threads.get(own.thread)?.meta.url : undefined
  return typeof url === 'string' ? url : undefined
}

function healthRound(ctx: SourceContext, entries: ReturnType<NonNullable<SourceContext['health']>>, group: string, graceSeconds: number, now: Date, counts: NoticeCounts): void {
  const channel: ChannelRef = { source: SOURCE, thread: `${SOURCE}:${group}:health`, address: { group } }
  const post = (id: string, text: string) => { ctx.notify({ id, channel, text, kind: 'notice' }); counts.posted++ }
  for (const [entry, health] of Object.entries(entries)) {
    if (HOST_HEALTH_ENTRIES.includes(entry)) continue
    const key = KEYS.health(entry)
    let record = ctx.state.get<HealthRecord>(key)
    if (health.state === 'error') {
      if (record?.state !== 'error') {
        record = { state: 'error', since: now.toISOString(), notified: false }
        ctx.state.set(key, record)
      }
      if (!record.notified && now.getTime() - Date.parse(record.since) >= graceSeconds * 1000) {
        post(`signal:health:${entry}:error:${record.since}`, `dsh: ${entry} is failing: ${capped(health.detail)}`)
        ctx.state.set<HealthRecord>(key, { ...record, notified: true })
      }
    } else if (health.state === 'ready' && record?.state === 'error') {
      if (record.notified) post(`signal:health:${entry}:ok:${record.since}`, `dsh: ${entry} works again.`)
      ctx.state.set<HealthRecord>(key, { state: 'ok' })
    }
  }
}
