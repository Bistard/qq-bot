import { ConversationManager } from './conversation'
import { BotConfig, IncomingPayload } from './types'
import { IStore } from './store'

export type CommandHandler = (ctx: CommandContext, args: string[]) => Promise<string | void> | string | void

export interface CommandContext {
  payload: IncomingPayload
  config: BotConfig
  store: IStore
  conversations: ConversationManager
}

export class CommandRegistry {
  private commands = new Map<string, CommandHandler>()

  register(name: string, handler: CommandHandler) {
    this.commands.set(name.toLowerCase(), handler)
  }

  async execute(name: string, ctx: CommandContext, args: string[]): Promise<string | void> {
    const handler = this.commands.get(name.toLowerCase())
    if (!handler) return
    return handler(ctx, args)
  }
}

export function registerBuiltInCommands(registry: CommandRegistry) {
  registry.register('reset', async ({ conversations, payload }) => {
    const key = buildChannelKey(payload)
    conversations.reset(key)
    return '✅ 已重置本会话的上下文'
  })

  registry.register('persona', ({ config, conversations, payload }, args) => {
    const name = args[0]
    if (!name) {
      return `可用人格：${Object.keys(config.personaPresets).join(', ')}。使用 /persona <name> 切换。`
    }
    if (!config.personaPresets[name]) {
      return `未找到人格预设 ${name}，可选：${Object.keys(config.personaPresets).join(', ')}`
    }
    conversations.setPersona(buildChannelKey(payload), name)
    return `已切换为人格：${name}`
  })

  registry.register('usage', ({ store }) => {
    const usage = store.getUsage()
    return `累计对话 ${usage.messages} 轮，提示 tokens=${usage.promptTokens}，回复 tokens=${usage.completionTokens}`
  })

  registry.register('mute-on', ({ config, store, payload }) => {
    const userId = payload.message.userId
    if (!config.admins.has(userId)) return '仅管理员可用'
    const key = buildChannelKey(payload)
    store.mute(key)
    return '已在本频道静音机器人'
  })

  registry.register('mute-off', ({ config, store, payload }) => {
    const userId = payload.message.userId
    if (!config.admins.has(userId)) return '仅管理员可用'
    const key = buildChannelKey(payload)
    store.unmute(key)
    return '机器人已解除静音'
  })

  registry.register('allow', ({ config, store, payload }, args) => {
    if (!config.admins.has(payload.message.userId)) return '仅管理员可用'
    const userId = args[0]
    if (!userId) return '用法：/allow <userId>'
    store.allow(userId)
    return `已加入白名单：${userId}`
  })

  registry.register('deny', ({ config, store, payload }, args) => {
    if (!config.admins.has(payload.message.userId)) return '仅管理员可用'
    const userId = args[0]
    if (!userId) return '用法：/deny <userId>'
    store.deny(userId)
    return `已加入黑名单：${userId}`
  })

  registry.register('config', ({ config, payload }) => {
    if (!config.admins.has(payload.message.userId)) return '仅管理员可用'
    return (
      `机器人：${config.botName}\n` +
      `OneBot: ${config.onebot.endpoint}\n` +
      `模型: ${config.deepseek.model}\n` +
      `上下文条数: ${config.maxContextMessages}\n` +
      `摘要阈值: ${config.summaryTrigger}\n` +
      `白名单模式: ${config.whitelistMode}`
    )
  })

  registry.register('status', ({ config, store, conversations, payload }) => {
    if (!config.admins.has(payload.message.userId)) return '仅管理员可用'
    const usage = store.getUsage()
    return (
      `会话活跃数: ${conversations.activeSessions}\n` +
      `累计对话: ${usage.messages}\n` +
      `白名单: ${store.listAllowed().length} 人\n` +
      `黑名单: ${store.listDenied().length} 人`
    )
  })

  registry.register('help', ({ config }) => {
    return [
      `🤖 ${config.botName} 指令：`,
      '/help 查看帮助',
      '/reset 重置上下文',
      '/persona <name> 切换人格',
      '/usage 查看用量',
      '管理员：/config /allow /deny /status /mute-on /mute-off',
    ].join('\n')
  })
}

function buildChannelKey(payload: IncomingPayload): string {
  if (payload.message.groupId) return `onebot:group:${payload.message.groupId}`
  return `onebot:dm:${payload.message.userId}`
}
