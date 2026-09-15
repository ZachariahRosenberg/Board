import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostSecurityHeaders, resolveWebDist } from "../src/daemon.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const roots: string[] = [];
let current: TestServer | undefined;

afterEach(async () => {
  await current?.stop();
  current = undefined;
});

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function serverWith(root: string): TestServer {
  current = startTestServer({ webRootHint: root });
  return current;
}

const INDEX_HTML = "<!doctype html><html><body>board spa shell</body></html>";
const APP_JS = 'console.log("board fixture");';
const APP_CSS = "body { margin: 0 }";

// The static seam needs a repo-root-shaped fixture: package.json + Makefile at
// the root, built assets under web/dist (never the real ~/.board or repo web/).
function makeFixtureRoot(withDist: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "board-web-fixture-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), '{ "name": "fixture" }\n');
  writeFileSync(join(root, "Makefile"), "# fixture root marker\n");
  if (withDist) {
    const dist = join(root, "web", "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), INDEX_HTML);
    writeFileSync(join(dist, "assets", "app.js"), APP_JS);
    writeFileSync(join(dist, "assets", "app.css"), APP_CSS);
  }
  return root;
}

function expectedHostCsp(originUrl: string): string {
  return `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${originUrl}; connect-src 'self'; frame-src ${originUrl}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'`;
}

describe("resolveWebDist", () => {
  test("walks up from a nested hint to the repo root and joins web/dist", () => {
    const root = makeFixtureRoot(true);
    const nested = join(root, "server", "src");
    mkdirSync(nested, { recursive: true });
    expect(resolveWebDist(nested)).toBe(join(root, "web", "dist"));
  });

  test("the default hint resolves to this repo's web/dist", () => {
    const dist = resolveWebDist();
    expect(dist.endsWith(join("web", "dist"))).toBe(true);
    const root = dirname(dirname(dist));
    expect(existsSync(join(root, "package.json"))).toBe(true);
    expect(existsSync(join(root, "Makefile"))).toBe(true);
  });

  test("throws when no repo root sits above the hint", () => {
    const orphan = mkdtempSync(join(tmpdir(), "board-web-orphan-"));
    roots.push(orphan);
    expect(() => resolveWebDist(orphan)).toThrow();
  });
});

describe("hostSecurityHeaders", () => {
  test("emits the exact docs/security.md host CSP plus nosniff", () => {
    expect(hostSecurityHeaders("http://127.0.0.1:7801")).toEqual({
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http://127.0.0.1:7801; connect-src 'self'; frame-src http://127.0.0.1:7801; frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
      "x-content-type-options": "nosniff",
    });
  });
});

describe("host server static serving (built dist)", () => {
  test("GET / serves index.html with the exact host CSP (derived origin port) and nosniff", async () => {
    const s = serverWith(makeFixtureRoot(true));
    const res = await s.api.get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("content-security-policy")).toBe(
      expectedHostCsp(s.originUrl),
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("serves assets with correct MIME types and nosniff", async () => {
    const s = serverWith(makeFixtureRoot(true));
    const js = await s.api.get("/assets/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(await js.text()).toBe(APP_JS);
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");

    const css = await s.api.get("/assets/app.css");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await css.text()).toBe(APP_CSS);
    expect(css.headers.get("content-security-policy")).toBe(
      expectedHostCsp(s.originUrl),
    );
  });

  test("unknown non-file paths fall back to index.html (SPA hash routing)", async () => {
    const s = serverWith(makeFixtureRoot(true));
    const res = await s.api.get("/whatever/spa/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("a missing file-shaped path is a 404, not the SPA shell", async () => {
    const s = serverWith(makeFixtureRoot(true));
    const res = await s.api.get("/assets/missing.js");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("percent-encoded traversal out of web/dist is rejected", async () => {
    const s = serverWith(makeFixtureRoot(true));
    const res = await s.api.get("/assets/%2e%2e/%2e%2e/%2e%2e/package.json");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("/api/health is unchanged JSON on the same server", async () => {
    const s = serverWith(makeFixtureRoot(true));
    const res = await s.api.get("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("non-GET methods on static paths are rejected with 405", async () => {
    const s = serverWith(makeFixtureRoot(true));
    const res = await s.api.post("/");
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("method_not_allowed");
  });

  test("hashed /assets/* cache immutably; index, fonts, and SPA fallback revalidate", async () => {
    // A rebuild wipes old hashed assets — a tab must never keep running a
    // stale bundle, so everything unhashed is no-cache (dogfooded the hard
    // way: a "missing" Enter-to-submit fix was an old cached bundle).
    const root = makeFixtureRoot(true);
    mkdirSync(join(root, "web", "dist", "fonts"), { recursive: true });
    writeFileSync(join(root, "web", "dist", "fonts", "fixture.woff2"), "font");
    const s = serverWith(root);

    const index = await s.api.get("/");
    expect(index.headers.get("cache-control")).toBe("no-cache");

    const js = await s.api.get("/assets/app.js");
    expect(js.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );

    const font = await s.api.get("/fonts/fixture.woff2");
    expect(font.status).toBe(200);
    expect(font.headers.get("cache-control")).toBe("no-cache");

    const spa = await s.api.get("/some/spa/route");
    expect(spa.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("host server static serving (dist not built)", () => {
  test("GET / returns the web_not_built JSON error, still with security headers", async () => {
    const s = serverWith(makeFixtureRoot(false));
    const res = await s.api.get("/");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("web_not_built");
    expect(body.error.message).toBe("run: make web");
    expect(res.headers.get("content-security-policy")).toBe(
      expectedHostCsp(s.originUrl),
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("/api/health keeps working when the dist is missing", async () => {
    const s = serverWith(makeFixtureRoot(false));
    const res = await s.api.get("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
