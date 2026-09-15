import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRepoRoot } from "../src/daemon.ts";
import { rawRequest, startTestServer, type TestServer } from "./helpers.ts";

let current: TestServer | undefined;

afterEach(async () => {
  await current?.stop();
  current = undefined;
});

function server(): TestServer {
  current ??= startTestServer();
  return current;
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

// The exact host CSP pinned by daemon.ts hostSecurityHeaders (D18): agent
// board scripts run in the app origin, so script-src allows 'unsafe-inline';
// connect-src 'self' stays the exfil kill-switch; form-action 'self' keeps
// boards from form-navigating the app away; nothing frames anymore.
const HOST_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

// Vendored file pinned in server/libs — the exact name is the upgrade
// contract: a lib upgrade adds a new file, never rewrites this one.
const CHART_FILE = "chart-4.4.9.umd.min.js";

describe("host server (api)", () => {
  test("GET /api/health returns 200 {ok:true}", async () => {
    const res = await server().api.get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  test("unknown /api path returns 404 JSON", async () => {
    const res = await server().api.get("/api/definitely-not-here");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });

  test("wrong method returns 405 with an Allow header", async () => {
    const res = await server().api.post("/api/health", {});
    expect(res.status).toBe(405);
    expect(await errorCode(res)).toBe("method_not_allowed");
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("GET /api/origin (removed by D18)", () => {
  test("the endpoint is gone — a plain 404", async () => {
    const res = await server().api.get("/api/origin");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });
});

describe("host server: GET /libs/<file> (D18)", () => {
  test("serves the vendored chart.js build with immutable cache and host headers", async () => {
    const s = server();
    const res = await s.api.get(`/libs/${CHART_FILE}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/javascript; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(res.headers.get("content-security-policy")).toBe(HOST_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const vendored = readFileSync(
      join(resolveRepoRoot(), "server", "libs", CHART_FILE),
    );
    expect(await res.text()).toBe(vendored.toString());
  });

  test("unknown lib files are a 404", async () => {
    const res = await server().api.get("/libs/nope.js");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });

  test("traversal out of the libs dir is rejected", async () => {
    for (const path of [
      "/libs/%2e%2e/%2e%2e/package.json",
      "/libs/..%2f..%2fpackage.json",
      `/libs/${CHART_FILE}%2f%2e%2e`,
    ]) {
      const res = await server().api.get(path);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("subdirectory-shaped paths are a 404 (flat dir)", async () => {
    const res = await server().api.get(`/libs/sub/${CHART_FILE}`);
    expect(res.status).toBe(404);
  });

  test("POST is a 405", async () => {
    const res = await server().api.post(`/libs/${CHART_FILE}`, {});
    expect(res.status).toBe(405);
    expect(await errorCode(res)).toBe("method_not_allowed");
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("binding", () => {
  test("the daemon is a single server on 127.0.0.1 (D18: the board origin is gone)", async () => {
    const s = server();
    const host = new URL(s.hostUrl);
    expect(host.hostname).toBe("127.0.0.1");
    expect(Number(host.port)).toBeGreaterThan(0);
    expect((await s.api.get("/api/health")).status).toBe(200);
  });
});

describe("request hardening", () => {
  test("Host: evil.com is rejected with 421 (raw HTTP and fetch)", async () => {
    const s = server();
    const hostPort = Number(new URL(s.hostUrl).port);
    const apiRaw = await rawRequest(
      hostPort,
      "GET /api/health HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n",
    );
    expect(apiRaw.status).toBe(421);
    expect(
      (await s.api.get("/api/health", { headers: { host: "evil.com" } }))
        .status,
    ).toBe(421);
  });

  test("localhost Host headers are allowed", async () => {
    const res = await server().api.get("/api/health", {
      headers: { host: "localhost" },
    });
    expect(res.status).toBe(200);
  });

  test("POST with Sec-Fetch-Site: cross-site is rejected with 403", async () => {
    const res = await server().api.post(
      "/api/health",
      {},
      { headers: { "sec-fetch-site": "cross-site" } },
    );
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("cross_site_blocked");
  });

  test("GET with Sec-Fetch-Site: cross-site is allowed", async () => {
    const res = await server().api.get("/api/health", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(200);
  });

  test("POST without application/json is rejected with 415", async () => {
    const res = await server().api.post("/api/health");
    expect(res.status).toBe(415);
    expect(await errorCode(res)).toBe("unsupported_media_type");
  });

  test("bodies over 8 MB are rejected with 413", async () => {
    const res = await server().api.post("/api/health", {
      pad: "x".repeat(9 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe("payload_too_large");
  });
});

describe("no CORS", () => {
  test("responses carry no Access-Control-* headers", async () => {
    const s = server();
    const responses = [
      await s.api.get("/api/health"),
      await s.api.get("/api/nope"),
    ];
    for (const res of responses) {
      const names: string[] = [];
      res.headers.forEach((_value, name) => {
        names.push(name.toLowerCase());
      });
      expect(
        names.filter((name) => name.startsWith("access-control-")),
      ).toEqual([]);
    }
  });
});
