import Database from 'better-sqlite3'
import { Logger } from './logger'

export interface SessionMeta {
  summary?: string
  summaryUpdatedAt?: number
  persona?: string
}

export interface ISessionStore {
  init(): Promise<void>
  get(sessionKey: string): Promise<SessionMeta | undefined>
  saveSummary(sessionKey: string, summary: string): Promise<void>
  savePersona(sessionKey: string, persona?: string): Promise<void>
  clear(sessionKey: string): Promise<void>
}

export class NullSessionStore implements ISessionStore {
  async init() {}
  async get(): Promise<SessionMeta | undefined> {
    return undefined
  }
  async saveSummary() {}
  async savePersona() {}
  async clear() {}
}

export class SqliteSessionStore implements ISessionStore {
  constructor(private db: Database.Database, private logger: Logger) {}

  async init() {}

  async get(sessionKey: string): Promise<SessionMeta | undefined> {
    const row = this.db
      .prepare(
        `SELECT summary, summary_updated_at AS summaryUpdatedAt, persona
         FROM mem_sessions WHERE session_key = ? LIMIT 1`,
      )
      .get(sessionKey) as SessionMeta | undefined
    return row ?? undefined
  }

  async saveSummary(sessionKey: string, summary: string) {
    const now = Date.now()
    const upsert = this.db.prepare(
      `INSERT INTO mem_sessions (session_key, summary, summary_updated_at, updated_at)
       VALUES (@sessionKey, @summary, @summaryUpdatedAt, @updatedAt)
       ON CONFLICT(session_key) DO UPDATE SET summary=@summary, summary_updated_at=@summaryUpdatedAt, updated_at=@updatedAt`,
    )
    const insertHistory = this.db.prepare(
      `INSERT INTO mem_session_summaries (session_key, created_at, summary) VALUES (?, ?, ?)`,
    )
    const run = this.db.transaction(() => {
      upsert.run({
        sessionKey,
        summary,
        summaryUpdatedAt: now,
        updatedAt: now,
      })
      insertHistory.run(sessionKey, now, summary)
    })
    run()
  }

  async savePersona(sessionKey: string, persona?: string) {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO mem_sessions (session_key, persona, updated_at)
         VALUES (@sessionKey, @persona, @updatedAt)
         ON CONFLICT(session_key) DO UPDATE SET persona=@persona, updated_at=@updatedAt`,
      )
      .run({ sessionKey, persona: persona ?? null, updatedAt: now })
  }

  async clear(sessionKey: string) {
    const run = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM mem_sessions WHERE session_key = ?`).run(sessionKey)
      this.db.prepare(`DELETE FROM mem_session_summaries WHERE session_key = ?`).run(sessionKey)
    })
    run()
  }
}
