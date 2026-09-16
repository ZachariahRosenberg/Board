import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { BoardEvent } from "../src/domain.ts";
import { startTestServer, type TestServer } from "./helpers.ts";

const MD = "# Plan\n\nA paragraph of substance.\n";

let current: TestServer | undefined;
let receivers: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  for (const receiver of receivers) {
    await receiver.stop();
  }
  receivers = [];
  await current?.stop();
  current = undefined;
});

// Webhook tests always run the dispatcher with a tiny backoff: real retries
// happen (3 attempts), but the 500ms/2s production waits would crawl.
function server(): TestServer {
  current ??= startTestServer({ webhook: { backoffMs: () => 5 } });
  return current;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(10);
  }
}

interface Delivery {
  body: string;
  signature: string | null;
}

interface Receiver {
  url: string;
  deliveries: Delivery[];
  statuses: number[];
  setFailFirst(count: number): void;
  stop(): Promise<void>;
}

// A real local webhook receiver on an ephemeral loopback port.
function startReceiver(): Receiver {
  const deliveries: Delivery[] = [];
  const statuses: number[] = [];
  let failFirst = 0;
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const body = await req.text();
      deliveries.push({
        body,
        signature: req.headers.get("x-board-signature"),
      });
      let status = 200;
      if (failFirst > 0) {
        failFirst -= 1;
        status = 500;
      }
      statuses.push(status);
      return new Response("ok", { status });
    },
  });
  const handle: Receiver = {
    url: `http://127.0.0.1:${receiver.port}`,
    deliveries,
    statuses,
    setFailFirst: (count: number) => {
      failFirst = count;
    },
    stop: () => receiver.stop(true),
  };
  receivers.push(handle);
  return handle;
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

interface SubscriptionJson {
  id: string;
  board_id: string;
  principal: string;
  webhook_url: string;
  created_seq: number;
}

