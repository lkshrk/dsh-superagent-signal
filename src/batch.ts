import { createHash } from 'node:crypto'
import { SOURCE, type SignalConfig } from './config.ts'
import { ENDED_WORDS, type Outcome, linearIdentifier, originLabel, pullOf, quotedTitle, subject } from './labels.ts'
import { KEYS, type NotifiedRecord } from './state.ts'
import type { ChannelRef, SourceContext, TicketChange, TicketStage } from './types.ts'

export interface BatchTicket {
  id: string
  origin: string
  title: string
  issue?: string
  parent?: string
  epic?: string
  started?: string
  announced?: true
  ended?: { at: string; seen: string; outcome: Outcome; pull?: string }
  reported?: true
}
export interface Batch { id: string; tickets: BatchTicket[]; lastStart?: string; lastEnd?: string }

const PARENT_LINE = /^Parent: (\S+) /

export function hasStarted(stage: TicketStage): boolean {
  return stage.stage !== 'ended' && !(stage.stage === 'working' && stage.action === 'queued')
}

export function loadBatch(ctx: SourceContext): Batch | undefined {
  const stored = ctx.state.get<Batch>(KEYS.batch)
  return stored && structuredClone(stored)
}

export function observe(ctx: SourceContext, batch: Batch | undefined, change: TicketChange, now: Date): Batch | undefined {
  const { ticket, stage } = change
  const end = stage.stage === 'ended' ? ticket.ended : undefined
  let entry = batch?.tickets.find(t => t.id === ticket.id)
  if (end) {
    if (entry?.ended?.at === end.at || (!entry && ctx.state.get<NotifiedRecord>(KEYS.notified(ticket.id))?.ended === end.at)) return batch
  } else {
    if (entry?.ended) { delete entry.ended; delete entry.reported }
    if (!hasStarted(stage) || entry?.started) return batch
  }
  const seen = now.toISOString()
  batch ??= { id: seen, tickets: [] }
  if (!entry) {
    const trigger = ctx.triggers.get(ticket.origin.triggerId)
    const { issue, parent } = trigger?.meta ?? {}
    const epic = typeof parent === 'string' ? PARENT_LINE.exec(trigger?.text ?? '')?.[1] : undefined
    entry = { id: ticket.id, origin: originLabel(trigger), title: ticket.title,
      ...typeof issue === 'string' ? { issue } : {}, ...typeof parent === 'string' ? { parent } : {}, ...epic ? { epic } : {} }
    batch.tickets.push(entry)
  }
  if (end) {
    const pull = pullOf(ctx, ticket)
    entry.title = ticket.title
    entry.ended = { at: end.at, seen, outcome: end.outcome, ...pull ? { pull } : {} }
    delete entry.reported
    batch.lastEnd = seen
  } else {
    entry.started = seen
    batch.lastStart = seen
  }
  return batch
}

const plural = (n: number) => `${n} ticket${n === 1 ? '' : 's'}`
const named = (t: BatchTicket) => subject(t.title, t.origin)
const outcomeOf = (t: BatchTicket) => t.ended ? `${ENDED_WORDS[t.ended.outcome]}${t.ended.pull ? `: ${t.ended.pull}` : ''}` : ''
const outcomeLine = (t: BatchTicket) => t.ended ? `${named(t)} ${outcomeOf(t)}` : named(t)

function epicName(batch: Batch, parent: string): string {
  const own = batch.tickets.find(t => t.issue === parent)
  const identifier = own ? linearIdentifier(own.origin) : batch.tickets.find(t => t.parent === parent && t.epic)?.epic
  return `Epic${identifier ? ` ${identifier}` : ''}${own ? ` "${quotedTitle(own.title, own.origin)}"` : ''}`
}

function epicCount(batch: Batch, parent: string): string {
  const members = batch.tickets.filter(t => t.parent === parent)
  const succeeded = members.filter(t => t.ended?.outcome === 'merged' || t.ended?.outcome === 'completed')
  const word = succeeded.every(t => t.ended?.outcome === 'merged') ? 'merged' : 'done'
  return `${succeeded.length} of ${members.length} sub-issues ${word}`
}

