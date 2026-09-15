import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { newBoardId, shortId } from "./ids.ts";

const dirs: string[] = [];
const dbs: Database[] = [];

afterAll(() => {
  for (const db of dbs) {
    db.close();
  }
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "board-ids-test-"));
  dirs.push(dir);
  const db = openDb(dir);
  dbs.push(db);
  return db;
}

describe("shortId", () => {
  test("defaults to 10 characters", () => {
    expect(shortId()).toHaveLength(10);
  });

  test("honors a custom length", () => {
    expect(shortId(16)).toHaveLength(16);
    expect(shortId(1)).toHaveLength(1);
  });

  test("only contains base62 characters", () => {
    for (let i = 0; i < 200; i++) {
      expect(shortId()).toMatch(/^[0-9A-Za-z]+$/);
    }
  });

  test("10k draws are all unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(shortId());
    }
    expect(seen.size).toBe(10_000);
  });
});

describe("newBoardId", () => {
  test("returns an id that is not present in the boards table", () => {
    const db = freshDb();
    const id = newBoardId(db);
    expect(id).toMatch(/^[0-9A-Za-z]{10}$/);
    const row = db.prepare("SELECT id FROM boards WHERE id = ?").get(id) as {
      id: string;
    } | null;
    expect(row).toBeNull();
    expect(existsSync(id)).toBe(false);
  });

  test("retries past collisions injected via the exists seam", () => {
    const db = freshDb();
    let seen = 0;
    const firstTwoExist = (_id: string): boolean => {
      seen++;
      return seen <= 2;
    };
    const id = newBoardId(db, firstTwoExist);
    expect(seen).toBe(3);
    expect(id).toMatch(/^[0-9A-Za-z]{10}$/);
  });

  test("gives up after 5 retries and throws", () => {
    const db = freshDb();
    let calls = 0;
    const alwaysExists = (_id: string): boolean => {
      calls++;
      return true;
    };
    expect(() => newBoardId(db, alwaysExists)).toThrow();
    expect(calls).toBe(6);
  });

  test("the default checker actually consults the boards table", () => {
    const db = freshDb();
    const id = newBoardId(db);
    db.prepare(
      "INSERT INTO boards (id, title, format, created_by, created_at) VALUES (?, 't', 'markdown', 'a', '2026-01-01T00:00:00Z')",
    ).run(id);
    const second = newBoardId(db);
    expect(second).not.toBe(id);
  });
});
