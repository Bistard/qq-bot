import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
import { Logger } from '../logger'
import { runMigrations } from './migrations'

export function openDatabase(dbPath: string, logger: Logger): Database.Database {
  const resolved = path.resolve(dbPath)
  const dir = path.dirname(resolved)
  fs.mkdirSync(dir, { recursive: true })
  const db = new Database(resolved)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  runMigrations(db, logger)
  logger.info('SQLite 已打开: %s', resolved)
  return db
}
