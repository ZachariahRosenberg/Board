import { describe, expect, test } from "bun:test";
import type { Board } from "../domain.ts";
import { filterBoards } from "./boards.ts";

function board(over: Partial<Board>): Board {
  return {
    id: "x",
    title: "t",
    format: "markdown",
    status: "open",
    tags: [],
    created_by: "agent",
    created_at: "2026-01-01T00:00:00.000Z",
    current_version: 0,
    ...over,
  };
}

describe("filterBoards", () => {
  test("no filters returns every board", () => {
    const boards = [board({ id: "a" }), board({ id: "b" })];
    expect(filterBoards(boards, {})).toEqual(boards);
  });

  test("status filter matches only that status", () => {
    const open = board({ id: "a", status: "open" });
    const ended = board({ id: "b", status: "ended" });
    expect(filterBoards([open, ended], { status: "open" })).toEqual([open]);
    expect(filterBoards([open, ended], { status: "ended" })).toEqual([ended]);
  });

  test("tag filter matches a tag at any position", () => {
    const tagged = board({ id: "a", tags: ["alpha", "shared"] });
    const other = board({ id: "b", tags: ["beta"] });
    expect(filterBoards([tagged, other], { tag: "shared" })).toEqual([tagged]);
    expect(filterBoards([tagged, other], { tag: "nope" })).toEqual([]);
  });

  test("author filter matches created_by", () => {
    const mine = board({ id: "a", created_by: "agent-one" });
    const theirs = board({ id: "b", created_by: "agent-two" });
    expect(filterBoards([mine, theirs], { author: "agent-one" })).toEqual([
      mine,
    ]);
  });

  test("filters combine with AND semantics", () => {
    const a = board({
      id: "a",
      status: "open",
      tags: ["x"],
      created_by: "one",
    });
    const b = board({
      id: "b",
      status: "ended",
      tags: ["x"],
      created_by: "one",
    });
    expect(
      filterBoards([a, b], { status: "open", tag: "x", author: "one" }),
    ).toEqual([a]);
  });
});
