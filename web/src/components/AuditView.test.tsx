import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { BoardEvent, EventType } from "../../../server/src/domain.ts";
import {
  createComponentHarness,
  installDom,
  setVisibilityState,
} from "../test-dom.ts";
import { AuditView } from "./AuditView.tsx";
import { EventLogPanel } from "./EventLogPanel.tsx";
import { SessionsPanel } from "./SessionsPanel.tsx";
import { TokensPanel } from "./TokensPanel.tsx";
import {
  eventPages,
  eventQueries,
  installApiMock,
  revokeCalls,
  sessionsList,
  tokensList,
} from "./test-api.ts";

installDom();
installApiMock();

const { render, cleanup } = createComponentHarness();
afterEach(cleanup);

beforeEach(() => {
  // the api double's recorders are file-global — every test starts from zero
  eventQueries.length = 0;
  eventPages.length = 0;
  sessionsList.length = 0;
  tokensList.length = 0;
  revokeCalls.length = 0;
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function ev(
  seq: number,
  type: EventType,
  boardId: string | null = "b1",
): BoardEvent {
  return {
    seq,
    ts: "2026-09-16T10:00:00.000Z",
    actor: "agent-1",
    type,
    board_id: boardId,
    payload: { note: `payload-${seq}` },
  };
}

// Buttons are found by exact text — the panels' affordances are few.
function buttonByText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === text,
    ) ?? null
  );
}

describe("EventLogPanel", () => {
  test("renders events ascending, newest at the bottom, dash for global rows", async () => {
    eventPages.push({
      events: [ev(1, "board.created", null), ev(2, "board.published")],
      last_seq: 2,
    });
    const container = render(<EventLogPanel pollMs={60_000} />);
    await act(async () => {});
    const seqs = [...container.querySelectorAll(".event-seq")].map((td) =>
      Number(td.textContent),
    );
    expect(seqs).toEqual([1, 2]);
    const boards = [...container.querySelectorAll(".event-board")].map(
      (td) => td.textContent,
    );
    expect(boards).toEqual(["—", "b1"]);
    expect(container.querySelectorAll(".event-row")).toHaveLength(2);
    // catch-up state: cursor === last_seq → no load-more affordance
    expect(buttonByText(container, "load more")).toBe(null);
  });

  test("type filter issues the query and restarts the page from the head", async () => {
    // one page for the mount fetch, one for the filtered refetch
    eventPages.push(
      { events: [ev(1, "board.created")], last_seq: 2 },
      { events: [ev(7, "webhook.failed")], last_seq: 7 },
    );
    const container = render(<EventLogPanel pollMs={60_000} />);
    await act(async () => {});
    expect(eventQueries[0]?.type).toBeUndefined();
    expect(eventQueries[0]?.limit).toBe(200);
    const select = container.querySelector(
      "select[aria-label='filter by type']",
    ) as HTMLSelectElement;
    select.value = "webhook.failed";
    await act(async () => {
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(eventQueries[1]?.type).toBe("webhook.failed");
    expect(eventQueries[1]?.since).toBeUndefined();
    // the page was reset and refetched with the filter
    expect(
      [...container.querySelectorAll(".event-seq")].map((td) =>
        Number(td.textContent),
      ),
    ).toEqual([7]);
  });

  test("dead-letter rows carry the failed chip styling", async () => {
    eventPages.push({
      events: [ev(1, "board.published"), ev(2, "webhook.failed")],
      last_seq: 2,
    });
    const container = render(<EventLogPanel pollMs={60_000} />);
    await act(async () => {});
    const chips = [...container.querySelectorAll(".event-type")];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "board.published",
      "webhook.failed",
    ]);
    expect(chips[0].className).not.toContain("failed");
    expect(chips[1].className).toContain("failed");
  });

  test("load more pages forward via since = last row seq, then disappears", async () => {
    eventPages.push(
      {
        events: [ev(1, "board.created"), ev(2, "board.published")],
        last_seq: 5,
      },
      {
        events: [ev(4, "comment.created"), ev(5, "webhook.failed")],
        last_seq: 5,
      },
    );
    const container = render(<EventLogPanel pollMs={60_000} />);
    await act(async () => {});
    // behind the global cursor → load-more affordance shows
    const loadMore = buttonByText(container, "load more");
    expect(loadMore).not.toBe(null);
    await act(async () => {
      loadMore?.click();
    });
    expect(eventQueries[1]?.since).toBe(2);
    const seqs = [...container.querySelectorAll(".event-seq")].map((td) =>
      Number(td.textContent),
    );
    expect(seqs).toEqual([1, 2, 4, 5]);
    // cursor reached the global max → affordance gone
    expect(buttonByText(container, "load more")).toBe(null);
  });

  test("a row click expands the payload json, collapsed by default", async () => {
    eventPages.push({ events: [ev(3, "asset.added")], last_seq: 3 });
    const container = render(<EventLogPanel pollMs={60_000} />);
    await act(async () => {});
    expect(container.querySelector(".event-payload")).toBe(null);
    const row = container.querySelector(".event-row") as HTMLElement;
    await act(async () => {
      row.click();
    });
    const pre = container.querySelector(".event-payload");
    expect(pre?.textContent).toBe(
      JSON.stringify({ note: "payload-3" }, null, 2),
    );
    await act(async () => {
      row.click();
    });
    expect(container.querySelector(".event-payload")).toBe(null);
  });

  test("empty log shows the empty state, not a table", async () => {
    const container = render(<EventLogPanel pollMs={60_000} />);
    await act(async () => {});
    expect(container.innerHTML).toContain("No events yet.");
    expect(container.querySelector("table")).toBe(null);
  });

  test("polls only while the tab is visible; unmount stops the interval", async () => {
    render(<EventLogPanel pollMs={20} />);
    await act(async () => {});
    const afterMount = eventQueries.length;
    expect(afterMount).toBeGreaterThanOrEqual(1); // the mount fetch (and any immediate visible tick)
    // hidden tab: ticks are skipped
    setVisibilityState("hidden");
    await act(async () => {
      await sleep(60);
    });
    expect(eventQueries.length).toBe(afterMount);
    // back to the tab: an immediate catch-up fetch fires
    setVisibilityState("visible");
    await act(async () => {});
    expect(eventQueries.length).toBeGreaterThan(afterMount);
    // unmount kills the interval even while visible
    await cleanup();
    const afterUnmount = eventQueries.length;
    await act(async () => {
      await sleep(60);
    });
    expect(eventQueries.length).toBe(afterUnmount);
  });
});

