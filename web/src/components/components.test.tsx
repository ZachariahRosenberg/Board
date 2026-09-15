import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Anchor,
  Board,
  Comment,
  Version,
  VersionMeta,
} from "../../../server/src/domain.ts";
import type { CreateCommentInput } from "../api.ts";
import { installDom, StubEventSource } from "../test-dom.ts";
import { clearSessionToken, setSessionToken } from "../token.ts";
import { App, Gate } from "./App.tsx";
import { BoardList } from "./BoardList.tsx";
import { BoardView } from "./BoardView.tsx";
import { CommentSidebar } from "./CommentSidebar.tsx";

installDom();

// BoardView injects the stored (server-sanitized) document; mermaid renders
// client-side — both are mocked at the module boundary so no network or real
// mermaid runs here. (bun 1.4.2 mock() exposes no call log — hand-rolled spy.)
const mermaidRunCalls: Array<{ nodes: HTMLElement[] }> = [];
const mermaidInitializeCalls: number[] = [];
mock.module("mermaid", () => ({
  default: {
    initialize: () => {
      mermaidInitializeCalls.push(0);
    },
    run: (args: { nodes: HTMLElement[] }) => {
      mermaidRunCalls.push(args);
      return Promise.resolve();
    },
  },
}));

const versionCalls: Array<[string, number]> = [];
const exchangeCalls: string[] = [];

const MD_BOARD: Board & { unresolved_comments: number } = {
  id: "b1",
  title: "Decision brief",
  format: "markdown",
  status: "open",
  tags: ["plan"],
  created_by: "agent-1",
  created_at: "2026-09-15T10:00:00.000Z",
  current_version: 2,
  unresolved_comments: 2,
};

const TEXT_ANCHOR: Anchor = {
  type: "text",
  section_id: "b2",
  originalText: "beta",
  startOffset: 6,
  endOffset: 10,
};

const COMMENT_ROOT: Comment = {
  id: "cm1",
  board_id: "b1",
  version_n: 2,
  seq: 10,
  anchor: TEXT_ANCHOR,
  body: "The intro should mention the cache.",
  author: "human",
  in_reply_to: null,
  created_at: "2026-09-15T18:00:00.000Z",
  edited_at: null,
  resolved_at: null,
  resolved_by: null,
};

const COMMENT_REPLY: Comment = {
  ...COMMENT_ROOT,
  id: "cm2",
  seq: 11,
  body: "Fixed in v2.",
  author: "agent-1",
  in_reply_to: "cm1",
  anchor: TEXT_ANCHOR,
};

const COMMENT_RESOLVED: Comment = {
  ...COMMENT_ROOT,
  id: "cm3",
  seq: 12,
  anchor: { type: "section", section_id: "b1" },
  body: "Done.",
  resolved_at: "2026-09-15T19:00:00.000Z",
  resolved_by: "human",
};

const commentFixture: Comment[] = [
  COMMENT_ROOT,
  COMMENT_REPLY,
  COMMENT_RESOLVED,
];
const getCommentsCalls: string[] = [];
const createdComments: Array<{ boardId: string; input: CreateCommentInput }> =
  [];
const replied: Array<[string, string]> = [];
const resolvedIds: string[] = [];

const VERSIONS: VersionMeta[] = [
  {
    board_id: "b1",
    n: 1,
    label: null,
    note: null,
    anchors: [],
    created_by: "agent-1",
    created_at: "2026-09-15T10:00:00.000Z",
  },
  {
    board_id: "b1",
    n: 2,
    label: "after review",
    note: null,
    anchors: [],
    created_by: "agent-1",
    created_at: "2026-09-15T11:00:00.000Z",
  },
];

const MD_VERSION: Version = {
  board_id: "b1",
  n: 2,
  label: "after review",
  note: null,
  content:
    '<!doctype html><html><body><h1 data-ba="b1">Plan</h1><pre class="mermaid">graph TD</pre></body></html>',
  source_md: "# Plan",
  anchors: [],
  created_by: "agent-1",
  created_at: "2026-09-15T11:00:00.000Z",
};

