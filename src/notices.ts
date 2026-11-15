import { type Batch, flushBatch, loadBatch, observe } from './batch.ts'
import { HEALTH, SOURCE, groupInternalId, type SignalConfig } from './config.ts'
import { ticketThreadId } from './intake.ts'
import { originLabel, subject } from './labels.ts'
import { KEYS, type NotifiedRecord } from './state.ts'
import type { ChannelRef, SourceContext, Ticket, TicketChange, TicketCursor } from './types.ts'

export const NOTICE_INTERVAL_MS = 5000
export const HOST_HEALTH_ENTRIES: readonly string[] = ['reply', 'relay', 'assessment', 'notice', 'runtime', 'evals', 'models', 'worker', 'launch', 'delivery', 'archive', HEALTH]
const DETAIL_MAX = 300
const PAGE = 100
const KEPT_KEYS = 20

export interface NoticeCounts { posted: number }
export type NoticeKind = 'question' | 'blocked' | 'failed'
type HealthRecord = { state: 'error'; since: string; notified: boolean } | { state: 'ok' }

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
  return undefined
}

export function noticeText(kind: NoticeKind, ticket: Ticket, origin: string): string {
  const about = subject(ticket.title, origin)
  const answer = '\n\nQuote this message to answer.'
  switch (kind) {
    case 'question': return `Question on ${about}:\n${ticket.attention?.question ?? ''}${answer}`
    case 'blocked': return `${about} is blocked:\n${latestReport(ticket)?.summary ?? ''}${answer}`
    case 'failed': return `${about} failed:\n${latestReport(ticket)?.summary ?? ''}${answer}`
  }
}

export function noticeRound(ctx: SourceContext, config: SignalConfig, now: Date, counts: NoticeCounts): void {
  const group = groupInternalId(config.groupId)
  if (group === undefined) return
  if (ctx.tickets.changed && ticketRound(ctx, ctx.tickets.changed, config, group, now, counts) && config.notifyProgress) counts.posted += flushBatch(ctx, config, group, now)
  if (config.notifyHealth && ctx.health) healthRound(ctx, ctx.health(), group, config.healthGraceSeconds, now, counts)
}

type Changed = NonNullable<SourceContext['tickets']['changed']>

function ticketRound(ctx: SourceContext, changed: Changed, config: SignalConfig, group: string, now: Date, counts: NoticeCounts): boolean {
  const stored = ctx.state.get<TicketCursor>(KEYS.ticketCursor)
  if (!stored) {
    ctx.state.set<TicketCursor>(KEYS.ticketCursor, { at: now.toISOString(), id: '' })
    return false
  }
  const offUntil = ctx.state.get<string>(KEYS.progressOff)
  let batch: Batch | undefined
  if (config.notifyProgress) batch = loadBatch(ctx)
  else if (ctx.state.get(KEYS.batch) !== undefined) ctx.state.set(KEYS.batch, undefined)
  // Re-read the whole last millisecond: a ticket with a smaller id may have been written there after the last read.
  let cursor: TicketCursor = { at: stored.at, id: '' }
  for (;;) {
    const page = changed(cursor, PAGE)
    for (const change of page.items) {
      if (config.notifyTickets) announce(ctx, change, group, counts)
      // Changes up to offUntil were read with digests off and must not start a batch.
      if (!config.notifyProgress) markEnded(ctx, change)
      else if (!(offUntil !== undefined && change.ticket.updatedAt <= offUntil)) batch = observe(ctx, batch, change, now)
    }
    if (batch) ctx.state.set(KEYS.batch, batch)
    cursor = page.next
    ctx.state.set(KEYS.ticketCursor, cursor)
    if (page.items.length < PAGE) {
      const until = config.notifyProgress ? (offUntil !== undefined && cursor.at > offUntil ? undefined : offUntil) : cursor.at
      if (until !== offUntil) ctx.state.set(KEYS.progressOff, until)
      return true
    }
  }
}

// Without digests no summary records the end, which prune needs to drop the record.
function markEnded(ctx: SourceContext, { ticket, stage }: TicketChange): void {
  if (stage.stage !== 'ended' || !ticket.ended) return
  const record = ctx.state.get<NotifiedRecord>(KEYS.notified(ticket.id))
  if (record && record.ended !== ticket.ended.at) ctx.state.set<NotifiedRecord>(KEYS.notified(ticket.id), { ...record, ended: ticket.ended.at })
}

function announce(ctx: SourceContext, change: TicketChange, group: string, counts: NoticeCounts): void {
  const transition = transitionOf(change)
  if (!transition) return
  const { ticket } = change
  const record = ctx.state.get<NotifiedRecord>(KEYS.notified(ticket.id)) ?? { keys: [] }
  if (record.keys.includes(transition.key)) return
  const trigger = ctx.triggers.get(ticket.origin.triggerId)
  const channel: ChannelRef = trigger?.source === SOURCE && trigger.channel
    ? trigger.channel
    : { source: SOURCE, thread: `${SOURCE}:${ticketThreadId(group, ticket.id)}`, address: { group } }
  ctx.notify({ id: `signal:notice:${ticket.id}:${transition.key}`, channel, text: noticeText(transition.kind, ticket, originLabel(trigger)), kind: 'notice', ticketId: ticket.id })
  counts.posted++
  ctx.state.set<NotifiedRecord>(KEYS.notified(ticket.id), { ...record, keys: [...record.keys, transition.key].slice(-KEPT_KEYS) })
}

function capped(detail: string): string {
  const points = [...detail]
  return points.length > DETAIL_MAX ? `${points.slice(0, DETAIL_MAX - 1).join('')}…` : detail
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
