import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConfig } from "../../../server/src/config.ts";
import { BOARDS_USAGE, runBoardsCommand } from "./boards.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-cli-boards-test-"));
  dirs.push(dir);
  return dir;
}

function testConfig() {
  return makeConfig({
    BOARD_DATA_DIR: tempDir(),
    BOARD_HOST: "127.0.0.1",
    BOARD_PORT: "7800",
  });
}

interface Capture {
  out: string[];
  err: string[];
}

// install.test.ts's capture pattern, plus the fetch seam: every request is
// recorded and answered from `routes` — nothing touches a network.
function capture(
  routes: (url: string, init?: RequestInit) => Response | Promise<Response>,
): Capture & {
  run(
    command: string,
    argv: string[],
    env?: Record<string, string | undefined>,
  ): Promise<number>;
  requests: Array<{ url: string; init?: RequestInit }>;
} {
  const out: string[] = [];
  const err: string[] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const path = String(url).replace(/^http:\/\/127\.0\.0\.1:7800/, "");
    return Promise.resolve(routes(path, init));
  };
  const savedToken = process.env.BOARD_TOKEN;
  return {
    out,
    err,
    requests,
    async run(command, argv, env = {}) {
      // assigning undefined to process.env stringifies it — delete instead
      if (env.BOARD_TOKEN === undefined) {
        delete process.env.BOARD_TOKEN;
      } else {
        process.env.BOARD_TOKEN = env.BOARD_TOKEN;
      }
      try {
        const code = await runBoardsCommand(command, {
          config: testConfig(),
          argv,
          io: {
            stdout: (text) => {
              out.push(text);
            },
            stderr: (text) => {
              err.push(text);
            },
          },
          fetchImpl,
        });
        return code;
      } finally {
        if (savedToken === undefined) {
          delete process.env.BOARD_TOKEN;
        } else {
          process.env.BOARD_TOKEN = savedToken;
        }
      }
    },
  };
}

function jsonRoute(
  status: number,
  body: unknown,
): (url: string, init?: RequestInit) => Response {
  return () => new Response(JSON.stringify(body), { status });
}

const BOARDS_JSON = [
  {
    id: "abcdefghij",
    title: "Plan",
    format: "markdown",
    status: "open",
    tags: [],
    created_by: "agent",
    created_at: "2026-09-15T00:00:00.000Z",
    current_version: 3,
    unresolved_comments: 2,
  },
  {
    id: "klmnopqrst",
    title: "Archive",
    format: "html",
    status: "ended",
    tags: [],
    created_by: "agent",
    created_at: "2026-09-15T00:00:00.000Z",
    current_version: 1,
    unresolved_comments: 0,
  },
];

describe("board list", () => {
  test("renders id/status/versions/unresolved as a table with bearer auth", async () => {
    const cap = capture(jsonRoute(200, BOARDS_JSON));
    const code = await cap.run("list", [], { BOARD_TOKEN: "tok-123" });
    expect(code).toBe(0);
    expect(cap.err).toEqual([]);
    expect(cap.requests).toHaveLength(1);
    expect(cap.requests[0]?.url).toBe("http://127.0.0.1:7800/api/boards");
    const init = cap.requests[0]?.init;
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer tok-123",
    );
    expect(cap.out).toHaveLength(3);
    expect(cap.out[0]).toContain("ID");
    expect(cap.out[1]).toContain("abcdefghij");
    expect(cap.out[1]).toContain("open");
    expect(cap.out[1]).toContain("3");
    expect(cap.out[1]).toContain("2");
    expect(cap.out[1]).toContain("Plan");
    expect(cap.out[2]).toContain("klmnopqrst");
    expect(cap.out[2]).toContain("ended");
  });

  test("empty list prints a hint", async () => {
    const cap = capture(jsonRoute(200, []));
    const code = await cap.run("list", ["--token", "t"]);
    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("no boards");
  });
});