describe("SessionsPanel", () => {
  test("revoke flow: arm confirm → DELETE called → row gone", async () => {
    sessionsList.push(
      {
        id: "sess-1",
        kind: "session",
        created_at: "2026-09-16T09:00:00.000Z",
        used_at: "2026-09-16T09:30:00.000Z",
        expires_at: null,
      },
      {
        id: "sess-2",
        kind: "exchange",
        created_at: "2026-09-16T08:00:00.000Z",
        used_at: null,
        expires_at: "2026-09-16T08:10:00.000Z",
      },
    );
    const container = render(<SessionsPanel />);
    await act(async () => {});
    expect(container.innerHTML).toContain("sess-1");
    const firstRow = [...container.querySelectorAll("tr")].find((tr) =>
      tr.textContent?.includes("sess-1"),
    ) as HTMLElement;
    const revoke = buttonByText(firstRow, "revoke");
    await act(async () => {
      revoke?.click();
    });
    // arming the confirm fires nothing — the destructive call needs the second click
    expect(revokeCalls).toEqual([]);
    expect(container.innerHTML).toContain("signed out");
    const confirm = buttonByText(firstRow, "confirm revoke");
    expect(confirm).not.toBe(null);
    await act(async () => {
      confirm?.click();
    });
    expect(revokeCalls).toEqual(["sess-1"]);
    // the refetch (server-faithful mock) dropped the row
    expect(container.innerHTML).not.toContain("sess-1");
    expect(container.innerHTML).toContain("sess-2");
  });

  test("kind chips distinguish live sessions from unexchanged exchange rows", async () => {
    sessionsList.push(
      {
        id: "sess-live",
        kind: "session",
        created_at: "2026-09-16T09:00:00.000Z",
        used_at: "2026-09-16T09:30:00.000Z",
        expires_at: null,
      },
      {
        id: "sess-unspent",
        kind: "exchange",
        created_at: "2026-09-16T08:00:00.000Z",
        used_at: null,
        expires_at: "2026-09-16T08:10:00.000Z",
      },
    );
    const container = render(<SessionsPanel />);
    await act(async () => {});
    const badges = [...container.querySelectorAll(".badge")];
    // listing order is created_at DESC → the later session row is first
    expect(badges.map((badge) => badge.textContent)).toEqual([
      "live",
      "unexchanged",
    ]);
    expect(badges[0].className).toContain("active");
    expect(badges[1].className).toContain("unexchanged");
  });

  test("used_at renders as the last-used column, — when never used", async () => {
    sessionsList.push(
      {
        id: "sess-used",
        kind: "session",
        created_at: "2026-09-16T09:00:00.000Z",
        used_at: "2026-09-16T09:30:00.000Z",
        expires_at: null,
      },
      {
        id: "sess-unused",
        kind: "exchange",
        created_at: "2026-09-16T08:00:00.000Z",
        used_at: null,
        expires_at: null,
      },
    );
    const container = render(<SessionsPanel />);
    await act(async () => {});
    const headers = [...container.querySelectorAll("th")].map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(["session", "kind", "created", "last used", ""]);
    const usedCell = (rowId: string): string | null => {
      const row = [...container.querySelectorAll("tr")].find((tr) =>
        tr.textContent?.includes(rowId),
      );
      return row?.querySelectorAll("td")[3]?.textContent ?? null;
    };
    // toLocaleString output is locale-dependent — assert a real timestamp
    // renders (a year is always present) and the unused row shows the dash
    expect(usedCell("sess-used")).toMatch(/\d{4}/);
    expect(usedCell("sess-unused")).toBe("—");
  });

  test("empty sessions shows the empty state", async () => {
    const container = render(<SessionsPanel />);
    await act(async () => {});
    expect(container.innerHTML).toContain("No sessions.");
  });
});