mock.module("../api.ts", () => ({
  listBoards: async () => [MD_BOARD],
  getBoard: async (id: string) => {
    if (id === "b-html") {
      return {
        board: {
          ...MD_BOARD,
          id: "b-html",
          format: "html",
          title: "Dashboard",
        },
        versions: VERSIONS,
      };
    }
    return { board: MD_BOARD, versions: VERSIONS };
  },
  getVersion: async (id: string, n: number) => {
    versionCalls.push([id, n]);
    return MD_VERSION;
  },
  exchange: async (token: string) => {
    exchangeCalls.push(token);
    return `session-for-${token}`;
  },
  getComments: async (boardId: string) => {
    getCommentsCalls.push(boardId);
    return {
      comments: commentFixture,
      last_seq: commentFixture.at(-1)?.seq ?? 0,
    };
  },
  createComment: async (boardId: string, input: CreateCommentInput) => {
    createdComments.push({ boardId, input });
    return { ...COMMENT_ROOT, id: "cm-new", body: input.body, seq: 99 };
  },
  replyComment: async (commentId: string, body: string) => {
    replied.push([commentId, body]);
    return { ...COMMENT_REPLY, id: "cm-r", body };
  },
  resolveComment: async (commentId: string) => {
    resolvedIds.push(commentId);
    return { ...COMMENT_RESOLVED, id: commentId };
  },
  streamUrl: () => "/api/stream?token=stub",
  onUnauthorized: () => () => {},
  ApiError: class ApiError extends Error {},
}));

const roots: Root[] = [];

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(element);
  });
  return container;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
});

describe("BoardList", () => {
  test("renders boards with status, author, tags, and unresolved counts", async () => {
    const container = render(<BoardList />);
    await act(async () => {});
    expect(container.innerHTML).toContain("Decision brief");
    expect(container.innerHTML).toContain("open");
    expect(container.innerHTML).toContain("agent-1");
    expect(container.innerHTML).toContain("plan");
    expect(container.innerHTML).toContain("2 unresolved");
    expect(container.querySelector("a.board-card")?.getAttribute("href")).toBe(
      "#/boards/b1",
    );
  });
});

describe("BoardView", () => {
  test("injects the sanitized document and runs mermaid on its blocks", async () => {
    versionCalls.length = 0;
    const mermaidBefore = mermaidRunCalls.length;
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    expect(versionCalls).toEqual([["b1", 2]]);
    const content = container.querySelector("div.board-content");
    expect(content).not.toBe(null);
    expect(content?.innerHTML).toContain("Plan");
    expect(mermaidRunCalls.length - mermaidBefore).toBe(1);
    const nodes = mermaidRunCalls.at(-1)?.nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes?.[0].className).toContain("mermaid");
  });

  test("version switcher fetches the selected version", async () => {
    versionCalls.length = 0;
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    expect(versionCalls).toEqual([["b1", 2]]);
    const pills =
      container
        .querySelector("nav.version-switcher")
        ?.querySelectorAll("button.pill") ?? [];
    expect(pills).toHaveLength(2);
    expect(pills[1].textContent).toContain("after review");
    await act(async () => {
      (pills[0] as HTMLElement).click();
    });
    expect(versionCalls).toEqual([
      ["b1", 2],
      ["b1", 1],
    ]);
  });

  test("html-format boards show the M4 notice and never inject", async () => {
    const mermaidBefore = mermaidRunCalls.length;
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    expect(container.innerHTML).toContain("starting with M4");
    expect(container.querySelector("div.board-content")).toBe(null);
    expect(mermaidRunCalls.length - mermaidBefore).toBe(0);
  });
});

