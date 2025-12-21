import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Logger } from '../common/logger';
import { StoredState, Usage } from '../common/types';

export interface IStateStore {
	init(): Promise<void>;
	getUsage(): Usage;
	recordUsage(delta: Partial<Usage>): Promise<void>;
	isMuted(channelKey: string): boolean;
	mute(channelKey: string): Promise<void>;
	unmute(channelKey: string): Promise<void>;
	allow(userId: string): Promise<void>;
	deny(userId: string): Promise<void>;
	isDenied(userId?: string): boolean;
	isAllowed(userId: string, admins: Set<string>, whitelistMode: boolean): boolean;
	listAllowed(): string[];
	listDenied(): string[];
}

class JsonStateStore implements IStateStore {
	private statePath: string;
	private state: StoredState;

	constructor(
		private dir: string,
		allowSeeds: Set<string>,
		denySeeds: Set<string>,
	) {
		this.statePath = path.join(dir, 'state.json');
		this.state = {
			whitelist: [...allowSeeds],
			blacklist: [...denySeeds],
			mutedChannels: [],
			usage: { messages: 0, promptTokens: 0, completionTokens: 0 },
		};
	}

	async init() {
		await fs.promises.mkdir(this.dir, { recursive: true });
		if (fs.existsSync(this.statePath)) {
			try {
				const raw = await fs.promises.readFile(this.statePath, 'utf-8');
				const parsed = JSON.parse(raw) as StoredState;
				this.state = {
					whitelist: parsed.whitelist ?? [],
					blacklist: parsed.blacklist ?? [],
					mutedChannels: parsed.mutedChannels ?? [],
					usage: parsed.usage ?? { messages: 0, promptTokens: 0, completionTokens: 0 },
				};
			} catch {
				// keep defaults
			}
		} else {
			await this.save();
		}
	}

	getUsage(): Usage {
		return this.state.usage;
	}

	async recordUsage(delta: Partial<Usage>) {
		this.state.usage.messages += delta.messages ?? 0;
		this.state.usage.promptTokens += delta.promptTokens ?? 0;
		this.state.usage.completionTokens += delta.completionTokens ?? 0;
		await this.save();
	}

	isMuted(channelKey: string): boolean {
		return this.state.mutedChannels.includes(channelKey);
	}

	async mute(channelKey: string) {
		if (!this.isMuted(channelKey)) {
			this.state.mutedChannels.push(channelKey);
			await this.save();
		}
	}

	async unmute(channelKey: string) {
		this.state.mutedChannels = this.state.mutedChannels.filter((id) => id !== channelKey);
		await this.save();
	}

	async allow(userId: string) {
		if (!this.state.whitelist.includes(userId)) {
			this.state.whitelist.push(userId);
			this.state.blacklist = this.state.blacklist.filter((id) => id !== userId);
			await this.save();
		}
	}

	async deny(userId: string) {
		if (!this.state.blacklist.includes(userId)) {
			this.state.blacklist.push(userId);
			this.state.whitelist = this.state.whitelist.filter((id) => id !== userId);
			await this.save();
		}
	}

	isDenied(userId?: string): boolean {
		if (!userId) return true;
		return this.state.blacklist.includes(userId);
	}

	isAllowed(userId: string, admins: Set<string>, whitelistMode: boolean): boolean {
		if (!userId) return false;
		if (admins.has(userId)) return true;
		if (this.state.blacklist.includes(userId)) return false;
		if (!whitelistMode) return true;
		return this.state.whitelist.includes(userId);
	}

	listAllowed(): string[] {
		return this.state.whitelist;
	}

	listDenied(): string[] {
		return this.state.blacklist;
	}

	private async save() {
		await fs.promises.mkdir(this.dir, { recursive: true });
		await fs.promises.writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
	}
}

class SqliteStateStore implements IStateStore {
	constructor(
		private db: Database.Database,
		private allowSeeds: Set<string>,
		private denySeeds: Set<string>,
		private logger: Logger,
	) {}

	async init() {
		this.seedFromEnv();
	}

	getUsage(): Usage {
		const row = this.db
			.prepare(
				`SELECT messages, prompt_tokens AS promptTokens, completion_tokens AS completionTokens FROM state_usage_total WHERE id = 1`,
			)
			.get() as { messages: number; promptTokens: number; completionTokens: number };
		return (
			row ?? {
				messages: 0,
				promptTokens: 0,
				completionTokens: 0,
			}
		);
	}

