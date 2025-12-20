import http from 'http';
import { loadConfig } from './config';
import { Logger } from './logger';
import { PersistentStore } from './store';
import { DeepseekClient } from './deepseek';
import { ConversationManager } from './conversation';
import { OneBotClient } from './onebot';
import { CommandRegistry, registerBuiltInCommands } from './commands';
import { chunkMessage } from './utils';
import { RateLimiter } from './limiter';
import { LockManager } from './lock';
import { IncomingPayload } from './types';

function buildChannelKey(message: IncomingPayload['message']): string {
	if (message.groupId) return `onebot:group:${message.groupId}`;
	return `onebot:dm:${message.userId}`;
}

function isCommand(text: string, prefix: string): boolean {
	return text.trim().startsWith(prefix);
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
		if (joined.startsWith(prefix)) return stripCommandPrefix(joined, prefix);
		return joined;
	}
	const trimmed = rawText.trim();
	if (trimmed.startsWith(prefix)) return stripCommandPrefix(trimmed, prefix);
	return trimmed;
}

function startHealthServer(
	port: number,
	botName: string,
	store: PersistentStore,
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
	const store = new PersistentStore(config.dataDir, config.allowlistSeed, config.denylistSeed);
	await store.init();

	const deepseek = new DeepseekClient(config.deepseek);
	const conversations = new ConversationManager(config, deepseek, store, logger);
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

	onebot.on('message', async (payload) => {
		await handleMessage(payload as IncomingPayload, {
			config,
			store,
			conversations,
			limiter,
			locks,
			onebot,
			logger,
			commands,
		});
	});

	onebot.start();
	startHealthServer(config.port, config.botName, store, conversations, logger);
	logger.info('机器人已启动');
}

async function handleMessage(
	payload: IncomingPayload,
	deps: {
		config: ReturnType<typeof loadConfig>;
		store: PersistentStore;
		conversations: ConversationManager;
		limiter: { user: RateLimiter; group: RateLimiter; global: RateLimiter };
		locks: LockManager;
		onebot: OneBotClient;
		logger: Logger;
		commands: CommandRegistry;
	},
) {
	const { config, store, conversations, limiter, locks, onebot, logger, commands } = deps;
	const { message, event } = payload;
	const text = message.plainText.trim();
	if (!text) return;

	const channelKey = buildChannelKey(message);

	if (store.isMuted(channelKey)) {
		logger.info('频道已静音，忽略消息');
		return;
	}

	const hasMention = message.mentioned;
	if (message.isGroup && !hasMention && !config.allowGroupPlainText) {
		return;
	}

	if (!store.isAllowed(message.userId, config.admins, config.whitelistMode)) {
		await onebot.sendText(event, '你没有权限使用此机器人，请联系管理员。', { quote: true });
		return;
	}
	if (store.isDenied(message.userId)) {
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
		const result = await commands.execute(
			name,
			{ config, store, conversations, payload },
			args,
		);
		if (result) {
			const parts = chunkMessage(result);
			for (const part of parts) {
				await onebot.sendText(event, part, { quote: true });
			}
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
	if (!cleaned) return;

	try {
		await locks.run(channelKey, async () => {
			const reply = await conversations.reply(channelKey, cleaned);
			const parts = chunkMessage(reply);
			for (const part of parts) {
				await onebot.sendText(event, part, { quote: true });
			}
		});
	} catch (err) {
		logger.warn('处理消息失败: %s', err);
		await onebot.sendText(event, '调用 AI 失败，请稍后重试或联系管理员。', { quote: true });
	}
}

bootstrap().catch((err) => {
	const logger = new Logger('deepseek-bot');
	logger.error('启动失败: %s', err);
	process.exit(1);
});
