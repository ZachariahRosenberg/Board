import { useEffect, useState } from "react";
import type { Board } from "../../../server/src/domain.ts";
import { listBoards } from "../api.ts";
import { formatDate } from "../format.ts";

export function BoardList() {
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listBoards()
      .then((loaded) => {
        if (alive) {
          setBoards(loaded);
        }
      })
      .catch((err) => {
        if (alive) {
          setError(
            err instanceof Error ? err.message : "failed to load boards",
          );
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (boards === null) {
    return <div className="status">loading…</div>;
  }
  if (boards.length === 0) {
    return (
      <div className="empty">
        No boards yet — agents create them via the API.
      </div>
    );
  }
  return (
    <div className="board-list">
      {boards.map((board) => (
        <a
          key={board.id}
          className={`board-card${board.status === "ended" ? " ended" : ""}`}
          href={`#/boards/${board.id}`}
        >
          <div className="board-card-title">{board.title}</div>
          <div className="board-card-meta">
            <span className={`badge ${board.status}`}>{board.status}</span>
            <span>v{board.current_version}</span>
            <span>{board.created_by}</span>
            <span>{formatDate(board.created_at)}</span>
          </div>
          {board.tags.length > 0 && (
            <div className="board-card-tags">
              {board.tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </a>
      ))}
    </div>
  );
}
