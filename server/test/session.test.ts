import { afterEach, describe, expect, test } from "bun:test";
import { createExchangeToken } from "../src/sessions.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

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

describe("POST /api/session/exchange", () => {
  test("happy path: exchange over HTTP, then the session token works as a Bearer", async () => {
    const s = server();
    const exchange = createExchangeToken(s.db);
    const res = await s.api.post("/api/session/exchange", { token: exchange });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as { token: string };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.token).not.toBe(exchange);

    const boards = await s.api.get("/api/boards", { token: body.token });
    expect(boards.status).toBe(200);
    expect(await boards.json()).toEqual([]);
  });

  test("reusing an exchange token is rejected with 401", async () => {
    const s = server();
    const exchange = createExchangeToken(s.db);
    expect(
      (await s.api.post("/api/session/exchange", { token: exchange })).status,
    ).toBe(200);
    const reuse = await s.api.post("/api/session/exchange", {
      token: exchange,
    });
    expect(reuse.status).toBe(401);
    expect(await errorCode(reuse)).toBe("unauthorized");
  });

  test("a garbage exchange token is rejected with 401", async () => {
    const s = server();
    const res = await s.api.post("/api/session/exchange", {
      token: "definitely-not-an-exchange-token",
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  test("a missing token field is rejected with 400", async () => {
    const s = server();
    const res = await s.api.post("/api/session/exchange", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("token");
  });

  test("an unused exchange token is not itself a Bearer", async () => {
    const s = server();
    const exchange = createExchangeToken(s.db);
    const res = await s.api.get("/api/boards", { token: exchange });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });

  test("the auth bootstrap still runs behind the hardening middleware", async () => {
    const s = server();
    const exchange = createExchangeToken(s.db);
    const crossSite = await s.api.post(
      "/api/session/exchange",
      { token: exchange },
      { headers: { "sec-fetch-site": "cross-site" } },
    );
    expect(crossSite.status).toBe(403);
    expect(await errorCode(crossSite)).toBe("cross_site_blocked");

    const noJson = await s.api.post("/api/session/exchange");
    expect(noJson.status).toBe(415);
    expect(await errorCode(noJson)).toBe("unsupported_media_type");
  });

  test("a wrong method returns 405 with an Allow header", async () => {
    const s = server();
    const res = await s.api.get("/api/session/exchange");
    expect(res.status).toBe(405);
    expect(await errorCode(res)).toBe("method_not_allowed");
    expect(res.headers.get("allow")).toBe("POST");
  });
});
