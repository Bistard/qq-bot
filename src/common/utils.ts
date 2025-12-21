import { Logger } from './logger';

export function parseList(input?: string): string[] {
	if (!input) return [];
	return input
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

export function parsePatterns(input?: string, logger?: Logger): RegExp[] {
	if (!input) return [];
	return input
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
		.map((pattern) => {
			try {
				return new RegExp(pattern, 'i');
			} catch (err) {
				logger?.warn('无法解析敏感词正则: %s (%s)', pattern, err);
				return null;
			}
		})
		.filter(Boolean) as RegExp[];
}

export function toNumber(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function chunkMessage(text: string, size = 900): string[] {
	const chunks: string[] = [];
	let current = text;
	while (current.length > size) {
		chunks.push(current.slice(0, size));
		current = current.slice(size);
	}
	if (current.length) {
		chunks.push(current);
	}
	return chunks;
}
