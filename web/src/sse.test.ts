import { describe, expect, test } from "bun:test";
import type { BoardEvent } from "../../server/src/domain.ts";
import { BoardStream } from "./sse.ts";
import { installDom, StubEventSource } from "./test-dom.ts";

installDom();

describe("BoardStream", () => {
  test("parses board frames and forwards them as events", () => {
    const seen: BoardEvent[] = [];
    const stream = new BoardStream("/api/stream?token=x", (ev) => {
      seen.push(ev);
    });
    const source = StubEventSource.instances.at(-1);
    expect(source?.url).toBe("/api/stream?token=x");
    const event: BoardEvent = {
      seq: 7,
      ts: "2026-09-15T18:00:00.000Z",
      actor: "human",
      type: "comment.created",
      board_id: "b1",
      payload: {},
    };
    source?.emit("board", { data: JSON.stringify(event) });
    expect(seen).toEqual([event]);
    stream.close();
  });

  test("malformed frames never kill the stream", () => {
    const seen: BoardEvent[] = [];
    const stream = new BoardStream("/api/stream?token=x", (ev) => {
      seen.push(ev);
    });
    const source = StubEventSource.instances.at(-1);
    source?.emit("board", { data: "{not json" });
    source?.emit("board", { data: JSON.stringify({ seq: 1 }) });
    expect(seen).toHaveLength(1);
    stream.close();
  });
});
