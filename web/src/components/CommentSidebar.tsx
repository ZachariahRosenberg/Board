import { useEffect, useState } from "react";
import type {
  Anchor,
  BoardStatus,
  Comment,
} from "../../../server/src/domain.ts";
import { anchorDescriptor, BOARD_ANCHOR } from "../anchor.ts";
import {
  createComment,
  getComments,
  replyComment,
  resolveComment,
} from "../api.ts";
import { formatDate } from "../format.ts";

interface ComposerState {
  anchor: Anchor;
  replyTo: Comment | null;
}

interface CommentSidebarProps {
  boardId: string;
  boardStatus: BoardStatus;
  versionN: number | null;
  refreshKey: number;
  pendingAnchor: Anchor | null;
  onPendingAnchorConsumed(): void;
  onHighlight(anchor: Anchor): void;
}

function authorLabel(author: string): string {
  return author === "human" ? "you" : author;
}

export function CommentSidebar(props: CommentSidebarProps) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [hideResolved, setHideResolved] = useState(false);

  const boardOpen = props.boardStatus === "open";

  const refresh = async (): Promise<void> => {
    try {
      const page = await getComments(props.boardId);
      setComments(page.comments);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load comments");
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: boardId/refreshKey are the intentional triggers; refresh is a render-scoped closure whose identity would refetch every render
  useEffect(() => {
    void refresh();
  }, [props.boardId, props.refreshKey]);

  // Anchors opened from the document (selection / section / row buttons)
  // biome-ignore lint/correctness/useExhaustiveDependencies: consume-once on pendingAnchor changes; the callback is a stable parent setter
  useEffect(() => {
    if (props.pendingAnchor !== null) {
      setComposer({ anchor: props.pendingAnchor, replyTo: null });
      setBody("");
      props.onPendingAnchorConsumed();
    }
  }, [props.pendingAnchor]);

  const submit = async (): Promise<void> => {
    if (
      composer === null ||
      body.trim().length === 0 ||
      busy ||
      props.versionN === null
    ) {
      return;
    }
    setBusy(true);
    try {
      if (composer.replyTo === null) {
        await createComment(props.boardId, {
          anchor: composer.anchor,
          body: body.trim(),
          version_n: props.versionN,
        });
      } else {
        await replyComment(composer.replyTo.id, body.trim());
      }
      setComposer(null);
      setBody("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "comment failed");
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (commentId: string): Promise<void> => {
    try {
      await resolveComment(commentId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "resolve failed");
    }
  };

  const threads =
    comments === null
      ? []
      : comments
          .filter((comment) => comment.in_reply_to === null)
          .sort((a, b) => a.seq - b.seq);
  // resolved threads fold away on request (dogfooded ask); counts stay honest
  const visibleThreads = hideResolved
    ? threads.filter((thread) => thread.resolved_at === null)
    : threads;
  const anyResolved = threads.some((thread) => thread.resolved_at !== null);
  const unresolved = threads.filter(
    (thread) => thread.resolved_at === null,
  ).length;
  const rootOf = (comment: Comment): Comment | null => {
    let current: Comment | undefined = comment;
    const seen = new Set<string>();
    while (current !== undefined && current.in_reply_to !== null) {
      if (seen.has(current.id)) {
        return null;
      }
      seen.add(current.id);
      current = comments?.find(
        (candidate) => candidate.id === current?.in_reply_to,
      );
    }
    return current ?? null;
  };
  const repliesOf = (root: Comment): Comment[] =>
    (comments ?? [])
      .filter(
        (comment) =>
          comment.in_reply_to !== null && rootOf(comment)?.id === root.id,
      )
      .sort((a, b) => a.seq - b.seq);

  return (
    <aside className="comment-sidebar">
      <header className="sidebar-header">
        <span className="sidebar-title">Comments</span>
        <span className="sidebar-count">
          {unresolved} unresolved / {threads.length} threads
        </span>
        {boardOpen && (
          <button
            type="button"
            className="pill"
            onClick={() => {
              setComposer({ anchor: BOARD_ANCHOR, replyTo: null });
              setBody("");
            }}
          >
            + board
          </button>
        )}
        {anyResolved && (
          <button
            type="button"
            className="pill"
            onClick={() => {
              setHideResolved((value) => !value);
            }}
          >
            {hideResolved ? "show resolved" : "hide resolved"}
          </button>
        )}
      </header>
      {error !== null && <div className="error">{error}</div>}
      {!boardOpen && (
        <div className="notice small">Board ended — read-only.</div>
      )}
      {comments === null ? (
        <div className="status small">loading…</div>
      ) : threads.length === 0 ? (
        <div className="empty small">
          No comments yet. Select text or hover a section to comment.
        </div>
      ) : visibleThreads.length === 0 ? (
        <div className="empty small">
          All resolved threads hidden — toggle "show resolved" to see them.
        </div>
      ) : (
        <div className="thread-list">
          {visibleThreads.map((thread) => (
            <ThreadView
              key={thread.id}
              root={thread}
              replies={repliesOf(thread)}
              boardOpen={boardOpen}
              onHighlight={props.onHighlight}
              onResolve={(commentId) => {
                void resolve(commentId);
              }}
              onReply={(comment) => {
                setComposer({ anchor: comment.anchor, replyTo: comment });
                setBody("");
              }}
            />
          ))}
        </div>
      )}
      {composer !== null && boardOpen && (
        <div className="composer">
          {composer.replyTo === null ? (
            <div className="anchor-chip">
              on {anchorDescriptor(composer.anchor)}
            </div>
          ) : (
            <div className="anchor-chip">
              reply to {authorLabel(composer.replyTo.author)}
            </div>
          )}
          {composer.anchor.type === "text" && (
            <blockquote className="quote">
              “{composer.anchor.originalText}”
            </blockquote>
          )}
          <textarea
            value={body}
            rows={3}
            placeholder={composer.replyTo === null ? "comment…" : "reply…"}
            onChange={(event) => {
              setBody(event.target.value);
            }}
            onKeyDown={(event) => {
              // Enter submits, Shift+Enter inserts a newline (GitHub-style
              // convention); flipping to literal Shift+Enter-submits is one line
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-actions">
            <button
              type="button"
              disabled={busy || body.trim().length === 0}
              onClick={() => {
                void submit();
              }}
            >
              {busy ? "sending…" : "Comment"}
            </button>
            <button
              type="button"
              className="linklike"
              onClick={() => {
                setComposer(null);
                setBody("");
              }}
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

interface ThreadViewProps {
  root: Comment;
  replies: Comment[];
  boardOpen: boolean;
  onHighlight(anchor: Anchor): void;
  onResolve(commentId: string): void;
  onReply(comment: Comment): void;
}

function ThreadView(props: ThreadViewProps) {
  const { root } = props;
  return (
    <div className={`thread${root.resolved_at !== null ? " resolved" : ""}`}>
      <button
        type="button"
        className="anchor-chip clickable"
        onClick={() => {
          props.onHighlight(root.anchor);
        }}
      >
        {anchorDescriptor(root.anchor)}
      </button>
      <div className="thread-body">{root.body}</div>
      <div className="thread-meta">
        <span
          className={`author-badge${root.author === "human" ? " human" : ""}`}
        >
          {authorLabel(root.author)}
        </span>
        <span>{formatDate(root.created_at)}</span>
        {root.resolved_at !== null ? (
          <span className="resolved-mark">
            ✓ resolved by {authorLabel(root.resolved_by ?? "")}
          </span>
        ) : (
          props.boardOpen && (
            <>
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  props.onResolve(root.id);
                }}
              >
                resolve
              </button>
              <button
                type="button"
                className="linklike"
                onClick={() => {
                  props.onReply(root);
                }}
              >
                reply
              </button>
            </>
          )
        )}
      </div>
      {props.replies.map((reply) => (
        <div className="thread-reply" key={reply.id}>
          <span
            className={`author-badge${reply.author === "human" ? " human" : ""}`}
          >
            {authorLabel(reply.author)}
          </span>
          <span className="reply-body">{reply.body}</span>
          <span className="reply-date">{formatDate(reply.created_at)}</span>
        </div>
      ))}
    </div>
  );
}
