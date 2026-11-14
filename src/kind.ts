import { z } from 'zod'
import { HEALTH, SOURCE, SignalConfigSchema, groupInternalId, type SignalConfig } from './config.ts'
import type { OutboundMessage, SourceContext, SourceKind } from './types.ts'

export interface KindDeps {
  send(message: OutboundMessage): Promise<'sent' | 'gone'>
  context(): SourceContext | undefined
}

export function signalKind(deps: KindDeps): SourceKind<SignalConfig> {
  return {
    kind: SOURCE,
    title: { zh: 'Signal', en: 'Signal' },
    description: { zh: '通过 signal hub 接收所有者在一个 Signal 群里的消息；引用 dsh 的消息即可回答。',
      en: 'Receives the owner\'s messages in one Signal group through the signal hub; quote a dsh message to answer it.' },
    schema: SignalConfigSchema,
    accountFields: ['tokenFile'],
    fields: [
      { key: 'hubUrl', type: 'text', pattern: '^$|^https?://\\S*[^\\s/]$', label: { zh: 'Hub 地址', en: 'Hub URL' },
        hint: { zh: '例如 http://signal-hub.tools.svc.cluster.local:8080', en: 'For example http://signal-hub.tools.svc.cluster.local:8080' } },
      { key: 'tokenFile', type: 'text', label: { zh: 'Hub 令牌文件', en: 'Hub token file' } },
      { key: 'groupId', type: 'text', label: { zh: 'Signal 群 id', en: 'Signal group id' },
        hint: { zh: '内部 id，或 group.<base64>', en: 'The internal id, or group.<base64>' } },
      { key: 'pollWaitSeconds', type: 'number', advanced: true, min: 0, max: 60, label: { zh: '长轮询等待 / 秒', en: 'Long-poll wait / seconds' } },
      { key: 'pollLimit', type: 'number', advanced: true, min: 1, max: 500, label: { zh: '每次读取的消息数', en: 'Messages per read' } },
      { key: 'notifyTickets', type: 'switch', advanced: true, label: { zh: '通知工单需要关注或已结束', en: 'Notify when a ticket needs a person or ended' } },
      { key: 'notifyHealth', type: 'switch', advanced: true, label: { zh: '通知依赖故障与恢复', en: 'Notify when a dependency fails or recovers' } },
      { key: 'healthGraceSeconds', type: 'number', advanced: true, min: 0, max: 3600, label: { zh: '故障通知前的等待 / 秒', en: 'Wait before a failure notice / seconds' },
        hint: { zh: '条目需持续处于 error 这么久', en: 'An entry must stay in error this long' } },
      { key: 'attachmentMaxBytes', type: 'number', advanced: true, min: 0, max: 26214400, label: { zh: '入站附件大小上限 / 字节', en: 'Largest inbound attachment / bytes' },
        hint: { zh: '更大的附件只列出，不下载', en: 'Larger attachments are listed, not fetched' } },
    ],
    health: [HEALTH],
    scope({ meta }, config) {
      const configured = groupInternalId(config.groupId)
      return configured !== undefined && meta.group === configured
        ? { listened: true, observed: false, row: 'chat' }
        : { listened: false, reason: 'group_not_configured' }
    },
    channel: {
      allowed: (address, config) => address.group === groupInternalId(config.groupId),
      send: (_host, message) => deps.send(message),
      link: () => ({ url: '', label: { zh: 'Signal', en: 'Signal' } }),
    },
    find: () => ({ threads: [], terms: [] }),
    policy: {
      schema: z.object({ allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]) }).strict(),
      fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Signal 用户', en: 'Signal users who may originate work' }, columns: [
        { key: 'id', type: 'text', label: { zh: 'Signal UUID 或号码', en: 'Signal UUID or number' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
      explicit: { zh: '名单里的人在 dsh 的 Signal 群里发言。', en: 'Someone on the list writes in the dsh Signal group.' },
      rows: () => [{ id: 'chat', label: 'dsh chat', note: { zh: '仅名单中的人', en: 'Listed people only' },
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } }],
    },
  }
}
