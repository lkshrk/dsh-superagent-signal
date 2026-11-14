import { describe, expect, it, vi } from 'vitest'
import { HubError, type HubClient, type Pull } from '../src/hub.ts'
import type { Health } from '../src/types.ts'
import { watchSignal } from '../src/watch.ts'
import { OWNER_UUID, fakeContext, message, restA } from './fakes.ts'

const NOW = new Date('2026-11-14T12:00:00.000Z')
const settings = { hubUrl: 'http://hub', tokenFile: '/run/token', groupId: restA }

function setup(config: Record<string, unknown> | null = settings) {
  const ctx = fakeContext()
  const reports: Health[] = []
  ctx.config = (() => config ?? undefined) as typeof ctx.config
  ctx.health = () => ({})
  ctx.tickets.changed = after => ({ items: [], next: after })
  ctx.tickets.attachThread = () => {}
  ctx.report = (_entry, health) => { reports.push(health) }
  return { ctx, reports }
}

const hanging = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  signal.addEventListener('abort', () => reject(new HubError('the hub request was aborted', 0)), { once: true })
})

function hubOf(...steps: (Partial<Pull> | HubError)[]) {
  const pull = vi.fn(async (_after: number | undefined, _wait: number, _limit: number, signal: AbortSignal): Promise<Pull> => {
    const step = steps.shift()
    if (step === undefined) return hanging(signal)
    if (step instanceof HubError) throw step
    const messages = step.messages ?? []
    return { messages, next: step.next ?? messages.at(-1)?.seq ?? 0, missed: step.missed ?? 0, reset: step.reset ?? false }
  })
  return { hub: { pull } as unknown as HubClient, pull }
}

const log = () => ({ info: vi.fn(), warn: vi.fn() })
const options = { now: () => NOW, retryMs: 1, noticeMs: 10_000, log: log() }

async function watchUntil(ctx: ReturnType<typeof setup>['ctx'], hub: HubClient, done: () => boolean) {
  const controller = new AbortController()
  const running = watchSignal(ctx, hub, controller.signal, { ...options, log: log() })
  await vi.waitFor(() => { if (!done()) throw new Error('not yet') }, { timeout: 2000, interval: 5 })
  controller.abort()
  await running
}

describe('watchSignal', () => {
  it('waits for the deployment check', async () => {
    const { ctx, reports } = setup()
    ctx.configured = () => false
    const { hub, pull } = hubOf()
    await watchSignal(ctx, hub, new AbortController().signal, options)
    expect(reports).toEqual([expect.objectContaining({ state: 'paused', detail: 'Waiting for the deployment check' })])
    expect(pull).not.toHaveBeenCalled()
  })

  it('asks for the hub settings', async () => {
    const { ctx, reports } = setup({ ...settings, tokenFile: '' })
    const { hub, pull } = hubOf()
    await watchUntil(ctx, hub, () => reports.length > 0)
    expect(reports[0]).toMatchObject({ state: 'paused', detail: 'Set the hub URL, token file and group id' })
    expect(pull).not.toHaveBeenCalled()
  })

  it('asks for the hub settings when the group id is invalid', async () => {
    const { ctx, reports } = setup({ ...settings, groupId: 'not-a-group' })
    const { hub, pull } = hubOf()
    await watchUntil(ctx, hub, () => reports.length > 0)
    expect(reports[0]).toMatchObject({ state: 'paused', detail: 'Set the hub URL, token file and group id' })
    expect(pull).not.toHaveBeenCalled()
  })

  it('reports Off when the Source is switched off', async () => {
    const { ctx, reports } = setup(null)
    const { hub, pull } = hubOf()
    await watchUntil(ctx, hub, () => reports.length > 0)
    expect(reports[0]).toMatchObject({ state: 'paused', detail: 'Off' })
    expect(pull).not.toHaveBeenCalled()
  })

  it('names the missing host members', async () => {
    const { ctx, reports } = setup()
    delete ctx.tickets.changed
    delete ctx.tickets.attachThread
    const { hub, pull } = hubOf()
    await watchSignal(ctx, hub, new AbortController().signal, options)
    expect(reports).toEqual([expect.objectContaining({ state: 'error',
      detail: 'This dsh-superagent version lacks tickets.changed, tickets.attachThread; the Signal Source needs dsh-superagent 0.3.0 or later' })])
    expect(pull).not.toHaveBeenCalled()
  })

  it('reports a refused token at once', async () => {
    const { ctx, reports } = setup()
    const { hub, pull } = hubOf(new HubError('unauthorized', 401))
    await watchUntil(ctx, hub, () => reports.some(report => report.state === 'error'))
    expect(reports.find(report => report.state === 'error')).toMatchObject({ detail: 'The hub refused the token (401)' })
    expect(pull.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('turns error after three failed polls', async () => {
    const { ctx, reports } = setup()
    const bad = () => new HubError('bad gateway', 502)
    const { hub } = hubOf(bad(), bad(), bad())
    await watchUntil(ctx, hub, () => reports.some(report => report.state === 'error'))
    expect(reports.filter(report => report.state === 'error')).toEqual([expect.objectContaining({ detail: '3 failed polls in a row; last: bad gateway (502)' })])
  })

  it('reports counts, missed and reset when ready', async () => {
    const { ctx, reports } = setup()
    const stranger = { number: '+4915100000000', uuid: '00000000-0000-4000-8000-000000000000', name: 'Someone', device: 1 }
    const { hub } = hubOf({ messages: [message({ seq: 1, timestamp: 1000 }), message({ seq: 2, timestamp: 1001, sender: stranger })], missed: 2, reset: true })
    await watchUntil(ctx, hub, () => reports.some(report => report.state === 'ready'))
    expect(ctx.received.map(trigger => trigger.actor.id)).toEqual([OWNER_UUID])
    expect(reports.find(report => report.state === 'ready')).toMatchObject({
      detail: `1 taken in, 1 from people not on the list, 0 ignored, 0 notices; 2 older than the hub's replay limit were skipped; the hub's log was reset at ${NOW.toISOString()}`,
    })
  })

  it('keeps taking in when a notice round throws', async () => {
    const { ctx, reports } = setup()
    ctx.health = () => { throw new Error('boom') }
    const logger = log()
    const { hub } = hubOf({ messages: [message({ seq: 1, timestamp: 1000 })] }, { messages: [message({ seq: 2, timestamp: 1001 })] })
    const controller = new AbortController()
    const running = watchSignal(ctx, hub, controller.signal, { ...options, noticeMs: 1, log: logger })
    await vi.waitFor(() => {
      expect(logger.warn.mock.calls.filter(([line]) => String(line).startsWith('notice round failed')).length).toBeGreaterThan(1)
      expect(ctx.received).toHaveLength(2)
    }, { timeout: 2000, interval: 5 })
    controller.abort()
    await running
    expect(reports.at(-1)).toMatchObject({ state: 'ready' })
  })

  it('stops both loops on abort', async () => {
    const { ctx } = setup()
    const { hub, pull } = hubOf()
    const controller = new AbortController()
    const running = watchSignal(ctx, hub, controller.signal, { ...options, retryMs: 5000, noticeMs: 5000 })
    await vi.waitFor(() => expect(pull).toHaveBeenCalled(), { timeout: 1000, interval: 5 })
    const started = Date.now()
    controller.abort()
    await running
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
