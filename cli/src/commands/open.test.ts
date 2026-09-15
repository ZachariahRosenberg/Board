import type { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../../server/src/config.ts";
import { openDb } from "../../../server/src/db.ts";
import { runOpenCommand } from "./open.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FreshDb {
  db: Database;
  dataDir: string;
}

// Tests never touch the real ~/.board — always a fresh temp data dir (AGENTS.md).
function freshDb(): FreshDb {
  const dataDir = mkdtempSync(join(tmpdir(), "board-cli-open-test-"));
  dirs.push(dataDir);
  return { db: openDb(dataDir), dataDir };
}

function testConfig(dataDir: string): Config {
  return {
    dataDir,
    host: "127.0.0.1",
    port: 7800,
    originPort: 7801,
    bind: ["127.0.0.1"],
  };
}

interface Capture {
  out: string[];
  err: string[];
  opened: string[];
}

function capture(dataDir: string): Capture & {
  run(argv: string[]): number;
} {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const db = openDb(dataDir);
  const run = (argv: string[]): number =>
    runOpenCommand({
      db,
      argv,
      config: testConfig(dataDir),
      io: {
        stdout: (text) => {
          out.push(text);
        },
        stderr: (text) => {
          err.push(text);
        },
      },
      openUrl: (url) => {
        opened.push(url);
      },
    });
  return { out, err, opened, run };
}

const URL_RE = /^http:\/\/127\.0\.0\.1:7800\/\?token=([A-Za-z0-9_-]{43})$/;
const URL_WITH_BOARD_RE =
  /^http:\/\/127\.0\.0\.1:7800\/\?token=([A-Za-z0-9_-]{43})#\/boards\/([0-9A-Za-z]+)$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("board open", () => {
  test("prints a well-formed URL carrying the token exactly once and opens it", () => {
    const { db, dataDir } = freshDb();
    const cap = capture(dataDir);
    const code = cap.run([]);
    expect(code).toBe(0);
    expect(cap.err).toEqual([]);
    expect(cap.out).toHaveLength(1);
    const url = cap.out[0] ?? "";
    expect(url).toMatch(URL_RE);
    const token = URL_RE.exec(url)?.[1] ?? "";
    expect(token).not.toBe("");
    expect(cap.out.join("\n").split(token)).toHaveLength(2);
    expect(cap.opened).toEqual([url]);
    db.close();
  });

  test("the printed exchange token is stored hashed with kind exchange", () => {
    const { db, dataDir } = freshDb();
    const cap = capture(dataDir);
    cap.run([]);
    const token = URL_RE.exec(cap.out[0] ?? "")?.[1] ?? "";
    const row = db
      .prepare("SELECT kind, token_hash FROM sessions WHERE token_hash = ?")
      .get(sha256(token)) as { kind: string; token_hash: string } | undefined;
    expect(row?.kind).toBe("exchange");
    expect(cap.out.join("\n")).not.toContain(row?.token_hash ?? "");
    db.close();
  });

  test("board open <ID> deep-links via #/boards/<ID> and records board_id", () => {
    const { db, dataDir } = freshDb();
    const cap = capture(dataDir);
    const code = cap.run(["ab12cd34ef"]);
    expect(code).toBe(0);
    const url = cap.out[0] ?? "";
    expect(url).toMatch(URL_WITH_BOARD_RE);
    expect(URL_WITH_BOARD_RE.exec(url)?.[2]).toBe("ab12cd34ef");
    const token = URL_WITH_BOARD_RE.exec(url)?.[1] ?? "";
    const row = db
      .prepare("SELECT board_id FROM sessions WHERE token_hash = ?")
      .get(sha256(token)) as { board_id: string | null } | undefined;
    expect(row?.board_id).toBe("ab12cd34ef");
    expect(cap.opened).toEqual([url]);
    db.close();
  });

  test("without an ID the URL has no hash fragment", () => {
    const { db, dataDir } = freshDb();
    const cap = capture(dataDir);
    cap.run([]);
    expect(cap.out[0] ?? "").not.toContain("#");
    db.close();
  });
});
