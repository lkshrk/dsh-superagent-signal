import type { SignalConfig } from './config.ts'
import { HubError, type HubClient, type SendInput } from './hub.ts'
import { consoleLog, type IntakeLog } from './intake.ts'
import { KEYS, remember, type SentRecord } from './state.ts'
import type { OutboundMessage, SourceContext } from './types.ts'

const NEVER_SUCCEEDS = new Set([400, 413])

export async function sendSignal(ctx: SourceContext, hub: Pick<HubClient, 'send'>, _config: SignalConfig, message: OutboundMessage, log: IntakeLog = consoleLog): Promise<'sent' | 'gone'> {
  if (ctx.state.get<SentRecord>(KEYS.sent(message.id))) return 'sent'
  const { address, thread } = message.channel
  const input: SendInput = {
    recipient: address.group ?? '',
    text: message.text,
    ...address.quoteTimestamp ? { quote: { timestamp: Number(address.quoteTimestamp), author: address.quoteAuthor ?? '' } } : {},
  }
  let result
  try {
    result = await hub.send(input)
  } catch (error) {
    if (error instanceof HubError && NEVER_SUCCEEDS.has(error.status)) {
      log.warn(`dropped message ${message.id}: the hub refused it with status ${error.status}`)
      return 'gone'
    }
    throw error
  }
  for (const failure of result.failures) log.warn(`message ${message.id} did not reach ${failure.uuid || failure.number}: ${failure.reason}`)
  if (result.timestamps.length === 0) throw new HubError(`the hub delivered message ${message.id} to nobody`, 502)
  const at = new Date().toISOString()
  ctx.state.set<SentRecord>(KEYS.sent(message.id), { timestamps: result.timestamps, at })
  if (message.ticketId !== undefined) {
    const entry = { thread: thread.replace(/^signal:/, ''), ticketId: message.ticketId, at }
    for (const timestamp of result.timestamps) if (!ctx.state.get(KEYS.map(timestamp))) remember(ctx, timestamp, entry)
  }
  return 'sent'
}
