import { IStateStore } from './store';
import { BotConfig, ChatMessage } from './types';
import { ILLMClient } from './deepseek';
import { Logger } from './logger';
import { FAKE_DEEP_THINK_PROMPT, PLAIN_TEXT_PROMPT } from './constants';
import { ISessionStore } from './session-store';

interface ConversationState {
	history: ChatMessage[];
	summary?: string;
	persona?: string;
}

export class ConversationManager {
	private sessions = new Map<string, ConversationState>();

	constructor(
		private config: BotConfig,
		private deepseek: ILLMClient,
		private stateStore: IStateStore,
		private sessionStore: ISessionStore,
		private logger: Logger,
	) {}

	get activeSessions() {
		return this.sessions.size;
	}

	async reset(sessionKey: string) {
		this.sessions.delete(sessionKey);
		await this.sessionStore.clear(sessionKey);
	}

	async setPersona(sessionKey: string, persona: string | undefined) {
		const state = await this.getOrCreateState(sessionKey);
		state.persona = persona;
		this.sessions.set(sessionKey, state);
		await this.sessionStore.savePersona(sessionKey, persona);
	}

	getPersona(sessionKey: string) {
		return this.sessions.get(sessionKey)?.persona;
	}

	private async getOrCreateState(sessionKey: string): Promise<ConversationState> {
		const existing = this.sessions.get(sessionKey);
		if (existing) return existing;
		const state: ConversationState = { history: [] };
		const meta = await this.sessionStore.get(sessionKey);
		if (meta?.summary) state.summary = meta.summary;
		if (meta?.persona) {
			state.persona = meta.persona;
		} else {
			const defaultPersona = this.config.defaultPersona;
			if (defaultPersona && this.config.personaPresets[defaultPersona]) {
				state.persona = defaultPersona;
			}
		}
		this.sessions.set(sessionKey, state);
		return state;
	}

	async reply(
		sessionKey: string,
		userText: string,
		options?: { deep?: boolean },
	): Promise<string> {
		const state = await this.getOrCreateState(sessionKey);
		const deepMode = options?.deep ?? false;

		state.history.push({ role: 'user', content: userText });

		if (state.history.length > this.config.summaryTrigger) {
			await this.summarize(sessionKey, state);
		}

		const messages: ChatMessage[] = [
			{ role: 'system', content: this.config.deepseek.systemPrompt },
		];

		if (state.persona && this.config.personaPresets[state.persona]) {
			messages.push({ role: 'system', content: this.config.personaPresets[state.persona] });
		}

		if (state.summary) {
			messages.push({ role: 'system', content: `对话摘要：${state.summary}` });
		}

		if (this.config.deepseek.forcePlainText) {
			messages.push({ role: 'system', content: PLAIN_TEXT_PROMPT });
		}

		if (deepMode) {
			messages.push({
				role: 'system',
				content: FAKE_DEEP_THINK_PROMPT,
			});
		}

		const recent = state.history.slice(-this.config.maxContextMessages);
		messages.push(...recent);

		const llmOptions = deepMode
			? {
					maxTokens: this.config.deepseek.maxTokens,
					temperature: Math.max(this.config.deepseek.temperature - 0.3, 0),
					model: this.config.deepseek.reasonerModel || this.config.deepseek.model,
			  }
			: undefined;

		const context = deepMode ? `reply:deep:${sessionKey}` : `reply:${sessionKey}`;
		const result = await this.callLLM(messages, llmOptions, context);

		state.history.push({ role: 'assistant', content: result.text });
		if (state.history.length > this.config.maxContextMessages * 2) {
			state.history = state.history.slice(-this.config.maxContextMessages);
		}

		this.sessions.set(sessionKey, state);

		if (result.usage) {
			await this.stateStore.recordUsage(result.usage);
		}

		return result.text;
	}

	private async summarize(sessionKey: string, state: ConversationState) {
		const serialized = state.history
			.slice(-this.config.summaryTrigger)
			.map((item) => `${item.role}: ${item.content}`)
			.join('\n');

		const summaryMessages: ChatMessage[] = [
			{
				role: 'system',
				content: '请用中文总结以下对话，保留关键事实、指令与上下文，不超过200字。',
			},
		];
		if (this.config.deepseek.forcePlainText) {
			summaryMessages.push({ role: 'system', content: PLAIN_TEXT_PROMPT });
		}
		summaryMessages.push({ role: 'user', content: serialized });

		try {
			const summary = await this.callLLM(
				summaryMessages,
				{
					maxTokens: this.config.deepseek.summaryMaxTokens,
					temperature: 0.2,
				},
				`summary:${sessionKey}`,
			);
			if (summary.usage) {
				await this.stateStore.recordUsage(summary.usage);
			}
			state.summary = summary.text;
			await this.sessionStore.saveSummary(sessionKey, summary.text);
			state.history = state.history.slice(-Math.floor(this.config.maxContextMessages / 2));
		} catch (err) {
			this.logger.warn('生成摘要失败，将跳过：%s', err);
		}
	}

	private async callLLM(
		messages: ChatMessage[],
		options: { maxTokens?: number; temperature?: number; model?: string } | undefined,
		context: string,
	) {
		if (this.config.logPrompts) {
			this.logger.info('LLM prompt[%s]: %s', context, JSON.stringify(messages));
		}
		const result = await this.deepseek.chat(messages, options);
		if (this.config.logResponses) {
			this.logger.info('LLM response[%s]: %s', context, result.text);
		}
		return result;
	}
}
