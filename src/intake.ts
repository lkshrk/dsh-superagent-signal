import { attachmentLine } from './attachments.ts'
import { SOURCE, groupInternalId, type SignalConfig } from './config.ts'
import type { HubClient, HubMessage } from './hub.ts'
import { KEYS, type MapEntry, lookup, prune, remember } from './state.ts'
import type { SourceContext, Trigger } from './types.ts'

export const threadId = (group: string, timestamp: number) => `${group}:${timestamp}`
export const ticketThreadId = (group: string, ticketId: string) => `${group}:ticket:${ticketId}`
export const triggerId = (actor: string, timestamp: number) => `signal:${actor}:${timestamp}`

export interface IntakeCounts { taken: number; refused: number; ignored: number; missed: number; reset?: string }
export interface IntakeLog { info(line: string): void; warn(line: string): void }
export interface IntakeOptions { now?: () => Date; log?: IntakeLog }

const PREFIX = 'dsh-superagent-signal:'
export const consoleLog: IntakeLog = { info: line => console.info(`${PREFIX} ${line}`), warn: line => console.warn(`${PREFIX} ${line}`) }

export function triggerOf(message: HubMessage, actor: string, thread: string, group: string, maxBytes: number): Trigger {
  const { timestamp, quote, attachments, sender } = message
  let text = message.kind === 'edit' ? `(edited) ${message.text}` : message.text
  if (quote && message.kind !== 'edit' && thread === threadId(group, timestamp)) text += `\n\n> quoted: ${quote.text}`
  if (attachments.length) text = [text, ...attachments.map(a => attachmentLine(a, maxBytes))].filter(part => part !== '').join('\n')
  return {
    id: triggerId(actor, timestamp),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: actor },
    human: true,
    addressed: 'direct',
    at: message.receivedAt,
    text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { group, quoteTimestamp: String(timestamp), quoteAuthor: actor } },
    meta: {
      group,
      timestamp,
      seq: message.seq,
      kind: message.kind,
      sender: { uuid: sender.uuid, number: sender.number, name: sender.name },
      ...quote ? { quote: quote.timestamp, quoteText: quote.text, quoteAuthor: quote.author.uuid || quote.author.number } : {},
      ...attachments.length ? { attachments } : {},
    },
  }
}

function admittedActor(ctx: SourceContext, sender: HubMessage['sender']): string | undefined {
  if (!ctx.admits) return undefined
  if (sender.uuid && ctx.admits({ id: sender.uuid, human: true })) return sender.uuid
  if (sender.number && ctx.admits({ id: sender.number, human: true })) return sender.number
  return undefined
}

export async function pollSignal(ctx: SourceContext, hub: Pick<HubClient, 'pull'>, config: SignalConfig, signal: AbortSignal, counts: IntakeCounts, options: IntakeOptions = {}): Promise<void> {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? consoleLog
  const group = groupInternalId(config.groupId)
  const after = ctx.state.get<number>(KEYS.cursor)
  const page = await hub.pull(after, config.pollWaitSeconds, config.pollLimit, signal)
  if (page.reset) {
    counts.reset = now().toISOString()
    log.warn(`hub log was reset; replaying from its oldest message (next ${page.next})`)
  }
  if (page.missed > 0) {
    counts.missed += page.missed
    log.warn(`hub dropped ${page.missed} messages older than its replay age before they were taken in`)
  }
  for (const message of page.messages) {
    await take(ctx, message, group, config.attachmentMaxBytes, counts, log, now())
    ctx.state.set(KEYS.cursor, message.seq)
  }
  if (page.reset || after === undefined || page.next >= after) ctx.state.set(KEYS.cursor, page.next)
  prune(ctx, now())
}

async function take(ctx: SourceContext, message: HubMessage, group: string | undefined, maxBytes: number, counts: IntakeCounts, log: IntakeLog, now: Date): Promise<void> {
  const where = `seq ${message.seq}, kind ${message.kind}, timestamp ${message.timestamp}`
  if (group === undefined || message.group?.id !== group || (message.kind !== 'message' && message.kind !== 'edit')) {
    counts.ignored++
    return
  }
  const actor = admittedActor(ctx, message.sender)
  if (actor === undefined) {
    counts.refused++
    log.info(`refused a message from ${message.sender.uuid || message.sender.number}, who is not on the list (${where})`)
    return
  }
  const thread = route(ctx, message, group, now)
  if (thread === undefined) {
    counts.ignored++
    log.info(`ignored an edit of an unknown message (${where}, edit of ${message.editOf})`)
    return
  }
  if (thread.ticketId !== undefined && thread.id === ticketThreadId(group, thread.ticketId)) attach(ctx, thread.ticketId, thread.id, log)
  if (!thread.mapped) remember(ctx, message.timestamp, { thread: thread.id, ...thread.ticketId ? { ticketId: thread.ticketId } : {}, at: now.toISOString() })
  await ctx.receive(triggerOf(message, actor, thread.id, group, maxBytes))
  counts.taken++
}

function attach(ctx: SourceContext, ticketId: string, thread: string, log: IntakeLog): void {
  try {
    ctx.tickets.attachThread?.(ticketId, { source: SOURCE, id: thread })
  } catch (error) {
    log.warn(`ticket ${ticketId} did not take thread ${thread} in: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

function route(ctx: SourceContext, message: HubMessage, group: string, now: Date): { id: string; ticketId?: string; mapped?: true } | undefined {
  const own = ctx.state.get<MapEntry>(KEYS.map(message.timestamp))
  if (own) return { id: own.thread, ticketId: own.ticketId, mapped: true }
  if (message.kind === 'edit') {
    const entry = lookup(ctx, message.editOf, now)
    return entry && { id: entry.thread, ticketId: entry.ticketId }
  }
  const entry = message.quote ? lookup(ctx, message.quote.timestamp, now) : undefined
  return entry ? { id: entry.thread, ticketId: entry.ticketId } : { id: threadId(group, message.timestamp) }
}