describe("Gate", () => {
  test("paste flow exchanges the token and reports back", async () => {
    exchangeCalls.length = 0;
    let ready = false;
    const container = render(<Gate onReady={() => (ready = true)} />);
    const input = container.querySelector("input");
    expect(input).not.toBe(null);
    // React's value tracker swallows direct .value writes on controlled
    // inputs — go through the native setter so onChange actually fires.
    const valueSetter = Object.getOwnPropertyDescriptor(
      (input as HTMLInputElement).constructor.prototype,
      "value",
    )?.set;
    await act(async () => {
      valueSetter?.call(input, "one-time-9");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // the submit button enabling proves the paste state actually committed
    const submitButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "open",
    ) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(false);
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(exchangeCalls).toEqual(["one-time-9"]);
    expect(ready).toBe(true);
    expect(localStorage.getItem("board.session")).toBe(
      "session-for-one-time-9",
    );
    clearSessionToken();
  });
});

describe("App", () => {
  test("with a stored session it renders the board list", async () => {
    setSessionToken("sess-ok");
    location.hash = "#/";
    const container = render(<App />);
    await act(async () => {});
    expect(container.innerHTML).toContain("Decision brief");
    clearSessionToken();
  });
});

describe("CommentSidebar", () => {
  test("renders threads with chips, authors, replies, and resolved state", async () => {
    getCommentsCalls.length = 0;
    const highlightCalls: Array<Anchor> = [];
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onHighlight={(anchor) => {
          highlightCalls.push(anchor);
        }}
      />,
    );
    await act(async () => {});
    expect(getCommentsCalls).toEqual(["b1"]);
    expect(container.innerHTML).toContain(
      "The intro should mention the cache.",
    );
    expect(container.innerHTML).toContain("text b2:");
    expect(container.innerHTML).toContain("“beta”");
    expect(container.innerHTML).toContain("you");
    expect(container.innerHTML).toContain("agent-1");
    expect(container.innerHTML).toContain("Fixed in v2.");
    expect(container.innerHTML).toContain("✓ resolved");
    expect(container.innerHTML).toContain("1 unresolved / 2 threads");
    const chip = container.querySelector(
      "button.anchor-chip.clickable",
    ) as HTMLElement;
    await act(async () => {
      chip.click();
    });
    expect(highlightCalls.at(-1)).toEqual(TEXT_ANCHOR);
  });

  test("resolve click calls the API and refreshes", async () => {
    resolvedIds.length = 0;
    getCommentsCalls.length = 0;
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onHighlight={() => {}}
      />,
    );
    await act(async () => {});
    const resolveButton = [
      ...container.querySelectorAll("button.linklike"),
    ].find((button) => button.textContent === "resolve") as HTMLElement;
    await act(async () => {
      resolveButton.click();
    });
    expect(resolvedIds).toEqual(["cm1"]);
    expect(getCommentsCalls).toHaveLength(2);
  });

  test("pendingAnchor opens the composer; submit creates the comment", async () => {
    createdComments.length = 0;
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={TEXT_ANCHOR}
        onPendingAnchorConsumed={() => {}}
        onHighlight={() => {}}
      />,
    );
    await act(async () => {});
    expect(container.innerHTML).toContain("on text b2:");
    expect(container.innerHTML).toContain("“beta”");
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBe(null);
    const valueSetter = Object.getOwnPropertyDescriptor(
      (textarea as HTMLTextAreaElement).constructor.prototype,
      "value",
    )?.set;
    await act(async () => {
      valueSetter?.call(textarea, "new note");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLElement;
    await act(async () => {
      submit.click();
    });
    expect(createdComments).toEqual([
      {
        boardId: "b1",
        input: { anchor: TEXT_ANCHOR, body: "new note", version_n: 2 },
      },
    ]);
  });

  test("reply flow uses the reply endpoint, not createComment", async () => {
    replied.length = 0;
    createdComments.length = 0;
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onHighlight={() => {}}
      />,
    );
    await act(async () => {});
    const replyButton = [...container.querySelectorAll("button.linklike")].find(
      (button) => button.textContent === "reply",
    ) as HTMLElement;
    await act(async () => {
      replyButton.click();
    });
    expect(container.innerHTML).toContain("reply to you");
    const textarea = container.querySelector("textarea");
    const valueSetter = Object.getOwnPropertyDescriptor(
      (textarea as HTMLTextAreaElement).constructor.prototype,
      "value",
    )?.set;
    await act(async () => {
      valueSetter?.call(textarea, "an answer");
      textarea?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLElement;
    await act(async () => {
      submit.click();
    });
    expect(replied).toEqual([["cm1", "an answer"]]);
    expect(createdComments).toHaveLength(0);
  });

  test("ended boards are read-only", async () => {
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="ended"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onHighlight={() => {}}
      />,
    );
    await act(async () => {});
    expect(container.innerHTML).toContain("read-only");
    expect(container.innerHTML).not.toContain("+ board");
    expect(
      [...container.querySelectorAll("button.linklike")].map(
        (button) => button.textContent,
      ),
    ).toEqual([]);
  });
});

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
