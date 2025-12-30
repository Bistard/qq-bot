import os from 'os';
import { execFileSync } from 'child_process';
import { BotConfig, Usage } from '../common/types';
import { IStateStore } from '../database/state-store';
import {
	ICostStore,
	CostSummary,
	ModelCostSummary,
	CostLogEntry,
	GroupedCostSummary,
} from '../database/cost-store';
import { ConversationManager } from '../bot/conversation';
import { DeepseekAccountClient, BalanceResult } from '../bot/deepseek-account';
import { Logger } from '../common/logger';

interface DiskInfo {
	path: string;
	totalBytes: number;
	usedBytes: number;
	freeBytes: number;
}

interface SystemSnapshot {
	loadAvg: number[];
	cpuPercent: number;
	memTotal: number;
	memFree: number;
	processRss: number;
	processHeapUsed: number;
	processHeapTotal: number;
	disk?: DiskInfo;
}

interface CostSnapshot {
	available: boolean;
	reason?: string;
	summary24h?: CostSummary;
	modelSummary?: ModelCostSummary[];
	topGroups?: GroupedCostSummary[];
	topUsers?: GroupedCostSummary[];
	recent?: CostLogEntry[];
}

interface StatusSnapshot {
	runtime: {
		startTime: number;
		uptimeMs: number;
		version: string;
		node: string;
	};
	system: SystemSnapshot;
	usage: Usage;
	activeSessions: number;
	cost?: CostSnapshot;
	balance?: BalanceResult;
	storageDriver: BotConfig['storageDriver'];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes)) return 'N/A';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let idx = 0;
	while (value >= 1024 && idx < units.length - 1) {
		value /= 1024;
		idx++;
	}
	return `${value.toFixed(value >= 10 || idx === 0 ? 0 : 1)}${units[idx]}`;
}

function formatDuration(ms: number): string {
	const sec = Math.floor(ms / 1000);
	const days = Math.floor(sec / 86400);
	const hours = Math.floor((sec % 86400) / 3600);
	const minutes = Math.floor((sec % 3600) / 60);
	const parts = [];
	if (days) parts.push(`${days}d`);
	if (hours) parts.push(`${hours}h`);
	if (minutes && parts.length < 2) parts.push(`${minutes}m`);
	if (!parts.length) parts.push(`${sec}s`);
	return parts.join(' ');
}

function currencySymbol(currency?: string) {
	if (!currency) return '';
	if (currency.toUpperCase() === 'CNY') return '¥';
	if (currency.toUpperCase() === 'USD') return '$';
	return `${currency} `;
}

function formatCost(amount?: number, currency?: string): string {
	if (!Number.isFinite(amount)) return '未知';
	const symbol = currencySymbol(currency);
	return `${symbol}${amount!.toFixed(2)}`;
}

function pickBalanceTotal(balance?: BalanceResult, preferredCurrency?: string): number | undefined {
	if (!balance?.data?.balance_infos?.length) return undefined;
	const infos = balance.data.balance_infos;
	const pick =
		preferredCurrency &&
		infos.find((item) => item.currency?.toUpperCase() === preferredCurrency.toUpperCase());
	const item = pick || infos[0];
	const total = Number(item.total_balance);
	return Number.isFinite(total) ? total : undefined;
}

export class StatusService {
	constructor(
		private opts: {
			config: BotConfig;
			startTime: number;
			stateStore: IStateStore;
			conversations: ConversationManager;
			costStore: ICostStore;
			balanceClient: DeepseekAccountClient;
			dataDir: string;
			logger: Logger;
		},
	) {}

	private collectSystem(): SystemSnapshot {
		const loadAvg = os.loadavg();
		const memTotal = os.totalmem();
		const memFree = os.freemem();
		const processMem = process.memoryUsage();
		const cpuUsage = process.cpuUsage();
		const cpuPercent =
			((cpuUsage.user + cpuUsage.system) / 1_000_000) /
			(Math.max(process.uptime(), 1) * os.cpus().length) *
			100;

		const disk = this.readDiskUsage(this.opts.dataDir);

		return {
			loadAvg,
			cpuPercent: Math.max(0, cpuPercent),
			memTotal,
			memFree,
			processRss: processMem.rss,
			processHeapUsed: processMem.heapUsed,
			processHeapTotal: processMem.heapTotal,
			disk,
		};
	}

