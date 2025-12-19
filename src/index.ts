import { App, Context, Logger, h } from 'koishi'
import type { Session } from 'koishi'
import { createRequire } from 'module'
import { HTTP } from '@cordisjs/plugin-http'
import adapterOneBot from '@koishijs/plugin-adapter-onebot'
import consolePlugin from '@koishijs/plugin-console'
import * as loggerPlugin from '@koishijs/plugin-logger'
import fs from 'fs'
import path from 'path'
import http from 'http'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface Usage {
  messages: number
  promptTokens: number
  completionTokens: number
}

interface StoredState {
  whitelist: string[]
  blacklist: string[]
  mutedChannels: string[]
  usage: Usage
}

interface RateLimitConfig {
  userPerMinute: number
  groupPerMinute: number
  globalPerMinute: number
}

interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
  temperature: number
  maxTokens: number
  summaryMaxTokens: number
  systemPrompt: string
}

interface OneBotConfig {
  endpoint: string
  selfId?: string
  token?: string
  protocol: 'ws' | 'ws-reverse'
}

interface BotConfig {
  port: number
  commandPrefix: string
  botName: string
  dataDir: string
  onebot: OneBotConfig
  deepseek: DeepSeekConfig
  admins: Set<string>
  allowlistSeed: Set<string>
  denylistSeed: Set<string>
  whitelistMode: boolean
  blockedPatterns: RegExp[]
  maxContextMessages: number
  summaryTrigger: number
  enableConsole: boolean
  consolePort: number
  allowGroupPlainText: boolean
  rateLimit: RateLimitConfig
  personaPresets: Record<string, string>
}

const logger = new Logger('deepseek-bot')

// Ensure ctx.constructor.Session exists for adapters expecting it (OneBot adapter compatibility).
const koishiRequire = createRequire(require.resolve('koishi/package.json'))
const { Session: KoishiSession } = koishiRequire('@satorijs/core')
;(App as any).Session = KoishiSession as any

const DEFAULT_PERSONAS: Record<string, string> = {
  default: '你是一个由 DeepSeek 模型驱动的 QQ 助手，回答要准确、简洁，默认使用中文，并在需要时给出简要步骤。',
  friendly: '以轻松、温暖的口吻回答，适合日常闲聊，保持积极和礼貌。',
  expert: '以专业技术顾问身份回答，结构化地给出原因、步骤和风险提示，避免无依据的内容。',
  concise: '保持超简洁回答，能用一句话解决的绝不展开，必要时用列表呈现。',
}

