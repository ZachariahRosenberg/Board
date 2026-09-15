import { describe, expect, test } from "bun:test";
import {
  ApiError,
  createComment,
  exchange,
  getBoard,
  getComments,
  getVersion,
  listBoards,
  onUnauthorized,
  replyComment,
  resolveComment,
  streamUrl,
} from "./api.ts";
import { installDom } from "./test-dom.ts";
import { clearSessionToken, setSessionToken } from "./token.ts";

installDom();

interface RecordedCall {
  input: string;
  init: RequestInit | undefined;
}

function mockFetch(respond: (call: RecordedCall) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { input: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api client", () => {
  test("listBoards sends GET with the session bearer", async () => {
    setSessionToken("sess-token");
    const calls = mockFetch(() => jsonResponse(200, []));
    const boards = await listBoards();
    expect(boards).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("/api/boards");
    expect(calls[0].init?.method).toBeUndefined();
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(
      "Bearer sess-token",
    );
    clearSessionToken();
  });

  test("no bearer header when no session is stored", async () => {
    clearSessionToken();
    const calls = mockFetch(() => jsonResponse(200, []));
    await listBoards();
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(null);
  });

  test("getBoard and getVersion build the right paths", async () => {
    const calls = mockFetch((call) =>
      call.input.includes("versions/3")
        ? jsonResponse(200, { board_id: "b1", n: 3 })
        : jsonResponse(200, { board: {}, versions: [] }),
    );
    await getBoard("b1");
    await getVersion("b1", 3);
    expect(calls.map((call) => call.input)).toEqual([
      "/api/boards/b1",
      "/api/boards/b1/versions/3",
    ]);
  });

  test("error envelope surfaces as ApiError with code", async () => {
    mockFetch(() =>
      jsonResponse(404, {
        error: { code: "board_not_found", message: 'board "x" not found' },
      }),
    );
    const err = await getBoard("x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe("board_not_found");
    expect(apiErr.message).toContain("not found");
  });

  test("401 clears the session and fires the unauthorized handler", async () => {
    setSessionToken("sess-token");
    let unauthorized = false;
    const off = onUnauthorized(() => {
      unauthorized = true;
    });
    mockFetch(() => jsonResponse(401, { error: { code: "unauthorized" } }));
    await expect(listBoards()).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).toBe(true);
    expect(localStorage.getItem("board.session")).toBe(null);
    off();
  });

  test("exchange posts the one-time token without a bearer", async () => {
    setSessionToken("sess-token");
    const calls = mockFetch(() => jsonResponse(200, { token: "new-session" }));
    const result = await exchange("one-time-1");
    expect(result).toBe("new-session");
    expect(calls[0].input).toBe("/api/session/exchange");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe(JSON.stringify({ token: "one-time-1" }));
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe(null);
    clearSessionToken();
  });

  test("failed exchange rejects with ApiError unauthorized", async () => {
    mockFetch(() => jsonResponse(401, { error: { code: "unauthorized" } }));
    await expect(exchange("burned")).rejects.toThrow("make open");
  });

  test("comment endpoints hit the right paths with the right bodies", async () => {
    setSessionToken("sess-token");
    const calls = mockFetch((call) => {
      if (call.input.includes("/reply")) {
        return jsonResponse(201, { id: "c2" });
      }
      if (call.input.includes("/resolve")) {
        return jsonResponse(200, { id: "c1" });
      }
      if (call.input.includes("comments")) {
        return jsonResponse(200, { comments: [], last_seq: 0 });
      }
      return jsonResponse(201, { id: "c3" });
    });
    await createComment("b1", {
      anchor: { type: "board" },
      body: "note",
      version_n: 2,
    });
    await replyComment("c1", "a reply");
    await resolveComment("c1");
    const page = await getComments("b1", 5);
    expect(page.last_seq).toBe(0);
    expect(
      calls.map((call) => `${call.init?.method ?? "GET"} ${call.input}`),
    ).toEqual([
      "POST /api/boards/b1/comments",
      "POST /api/comments/c1/reply",
      "POST /api/comments/c1/resolve",
      "GET /api/boards/b1/comments?since=5",
    ]);
    expect(calls[0].init?.body).toBe(
      JSON.stringify({
        anchor: { type: "board" },
        body: "note",
        version_n: 2,
      }),
    );
    expect(calls[1].init?.body).toBe(JSON.stringify({ body: "a reply" }));
    clearSessionToken();
  });

  test("streamUrl embeds the session token url-encoded", () => {
    setSessionToken("abc/def+ghi=");
    expect(streamUrl()).toBe("/api/stream?token=abc%2Fdef%2Bghi%3D");
    clearSessionToken();
    expect(streamUrl()).toBe("");
  });
});
