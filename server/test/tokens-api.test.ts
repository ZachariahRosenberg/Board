import { afterEach, describe, expect, test } from "bun:test";
import { createExchangeToken } from "../src/sessions.ts";
import { createToken, revokeToken } from "../src/tokens.ts";
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

async function humanToken(s: TestServer): Promise<string> {
  const exchange = createExchangeToken(s.db);
  const res = await s.api.post("/api/session/exchange", { token: exchange });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

describe("GET /api/tokens", () => {
  test("human-only: none 401, agent bearer 403, human session 200", async () => {
    const s = server();
    const none = await s.api.get("/api/tokens");
    expect(none.status).toBe(401);
    expect(await errorCode(none)).toBe("unauthorized");

    const { token: agentToken } = await s.createAgent("token-recon-agent");
    const agent = await s.api.get("/api/tokens", { token: agentToken });
    expect(agent.status).toBe(403);
    expect(await errorCode(agent)).toBe("forbidden");

    const human = await s.api.get("/api/tokens", {
      token: await humanToken(s),
    });
    expect(human.status).toBe(200);
  });

  test("mirrors `token list`: the exact key set with lifecycle values", async () => {
    const s = server();
    const active = createToken(s.db, { name: "inventory-active" });
    createToken(s.db, { name: "inventory-revoked" });
    revokeToken(s.db, "inventory-revoked");
    // a real use stamps last_used_at on the active token
    expect(
      (await s.api.get("/api/boards", { token: active.token })).status,
    ).toBe(200);

    const res = await s.api.get("/api/tokens", { token: await humanToken(s) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokens: Array<Record<string, unknown>>;
    };
    const keys = [
      ...new Set(body.tokens.flatMap((row) => Object.keys(row))),
    ].sort();
    expect(keys).toEqual(["created_at", "last_seen", "name", "revoked_at"]);

    const byName = new Map(body.tokens.map((row) => [row.name as string, row]));
    const activeRow = byName.get("inventory-active");
    expect(activeRow?.revoked_at).toBeNull();
    expect(activeRow?.last_seen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const revokedRow = byName.get("inventory-revoked");
    expect(revokedRow?.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(revokedRow?.last_seen).toBeNull();
  });

  test("never carries token values or hashes", async () => {
    const s = server();
    const a = createToken(s.db, { name: "secret-less-a" });
    const b = createToken(s.db, { name: "secret-less-b" });
    const res = await s.api.get("/api/tokens", { token: await humanToken(s) });
    const text = await res.text();
    // neither plaintext nor sha256 hex may surface — inventory only
    expect(text).not.toContain(a.token);
    expect(text).not.toContain(b.token);
    expect(text).not.toContain("token_hash");
    expect(text).not.toContain("hash");
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });
});
