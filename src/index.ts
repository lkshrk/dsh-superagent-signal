import { signalKind } from './kind.ts'
import type { SourceContext, SourceHost } from './types.ts'

interface PluginContext {
  orchestrator: SourceHost
  effect(execute: () => (() => unknown) | void, label?: string): unknown
}

export const name = 'dsh-superagent-signal'
export const inject = ['orchestrator']
export function apply(ctx: PluginContext): void {
  let source: SourceContext | undefined
  const kind = signalKind({ send: async () => 'gone', context: () => source })
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'signal: source kind')
  ctx.effect(() => { source = ctx.orchestrator.context(kind); return () => { source = undefined } })
}
export { SignalConfigSchema, groupInternalId, type SignalConfig } from './config.ts'
export { signalKind, type KindDeps } from './kind.ts'
