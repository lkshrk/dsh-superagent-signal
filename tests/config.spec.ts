import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SignalConfigSchema, groupInternalId } from '../src/config.ts'
import { signalKind } from '../src/kind.ts'
import type { SourceKind } from '../src/types.ts'
import type { SignalConfig } from '../src/config.ts'

const internal = (seed = 0) => Buffer.from(Array.from({ length: 32 }, (_, i) => (i + seed) % 256)).toString('base64')
const restForm = (id: string) => `group.${Buffer.from(id).toString('base64')}`
const kind = signalKind({ send: async () => 'sent', context: () => undefined })
const config = (over: Partial<SignalConfig> = {}) => SignalConfigSchema.parse(over)

describe('config', () => {
  it('fills the defaults', () => {
    expect(SignalConfigSchema.parse({})).toEqual({ hubUrl: '', tokenFile: '', groupId: '', pollWaitSeconds: 30, pollLimit: 100,
      notifyTickets: true, notifyProgress: false, notifyHealth: true, healthGraceSeconds: 60, attachmentMaxBytes: 10485760, batchSettleSeconds: 120, batchMaxHours: 4 })
  })

  it('accepts valid values', () => {
    const parsed = SignalConfigSchema.parse({ hubUrl: 'http://signal-hub.tools.svc.cluster.local:8080', tokenFile: '/run/secrets/dsh', groupId: restForm(internal()),
      pollWaitSeconds: 0, pollLimit: 500, healthGraceSeconds: 3600, attachmentMaxBytes: 26214400, batchSettleSeconds: 3600, batchMaxHours: 48 })
    expect(parsed.groupId).toBe(restForm(internal()))
    expect(SignalConfigSchema.parse({ batchSettleSeconds: 0, batchMaxHours: 1 })).toMatchObject({ batchSettleSeconds: 0, batchMaxHours: 1 })
  })

  it.each([
    ['hubUrl scheme', { hubUrl: 'ftp://x' }],
    ['hubUrl trailing slash', { hubUrl: 'http://x/' }],
    ['relative tokenFile', { tokenFile: 'rel/path' }],
    ['colon group id', { groupId: `group:${internal()}` }],
    ['short group id', { groupId: Buffer.alloc(16).toString('base64') }],
    ['pollWaitSeconds over', { pollWaitSeconds: 61 }],
    ['pollLimit zero', { pollLimit: 0 }],
    ['pollLimit over', { pollLimit: 501 }],
    ['healthGraceSeconds over', { healthGraceSeconds: 3601 }],
    ['attachmentMaxBytes over', { attachmentMaxBytes: 26214401 }],
    ['fractional pollLimit', { pollLimit: 1.5 }],
    ['batchSettleSeconds negative', { batchSettleSeconds: -1 }],
    ['batchSettleSeconds over', { batchSettleSeconds: 3601 }],
    ['fractional batchSettleSeconds', { batchSettleSeconds: 1.5 }],
    ['batchMaxHours zero', { batchMaxHours: 0 }],
    ['batchMaxHours over', { batchMaxHours: 49 }],
    ['fractional batchMaxHours', { batchMaxHours: 2.5 }],
    ['unknown key', { extra: true }],
  ])('refuses %s', (_, value) => {
    expect(SignalConfigSchema.safeParse(value).success).toBe(false)
  })

  it('normalizes both group id forms', () => {
    const id = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
    expect(internal()).toBe(id)
    expect(groupInternalId(id)).toBe(id)
    expect(groupInternalId('group.QUFFQ0F3UUZCZ2NJQ1FvTERBME9EeEFSRWhNVUZSWVhHQmthR3h3ZEhoOD0=')).toBe(id)
    expect(groupInternalId(restForm(id))).toBe(id)
    expect(groupInternalId(Buffer.alloc(16).toString('base64'))).toBeUndefined()
    expect(groupInternalId('+4915112345678')).toBeUndefined()
    expect(groupInternalId('')).toBeUndefined()
    expect(groupInternalId('group.')).toBeUndefined()
  })
})

describe('kind', () => {
  const k = kind as SourceKind<SignalConfig>

  it('listens only to the configured group', () => {
    const a = internal(), b = internal(1)
    const cfg = config({ groupId: restForm(a) })
    expect(k.scope?.({ meta: { group: a } }, cfg)).toEqual({ listened: true, observed: false, row: 'chat' })
    expect(k.scope?.({ meta: { group: b } }, cfg)).toEqual({ listened: false, reason: 'group_not_configured' })
    expect(k.scope?.({ meta: { group: a } }, config())).toEqual({ listened: false, reason: 'group_not_configured' })
  })

  it('declares its identity and fields', () => {
    expect(k.kind).toBe('signal')
    expect(k.health).toEqual(['signal'])
    expect(k.accountFields).toEqual(['tokenFile'])
    expect(k.fields.map(field => field.key)).toEqual(Object.keys(SignalConfigSchema.parse({})))
    expect(k.find?.('anything')).toEqual({ threads: [], terms: [] })
  })

  it('validates the policy part', () => {
    const schema = k.policy!.schema
    expect(schema.safeParse({ allowed: [{ id: '0b6a3c1e-5d2f-4a8b-9c7e-1f2a3b4c5d6e' }] }).success).toBe(true)
    expect(schema.safeParse({ allowed: [{ id: '+4915112345678', name: 'Owner' }] }).success).toBe(true)
    expect(schema.safeParse({ allowed: [{ id: '' }] }).success).toBe(false)
    expect(schema.safeParse({ allowed: [], extra: 1 }).success).toBe(false)
    expect(schema.parse({})).toEqual({ allowed: [] })
  })

  it('shows one chat row with every cell off', () => {
    expect(k.policy!.rows?.({})).toEqual([{ id: 'chat', label: 'dsh chat', note: { en: 'Listed people only', zh: '仅名单中的人' },
      cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }])
  })
})

describe('bundle layer', () => {
  it('ships the bundle row', () => {
    expect(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')).toBe(`# dsh-superagent-signal bundle layer: the Signal Source plugin, off until a profile enables it and configures the hub.
- insert:
    - id: dsh-superagent-signal
      name: dsh-superagent-signal
      disabled: true
`)
  })
})