function parseList(input?: string): string[] {
  if (!input) return []
  return input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parsePatterns(input?: string): RegExp[] {
  if (!input) return []
  return input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((pattern) => {
      try {
        return new RegExp(pattern, 'i')
      } catch (err) {
        logger.warn('无法解析敏感词正则: %s (%s)', pattern, err)
        return null
      }
    })
    .filter(Boolean) as RegExp[]
}

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

class PersistentStore {
  private statePath: string
  private state: StoredState

  constructor(private dir: string, allowSeeds: Set<string>, denySeeds: Set<string>) {
    this.statePath = path.join(dir, 'state.json')
    this.state = {
      whitelist: [...allowSeeds],
      blacklist: [...denySeeds],
      mutedChannels: [],
      usage: { messages: 0, promptTokens: 0, completionTokens: 0 },
    }
  }

  async init() {
    await fs.promises.mkdir(this.dir, { recursive: true })
    if (fs.existsSync(this.statePath)) {
      try {
        const raw = await fs.promises.readFile(this.statePath, 'utf-8')
        const parsed = JSON.parse(raw) as StoredState
        this.state = {
          whitelist: parsed.whitelist ?? [],
          blacklist: parsed.blacklist ?? [],
          mutedChannels: parsed.mutedChannels ?? [],
          usage: parsed.usage ?? { messages: 0, promptTokens: 0, completionTokens: 0 },
        }
      } catch (err) {
        logger.warn('读取持久化状态失败，将使用默认值: %s', err)
      }
    } else {
      await this.save()
    }
  }

  getUsage(): Usage {
    return this.state.usage
  }

  recordUsage(delta: Partial<Usage>) {
    this.state.usage.messages += delta.messages ?? 0
    this.state.usage.promptTokens += delta.promptTokens ?? 0
    this.state.usage.completionTokens += delta.completionTokens ?? 0
    return this.save()
  }

  isMuted(channelKey: string): boolean {
    return this.state.mutedChannels.includes(channelKey)
  }

  mute(channelKey: string) {
    if (!this.isMuted(channelKey)) {
      this.state.mutedChannels.push(channelKey)
      return this.save()
    }
  }

  unmute(channelKey: string) {
    this.state.mutedChannels = this.state.mutedChannels.filter((id) => id !== channelKey)
    return this.save()
  }

  allow(userId: string) {
    if (!this.state.whitelist.includes(userId)) {
      this.state.whitelist.push(userId)
      this.state.blacklist = this.state.blacklist.filter((id) => id !== userId)
      return this.save()
    }
  }

  deny(userId: string) {
    if (!this.state.blacklist.includes(userId)) {
      this.state.blacklist.push(userId)
      this.state.whitelist = this.state.whitelist.filter((id) => id !== userId)
      return this.save()
    }
  }

  isDenied(userId?: string): boolean {
    if (!userId) return true
    return this.state.blacklist.includes(userId)
  }

  isAllowed(userId: string, admins: Set<string>, whitelistMode: boolean): boolean {
    if (!userId) return false
    if (admins.has(userId)) return true
    if (this.state.blacklist.includes(userId)) return false
    if (!whitelistMode) return true
    return this.state.whitelist.includes(userId)
  }

  listAllowed(): string[] {
    return this.state.whitelist
  }

  listDenied(): string[] {
    return this.state.blacklist
  }

  private async save() {
    await fs.promises.mkdir(this.dir, { recursive: true })
    await fs.promises.writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8')
  }
}

class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>()

  constructor(private limit: number, private windowMs: number) {}

  allow(key: string): boolean {
    if (!this.limit || this.limit <= 0) return true
    const now = Date.now()
    const bucket = this.buckets.get(key) ?? { count: 0, resetAt: now + this.windowMs }
    if (now > bucket.resetAt) {
      bucket.count = 0
      bucket.resetAt = now + this.windowMs
    }
    if (bucket.count >= this.limit) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.count += 1
    this.buckets.set(key, bucket)
    return true
  }

  remainingMs(key: string): number {
    const bucket = this.buckets.get(key)
    if (!bucket) return 0
    return Math.max(bucket.resetAt - Date.now(), 0)
  }
}

class LockManager {
  private locks = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.locks.set(key, previous.then(() => current))

    try {
      await previous
      const result = await task()
      return result
    } finally {
      ;(release as () => void)()
      if (this.locks.get(key) === current) {
        this.locks.delete(key)
      }
    }
  }
}

class DeepseekClient {
  constructor(private config: DeepSeekConfig) {}

  async chat(messages: ChatMessage[], options?: { maxTokens?: number; temperature?: number }): Promise<{ text: string; usage?: Usage }> {
    if (!this.config.apiKey) {
      throw new Error('DEEPSEEK_API_KEY 未设置')
    }

    const body = {
      model: this.config.model,
      messages,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      temperature: options?.temperature ?? this.config.temperature,
      stream: false,
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`DeepSeek 请求失败: ${response.status} ${response.statusText} ${text}`)
      }

      const data = (await response.json()) as any
      const content = data?.choices?.[0]?.message?.content
      if (!content) {
        throw new Error('DeepSeek 响应为空')
      }

