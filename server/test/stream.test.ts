import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "./helpers.ts";

let s: TestServer;
let agent: { name: string; token: string };

beforeAll(async () => {
  // 50ms heartbeats so the heartbeat test runs fast (docs/plan.md "GET /stream")
  process.env.BOARD_SSE_HEARTBEAT_MS = "50";
  s = startTestServer();
  agent = await s.createAgent("streamer");
});

afterAll(async () => {
  await s.stop();
  delete process.env.BOARD_SSE_HEARTBEAT_MS;
});

function openStream(
  extra: { headers?: Record<string, string>; query?: string } = {},
): Promise<Response> {
  const query = extra.query ?? "";
  return fetch(`${s.hostUrl}/api/stream${query}`, {
    headers: { authorization: `Bearer ${agent.token}`, ...extra.headers },
  });
}

interface ReadResult {
  text: string;
  close(): Promise<void>;
}

// Read frames until the accumulated text satisfies the predicate (or timeout).
async function readUntil(
  res: Response,
  predicate: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<ReadResult> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    throw new Error("stream has no body");
  }
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wait = reader.read();
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("read timeout")),
        deadline - Date.now(),
      );
    });
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = (await Promise.race([
        wait,
        timeout,
      ])) as ReadableStreamReadResult<Uint8Array>;
    } catch (err) {
      if (predicate(text)) {
        return { text, close: () => reader.cancel().then(() => undefined) };
      }
      throw err;
    }
    if (chunk.done) {
      break;
    }
    text += decoder.decode(chunk.value, { stream: true });
    if (predicate(text)) {
      return { text, close: () => reader.cancel().then(() => undefined) };
    }
  }
  if (predicate(text)) {
    return { text, close: () => reader.cancel().then(() => undefined) };
  }
  throw new Error(`predicate not met within ${timeoutMs}ms; got: ${text}`);
}

async function makeBoard(title: string): Promise<string> {
  const res = await s.api.post(
    "/api/boards",
    { title, format: "markdown" },
    { token: agent.token },
  );
  const board = (await res.json()) as { id: string };
  const publish = await s.api.post(
    `/api/boards/${board.id}/publish`,
    { format: "markdown", content: "# stream", expected_version: 0 },
    { token: agent.token },
  );
  expect(publish.status).toBe(201);
  return board.id;
}

describe("GET /api/stream (SSE)", () => {
  test("live events arrive as id/event/data frames", async () => {
    const res = await openStream();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // the board is created WHILE the stream is open — this is the live path
    const boardPromise = makeBoard("Live");
    const { text, close } = await readUntil(res, (t) =>
      t.includes('"type":"board.created"'),
    );
    expect(text).toMatch(/id: \d+\nevent: board\ndata: /);
    await boardPromise;
    await close();
  });

  test("?since= replays missed events before going live", async () => {
    await makeBoard("Replay one");
    const before = s.db.prepare("SELECT MAX(seq) AS m FROM events").get() as {
      m: number | null;
    };
    const since = before.m ?? 0;
    await makeBoard("Replay two");
    const res = await openStream({ query: `?since=${since}` });
    const { text, close } = await readUntil(res, (t) =>
      t.includes('"type":"board.published"'),
    );
    expect(text).toContain('"type":"board.created"');
    expect(text).toContain("Replay");
    await close();
  });

  test("Last-Event-ID header behaves like since", async () => {
    const boardId = await makeBoard("LastEventId");
    const row = s.db
      .prepare("SELECT MAX(seq) AS m FROM events WHERE board_id = ?")
      .get(boardId) as { m: number | null };
    const res = await openStream({
      headers: { "last-event-id": String((row.m ?? 1) - 1) },
    });
    const { text, close } = await readUntil(res, (t) =>
      t.includes('"type":"board.published"'),
    );
    expect(text).toContain('"type":"board.published"');
    await close();
  });

  test("heartbeat comment frames arrive", async () => {
    const res = await openStream();
    const { text, close } = await readUntil(
      res,
      (t) => t.includes(": ping"),
      2000,
    );
    expect(text).toContain(": ping");
    await close();
  });

  test("401 without a token", async () => {
    const res = await fetch(`${s.hostUrl}/api/stream`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  test("cancelling a reader does not wedge the daemon; stop() resolves", async () => {
    const res = await openStream();
    await res.body?.cancel();
    const health = await s.api.get("/api/health");
    expect(health.status).toBe(200);
    const stopped = await Promise.race([
      s.stop().then(() => "stopped" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 2000),
      ),
    ]);
    expect(stopped).toBe("stopped");
  });
});
