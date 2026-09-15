import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Full v1 schema per docs/plan.md "Data model". Append new migrations; never edit old ones.
const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE boards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('markdown', 'html')),
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'ended')),
        tags TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE versions (
        board_id TEXT NOT NULL REFERENCES boards (id),
        n INTEGER NOT NULL,
        label TEXT,
        note TEXT,
        content TEXT NOT NULL,
        source_md TEXT,
        anchors TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (board_id, n)
      );

      CREATE TABLE comments (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards (id),
        version_n INTEGER NOT NULL,
        anchor TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        in_reply_to TEXT REFERENCES comments (id),
        created_at TEXT NOT NULL,
        edited_at TEXT,
        resolved_at TEXT,
        resolved_by TEXT
      );
      CREATE INDEX idx_comments_board_created ON comments (board_id, created_at);

      -- AUTOINCREMENT so seq values are never reused, even hypothetically post-delete — events are append-only (invariant 5).
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        actor TEXT NOT NULL,
        type TEXT NOT NULL,
        board_id TEXT,
        payload TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX idx_events_board_seq ON events (board_id, seq);

      CREATE TABLE subscribers (
        board_id TEXT NOT NULL REFERENCES boards (id),
        agent TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('sse', 'cursor', 'webhook')),
        webhook_url TEXT,
        secret TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (board_id, agent, kind)
      );

      CREATE TABLE tokens (
        name TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );
    `,
  },
  {
    // docs/security.md "human browser session": one-time exchange tokens minted
    // by `board open` and the resulting browser sessions. Only sha256 lives
    // here — plaintext exists solely in the minting call's return (invariant 8).
    version: 2,
    sql: `
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('exchange', 'session')),
        created_at TEXT NOT NULL,
        expires_at TEXT,
        used_at TEXT,
        board_id TEXT
      );
    `,
  },
];

export function openDb(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "board.db"));
  // WAL: concurrent daemon + CLI access; busy_timeout rides along with it.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const appliedRows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => row.version));
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, new Date().toISOString());
    });
    run();
  }
}
