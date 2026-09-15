import {
  createComment,
  listComments,
  maxCommentSeq,
  recordCursorPresence,
  replyComment,
  resolveComment,
} from "../comments.ts";
import type { Board, Comment } from "../domain.ts";
import { serializeFeedback, threadRootOf } from "../feedback.ts";
import { HttpError, jsonOk } from "../http.ts";
import { getBoard } from "../store.ts";
import {
  asAnchor,
  asInt,
  asNonNegativeIntString,
  asOptionalString,
  asString,
} from "../validate.ts";
import type { RequestContext, Route } from "./route.ts";

function actorName(ctx: RequestContext): string {
  if (ctx.actor === undefined) {
    throw new HttpError(
      500,
      "internal_error",
      "authenticated route ran without an actor",
    );
  }
  return ctx.actor.name;
}

function requireBoard(ctx: RequestContext, boardId: string): Board {
  const board = getBoard(ctx.db, boardId);
  if (board === null) {
    throw new HttpError(404, "board_not_found", `board "${boardId}" not found`);
  }
  return board;
}

function bodyFields(ctx: RequestContext): Record<string, unknown> {
  return typeof ctx.body === "object" && ctx.body !== null
    ? (ctx.body as Record<string, unknown>)
    : {};
}

function createCommentHandler(_req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  requireBoard(ctx, boardId);
  const body = bodyFields(ctx);
  const comment = createComment(ctx.db, ctx.dataDir, boardId, {
    anchor: asAnchor(body.anchor, "anchor"),
    body: asString(body.body, "body"),
    version_n: asInt(body.version_n, "version_n"),
    in_reply_to: asOptionalString(body.in_reply_to, "in_reply_to"),
    actor: actorName(ctx),
  });
  return jsonOk(comment, 201);
}

function replyHandler(_req: Request, ctx: RequestContext): Response {
  const body = bodyFields(ctx);
  const comment = replyComment(ctx.db, ctx.dataDir, ctx.params.id, {
    body: asString(body.body, "body"),
    actor: actorName(ctx),
  });
  return jsonOk(comment, 201);
}

function resolveHandler(_req: Request, ctx: RequestContext): Response {
  const comment = resolveComment(
    ctx.db,
    ctx.dataDir,
    ctx.params.id,
    actorName(ctx),
  );
  return jsonOk(comment);
}

function listCommentsHandler(req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  requireBoard(ctx, boardId);
  const since = asNonNegativeIntString(
    new URL(req.url).searchParams.get("since"),
    "since",
  );
  recordCursorPresence(ctx.db, boardId, ctx.actor);
  const comments = listComments(ctx.db, boardId, since);
  const lastSeq = maxCommentSeq(ctx.db, boardId);
  return jsonOk({
    comments,
    last_seq: comments.length > 0 ? (comments.at(-1)?.seq ?? lastSeq) : lastSeq,
  });
}

// Threads touched after `since` render IN FULL (root + all replies) — feedback
// is a catch-up artifact, not a diff.
function threadsTouchedSince(comments: Comment[], since: number): Comment[] {
  const keptRoots = new Set<string>();
  for (const comment of comments) {
    if (comment.seq > since) {
      const root = threadRootOf(comments, comment);
      if (root !== null) {
        keptRoots.add(root.id);
      }
    }
  }
  return comments.filter((comment) => {
    const root = threadRootOf(comments, comment);
    return root !== null && keptRoots.has(root.id);
  });
}

function feedbackHandler(req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  const board = requireBoard(ctx, boardId);
  const since = asNonNegativeIntString(
    new URL(req.url).searchParams.get("since"),
    "since",
  );
  const all = listComments(ctx.db, boardId);
  const comments = since === undefined ? all : threadsTouchedSince(all, since);
  return jsonOk({
    feedback: serializeFeedback(board, comments),
    last_seq: maxCommentSeq(ctx.db, boardId),
  });
}

export const commentRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/boards/:id/comments",
    handler: createCommentHandler,
  },
  { method: "POST", path: "/api/comments/:id/reply", handler: replyHandler },
  {
    method: "POST",
    path: "/api/comments/:id/resolve",
    handler: resolveHandler,
  },
  {
    method: "GET",
    path: "/api/boards/:id/comments",
    handler: listCommentsHandler,
  },
  {
    method: "GET",
    path: "/api/boards/:id/feedback",
    handler: feedbackHandler,
  },
];
