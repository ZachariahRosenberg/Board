import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-db-test-"));
  dirs.push(dir);
  return dir;
}

describe("openDb", () => {
  test("creates the data dir and board.db when missing", () => {
    const dir = join(freshDir(), "nested", "data");
    openDb(dir);
    expect(existsSync(join(dir, "board.db"))).toBe(true);
  });

  test("enables WAL journal mode", () => {
    const db = openDb(freshDir());
    const row = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(row.journal_mode).toBe("wal");
    db.close();
  });

  test("enables foreign keys and busy timeout", () => {
    const db = openDb(freshDir());
    const fk = db.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    const busy = db.prepare("PRAGMA busy_timeout").get() as {
      timeout: number;
    };
    expect(fk.foreign_keys).toBe(1);
    expect(busy.timeout).toBe(5000);
    db.close();
  });

  test("creates all tables across migrations", () => {
    const db = openDb(freshDir());
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    for (const table of [
      "boards",
      "versions",
      "comments",
      "events",
      "subscribers",
      "tokens",
      "sessions",
      "schema_migrations",
    ]) {
      expect(names).toContain(table);
    }
    db.close();
  });

  test("reopening an existing data dir is idempotent", () => {
    const dir = freshDir();
    const first: Database = openDb(dir);
    first.close();
    const second = openDb(dir);
    const migrations = second
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    expect(migrations.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    second.close();
  });

  test("rejects a second daemon-style writer cleanly via WAL (two open connections)", () => {
    const dir = freshDir();
    const a = openDb(dir);
    const b = openDb(dir);
    a.prepare(
      "INSERT INTO tokens (name, token_hash, created_at) VALUES ('a', 'h1', '2026-01-01T00:00:00Z')",
    ).run();
    const rows = b.prepare("SELECT name FROM tokens").all() as Array<{
      name: string;
    }>;
    expect(rows).toHaveLength(1);
    a.close();
    b.close();
  });
});
