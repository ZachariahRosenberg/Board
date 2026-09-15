import type { Database } from "bun:sqlite";
import type { Document, Element } from "happy-dom";
import { Window } from "happy-dom";
import type { Anchor, Comment, Version } from "./domain.ts";
import { appendEventDb, mirrorEventFiles } from "./events.ts";
import { shortId } from "./ids.ts";
import {
  BoardEnded,
  BoardNotFound,
  getBoard,
  getVersion,
  StoreError,
  VersionNotFound,
} from "./store.ts";

export class InvalidAnchor extends StoreError {
  constructor(message: string) {
    super(`invalid anchor: ${message}`);
    this.name = "InvalidAnchor";
  }
}

export class CommentNotFound extends StoreError {
  constructor(commentId: string) {
    super(`comment "${commentId}" not found`);
    this.name = "CommentNotFound";
  }
}

export interface CreateCommentInput {
  anchor: Anchor;
  body: string;
  version_n: number;
  in_reply_to?: string;
  actor: string;
}

interface CommentRow {
  id: string;
  board_id: string;
  version_n: number;
  anchor: string;
  body: string;
  author: string;
  in_reply_to: string | null;
  created_at: string;
  edited_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  seq: number | null;
}

function mapCommentRow(row: CommentRow): Comment {
  return {
    id: row.id,
    board_id: row.board_id,
    version_n: row.version_n,
    seq: row.seq ?? 0,
    anchor: JSON.parse(row.anchor) as Anchor,
    body: row.body,
    author: row.author,
    in_reply_to: row.in_reply_to,
    created_at: row.created_at,
    edited_at: row.edited_at,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
  };
}

const window = new Window();

// Lookup by iterating [data-ba] elements: agent-supplied ids never touch a
// CSS selector string (injection surface — never build selectors from input).
function findDataBa(doc: Document, id: string): Element | null {
  for (const el of [...doc.body.querySelectorAll("[data-ba]")]) {
    if (el.getAttribute("data-ba") === id) {
      return el;
    }
  }
  return null;
}

// Offsets are informational; the quoted originalText is the re-anchor truth
// (plannotator's block+offset+quote model, docs/plan.md "Data model").
export function validateAnchor(anchor: Anchor, version: Version): void {
  if (anchor.type === "board") {
    return;
  }
  if (anchor.type === "image") {
    throw new InvalidAnchor("image anchors land with M6");
  }
  const doc = new window.DOMParser().parseFromString(
    version.content,
    "text/html",
  );
  if (anchor.type === "section") {
    if (findDataBa(doc, anchor.section_id) === null) {
      throw new InvalidAnchor(
        `section "${anchor.section_id}" not found in v${version.n}`,
      );
    }
    return;
  }
  if (anchor.type === "row") {
    if (findDataBa(doc, anchor.row_id) === null) {
      throw new InvalidAnchor(
        `row "${anchor.row_id}" not found in v${version.n}`,
      );
    }
    return;
  }
  const section = findDataBa(doc, anchor.section_id);
  if (section === null) {
    throw new InvalidAnchor(
      `section "${anchor.section_id}" not found in v${version.n}`,
    );
  }
  if (!section.textContent.includes(anchor.originalText)) {
    throw new InvalidAnchor(
      `quoted text not found in section "${anchor.section_id}" of v${version.n}`,
    );
  }
}

const INSERT_COMMENT =
  "INSERT INTO comments (id, board_id, version_n, anchor, body, author, in_reply_to, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function createComment(
  db: Database,
  dataDir: string,
  boardId: string,
  input: CreateCommentInput,
): Comment {
  const board = getBoard(db, boardId);
  if (board === null) {
    throw new BoardNotFound(boardId);
  }
  // comments are writes: ended boards are read-only (docs/plan.md end → writes 409)
  if (board.status !== "open") {
    throw new BoardEnded(boardId);
  }
  const version = getVersion(db, boardId, input.version_n);
  if (version === null) {
    throw new VersionNotFound(boardId, input.version_n);
  }
  validateAnchor(input.anchor, version);
  if (input.in_reply_to !== undefined) {
    const parent = getComment(db, input.in_reply_to);
    if (parent === null) {
      throw new CommentNotFound(input.in_reply_to);
    }
    if (parent.board_id !== boardId) {
      throw new InvalidAnchor("parent comment belongs to a different board");
    }
  }
  const id = shortId();
  const write = db.transaction(() => {
    const ev = appendEventDb(db, {
      actor: input.actor,
      type: "comment.created",
      boardId,
      payload: {
        comment_id: id,
        version_n: input.version_n,
        anchor: input.anchor,
      },
    });
    db.prepare(INSERT_COMMENT).run(
      id,
      boardId,
      input.version_n,
      JSON.stringify(input.anchor),
      input.body,
      input.actor,
      input.in_reply_to ?? null,
      new Date().toISOString(),
      ev.seq,
    );
    return ev;
  });
  const ev = write();
  mirrorEventFiles(dataDir, ev);
  return getComment(db, id) as Comment;
}

