import { z } from 'zod'

export const SOURCE = 'signal'
export const HEALTH = 'signal'

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const isInternal = (id: string) => BASE64.test(id) && Buffer.from(id, 'base64').length === 32 && Buffer.from(id, 'base64').toString('base64') === id

export function groupInternalId(id: string): string | undefined {
  if (isInternal(id)) return id
  if (!id.startsWith('group.')) return undefined
  const inner = Buffer.from(id.slice('group.'.length), 'base64').toString('utf8')
  return isInternal(inner) ? inner : undefined
}

export const SignalConfigSchema = z.object({
  hubUrl: z.string().trim().refine(url => url === '' || /^https?:\/\/\S*[^\s/]$/.test(url), 'An http(s) URL without a trailing slash').default(''),
  tokenFile: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path').default(''),
  groupId: z.string().trim().refine(id => id === '' || groupInternalId(id) !== undefined, 'A Signal group id').default(''),
  pollWaitSeconds: z.number().int().min(0).max(60).default(30),
  pollLimit: z.number().int().min(1).max(500).default(100),
  notifyTickets: z.boolean().default(true),
  notifyHealth: z.boolean().default(true),
  healthGraceSeconds: z.number().int().min(0).max(3600).default(60),
  attachmentMaxBytes: z.number().int().min(0).max(26214400).default(10485760),
}).strict()
export type SignalConfig = z.infer<typeof SignalConfigSchema>
