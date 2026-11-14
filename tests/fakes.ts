import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HubMessage } from '../src/hub.ts'
import type { ReceiveResult, SourceContext, Ticket, Trigger } from '../src/types.ts'

export interface RecordedRequest { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }
export interface ScriptedResponse { status?: number; headers?: Record<string, string>; json?: unknown; chunks?: Uint8Array[]; hold?: boolean }
export type Script = ScriptedResponse | ((request: RecordedRequest) => ScriptedResponse)

export interface FakeHub {
  url: string
  requests: RecordedRequest[]
  respond(...scripts: Script[]): void
  requested(count: number): Promise<void>
  close(): Promise<void>
}

export async function fakeHub(): Promise<FakeHub> {
  const requests: RecordedRequest[] = []
  const queue: Script[] = []
  const waiters: { count: number; resolve: () => void }[] = []
  const server = createServer((req, res) => {
    const parts: Buffer[] = []
    req.on('data', chunk => parts.push(chunk))
    req.on('end', () => {
      const recorded: RecordedRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(parts).toString('utf8') }
      requests.push(recorded)
      for (const waiter of waiters) if (requests.length >= waiter.count) waiter.resolve()
      const script = queue.shift() ?? { status: 500, json: { error: 'no scripted response' } }
      const response = typeof script === 'function' ? script(recorded) : script
      if (response.hold) return
      const headers = { ...(response.json !== undefined ? { 'content-type': 'application/json' } : {}), ...response.headers }
      res.writeHead(response.status ?? 200, headers)
      if (response.json !== undefined) res.end(JSON.stringify(response.json))
      else {
        for (const chunk of response.chunks ?? []) res.write(chunk)
        res.end()
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    respond: (...scripts) => { queue.push(...scripts) },
    requested: count => requests.length >= count ? Promise.resolve() : new Promise<void>(resolve => { waiters.push({ count, resolve }) }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

export const internalA = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
export const restA = `group.${Buffer.from(internalA).toString('base64')}`
export const OWNER_UUID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
export const OWNER_NUMBER = '+4915112345678'

export interface FakeContext extends SourceContext {
  received: Trigger[]
  store: Map<string, unknown>
  ticketStore: Map<string, Ticket>
  admitted: Set<string>
  onReceive: (trigger: Trigger) => ReceiveResult | Promise<ReceiveResult>
}

export function fakeContext(): FakeContext {
  const store = new Map<string, unknown>()
  const ticketStore = new Map<string, Ticket>()
  const received: Trigger[] = []
  const ctx: FakeContext = {
    received,
    store,
    ticketStore,
    admitted: new Set([OWNER_UUID]),
    onReceive: () => 'stored',
    deployment: { repository: 'lkshrk/example' },
    ready: Promise.resolve(),
    configured: () => true,
    config: () => undefined,
    receive: async trigger => {
      const result = await ctx.onReceive(trigger)
      received.push(trigger)
      return result
    },
    admits: actor => actor.human && ctx.admitted.has(actor.id),
    state: {
      get: <V>(key: string) => store.get(key) as V | undefined,
      set: (key, value) => { if (value === undefined) store.delete(key); else store.set(key, value) },
      keys: prefix => {
        const start = typeof prefix === 'string' ? prefix : prefix.prefix
        return [...store.keys()].filter(key => key.startsWith(start))
      },
    },
    threads: { get: () => undefined, describe: () => {} },
    tickets: { get: id => ticketStore.get(id), open: () => [...ticketStore.values()] },
    triggers: { get: () => undefined },
    notify: () => {},
    report: () => {},
  }
  return ctx
}

export function message(overrides: Partial<HubMessage> = {}): HubMessage {
  return {
    seq: 1,
    receivedAt: '2026-11-14T10:00:00.000Z',
    timestamp: 1763114400000,
    kind: 'message',
    sender: { number: OWNER_NUMBER, uuid: OWNER_UUID, name: 'Owner', device: 1 },
    group: { id: internalA, internalId: internalA, restId: restA, name: 'dsh' },
    text: 'Fix the flaky test',
    quote: null,
    attachments: [],
    editOf: 0,
    ...overrides,
  }
}
