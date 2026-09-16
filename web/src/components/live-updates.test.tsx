import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import {
  createComponentHarness,
  installDom,
  StubEventSource,
} from "../test-dom.ts";
import { clearSessionToken, setSessionToken } from "../token.ts";
import { BoardView } from "./BoardView.tsx";
import { getCommentsCalls, installApiMock } from "./test-api.ts";

installDom();
installApiMock();

const { render, cleanup } = createComponentHarness();
afterEach(cleanup);

// Live updates are an end-to-end-ish flow — a BoardView wired to the SSE
// stream through the (stubbed) EventSource — not one component's behavior,
// so the describe lives here rather than in a single component's file.
describe("BoardView live updates", () => {
  test("an SSE board event refreshes comments", async () => {
    getCommentsCalls.length = 0;
    setSessionToken("sess-ok");
    render(<BoardView id="b1" />);
    await act(async () => {});
    const initial = getCommentsCalls.length;
    const source = StubEventSource.instances.at(-1);
    await act(async () => {
      source?.emit("board", {
        data: JSON.stringify({
          seq: 20,
          ts: "2026-09-15T18:30:00.000Z",
          actor: "human",
          type: "comment.created",
          board_id: "b1",
          payload: {},
        }),
      });
    });
    await act(async () => {});
    expect(getCommentsCalls.length).toBeGreaterThan(initial);
    clearSessionToken();
  });
});