describe("board export", () => {
  test("writes the zip bytes to the default <id>.zip file", async () => {
    const dir = tempDir();
    // the CLI moves bytes; it never parses the zip — any bytes will do
    const zip = new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]);
    const cap = capture(
      () =>
        new Response(new Uint8Array(zip), {
          status: 200,
          headers: { "content-type": "application/zip" },
        }),
    );
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const code = await cap.run("export", ["abc123def9"], {
        BOARD_TOKEN: "t",
      });
      expect(code).toBe(0);
      const file = join(dir, "abc123def9.zip");
      expect(existsSync(file)).toBe(true);
      expect(new Uint8Array(readFileSync(file))).toEqual(new Uint8Array(zip));
      expect(cap.out.join("\n")).toContain("abc123def9.zip");
    } finally {
      process.chdir(cwd);
    }
  });

  test("explicit file argument overrides the default", async () => {
    const dir = tempDir();
    const cap = capture(() => new Response(new Uint8Array([1, 2, 3])));
    const file = join(dir, "bundle.zip");
    const code = await cap.run("export", ["abc123def9", file], {
      BOARD_TOKEN: "t",
    });
    expect(code).toBe(0);
    expect(new Uint8Array(readFileSync(file))).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  test("a 404 surfaces the daemon's error message", async () => {
    const cap = capture(
      jsonRoute(404, {
        error: { code: "board_not_found", message: 'board "nope" not found' },
      }),
    );
    const code = await cap.run("export", ["nope", "x.zip"], {
      BOARD_TOKEN: "t",
    });
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("not found");
  });
});

describe("board import", () => {
  test("posts the file bytes raw with application/zip and prints the new id", async () => {
    const dir = tempDir();
    const zip = new Uint8Array([0x50, 0x4b, 3, 4, 9, 8, 7, 6]);
    const file = join(dir, "bundle.zip");
    await Bun.write(file, zip);
    const cap = capture(
      jsonRoute(201, { id: "newboard99", title: "Restored" }),
    );
    const code = await cap.run("import", [file], { BOARD_TOKEN: "t" });
    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("newboard99");
    expect(cap.out.join("\n")).toContain("Restored");
    const init = cap.requests[0]?.init;
    expect(cap.requests[0]?.url).toBe(
      "http://127.0.0.1:7800/api/boards/import",
    );
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/zip",
    );
    expect(new Uint8Array(init?.body as ArrayBuffer)).toEqual(
      new Uint8Array(zip),
    );
  });

  test("a 422 rejection surfaces the failing item and exits 1", async () => {
    const dir = tempDir();
    const file = join(dir, "dirty.zip");
    await Bun.write(file, "not a zip");
    const cap = capture(
      jsonRoute(422, {
        error: {
          code: "import_rejected",
          message: 'unexpected bundle entry "../evil.txt"',
        },
      }),
    );
    const code = await cap.run("import", [file], { BOARD_TOKEN: "t" });
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain("../evil.txt");
  });

  test("a missing bundle file exits 1 without a request", async () => {
    const cap = capture(() => new Response("", { status: 200 }));
    const code = await cap.run("import", ["/nonexistent/dir/b.zip"], {
      BOARD_TOKEN: "t",
    });
    expect(code).toBe(1);
    expect(cap.requests).toHaveLength(0);
    expect(cap.err.join("\n")).toContain("could not read");
  });
});

describe("token resolution", () => {
  test("--token wins over BOARD_TOKEN and rides the Authorization header", async () => {
    const cap = capture(jsonRoute(200, []));
    const code = await cap.run("list", ["--token", "flag-token"], {
      BOARD_TOKEN: "env-token",
    });
    expect(code).toBe(0);
    expect(
      new Headers(cap.requests[0]?.init?.headers).get("authorization"),
    ).toBe("Bearer flag-token");
  });

  test("no token anywhere: usage error, no request, exit 1", async () => {
    const cap = capture(jsonRoute(200, []));
    const code = await cap.run("list", []);
    expect(code).toBe(1);
    expect(cap.requests).toHaveLength(0);
    expect(cap.err.join("\n")).toContain("no token");
    expect(cap.err.join("\n")).toContain("make token add");
  });

  test("unknown command falls through to usage", async () => {
    const cap = capture(jsonRoute(200, []));
    const code = await cap.run("frobnicate", []);
    expect(code).toBe(1);
    expect(cap.err.join("\n")).toContain(BOARDS_USAGE);
  });
});
