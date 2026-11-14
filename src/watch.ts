import { HEALTH, SOURCE, SignalConfigSchema, groupInternalId, type SignalConfig } from './config.ts'
import { HubError, type HubClient } from './hub.ts'
import { type IntakeCounts, type IntakeLog, consoleLog, pollSignal } from './intake.ts'
import { NOTICE_INTERVAL_MS, type NoticeCounts, noticeRound } from './notices.ts'
import type { Health, SourceContext } from './types.ts'

export const RETRY_MS = 5000
export const EMPTY_POLL_PAUSE_MS = 1000

export interface WatchOptions { now?: () => Date; log?: IntakeLog; retryMs?: number; noticeMs?: number; emptyPauseMs?: number }

type Settings = { ok: true; config: SignalConfig } | { ok: false; health: Health }

function missingMembers(ctx: SourceContext): string[] {
  const missing: string[] = []
  if (!ctx.admits) missing.push('admits')
  if (!ctx.health) missing.push('health')
  if (!ctx.tickets.changed) missing.push('tickets.changed')
  if (!ctx.tickets.attachThread) missing.push('tickets.attachThread')
  return missing
}

function settingsOf(ctx: SourceContext): Settings {
  const raw = ctx.config<SignalConfig>(SOURCE)
  if (!raw) return { ok: false, health: { state: 'paused', detail: 'Off' } }
  const parsed = SignalConfigSchema.safeParse(raw)
  if (!parsed.success || !parsed.data.hubUrl || !parsed.data.tokenFile || groupInternalId(parsed.data.groupId) === undefined) {
    return { ok: false, health: { state: 'paused', detail: 'Set the hub URL, token file and group id' } }
  }
  return { ok: true, config: parsed.data }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

// Only hub errors are known to carry no message text; anything else is named, not quoted.
export function errorDetail(error: unknown): string {
  if (error instanceof HubError) return error.status > 0 ? `${error.message} (${error.status})` : error.message
  return error instanceof Error ? error.name : typeof error
}

export async function watchSignal(ctx: SourceContext, hub: Pick<HubClient, 'pull'>, signal: AbortSignal, options: WatchOptions = {}): Promise<void> {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? consoleLog
  const retryMs = options.retryMs ?? RETRY_MS
  const noticeMs = options.noticeMs ?? NOTICE_INTERVAL_MS
  const emptyPauseMs = options.emptyPauseMs ?? EMPTY_POLL_PAUSE_MS
  let last = ''
  const report = (health: Health, same = `${health.state}: ${health.detail}`) => {
    ctx.report(HEALTH, { ...health, at: now().toISOString() })
    if (same !== last) { last = same; log.info(`${health.state}: ${health.detail}`) }
  }

  await ctx.ready
  if (!ctx.configured()) { report({ state: 'paused', detail: 'Waiting for the deployment check' }); return }
  const missing = missingMembers(ctx)
  if (missing.length) {
    report({ state: 'error', detail: `This dsh-superagent version lacks ${missing.join(', ')}; the Signal Source needs dsh-superagent 0.3.0 or later` })
    return
  }

  const counts: IntakeCounts = { taken: 0, refused: 0, ignored: 0, missed: 0 }
  const notices: NoticeCounts = { posted: 0 }

  const intake = async () => {
    let failures = 0
    let refused = false
    while (!signal.aborted) {
      let pause = 0
      try {
        const settings = settingsOf(ctx)
        if (!settings.ok) {
          failures = 0
          refused = false
          report(settings.health)
          await sleep(retryMs, signal)
          continue
        }
        const before = counts.taken + counts.refused + counts.ignored
        await pollSignal(ctx, hub, settings.config, signal, counts, { now, log })
        failures = 0
        refused = false
        if (settings.config.pollWaitSeconds === 0 && counts.taken + counts.refused + counts.ignored === before) pause = emptyPauseMs
        const missed = counts.missed ? `; ${counts.missed} older than the hub's replay limit were skipped` : ''
        const reset = counts.reset ? `; the hub's log was reset at ${counts.reset}` : ''
        report({ state: 'ready',
          detail: `${counts.taken} taken in, ${counts.refused} from people not on the list, ${counts.ignored} ignored, ${notices.posted} notices${missed}${reset}` },
        'ready')
      } catch (error) {
        if (signal.aborted) return
        failures++
        const detail = errorDetail(error)
        if (failures === 1) log.warn(`poll failed: ${detail}`)
        const unauthorized = error instanceof HubError && error.status === 401
        if (unauthorized) report({ state: 'error', detail: 'The hub refused the token (401)' })
        // Replace a stale 401 detail at once instead of waiting for the third failure.
        else if (failures >= 3 || refused) report({ state: 'error', detail: `${failures} failed polls in a row; last: ${detail}` }, `error: polls: ${detail}`)
        refused = unauthorized
        pause = retryMs
      }
      if (pause) await sleep(pause, signal)
    }
  }

  const notify = async () => {
    while (!signal.aborted) {
      try {
        const settings = settingsOf(ctx)
        if (settings.ok) noticeRound(ctx, settings.config, now(), notices)
      } catch (error) {
        // Only the error's name: host errors may quote ticket or message text.
        log.warn(`notice round failed: ${error instanceof Error ? error.name : typeof error}`)
      }
      await sleep(noticeMs, signal)
    }
  }

  await Promise.all([intake(), notify()])
}
