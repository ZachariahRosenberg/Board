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
import {
  renderHtmlDocument,
  renderMarkdownDocument,
  TASK_LIST_TITLE,
} from "../../../server/src/render.ts";
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
const uploadedAssets: Array<{ boardId: string; file: File }> = [];
let uploadAssetError: Error | null = null;

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

const IMAGE_ANCHOR: Anchor = {
  type: "image",
  asset_id: "assetImg01",
  overlay: {
    arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
    boxes: [{ x: 0.5, y: 0.1, text: "watch this" }],
  },
};

const IMAGE_COMMENT: Comment = {
  ...COMMENT_ROOT,
  id: "cm-img",
  seq: 13,
  anchor: IMAGE_ANCHOR,
  body: "The arrow points at the regression.",
};

const commentFixture: Comment[] = [
  COMMENT_ROOT,
  COMMENT_REPLY,
  COMMENT_RESOLVED,
  IMAGE_COMMENT,
];

// an overlay-only annotation arrives with an empty body (the overlay is the
// payload) — the thread must read fine with the anchor affordance alone
const EMPTY_BODY_COMMENTS: Comment[] = [
  {
    ...IMAGE_COMMENT,
    id: "cm-img-empty",
    seq: 14,
    body: "",
  },
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
    '<!doctype html><html><body><h1 data-ba="b1">Plan</h1><p data-ba="b2">alpha beta gamma</p><pre class="mermaid">graph TD</pre><table data-ba="b3"><tbody><tr data-ba="b3r1"><td>one</td></tr></tbody></table><p data-ba="b4"><img src="/assets/assetImg01" alt="shot"></p></body></html>',
  source_md: "# Plan",
  anchors: [],
  created_by: "agent-1",
  created_at: "2026-09-15T11:00:00.000Z",
};

// Full agent documents (head styles + body + scripts) as the publish
// pipeline now stores them (D18): ids injected server-side, scripts kept.
function htmlDoc(heading: string, style: string): string {
  return [
    "<!doctype html><html><head><title>Dashboard</title>",
    `<style>${style}</style>`,
    "</head><body>",
    '<section data-ba="s-header" data-ba-label="Header">',
    `<h1>${heading}</h1></section>`,
    "<p>unlabeled tail</p>",
    '<script src="/libs/chart-4.4.9.umd.min.js"></script>',
    "<script>window.__dashMounted = true;</script>",
    "</body></html>",
  ].join("");
}

const HTML_V1 = htmlDoc("Dashboard v1", ".dash-v1 { color: red; }");
const HTML_V2 = htmlDoc("Dashboard v2", ".dash-note { color: purple; }");

const HTML_VERSION: Version = {
  board_id: "b-html",
  n: 2,
  label: null,
  note: null,
  content: HTML_V2,
  source_md: null,
  anchors: [],
  created_by: "agent-1",
  created_at: "2026-09-15T11:00:00.000Z",
};

