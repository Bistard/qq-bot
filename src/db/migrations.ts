import Database from 'better-sqlite3';
import { Logger } from '../logger';

interface Migration {
	id: string;
	statements: string[];
}

const MIGRATIONS: Migration[] = [
	{
		id: '001_init_state',
		statements: [
			`CREATE TABLE IF NOT EXISTS state_acl (
        user_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('allow', 'deny')),
        updated_at INTEGER NOT NULL
      );`,
			`CREATE INDEX IF NOT EXISTS idx_state_acl_status ON state_acl(status);`,
			`CREATE TABLE IF NOT EXISTS state_muted_channels (
        channel_key TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      );`,
			`CREATE TABLE IF NOT EXISTS state_usage_total (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        messages INTEGER NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );`,
			`INSERT INTO state_usage_total (id, messages, prompt_tokens, completion_tokens, updated_at)
       VALUES (1, 0, 0, 0, CAST(strftime('%s','now') AS INTEGER) * 1000)
       ON CONFLICT(id) DO NOTHING;`,
		],
	},
	{
		id: '002_sessions',
		statements: [
			`CREATE TABLE IF NOT EXISTS mem_sessions (
        session_key TEXT PRIMARY KEY,
        persona TEXT,
        summary TEXT,
        summary_updated_at INTEGER,
        last_message_ts INTEGER,
        updated_at INTEGER NOT NULL
      );`,
			`CREATE TABLE IF NOT EXISTS mem_session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        summary TEXT NOT NULL
      );`,
			`CREATE INDEX IF NOT EXISTS idx_mem_summary_session_time ON mem_session_summaries(session_key, created_at);`,
		],
	},
	{
		id: '003_messages',
		statements: [
			`CREATE TABLE IF NOT EXISTS msg_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL DEFAULT 'onebot',
        channel_key TEXT NOT NULL,
        user_id TEXT NOT NULL,
        group_id TEXT,
        message_id TEXT,
        ts INTEGER NOT NULL,
        plain_text TEXT NOT NULL,
        is_bot INTEGER NOT NULL DEFAULT 0
      );`,
			`CREATE INDEX IF NOT EXISTS idx_msg_channel_ts ON msg_messages(channel_key, ts);`,
			`CREATE INDEX IF NOT EXISTS idx_msg_user_ts ON msg_messages(user_id, ts);`,
			`CREATE VIRTUAL TABLE IF NOT EXISTS msg_messages_fts USING fts5(
        plain_text,
        user_id,
        channel_key,
        content='msg_messages',
        content_rowid='id'
      );`,
		],
	},
];

export function runMigrations(db: Database.Database, logger: Logger) {
	db.exec(
		`CREATE TABLE IF NOT EXISTS meta_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );`,
	);
	const appliedRows = db.prepare(`SELECT id FROM meta_migrations`).all() as { id: string }[];
	const applied = new Set(appliedRows.map((row) => row.id));

	for (const migration of MIGRATIONS) {
		if (applied.has(migration.id)) continue;
		const apply = db.transaction(() => {
			for (const sql of migration.statements) {
				db.exec(sql);
			}
			db.prepare(`INSERT INTO meta_migrations (id, applied_at) VALUES (?, ?)`).run(
				migration.id,
				Date.now(),
			);
		});
		apply();
		logger.info('已应用数据库迁移: %s', migration.id);
	}
}