async function makeBoard(s: TestServer, token: string): Promise<string> {
  const res = await s.api.post(
    "/api/boards",
    { title: "Hooks", format: "markdown" },
    { token },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function publish(
  s: TestServer,
  token: string,
  boardId: string,
): Promise<void> {
  const res = await s.api.post(
    `/api/boards/${boardId}/publish`,
    { format: "markdown", content: MD, expected_version: 0 },
    { token },
  );
  expect(res.status).toBe(201);
}

function deadLetters(s: TestServer, boardId?: string): BoardEvent[] {
  const sql =
    boardId === undefined
      ? "SELECT seq, ts, actor, type, board_id, payload FROM events WHERE type = 'webhook.failed'"
      : "SELECT seq, ts, actor, type, board_id, payload FROM events WHERE type = 'webhook.failed' AND board_id = ?";
  return (
    s.db
      .prepare(sql)
      .all(...(boardId === undefined ? [] : [boardId])) as Array<{
      seq: number;
      ts: string;
      actor: string;
      type: string;
      board_id: string | null;
      payload: string;
    }>
  ).map((row) => ({
    ...row,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  })) as BoardEvent[];
}

describe("POST /api/boards/:id/subscribe", () => {
  test("registers a webhook subscription and returns its record", async () => {
    const s = server();
    const agent = await s.createAgent("hook-agent");
    const boardId = await makeBoard(s, agent.token);
    const res = await s.api.post(
      `/api/boards/${boardId}/subscribe`,
      {
        webhook_url: "http://127.0.0.1:9/hook",
        webhook_secret: "s3cret",
      },
      { token: agent.token },
    );
    expect(res.status).toBe(201);
    const sub = (await res.json()) as SubscriptionJson;
    expect(sub.id).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(sub.board_id).toBe(boardId);
    expect(sub.principal).toBe("hook-agent");
    expect(sub.webhook_url).toBe("http://127.0.0.1:9/hook");
    expect(sub.created_seq).toBeGreaterThan(0);
  });

  test("re-subscribing replaces the caller's webhook (one per principal)", async () => {
    const s = server();
    const agent = await s.createAgent("replace-agent");
    const boardId = await makeBoard(s, agent.token);
    const first = (await (
      await s.api.post(
        `/api/boards/${boardId}/subscribe`,
        { webhook_url: "http://127.0.0.1:9/one", webhook_secret: "a" },
        { token: agent.token },
      )
    ).json()) as SubscriptionJson;
    const second = (await (
      await s.api.post(
        `/api/boards/${boardId}/subscribe`,
        { webhook_url: "http://127.0.0.1:9/two", webhook_secret: "b" },
        { token: agent.token },
      )
    ).json()) as SubscriptionJson;
    expect(second.id).not.toBe(first.id);
    expect(second.created_seq).toBeGreaterThan(first.created_seq);

    const listRes = await s.api.get(`/api/boards/${boardId}/subscribers`, {
      token: agent.token,
    });
    expect(listRes.status).toBe(200);
    const subscribers = (await listRes.json()) as Array<{
      principal: string;
      kind: string;
      webhook_url: string | null;
      id: string | null;
    }>;
    expect(subscribers).toHaveLength(1);
    expect(subscribers[0].principal).toBe("replace-agent");
    expect(subscribers[0].kind).toBe("webhook");
    expect(subscribers[0].webhook_url).toBe("http://127.0.0.1:9/two");
    expect(subscribers[0].id).toBe(second.id);
    // the secret never leaves the signing path
    expect(JSON.stringify(subscribers)).not.toContain("s3cret");
    expect(JSON.stringify(subscribers)).not.toContain('"secret"');
  });

  test("rejects non-http(s), credential-embedded, and missing webhook_url with 400", async () => {
    const s = server();
    const agent = await s.createAgent("validate-agent");
    const boardId = await makeBoard(s, agent.token);
    const bad: Array<[unknown, string]> = [
      [{ webhook_url: "ftp://127.0.0.1/hook" }, "invalid_webhook_url"],
      [
        { webhook_url: "http://user:pass@127.0.0.1/hook" },
        "invalid_webhook_url",
      ],
      [{ webhook_url: "not a url" }, "invalid_webhook_url"],
      [{ webhook_secret: "no-url" }, "invalid_request"],
    ];
    for (const [body, code] of bad) {
      const res = await s.api.post(`/api/boards/${boardId}/subscribe`, body, {
        token: agent.token,
      });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe(code);
    }
  });

  test("404s on an unknown board", async () => {
    const s = server();
    const agent = await s.createAgent("missing-agent");
    const res = await s.api.post(
      "/api/boards/zzzzzzzzzz/subscribe",
      { webhook_url: "http://127.0.0.1:9/hook" },
      { token: agent.token },
    );
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("board_not_found");
  });

  test("appends an agent.subscribed event for the webhook", async () => {
    const s = server();
    const agent = await s.createAgent("event-agent");
    const boardId = await makeBoard(s, agent.token);
    await s.api.post(
      `/api/boards/${boardId}/subscribe`,
      { webhook_url: "http://127.0.0.1:9/hook" },
      { token: agent.token },
    );
    const res = await s.api.get(`/api/boards/${boardId}/events`, {
      token: agent.token,
    });
    const body = (await res.json()) as {
      events: Array<{
        type: string;
        actor: string;
        payload: Record<string, unknown>;
      }>;
    };
    const sub = body.events.find((event) => event.type === "agent.subscribed");
    expect(sub).toBeDefined();
    expect(sub?.actor).toBe("event-agent");
    expect(sub?.payload).toEqual({
      kind: "webhook",
      webhook_url: "http://127.0.0.1:9/hook",
    });
  });
});

describe("DELETE /api/boards/:id/subscribe", () => {
  test("removes the caller's webhook subscription; a second delete 404s", async () => {
    const s = server();
    const agent = await s.createAgent("unsub-agent");
    const boardId = await makeBoard(s, agent.token);
    await s.api.post(
      `/api/boards/${boardId}/subscribe`,
      { webhook_url: "http://127.0.0.1:9/hook" },
      { token: agent.token },
    );
    // the middleware requires application/json on all writes, DELETE included
    const del = await s.api.delete(`/api/boards/${boardId}/subscribe`, {
      token: agent.token,
      headers: { "content-type": "application/json" },
    });
    expect(del.status).toBe(200);
    const list = await s.api.get(`/api/boards/${boardId}/subscribers`, {
      token: agent.token,
    });
    expect((await list.json()) as unknown[]).toEqual([]);
    const again = await s.api.delete(`/api/boards/${boardId}/subscribe`, {
      token: agent.token,
      headers: { "content-type": "application/json" },
    });
    expect(again.status).toBe(404);
    expect(await errorCode(again)).toBe("subscription_not_found");
  });

  test("404s for an unknown board and without a subscription", async () => {
    const s = server();
    const agent = await s.createAgent("unsub-missing-agent");
    const missing = await s.api.delete("/api/boards/zzzzzzzzzz/subscribe", {
      token: agent.token,
      headers: { "content-type": "application/json" },
    });
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("board_not_found");
    const boardId = await makeBoard(s, agent.token);
    const none = await s.api.delete(`/api/boards/${boardId}/subscribe`, {
      token: agent.token,
      headers: { "content-type": "application/json" },
    });
    expect(none.status).toBe(404);
    expect(await errorCode(none)).toBe("subscription_not_found");
  });
});

describe("subscribe auth + routing", () => {
  test("all three routes reject a missing token with 401", async () => {
    const s = server();
    const post = await s.api.post("/api/boards/abcdefghij/subscribe", {
      webhook_url: "http://127.0.0.1:9/hook",
    });
    expect(post.status).toBe(401);
    expect(await errorCode(post)).toBe("unauthorized");
    const get = await s.api.get("/api/boards/abcdefghij/subscribers");
    expect(get.status).toBe(401);
    expect(await errorCode(get)).toBe("unauthorized");
    const del = await s.api.delete("/api/boards/abcdefghij/subscribe", {
      headers: { "content-type": "application/json" },
    });
    expect(del.status).toBe(401);
    expect(await errorCode(del)).toBe("unauthorized");
  });

  test("subscribers 404s on an unknown board", async () => {
    const s = server();
    const agent = await s.createAgent("subs-missing-agent");
    const res = await s.api.get("/api/boards/zzzzzzzzzz/subscribers", {
      token: agent.token,
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("board_not_found");
  });

  test("cursor-poll presence rows show up next to webhook rows", async () => {
    const s = server();
    const agent = await s.createAgent("presence-agent");
    const boardId = await makeBoard(s, agent.token);
    await s.api.post(
      `/api/boards/${boardId}/publish`,
      { format: "markdown", content: MD, expected_version: 0 },
      { token: agent.token },
    );
    // a cursor poll (D13) records presence with kind 'cursor'
    await s.api.get(`/api/boards/${boardId}/comments`, { token: agent.token });
    await s.api.post(
      `/api/boards/${boardId}/subscribe`,
      { webhook_url: "http://127.0.0.1:9/hook" },
      { token: agent.token },
    );
    const res = await s.api.get(`/api/boards/${boardId}/subscribers`, {
      token: agent.token,
    });
    const subscribers = (await res.json()) as Array<{
      principal: string;
      kind: string;
      webhook_url: string | null;
    }>;
    expect(subscribers.map((sub) => sub.kind).sort()).toEqual([
      "cursor",
      "webhook",
    ]);
  });
});

describe("webhook dispatcher", () => {
  test("delivers the event envelope with a verifiable HMAC signature, one attempt on success", async () => {
    const s = server();
    const agent = await s.createAgent("signed-agent");
    const receiver = startReceiver();
    const boardId = await makeBoard(s, agent.token);
    const sub = (await (
      await s.api.post(
        `/api/boards/${boardId}/subscribe`,
        { webhook_url: receiver.url, webhook_secret: "corr-secret" },
        { token: agent.token },
      )
    ).json()) as SubscriptionJson;
    // the subscription's own agent.subscribed event is the first delivery
    await waitFor(() => receiver.deliveries.length === 1, "subscribe ping");
    await publish(s, agent.token, boardId);
    await waitFor(() => receiver.deliveries.length === 2, "publish delivery");

    const delivery = receiver.deliveries[1];
    const envelope = JSON.parse(delivery.body) as BoardEvent;
    expect(envelope.type).toBe("board.published");
    expect(envelope.board_id).toBe(boardId);
    expect(envelope.seq).toBeGreaterThan(sub.created_seq);
    expect(envelope.payload).toEqual({ n: 1, format: "markdown" });
    const expected = `sha256=${createHmac("sha256", "corr-secret")
      .update(delivery.body)
      .digest("hex")}`;
    expect(delivery.signature).toBe(expected);
    // success = no retries, and the subscriber's cursor advances to the event
    // (polled: the dispatcher updates it after the receiver's response lands)
    expect(receiver.statuses).toEqual([200, 200]);
    await waitFor(() => {
      const row = s.db
        .prepare(
          "SELECT last_seq FROM subscribers WHERE board_id = ? AND kind = 'webhook'",
        )
        .get(boardId) as { last_seq: number };
      return row.last_seq === envelope.seq;
    }, "subscriber cursor advance");
    expect(deadLetters(s, boardId)).toEqual([]);
  });

  test("secret-less subscriptions get unsigned deliveries", async () => {
    const s = server();
    const agent = await s.createAgent("unsigned-agent");
    const receiver = startReceiver();
    const boardId = await makeBoard(s, agent.token);
    await s.api.post(
      `/api/boards/${boardId}/subscribe`,
      { webhook_url: receiver.url },
      { token: agent.token },
    );
    await waitFor(() => receiver.deliveries.length === 1, "delivery");
    await publish(s, agent.token, boardId);
    await waitFor(() => receiver.deliveries.length === 2, "publish delivery");
    expect(receiver.deliveries[1].signature).toBeNull();
  });

  test("retries failures with backoff and delivers on the third attempt without a dead-letter", async () => {
    const s = server();
    const agent = await s.createAgent("flaky-agent");
    const receiver = startReceiver();
    const boardId = await makeBoard(s, agent.token);
    await s.api.post(
      `/api/boards/${boardId}/subscribe`,
      { webhook_url: receiver.url, webhook_secret: "k" },
      { token: agent.token },
    );
    await waitFor(() => receiver.deliveries.length === 1, "subscribe ping");
    receiver.setFailFirst(2);
    await publish(s, agent.token, boardId);
    await waitFor(() => receiver.deliveries.length === 4, "three attempts");
    // attempts 2..4: 500, 500, 200
    expect(receiver.statuses.slice(1)).toEqual([500, 500, 200]);
    await sleep(50);
    expect(receiver.deliveries.length).toBe(4);
    expect(deadLetters(s, boardId)).toEqual([]);
  });

  test("appends a webhook.failed dead-letter after the final failure and never delivers it", async () => {
    const s = server();
    const agent = await s.createAgent("dead-agent");
    const receiver = startReceiver();
    receiver.setFailFirst(Number.MAX_SAFE_INTEGER);
    const boardId = await makeBoard(s, agent.token);
    await s.api.post(
      `/api/boards/${boardId}/subscribe`,
      { webhook_url: receiver.url, webhook_secret: "k" },
      { token: agent.token },
    );
    await publish(s, agent.token, boardId);
    // 3 failed attempts per event (agent.subscribed, then board.published)
    await waitFor(
      () => receiver.deliveries.length === 6,
      "six failed attempts",
    );
    await waitFor(
      () => deadLetters(s, boardId).length === 2,
      "two dead-letters",
    );
    expect(receiver.statuses.every((status) => status === 500)).toBe(true);
    // the dead-letters themselves are never delivered: nothing further arrives
    await sleep(80);
    expect(receiver.deliveries.length).toBe(6);
    const failed = deadLetters(s, boardId);
    const published = failed.find(
      (event) => event.payload.event_type === "board.published",
    );
    expect(published).toBeDefined();
    expect(published?.actor).toBe("dead-agent");
    expect(published?.board_id).toBe(boardId);
    expect(published?.payload.subscriber).toBe("dead-agent");
    expect(published?.payload.webhook_url).toBe(receiver.url);
    expect(published?.payload.attempts).toBe(3);
    expect(published?.payload.error).toBe("HTTP 500");
    expect(typeof published?.payload.event_seq).toBe("number");
    // the dead-letters are mirrored to the board's event channel too
    const events = await s.api.get(`/api/boards/${boardId}/events`, {
      token: agent.token,
    });
    const body = (await events.json()) as {
      events: Array<{ type: string }>;
    };
    expect(
      body.events.filter((event) => event.type === "webhook.failed").length,
    ).toBe(2);
  });

  test("unsubscribing stops deliveries", async () => {
    const s = server();
    const agent = await s.createAgent("stop-agent");
    const receiver = startReceiver();
    const boardId = await makeBoard(s, agent.token);
    await s.api.post(
      `/api/boards/${boardId}/subscribe`,
      { webhook_url: receiver.url },
      { token: agent.token },
    );
    await waitFor(() => receiver.deliveries.length === 1, "subscribe ping");
    await s.api.delete(`/api/boards/${boardId}/subscribe`, {
      token: agent.token,
      headers: { "content-type": "application/json" },
    });
    await publish(s, agent.token, boardId);
    await sleep(80);
    expect(receiver.deliveries.length).toBe(1);
  });
});

describe("board_subscribe via MCP", () => {
  test("registers a webhook through the SDK client and deliveries flow", async () => {
    const s = server();
    const agent = await s.createAgent("mcp-hook-agent");
    const receiver = startReceiver();
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "hook-mcp-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${s.hostUrl}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${agent.token}` } } },
    );
    await client.connect(transport);
    try {
      const created = (await client.callTool({
        name: "board_create",
        arguments: { title: "MCP hooks" },
      })) as { content: Array<{ text: string }> };
      const boardId = (JSON.parse(created.content[0].text) as { id: string })
        .id;

      const result = (await client.callTool({
        name: "board_subscribe",
        arguments: {
          board_id: boardId,
          webhook_url: receiver.url,
          webhook_secret: "mcp-secret",
        },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBeUndefined();
      const sub = JSON.parse(result.content[0].text) as SubscriptionJson;
      expect(sub.board_id).toBe(boardId);
      expect(sub.principal).toBe("mcp-hook-agent");
      expect(sub.webhook_url).toBe(receiver.url);

      await publish(s, agent.token, boardId);
      await waitFor(() => receiver.deliveries.length === 2, "publish delivery");
      const expected = `sha256=${createHmac("sha256", "mcp-secret")
        .update(receiver.deliveries[1].body)
        .digest("hex")}`;
      expect(receiver.deliveries[1].signature).toBe(expected);
    } finally {
      await client.close();
    }
  });

  test("board_subscribe surfaces store errors as tool errors", async () => {
    const s = server();
    const agent = await s.createAgent("mcp-hook-bad-agent");
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "hook-mcp-bad", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${s.hostUrl}/mcp`),
      { requestInit: { headers: { authorization: `Bearer ${agent.token}` } } },
    );
    await client.connect(transport);
    try {
      const result = (await client.callTool({
        name: "board_subscribe",
        arguments: {
          board_id: "zzzzzzzzzz",
          webhook_url: "http://127.0.0.1:9/h",
        },
      })) as { content: Array<{ text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not found");
    } finally {
      await client.close();
    }
  });
});
