/**
 * SQLite storage for discord-bot (Fase 0).
 *
 * Single file via node:sqlite (no driver dep, no Docker, no pgvector).
 * Tables mirror the botdiscord (Go) vocabulary minus the vector parts:
 * memories keep a nullable `embedding` BLOB reserved for a future
 * sqlite-vec upgrade — no migration needed when that day comes.
 *
 * Conventions (same as the Go bot):
 * - append-only migrations, tracked in `schema_migrations`
 * - WAL mode so the consolidation worker can write while the gateway reads
 * - FTS5 (unicode61, good for PT-BR) for memory + history search
 */

import { DatabaseSync } from "node:sqlite";

export const CURRENT_SCHEMA_VERSION = 2;

interface Migration {
	version: number;
	name: string;
	sql: string;
}

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "init",
		sql: `
-- Key-value config (replaces config.yaml; secrets stay in env).
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Raw message history per channel/thread.
CREATE TABLE messages (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL DEFAULT '',
  reply_to TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX messages_channel_rowid ON messages(channel_id, rowid);

-- Full-text search over message bodies ("lembra quando...").
CREATE VIRTUAL TABLE messages_fts USING fts5(
  body, author_name,
  content='messages', content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body, author_name)
  VALUES (new.rowid, new.body, new.author_name);
END;
CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, author_name)
  VALUES ('delete', old.rowid, old.body, old.author_name);
END;
CREATE TRIGGER messages_fts_update AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body, author_name)
  VALUES ('delete', old.rowid, old.body, old.author_name);
  INSERT INTO messages_fts(rowid, body, author_name)
  VALUES (new.rowid, new.body, new.author_name);
END;

-- Durable memories: kind = fact|preference|lesson|culture|episode-ref,
-- scope = group|user, status = active|contested|suppressed.
CREATE TABLE memories (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  scope TEXT NOT NULL DEFAULT 'group',
  person_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  embedding BLOB, -- reserved for future sqlite-vec; NULL until then
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (key, scope, person_id, channel_id)
);
CREATE INDEX memories_scope_status ON memories(scope, status);

-- FTS over memory contents (replaces embeddings + rerank for now).
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  content='memories', content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER memories_fts_update AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- Changelog of memory edits (creation included).
CREATE TABLE memory_versions (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'group',
  person_id TEXT NOT NULL DEFAULT '',
  channel_id TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX memory_versions_key ON memory_versions(memory_key);

-- Group stories (episodes), sources computed from messages.
CREATE TABLE episodes (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  outcome_known INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Rolling 6h summaries of raw traffic (~72h retained).
CREATE TABLE rolling_summaries (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  summary TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  UNIQUE (channel_id, window_start)
);

-- Social feedback evidence (corrections, praise, reactions, skill runs).
CREATE TABLE interaction_events (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  author_id TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX interaction_events_unprocessed
  ON interaction_events(channel_id, processed, rowid);

-- Skill usage tracking (loaded vs applied + judged result).
CREATE TABLE skill_runs (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_name TEXT NOT NULL,
  channel_id TEXT NOT NULL DEFAULT '',
  usage TEXT NOT NULL DEFAULT 'loaded',
  result TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Participation decisions, quota and open loops (follow-ups).
CREATE TABLE participation_actions (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE open_loops (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  description TEXT NOT NULL,
  source_id TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  done INTEGER NOT NULL DEFAULT 0
);

-- AI call telemetry (powers the future metrics view).
CREATE TABLE ai_requests (
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'discord',
  status TEXT NOT NULL DEFAULT 'success',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ai_requests_created ON ai_requests(created_at);
`,
	},
	{
		version: 2,
		name: "souls",
		sql: `
-- Souls: switchable personas. channel_soul picks one per channel;
-- channels without a row use the default soul (see souls.ts).
CREATE TABLE souls (
  name TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE channel_soul (
  channel_id TEXT PRIMARY KEY,
  soul_name TEXT NOT NULL
);
`,
	},
];

/** Open (or create) the bot database and run pending migrations. */
export function openDatabase(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	migrate(db);
	return db;
}

/** Current schema version applied to an open database. */
export function schemaVersion(db: DatabaseSync): number {
	db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
	const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations;").get() as { v: number };
	return row.v;
}

/** Apply pending migrations in order, each in its own transaction. */
export function migrate(db: DatabaseSync): void {
	const current = schemaVersion(db);
	for (const m of MIGRATIONS) {
		if (m.version <= current) continue;
		db.exec("BEGIN;");
		try {
			db.exec(m.sql);
			db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?);").run(m.version, m.name);
			db.exec("COMMIT;");
		} catch (err) {
			try {
				db.exec("ROLLBACK;");
			} catch {
				/* already rolled back */
			}
			throw err;
		}
	}
}