      return {
        text: content,
        usage: {
          messages: 1,
          promptTokens: data?.usage?.prompt_tokens ?? 0,
          completionTokens: data?.usage?.completion_tokens ?? 0,
        },
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

interface ConversationState {
  history: ChatMessage[]
  summary?: string
  persona?: string
}

class ConversationManager {
  private sessions = new Map<string, ConversationState>()

  constructor(private config: BotConfig, private deepseek: DeepseekClient, private store: PersistentStore) {}

  get activeSessions() {
    return this.sessions.size
  }

  reset(sessionKey: string) {
    this.sessions.delete(sessionKey)
  }

  setPersona(sessionKey: string, persona: string | undefined) {
    const state = this.sessions.get(sessionKey) ?? { history: [] }
    state.persona = persona
    this.sessions.set(sessionKey, state)
  }

  getPersona(sessionKey: string) {
    return this.sessions.get(sessionKey)?.persona
  }

  async reply(session: Session, text: string): Promise<string> {
    const sessionKey = this.getSessionKey(session)
    const state = this.sessions.get(sessionKey) ?? { history: [] }

    state.history.push({ role: 'user', content: text })

    if (state.history.length > this.config.summaryTrigger) {
      await this.summarize(state)
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: this.config.deepseek.systemPrompt },
    ]

    if (state.persona && this.config.personaPresets[state.persona]) {
      messages.push({ role: 'system', content: this.config.personaPresets[state.persona] })
    }

    if (state.summary) {
      messages.push({ role: 'system', content: `对话摘要：${state.summary}` })
    }

    const recent = state.history.slice(-this.config.maxContextMessages)
    messages.push(...recent)

    const result = await this.deepseek.chat(messages)

    state.history.push({ role: 'assistant', content: result.text })
    if (state.history.length > this.config.maxContextMessages * 2) {
      state.history = state.history.slice(-this.config.maxContextMessages)
    }

    this.sessions.set(sessionKey, state)

    if (result.usage) {
      await this.store.recordUsage(result.usage)
    }

    return result.text
  }

  getSessionKey(session: Session): string {
    if (session.guildId) return `${session.platform}:${session.guildId}`
    if (session.channelId) return `${session.platform}:${session.channelId}`
    if (session.userId) return `${session.platform}:user:${session.userId}`
    return `${session.platform}:unknown`
  }

  private async summarize(state: ConversationState) {
    const serialized = state.history
      .slice(-this.config.summaryTrigger)
      .map((item) => `${item.role}: ${item.content}`)
      .join('\n')

    const summaryMessages: ChatMessage[] = [
      { role: 'system', content: '请用中文总结以下对话，保留关键事实、指令与上下文，不超过200字。' },
      { role: 'user', content: serialized },
    ]

    try {
      const summary = await this.deepseek.chat(summaryMessages, {
        maxTokens: this.config.deepseek.summaryMaxTokens,
        temperature: 0.2,
      })
      if (summary.usage) {
        await this.store.recordUsage(summary.usage)
      }
      state.summary = summary.text
      state.history = state.history.slice(-Math.floor(this.config.maxContextMessages / 2))
    } catch (err) {
      logger.warn('生成摘要失败，将跳过：%s', err)
    }
  }
}

function loadConfig(): BotConfig {
  const allowlistSeed = new Set(parseList(process.env.ALLOWLIST))
  const denylistSeed = new Set(parseList(process.env.DENYLIST))
  const adminIds = new Set(parseList(process.env.ADMIN_IDS))
  const personaPresets = { ...DEFAULT_PERSONAS }

  try {
    if (process.env.PERSONA_PRESETS) {
      const parsed = JSON.parse(process.env.PERSONA_PRESETS)
      Object.assign(personaPresets, parsed)
    }
  } catch (err) {
    logger.warn('PERSONA_PRESETS 解析失败，使用默认值: %s', err)
  }

  return {
    port: toNumber(process.env.PORT, 5140),
    commandPrefix: process.env.BOT_PREFIX || '/',
    botName: process.env.BOT_NAME || 'DeepSeek Bot',
    dataDir: path.resolve(process.env.DATA_DIR || 'data'),
    onebot: {
      endpoint: process.env.ONEBOT_WS_URL || 'ws://napcat:3001',
      selfId: process.env.BOT_SELF_ID,
      token: process.env.ONEBOT_ACCESS_TOKEN,
      protocol: (process.env.ONEBOT_PROTOCOL as 'ws' | 'ws-reverse') || 'ws',
    },
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY || '',
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      temperature: toNumber(process.env.DEEPSEEK_TEMPERATURE, 0.8),
      maxTokens: toNumber(process.env.DEEPSEEK_MAX_TOKENS, 2048),
      summaryMaxTokens: toNumber(process.env.DEEPSEEK_SUMMARY_TOKENS, 512),
      systemPrompt:
        process.env.SYSTEM_PROMPT ||
        '你是 QQ 群的智能助手，保持礼貌、简洁，拒绝违法违规和敏感内容，必要时提醒用户风险。',
    },
    admins: adminIds,
    allowlistSeed,
    denylistSeed,
    whitelistMode: process.env.WHITELIST_MODE === 'true',
    blockedPatterns: parsePatterns(process.env.BLOCKED_PATTERNS),
    maxContextMessages: toNumber(process.env.MAX_CONTEXT_MESSAGES, 12),
  summaryTrigger: toNumber(process.env.SUMMARY_TRIGGER, 10),
  enableConsole: process.env.ENABLE_CONSOLE !== 'false',
  consolePort: toNumber(process.env.CONSOLE_PORT, 5300),
  allowGroupPlainText: process.env.ALLOW_GROUP_PLAIN === 'true',
  rateLimit: {
    userPerMinute: toNumber(process.env.USER_RATE_LIMIT, 8),
    groupPerMinute: toNumber(process.env.GROUP_RATE_LIMIT, 40),
    globalPerMinute: toNumber(process.env.GLOBAL_RATE_LIMIT, 120),
  },
    personaPresets,
  }
}