const HTML_COMMENTS: Comment[] = [
  {
    ...COMMENT_ROOT,
    anchor: { type: "section", section_id: "s-header" },
  },
];

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
    if (id === "b-html") {
      return { ...HTML_VERSION, n, content: n === 1 ? HTML_V1 : HTML_V2 };
    }
    return MD_VERSION;
  },
  exchange: async (token: string) => {
    exchangeCalls.push(token);
    return `session-for-${token}`;
  },
  getComments: async (boardId: string) => {
    getCommentsCalls.push(boardId);
    const comments =
      boardId === "b-html"
        ? HTML_COMMENTS
        : boardId === "b-empty"
          ? EMPTY_BODY_COMMENTS
          : commentFixture;
    return {
      comments,
      last_seq: comments.at(-1)?.seq ?? 0,
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
  uploadAsset: async (boardId: string, file: File) => {
    if (uploadAssetError !== null) {
      throw uploadAssetError;
    }
    uploadedAssets.push({ boardId, file });
    return {
      id: "uploadedAsset",
      board_id: boardId,
      file: "uploadedAsset.png",
      mime: file.type,
      size: 64,
      source: "binary" as const,
      created_by: "human",
      created_at: "2026-09-15T20:00:00.000Z",
    };
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

  test("html board renders into .board-content — no iframe anywhere (D18)", async () => {
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    expect(container.querySelector("iframe")).toBe(null);
    const content = container.querySelector("div.board-content");
    expect(content).not.toBe(null);
    // body children mounted, opt-in data-ba sections intact
    const section = content?.querySelector('[data-ba="s-header"]');
    expect(section?.getAttribute("data-ba-label")).toBe("Header");
    expect(section?.textContent).toBe("Dashboard v2");
    // head styles land in the container (board templates keep CSS in <head>)
    expect(content?.querySelector("style")?.textContent).toContain(
      ".dash-note",
    );
    // scripts re-created in document order — the external one is created and
    // awaited BEFORE the inline runs (dogfooded: "Chart is not defined"). In
    // tests script fetching is disabled, so the load event is dispatched by
    // hand to advance the sequence.
    let scripts = [...(content?.querySelectorAll("script") ?? [])];
    expect(scripts).toHaveLength(1);
    expect(scripts[0].getAttribute("src")).toBe("/libs/chart-4.4.9.umd.min.js");
    await act(async () => {
      scripts[0].dispatchEvent(new Event("load"));
    });
    scripts = [...(content?.querySelectorAll("script") ?? [])];
    expect(scripts).toHaveLength(2);
    expect(scripts[1].getAttribute("src")).toBe(null);
    expect(scripts[1].text).toContain("__dashMounted");
  });

  test("html board inline scripts actually run in the host DOM (D18)", async () => {
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    const src = container.querySelector(
      "div.board-content script[src]",
    ) as HTMLScriptElement;
    await act(async () => {
      src.dispatchEvent(new Event("load"));
    });
    expect(
      (window as unknown as { __dashMounted?: boolean }).__dashMounted,
    ).toBe(true);
  });

  test("markdown boards render no iframe", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    expect(container.querySelector("iframe")).toBe(null);
    expect(container.querySelector("div.board-content")).not.toBe(null);
  });

  test("board content carries the board format class", async () => {
    // snapshot-only styling (static markdown task-list glyphs) must never
    // reach html boards, whose checkboxes may be interactive (D18)
    const md = render(<BoardView id="b1" />);
    await act(async () => {});
    expect(
      md.querySelector("div.board-content")?.classList.contains("markdown"),
    ).toBe(true);
    const html = render(<BoardView id="b-html" />);
    await act(async () => {});
    expect(
      html.querySelector("div.board-content")?.classList.contains("html"),
    ).toBe(true);
  });

  test("switching versions remounts the html document in place", async () => {
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    expect(container.querySelector("div.board-content")?.textContent).toContain(
      "Dashboard v2",
    );
    const pill = container.querySelector(
      "nav.version-switcher button.pill",
    ) as HTMLElement;
    await act(async () => {
      pill.click();
    });
    expect(container.querySelector("div.board-content")?.textContent).toContain(
      "Dashboard v1",
    );
    expect(
      container.querySelectorAll("div.board-content section"),
    ).toHaveLength(1);
  });

  test("highlighting an html-board anchor outlines the section in the host DOM", async () => {
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    const chip = container.querySelector(
      "button.anchor-chip.clickable",
    ) as HTMLElement;
    await act(async () => {
      chip.click();
    });
    expect(
      container
        .querySelector('[data-ba="s-header"]')
        ?.classList.contains("anchor-target"),
    ).toBe(true);
  });

  test("hover affordance works on html boards (the host DOM is the board)", async () => {
    const container = render(<BoardView id="b-html" />);
    await act(async () => {});
    const section = container.querySelector(
      '[data-ba="s-header"]',
    ) as HTMLElement;
    await act(async () => {
      section.dispatchEvent(
        new window.MouseEvent("mouseover", { bubbles: true }),
      );
    });
    const button = container.querySelector("button.floating-comment");
    expect(button?.textContent).toBe("Comment on section");
    await act(async () => {
      (button as HTMLElement).click();
    });
    expect(container.querySelector("div.composer")).not.toBe(null);
    expect(container.innerHTML).toContain("on section s-header");
  });

  test("selection affordance survives the pointer crossing sections and opens the composer", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const content = container.querySelector("div.board-content");
    expect(content).not.toBe(null);
    const para = content?.querySelector('[data-ba="b2"]');
    const text = para?.firstChild;
    if (text === undefined || text === null) {
      throw new Error("fixture missing text node");
    }
    // the flow under test is events → affordance state, not happy-dom's
    // Selection internals — stub getSelection (a real selection left on the
    // shared document poisons later React event tests)
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    const realGetSelection = window.getSelection.bind(window);
    window.getSelection = () =>
      ({
        isCollapsed: false,
        rangeCount: 1,
        getRangeAt: () => range,
        removeAllRanges: () => {},
      }) as unknown as Selection;
    try {
      await act(async () => {
        document.dispatchEvent(new Event("mouseup"));
      });
      let button = container.querySelector("button.floating-comment");
      expect(button?.textContent).toBe("Comment on selection");
      // crossing another section toward the button must NOT swap the
      // affordance out mid-flight (the reported "clicking does nothing" bug)
      await act(async () => {
        const section = content?.querySelector('[data-ba="b1"]') as
          | HTMLElement
          | undefined;
        section?.dispatchEvent(
          new window.MouseEvent("mouseover", { bubbles: true }),
        );
      });
      button = container.querySelector("button.floating-comment");
      expect(button?.textContent).toBe("Comment on selection");
      // clicking it opens the composer with the quoted text anchor
      await act(async () => {
        (button as HTMLElement).click();
      });
      expect(container.querySelector("div.composer")).not.toBe(null);
      expect(container.innerHTML).toContain("on text b2:");
      expect(container.innerHTML).toContain("“beta”");
    } finally {
      window.getSelection = realGetSelection;
    }
  });

  test("collapsing the selection dismisses the selection affordance", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const content = container.querySelector("div.board-content");
    const para = content?.querySelector('[data-ba="b2"]');
    const text = para?.firstChild;
    if (text === undefined || text === null) {
      throw new Error("fixture missing text node");
    }
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    const realGetSelection = window.getSelection.bind(window);
    let collapsed = false;
    window.getSelection = () =>
      ({
        get isCollapsed() {
          return collapsed;
        },
        rangeCount: collapsed ? 0 : 1,
        getRangeAt: () => range,
        removeAllRanges: () => {},
      }) as unknown as Selection;
    try {
      await act(async () => {
        document.dispatchEvent(new Event("mouseup"));
      });
      expect(container.querySelector("button.floating-comment")).not.toBe(null);
      collapsed = true;
      await act(async () => {
        document.dispatchEvent(new Event("selectionchange"));
      });
      expect(container.querySelector("button.floating-comment")).toBe(null);
    } finally {
      window.getSelection = realGetSelection;
    }
  });

  test("hover affordance pins on the floating button and opens the composer", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const content = container.querySelector("div.board-content");
    expect(content).not.toBe(null);
    const heading = content?.querySelector('[data-ba="b1"]') as HTMLElement;
    await act(async () => {
      heading.dispatchEvent(
        new window.MouseEvent("mouseover", { bubbles: true }),
      );
    });
    let button = container.querySelector("button.floating-comment");
    expect(button?.textContent).toBe("Comment on section");
    // leaving the section TOWARD the button must keep it alive — React
    // synthesizes the button's mouseenter from this very event (the pin)
    await act(async () => {
      heading.dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: button ?? undefined,
        }),
      );
    });
    expect(container.querySelector("button.floating-comment")).not.toBe(null);
    // leaving the BUTTON (to nowhere) unpins and clears the affordance
    await act(async () => {
      (button as HTMLElement).dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: null,
        }),
      );
    });
    expect(container.querySelector("button.floating-comment")).toBe(null);
    // re-hover; leaving the section to nowhere (never pinned) clears too
    await act(async () => {
      heading.dispatchEvent(
        new window.MouseEvent("mouseover", { bubbles: true }),
      );
    });
    expect(container.querySelector("button.floating-comment")).not.toBe(null);
    await act(async () => {
      heading.dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: null,
        }),
      );
    });
    expect(container.querySelector("button.floating-comment")).toBe(null);
    // hover once more and click — the composer opens with a section anchor
    await act(async () => {
      heading.dispatchEvent(
        new window.MouseEvent("mouseover", { bubbles: true }),
      );
    });
    button = container.querySelector("button.floating-comment");
    await act(async () => {
      (button as HTMLElement).click();
    });
    expect(container.querySelector("div.composer")).not.toBe(null);
    expect(container.innerHTML).toContain("on section b1");
  });
});

