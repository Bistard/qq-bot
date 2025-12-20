import { ChatMessage, DeepSeekConfig, Usage } from './types';

export interface ILLMClient {
	chat(
		messages: ChatMessage[],
		options?: { maxTokens?: number; temperature?: number; model?: string },
	): Promise<{ text: string; usage?: Usage }>;
}

export class DeepseekClient implements ILLMClient {
	constructor(private config: DeepSeekConfig) {}

	async chat(
		messages: ChatMessage[],
		options?: { maxTokens?: number; temperature?: number; model?: string },
	): Promise<{ text: string; usage?: Usage }> {
		if (!this.config.apiKey) {
			throw new Error('DEEPSEEK_API_KEY 未设置');
		}

		const body = {
			model: options?.model || this.config.model,
			messages,
			max_tokens: options?.maxTokens ?? this.config.maxTokens,
			temperature: options?.temperature ?? this.config.temperature,
			stream: false,
		};

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

		try {
			const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.config.apiKey}`,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			if (!response.ok) {
				const text = await response.text();
				throw new Error(
					`DeepSeek 请求失败: ${response.status} ${response.statusText} ${text}`,
				);
			}

			const data = (await response.json()) as any;
			const content = data?.choices?.[0]?.message?.content;
			if (!content) {
				throw new Error('DeepSeek 响应为空');
			}

			return {
				text: content,
				usage: {
					messages: 1,
					promptTokens: data?.usage?.prompt_tokens ?? 0,
					completionTokens: data?.usage?.completion_tokens ?? 0,
				},
			};
		} catch (err) {
			if ((err as any)?.name === 'AbortError') {
				throw new Error(`DeepSeek 请求超时 (>${this.config.timeoutMs}ms)`);
			}
			throw err;
		} finally {
			clearTimeout(timeout);
		}
	}
}
