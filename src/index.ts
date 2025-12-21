import http from 'http';
import path from 'path';
import { loadConfig } from './config';
import { Logger } from './logger';
import { createStateStore, IStateStore } from './store';
import { DeepseekClient } from './deepseek';
import { ConversationManager } from './conversation';
import { OneBotClient } from './onebot';
import { CommandRegistry, registerBuiltInCommands } from './commands';
import { chunkMessage } from './utils';
import { RateLimiter } from './limiter';
import { LockManager } from './lock';
import { IncomingPayload } from './types';
import { openDatabase } from './db/client';
import { NullSessionStore, SqliteSessionStore } from './session-store';
import { IMessageStore, NullMessageStore, SqliteMessageStore } from './message-store';

function buildChannelKey(message: IncomingPayload['message']): string {
	if (message.groupId) return `onebot:group:${message.groupId}`;
	return `onebot:dm:${message.userId}`;
}

function isCommand(text: string, prefix: string): boolean {
	const trimmed = text.trim();
	return trimmed.toLowerCase().startsWith(prefix.toLowerCase());
}

function stripCommandPrefix(text: string, prefix: string): string {
	return text.trim().slice(prefix.length).trim();
}

function cleanUserInput(rawText: string, segments: any[], prefix: string): string {
	if (Array.isArray(segments) && segments.length) {
		const textParts = segments
			.filter((seg) => seg.type === 'text')
			.map((seg) => seg.data?.text ?? '');
		const joined = textParts.join('').trim();
		if (isCommand(joined, prefix)) return stripCommandPrefix(joined, prefix);
		return joined;
	}
	const trimmed = rawText.trim();
	if (isCommand(trimmed, prefix)) return stripCommandPrefix(trimmed, prefix);
	return trimmed;
}

function startHealthServer(
	port: number,
	botName: string,
	store: IStateStore,
	conversations: ConversationManager,
	logger: Logger,
) {
	const server = http.createServer((req, res) => {
		if (!req.url) {
			res.writeHead(404);
			return res.end();
		}
		if (req.url === '/healthz') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ status: 'ok' }));
		}
		if (req.url === '/status') {
			const usage = store.getUsage();
			res.writeHead(200, { 'Content-Type': 'application/json' });
			return res.end(
				JSON.stringify({
					bot: botName,
					activeSessions: conversations.activeSessions,
					usage,
				}),
			);
		}
		res.writeHead(404);
		res.end();
	});
	server.listen(port, '0.0.0.0', () => logger.info('健康检查端口已启动: %d', port));
}

async function bootstrap() {
	const logger = new Logger('deepseek-bot');
	const config = loadConfig(logger);
	const dbLogger = new Logger('sqlite');
	const db =
		config.storageDriver === 'sqlite'
			? openDatabase(config.sqlitePath || path.join(config.dataDir, 'bot.db'), dbLogger)
			: undefined;

	const stateStore = createStateStore(config.storageDriver, {
		dataDir: config.dataDir,
		allowSeeds: config.allowlistSeed,
		denySeeds: config.denylistSeed,
		db,
		logger: new Logger('state'),
	});

	const sessionStore =
		config.storageDriver === 'sqlite' && db
			? new SqliteSessionStore(db, new Logger('session'))
			: new NullSessionStore();

	const messageStore: IMessageStore =
		config.storageDriver === 'sqlite' && db && config.logChatHistory
			? new SqliteMessageStore(db, new Logger('msglog'))
			: new NullMessageStore();

	await stateStore.init();
	await sessionStore.init();
	await messageStore.init();

	const deepseek = new DeepseekClient(config.deepseek);
	const conversations = new ConversationManager(
		config,
		deepseek,
		stateStore,
		sessionStore,
		logger,
	);
	const locks = new LockManager();
	const commands = new CommandRegistry();
	registerBuiltInCommands(commands);

	const limiter = {
		user: new RateLimiter(config.rateLimit.userPerMinute, 60_000),
		group: new RateLimiter(config.rateLimit.groupPerMinute, 60_000),
		global: new RateLimiter(config.rateLimit.globalPerMinute, 60_000),
	};

	const onebot = new OneBotClient(config.onebot, new Logger('onebot'));

	onebot.on('ready', () => logger.info('OneBot 就绪，开始监听消息'));

	onebot.on('message', async (payload: IncomingPayload) => {
		await handleMessage(payload, {
			config,
			stateStore,
			conversations,
			limiter,
			locks,
			onebot,
			logger,
			commands,
			messageStore,
		});
	});

	onebot.start();
	startHealthServer(config.port, config.botName, stateStore, conversations, logger);
	logger.info('机器人已启动');
}

