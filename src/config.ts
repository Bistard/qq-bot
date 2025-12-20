import path from 'path'
import { BotConfig } from './types'
import { Logger } from './logger'
import { parseList, parsePatterns, toNumber } from './utils'

const DEFAULT_PERSONAS: Record<string, string> = {
  default: '你是一个由 DeepSeek 模型驱动的 QQ 助手，回答要准确、简洁，默认使用中文，并在需要时给出简要步骤。',
  friendly: '以轻松、温暖的口吻回答，适合日常闲聊，保持积极和礼貌。',
  expert: '以专业技术顾问身份回答，结构化地给出原因、步骤和风险提示，避免无依据的内容。',
  concise: '保持超简洁回答，能用一句话解决的绝不展开，必要时用列表呈现。',
}

export function loadConfig(logger: Logger): BotConfig {
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
    blockedPatterns: parsePatterns(process.env.BLOCKED_PATTERNS, logger),
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