function buildChannelKey(session: Session): string {
  if (session.guildId) return `${session.platform}:${session.guildId}`
  if (session.channelId) return `${session.platform}:${session.channelId}`
  return `${session.platform}:dm:${session.userId ?? 'unknown'}`
}

function cleanMessage(content: string, prefix: string): string {
  let text = content.trim()
  if (text.startsWith(prefix)) {
    text = text.slice(prefix.length)
  }
  text = text.replace(/^<at[^>]*>/, '').trim()
  return text
}

function detectMention(session: Session): boolean {
  return Boolean(session.elements?.some((element) => element.type === 'at' && (!element.attrs?.id || element.attrs.id === session.selfId)))
}

function chunkMessage(text: string, size = 900): string[] {
  const chunks: string[] = []
  let current = text
  while (current.length > size) {
    chunks.push(current.slice(0, size))
    current = current.slice(size)
  }
  if (current.length) chunks.push(current)
  return chunks
}

function registerCommands(
  ctx: Context,
  config: BotConfig,
  store: PersistentStore,
  conversations: ConversationManager,
) {
  ctx.command('reset', '重置当前会话上下文').action(async ({ session }) => {
    if (!session) return
    const key = conversations.getSessionKey(session)
    conversations.reset(key)
    return '✅ 已重置本会话的上下文'
  })

  ctx.command('persona [name]', '切换人格预设').action(async ({ session }, name) => {
    if (!session) return
    if (!name) {
      return `可用人格：${Object.keys(config.personaPresets).join(', ')}。使用 /persona <name> 切换。`
    }
    if (!config.personaPresets[name]) {
      return `未找到人格预设 ${name}，可选：${Object.keys(config.personaPresets).join(', ')}`
    }
    conversations.setPersona(conversations.getSessionKey(session), name)
    return `已切换为人格：${name}`
  })

  ctx.command('usage', '查看调用用量').action(() => {
    const usage = store.getUsage()
    return `累计对话 ${usage.messages} 轮，提示 tokens=${usage.promptTokens}，回复 tokens=${usage.completionTokens}`
  })

  ctx.command('mute-on', '静音当前频道/群 (管理员)').action(({ session }) => {
    if (!session) return
    if (!session.userId || !config.admins.has(session.userId)) return '仅管理员可用'
    const key = buildChannelKey(session)
    store.mute(key)
    return '已在本频道静音机器人'
  })

  ctx.command('mute-off', '取消静音当前频道/群 (管理员)').action(({ session }) => {
    if (!session) return
    if (!session.userId || !config.admins.has(session.userId)) return '仅管理员可用'
    const key = buildChannelKey(session)
    store.unmute(key)
    return '机器人已解除静音'
  })

  ctx.command('allow <userId>', '允许用户使用机器人 (管理员)').action(async ({ session }, userId) => {
    if (!session) return
    if (!session.userId || !config.admins.has(session.userId)) return '仅管理员可用'
    store.allow(userId)
    return `已加入白名单：${userId}`
  })

  ctx.command('deny <userId>', '阻止用户使用机器人 (管理员)').action(async ({ session }, userId) => {
    if (!session) return
    if (!session.userId || !config.admins.has(session.userId)) return '仅管理员可用'
    store.deny(userId)
    return `已加入黑名单：${userId}`
  })

  ctx.command('config', '查看运行配置 (管理员)').action(({ session }) => {
    if (!session?.userId || !config.admins.has(session.userId)) return '仅管理员可用'
    return (
      `机器人：${config.botName}\n` +
      `OneBot: ${config.onebot.endpoint}\n` +
      `模型: ${config.deepseek.model}\n` +
      `上下文条数: ${config.maxContextMessages}\n` +
      `摘要阈值: ${config.summaryTrigger}\n` +
      `白名单模式: ${config.whitelistMode}`
    )
  })

  ctx.command('status', '查看状态 (管理员)').action(({ session }) => {
    if (!session?.userId || !config.admins.has(session.userId)) return '仅管理员可用'
    const usage = store.getUsage()
    return (
      `会话活跃数: ${conversations.activeSessions}\n` +
      `累计对话: ${usage.messages}\n` +
      `白名单: ${store.listAllowed().length} 人\n` +
      `黑名单: ${store.listDenied().length} 人`
    )
  })

  ctx.command('help', '查看帮助').action(() => {
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

function registerMessageHandler(
  ctx: Context,
  config: BotConfig,
  store: PersistentStore,
  conversations: ConversationManager,
  limiter: { user: RateLimiter; group: RateLimiter; global: RateLimiter },
  locks: LockManager,
) {
  ctx.middleware(async (session, next) => {
    if (session.type !== 'message-created') return next()
    const content = session.content?.trim()
    if (!content) return next()
    if (content.startsWith(config.commandPrefix)) return next()

    const mentioned = detectMention(session)
    const direct = session.isDirect
    if (!direct && !mentioned && !config.allowGroupPlainText) return next()

    const userId = session.userId
    const channelKey = buildChannelKey(session)

    if (store.isMuted(channelKey)) return

    if (!userId) return next()
    if (!store.isAllowed(userId, config.admins, config.whitelistMode)) {
      return session.send('你没有权限使用此机器人，请联系管理员。')
    }
    if (store.isDenied(userId)) {
      return session.send('你已被禁止使用此机器人。')
    }

    const patternHit = config.blockedPatterns.find((pattern) => pattern.test(content))
    if (patternHit) {
      return session.send('消息包含禁止内容，已拦截。')
    }

    if (!limiter.user.allow(userId)) {
      const wait = Math.ceil(limiter.user.remainingMs(userId) / 1000)
      return session.send(`请求过于频繁，请 ${wait} 秒后再试。`)
    }
    const groupKey = session.guildId || session.channelId || 'default'
    if (!limiter.group.allow(groupKey)) {
      return session.send('当前群聊请求过多，请稍后再试。')
    }
    if (!limiter.global.allow('global')) {
      return session.send('系统繁忙，请稍后再试。')
    }

    const cleaned = cleanMessage(content, config.commandPrefix)
    if (!cleaned) return next()

    try {
      const reply = await locks.run(conversations.getSessionKey(session), () => conversations.reply(session, cleaned))
      const parts = chunkMessage(reply)
      const quote = session.messageId ? h.quote(session.messageId) : ''
      for (const part of parts) {
        await session.sendQueued(quote + part)
      }
    } catch (err) {
      logger.warn(err)
      await session.send('调用 AI 失败，请稍后重试或联系管理员。')
    }
  })
}

function startHealthServer(config: BotConfig, store: PersistentStore, conversations: ConversationManager) {
  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(404)
      return res.end()
    }
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ status: 'ok' }))
    }
    if (req.url === '/status') {
      const usage = store.getUsage()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(
        JSON.stringify({
          bot: config.botName,
          activeSessions: conversations.activeSessions,
          usage,
        }),
      )
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(config.port, '0.0.0.0', () => logger.info('健康检查端口已启动: %d', config.port))
}