async function handleMessage(
	payload: IncomingPayload,
	deps: {
		config: ReturnType<typeof loadConfig>;
		stateStore: IStateStore;
		conversations: ConversationManager;
		limiter: { user: RateLimiter; group: RateLimiter; global: RateLimiter };
		locks: LockManager;
		onebot: OneBotClient;
		logger: Logger;
		commands: CommandRegistry;
		messageStore: IMessageStore;
	},
) {
	const {
		config,
		stateStore,
		conversations,
		limiter,
		locks,
		onebot,
		logger,
		commands,
		messageStore,
	} = deps;
	const { message, event } = payload;
	const text = message.plainText.trim();
	if (!text) return;

	const channelKey = buildChannelKey(message);

	if (config.logChatHistory) {
		await messageStore.log({
			channelKey,
			userId: message.userId,
			groupId: message.groupId,
			messageId: message.messageId,
			ts: payload.event?.time ? payload.event.time * 1000 : Date.now(),
			plainText: message.plainText,
			isBot: false,
		});
	}

	if (stateStore.isMuted(channelKey)) {
		logger.info('频道已静音，忽略消息');
		return;
	}

	const hasMention = message.mentioned;
	if (message.isGroup && !hasMention && !config.allowGroupPlainText) {
		return;
	}

	if (!stateStore.isAllowed(message.userId, config.admins, config.whitelistMode)) {
		await onebot.sendText(event, '你没有权限使用此机器人，请联系管理员。', { quote: true });
		return;
	}
	if (stateStore.isDenied(message.userId)) {
		await onebot.sendText(event, '你已被禁止使用此机器人。', { quote: true });
		return;
	}

	const patternHit = config.blockedPatterns.find((pattern) => pattern.test(text));
	if (patternHit) {
		await onebot.sendText(event, '消息包含禁止内容，已拦截。', { quote: true });
		return;
	}

	if (isCommand(text, config.commandPrefix)) {
		const commandLine = stripCommandPrefix(text, config.commandPrefix);
		const [name, ...args] = commandLine.split(/\s+/).filter(Boolean);
		if (!name) return;
		try {
			const result = await commands.execute(
				name,
				{ config, store: stateStore, conversations, payload, messageStore },
				args,
			);
			const botUserId = config.onebot.selfId || 'bot';
			if (result) {
				const parts = chunkMessage(result);
				for (const part of parts) {
					await onebot.sendText(event, part, { quote: true });
					if (config.logChatHistory) {
						await messageStore.log({
							channelKey,
							userId: botUserId,
							groupId: message.groupId,
							messageId: undefined,
							plainText: part,
							isBot: true,
						});
					}
				}
			}
		} catch (err) {
			logger.warn('执行命令失败: %s', err);
			await onebot.sendText(event, '命令执行失败，请稍后重试或联系管理员。', { quote: true });
		}
		return;
	}

	if (!limiter.user.allow(message.userId)) {
		const wait = Math.ceil(limiter.user.remainingMs(message.userId) / 1000);
		await onebot.sendText(event, `请求过于频繁，请 ${wait} 秒后再试。`, { quote: true });
		return;
	}
	const groupKey = message.groupId || message.userId;
	if (!limiter.group.allow(groupKey)) {
		await onebot.sendText(event, '当前群聊请求过多，请稍后再试。', { quote: true });
		return;
	}
	if (!limiter.global.allow('global')) {
		await onebot.sendText(event, '系统繁忙，请稍后再试。', { quote: true });
		return;
	}

	const cleaned = cleanUserInput(message.rawText, message.segments, config.commandPrefix);
	if (!cleaned) {
		return;
	}

	try {
		await locks.run(channelKey, async () => {
			const reply = await conversations.reply(channelKey, cleaned);
			const parts = chunkMessage(reply);
			const botUserId = config.onebot.selfId || 'bot';
			for (const part of parts) {
				await onebot.sendText(event, part, { quote: true });
				if (config.logChatHistory) {
					await messageStore.log({
						channelKey,
						userId: botUserId,
						groupId: message.groupId,
						messageId: undefined,
						plainText: part,
						isBot: true,
					});
				}
			}
		});
	} catch (err) {
		const errorMessage = err instanceof Error ? err.stack || err.message : String(err);
		const responseText = `处理消息失败：${errorMessage}`;
		logger.warn(responseText);
		await onebot.sendText(event, responseText, { quote: true });
	}
}

bootstrap().catch((err) => {
	const logger = new Logger('deepseek-bot');
	logger.error('启动失败: %s', err);
	process.exit(1);
});
