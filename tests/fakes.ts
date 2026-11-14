import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

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