export function getComment(db: Database, id: string): Comment | null {
  const row = db
    .prepare("SELECT * FROM comments WHERE id = ?")
    .get(id) as CommentRow | null;
  return row === null ? null : mapCommentRow(row);
}

export function listComments(
  db: Database,
  boardId: string,
  since?: number,
): Comment[] {
  const rows =
    since === undefined
      ? (db
          .prepare("SELECT * FROM comments WHERE board_id = ? ORDER BY seq ASC")
          .all(boardId) as CommentRow[])
      : (db
          .prepare(
            "SELECT * FROM comments WHERE board_id = ? AND seq > ? ORDER BY seq ASC",
          )
          .all(boardId, since) as CommentRow[]);
  return rows.map(mapCommentRow);
}

export interface ReplyInput {
  body: string;
  actor: string;
}

// Replies inherit the parent's anchor + version_n: a thread stays one anchor.
export function replyComment(
  db: Database,
  dataDir: string,
  commentId: string,
  input: ReplyInput,
): Comment {
  const parent = getComment(db, commentId);
  if (parent === null) {
    throw new CommentNotFound(commentId);
  }
  const board = getBoard(db, parent.board_id);
  if (board === null) {
    throw new BoardNotFound(parent.board_id);
  }
  if (board.status !== "open") {
    throw new BoardEnded(parent.board_id);
  }
  const id = shortId();
  const write = db.transaction(() => {
    const ev = appendEventDb(db, {
      actor: input.actor,
      type: "comment.replied",
      boardId: parent.board_id,
      payload: { comment_id: id, parent_id: commentId },
    });
    db.prepare(INSERT_COMMENT).run(
      id,
      parent.board_id,
      parent.version_n,
      JSON.stringify(parent.anchor),
      input.body,
      input.actor,
      commentId,
      new Date().toISOString(),
      ev.seq,
    );
    return ev;
  });
  const ev = write();
  mirrorEventFiles(dataDir, ev);
  return getComment(db, id) as Comment;
}

// Idempotent: an already-resolved comment returns as-is, no second event.
export function resolveComment(
  db: Database,
  dataDir: string,
  commentId: string,
  actor: string,
): Comment {
  const comment = getComment(db, commentId);
  if (comment === null) {
    throw new CommentNotFound(commentId);
  }
  if (comment.resolved_at !== null) {
    return comment;
  }
  const board = getBoard(db, comment.board_id);
  if (board === null) {
    throw new BoardNotFound(comment.board_id);
  }
  if (board.status !== "open") {
    throw new BoardEnded(comment.board_id);
  }
  const write = db.transaction(() => {
    const ev = appendEventDb(db, {
      actor,
      type: "comment.resolved",
      boardId: comment.board_id,
      payload: { comment_id: commentId },
    });
    db.prepare(
      "UPDATE comments SET resolved_at = ?, resolved_by = ? WHERE id = ?",
    ).run(ev.ts, actor, commentId);
    return ev;
  });
  const ev = write();
  mirrorEventFiles(dataDir, ev);
  return getComment(db, commentId) as Comment;
}

export function countUnresolvedRoots(db: Database, boardId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS c FROM comments WHERE board_id = ? AND in_reply_to IS NULL AND resolved_at IS NULL",
    )
    .get(boardId) as { c: number };
  return row.c;
}

export function maxCommentSeq(db: Database, boardId: string): number {
  const row = db
    .prepare("SELECT MAX(seq) AS m FROM comments WHERE board_id = ?")
    .get(boardId) as { m: number | null };
  return row.m ?? 0;
}
