import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import {
  appendEvent,
  getBoardEvents,
  getEvents,
  maxEventSeq,
} from "./events.ts";

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

function freshSetup(): { db: Database; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "board-events-test-"));
  dirs.push(dataDir);
  const db = openDb(dataDir);
  dbs.push(db);
  return { db, dataDir };
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("appendEvent", () => {
  test("returns events with monotonic seq across boards and parses payloads", () => {
    const { db, dataDir } = freshSetup();
    const a = appendEvent(db, dataDir, {
      actor: "human",
      type: "board.created",
      boardId: "boardA",
      payload: { title: "A", nested: { list: [1, "x"] } },
    });
    const b = appendEvent(db, dataDir, {
      actor: "agent-1",
      type: "board.published",
      boardId: "boardB",
    });
    const c = appendEvent(db, dataDir, {
      actor: "human",
      type: "comment.created",
      boardId: "boardA",
      payload: { body: "hi" },
    });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(a).toEqual({
      seq: 1,
      ts: a.ts,
      actor: "human",
      type: "board.created",
      board_id: "boardA",
      payload: { title: "A", nested: { list: [1, "x"] } },
    });
    expect(b.payload).toEqual({});
    expect(b.board_id).toBe("boardB");
    expect(a.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("global events.jsonl gets exactly one line per event, matching the rows", () => {
    const { db, dataDir } = freshSetup();
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.created",
      boardId: "x",
    });
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.published",
      boardId: "x",
      payload: { n: 1 },
    });
    appendEvent(db, dataDir, { actor: "h", type: "board.ended", boardId: "y" });
    const lines = readLines(join(dataDir, "events.jsonl"));
    const rows = getEvents(db);
    expect(lines).toHaveLength(3);
    for (const [i, line] of lines.entries()) {
      expect(JSON.parse(line)).toEqual(rows[i]);
    }
  });

  test("per-board events.jsonl mirrors only that board's events", () => {
    const { db, dataDir } = freshSetup();
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.created",
      boardId: "x",
    });
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.created",
      boardId: "y",
    });
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.published",
      boardId: "x",
      payload: { n: 1 },
    });
    const linesX = readLines(join(dataDir, "boards", "x", "events.jsonl"));
    expect(linesX).toHaveLength(2);
    const rowsX = getBoardEvents(db, "x");
    expect(linesX.map((line) => JSON.parse(line))).toEqual(rowsX);
    expect(
      readLines(join(dataDir, "boards", "y", "events.jsonl")),
    ).toHaveLength(1);
  });

  test("events without a boardId only land in the global log", () => {
    const { db, dataDir } = freshSetup();
    appendEvent(db, dataDir, { actor: "h", type: "webhook.failed" });
    expect(readLines(join(dataDir, "events.jsonl"))).toHaveLength(1);
    const dirs = readFileSync(join(dataDir, "events.jsonl"), "utf8");
    expect(dirs).toContain("webhook.failed");
  });
});

describe("getEvents", () => {
  test("since is exclusive", () => {
    const { db, dataDir } = freshSetup();
    for (let i = 0; i < 5; i++) {
      appendEvent(db, dataDir, {
        actor: "h",
        type: "board.published",
        boardId: "b",
      });
    }
    expect(getEvents(db, { since: 3 }).map((e) => e.seq)).toEqual([4, 5]);
    expect(getEvents(db, { since: 0 }).map((e) => e.seq)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(getEvents(db, { since: 5 })).toEqual([]);
  });

  test("filters by boardId", () => {
    const { db, dataDir } = freshSetup();
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.created",
      boardId: "a",
    });
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.created",
      boardId: "b",
    });
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.published",
      boardId: "a",
      payload: { n: 1 },
    });
    expect(getEvents(db, { boardId: "a" }).map((e) => e.seq)).toEqual([1, 3]);
    expect(getEvents(db, { boardId: "b" }).map((e) => e.seq)).toEqual([2]);
  });

  test("combines since, boardId and limit", () => {
    const { db, dataDir } = freshSetup();
    for (let i = 0; i < 4; i++) {
      appendEvent(db, dataDir, {
        actor: "h",
        type: "board.published",
        boardId: "a",
      });
      appendEvent(db, dataDir, {
        actor: "h",
        type: "board.published",
        boardId: "b",
      });
    }
    expect(
      getEvents(db, { since: 2, boardId: "a", limit: 2 }).map((e) => e.seq),
    ).toEqual([3, 5]);
  });

  test("limit caps results in ascending seq order", () => {
    const { db, dataDir } = freshSetup();
    for (let i = 0; i < 4; i++) {
      appendEvent(db, dataDir, {
        actor: "h",
        type: "board.published",
        boardId: "a",
      });
    }
    expect(getEvents(db, { limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
  });

  test("default limit is 200", () => {
    const { db, dataDir } = freshSetup();
    for (let i = 0; i < 205; i++) {
      appendEvent(db, dataDir, { actor: "h", type: "webhook.failed" });
    }
    const rows = getEvents(db);
    expect(rows).toHaveLength(200);
    expect(rows[0].seq).toBe(1);
    expect(rows[199].seq).toBe(200);
  });

  test("filters by exact type", () => {
    const { db, dataDir } = freshSetup();
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.created",
      boardId: "a",
    });
    appendEvent(db, dataDir, {
      actor: "agent-1",
      type: "webhook.failed",
      boardId: "a",
    });
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.published",
      boardId: "a",
      payload: { n: 1 },
    });
    expect(getEvents(db, { type: "webhook.failed" }).map((e) => e.seq)).toEqual(
      [2],
    );
    expect(getEvents(db, { type: "no.such" })).toEqual([]);
    // composes with the other filters
    expect(
      getEvents(db, { type: "board.published", boardId: "a", since: 1 }).map(
        (e) => e.seq,
      ),
    ).toEqual([3]);
  });

  test("payloads come back JSON-parsed with structure intact", () => {
    const { db, dataDir } = freshSetup();
    const payload = { n: 3, label: "v3", deep: { arr: [{ k: "v" }] } };
    appendEvent(db, dataDir, {
      actor: "agent-2",
      type: "board.published",
      boardId: "b",
      payload,
    });
    expect(getEvents(db)[0].payload).toEqual(payload);
  });
});

describe("getBoardEvents", () => {
  test("scopes to one board with an exclusive since", () => {
    const { db, dataDir } = freshSetup();
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.created",
      boardId: "a",
    });
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.created",
      boardId: "b",
    });
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.published",
      boardId: "a",
      payload: { n: 1 },
    });
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.published",
      boardId: "a",
      payload: { n: 2 },
    });
    expect(getBoardEvents(db, "a").map((e) => e.seq)).toEqual([1, 3, 4]);
    expect(getBoardEvents(db, "a", 1).map((e) => e.seq)).toEqual([3, 4]);
    expect(getBoardEvents(db, "b").map((e) => e.seq)).toEqual([2]);
  });
});

describe("maxEventSeq", () => {
  test("is the global max across boards, 0 on an empty log", () => {
    const { db, dataDir } = freshSetup();
    expect(maxEventSeq(db)).toBe(0);
    appendEvent(db, dataDir, {
      actor: "h",
      type: "board.created",
      boardId: "a",
    });
    appendEvent(db, dataDir, {
      actor: "h",
      type: "webhook.failed",
      boardId: "b",
    });
    expect(maxEventSeq(db)).toBe(2);
  });
});
