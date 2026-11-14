import type { SignalConfig } from './config.ts'
import { HubError, type HubClient, type HubMessage } from './hub.ts'
import type { Agent, ImageMediaType } from './types.ts'

const IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const EXTENSIONS: Record<ImageMediaType, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }
const LINE = /^\[attachment signal:(\S+) (.*) (\S+) (\d+) bytes\]( \(too large to read\))?$/gm

export function attachmentLine(a: HubMessage['attachments'][number], maxBytes: number): string {
  const name = a.filename.replace(/\s+/g, ' ').trim() || 'unnamed'
  return `[attachment signal:${a.id} ${name} ${a.contentType} ${a.size} bytes]${a.size > maxBytes ? ' (too large to read)' : ''}`
}

function imageLines(text: string): { id: string; mediaType: ImageMediaType }[] {
  const found: { id: string; mediaType: ImageMediaType }[] = []
  for (const match of text.matchAll(LINE)) {
    const [, id, , contentType, , large] = match
    if (id && contentType && !large && IMAGE_TYPES.includes(contentType)) found.push({ id, mediaType: contentType as ImageMediaType })
  }
  return found
}

export function imageKeys(text: string): string[] {
  return [...new Set(imageLines(text).map(line => line.id))]
}

export async function readImage(agent: Agent, hub: Pick<HubClient, 'attachment'>, config: SignalConfig, message: { id: string; text: string },
  key: string, signal: AbortSignal): Promise<{ source_message_id: string; image_key: string; image: unknown }> {
  const line = imageLines(message.text).find(entry => entry.id === key)
  if (!line) throw new Error('Choose an image key from this source message')
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('Image reading is unavailable: no attachment service is mounted')
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  const llm = agent.ctx.get('llm')
  if (!llm || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
  const info = await llm.resolveModelInfo(provider, model, signal)
  if (!info.inputModalities?.includes('image')) throw new Error(`Model ${model} does not support image input; the image has not been inspected`)
  signal.throwIfAborted()
  const limit = Math.min(config.attachmentMaxBytes, attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  let fetched: { data: Uint8Array }
  try {
    fetched = await hub.attachment(key, limit, signal)
  } catch (error) {
    if (error instanceof HubError && error.status === 404) throw new Error('attachment no longer available')
    throw error
  }
  signal.throwIfAborted()
  const image = await attachments.saveImage({ data: fetched.data, mediaType: line.mediaType, name: `${key.replace(/[^\w.-]/g, '_')}${key.includes('.') ? '' : EXTENSIONS[line.mediaType]}` })
  signal.throwIfAborted()
  return { source_message_id: message.id, image_key: key, image }
}