	private readDiskUsage(targetPath: string): DiskInfo | undefined {
		try {
			const out = execFileSync('df', ['-Pk', targetPath], { encoding: 'utf-8' });
			const lines = out.trim().split('\n');
			if (lines.length < 2) return undefined;
			const parts = lines[lines.length - 1].trim().split(/\s+/);
			if (parts.length < 6) return undefined;
			const total = Number(parts[1]) * 1024;
			const used = Number(parts[2]) * 1024;
			const free = Number(parts[3]) * 1024;
			if (!Number.isFinite(total)) return undefined;
			return {
				path: targetPath,
				totalBytes: total,
				usedBytes: Number.isFinite(used) ? used : 0,
				freeBytes: Number.isFinite(free) ? free : 0,
			};
		} catch (err) {
			this.opts.logger.warn('获取磁盘使用失败: %s', err);
			return undefined;
		}
	}

	private async collectCost(full: boolean): Promise<CostSnapshot> {
		if (this.opts.config.storageDriver !== 'sqlite') {
			return { available: false, reason: '仅 sqlite 模式支持成本明细' };
		}
		const now = Date.now();
		const summary24h = await this.opts.costStore.sumSince(now - DAY_MS);
		const snapshot: CostSnapshot = {
			available: true,
			summary24h,
		};

		if (!full) return snapshot;

		const range7d = now - DAY_MS * 7;
		const recent = await this.opts.costStore.recent(this.opts.config.cost.recentLimit);
		const modelSummary = await this.opts.costStore.modelSummarySince(now - DAY_MS);
		const topGroups = await this.opts.costStore.topGroupsSince(range7d, 5);
		const topUsers = await this.opts.costStore.topUsersSince(range7d, 5);

		return {
			available: true,
			summary24h,
			recent,
			modelSummary,
			topGroups,
			topUsers,
		};
	}

	async collectSnapshot(fullCost: boolean): Promise<StatusSnapshot> {
		const uptimeMs = Date.now() - this.opts.startTime;
		const usage = this.opts.stateStore.getUsage();
		const balance = await this.opts.balanceClient.getBalance();
		const cost = await this.collectCost(fullCost);
		return {
			runtime: {
				startTime: this.opts.startTime,
				uptimeMs,
				version: this.opts.config.appVersion,
				node: process.version,
			},
			system: this.collectSystem(),
			usage,
			activeSessions: this.opts.conversations.activeSessions,
			cost,
			balance,
			storageDriver: this.opts.config.storageDriver,
		};
	}

