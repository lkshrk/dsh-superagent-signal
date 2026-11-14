import { sendSignal } from './channel.ts'
import { HEALTH, SOURCE, SignalConfigSchema, type SignalConfig } from './config.ts'
import { HubClient } from './hub.ts'
import { signalKind } from './kind.ts'
import type { SourceContext, SourceHost } from './types.ts'
import { watchSignal } from './watch.ts'

interface PluginContext {
  orchestrator: SourceHost
  effect(execute: () => (() => unknown) | void, label?: string): unknown
}

export const name = 'dsh-superagent-signal'
export const inject = ['orchestrator']
export function apply(ctx: PluginContext): void {
  const orchestrator = ctx.orchestrator
  let source: SourceContext | undefined
  const config = () => {
    const current = source?.config<SignalConfig>(SOURCE)
    if (!current) throw new Error('The Signal Source is off')
    return SignalConfigSchema.parse(current)
  }
  const hub = new HubClient(() => {
    const { hubUrl, tokenFile } = config()
    return { url: hubUrl, tokenFile }
  })
  const kind = signalKind({ send: m => sendSignal(source!, hub, m), context: () => source, hub: () => hub })
  ctx.effect(() => orchestrator.sources.register(kind), 'signal: source kind')
  ctx.effect(() => {
    const context = source = orchestrator.context(kind)
    const controller = new AbortController()
    // DSH ends its process on an unhandled rejection, so a failure that escapes the loops becomes the Source's health.
    const running = watchSignal(context, hub, controller.signal)
      .catch((error: unknown) => { context.report(HEALTH, { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running; source = undefined }
  })
}
export { SignalConfigSchema, groupInternalId, type SignalConfig } from './config.ts'
export { HubClient, HubError } from './hub.ts'
export { signalKind, type KindDeps } from './kind.ts'
export { watchSignal } from './watch.ts'
