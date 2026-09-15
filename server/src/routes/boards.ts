import { countUnresolvedRoots } from "../comments.ts";
import type { Board, BoardStatus } from "../domain.ts";
import { HttpError, jsonOk } from "../http.ts";
import {
  BoardNotFound,
  createBoard,
  endBoard,
  getBoard,
  getVersion,
  listBoards,
  listVersions,
  publishVersion,
  restoreVersion,
  VersionNotFound,
} from "../store.ts";
import {
  asEnum,
  asInt,
  asNonNegativeIntString,
  asOptionalString,
  asString,
  asStringArray,
} from "../validate.ts";
import type { RequestContext, Route } from "./route.ts";

const BOARD_FORMATS = ["markdown", "html"] as const;
const BOARD_STATUSES = ["open", "ended"] as const;

// Authed routes always get an actor from the daemon; this guard only fires on
// a route-table misconfiguration.
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

// Non-object bodies read as {} so field validators reject them with the
// missing field name (e.g. "title must be a string") instead of crashing.
function bodyFields(ctx: RequestContext): Record<string, unknown> {
  return typeof ctx.body === "object" && ctx.body !== null
    ? (ctx.body as Record<string, unknown>)
    : {};
}

interface BoardFilters {
  status?: BoardStatus;
  tag?: string;
  author?: string;
}

export function filterBoards<T extends Board>(
  boards: T[],
  filters: BoardFilters,
): T[] {
  return boards.filter(
    (board) =>
      (filters.status === undefined || board.status === filters.status) &&
      (filters.tag === undefined || board.tags.includes(filters.tag)) &&
      (filters.author === undefined || board.created_by === filters.author),
  );
}

function createBoardHandler(_req: Request, ctx: RequestContext): Response {
  const body = bodyFields(ctx);
  const board = createBoard(ctx.db, ctx.dataDir, {
    title: asString(body.title, "title"),
    format: asEnum(body.format, "format", BOARD_FORMATS),
    tags:
      body.tags === undefined ? undefined : asStringArray(body.tags, "tags"),
    actor: actorName(ctx),
  });
  return jsonOk(board, 201);
}

function listBoardsHandler(req: Request, ctx: RequestContext): Response {
  const query = new URL(req.url).searchParams;
  const status = query.get("status");
  const tag = query.get("tag");
  const author = query.get("author");
  const filters: BoardFilters = {
    status:
      status === null ? undefined : asEnum(status, "status", BOARD_STATUSES),
    tag: tag === null ? undefined : asString(tag, "tag"),
    author: author === null ? undefined : asString(author, "author"),
  };
  // unresolved root-thread counts ride along on the list (docs/plan.md REST API)
  const boards = listBoards(ctx.db).map((board) => ({
    ...board,
    unresolved_comments: countUnresolvedRoots(ctx.db, board.id),
  }));
  return jsonOk(filterBoards(boards, filters));
}

function getBoardHandler(_req: Request, ctx: RequestContext): Response {
  const board = getBoard(ctx.db, ctx.params.id);
  if (board === null) {
    throw new BoardNotFound(ctx.params.id);
  }
  return jsonOk({ board, versions: listVersions(ctx.db, ctx.params.id) });
}

function getVersionHandler(_req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  if (getBoard(ctx.db, boardId) === null) {
    throw new BoardNotFound(boardId);
  }
  const n = asNonNegativeIntString(ctx.params.n, "n");
  if (n === undefined) {
    throw new HttpError(
      400,
      "invalid_request",
      "n must be a non-negative integer",
    );
  }
  const version = getVersion(ctx.db, boardId, n);
  if (version === null) {
    throw new VersionNotFound(boardId, n);
  }
  return jsonOk(version);
}

async function publishHandler(
  _req: Request,
  ctx: RequestContext,
): Promise<Response> {
  const body = bodyFields(ctx);
  const version = await publishVersion(ctx.db, ctx.dataDir, ctx.params.id, {
    format: asEnum(body.format, "format", BOARD_FORMATS),
    content: asString(body.content, "content"),
    expected_version: asInt(body.expected_version, "expected_version"),
    label: asOptionalString(body.label, "label"),
    note: asOptionalString(body.note, "note"),
    actor: actorName(ctx),
  });
  return jsonOk(version, 201);
}

function endHandler(_req: Request, ctx: RequestContext): Response {
  const board = endBoard(ctx.db, ctx.dataDir, ctx.params.id, actorName(ctx));
  return jsonOk(board);
}

async function restoreHandler(
  _req: Request,
  ctx: RequestContext,
): Promise<Response> {
  const body = bodyFields(ctx);
  const version = await restoreVersion(ctx.db, ctx.dataDir, ctx.params.id, {
    from_n: asInt(body.from_n, "from_n"),
    expected_version: asInt(body.expected_version, "expected_version"),
    actor: actorName(ctx),
  });
  return jsonOk(version, 201);
}

export const boardRoutes: Route[] = [
  { method: "GET", path: "/api/boards", handler: listBoardsHandler },
  { method: "POST", path: "/api/boards", handler: createBoardHandler },
  { method: "GET", path: "/api/boards/:id", handler: getBoardHandler },
  {
    method: "GET",
    path: "/api/boards/:id/versions/:n",
    handler: getVersionHandler,
  },
  {
    method: "POST",
    path: "/api/boards/:id/publish",
    handler: publishHandler,
  },
  { method: "POST", path: "/api/boards/:id/end", handler: endHandler },
  {
    method: "POST",
    path: "/api/boards/:id/restore",
    handler: restoreHandler,
  },
];
