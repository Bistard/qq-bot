export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface Usage {
	messages: number;
	promptTokens: number;
	completionTokens: number;
}

export interface StoredState {
	whitelist: string[];
	blacklist: string[];
	mutedChannels: string[];
	usage: Usage;
}

export interface RateLimitConfig {
	userPerMinute: number;
	groupPerMinute: number;
	globalPerMinute: number;
}

export interface DeepSeekConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	reasonerModel: string;
	temperature: number;
	maxTokens: number;
	summaryMaxTokens: number;
	systemPrompt: string;
	timeoutMs: number;
	forcePlainText: boolean;
}

export interface OneBotConfig {
	endpoint: string;
	selfId?: string;
	token?: string;
	reconnectIntervalMs: number;
}

export interface BotConfig {
	port: number;
	commandPrefix: string;
	botName: string;
	dataDir: string;
	onebot: OneBotConfig;
	deepseek: DeepSeekConfig;
	admins: Set<string>;
	allowlistSeed: Set<string>;
	denylistSeed: Set<string>;
	whitelistMode: boolean;
	blockedPatterns: RegExp[];
	maxContextMessages: number;
	summaryTrigger: number;
	allowGroupPlainText: boolean;
	rateLimit: RateLimitConfig;
	logPrompts: boolean;
	logResponses: boolean;
	personaPresets: Record<string, string>;
}

export interface OneBotMessageSegment {
	type: string;
	data: Record<string, any>;
}

export interface OneBotMessageEvent {
	time: number;
	self_id: number | string;
	post_type: 'message';
	message_type: 'group' | 'private';
	sub_type?: string;
	message_id: number;
	user_id: number | string;
	message: OneBotMessageSegment[] | string;
	raw_message: string;
	font?: number;
	group_id?: number | string;
	target_id?: number | string;
}

export interface ParsedMessage {
	platform: 'onebot';
	selfId: string;
	userId: string;
	groupId?: string;
	messageId: string;
	rawText: string;
	plainText: string;
	segments: OneBotMessageSegment[];
	mentioned: boolean;
	isGroup: boolean;
	isPrivate: boolean;
}

export interface IncomingPayload {
	event: OneBotMessageEvent;
	message: ParsedMessage;
}
