import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  Anchor,
  Comment,
  ImageAnchor,
  ImageOverlay,
  Version,
} from "../../../server/src/domain.ts";
import {
  anchorForElement,
  anchorFromSelection,
  highlightAnchor,
} from "../anchor.ts";
import {
  type BoardWithVersions,
  getBoard,
  getVersion,
  streamUrl,
} from "../api.ts";
import { mountBoardDocument } from "../board-mount.ts";
import { formatDate } from "../format.ts";
import { assetIdFromSrc } from "../image.ts";
import { BoardStream } from "../sse.ts";
import { CommentSidebar } from "./CommentSidebar.tsx";
import { ImageOverlayLayer } from "./ImageOverlaySvg.tsx";

// Markdown content was sanitized server-side at publish (script-free by
// construction) — injecting it here IS the sanctioned host-chrome display
// mode (docs/architecture.md). html-format boards mount through
// mountBoardDocument instead (D18: unsandboxed host render, scripts run).
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
  // image annotation: the sidebar streams comments up; image-anchored threads
  // badge their board image and hover-preview the overlay on it, and the
  // lightbox (below) reviews any board image full size with its overlays
  const [comments, setComments] = useState<Comment[]>([]);
  const [imageTargets, setImageTargets] = useState<Record<string, HTMLElement>>(
    {},
  );
  // the image lightbox: the asset whose review modal is open (one modal at a
  // time — a single value, replaced on each open)
  const [lightbox, setLightbox] = useState<{ assetId: string } | null>(null);
  const [activeImage, setActiveImage] = useState<{
    anchor: ImageAnchor;
    overlay: ImageOverlay;
  } | null>(null);
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

  // D18: html boards mount into the host DOM like markdown — the document is
  // parsed, head styles and body children are injected, and scripts are
  // re-created so they actually run (innerHTML would not execute them). The
  // mount is async: external scripts are awaited in document order so inline
  // code never races its dependencies; a version switch mid-mount aborts the
  // old sequence (its scripts are detached and never fire). Declared before
  // the affordance effects so the content DOM exists when they bind.
  useEffect(() => {
    const root = containerRef.current;
    if (
      version === null ||
      data === null ||
      root === null ||
      data.board.format !== "html"
    ) {
      return;
    }
    void mountBoardDocument(version.content, root);
  }, [version, data]);

  // Board images (markdown embeds and agent html alike) get wrapped so
  // badges and hover overlays can portal into a positioned box hugging the
  // image. Runs after content injection (markdown innerHTML commits during
  // render; the html mount's synchronous prefix appends body children before
  // its first await). The wrap span is ours — React only replaces the
  // container wholesale on version change, and the effect re-runs on that.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version/data are intentional re-run triggers — the listeners rebind when the content DOM is replaced
  useEffect(() => {
    const root = containerRef.current;
    if (root === null || version === null) {
      return;
    }
    const targets: Record<string, HTMLElement> = {};
    for (const img of [...root.querySelectorAll("img")]) {
      const assetId = assetIdFromSrc(img.getAttribute("src") ?? "");
      if (assetId === null) {
        continue;
      }
      let wrap = img.parentElement;
      if (wrap === null || !wrap.classList.contains("image-anchor-wrap")) {
        wrap = root.ownerDocument.createElement("span");
        wrap.className = "image-anchor-wrap";
        img.replaceWith(wrap);
        wrap.append(img);
      }
      targets[assetId] = wrap;
    }
    setImageTargets(targets);
  }, [version, data]);

  // Lightbox entry (dogfooded ask [163]: "click the image and have it open in
  // a modal, so that I can further review and annotate"): a delegated click on
  // any board image whose src is a served asset — both formats, since the wrap
  // effect above treats them alike. preventDefault so an asset img nested in a
  // markdown link cannot half-navigate while the modal opens: for asset images
  // the lightbox IS the click's action.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version/data are intentional re-run triggers — the listeners rebind when the content DOM is replaced
  useEffect(() => {
    const root = containerRef.current;
    if (root === null || version === null) {
      return;
    }
    const onClick = (event: Event): void => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") {
        return;
      }
      const img = target.closest("img");
      if (img === null) {
        return;
      }
      const assetId = assetIdFromSrc(img.getAttribute("src") ?? "");
      if (assetId !== null) {
        event.preventDefault();
        setLightbox({ assetId });
      }
    };
    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("click", onClick);
    };
  }, [version, data]);

  // Escape closes the lightbox (the keyboard close path, alongside the close
  // button). No focus trap for v1: the modal is read-only review with two
  // real buttons — a trap is overkill and this modal never stacks.
  useEffect(() => {
    if (lightbox === null) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setLightbox(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [lightbox]);

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

  // Hover affordance: one comment button under the pointer — asset images
  // get the annotate affordance (image anchors), other [data-ba] elements
  // get sections/rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version/data are intentional re-run triggers — the listeners rebind when the content DOM is replaced
  useEffect(() => {
    const root = containerRef.current;
    if (root === null) {
      return;
    }
    const closest = (
      event: Event,
    ): { anchor: Anchor; el: Element; label: string } | null => {
      const target = event.target as Element | null;
      if (target === null || typeof target.closest !== "function") {
        return null;
      }
      // an asset image wins over its surrounding section: the annotation
      // targets the image itself
      const img = target.closest("img");
      if (img !== null) {
        const assetId = assetIdFromSrc(img.getAttribute("src") ?? "");
        if (assetId !== null) {
          return {
            anchor: { type: "image", asset_id: assetId },
            el: img,
            label: "annotate image",
          };
        }
      }
      const el = target.closest("[data-ba]");
      if (el === null) {
        return null;
      }
      return {
        anchor: anchorForElement(el),
        el,
        label: el.tagName === "TR" ? "Comment on row" : "Comment on section",
      };
    };
    const onMouseOver = (event: Event): void => {
      if (selectionActiveRef.current) {
        return;
      }
      const found = closest(event);
      const el = found?.el ?? null;
      if (el === hoverTargetRef.current) {
        return;
      }
      hoverTargetRef.current = el;
      if (found === null || !root.contains(found.el)) {
        if (!pinnedRef.current) {
          setAffordance(null);
        }
        return;
      }
      const rect = found.el.getBoundingClientRect();
      setAffordance({
        anchor: found.anchor,
        top: rect.top + 2,
        left: rect.right - 6,
        label: found.label,
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
  // every image-anchored root comment's overlay for the lightboxed asset —
  // the review modal stacks them all (the board image shows one at a time on
  // hover; review shows the full picture)
  const lightboxOverlays =
    lightbox === null
      ? []
      : comments.flatMap((comment) =>
          comment.in_reply_to === null &&
          comment.anchor.type === "image" &&
          comment.anchor.asset_id === lightbox.assetId &&
          comment.anchor.overlay !== undefined
            ? [{ id: comment.id, overlay: comment.anchor.overlay }]
            : [],
        );
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
          {version === null ? (
            <div className="status">loading version…</div>
          ) : (
            <div
              ref={containerRef}
              // the format class scopes snapshot-only styling (e.g. the static
              // markdown task-list glyphs) away from html boards, whose
              // checkboxes may be genuinely interactive (D18 scripts run)
              className={`board-content ${board.format}`}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: the sanctioned host-chrome display mode — markdown content is sanitized server-side at publish and script-free by construction (invariant 6, docs/security.md "Content rules"); html boards mount through mountBoardDocument instead (D18)
              dangerouslySetInnerHTML={
                board.format === "html"
                  ? undefined
                  : { __html: boardBodyHtml(version.content) }
              }
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
            highlightAnchor(anchor, containerRef.current);
          }}
          onSwitchVersion={(n) => {
            setSelected(n);
          }}
          onCommentsChange={setComments}
          onImageHover={(anchor) => {
            if (anchor === null || anchor.overlay === undefined) {
              setActiveImage(null);
              return;
            }
            setActiveImage({ anchor, overlay: anchor.overlay });
          }}
          onOpenImage={(assetId) => {
            // a thread thumbnail click opens the same lightbox as the board
            // image itself (the modal is the one review surface)
            setLightbox({ assetId });
          }}
        />
      </div>
      {/* badges + hover overlays portal into each wrapped board image */}
      {Object.entries(imageTargets).map(([assetId, target]) => {
        const threads = comments.filter(
          (comment) =>
            comment.in_reply_to === null &&
            comment.anchor.type === "image" &&
            comment.anchor.asset_id === assetId,
        );
        const overlay =
          activeImage?.anchor.asset_id === assetId ? activeImage.overlay : null;
        return createPortal(
          <>
            {threads.length > 0 && (
              <span className="image-anchor-badge">{threads.length}</span>
            )}
            {overlay !== null && <ImageOverlayLayer overlay={overlay} />}
          </>,
          target,
        );
      })}
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
      {/* the image lightbox (dogfooded ask [163]): full-size review of one
          asset with every image-anchored overlay for it stacked (each thread
          contributes its own layer — the shared renderer, no fork). Backdrop
          click closes (only the backdrop itself, not clicks inside the image
          box); Escape and the close button are the keyboard paths; no focus
          trap for v1 (read-only modal, never stacks — see the effect above). */}
      {lightbox !== null && (
        // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a pointer-only extra — Escape and the close button close for keyboard users
        // biome-ignore lint/a11y/useKeyWithClickEvents: see above
        <div
          className="lightbox-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setLightbox(null);
            }
          }}
        >
          <div className="lightbox" role="dialog" aria-label="image preview">
            <div className="lightbox-toolbar">
              <span className="lightbox-title">{lightbox.assetId}</span>
              {board.status === "open" && (
                <button
                  type="button"
                  className="pill"
                  onClick={() => {
                    // the floating "annotate image" button's exact flow: stage
                    // the image anchor as a pending composer anchor and let
                    // the sidebar own the editor — one editor implementation,
                    // no fork (the composer holds the preview and its annotate
                    // affordance)
                    setPendingAnchor({
                      type: "image",
                      asset_id: lightbox.assetId,
                    });
                    setLightbox(null);
                    selectionActiveRef.current = false;
                    pinnedRef.current = false;
                  }}
                >
                  annotate
                </button>
              )}
              <button
                type="button"
                className="pill active"
                onClick={() => {
                  setLightbox(null);
                }}
              >
                close
              </button>
            </div>
            {/* hugs the img like the editor's stage, so the overlay layers
                measure exactly the displayed image box */}
            <div className="lightbox-stage">
              <img
                src={`/assets/${lightbox.assetId}`}
                alt=""
                draggable={false}
              />
              {lightboxOverlays.map(({ id, overlay }) => (
                <ImageOverlayLayer key={id} overlay={overlay} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
