import fs from 'fs';
import path from 'path';
import { StoredState, Usage } from './types';

export interface IStore {
	init(): Promise<void>;
	getUsage(): Usage;
	recordUsage(delta: Partial<Usage>): Promise<void | undefined>;
	isMuted(channelKey: string): boolean;
	mute(channelKey: string): Promise<void | undefined>;
	unmute(channelKey: string): Promise<void | undefined>;
	allow(userId: string): Promise<void | undefined>;
	deny(userId: string): Promise<void | undefined>;
	isDenied(userId?: string): boolean;
	isAllowed(userId: string, admins: Set<string>, whitelistMode: boolean): boolean;
	listAllowed(): string[];
	listDenied(): string[];
}

export class PersistentStore implements IStore {
	private statePath: string;
	private state: StoredState;

	constructor(private dir: string, allowSeeds: Set<string>, denySeeds: Set<string>) {
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
				// 使用默认值
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
		return this.save();
	}

	isMuted(channelKey: string): boolean {
		return this.state.mutedChannels.includes(channelKey);
	}

	async mute(channelKey: string) {
		if (!this.isMuted(channelKey)) {
			this.state.mutedChannels.push(channelKey);
			return this.save();
		}
	}

	async unmute(channelKey: string) {
		this.state.mutedChannels = this.state.mutedChannels.filter((id) => id !== channelKey);
		return this.save();
	}

	async allow(userId: string) {
		if (!this.state.whitelist.includes(userId)) {
			this.state.whitelist.push(userId);
			this.state.blacklist = this.state.blacklist.filter((id) => id !== userId);
			return this.save();
		}
	}

	async deny(userId: string) {
		if (!this.state.blacklist.includes(userId)) {
			this.state.blacklist.push(userId);
			this.state.whitelist = this.state.whitelist.filter((id) => id !== userId);
			return this.save();
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
