import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoRoot } from "../src/daemon.ts";
import { createBoard, getVersion, publishVersion } from "../src/store.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

// Vendored file pinned in server/origin-libs — the exact name is the upgrade
// contract: a lib upgrade adds a new file, never rewrites this one.
const CHART_FILE = "chart-4.4.9.umd.min.js";

const HTML_DOC =
  '<!doctype html><html><head><title>origin fixture</title></head><body><h1 data-ba="b1">Origin fixture</h1><p>chart canvas goes here</p></body></html>';
const MARKDOWN_DOC =
  "# Plan\n\nA **markdown** board.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";

let current: TestServer | undefined;
const dataDirs: string[] = [];

afterEach(async () => {
  await current?.stop();
  current = undefined;
});

afterAll(() => {
  for (const dir of dataDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function server(): TestServer {
  current ??= startTestServer();
  dataDirs.push(current.dataDir);
  return current;
}

// Boards are seeded through the store layer in-process (same db the daemon
// opened) — no auth round-trip needed to arrange origin-serving fixtures.
async function seedHtmlBoard(
  s: TestServer,
  content = HTML_DOC,
): Promise<string> {
  const board = createBoard(s.db, s.dataDir, {
    title: "origin html",
    format: "html",
    actor: "origin-test",
  });
  await publishVersion(s.db, s.dataDir, board.id, {
    format: "html",
    content,
    expected_version: 0,
    actor: "origin-test",
  });
  return board.id;
}

async function seedMarkdownBoard(s: TestServer): Promise<string> {
  const board = createBoard(s.db, s.dataDir, {
    title: "origin markdown",
    format: "markdown",
    actor: "origin-test",
  });
  await publishVersion(s.db, s.dataDir, board.id, {
    format: "markdown",
    content: MARKDOWN_DOC,
    expected_version: 0,
    actor: "origin-test",
  });
  return board.id;
}

// The full locked header set from docs/security.md, byte-exact, with
// frame-ancestors derived from the test daemon's host origin.
function expectLockedHeaders(res: Response, s: TestServer): void {
  expect(res.headers.get("content-security-policy")).toBe(
    `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors ${s.hostUrl}`,
  );
  expect(res.headers.get("permissions-policy")).toBe(
    "geolocation=(), camera=(), microphone=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=(), bluetooth=()",
  );
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

describe("board origin: GET /b/:id/:n", () => {
  test("serves the published html document verbatim with locked headers and immutable cache", async () => {
    const s = server();
    const boardId = await seedHtmlBoard(s);
    const res = await s.origin.get(`/b/${boardId}/1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(HTML_DOC);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expectLockedHeaders(res, s);
  });

  test("serves the derived html document for markdown-format boards", async () => {
    const s = server();
    const boardId = await seedMarkdownBoard(s);
    const res = await s.origin.get(`/b/${boardId}/1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body.startsWith("<!doctype html>")).toBe(true);
    expect(body).toContain("markdown");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expectLockedHeaders(res, s);
  });

  test("the fetched document is byte-identical to the stored version content", async () => {
    const s = server();
    const boardId = await seedHtmlBoard(s);
    const res = await s.origin.get(`/b/${boardId}/1`);
    const stored = getVersion(s.db, boardId, 1);
    if (stored === null) {
      throw new Error("version 1 missing after publish");
    }
    expect(await res.text()).toBe(stored.content);
  });

  test("unknown board is a 404 board_not_found with locked headers", async () => {
    const s = server();
    const res = await s.origin.get("/b/aaaaaaaaaa/1");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("board_not_found");
    expectLockedHeaders(res, s);
  });

  test("a board-id-shaped-but-different id stays a 404 (no wildcard ids)", async () => {
    const s = server();
    await seedHtmlBoard(s);
    const res = await s.origin.get("/b/bbbbbbbbbb/1");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("board_not_found");
  });

  test("known board with unknown version is a 404 version_not_found", async () => {
    const s = server();
    const boardId = await seedHtmlBoard(s);
    const missing = await s.origin.get(`/b/${boardId}/9`);
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("version_not_found");
    expectLockedHeaders(missing, s);
    expect(await errorCode(await s.origin.get(`/b/${boardId}/0`))).toBe(
      "version_not_found",
    );
  });

  test("non-integer version numbers are a 400", async () => {
    const s = server();
    const boardId = await seedHtmlBoard(s);
    for (const n of ["1.5", "abc", "-1", "1e3"]) {
      const res = await s.origin.get(`/b/${boardId}/${n}`);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_request");
    }
  });

  test("POST is a 405 with locked headers", async () => {
    const s = server();
    const boardId = await seedHtmlBoard(s);
    const res = await s.origin.post(`/b/${boardId}/1`, {});
    expect(res.status).toBe(405);
    expect(await errorCode(res)).toBe("method_not_allowed");
    expect(res.headers.get("allow")).toBe("GET");
    expectLockedHeaders(res, s);
  });
});

describe("board origin: GET /libs/<file>", () => {
  test("serves the vendored chart.js build verbatim as js with immutable cache and locked headers", async () => {
    const s = server();
    const res = await s.origin.get(`/libs/${CHART_FILE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expectLockedHeaders(res, s);
    const vendored = readFileSync(
      join(resolveRepoRoot(), "server", "origin-libs", CHART_FILE),
    );
    expect(await res.text()).toBe(vendored.toString());
  });

  test("unknown lib files are a 404", async () => {
    const s = server();
    const res = await s.origin.get("/libs/nope.js");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expectLockedHeaders(res, s);
  });

  test("traversal out of the libs dir is rejected", async () => {
    const s = server();
    for (const path of [
      "/libs/%2e%2e/%2e%2e/package.json",
      "/libs/..%2f..%2fpackage.json",
      `/libs/${CHART_FILE}%2f%2e%2e`,
    ]) {
      const res = await s.origin.get(path);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("subdirectory-shaped paths are a 404 (flat dir)", async () => {
    const s = server();
    const res = await s.origin.get(`/libs/sub/${CHART_FILE}`);
    expect(res.status).toBe(404);
  });

  test("POST is a 405 with locked headers", async () => {
    const s = server();
    const res = await s.origin.post(`/libs/${CHART_FILE}`, {});
    expect(res.status).toBe(405);
    expect(await errorCode(res)).toBe("method_not_allowed");
    expect(res.headers.get("allow")).toBe("GET");
    expectLockedHeaders(res, s);
  });
});