describe("Gate", () => {
  test("renders the paste gate; an empty submit is a no-op", async () => {
    exchangeCalls.length = 0;
    let ready = false;
    const container = render(<Gate onReady={() => (ready = true)} />);
    expect(container.querySelector("input")).not.toBe(null);
    const submitButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "open",
    ) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(exchangeCalls).toEqual([]);
    expect(ready).toBe(false);
    expect(container.innerHTML).toContain("make open");
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
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={(anchor) => {
          highlightCalls.push(anchor);
        }}
        onSwitchVersion={() => {}}
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
    expect(container.innerHTML).toContain("2 unresolved / 3 threads");
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
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
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

  test("hide-resolved toggle folds resolved threads away and back", async () => {
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    expect(container.innerHTML).toContain("✓ resolved");
    const hide = [...container.querySelectorAll("button.pill")].find(
      (button) => button.textContent === "hide resolved",
    ) as HTMLElement;
    await act(async () => {
      hide.click();
    });
    expect(container.innerHTML).not.toContain("✓ resolved");
    // the header counts stay honest while folded
    expect(container.innerHTML).toContain("2 unresolved / 3 threads");
    const show = [...container.querySelectorAll("button.pill")].find(
      (button) => button.textContent === "show resolved",
    ) as HTMLElement;
    await act(async () => {
      show.click();
    });
    expect(container.innerHTML).toContain("✓ resolved");
  });

  test("no section picker anywhere (removed by D18 — host affordances cover every board)", async () => {
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    expect(container.innerHTML).not.toContain("+ section");
    expect(container.querySelectorAll("button.section-option")).toHaveLength(0);
  });

  test("pendingAnchor opens the composer with the anchor chip and quote", async () => {
    createdComments.length = 0;
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={TEXT_ANCHOR}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    expect(container.innerHTML).toContain("on text b2:");
    expect(container.innerHTML).toContain("“beta”");
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBe(null);
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLButtonElement;
    // empty body keeps the composer guarded
    expect(submit.disabled).toBe(true);
    expect(createdComments).toHaveLength(0);
  });

  test("reply button opens a reply composer; an empty submit is a no-op", async () => {
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
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
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
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => {
      submit.click();
    });
    expect(replied).toHaveLength(0);
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
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
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

  test("a thread pinned to another version gets an on v<n> jump that switches versions", async () => {
    const switchCalls: number[] = [];
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={1}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={(n) => {
          switchCalls.push(n);
        }}
      />,
    );
    await act(async () => {});
    const jump = [...container.querySelectorAll("button.linklike")].find(
      (button) => button.textContent === "on v2",
    );
    expect(jump).not.toBe(undefined);
    await act(async () => {
      (jump as HTMLElement).click();
    });
    expect(switchCalls).toEqual([2]);
  });

  test("no jump affordance when the thread is pinned to the viewed version", async () => {
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    expect(
      [...container.querySelectorAll("button.linklike")].filter((button) =>
        (button.textContent ?? "").startsWith("on v"),
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

// React controlled-input helper: write via the prototype's native setter (not
// the element's, which React wraps with a value tracker), then drop the stale
// tracker so updateValueIfChanged sees the change when the input event lands.
function typeInto(field: Element, text: string): void {
  const proto =
    field instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(field, text);
  delete (field as unknown as { _valueTracker?: unknown })._valueTracker;
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function dropEvent(files: File[]): Event {
  const event = new window.Event("drop", { bubbles: true }) as Event & {
    dataTransfer: { files: File[] };
  };
  event.dataTransfer = { files };
  return event;
}

describe("CommentSidebar image upload", () => {
  const pngFile = new window.File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    "shot.png",
    { type: "image/png" },
  );

  test("dropping an image uploads it to /api/assets with the board id and opens the editor", async () => {
    uploadedAssets.length = 0;
    uploadAssetError = null;
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    const sidebar = container.querySelector("aside.comment-sidebar");
    expect(sidebar).not.toBe(null);
    await act(async () => {
      (sidebar as HTMLElement).dispatchEvent(dropEvent([pngFile]));
    });
    expect(uploadedAssets).toEqual([
      { boardId: "b1", file: expect.anything() },
    ]);
    const editor = container.querySelector(".overlay-editor");
    expect(editor).not.toBe(null);
    expect(
      container.querySelector(".overlay-editor-stage img")?.getAttribute("src"),
    ).toBe("/assets/uploadedAsset");
  });

  test("editor done → composer holds the pending image anchor; posting sends it", async () => {
    uploadedAssets.length = 0;
    createdComments.length = 0;
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    await act(async () => {
      (
        container.querySelector("aside.comment-sidebar") as HTMLElement
      ).dispatchEvent(dropEvent([pngFile]));
    });
    const done = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "done",
    ) as HTMLElement;
    await act(async () => {
      done.click();
    });
    expect(container.innerHTML).toContain("on image uploadedAsset");
    const textarea = container.querySelector("textarea") as HTMLElement;
    await act(async () => {
      typeInto(textarea, "look at the arrow");
    });
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLElement;
    await act(async () => {
      submit.click();
    });
    expect(createdComments).toHaveLength(1);
    expect(createdComments[0].boardId).toBe("b1");
    expect(createdComments[0].input.anchor).toEqual({
      type: "image",
      asset_id: "uploadedAsset",
      overlay: { arrows: [], boxes: [] },
    });
    expect(createdComments[0].input.body).toBe("look at the arrow");
  });

  test("an overlay-only annotation posts with an empty body (the overlay is the payload)", async () => {
    uploadedAssets.length = 0;
    createdComments.length = 0;
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    await act(async () => {
      (
        container.querySelector("aside.comment-sidebar") as HTMLElement
      ).dispatchEvent(dropEvent([pngFile]));
    });
    // draw one arrow, commit no text
    const stage = container.querySelector(
      ".overlay-editor-stage",
    ) as HTMLElement;
    stage.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 800, height: 400 }) as DOMRect;
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
    const canvas = container.querySelector(
      ".overlay-editor-canvas",
    ) as HTMLElement;
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mousedown", {
          bubbles: true,
          clientX: 210,
          clientY: 220,
        }),
      );
    });
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mousemove", {
          bubbles: true,
          clientX: 610,
          clientY: 220,
        }),
      );
    });
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mouseup", {
          bubbles: true,
          clientX: 610,
          clientY: 220,
        }),
      );
    });
    const done = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "done",
    ) as HTMLElement;
    await act(async () => {
      done.click();
    });
    // empty body does NOT guard the composer anymore — the overlay enables it
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.click();
    });
    expect(createdComments).toHaveLength(1);
    expect(createdComments[0].input.body).toBe("");
    expect(createdComments[0].input.anchor).toEqual({
      type: "image",
      asset_id: "uploadedAsset",
      overlay: {
        arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
        boxes: [],
      },
    });
  });

  test("editor done with an EMPTY overlay still requires body text", async () => {
    uploadedAssets.length = 0;
    createdComments.length = 0;
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    await act(async () => {
      (
        container.querySelector("aside.comment-sidebar") as HTMLElement
      ).dispatchEvent(dropEvent([pngFile]));
    });
    const done = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "done",
    ) as HTMLElement;
    await act(async () => {
      done.click();
    });
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLButtonElement;
    // no overlay items + no text → still guarded, Enter included
    expect(submit.disabled).toBe(true);
    const textarea = container.querySelector("textarea") as HTMLElement;
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
    });
    await act(async () => {});
    expect(createdComments).toHaveLength(0);
  });

  test("editor cancel discards — no composer, no comment", async () => {
    uploadedAssets.length = 0;
    createdComments.length = 0;
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    await act(async () => {
      (
        container.querySelector("aside.comment-sidebar") as HTMLElement
      ).dispatchEvent(dropEvent([pngFile]));
    });
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "cancel",
    ) as HTMLElement;
    await act(async () => {
      cancel.click();
    });
    expect(container.querySelector(".overlay-editor")).toBe(null);
    expect(container.querySelector("div.composer")).toBe(null);
    expect(createdComments).toHaveLength(0);
  });

  test("upload errors surface in the composer area", async () => {
    uploadedAssets.length = 0;
    uploadAssetError = new Error(
      'asset type not allowed: "image/x-icon" is not on the image allowlist',
    );
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    await act(async () => {
      (
        container.querySelector("aside.comment-sidebar") as HTMLElement
      ).dispatchEvent(dropEvent([pngFile]));
    });
    expect(container.innerHTML).toContain("asset type not allowed");
    expect(container.querySelector(".overlay-editor")).toBe(null);
    // a failed upload opens no editor and never stages a local blob: preview
    // (the host CSP is img-src 'self' data: — blob: could never render)
    expect(container.innerHTML).not.toContain("blob:");
    expect(container.querySelector(".overlay-editor-stage img")).toBe(null);
    uploadAssetError = null;
  });

  test("image-anchored thread renders a thumbnail from the served asset URL", async () => {
    // dogfooded: the thread chip was a bare text label — nothing confirmed
    // the attachment existed. The thumb rides the same /assets/<id> URL the
    // board uses (CSP img-src 'self'), on the thread root's image anchor.
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    const thumbs = [
      ...container.querySelectorAll("img.comment-image-thumb"),
    ] as HTMLImageElement[];
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0].getAttribute("src")).toBe("/assets/assetImg01");
    expect(thumbs[0].getAttribute("src")).not.toContain("blob:");
    // it belongs to the image-anchored thread, not the text ones
    expect(thumbs[0].closest(".thread")?.textContent).toContain(
      "The arrow points at the regression.",
    );
  });

  test("thread thumbnails render the comment's own overlay and click through to the lightbox", async () => {
    // dogfooded ask [163]: "I don't see the annotations in the thumbnail" —
    // the shared overlay renderer scales the comment's overlay onto the thumb
    const openCalls: string[] = [];
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={(assetId) => {
          openCalls.push(assetId);
        }}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    const thumb = container.querySelector(
      "button.comment-thumb",
    ) as HTMLElement;
    expect(thumb).not.toBe(null);
    const layer = thumb.querySelector(".image-overlay-layer") as HTMLElement;
    expect(layer).not.toBe(null);
    // measure at the thumb's box (160px max width) → svg renders in that space
    layer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 160, height: 120 }) as DOMRect;
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
    const svg = thumb.querySelector("svg.image-overlay-svg");
    expect(svg?.getAttribute("width")).toBe("160");
    expect(svg?.getAttribute("height")).toBe("120");
    // arrow (0.25, 0.5) → (0.75, 0.5) scaled onto the 160×120 thumb
    const line = svg?.querySelector("line");
    expect(line?.getAttribute("x1")).toBe("40");
    expect(line?.getAttribute("y1")).toBe("60");
    expect(line?.getAttribute("x2")).toBe("120");
    expect(line?.getAttribute("y2")).toBe("60");
    expect(svg?.querySelector("text")?.textContent).toBe("watch this");
    // clicking reports the asset up to the board view (the lightbox lives
    // there); the chip's hover-preview and highlight behaviors are untouched
    await act(async () => {
      thumb.click();
    });
    expect(openCalls).toEqual(["assetImg01"]);
  });

  test("composer with a pending image anchor previews the held image", async () => {
    const container = render(
      <CommentSidebar
        boardId="b1"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={IMAGE_ANCHOR}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    const composer = container.querySelector("div.composer");
    expect(composer).not.toBe(null);
    const thumb = composer?.querySelector(
      "img.comment-image-thumb",
    ) as HTMLImageElement;
    expect(thumb).not.toBe(null);
    expect(thumb.getAttribute("src")).toBe("/assets/assetImg01");
    // the annotate affordance stays next to the preview
    expect(composer?.innerHTML).toContain("annotate");
  });

  test("an overlay-only thread (empty body) shows the anchor affordance alone", async () => {
    const container = render(
      <CommentSidebar
        boardId="b-empty"
        boardStatus="open"
        versionN={2}
        refreshKey={0}
        pendingAnchor={null}
        onPendingAnchorConsumed={() => {}}
        onCommentsChange={() => {}}
        onImageHover={() => {}}
        onOpenImage={() => {}}
        onHighlight={() => {}}
        onSwitchVersion={() => {}}
      />,
    );
    await act(async () => {});
    const thread = container.querySelector("div.thread") as HTMLElement;
    expect(thread).not.toBe(null);
    // the image affordances render — thumbnail + chip
    expect(thread.querySelector("img.comment-image-thumb")).not.toBe(null);
    expect(thread.querySelector("button.anchor-chip")).not.toBe(null);
    // no empty body block
    expect(thread.querySelector(".thread-body")).toBe(null);
  });
});