function grouped(batch: Batch, listed: BatchTicket[], line: (t: BatchTicket) => string, header: (parent: string, own?: BatchTicket) => string): string[] {
  const groupOf = (t: BatchTicket) => t.parent ?? (t.issue !== undefined && batch.tickets.some(m => m.parent === t.issue) ? t.issue : undefined)
  const lines: string[] = []
  const shown = new Set<string>()
  for (const t of listed) {
    const parent = groupOf(t)
    if (parent === undefined) { lines.push(line(t)); continue }
    if (shown.has(parent)) continue
    shown.add(parent)
    lines.push(header(parent, listed.find(m => m.issue === parent)))
    for (const member of listed) if (member.parent === parent) lines.push(`  ${line(member)}`)
  }
  return lines
}

export function startText(batch: Batch, fresh: BatchTicket[]): string {
  return [`Started: ${plural(fresh.length)}`, ...grouped(batch, fresh, named, parent => `${epicName(batch, parent)}:`)].join('\n')
}

export function summaryText(batch: Batch, listed: BatchTicket[], running: BatchTicket[]): string {
  const head = running.length
    ? `${batch.tickets.length - running.length} of ${batch.tickets.length} done, still running: ${running.map(named).join(', ')}`
    : `Finished: ${plural(batch.tickets.length)}`
  const header = (parent: string, own?: BatchTicket) => own?.ended
    ? `${epicName(batch, parent)} ${outcomeOf(own)}, ${epicCount(batch, parent)}`
    : `${epicName(batch, parent)}: ${epicCount(batch, parent)}`
  return [head, ...grouped(batch, listed, outcomeLine, header)].join('\n')
}

// End times join the text so a replaced end with the same wording still gets a new id.
function digest(text: string, listed: BatchTicket[]): string {
  const ends = listed.flatMap(t => t.ended ? [`${t.id}:${t.ended.at}`] : []).sort()
  return createHash('sha256').update([text, ...ends].join('\n')).digest('hex').slice(0, 12)
}

export function flushBatch(ctx: SourceContext, config: SignalConfig, group: string, now: Date): number {
  const batch = loadBatch(ctx)
  if (!batch) return 0
  const kept = batch.tickets.filter(t => t.ended || ctx.tickets.get(t.id))
  if (kept.length < batch.tickets.length) {
    batch.tickets = kept
    ctx.state.set(KEYS.batch, kept.length ? batch : undefined)
    if (!kept.length) return 0
  }
  const channel: ChannelRef = { source: SOURCE, thread: `${SOURCE}:${group}:batch`, address: { group } }
  const since = (at: string | undefined) => at === undefined ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(at)
  const settled = (at: string | undefined) => since(at) >= config.batchSettleSeconds * 1000
  let posted = 0
  const post = (kind: 'start' | 'summary', listed: BatchTicket[], text: string) => {
    ctx.notify({ id: `signal:batch:${batch.id}:${kind}:${digest(text, kind === 'summary' ? listed : [])}`, channel, text, kind: 'notice' })
    posted++
  }

  const fresh = batch.tickets.filter(t => t.started && !t.announced && !t.ended)
  if (fresh.length && settled(batch.lastStart)) {
    post('start', fresh, startText(batch, fresh))
    for (const t of fresh) t.announced = true
    ctx.state.set(KEYS.batch, batch)
  }

  const running = batch.tickets.filter(t => !t.ended)
  if (!running.length && settled(batch.lastEnd)) {
    post('summary', batch.tickets, summaryText(batch, batch.tickets, running))
    for (const t of batch.tickets) {
      const record = ctx.state.get<NotifiedRecord>(KEYS.notified(t.id)) ?? { keys: [] }
      ctx.state.set<NotifiedRecord>(KEYS.notified(t.id), { ...record, ...t.ended ? { ended: t.ended.at } : {} })
    }
    ctx.state.set(KEYS.batch, undefined)
    return posted
  }

  const unreported = batch.tickets.filter(t => t.ended && !t.reported)
  const oldest = unreported.map(t => t.ended?.seen ?? '').sort()[0]
  if (running.length && unreported.length && since(oldest) >= config.batchMaxHours * 3600_000) {
    post('summary', unreported, summaryText(batch, unreported, running))
    for (const t of unreported) t.reported = true
    ctx.state.set(KEYS.batch, batch)
  }
  return posted
}
