import { z } from 'zod'
import { HEALTH, SOURCE, SignalConfigSchema, groupInternalId, type SignalConfig } from './config.ts'
import { imageKeys, readImage } from './attachments.ts'
import type { HubClient } from './hub.ts'
import type { ContextMessage, OutboundMessage, SourceContext, SourceKind } from './types.ts'

export interface KindDeps {
  send(message: OutboundMessage): Promise<'sent' | 'gone'>
  context(): SourceContext | undefined
  hub?(): HubClient | undefined
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
      { key: 'notifyTickets', type: 'switch', advanced: true, label: { zh: '工单需要人处理时通知（提问、受阻、失败）', en: 'Notify when a ticket needs a person (question, blocked, failed)' } },
      { key: 'notifyProgress', type: 'switch', advanced: true, label: { zh: '发送工单开始与结束的汇总', en: 'Post ticket start and finish digests' } },
      { key: 'notifyHealth', type: 'switch', advanced: true, label: { zh: '通知依赖故障与恢复', en: 'Notify when a dependency fails or recovers' } },
      { key: 'healthGraceSeconds', type: 'number', advanced: true, min: 0, max: 3600, label: { zh: '故障通知前的等待 / 秒', en: 'Wait before a failure notice / seconds' },
        hint: { zh: '条目需持续处于 error 这么久', en: 'An entry must stay in error this long' } },
      { key: 'attachmentMaxBytes', type: 'number', advanced: true, min: 0, max: 26214400, label: { zh: '入站附件大小上限 / 字节', en: 'Largest inbound attachment / bytes' },
        hint: { zh: '更大的附件只列出，不下载', en: 'Larger attachments are listed, not fetched' } },
      { key: 'batchSettleSeconds', type: 'number', advanced: true, min: 0, max: 3600, label: { zh: '批量消息前的静默 / 秒', en: 'Quiet time before a batch message / seconds' },
        hint: { zh: '开启汇总时：这么久没有新工单开始或结束后，才发送开始或汇总消息', en: 'With digests on: start and summary messages wait until no ticket started or ended for this long' } },
      { key: 'batchMaxHours', type: 'number', advanced: true, min: 1, max: 48, label: { zh: '中间汇总前的最长等待 / 小时', en: 'Longest wait before a partial summary / hours' },
        hint: { zh: '开启汇总时：仍有工单运行时，结束的工单最多等这么久就汇总', en: 'With digests on: ended tickets wait at most this long for a summary while others still run' } },
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
    threadContext: {
      messageId: trigger => String(trigger.meta.timestamp),
      async read(_commands, trigger, part) {
        if (part === 'parent') return { messages: quoted(trigger), body: {} }
        return { messages: [{ id: String(trigger.meta.timestamp), from: trigger.actor.id, at: trigger.at, text: trigger.text }], body: {} }
      },
      images: imageKeys,
      async image(agent, _commands, _trigger, message, key, _stateDir, signal) {
        const hub = deps.hub?.()
        const config = deps.context()?.config<SignalConfig>(SOURCE)
        if (!hub || !config) throw new Error('Image reading is unavailable: the Signal hub is not configured')
        return readImage(agent, hub, SignalConfigSchema.parse(config), message, key, signal)
      },
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

function quoted(trigger: { meta: Record<string, unknown>; at: string }): ContextMessage[] {
  const { quote, quoteText, quoteAuthor } = trigger.meta
  if (quote === undefined || typeof quoteText !== 'string') return []
  return [{ id: String(quote), from: typeof quoteAuthor === 'string' ? quoteAuthor : 'unknown', at: trigger.at, text: quoteText }]
}
