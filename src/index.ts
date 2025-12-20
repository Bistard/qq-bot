import fs from 'fs'
import path from 'path'
import http from 'http'
import { EventEmitter } from 'events'
import WebSocket from 'ws'

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
  reconnectIntervalMs: number
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
  allowGroupPlainText: boolean
  rateLimit: RateLimitConfig
  personaPresets: Record<string, string>
}

interface OneBotMessageSegment {
  type: string
  data: Record<string, any>
}

interface OneBotMessageEvent {
  time: number
  self_id: number | string
  post_type: 'message'
  message_type: 'group' | 'private'
  sub_type?: string
  message_id: number
  user_id: number | string
  message: OneBotMessageSegment[] | string
  raw_message: string
  font?: number
  group_id?: number | string
  target_id?: number | string
}

interface ParsedMessage {
  platform: 'onebot'
  selfId: string
  userId: string
  groupId?: string
  messageId: string
  rawText: string
  plainText: string
  segments: OneBotMessageSegment[]
  mentioned: boolean
  isGroup: boolean
  isPrivate: boolean
}

interface IncomingPayload {
  event: OneBotMessageEvent
  message: ParsedMessage
}

class Logger {
  constructor(private scope: string) {}

  private format(level: string, args: any[]) {
    const ts = new Date().toISOString()
    return [`[${ts}] [${level}] [${this.scope}]`, ...args]
  }

  info(...args: any[]) {
    console.log(...this.format('INFO', args))
  }

  warn(...args: any[]) {
    console.warn(...this.format('WARN', args))
  }

  error(...args: any[]) {
    console.error(...this.format('ERROR', args))
  }
}

const logger = new Logger('deepseek-bot')

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

  async reply(sessionKey: string, userText: string): Promise<string> {
    const state = this.sessions.get(sessionKey) ?? { history: [] }

    state.history.push({ role: 'user', content: userText })

    if (state.history.length > this.config.summaryTrigger) {
      await this.summarize(state)
    }

    const messages: ChatMessage[] = [{ role: 'system', content: this.config.deepseek.systemPrompt }]

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

class OneBotClient extends EventEmitter {
  private socket?: WebSocket
  private reconnectTimer?: NodeJS.Timeout
  private closed = false

  constructor(private config: OneBotConfig, private log: Logger) {
    super()
  }

  start() {
    this.closed = false
    this.connect()
  }

  stop() {
    this.closed = true
    clearTimeout(this.reconnectTimer)
    this.socket?.close()
  }

  private connect() {
    this.log.info('正在连接 OneBot: %s', this.config.endpoint)
    const headers: Record<string, string> = {}
    if (this.config.token) {
      headers.Authorization = `Bearer ${this.config.token}`
    }

    const ws = new WebSocket(this.config.endpoint, { headers })
    this.socket = ws

    ws.on('open', () => {
      this.log.info('OneBot 连接成功')
      this.emit('ready')
    })

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString())
        if (parsed?.post_type === 'message') {
          const payload = this.parseMessage(parsed as OneBotMessageEvent)
          if (payload) {
            this.emit('message', payload)
          }
        }
      } catch (err) {
        this.log.warn('解析 OneBot 消息失败: %s', err)
      }
    })

    ws.on('close', (code) => {
      this.log.warn('OneBot 连接关闭 code=%s', code)
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      this.log.warn('OneBot 连接错误: %s', err)
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect() {
    if (this.closed) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.connect(), this.config.reconnectIntervalMs)
  }

  private parseMessage(event: OneBotMessageEvent): IncomingPayload | null {
    const selfId = (this.config.selfId ?? event.self_id)?.toString() ?? ''
    const userId = event.user_id?.toString()
    if (!userId) return null
    if (selfId && userId === selfId) return null

    const segments: OneBotMessageSegment[] = Array.isArray(event.message) ? event.message : []
    const plainText = this.extractPlainText(segments, event.raw_message)
    const mentioned = this.detectMention(segments, selfId)

    const message: ParsedMessage = {
      platform: 'onebot',
      selfId,
      userId,
      groupId: event.message_type === 'group' ? event.group_id?.toString() : undefined,
      messageId: event.message_id?.toString(),
      rawText: event.raw_message ?? plainText,
      plainText,
      segments,
      mentioned,
      isGroup: event.message_type === 'group',
      isPrivate: event.message_type === 'private',
    }

    return { event, message }
  }

  private extractPlainText(segments: OneBotMessageSegment[], fallback: string): string {
    if (!segments.length) return fallback ?? ''
    const textParts = segments
      .filter((seg) => seg.type === 'text')
      .map((seg) => seg.data?.text ?? '')
    const joined = textParts.join('')
    return joined || fallback || ''
  }

  private detectMention(segments: OneBotMessageSegment[], selfId: string): boolean {
    if (!selfId) return false
    return segments.some((seg) => seg.type === 'at' && (seg.data?.qq?.toString() === selfId || seg.data?.id?.toString() === selfId))
  }

  async sendText(target: OneBotMessageEvent, text: string, options?: { quote?: boolean }) {
    const messageSegments: OneBotMessageSegment[] = []
    if (options?.quote && target.message_id) {
      messageSegments.push({ type: 'reply', data: { id: target.message_id } })
    }
    messageSegments.push({ type: 'text', data: { text } })

    const action = target.message_type === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params =
      target.message_type === 'group'
        ? { group_id: target.group_id, message: messageSegments }
        : { user_id: target.user_id, message: messageSegments }

    await this.sendAction(action, params)
  }

  private async sendAction(action: string, params: Record<string, any>) {
    const payload = JSON.stringify({ action, params, echo: `action-${Date.now()}` })
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(payload)
    } else {
      this.log.warn('发送失败，OneBot 未连接')
    }
  }
}