describe("BoardView image annotation", () => {
  test("hovering a board image offers annotate; clicking opens an image-anchor composer", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const img = container.querySelector(
      ".image-anchor-wrap img",
    ) as HTMLElement;
    expect(img).not.toBe(null);
    await act(async () => {
      img.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    });
    const button = container.querySelector("button.floating-comment");
    expect(button?.textContent).toBe("annotate image");
    await act(async () => {
      (button as HTMLElement).click();
    });
    expect(container.querySelector("div.composer")).not.toBe(null);
    expect(container.innerHTML).toContain("on image assetImg01");
    // the composer offers the editor on the already-published asset
    expect(container.innerHTML).toContain("annotate");
  });

  test("image-anchored threads badge their image and hover-preview the overlay as svg", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    // badge on the wrapped image (one unresolved image thread)
    expect(container.querySelector(".image-anchor-badge")?.textContent).toBe(
      "1",
    );
    // hovering the thread's chip mounts the overlay layer on the image
    const chip = [...container.querySelectorAll("button.anchor-chip")].find(
      (button) => button.textContent === "image assetImg01",
    ) as HTMLElement;
    await act(async () => {
      chip.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    });
    const layer = container.querySelector(
      ".image-overlay-layer",
    ) as HTMLElement;
    expect(layer).not.toBe(null);
    // measure with a known image box → the svg renders in scaled pixel space
    layer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 400 }) as DOMRect;
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
    const svg = container.querySelector("svg.image-overlay-svg");
    expect(svg?.getAttribute("width")).toBe("800");
    expect(svg?.getAttribute("height")).toBe("400");
    const line = svg?.querySelector("line");
    // arrow (0.25, 0.5) → (0.75, 0.5) scaled to the 800×400 box
    expect(line?.getAttribute("x1")).toBe("200");
    expect(line?.getAttribute("y1")).toBe("200");
    expect(line?.getAttribute("x2")).toBe("600");
    expect(line?.getAttribute("y2")).toBe("200");
    const text = svg?.querySelector("text");
    expect(text?.getAttribute("x")).toBe("400");
    expect(text?.getAttribute("y")).toBe("40");
    expect(text?.textContent).toBe("watch this");
    // leaving the chip unmounts the overlay ON THE BOARD IMAGE (the
    // thumbnail's own scaled overlay from the thread is independent of chip
    // hover and stays)
    await act(async () => {
      chip.dispatchEvent(
        new window.MouseEvent("mouseout", {
          bubbles: true,
          relatedTarget: null,
        }),
      );
    });
    expect(
      container.querySelector(".image-anchor-wrap .image-overlay-layer"),
    ).toBe(null);
    expect(
      container.querySelector(".comment-thumb .image-overlay-layer"),
    ).not.toBe(null);
  });

  test("an image thread chip click highlights the board image (anchor-target parity)", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const chip = [...container.querySelectorAll("button.anchor-chip")].find(
      (button) => button.textContent === "image assetImg01",
    ) as HTMLElement;
    await act(async () => {
      chip.click();
    });
    const img = container.querySelector(".image-anchor-wrap img");
    expect(img?.classList.contains("anchor-target")).toBe(true);
  });

  test("clicking a board image opens the lightbox with the asset's overlays", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const img = container.querySelector(
      ".image-anchor-wrap img",
    ) as HTMLElement;
    await act(async () => {
      img.click();
    });
    const backdrop = container.querySelector(".lightbox-backdrop");
    expect(backdrop).not.toBe(null);
    const stage = container.querySelector(".lightbox-stage") as HTMLElement;
    const lightImg = stage.querySelector("img") as HTMLImageElement;
    expect(lightImg.getAttribute("src")).toBe("/assets/assetImg01");
    // every image-anchored thread's overlay for this asset renders in the
    // modal — measured against the stage box, the shared renderer
    const layer = stage.querySelector(".image-overlay-layer") as HTMLElement;
    expect(layer).not.toBe(null);
    layer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 400 }) as DOMRect;
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
    const svg = stage.querySelector("svg.image-overlay-svg");
    expect(svg?.getAttribute("width")).toBe("800");
    expect(svg?.getAttribute("height")).toBe("400");
    // arrow (0.25, 0.5) → (0.75, 0.5) scaled to the 800×400 box
    const line = svg?.querySelector("line");
    expect(line?.getAttribute("x2")).toBe("600");
    const text = svg?.querySelector("text");
    expect(text?.textContent).toBe("watch this");
    expect(stage.querySelectorAll(".image-overlay-layer")).toHaveLength(1);
  });

  test("lightbox annotate routes through the existing composer → editor flow", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const img = container.querySelector(
      ".image-anchor-wrap img",
    ) as HTMLElement;
    await act(async () => {
      img.click();
    });
    const annotate = [
      ...container.querySelectorAll(".lightbox-toolbar button"),
    ].find((button) => button.textContent === "annotate") as HTMLElement;
    await act(async () => {
      annotate.click();
    });
    // the modal closed; the composer holds the image anchor — the floating
    // "annotate image" button's exact flow (pendingAnchor → composer)
    expect(container.querySelector(".lightbox-backdrop")).toBe(null);
    expect(container.innerHTML).toContain("on image assetImg01");
    // and the composer's annotate affordance mounts the existing editor
    const composerAnnotate = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "annotate",
    ) as HTMLElement;
    await act(async () => {
      composerAnnotate.click();
    });
    expect(container.querySelector(".overlay-editor")).not.toBe(null);
    expect(
      container.querySelector(".overlay-editor-stage img")?.getAttribute("src"),
    ).toBe("/assets/assetImg01");
  });

  test("lightbox → annotate → editor captures drawn items in the posted anchor (regression)", async () => {
    // owner report: a second annotation entered from the lightbox arrived
    // with overlay {arrows:[], boxes:[]}. Drives the FULL path — lightbox
    // annotate button → pendingAnchor → composer → editor → one arrow +
    // one textbox → done → post with an EMPTY body (the overlay is the
    // payload) — and asserts both items survive into the posted anchor.
    uploadedAssets.length = 0;
    createdComments.length = 0;
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    // 1. enter from the LIGHTBOX: click the board image → review modal
    const img = container.querySelector(
      ".image-anchor-wrap img",
    ) as HTMLElement;
    await act(async () => {
      img.click();
    });
    expect(container.querySelector(".lightbox-backdrop")).not.toBe(null);
    // 2. the lightbox annotate button stages the pending image anchor
    const annotate = [
      ...container.querySelectorAll(".lightbox-toolbar button"),
    ].find((button) => button.textContent === "annotate") as HTMLElement;
    await act(async () => {
      annotate.click();
    });
    expect(container.querySelector(".lightbox-backdrop")).toBe(null);
    expect(container.innerHTML).toContain("on image assetImg01");
    // 3. the composer's annotate affordance opens the shared editor
    const composerAnnotate = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "annotate",
    ) as HTMLElement;
    await act(async () => {
      composerAnnotate.click();
    });
    const editor = container.querySelector(".overlay-editor");
    expect(editor).not.toBe(null);
    // 4. draw one arrow (press-drag-release) in the editor's canvas
    const stage = container.querySelector(
      ".overlay-editor-stage",
    ) as HTMLElement;
    stage.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 800, height: 400 }) as DOMRect;
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
    const canvas = container.querySelector(
      ".overlay-editor-canvas",
    ) as HTMLElement;
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mousedown", {
          bubbles: true,
          clientX: 210,
          clientY: 220,
        }),
      );
    });
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mousemove", {
          bubbles: true,
          clientX: 610,
          clientY: 220,
        }),
      );
    });
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mouseup", {
          bubbles: true,
          clientX: 610,
          clientY: 220,
        }),
      );
    });
    // 5. draw one textbox: place a label and commit its text with Enter
    const textPill = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "text",
    ) as HTMLElement;
    await act(async () => {
      textPill.click();
    });
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("click", {
          bubbles: true,
          clientX: 410,
          clientY: 60,
        }),
      );
    });
    const input = container.querySelector(
      ".overlay-editor-input",
    ) as HTMLInputElement;
    expect(input).not.toBe(null);
    input.value = "hold this";
    await act(async () => {
      input.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    // 6. Done — the editor hands its overlay to the composer's anchor
    const done = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "done",
    ) as HTMLElement;
    await act(async () => {
      done.click();
    });
    expect(container.querySelector(".overlay-editor")).toBe(null);
    // 7. post with an EMPTY body via Enter — the composer must submit
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    const textarea = container.querySelector("textarea") as HTMLElement;
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
    });
    await act(async () => {});
    // the posted anchor carries BOTH drawn items — no state reset, no
    // overlay dropped between the editor's Done and the POST body
    expect(createdComments).toHaveLength(1);
    expect(createdComments[0].input.body).toBe("");
    expect(createdComments[0].input.anchor).toEqual({
      type: "image",
      asset_id: "assetImg01",
      overlay: {
        arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
        boxes: [{ x: 0.5, y: 0.1, text: "hold this" }],
      },
    });
  });

  test("Escape and a backdrop click close the lightbox; a click on the image box does not", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const img = container.querySelector(
      ".image-anchor-wrap img",
    ) as HTMLElement;
    const open = async (): Promise<void> => {
      await act(async () => {
        img.click();
      });
    };
    await open();
    expect(container.querySelector(".lightbox-backdrop")).not.toBe(null);
    await act(async () => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(container.querySelector(".lightbox-backdrop")).toBe(null);
    await open();
    const backdrop = container.querySelector(
      ".lightbox-backdrop",
    ) as HTMLElement;
    await act(async () => {
      backdrop.click();
    });
    expect(container.querySelector(".lightbox-backdrop")).toBe(null);
    await open();
    // a click inside the image box is not a backdrop click (event.target vs
    // currentTarget) — reviewing stays put
    const stage = container.querySelector(".lightbox-stage") as HTMLElement;
    await act(async () => {
      stage.click();
    });
    expect(container.querySelector(".lightbox-backdrop")).not.toBe(null);
  });

  test("clicking a thread thumbnail opens the lightbox for that asset", async () => {
    const container = render(<BoardView id="b1" />);
    await act(async () => {});
    const thumb = container.querySelector(
      "button.comment-thumb",
    ) as HTMLElement;
    expect(thumb).not.toBe(null);
    await act(async () => {
      thumb.click();
    });
    expect(container.querySelector(".lightbox-backdrop")).not.toBe(null);
    const lightImg = container.querySelector(
      ".lightbox-stage img",
    ) as HTMLImageElement;
    expect(lightImg.getAttribute("src")).toBe("/assets/assetImg01");
  });
});

