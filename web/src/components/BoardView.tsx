import { useEffect, useRef, useState } from "react";
import type { Anchor, Version } from "../../../server/src/domain.ts";
import {
  anchorForElement,
  anchorFragment,
  anchorFromSelection,
  highlightAnchor,
} from "../anchor.ts";
import {
  type BoardWithVersions,
  getBoard,
  getOriginUrl,
  getVersion,
  streamUrl,
} from "../api.ts";
import { formatDate } from "../format.ts";
import { BoardStream } from "../sse.ts";
import { CommentSidebar } from "./CommentSidebar.tsx";

// Markdown-derived content was sanitized server-side at publish (script-free
// by construction) — injecting it here IS the sanctioned host-chrome display
// mode (docs/architecture.md). html-format content is NEVER injected (M4
// sandbox territory); the placeholder notice covers it.
function boardBodyHtml(content: string): string {
  const doc = new DOMParser().parseFromString(content, "text/html");
  return doc.body.innerHTML;
}

interface Affordance {
  anchor: Anchor;
  top: number;
  left: number;
  label: string;
}

export function BoardView({ id }: { id: string }) {
  const [data, setData] = useState<BoardWithVersions | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [affordance, setAffordance] = useState<Affordance | null>(null);
  const [pendingAnchor, setPendingAnchor] = useState<Anchor | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [originUrl, setOriginUrl] = useState<string | null>(null);
  // html boards are aimed by URL fragment (anchor chip clicks) — see onHighlight
  const [frameFragment, setFrameFragment] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverTargetRef = useRef<Element | null>(null);
  // The floating button pins the affordance while the pointer is on it —
  // without the pin, leaving the section toward the button unmounts it
  // before the click lands (the reported "icon disappears" bug).
  const pinnedRef = useRef(false);
  // While a selection affordance is up, hover affordances are suppressed —
  // the pointer crosses other sections on the way to the button and would
  // swap it out mid-flight (the reported "clicking does nothing" bug).
  const selectionActiveRef = useRef(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setSelected(null);
    setVersion(null);
    setError(null);
    setFrameFragment(null);
    getBoard(id)
      .then((loaded) => {
        if (!alive) {
          return;
        }
        setData(loaded);
        setSelected(loaded.board.current_version);
      })
      .catch((err) => {
        if (alive) {
          setError(err instanceof Error ? err.message : "failed to load board");
        }
      });
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (selected === null) {
      return;
    }
    let alive = true;
    getVersion(id, selected)
      .then((loaded) => {
        if (alive) {
          setVersion(loaded);
        }
      })
      .catch((err) => {
        if (alive) {
          setError(
            err instanceof Error ? err.message : "failed to load version",
          );
        }
      });
    return () => {
      alive = false;
    };
  }, [id, selected]);

  useEffect(() => {
    if (version === null || data === null || data.board.format === "html") {
      return;
    }
    // mermaid renders client-side in the host chrome (D12)
    const nodes = Array.from(
      containerRef.current?.querySelectorAll("pre.mermaid") ?? [],
    ) as HTMLElement[];
    if (nodes.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ securityLevel: "strict", startOnLoad: false });
        if (cancelled) {
          return;
        }
        await mermaid.run({ nodes });
      } catch {
        // a bad diagram degrades to its source text — never breaks the page
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version, data]);

  // html boards render from the board origin — learn its URL once (config
  // allows BOARD_ORIGIN_PORT to move it; markdown boards never need it).
  useEffect(() => {
    let alive = true;
    getOriginUrl()
      .then((url) => {
        if (alive) {
          setOriginUrl(url);
        }
      })
      .catch(() => {
        // the html branch surfaces this below; markdown boards don't care
      });
    return () => {
      alive = false;
    };
  }, []);

  // Live updates (SSE): any event for this board refreshes comments; board
  // lifecycle events also refresh the board meta. Reconnect is EventSource's.
  useEffect(() => {
    const url = streamUrl();
    if (url === "") {
      return;
    }
    const stream = new BoardStream(url, (ev) => {
      if (ev.board_id !== id) {
        return;
      }
      setRefreshKey((key) => key + 1);
      if (ev.type.startsWith("board.")) {
        getBoard(id)
          .then((loaded) => {
            setData(loaded);
          })
          .catch(() => {
            // a failed meta refresh just leaves the stale header
          });
      }
    });
    return () => {
      stream.close();
    };
  }, [id]);

  // Selection affordance: text selected inside the board content offers a
  // comment button at the selection (mouseup — the selection is done by
  // then). Dismissed when the selection collapses anywhere else.
  useEffect(() => {
    const onMouseUp = (): void => {
      if (pinnedRef.current) {
        return;
      }
      const sel = window.getSelection();
      const root = containerRef.current;
      if (
        sel === null ||
        root === null ||
        sel.isCollapsed ||
        sel.rangeCount === 0
      ) {
        return;
      }
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        return;
      }
      const anchor = anchorFromSelection(sel, root);
      if (anchor === null) {
        return;
      }
      const rect = range.getBoundingClientRect();
      selectionActiveRef.current = true;
      setAffordance({
        anchor,
        top: rect.top - 34,
        left: rect.left + rect.width / 2,
        label: "Comment on selection",
      });
    };
    const onSelectionChange = (): void => {
      const sel = window.getSelection();
      if (selectionActiveRef.current && (sel === null || sel.isCollapsed)) {
        selectionActiveRef.current = false;
        if (!pinnedRef.current) {
          setAffordance(null);
        }
      }
    };
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);

  // Hover affordance: one comment button on the [data-ba] element under the
  // pointer — sections get section anchors, table rows get row anchors.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version/data are intentional re-run triggers — the listeners rebind when the content DOM is replaced
  useEffect(() => {
    const root = containerRef.current;
    if (root === null) {
      return;
    }
    const closest = (event: Event): Element | null => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") {
        return null;
      }
      return target.closest("[data-ba]");
    };
    const onMouseOver = (event: Event): void => {
      if (selectionActiveRef.current) {
        return;
      }
      const el = closest(event);
      if (el === hoverTargetRef.current) {
        return;
      }
      hoverTargetRef.current = el;
      if (el === null || !root.contains(el)) {
        if (!pinnedRef.current) {
          setAffordance(null);
        }
        return;
      }
      const anchor = anchorForElement(el);
      const rect = el.getBoundingClientRect();
      setAffordance({
        anchor,
        top: rect.top + 2,
        left: rect.right - 6,
        label: el.tagName === "TR" ? "Comment on row" : "Comment on section",
      });
    };
    const onMouseOut = (event: MouseEvent): void => {
      // happy-dom reports an absent relatedTarget as undefined, not null —
      // normalize or every "left the content" event would hit contains(undefined)
      const to = event.relatedTarget ?? null;
      // moving onto the floating button (or while pinned) keeps the affordance
      const toButton =
        to !== null &&
        to instanceof Element &&
        to.classList.contains("floating-comment");
      if (pinnedRef.current || toButton) {
        return;
      }
      // still inside the content — the next mouseover replaces the affordance
      if (to !== null && to instanceof Node && root.contains(to)) {
        return;
      }
      hoverTargetRef.current = null;
      setAffordance(null);
    };
    root.addEventListener("mouseover", onMouseOver);
    root.addEventListener("mouseout", onMouseOut as (event: Event) => void);
    return () => {
      root.removeEventListener("mouseover", onMouseOver);
      root.removeEventListener(
        "mouseout",
        onMouseOut as (event: Event) => void,
      );
    };
  }, [version, data]);

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (data === null) {
    return <div className="status">loading…</div>;
  }
  const board = data.board;
  const frameSrc =
    board.format !== "html" || originUrl === null || selected === null
      ? null
      : `${originUrl}/b/${board.id}/${selected}${
          frameFragment === null ? "" : `#${encodeURIComponent(frameFragment)}`
        }`;
  return (
    <div className="board-view">
      <header className="board-header">
        <a className="back" href="#/">
          ← boards
        </a>
        <h1>{board.title}</h1>
        <div className="board-card-meta">
          <span className={`badge ${board.status}`}>{board.status}</span>
          <span>{board.created_by}</span>
          <span>{formatDate(board.created_at)}</span>
        </div>
      </header>
      <nav className="version-switcher">
        {data.versions.map((meta) => (
          <button
            key={meta.n}
            type="button"
            className={`pill${meta.n === selected ? " active" : ""}`}
            onClick={() => {
              setSelected(meta.n);
            }}
          >
            {meta.label ?? `v${meta.n}`}
          </button>
        ))}
      </nav>
      <div className="board-layout">
        <div className="board-main">
          {board.format === "html" ? (
            originUrl === null ? (
              <div className="notice">
                Board origin unavailable — reload to retry.
              </div>
            ) : (
              // Exact sandbox embed from docs/security.md ("Sandbox
              // architecture") — allow-scripts only, opaque origin. Never add
              // sandbox flags here (invariant 2). (referrerPolicy is React's
              // spelling of the referrerpolicy attribute — same DOM output.)
              <iframe
                sandbox="allow-scripts"
                allow=""
                referrerPolicy="no-referrer"
                src={frameSrc ?? undefined}
                title={board.title}
                className="board-frame"
              />
            )
          ) : version === null ? (
            <div className="status">loading version…</div>
          ) : (
            <div
              ref={containerRef}
              className="board-content"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: the sanctioned host-chrome display mode — content is sanitized server-side at publish and script-free by construction (docs/architecture.md, D5); html-format boards never reach this branch
              dangerouslySetInnerHTML={{
                __html: boardBodyHtml(version.content),
              }}
            />
          )}
        </div>
        <CommentSidebar
          boardId={id}
          boardStatus={board.status}
          versionN={selected}
          refreshKey={refreshKey}
          pendingAnchor={pendingAnchor}
          onPendingAnchorConsumed={() => {
            setPendingAnchor(null);
          }}
          onHighlight={(anchor) => {
            if (board.format === "html") {
              // no host access into the sandbox — aim the frame by fragment;
              // its own bootstrap script (origin-libs) scrolls + outlines
              const fragment = anchorFragment(anchor);
              if (fragment !== null) {
                setFrameFragment(fragment);
              }
              return;
            }
            highlightAnchor(anchor, containerRef.current);
          }}
          onSwitchVersion={(n) => {
            setSelected(n);
          }}
        />
      </div>
      {affordance !== null && board.status === "open" && (
        <button
          type="button"
          className="floating-comment"
          style={{ top: `${affordance.top}px`, left: `${affordance.left}px` }}
          onMouseDown={(event) => {
            // keep the selection alive through the click — the default
            // collapse would race the handler and drop the affordance
            event.preventDefault();
          }}
          onMouseEnter={() => {
            pinnedRef.current = true;
          }}
          onMouseLeave={() => {
            pinnedRef.current = false;
            hoverTargetRef.current = null;
            if (!selectionActiveRef.current) {
              setAffordance(null);
            }
          }}
          onClick={() => {
            setPendingAnchor(affordance.anchor);
            setAffordance(null);
            selectionActiveRef.current = false;
            pinnedRef.current = false;
            window.getSelection()?.removeAllRanges();
          }}
        >
          {affordance.label}
        </button>
      )}
    </div>
  );
}
