import { DeepSeekConfig } from '../common/types';
import { Logger } from '../common/logger';

export interface BalanceInfo {
	currency: string;
	total_balance: string;
	granted_balance?: string;
	topped_up_balance?: string;
}

export interface BalanceResponse {
	is_available: boolean;
	balance_infos: BalanceInfo[];
}

export interface BalanceResult {
	ts: number;
	data?: BalanceResponse;
	error?: string;
	fromCache: boolean;
}

export class DeepseekAccountClient {
	private cache?: BalanceResult;

	constructor(
		private config: DeepSeekConfig,
		private cacheMs: number,
		private timeoutMs: number,
		private logger: Logger,
	) {}

	async getBalance(force = false): Promise<BalanceResult> {
		const now = Date.now();
		if (!force && this.cache && now - this.cache.ts < this.cacheMs) {
			return { ...this.cache, fromCache: true };
		}
		if (!this.config.apiKey) {
			const res = { ts: now, error: 'DEEPSEEK_API_KEY 未配置', fromCache: false };
			this.cache = res;
			return res;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const url = `${this.config.baseUrl.replace(/\/+$/, '')}/user/balance`;
			const resp = await fetch(url, {
				method: 'GET',
				headers: { Authorization: `Bearer ${this.config.apiKey}` },
				signal: controller.signal,
			});
			if (!resp.ok) {
				const text = await resp.text();
				const errMsg = `余额查询失败: ${resp.status} ${resp.statusText} ${text}`;
				this.logger.warn(errMsg);
				const res = { ts: now, error: errMsg, fromCache: false };
				this.cache = res;
				return res;
			}
			const data = (await resp.json()) as BalanceResponse;
			const res = { ts: now, data, fromCache: false };
			this.cache = res;
			return res;
		} catch (err) {
			const message =
				(err as any)?.name === 'AbortError'
					? `余额查询超时 (> ${this.timeoutMs}ms)`
					: `余额查询异常: ${err}`;
			this.logger.warn(message);
			const res = { ts: now, error: message, fromCache: false };
			this.cache = res;
			return res;
		} finally {
			clearTimeout(timer);
		}
	}
}