	async buildText(full = true): Promise<string> {
		const snap = await this.collectSnapshot(full);
		const lines: string[] = [];
		const runtime = snap.runtime;
		const sys = snap.system;
		const loadText = sys.loadAvg.map((n) => n.toFixed(2)).join(' ');
		const memUsed = sys.memTotal - sys.memFree;
		const memFreeRatio = sys.memTotal ? (sys.memFree / sys.memTotal) * 100 : 0;
		const diskText = sys.disk
			? `${formatBytes(sys.disk.freeBytes)} free / ${formatBytes(sys.disk.totalBytes)}`
			: '未知';
		lines.push(`版本: v${runtime.version}`);
		lines.push(`启动: ${new Date(runtime.startTime).toLocaleString()}`);
		lines.push(`已运行: ${formatDuration(runtime.uptimeMs)}`);
		lines.push(`负载: ${loadText}`);
		lines.push(`CPU: ${sys.cpuPercent.toFixed(1)}%`);
		lines.push(
			`内存: ${formatBytes(memUsed)}/${formatBytes(sys.memTotal)} (${memFreeRatio.toFixed(1)}%空闲)`,
		);
		lines.push(`磁盘: ${diskText}`);
		lines.push(`活跃会话: ${snap.activeSessions}`);
		lines.push(`累计对话: ${snap.usage.messages} 轮`);
		lines.push(`Tokens: prompt ${snap.usage.promptTokens}, completion ${snap.usage.completionTokens}`);

		const balance = snap.balance;
		const balanceTotal = pickBalanceTotal(balance, this.opts.config.cost.currency);
		const balanceText = balance?.data
			? `${formatCost(balanceTotal, this.opts.config.cost.currency)}${balance?.fromCache ? ' (缓存)' : ''}`
			: `不可用${balance?.error ? `: ${balance.error}` : ''}`;
		lines.push(`DeepSeek 余额: ${balanceText}`);

		const cost = snap.cost;
		if (cost?.available && cost.summary24h) {
			const burn = cost.summary24h.estimatedCost;
			const burnText = formatCost(burn, cost.summary24h.currency || this.opts.config.cost.currency);
			lines.push(`近24h 消耗: ${burnText}`);
			if (Number.isFinite(burn) && burn! > 0 && Number.isFinite(balanceTotal)) {
				const daysLeft = (balanceTotal as number) / (burn as number);
				lines.push(`预计可用: ${daysLeft.toFixed(1)} 天`);
			}

			if (full && cost.modelSummary?.length) {
				lines.push('模型汇总(24h):');
				cost.modelSummary.slice(0, 5).forEach((m) => {
					lines.push(
						`- ${m.model}: ${formatCost(
							m.estimatedCost,
							m.currency || this.opts.config.cost.currency,
						)} (${m.calls} 次)`,
					);
				});
			}

			if (full && cost.topGroups?.length) {
				lines.push('Top 群(7d):');
				cost.topGroups.forEach((item) => {
					lines.push(
						`- ${item.key}: ${formatCost(
							item.estimatedCost,
							item.currency || this.opts.config.cost.currency,
						)}`,
					);
				});
			}

			if (full && cost.topUsers?.length) {
				lines.push('Top 用户(7d):');
				cost.topUsers.forEach((item) => {
					lines.push(
						`- ${item.key}: ${formatCost(
							item.estimatedCost,
							item.currency || this.opts.config.cost.currency,
						)}`,
					);
				});
			}

			if (full && cost.recent?.length) {
				lines.push('最近调用:');
				const recentLines = cost.recent.slice(0, this.opts.config.cost.recentLimit).map((item) => {
					const ts = new Date(item.ts).toLocaleString('zh-CN', {
						month: '2-digit',
						day: '2-digit',
						hour: '2-digit',
						minute: '2-digit',
					});
					const okFlag = item.ok ? '✅' : '⚠️';
					return `${ts} ${okFlag} ${item.model} tokens=${item.totalTokens} cost=${formatCost(
						item.estimatedCost,
						item.currency || this.opts.config.cost.currency,
					)} ${item.channelKey ?? ''}`;
				});
				lines.push(...recentLines);
			}
		} else {
			lines.push(`成本明细: 不可用${cost?.reason ? ` (${cost.reason})` : ''}`);
		}

		return lines.join('\n');
	}

	async publicPayload() {
		const snap = await this.collectSnapshot(false);
		const sys = snap.system;
		return {
			bot: this.opts.config.botName,
			version: snap.runtime.version,
			startTime: snap.runtime.startTime,
			uptimeMs: snap.runtime.uptimeMs,
			activeSessions: snap.activeSessions,
			usage: snap.usage,
			system: {
				loadAvg: sys.loadAvg,
				cpuPercent: sys.cpuPercent,
				mem: {
					total: sys.memTotal,
					free: sys.memFree,
					processRss: sys.processRss,
				},
				disk: sys.disk
					? {
							path: sys.disk.path,
							totalBytes: sys.disk.totalBytes,
							freeBytes: sys.disk.freeBytes,
						}
					: undefined,
			},
		};
	}
}
