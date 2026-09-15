import { afterEach, describe, expect, test } from "bun:test";
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

describe("GET /api/origin", () => {
  test("returns the daemon's live board-origin URL, unauthenticated", async () => {
    const s = server();
    const res = await s.api.get("/api/origin");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ url: s.originUrl });
  });

  test("wrong method returns 405 with an Allow header", async () => {
    const res = await server().api.post("/api/origin", {});
    expect(res.status).toBe(405);
    expect(await errorCode(res)).toBe("method_not_allowed");
    expect(res.headers.get("allow")).toBe("GET");
  });
});

describe("binding", () => {
  test("both servers bind 127.0.0.1 on distinct ephemeral ports and answer", async () => {
    const s = server();
    const host = new URL(s.hostUrl);
    const origin = new URL(s.originUrl);
    expect(host.hostname).toBe("127.0.0.1");
    expect(origin.hostname).toBe("127.0.0.1");
    expect(Number(host.port)).toBeGreaterThan(0);
    expect(Number(origin.port)).toBeGreaterThan(0);
    expect(host.port).not.toBe(origin.port);
    expect((await s.api.get("/api/health")).status).toBe(200);
    expect((await s.origin.get("/b/some-board/1")).status).toBe(404);
  });
});

describe("board origin security headers", () => {
  test("every response carries the exact header set with derived frame-ancestors", async () => {
    const s = server();
    for (const path of ["/", "/b/abc/1", "/libs/mermaid.js", "/assets/img"]) {
      const res = await s.origin.get(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-security-policy")).toBe(
        `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors ${s.hostUrl}`,
      );
      expect(res.headers.get("permissions-policy")).toBe(
        "geolocation=(), camera=(), microphone=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=(), bluetooth=()",
      );
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
});

describe("request hardening", () => {
  test("Host: evil.com is rejected with 421 on both servers (raw HTTP and fetch)", async () => {
    const s = server();
    const hostPort = Number(new URL(s.hostUrl).port);
    const originPort = Number(new URL(s.originUrl).port);
    const apiRaw = await rawRequest(
      hostPort,
      "GET /api/health HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n",
    );
    expect(apiRaw.status).toBe(421);
    const originRaw = await rawRequest(
      originPort,
      "GET /b/x HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n",
    );
    expect(originRaw.status).toBe(421);
    expect(
      (await s.api.get("/api/health", { headers: { host: "evil.com" } }))
        .status,
    ).toBe(421);
    expect(
      (await s.origin.get("/b/x", { headers: { host: "evil.com" } })).status,
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
      await s.origin.get("/b/x"),
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
