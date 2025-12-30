import Database from 'better-sqlite3';
import { Logger } from '../common/logger';

export interface CostLogEntry {
	ts: number;
	model: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	latencyMs?: number;
	channelKey?: string;
	groupId?: string;
	userId?: string;
	ok: boolean;
	error?: string;
	estimatedCost?: number;
	currency?: string;
}

export interface CostSummary {
	calls: number;
	errors: number;
	promptTokens: number;
	completionTokens: number;
	estimatedCost: number;
	currency?: string;
}

export interface GroupedCostSummary extends CostSummary {
	key: string;
}

export interface ModelCostSummary extends CostSummary {
	model: string;
}

export interface DailyCostSummary extends CostSummary {
	day: string;
}

export interface ICostStore {
	init(): Promise<void>;
	record(entry: CostLogEntry): Promise<void>;
	recent(limit: number): Promise<CostLogEntry[]>;
	sumSince(ts: number): Promise<CostSummary>;
	modelSummarySince(ts: number): Promise<ModelCostSummary[]>;
	topGroupsSince(ts: number, limit: number): Promise<GroupedCostSummary[]>;
	topUsersSince(ts: number, limit: number): Promise<GroupedCostSummary[]>;
	dailySummary(days: number): Promise<DailyCostSummary[]>;
}

export class NullCostStore implements ICostStore {
	async init() {}
	async record() {}
	async recent(): Promise<CostLogEntry[]> {
		return [];
	}
	async sumSince(): Promise<CostSummary> {
		return { calls: 0, errors: 0, promptTokens: 0, completionTokens: 0, estimatedCost: 0 };
	}
	async modelSummarySince(): Promise<ModelCostSummary[]> {
		return [];
	}
	async topGroupsSince(): Promise<GroupedCostSummary[]> {
		return [];
	}
	async topUsersSince(): Promise<GroupedCostSummary[]> {
		return [];
	}
	async dailySummary(): Promise<DailyCostSummary[]> {
		return [];
	}
}

export class SqliteCostStore implements ICostStore {
	constructor(
		private db: Database.Database,
		private logger: Logger,
	) {}

	async init() {}

	async record(entry: CostLogEntry) {
		const stmt = this.db.prepare(
			`INSERT INTO cost_usage_log
       (ts, model, prompt_tokens, completion_tokens, total_tokens, latency_ms, channel_key, group_id, user_id, ok, error, estimated_cost, currency)
       VALUES (@ts, @model, @promptTokens, @completionTokens, @totalTokens, @latencyMs, @channelKey, @groupId, @userId, @ok, @error, @estimatedCost, @currency)`,
		);
		try {
			stmt.run({
				ts: entry.ts,
				model: entry.model,
				promptTokens: entry.promptTokens,
				completionTokens: entry.completionTokens,
				totalTokens: entry.totalTokens,
				latencyMs: entry.latencyMs ?? null,
				channelKey: entry.channelKey ?? null,
				groupId: entry.groupId ?? null,
				userId: entry.userId ?? null,
				ok: entry.ok ? 1 : 0,
				error: entry.error ? entry.error.slice(0, 500) : null,
				estimatedCost: entry.estimatedCost ?? null,
				currency: entry.currency ?? null,
			});
		} catch (err) {
			this.logger.warn('写入成本日志失败: %s', err);
		}
	}

	async recent(limit: number): Promise<CostLogEntry[]> {
		const rows = this.db
			.prepare(
				`SELECT ts, model, prompt_tokens as promptTokens, completion_tokens as completionTokens,
            total_tokens as totalTokens, latency_ms as latencyMs, channel_key as channelKey,
            group_id as groupId, user_id as userId, ok, error, estimated_cost as estimatedCost, currency
         FROM cost_usage_log
         ORDER BY ts DESC
         LIMIT ?`,
			)
			.all(limit) as CostLogEntry[];
		return rows.map((row) => ({ ...row, ok: !!(row as any).ok }));
	}

