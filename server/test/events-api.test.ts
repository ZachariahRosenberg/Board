import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Board, BoardEvent } from "../src/domain.ts";
import { appendEvent } from "../src/events.ts";
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

// The human session path: mint an exchange token, swap it over HTTP — the
// same flow the SPA runs (the audit view polls with the session bearer).
async function humanToken(s: TestServer): Promise<string> {
  const exchange = createExchangeToken(s.db);
  const res = await s.api.post("/api/session/exchange", { token: exchange });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
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

describe("GET /api/events: audit filters (M7)", () => {
  test("?board_id= filters the channel while last_seq stays the GLOBAL max", async () => {
    const { s, tokenA, boardA } = await seed();
    const res = await s.api.get(`/api/events?board_id=${boardA.id}`, {
      token: tokenA,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events.map((event) => event.seq)).toEqual([1, 2]);
    // the cursor advances past the filtered-out events, not to the page tail
    expect(body.last_seq).toBe(4);
  });

  test("?type= filters by exact type", async () => {
    const { s, tokenA } = await seed();
    const res = await s.api.get("/api/events?type=board.created", {
      token: tokenA,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events.map((event) => event.seq)).toEqual([1, 3]);
    expect(body.last_seq).toBe(4);
  });

  test("dead-letters surface via type=webhook.failed", async () => {
    const { s, tokenA, boardA } = await seed();
    appendEvent(s.db, s.dataDir, {
      actor: "dead-agent",
      type: "webhook.failed",
      boardId: boardA.id,
      payload: { error: "HTTP 500" },
    });
    const res = await s.api.get("/api/events?type=webhook.failed", {
      token: tokenA,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0].seq).toBe(5);
    expect(body.events[0].actor).toBe("dead-agent");
    expect(body.events[0].board_id).toBe(boardA.id);
    expect(body.last_seq).toBe(5);
  });

  test("filters combine (board_id + type + since)", async () => {
    const { s, tokenA, boardA } = await seed();
    const res = await s.api.get(
      `/api/events?board_id=${boardA.id}&type=board.published&since=1`,
      { token: tokenA },
    );
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events.map((event) => event.seq)).toEqual([2]);
    expect(body.last_seq).toBe(4);
  });

  test("an unknown type/board_id filter is an empty result, not a 404 (filters, not resources)", async () => {
    const { s, tokenA } = await seed();
    const res = await s.api.get(
      "/api/events?type=no.such&board_id=zzzzzzzzzz",
      {
        token: tokenA,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [], last_seq: 4 });
  });

  test("the human session can read the global channel", async () => {
    const { s } = await seed();
    const token = await humanToken(s);
    const res = await s.api.get("/api/events", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: BoardEvent[] };
    expect(body.events).toHaveLength(4);
  });
});

describe("GET /api/events: paging (M7)", () => {
  // Volume fixture via direct appends (the route reads the same rows): 550
  // events, seqs 1..550 in a fresh daemon.
  async function seedVolume(): Promise<{ s: TestServer; token: string }> {
    const s = server();
    const { token } = await s.createAgent("volume-agent");
    for (let i = 0; i < 550; i++) {
      appendEvent(s.db, s.dataDir, {
        actor: "volume-agent",
        type: "board.published",
        boardId: "volume-board",
      });
    }
    return { s, token };
  }

  test("default limit is 100, order ascending, last_seq the global max", async () => {
    const { s, token } = await seedVolume();
    const res = await s.api.get("/api/events", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events).toHaveLength(100);
    const seqs = body.events.map((event) => event.seq);
    expect(seqs[0]).toBe(1);
    expect(seqs[99]).toBe(100);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    // global max, NOT the page max — the distinguishing contract
    expect(body.last_seq).toBe(550);
  });

  test("limit over the max clamps to 500 without erroring", async () => {
    const { s, token } = await seedVolume();
    const res = await s.api.get("/api/events?limit=1000", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(body.events).toHaveLength(500);
    expect(body.events[499].seq).toBe(500);
    expect(body.last_seq).toBe(550);
  });

  test("an explicit small limit is honored and since composes with it", async () => {
    const { s, token } = await seedVolume();
    const small = await s.api.get("/api/events?limit=5", { token });
    const smallBody = (await small.json()) as { events: BoardEvent[] };
    expect(smallBody.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    const tail = await s.api.get("/api/events?since=540&limit=100", { token });
    const tailBody = (await tail.json()) as {
      events: BoardEvent[];
      last_seq: number;
    };
    expect(tailBody.events.map((event) => event.seq)).toEqual([
      541, 542, 543, 544, 545, 546, 547, 548, 549, 550,
    ]);
    expect(tailBody.last_seq).toBe(550);
  });

  test("a non-integer limit is rejected with 400 (validation, like since)", async () => {
    const { s, token } = await seedVolume();
    const res = await s.api.get("/api/events?limit=abc", { token });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("invalid_request");
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
