import { describe, expect, test } from "bun:test";
import type { Board, Comment } from "./domain.ts";
import { serializeFeedback } from "./feedback.ts";

const board: Board = {
  id: "b1",
  title: "Decision brief",
  format: "markdown",
  status: "open",
  tags: [],
  created_by: "agent-1",
  created_at: "2026-09-15T10:00:00.000Z",
  current_version: 2,
};

let nextId = 0;

function comment(over: Partial<Comment>): Comment {
  nextId += 1;
  return {
    id: `c${nextId}`,
    board_id: "b1",
    version_n: 2,
    seq: nextId,
    anchor: { type: "board" },
    body: "body",
    author: "human",
    in_reply_to: null,
    created_at: "2026-09-15T18:00:00.000Z",
    edited_at: null,
    resolved_at: null,
    resolved_by: null,
    ...over,
  };
}

describe("serializeFeedback", () => {
  test("empty board renders the header and a no-comments line", () => {
    expect(serializeFeedback(board, [])).toBe(
      `# Feedback: "Decision brief" (b1, v2)\n\nUnresolved: 0 of 0 threads.\n\nNo comments yet.\n`,
    );
  });

  test("one unresolved text thread with a reply", () => {
    const root = comment({
      anchor: {
        type: "text",
        section_id: "b2",
        originalText: "alpha beta",
        startOffset: 0,
        endOffset: 10,
      },
      body: "The intro should mention the cache.",
    });
    const reply = comment({
      author: "agent-1",
      body: "Fixed in v2.",
      in_reply_to: root.id,
      created_at: "2026-09-15T18:05:00.000Z",
    });
    expect(serializeFeedback(board, [root, reply])).toBe(
      `# Feedback: "Decision brief" (b1, v2)\n\nUnresolved: 1 of 1 threads.\n\n---\n\n` +
        `## 1. UNRESOLVED — text b2: "alpha beta"\n\n` +
        `> The intro should mention the cache.\n\n` +
        `— human, 2026-09-15T18:00:00.000Z\n\n` +
        `- 1.1 agent-1, 2026-09-15T18:05:00.000Z: Fixed in v2.\n\n`,
    );
  });

  test("resolved section thread renders RESOLVED", () => {
    const root = comment({
      anchor: { type: "section", section_id: "b3" },
      body: "Done.",
      resolved_at: "2026-09-15T19:00:00.000Z",
      resolved_by: "human",
    });
    const out = serializeFeedback(board, [root]);
    expect(out).toContain("Unresolved: 0 of 1 threads.");
    expect(out).toContain("## 1. RESOLVED — section b3");
    expect(out).not.toContain("UNRESOLVED —");
  });

  test("row and board anchors get their descriptors", () => {
    const rowThread = comment({
      anchor: { type: "row", section_id: "b4", row_id: "b4r2" },
      body: "row thread",
    });
    const boardThread = comment({
      anchor: { type: "board" },
      body: "board thread",
    });
    const out = serializeFeedback(board, [rowThread, boardThread]);
    expect(out).toContain("## 1. UNRESOLVED — row b4/b4r2");
    expect(out).toContain("## 2. UNRESOLVED — board");
  });

  test("multiline bodies quote every line", () => {
    const root = comment({ body: "line one\nline two" });
    const out = serializeFeedback(board, [root]);
    expect(out).toContain("> line one\n> line two");
  });

  test("replies-to-replies render flat under the root, in seq order", () => {
    const root = comment({ body: "root" });
    const reply = comment({
      author: "agent-1",
      body: "first reply",
      in_reply_to: root.id,
    });
    const nested = comment({
      author: "agent-2",
      body: "nested reply",
      in_reply_to: reply.id,
    });
    const out = serializeFeedback(board, [root, reply, nested]);
    expect(out).toContain(
      "- 1.1 agent-1, 2026-09-15T18:00:00.000Z: first reply",
    );
    expect(out).toContain(
      "- 1.2 agent-2, 2026-09-15T18:00:00.000Z: nested reply",
    );
  });

  test("threads render in seq order regardless of array order", () => {
    const later = comment({ body: "later", seq: 99 });
    const earlier = comment({ body: "earlier", seq: 1 });
    const out = serializeFeedback(board, [later, earlier]);
    const earlierAt = out.indexOf("earlier");
    const laterAt = out.indexOf("later");
    expect(earlierAt).toBeGreaterThan(-1);
    expect(earlierAt).toBeLessThan(laterAt);
  });
});
