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
export interface Batch { id: string; tickets: BatchTicket[]; starts: number; summaries: number; lastStart?: string; lastEnd?: string }

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
  if (!end && !hasStarted(stage)) return batch
  let entry = batch?.tickets.find(t => t.id === ticket.id)
  if (end ? entry?.ended || (!entry && ctx.state.get<NotifiedRecord>(KEYS.notified(ticket.id))?.ended === end.at) : entry) return batch
  const seen = now.toISOString()
  batch ??= { id: seen, tickets: [], starts: 0, summaries: 0 }
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
    batch.lastEnd = seen
  } else {
    entry.started = seen
    batch.lastStart = seen
  }
  return batch
}

const plural = (n: number) => `${n} ticket${n === 1 ? '' : 's'}`
const named = (t: BatchTicket) => subject(t.title, t.origin)
const outcomeLine = (t: BatchTicket) => t.ended ? `${named(t)} ${ENDED_WORDS[t.ended.outcome]}${t.ended.pull ? `: ${t.ended.pull}` : ''}` : named(t)

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

function grouped(listed: BatchTicket[], line: (t: BatchTicket) => string, header: (parent: string) => string): string[] {
  const lines: string[] = []
  const shown = new Set<string>()
  for (const t of listed) {
    if (t.parent === undefined) { lines.push(line(t)); continue }
    if (shown.has(t.parent)) continue
    shown.add(t.parent)
    lines.push(header(t.parent))
    for (const member of listed) if (member.parent === t.parent) lines.push(`  ${line(member)}`)
  }
  return lines
}

export function startText(batch: Batch, fresh: BatchTicket[]): string {
  return [`Started: ${plural(fresh.length)}`, ...grouped(fresh, named, parent => `${epicName(batch, parent)}:`)].join('\n')
}

export function summaryText(batch: Batch, listed: BatchTicket[], running: BatchTicket[]): string {
  const head = running.length
    ? `${batch.tickets.length - running.length} of ${batch.tickets.length} done, still running: ${running.map(named).join(', ')}`
    : `Finished: ${plural(batch.tickets.length)}`
  return [head, ...grouped(listed, outcomeLine, parent => `${epicName(batch, parent)}: ${epicCount(batch, parent)}`)].join('\n')
}

export function flushBatch(ctx: SourceContext, config: SignalConfig, group: string, now: Date): number {
  const batch = loadBatch(ctx)
  if (!batch) return 0
  const channel: ChannelRef = { source: SOURCE, thread: `${SOURCE}:${group}:batch`, address: { group } }
  const since = (at: string | undefined) => at === undefined ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(at)
  const settled = (at: string | undefined) => since(at) >= config.batchSettleSeconds * 1000
  let posted = 0
  const post = (part: string, text: string) => { ctx.notify({ id: `signal:batch:${batch.id}:${part}`, channel, text, kind: 'notice' }); posted++ }

  const fresh = batch.tickets.filter(t => t.started && !t.announced && !t.ended)
  if (fresh.length && settled(batch.lastStart)) {
    batch.starts++
    post(`start:${batch.starts}`, startText(batch, fresh))
    for (const t of fresh) t.announced = true
    ctx.state.set(KEYS.batch, batch)
  }

  const running = batch.tickets.filter(t => !t.ended)
  if (!running.length && settled(batch.lastEnd)) {
    batch.summaries++
    post(`summary:${batch.summaries}`, summaryText(batch, batch.tickets, running))
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
    batch.summaries++
    post(`summary:${batch.summaries}`, summaryText(batch, unreported, running))
    for (const t of unreported) t.reported = true
    ctx.state.set(KEYS.batch, batch)
  }
  return posted
}
