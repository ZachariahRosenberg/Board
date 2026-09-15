import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("board cli", () => {
  test("bin prints the not-yet-implemented notice and exits 0", () => {
    const proc = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, "main.ts"),
    ]);
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("board: not yet implemented\n");
  });
});