	async sumSince(ts: number): Promise<CostSummary> {
		const row = this.db
			.prepare(
				`SELECT
           COUNT(*) as calls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) as errors,
           SUM(prompt_tokens) as promptTokens,
           SUM(completion_tokens) as completionTokens,
           SUM(estimated_cost) as estimatedCost,
           MAX(currency) as currency
         FROM cost_usage_log
         WHERE ts >= ?`,
			)
			.get(ts) as any;
		return {
			calls: row?.calls ?? 0,
			errors: row?.errors ?? 0,
			promptTokens: row?.promptTokens ?? 0,
			completionTokens: row?.completionTokens ?? 0,
			estimatedCost: row?.estimatedCost ?? 0,
			currency: row?.currency ?? undefined,
		};
	}

	async modelSummarySince(ts: number): Promise<ModelCostSummary[]> {
		const rows = this.db
			.prepare(
				`SELECT model,
           COUNT(*) as calls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) as errors,
           SUM(prompt_tokens) as promptTokens,
           SUM(completion_tokens) as completionTokens,
           SUM(estimated_cost) as estimatedCost,
           MAX(currency) as currency
         FROM cost_usage_log
         WHERE ts >= ?
         GROUP BY model
         ORDER BY COALESCE(estimatedCost, 0) DESC, calls DESC`,
			)
			.all(ts) as any[];
		return rows.map((row) => ({
			model: row.model,
			calls: row.calls ?? 0,
			errors: row.errors ?? 0,
			promptTokens: row.promptTokens ?? 0,
			completionTokens: row.completionTokens ?? 0,
			estimatedCost: row.estimatedCost ?? 0,
			currency: row.currency ?? undefined,
		}));
	}

	async topGroupsSince(ts: number, limit: number): Promise<GroupedCostSummary[]> {
		const rows = this.db
			.prepare(
				`SELECT group_id as key,
           COUNT(*) as calls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) as errors,
           SUM(prompt_tokens) as promptTokens,
           SUM(completion_tokens) as completionTokens,
           SUM(estimated_cost) as estimatedCost,
           MAX(currency) as currency
         FROM cost_usage_log
         WHERE ts >= ? AND group_id IS NOT NULL
         GROUP BY group_id
         ORDER BY COALESCE(estimatedCost, 0) DESC, calls DESC
         LIMIT ?`,
			)
			.all(ts, limit) as any[];
		return rows.map((row) => ({
			key: row.key,
			calls: row.calls ?? 0,
			errors: row.errors ?? 0,
			promptTokens: row.promptTokens ?? 0,
			completionTokens: row.completionTokens ?? 0,
			estimatedCost: row.estimatedCost ?? 0,
			currency: row.currency ?? undefined,
		}));
	}

	async topUsersSince(ts: number, limit: number): Promise<GroupedCostSummary[]> {
		const rows = this.db
			.prepare(
				`SELECT user_id as key,
           COUNT(*) as calls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) as errors,
           SUM(prompt_tokens) as promptTokens,
           SUM(completion_tokens) as completionTokens,
           SUM(estimated_cost) as estimatedCost,
           MAX(currency) as currency
         FROM cost_usage_log
         WHERE ts >= ? AND user_id IS NOT NULL
         GROUP BY user_id
         ORDER BY COALESCE(estimatedCost, 0) DESC, calls DESC
         LIMIT ?`,
			)
			.all(ts, limit) as any[];
		return rows.map((row) => ({
			key: row.key,
			calls: row.calls ?? 0,
			errors: row.errors ?? 0,
			promptTokens: row.promptTokens ?? 0,
			completionTokens: row.completionTokens ?? 0,
			estimatedCost: row.estimatedCost ?? 0,
			currency: row.currency ?? undefined,
		}));
	}

	async dailySummary(days: number): Promise<DailyCostSummary[]> {
		const since = Date.now() - days * 24 * 60 * 60 * 1000;
		const rows = this.db
			.prepare(
				`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') as day,
           COUNT(*) as calls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) as errors,
           SUM(prompt_tokens) as promptTokens,
           SUM(completion_tokens) as completionTokens,
           SUM(estimated_cost) as estimatedCost,
           MAX(currency) as currency
         FROM cost_usage_log
         WHERE ts >= ?
         GROUP BY day
         ORDER BY day DESC`,
			)
			.all(since) as any[];
		return rows.map((row) => ({
			day: row.day,
			calls: row.calls ?? 0,
			errors: row.errors ?? 0,
			promptTokens: row.promptTokens ?? 0,
			completionTokens: row.completionTokens ?? 0,
			estimatedCost: row.estimatedCost ?? 0,
			currency: row.currency ?? undefined,
		}));
	}
}
