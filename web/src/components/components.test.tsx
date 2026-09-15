import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  Board,
  Version,
  VersionMeta,
} from "../../../server/src/domain.ts";
import { installDom } from "../test-dom.ts";
import { clearSessionToken, setSessionToken } from "../token.ts";
import { App, Gate } from "./App.tsx";
import { BoardList } from "./BoardList.tsx";
import { BoardView } from "./BoardView.tsx";

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

const MD_BOARD: Board = {
  id: "b1",
  title: "Decision brief",
  format: "markdown",
  status: "open",
  tags: ["plan"],
  created_by: "agent-1",
  created_at: "2026-09-15T10:00:00.000Z",
  current_version: 2,
};

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
  test("renders boards with status, author, and tags", async () => {
    const container = render(<BoardList />);
    await act(async () => {});
    expect(container.innerHTML).toContain("Decision brief");
    expect(container.innerHTML).toContain("open");
    expect(container.innerHTML).toContain("agent-1");
    expect(container.innerHTML).toContain("plan");
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
    const pills = container.querySelectorAll("button.pill");
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
