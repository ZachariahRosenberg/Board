import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-cli-main-test-"));
  dirs.push(dir);
  return dir;
}

interface Proc {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Proc {
  const proc = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "main.ts"), ...args],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("board cli", () => {
  test("subprocess: token add exits 0 and prints a token exactly once", () => {
    const dir = freshDir();
    const proc = runCli(["token", "add", "smoke"], { BOARD_DATA_DIR: dir });
    expect(proc.exitCode).toBe(0);
    const token = proc.stdout
      .split("\n")
      .find((line) => /^[A-Za-z0-9_-]{43}$/.test(line));
    expect(token).toBeDefined();
    expect(proc.stdout.split(token ?? "")).toHaveLength(2);
    expect(proc.stdout).toContain("not recoverable");
    expect(proc.stderr).toBe("");
  });

  test("subprocess: board open prints a one-time exchange URL on the default port", () => {
    const dir = freshDir();
    const proc = runCli(["open"], { BOARD_DATA_DIR: dir });
    expect(proc.exitCode).toBe(0);
    const url = proc.stdout.trim();
    expect(url).toMatch(
      /^http:\/\/127\.0\.0\.1:7800\/\?token=[A-Za-z0-9_-]{43}$/,
    );
    const token = /\?token=([A-Za-z0-9_-]{43})/.exec(url)?.[1] ?? "";
    expect(token).not.toBe("");
    expect(proc.stdout.split(token)).toHaveLength(2);
    expect(proc.stderr).not.toContain(token);
  });

  test("subprocess: board open <ID> deep-links to the board", () => {
    const dir = freshDir();
    const proc = runCli(["open", "ab12cd34ef"], { BOARD_DATA_DIR: dir });
    expect(proc.exitCode).toBe(0);
    const url = proc.stdout.trim();
    expect(url).toMatch(
      /^http:\/\/127\.0\.0\.1:7800\/\?token=[A-Za-z0-9_-]{43}#\/boards\/ab12cd34ef$/,
    );
    const token = /\?token=([A-Za-z0-9_-]{43})/.exec(url)?.[1] ?? "";
    expect(proc.stderr).not.toContain(token);
  });

  test("--help and bare invocation print usage listing every command", () => {
    for (const args of [[], ["--help"]]) {
      const proc = runCli(args);
      expect(proc.exitCode).toBe(0);
      expect(proc.stderr).toBe("");
      for (const entry of [
        "serve",
        "token add",
        "token list",
        "token revoke",
        "list",
        "open",
        "export",
        "import",
        "status",
        "(not yet implemented)",
      ]) {
        expect(proc.stdout).toContain(entry);
      }
    }
  });

  test("an unknown command exits 1 with usage on stderr", () => {
    const proc = runCli(["frobnicate"]);
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr).toContain("frobnicate");
    expect(proc.stderr).toContain("serve");
  });
});
