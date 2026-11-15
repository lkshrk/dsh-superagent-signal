import type { SourceContext } from './types.ts'

export const MAP_HORIZON_MS = 14 * 24 * 3600_000
export const PRUNE_INTERVAL_MS = 3600_000

const PREFIX = { map: 'signal-map:', sent: 'signal-sent:', notified: 'signal-notified:' }

export const KEYS = {
  cursor: 'signal-cursor',
  map: (timestamp: number) => `${PREFIX.map}${timestamp}`,
  sent: (messageId: string) => `${PREFIX.sent}${messageId}`,
  notified: (ticketId: string) => `${PREFIX.notified}${ticketId}`,
  ticketCursor: 'signal-ticket-cursor',
  batch: 'signal-batch',
  health: (entry: string) => `signal-health:${entry}`,
  pruned: 'signal-pruned',
}

export interface MapEntry { thread: string; ticketId?: string; at: string }
export interface SentRecord { timestamps: number[]; at: string }
export interface NotifiedRecord { keys: string[]; ended?: string }

const expired = (at: string | undefined, now: Date) => {
  const time = at === undefined ? Number.NaN : Date.parse(at)
  return Number.isNaN(time) || now.getTime() - time > MAP_HORIZON_MS
}

export function remember(ctx: SourceContext, timestamp: number, entry: MapEntry): void {
  ctx.state.set(KEYS.map(timestamp), entry)
}

export function lookup(ctx: SourceContext, timestamp: number, now: Date = new Date()): MapEntry | undefined {
  const entry = ctx.state.get<MapEntry>(KEYS.map(timestamp))
  return entry && !expired(entry.at, now) ? entry : undefined
}

export function prune(ctx: SourceContext, now: Date): number {
  const last = ctx.state.get<string>(KEYS.pruned)
  if (last !== undefined && now.getTime() - Date.parse(last) < PRUNE_INTERVAL_MS) return 0
  let removed = 0
  const drop = (key: string) => { ctx.state.set(key, undefined); removed++ }
  for (const key of ctx.state.keys(PREFIX.map)) if (expired(ctx.state.get<MapEntry>(key)?.at, now)) drop(key)
  for (const key of ctx.state.keys(PREFIX.sent)) if (expired(ctx.state.get<SentRecord>(key)?.at, now)) drop(key)
  for (const key of ctx.state.keys(PREFIX.notified)) {
    const record = ctx.state.get<NotifiedRecord>(key)
    const ticket = ctx.tickets.get(key.slice(PREFIX.notified.length))
    const endedLongAgo = record?.ended !== undefined && expired(record.ended, now)
    if (!ticket || endedLongAgo) drop(key)
  }
  ctx.state.set(KEYS.pruned, now.toISOString())
  return removed
}