	async recordUsage(delta: Partial<Usage>) {
		const now = Date.now();
		this.db
			.prepare(
				`UPDATE state_usage_total
         SET messages = messages + @messages,
             prompt_tokens = prompt_tokens + @promptTokens,
             completion_tokens = completion_tokens + @completionTokens,
             updated_at = @updatedAt
         WHERE id = 1`,
			)
			.run({
				messages: delta.messages ?? 0,
				promptTokens: delta.promptTokens ?? 0,
				completionTokens: delta.completionTokens ?? 0,
				updatedAt: now,
			});
	}

	isMuted(channelKey: string): boolean {
		const row = this.db
			.prepare(`SELECT 1 FROM state_muted_channels WHERE channel_key = ? LIMIT 1`)
			.get(channelKey);
		return !!row;
	}

	async mute(channelKey: string) {
		const now = Date.now();
		this.db
			.prepare(
				`INSERT INTO state_muted_channels (channel_key, updated_at)
         VALUES (?, ?)
         ON CONFLICT(channel_key) DO UPDATE SET updated_at=excluded.updated_at`,
			)
			.run(channelKey, now);
	}

	async unmute(channelKey: string) {
		this.db.prepare(`DELETE FROM state_muted_channels WHERE channel_key = ?`).run(channelKey);
	}

	async allow(userId: string) {
		const now = Date.now();
		const stmt = this.db.prepare(
			`INSERT INTO state_acl (user_id, status, updated_at)
       VALUES (?, 'allow', ?)
       ON CONFLICT(user_id) DO UPDATE SET status='allow', updated_at=excluded.updated_at`,
		);
		stmt.run(userId, now);
	}

	async deny(userId: string) {
		const now = Date.now();
		const stmt = this.db.prepare(
			`INSERT INTO state_acl (user_id, status, updated_at)
       VALUES (?, 'deny', ?)
       ON CONFLICT(user_id) DO UPDATE SET status='deny', updated_at=excluded.updated_at`,
		);
		stmt.run(userId, now);
	}

	isDenied(userId?: string): boolean {
		if (!userId) return true;
		const row = this.db
			.prepare(`SELECT status FROM state_acl WHERE user_id = ? LIMIT 1`)
			.get(userId) as { status: string } | undefined;
		return row?.status === 'deny';
	}

	isAllowed(userId: string, admins: Set<string>, whitelistMode: boolean): boolean {
		if (!userId) return false;
		if (admins.has(userId)) return true;
		const row = this.db
			.prepare(`SELECT status FROM state_acl WHERE user_id = ? LIMIT 1`)
			.get(userId) as { status: string } | undefined;
		if (row?.status === 'deny') return false;
		if (!whitelistMode) return true;
		return row?.status === 'allow';
	}

	listAllowed(): string[] {
		const rows = this.db
			.prepare(`SELECT user_id FROM state_acl WHERE status = 'allow' ORDER BY user_id`)
			.all() as { user_id: string }[];
		return rows.map((r) => r.user_id);
	}

	listDenied(): string[] {
		const rows = this.db
			.prepare(`SELECT user_id FROM state_acl WHERE status = 'deny' ORDER BY user_id`)
			.all() as { user_id: string }[];
		return rows.map((r) => r.user_id);
	}

	private seedFromEnv() {
		const now = Date.now();
		const insert = this.db.prepare(
			`INSERT INTO state_acl (user_id, status, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at`,
		);
		for (const user of this.allowSeeds) {
			insert.run(user, 'allow', now);
		}
		for (const user of this.denySeeds) {
			insert.run(user, 'deny', now);
		}
	}
}

export function createStateStore(
	driver: 'json' | 'sqlite',
	options: {
		dataDir: string;
		allowSeeds: Set<string>;
		denySeeds: Set<string>;
		db?: Database.Database;
		logger: Logger;
	},
): IStateStore {
	if (driver === 'sqlite') {
		if (!options.db) throw new Error('SQLite store 需要提供 db 实例');
		return new SqliteStateStore(
			options.db,
			options.allowSeeds,
			options.denySeeds,
			options.logger,
		);
	}
	return new JsonStateStore(options.dataDir, options.allowSeeds, options.denySeeds);
}
