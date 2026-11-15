import type { SourceContext, Ticket, Trigger } from './types.ts'

export type Outcome = NonNullable<Ticket['ended']>['outcome']

export const ENDED_WORDS: Record<Outcome, string> = {
  completed: 'is done',
  merged: 'is merged',
  closed: 'was closed without merging',
  dropped: 'was dropped: nothing to do',
  stopped: 'was stopped by a person',
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

export function linearIdentifier(origin: string): string | undefined {
  return /^Linear (\S+)$/.exec(origin)?.[1]
}

export function quotedTitle(title: string, origin: string): string {
  const identifier = linearIdentifier(origin)
  return identifier && title.startsWith(`${identifier}: `) ? title.slice(identifier.length + 2) : title
}

export function subject(title: string, origin: string): string {
  return `${origin} "${quotedTitle(title, origin)}"`
}

export function pullOf(ctx: SourceContext, ticket: Ticket): string | undefined {
  const own = ticket.follows?.find(follow => follow.own)
  const url = own ? ctx.threads.get(own.thread)?.meta.url : undefined
  return typeof url === 'string' ? url : undefined
}