async function bootstrap() {
  const config = loadConfig()
  const store = new PersistentStore(config.dataDir, config.allowlistSeed, config.denylistSeed)
  await store.init()

  const deepseek = new DeepseekClient(config.deepseek)
  const conversations = new ConversationManager(config, deepseek, store)
  const locks = new LockManager()

  const app = new App({
    prefix: config.commandPrefix,
  })

  if (config.enableConsole) {
    app.plugin(consolePlugin as any, { open: false, port: config.consolePort } as any)
  }
  app.plugin(HTTP as any)
  app.plugin(loggerPlugin)
  app.plugin(adapterOneBot as any, {
    protocol: config.onebot.protocol,
    selfId: config.onebot.selfId,
    token: config.onebot.token,
    endpoint: config.onebot.endpoint,
  } as any)

  const limiter = {
    user: new RateLimiter(config.rateLimit.userPerMinute, 60_000),
    group: new RateLimiter(config.rateLimit.groupPerMinute, 60_000),
    global: new RateLimiter(config.rateLimit.globalPerMinute, 60_000),
  }

  registerCommands(app, config, store, conversations)
  registerMessageHandler(app, config, store, conversations, limiter, locks)

  await app.start()
  startHealthServer(config, store, conversations)
  logger.info('机器人已启动')
}

bootstrap().catch((err) => {
  logger.error('启动失败: %s', err)
  process.exit(1)
})
