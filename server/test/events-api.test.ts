import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Board, BoardEvent } from "../src/domain.ts";
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

async function createBoardVia(
  s: TestServer,
  token: string,
  title: string,
): Promise<Board> {
  const res = await s.api.post(
    "/api/boards",
    { title, format: "markdown" },
    { token },
  );
  expect(res.status).toBe(201);
  return (await res.json()) as Board;
}

async function publishVia(
  s: TestServer,
  token: string,
  boardId: string,
  content: string,
): Promise<void> {
  const res = await s.api.post(
    `/api/boards/${boardId}/publish`,
    { format: "markdown", content, expected_version: 0 },
    { token },
  );
  expect(res.status).toBe(201);
}

// Two boards by two agents, one publish each: global seqs 1..4 in order
// created-A, published-A, created-B, published-B.
async function seed(): Promise<{
  s: TestServer;
  tokenA: string;
  tokenB: string;
  boardA: Board;
  boardB: Board;
}> {
  const s = server();
  const a = await s.createAgent("agent-a");
  const b = await s.createAgent("agent-b");
  const boardA = await createBoardVia(s, a.token, "Board A");
  await publishVia(s, a.token, boardA.id, "# A v1");
  const boardB = await createBoardVia(s, b.token, "Board B");
  await publishVia(s, b.token, boardB.id, "# B v1");
  return { s, tokenA: a.token, tokenB: b.token, boardA, boardB };
}

async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

describe("GET /api/events", () => {
  test("returns the full global channel in seq order with BoardEvent shapes", async () => {
    const { s, tokenA, boardA } = await seed();
    const res = await s.api.get("/api/events", { token: tokenA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events.map((event) => event.type)).toEqual([
      "board.created",
      "board.published",
      "board.created",
      "board.published",
    ]);
    expect(body.last_seq).toBe(4);
    const first = body.events[0];
    expect(first.seq).toBe(1);
    expect(first.board_id).toBe(boardA.id);
    expect(first.actor).toBe("agent-a");
    expect(first.payload).toEqual({ title: "Board A", format: "markdown" });
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("?since= returns only newer events with a correct last_seq", async () => {
    const { s, tokenA } = await seed();
    const res = await s.api.get("/api/events?since=2", { token: tokenA });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(body.last_seq).toBe(4);
  });

  test("?since= at the tail returns no events and echoes the cursor", async () => {
    const { s, tokenA } = await seed();
    const res = await s.api.get("/api/events?since=4", { token: tokenA });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], last_seq: 4 });
  });

  test("?since=0 returns everything, like an omitted since", async () => {
    const { s, tokenA } = await seed();
    const res = await s.api.get("/api/events?since=0", { token: tokenA });
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events.length).toBe(4);
    expect(body.last_seq).toBe(4);
  });

  test("rejects a non-integer since with 400", async () => {
    const { s, tokenA } = await seed();
    for (const bad of ["abc", "-1", "1.5", ""]) {
      const res = await s.api.get(
        `/api/events?since=${encodeURIComponent(bad)}`,
        { token: tokenA },
      );
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_request");
    }
  });

  test("requires a token", async () => {
    const s = server();
    const res = await s.api.get("/api/events");
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });
});

describe("GET /api/boards/:id/events", () => {
  test("returns only that board's events, excluding other boards", async () => {
    const { s, tokenA, boardA, boardB } = await seed();
    const res = await s.api.get(`/api/boards/${boardA.id}/events`, {
      token: tokenA,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events.map((event) => event.type)).toEqual([
      "board.created",
      "board.published",
    ]);
    for (const event of body.events) {
      expect(event.board_id).toBe(boardA.id);
    }
    expect(body.last_seq).toBe(2);

    const otherRes = await s.api.get(`/api/boards/${boardB.id}/events`, {
      token: tokenA,
    });
    const other = (await otherRes.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(other.events.map((event) => event.seq)).toEqual([3, 4]);
    expect(other.last_seq).toBe(4);
  });

  test("?since= filters within the board channel", async () => {
    const { s, tokenA, boardA } = await seed();
    const res = await s.api.get(`/api/boards/${boardA.id}/events?since=1`, {
      token: tokenA,
    });
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events.map((event) => event.type)).toEqual(["board.published"]);
    expect(body.last_seq).toBe(2);

    const tail = await s.api.get(`/api/boards/${boardA.id}/events?since=2`, {
      token: tokenA,
    });
    expect(await tail.json()).toEqual({ events: [], last_seq: 2 });
  });

  test("returns 404 board_not_found for an unknown board", async () => {
    const { s, tokenA } = await seed();
    const res = await s.api.get("/api/boards/zzzzzzzzzz/events", {
      token: tokenA,
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("board_not_found");
  });

  test("rejects a non-integer since with 400", async () => {
    const { s, tokenA, boardA } = await seed();
    const res = await s.api.get(`/api/boards/${boardA.id}/events?since=abc`, {
      token: tokenA,
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
  });

  test("requires a token", async () => {
    const s = server();
    const res = await s.api.get("/api/boards/abcdefghij/events");
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("unauthorized");
  });
});

describe("dual-write", () => {
  test("the global events.jsonl mirrors the events returned by the API", async () => {
    const { s, tokenA } = await seed();
    const res = await s.api.get("/api/events", { token: tokenA });
    const body = (await res.json()) as { events: BoardEvent[] };
    const lines = readFileSync(join(s.dataDir, "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(lines.length).toBe(body.events.length);
    const onDisk = lines.map((line) => JSON.parse(line) as BoardEvent);
    expect(onDisk.map((event) => event.seq)).toEqual(
      body.events.map((event) => event.seq),
    );
  });
});
