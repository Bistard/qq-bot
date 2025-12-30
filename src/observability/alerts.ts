import { BotConfig } from '../common/types';
import { StatusService } from './status-service';
import { ICostStore } from '../database/cost-store';
import { DeepseekAccountClient } from '../bot/deepseek-account';
import { OneBotClient } from '../adapters/onebot';
import { Logger } from '../common/logger';

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

function currencySymbol(currency?: string) {
	if (!currency) return '';
	if (currency.toUpperCase() === 'CNY') return '¥';
	if (currency.toUpperCase() === 'USD') return '$';
	return `${currency} `;
}

function formatCost(amount?: number, currency?: string): string {
	if (!Number.isFinite(amount)) return '未知';
	return `${currencySymbol(currency)}${amount!.toFixed(2)}`;
}

export class AlertManager {
	private timer?: NodeJS.Timeout;
	private lastSent = new Map<string, number>();

	constructor(
		private opts: {
			config: BotConfig;
			statusService: StatusService;
			costStore: ICostStore;
			balanceClient: DeepseekAccountClient;
			onebot: OneBotClient;
			admins: Set<string>;
			logger: Logger;
		},
	) {}

	start() {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.tick();
		}, 60_000);
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
	}

	private shouldSend(key: string, now: number): boolean {
		const last = this.lastSent.get(key) ?? 0;
		if (now - last < this.opts.config.alerts.cooldownMs) return false;
		this.lastSent.set(key, now);
		return true;
	}

	private async sendAlert(message: string) {
		const targets: Array<Promise<void>> = [];
		for (const admin of this.opts.admins) {
			targets.push(
				this.opts.onebot
					.sendTextToUser(admin, message)
					.catch((err) => this.opts.logger.warn('发送告警给管理员 %s 失败: %s', admin, err)),
			);
		}
		if (this.opts.config.alerts.targetGroupId) {
			targets.push(
				this.opts.onebot
					.sendTextToGroup(this.opts.config.alerts.targetGroupId, message)
					.catch((err) =>
						this.opts.logger.warn('发送告警到群 %s 失败: %s', this.opts.config.alerts.targetGroupId, err),
					),
			);
		}
		await Promise.all(targets);
	}

	private pickBalanceTotal(balance: Awaited<ReturnType<DeepseekAccountClient['getBalance']>>) {
		const infos = balance.data?.balance_infos;
		if (!infos?.length) return undefined;
		const preferred = this.opts.config.cost.currency;
		const item =
			infos.find((info) => info.currency?.toUpperCase() === preferred.toUpperCase()) ?? infos[0];
		const total = Number(item.total_balance);
		return Number.isFinite(total) ? total : undefined;
	}

	private async tick() {
		const now = Date.now();
		const snapshot = await this.opts.statusService.collectSnapshot(false);
		const disk = snapshot.system.disk;
		const alerts = this.opts.config.alerts;

		// Disk
		if (alerts.diskFreeBytes && disk && disk.freeBytes < alerts.diskFreeBytes) {
			if (this.shouldSend('disk', now)) {
				await this.sendAlert(
					`[告警] 磁盘剩余 ${formatBytes(disk.freeBytes)}，低于阈值 ${formatBytes(alerts.diskFreeBytes)}。`,
				);
			}
		}

		// Memory
		if (alerts.memFreeRatio) {
			const ratio = snapshot.system.memFree / Math.max(snapshot.system.memTotal, 1);
			if (ratio < alerts.memFreeRatio) {
				if (this.shouldSend('mem', now)) {
					await this.sendAlert(
						`[告警] 系统可用内存 ${(ratio * 100).toFixed(1)}% 低于阈值 ${(alerts.memFreeRatio * 100).toFixed(1)}%。`,
					);
				}
			}
		}

		// Balance
		if (alerts.balanceLow !== undefined) {
			const balance = await this.opts.balanceClient.getBalance();
			const total = this.pickBalanceTotal(balance);
			if (Number.isFinite(total) && (total as number) < alerts.balanceLow) {
				if (this.shouldSend('balance', now)) {
					await this.sendAlert(
						`[告警] DeepSeek 余额 ${formatCost(total, this.opts.config.cost.currency)} 低于阈值 ${formatCost(
							alerts.balanceLow,
							this.opts.config.cost.currency,
						)}。`,
					);
				}
			}
		}

		// Error rate
		if (alerts.errorRateThreshold !== undefined) {
			const windowMs = alerts.errorRateWindowMinutes * 60 * 1000;
			const summary = await this.opts.costStore.sumSince(now - windowMs);
			if (summary.calls >= 5 && summary.errors / summary.calls > alerts.errorRateThreshold) {
				if (this.shouldSend('errorRate', now)) {
					await this.sendAlert(
						`[告警] 近 ${alerts.errorRateWindowMinutes} 分钟 DeepSeek 错误率 ${((
							summary.errors /
							summary.calls
						) *
							100).toFixed(1)}% （${summary.errors}/${summary.calls}）。`,
					);
				}
			}
		}
	}
}
