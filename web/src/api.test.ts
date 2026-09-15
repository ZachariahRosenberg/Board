import { describe, expect, test } from "bun:test";
import {
  ApiError,
  exchange,
  getBoard,
  getVersion,
  listBoards,
  onUnauthorized,
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
});
