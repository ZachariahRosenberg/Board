import type { BoardEvent } from "../domain.ts";
import { getBoardEvents, getEvents } from "../events.ts";
import { jsonOk } from "../http.ts";
import { BoardNotFound, getBoard } from "../store.ts";
import { asNonNegativeIntString } from "../validate.ts";
import type { RequestContext, Route } from "./route.ts";

// Agents persist last_seq as their next cursor: the last returned seq, else
// the caller's since (0 when the channel is empty and no cursor was given).
function lastSeq(events: BoardEvent[], since: number | undefined): number {
  return events.length > 0 ? events[events.length - 1].seq : (since ?? 0);
}

function listEventsHandler(req: Request, ctx: RequestContext): Response {
  const since = asNonNegativeIntString(
    new URL(req.url).searchParams.get("since"),
    "since",
  );
  const events = getEvents(ctx.db, since === undefined ? {} : { since });
  return jsonOk({ events, last_seq: lastSeq(events, since) });
}

function boardEventsHandler(req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  if (getBoard(ctx.db, boardId) === null) {
    throw new BoardNotFound(boardId);
  }
  const since = asNonNegativeIntString(
    new URL(req.url).searchParams.get("since"),
    "since",
  );
  const events = getBoardEvents(ctx.db, boardId, since);
  return jsonOk({ events, last_seq: lastSeq(events, since) });
}

export const eventRoutes: Route[] = [
  { method: "GET", path: "/api/events", handler: listEventsHandler },
  {
    method: "GET",
    path: "/api/boards/:id/events",
    handler: boardEventsHandler,
  },
];