describe("TokensPanel", () => {
  test("renders lifecycle table with revoked treatment and no value column", async () => {
    tokensList.push(
      {
        name: "agent-1",
        created_at: "2026-09-15T10:00:00.000Z",
        revoked_at: null,
        last_seen: "2026-09-16T09:00:00.000Z",
      },
      {
        name: "old-agent",
        created_at: "2026-09-14T10:00:00.000Z",
        revoked_at: "2026-09-15T12:00:00.000Z",
        last_seen: null,
      },
    );
    const container = render(<TokensPanel />);
    await act(async () => {});
    const headers = [...container.querySelectorAll("th")].map(
      (th) => th.textContent,
    );
    expect(headers).toEqual(["name", "created", "last seen", "status"]);
    const badges = [...container.querySelectorAll(".badge")];
    expect(badges.map((badge) => badge.textContent)).toEqual([
      "active",
      "revoked",
    ]);
    expect(badges[1].className).toContain("revoked");
    expect(badges[0].className).toContain("active");
    // no values anywhere — the client never receives them (invariant 7)
    expect(container.innerHTML).not.toContain("value");
  });

  test("empty tokens shows the empty state", async () => {
    const container = render(<TokensPanel />);
    await act(async () => {});
    expect(container.innerHTML).toContain("No tokens.");
  });
});

describe("AuditView", () => {
  test("composes event log + sessions + tokens panels", async () => {
    const container = render(<AuditView />);
    await act(async () => {});
    expect(container.querySelector(".event-log")).not.toBe(null);
    expect(container.querySelector("[aria-label='Sessions']")).not.toBe(null);
    expect(container.querySelector("[aria-label='Tokens']")).not.toBe(null);
    // the back affordance returns to the board list
    expect(container.querySelector("a.back")?.getAttribute("href")).toBe("#/");
  });

  test("all-empty fixtures show every empty state", async () => {
    const container = render(<AuditView />);
    await act(async () => {});
    expect(container.innerHTML).toContain("No events yet.");
    expect(container.innerHTML).toContain("No sessions.");
    expect(container.innerHTML).toContain("No tokens.");
  });
});
