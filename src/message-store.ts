import Database from 'better-sqlite3'
import { Logger } from './logger'

export interface MessageLogEntry {
  channelKey: string
  userId: string
  groupId?: string
  messageId?: string
  ts?: number
  plainText: string
  isBot?: boolean
}

export interface SearchResult {
  text: string
  userId: string
  channelKey: string
  ts: number
}

export interface IMessageStore {
  init(): Promise<void>
  log(entry: MessageLogEntry): Promise<void>
  search(keyword: string, options?: { limit?: number; channelKey?: string; days?: number }): Promise<SearchResult[]>
}

export class NullMessageStore implements IMessageStore {
  async init() {}
  async log() {}
  async search(): Promise<SearchResult[]> {
    return []
  }
}

export class SqliteMessageStore implements IMessageStore {
  constructor(private db: Database.Database, private logger: Logger) {}

  async init() {}

  async log(entry: MessageLogEntry) {
    const ts = entry.ts ?? Date.now()
    const insertMain = this.db.prepare(
      `INSERT INTO msg_messages (platform, channel_key, user_id, group_id, message_id, ts, plain_text, is_bot)
       VALUES ('onebot', @channelKey, @userId, @groupId, @messageId, @ts, @plainText, @isBot)`,
    )
    const insertFts = this.db.prepare(
      `INSERT INTO msg_messages_fts (rowid, plain_text, user_id, channel_key)
       VALUES (?, ?, ?, ?)`,
    )

    const run = this.db.transaction(() => {
      const info = insertMain.run({
        channelKey: entry.channelKey,
        userId: entry.userId,
        groupId: entry.groupId ?? null,
        messageId: entry.messageId ?? null,
        ts,
        plainText: entry.plainText,
        isBot: entry.isBot ? 1 : 0,
      })
      insertFts.run(info.lastInsertRowid as number, entry.plainText, entry.userId, entry.channelKey)
    })
    try {
      run()
    } catch (err) {
      this.logger.warn('写入消息日志失败: %s', err)
    }
  }

  async search(keyword: string, options?: { limit?: number; channelKey?: string; days?: number }) {
    const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100)
    const baseConditions: string[] = []
    const baseParams: any[] = []

    if (options?.channelKey) {
      baseConditions.push('m.channel_key = ?')
      baseParams.push(options.channelKey)
    }
    if (options?.days && options.days > 0) {
      const tsBoundary = Date.now() - options.days * 24 * 60 * 60 * 1000
      baseConditions.push('m.ts >= ?')
      baseParams.push(tsBoundary)
    }

    // 1) 首选 FTS5（最快）
    const ftsConditions = [...baseConditions, 'msg_messages_fts MATCH ?']
    const ftsWhereSql = `WHERE ${ftsConditions.join(' AND ')}`
    const ftsParams = [...baseParams, keyword, limit]
    const ftsSql = `
      SELECT m.plain_text as text, m.user_id as userId, m.channel_key as channelKey, m.ts
      FROM msg_messages_fts
      JOIN msg_messages m ON m.id = msg_messages_fts.rowid
      ${ftsWhereSql}
      ORDER BY m.ts DESC
      LIMIT ?
    `

    try {
      const rows = this.db.prepare(ftsSql).all(...ftsParams) as SearchResult[]
      if (rows.length) return rows
    } catch (err) {
      this.logger.warn('FTS 搜索失败，将尝试 LIKE: %s', err)
    }

    // 2) 回退：LIKE 模糊匹配（便于中文无分词、或异常时兜底）
    const escaped = keyword.replace(/[%_\\]/g, '\\$&')
    const likeKeyword = `%${escaped}%`
    const likeConditions = [...baseConditions, `m.plain_text LIKE ? ESCAPE '\\'`]
    const likeWhereSql = `WHERE ${likeConditions.join(' AND ')}`
    const likeParams = [...baseParams, likeKeyword, limit]
    const likeSql = `
      SELECT m.plain_text as text, m.user_id as userId, m.channel_key as channelKey, m.ts
      FROM msg_messages m
      ${likeWhereSql}
      ORDER BY m.ts DESC
      LIMIT ?
    `

    const fallbackRows = this.db.prepare(likeSql).all(...likeParams) as SearchResult[]
    return fallbackRows
  }
}