describe("markdown task-list glyphs (static snapshot affordance)", () => {
  // the render pipeline is the implementation of the task-list affordance
  // (marked GFM → DOMPurify → glyph replacement in server/src/render.ts); the
  // muted/inert LOOK is CSS (styles.css, scoped to .board-content.markdown).
  // These assert the DOM attributes/structure the CSS keys off.
  test("GFM task lists render glyph spans, not checkbox inputs", async () => {
    const { html } = await renderMarkdownDocument(
      "- [ ] unchecked thing\n- [x] checked thing\n",
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    // no control semantics left — the dogfooded complaint was that a disabled
    // input still LOOKS interactive
    expect(doc.querySelectorAll("input")).toHaveLength(0);
    const glyphs = [...doc.querySelectorAll("span.task-glyph")];
    expect(glyphs).toHaveLength(2);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute("title")).toBe(TASK_LIST_TITLE);
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
    }
    // `- [x]` state survives the pipeline, as a clearly distinct glyph
    expect(glyphs[0].textContent).toBe("☐");
    expect(glyphs[1].textContent).toBe("☑");
  });

  test("html boards get no snapshot title — their checkboxes may be interactive (D18)", () => {
    const { html } = renderHtmlDocument(
      '<body><form><input type="checkbox"></form></body>',
    );
    expect(html).not.toContain(TASK_LIST_TITLE);
    expect(html).toContain('type="checkbox"');
  });
});
