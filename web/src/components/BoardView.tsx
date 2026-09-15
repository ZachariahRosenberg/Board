import { useEffect, useRef, useState } from "react";
import type { Version } from "../../../server/src/domain.ts";
import { type BoardWithVersions, getBoard, getVersion } from "../api.ts";
import { formatDate } from "../format.ts";

// Markdown-derived content was sanitized server-side at publish (script-free
// by construction) — injecting it here IS the sanctioned host-chrome display
// mode (docs/architecture.md). html-format content is NEVER injected (M4
// sandbox territory); the placeholder notice covers it.
function boardBodyHtml(content: string): string {
  const doc = new DOMParser().parseFromString(content, "text/html");
  return doc.body.innerHTML;
}

export function BoardView({ id }: { id: string }) {
  const [data, setData] = useState<BoardWithVersions | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [version, setVersion] = useState<Version | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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
    // mermaid renders client-side in the host chrome (server pipeline defers
    // it deliberately — layout measurement needs a real DOM)
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

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (data === null) {
    return <div className="status">loading…</div>;
  }
  const board = data.board;
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
      {board.format === "html" ? (
        <div className="notice">HTML boards render here starting with M4.</div>
      ) : version === null ? (
        <div className="status">loading version…</div>
      ) : (
        <div
          ref={containerRef}
          className="board-content"
          dangerouslySetInnerHTML={{ __html: boardBodyHtml(version.content) }}
        />
      )}
    </div>
  );
}