interface CommandContext {
  payload: IncomingPayload
  config: BotConfig
  store: PersistentStore
  conversations: ConversationManager
}

type CommandHandler = (ctx: CommandContext, args: string[]) => Promise<string | void> | string | void

class CommandRegistry {
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
      reconnectIntervalMs: toNumber(process.env.ONEBOT_RECONNECT_MS, 5000),
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
    allowGroupPlainText: process.env.ALLOW_GROUP_PLAIN === 'true',
    rateLimit: {
      userPerMinute: toNumber(process.env.USER_RATE_LIMIT, 8),
      groupPerMinute: toNumber(process.env.GROUP_RATE_LIMIT, 40),
      globalPerMinute: toNumber(process.env.GLOBAL_RATE_LIMIT, 120),
    },
    personaPresets,
  }
}

function buildChannelKey(message: ParsedMessage): string {
  if (message.groupId) return `onebot:group:${message.groupId}`
  return `onebot:dm:${message.userId}`
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

function isCommand(text: string, prefix: string): boolean {
  return text.trim().startsWith(prefix)
}

function stripCommandPrefix(text: string, prefix: string): string {
  return text.trim().slice(prefix.length).trim()
}

function cleanUserInput(message: ParsedMessage, prefix: string): string {
  if (Array.isArray(message.segments) && message.segments.length) {
    const textParts = message.segments
      .filter((seg) => seg.type === 'text')
      .map((seg) => seg.data?.text ?? '')
    const joined = textParts.join('').trim()
    if (joined.startsWith(prefix)) return stripCommandPrefix(joined, prefix)
    return joined
  }
  const trimmed = message.rawText.trim()
  if (trimmed.startsWith(prefix)) return stripCommandPrefix(trimmed, prefix)
  return trimmed
}

function registerCommands(registry: CommandRegistry) {
  registry.register('reset', async ({ conversations, payload }) => {
    const key = buildChannelKey(payload.message)
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
    conversations.setPersona(buildChannelKey(payload.message), name)
    return `已切换为人格：${name}`
  })

  registry.register('usage', ({ store }) => {
    const usage = store.getUsage()
    return `累计对话 ${usage.messages} 轮，提示 tokens=${usage.promptTokens}，回复 tokens=${usage.completionTokens}`
  })

  registry.register('mute-on', ({ config, store, payload }) => {
    const userId = payload.message.userId
    if (!config.admins.has(userId)) return '仅管理员可用'
    const key = buildChannelKey(payload.message)
    store.mute(key)
    return '已在本频道静音机器人'
  })

  registry.register('mute-off', ({ config, store, payload }) => {
    const userId = payload.message.userId
    if (!config.admins.has(userId)) return '仅管理员可用'
    const key = buildChannelKey(payload.message)
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
  const commands = new CommandRegistry()
  registerCommands(commands)

  const limiter = {
    user: new RateLimiter(config.rateLimit.userPerMinute, 60_000),
    group: new RateLimiter(config.rateLimit.groupPerMinute, 60_000),
    global: new RateLimiter(config.rateLimit.globalPerMinute, 60_000),
  }

  const onebot = new OneBotClient(config.onebot, new Logger('onebot'))

  onebot.on('ready', () => logger.info('OneBot 就绪，开始监听消息'))

  onebot.on('message', async (payload: IncomingPayload) => {
    const { message, event } = payload
    const text = message.plainText.trim()
    if (!text) return

    const channelKey = buildChannelKey(message)

    if (store.isMuted(channelKey)) {
      logger.info('频道已静音，忽略消息')
      return
    }

    const hasMention = message.mentioned
    if (message.isGroup && !hasMention && !config.allowGroupPlainText) {
      return
    }

    if (!store.isAllowed(message.userId, config.admins, config.whitelistMode)) {
      await onebot.sendText(event, '你没有权限使用此机器人，请联系管理员。', { quote: true })
      return
    }
    if (store.isDenied(message.userId)) {
      await onebot.sendText(event, '你已被禁止使用此机器人。', { quote: true })
      return
    }

    const patternHit = config.blockedPatterns.find((pattern) => pattern.test(text))
    if (patternHit) {
      await onebot.sendText(event, '消息包含禁止内容，已拦截。', { quote: true })
      return
    }

    if (isCommand(text, config.commandPrefix)) {
      const commandLine = stripCommandPrefix(text, config.commandPrefix)
      const [name, ...args] = commandLine.split(/\s+/).filter(Boolean)
      if (!name) return
      const result = await commands.execute(name, { config, store, conversations, payload }, args)
      if (result) {
        await onebot.sendText(event, result, { quote: true })
      }
      return
    }

    if (!limiter.user.allow(message.userId)) {
      const wait = Math.ceil(limiter.user.remainingMs(message.userId) / 1000)
      await onebot.sendText(event, `请求过于频繁，请 ${wait} 秒后再试。`, { quote: true })
      return
    }
    const groupKey = message.groupId || message.userId
    if (!limiter.group.allow(groupKey)) {
      await onebot.sendText(event, '当前群聊请求过多，请稍后再试。', { quote: true })
      return
    }
    if (!limiter.global.allow('global')) {
      await onebot.sendText(event, '系统繁忙，请稍后再试。', { quote: true })
      return
    }

    const cleaned = cleanUserInput(message, config.commandPrefix)
    if (!cleaned) return

    try {
      const reply = await locks.run(buildChannelKey(message), () => conversations.reply(buildChannelKey(message), cleaned))
      const parts = chunkMessage(reply)
      for (const part of parts) {
        await onebot.sendText(event, part, { quote: true })
      }
    } catch (err) {
      logger.warn('处理消息失败: %s', err)
      await onebot.sendText(event, '调用 AI 失败，请稍后重试或联系管理员。', { quote: true })
    }
  })

  onebot.start()
  startHealthServer(config, store, conversations)
  logger.info('机器人已启动')
}

bootstrap().catch((err) => {
  logger.error('启动失败: %s', err)
  process.exit(1)
})
