import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
	IncomingPayload,
	OneBotConfig,
	OneBotMessageEvent,
	OneBotMessageSegment,
	ParsedMessage,
} from '../common/types';
import { Logger } from '../common/logger';

export class OneBotClient extends EventEmitter {
	private socket?: WebSocket;
	private reconnectTimer?: NodeJS.Timeout;
	private closed = false;
	private pendingActions = new Map<
		string,
		{ resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
	>();

	constructor(
		private config: OneBotConfig,
		private log: Logger,
	) {
		super();
	}

	start() {
		this.closed = false;
		this.connect();
	}

	stop() {
		this.closed = true;
		clearTimeout(this.reconnectTimer);
		this.socket?.close();
	}

	private connect() {
		this.log.info('正在连接 OneBot: %s', this.config.endpoint);
		const headers: Record<string, string> = {};
		if (this.config.token) {
			headers.Authorization = `Bearer ${this.config.token}`;
		}

		const ws = new WebSocket(this.config.endpoint, { headers });
		this.socket = ws;

		ws.on('open', () => {
			this.log.info('OneBot 连接成功');
			this.emit('ready');
		});

		ws.on('message', (data) => this.handleSocketMessage(data));

		ws.on('close', (code) => {
			this.log.warn('OneBot 连接关闭 code=%s', code);
			this.rejectAllPending('OneBot 连接已关闭');
			this.scheduleReconnect();
		});

		ws.on('error', (err) => {
			this.log.warn('OneBot 连接错误: %s', err);
			this.rejectAllPending('OneBot 连接异常');
			this.scheduleReconnect();
		});
	}

	private scheduleReconnect() {
		if (this.closed) return;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => this.connect(), this.config.reconnectIntervalMs);
	}

	private parseMessage(event: OneBotMessageEvent): IncomingPayload | null {
		const selfId = (this.config.selfId ?? event.self_id)?.toString() ?? '';
		const userId = event.user_id?.toString();
		if (!userId) return null;
		if (selfId && userId === selfId) return null;

		const segments: OneBotMessageSegment[] = Array.isArray(event.message) ? event.message : [];
		const plainText = this.extractPlainText(segments, event.raw_message);
		const mentioned = this.detectMention(segments, selfId);

		const message: ParsedMessage = {
			platform: 'onebot',
			selfId,
			userId,
			groupId: event.message_type === 'group' ? event.group_id?.toString() : undefined,
			messageId: event.message_id?.toString(),
			rawText: event.raw_message ?? plainText,
			plainText,
			segments,
			mentioned,
			isGroup: event.message_type === 'group',
			isPrivate: event.message_type === 'private',
		};

		return { event, message };
	}

	private extractPlainText(segments: OneBotMessageSegment[], fallback: string): string {
		if (!segments.length) return fallback ?? '';
		const textParts = segments
			.filter((seg) => seg.type === 'text')
			.map((seg) => seg.data?.text ?? '');
		const joined = textParts.join('');
		return joined || fallback || '';
	}

	private detectMention(segments: OneBotMessageSegment[], selfId: string): boolean {
		if (!selfId) return false;
		return segments.some(
			(seg) =>
				seg.type === 'at' &&
				(seg.data?.qq?.toString() === selfId || seg.data?.id?.toString() === selfId),
		);
	}

	async sendText(target: OneBotMessageEvent, text: string, options?: { quote?: boolean }) {
		const messageSegments: OneBotMessageSegment[] = [];
		if (options?.quote && target.message_id) {
			messageSegments.push({ type: 'reply', data: { id: target.message_id } });
		}
		messageSegments.push({ type: 'text', data: { text } });

		const action = target.message_type === 'group' ? 'send_group_msg' : 'send_private_msg';
		const params =
			target.message_type === 'group'
				? { group_id: target.group_id, message: messageSegments }
				: { user_id: target.user_id, message: messageSegments };

		await this.sendAction(action, params);
	}

	async sendTextToUser(userId: string | number, text: string) {
		const messageSegments: OneBotMessageSegment[] = [{ type: 'text', data: { text } }];
		await this.sendAction('send_private_msg', { user_id: userId, message: messageSegments });
	}

	async sendTextToGroup(groupId: string | number, text: string) {
		const messageSegments: OneBotMessageSegment[] = [{ type: 'text', data: { text } }];
		await this.sendAction('send_group_msg', { group_id: groupId, message: messageSegments });
	}

	async reactToMessage(target: OneBotMessageEvent, emojiId: string) {
		if (!target.message_id) return;
		try {
			await this.sendAction('set_msg_emoji_like', {
				message_id: target.message_id,
				emoji_id: emojiId,
			});
		} catch (err) {
			this.log.warn('设置消息回应表情失败: %s', err);
		}
	}

	private handleSocketMessage(data: WebSocket.RawData) {
		try {
			const parsed = JSON.parse(data.toString());
			if (parsed?.post_type === 'message') {
				const payload = this.parseMessage(parsed as OneBotMessageEvent);
				if (payload) {
					this.emit('message', payload);
				}
				return;
			}

			if (parsed?.echo && this.pendingActions.has(parsed.echo)) {
				const pending = this.pendingActions.get(parsed.echo)!;
				clearTimeout(pending.timer);
				this.pendingActions.delete(parsed.echo);
				if (parsed.status === 'ok' || parsed.retcode === 0) {
					pending.resolve();
				} else {
					const reason =
						parsed.message ||
						parsed.wording ||
						`OneBot 动作失败: ${parsed.status ?? parsed.retcode ?? 'unknown'}`;
					pending.reject(new Error(reason));
				}
				return;
			}
		} catch (err) {
			this.log.warn('解析 OneBot 消息失败: %s', err);
		}
	}

	private async sendAction(action: string, params: Record<string, unknown>) {
		const echo = `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const payload = JSON.stringify({ action, params, echo });
		const timeoutMs = this.config.actionTimeoutMs;

		return new Promise<void>((resolve, reject) => {
			if (this.socket?.readyState !== WebSocket.OPEN) {
				return reject(new Error('发送失败，OneBot 未连接'));
			}

			const timer = setTimeout(() => {
				this.pendingActions.delete(echo);
				reject(new Error(`OneBot 动作超时: ${action}`));
			}, timeoutMs);

			this.pendingActions.set(echo, { resolve, reject, timer });

			this.socket.send(payload, (err) => {
				if (err) {
					clearTimeout(timer);
					this.pendingActions.delete(echo);
					reject(err);
				}
			});
		});
	}

	private rejectAllPending(reason: string) {
		for (const [, pending] of this.pendingActions) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.pendingActions.clear();
	}
}
