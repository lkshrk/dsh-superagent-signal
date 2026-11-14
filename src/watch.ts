import { HEALTH, SOURCE, SignalConfigSchema, groupInternalId, type SignalConfig } from './config.ts'
import { HubError, type HubClient } from './hub.ts'
import { type IntakeCounts, type IntakeLog, consoleLog, pollSignal } from './intake.ts'
import { NOTICE_INTERVAL_MS, type NoticeCounts, noticeRound } from './notices.ts'
import type { Health, SourceContext } from './types.ts'

export const RETRY_MS = 5000

export interface WatchOptions { now?: () => Date; log?: IntakeLog; retryMs?: number; noticeMs?: number }

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

const describe = (error: unknown) => error instanceof HubError && error.status > 0
  ? `${error.message} (${error.status})`
  : error instanceof Error ? error.message : String(error)

export async function watchSignal(ctx: SourceContext, hub: Pick<HubClient, 'pull'>, signal: AbortSignal, options: WatchOptions = {}): Promise<void> {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? consoleLog
  const retryMs = options.retryMs ?? RETRY_MS
  const noticeMs = options.noticeMs ?? NOTICE_INTERVAL_MS
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
    while (!signal.aborted) {
      const settings = settingsOf(ctx)
      if (!settings.ok) {
        report(settings.health)
        await sleep(retryMs, signal)
        continue
      }
      try {
        await pollSignal(ctx, hub, settings.config, signal, counts, { now, log })
        failures = 0
        const missed = counts.missed ? `; ${counts.missed} older than the hub's replay limit were skipped` : ''
        const reset = counts.reset ? `; the hub's log was reset at ${counts.reset}` : ''
        report({ state: 'ready',
          detail: `${counts.taken} taken in, ${counts.refused} from people not on the list, ${counts.ignored} ignored, ${notices.posted} notices${missed}${reset}` },
        'ready')
      } catch (error) {
        if (signal.aborted) return
        failures++
        const detail = describe(error)
        if (failures === 1) log.warn(`poll failed: ${detail}`)
        if (error instanceof HubError && error.status === 401) report({ state: 'error', detail: 'The hub refused the token (401)' })
        else if (failures >= 3) report({ state: 'error', detail: `${failures} failed polls in a row; last: ${detail}` }, `error: polls: ${detail}`)
        await sleep(retryMs, signal)
      }
    }
  }

  const notify = async () => {
    while (!signal.aborted) {
      const settings = settingsOf(ctx)
      if (settings.ok) {
        try {
          noticeRound(ctx, settings.config, now(), notices)
        } catch (error) {
          // Only the error's name: host errors may quote ticket or message text.
          log.warn(`notice round failed: ${error instanceof Error ? error.name : typeof error}`)
        }
      }
      await sleep(noticeMs, signal)
    }
  }

  await Promise.all([intake(), notify()])
}
