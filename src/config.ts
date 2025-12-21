import path from 'path';
import fs from 'fs';
import { Logger } from './common/logger';
import { BotConfig } from './common/types';
import { parseList, toNumber, parsePatterns } from './common/utils';

function loadPersonaPresets(personaDir: string, logger: Logger): Record<string, string> {
	const personas: Record<string, string> = {};
	try {
		const entries = fs.readdirSync(personaDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile()) continue;
			const ext = path.extname(entry.name).toLowerCase();
			if (ext && ext !== '.txt') continue;
			const personaName = ext ? entry.name.slice(0, -ext.length) : entry.name;
			const content = fs.readFileSync(path.join(personaDir, entry.name), 'utf-8').trim();
			if (content) personas[personaName] = content;
		}
		if (Object.keys(personas).length === 0) {
			logger.warn('persona 目录 %s 中未找到有效的 persona 文件', personaDir);
		}
	} catch (err) {
		logger.warn('读取 persona 目录 %s 失败，将使用空集合: %s', personaDir, err);
	}
	return personas;
}

export function loadConfig(logger: Logger): BotConfig {
	const allowlistSeed = new Set(parseList(process.env.ALLOWLIST));
	const denylistSeed = new Set(parseList(process.env.DENYLIST));
	const adminIds = new Set(parseList(process.env.ADMIN_IDS));

	const personaDir = process.env.PERSONA_DIR
		? path.resolve(process.env.PERSONA_DIR)
		: path.resolve(__dirname, '../personas');
	const personaPresets = loadPersonaPresets(personaDir, logger);
	const defaultPersonaEnv = process.env.DEFAULT_PERSONA?.trim();
	const defaultPersona =
		defaultPersonaEnv && personaPresets[defaultPersonaEnv] ? defaultPersonaEnv : undefined;
	if (defaultPersonaEnv && !defaultPersona) {
		logger.warn('默认 persona %s 未找到，已忽略', defaultPersonaEnv);
	}
	const systemPrompt = process.env.SYSTEM_PROMPT || '';

	return {
		storageDriver: process.env.STORAGE_DRIVER === 'sqlite' ? 'sqlite' : 'json',
		sqlitePath: process.env.SQLITE_PATH,
		logChatHistory: process.env.LOG_CHAT_HISTORY !== 'false',
		port: toNumber(process.env.PORT, 5140),
		commandPrefix: process.env.BOT_PREFIX || '/',
		botName: process.env.BOT_NAME || 'DeepSeek Bot',
		dataDir: path.resolve(process.env.DATA_DIR || 'data'),
		onebot: {
			endpoint: process.env.ONEBOT_WS_URL || 'ws://napcat:3001',
			selfId: process.env.BOT_SELF_ID,
			token: process.env.ONEBOT_ACCESS_TOKEN,
			reconnectIntervalMs: toNumber(process.env.ONEBOT_RECONNECT_MS, 5000),
			actionTimeoutMs: toNumber(process.env.ONEBOT_ACTION_TIMEOUT_MS, 10000),
		},
		deepseek: {
			apiKey: process.env.DEEPSEEK_API_KEY || '',
			baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
			model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
			reasonerModel: process.env.DEEPSEEK_REASONER_MODEL || 'deepseek-reasoner',
			forcePlainText: process.env.DEEPSEEK_FORCE_PLAIN === 'true',
			temperature: toNumber(process.env.DEEPSEEK_TEMPERATURE, 0.8),
			maxTokens: toNumber(process.env.DEEPSEEK_MAX_TOKENS, 2048),
			summaryMaxTokens: toNumber(process.env.DEEPSEEK_SUMMARY_TOKENS, 512),
			timeoutMs: toNumber(process.env.DEEPSEEK_TIMEOUT_MS, 30000),
			systemPrompt,
		},
		admins: adminIds,
		allowlistSeed,
		denylistSeed,
		whitelistMode: process.env.WHITELIST_MODE === 'true',
		blockedPatterns: parsePatterns(process.env.BLOCKED_PATTERNS, logger),
		maxContextMessages: toNumber(process.env.MAX_CONTEXT_MESSAGES, 12),
		summaryTrigger: toNumber(process.env.SUMMARY_TRIGGER, 10),
		allowGroupPlainText: process.env.ALLOW_GROUP_PLAIN === 'true',
		logPrompts: process.env.LOG_PROMPTS === 'true',
		logResponses: process.env.LOG_RESPONSES === 'true',
		rateLimit: {
			userPerMinute: toNumber(process.env.USER_RATE_LIMIT, 8),
			groupPerMinute: toNumber(process.env.GROUP_RATE_LIMIT, 40),
			globalPerMinute: toNumber(process.env.GLOBAL_RATE_LIMIT, 120),
		},
		personaPresets,
		defaultPersona,
	};
}
