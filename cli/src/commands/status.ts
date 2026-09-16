// status (P3-6, promised in the usage text since M1): a quick health read of
// one board. REST against the live daemon like the boards.ts commands (no
// local db — invariant 3), built strictly on existing routes.
import type { Config } from "../../../server/src/config.ts";
import { originUrlFor } from "../../../server/src/daemon.ts";
import { renderTable } from "../table.ts";
import {
  bearer,
  errorMessage,
  type FetchLike,
  type ParsedArgs,
  parseArgs,
} from "./rest.ts";
import type { CommandIo } from "./token.ts";

export const STATUS_USAGE = "usage: board status <board_id>";

interface StatusCommandInput {
  config: Config;
  argv: string[];
  io: CommandIo;
  // Seam: tests inject a fake so nothing touches the network (boards.ts
  // fetchImpl pattern).
  fetchImpl?: FetchLike;
}

// Narrow views of the daemon's responses — shapes verified against
// server/src/routes/{boards,comments,events,webhooks}.ts; only consumed
// fields are typed (boards.ts ListRow pattern).
interface BoardView {
  id: string;
  title: string;
  status: string;
  current_version: number;
  created_at: string;
}

interface CommentView {
  in_reply_to: string | null;
  resolved_at: string | null;
}

interface EventView {
  type: string;
  ts: string;
}

interface SubscriberView {
  kind: string;
  principal: string;
  last_seq: number;
  last_seen: string;
}

// Same count as the server's countUnresolvedRoots (server/src/comments.ts) so
// this UNRESOLVED matches `board list`'s column: root threads only.
function unresolvedRoots(comments: CommentView[]): number {
  return comments.filter(
    (comment) => comment.in_reply_to === null && comment.resolved_at === null,
  ).length;
}

async function runStatus(
  input: StatusCommandInput,
  parsed: ParsedArgs,
  boardId: string,
): Promise<number> {
  const { io, config, fetchImpl } = input;
  const doFetch = fetchImpl ?? fetch;
  const headers = bearer(parsed.token);

  const boardRes = await doFetch(
    new URL(`/api/boards/${boardId}`, originUrlFor(config.host, config.port)),
    { headers },
  );
  if (!boardRes.ok) {
    io.stderr(`board: ${await errorMessage(boardRes)}`);
    return 1;
  }
  const { board } = (await boardRes.json()) as { board: BoardView };

  // GET /api/boards/:id carries no unresolved count (only the list route
  // computes one), so it is counted from the comments read — which doubles
  // as a cursor-presence poll for agent callers (server/src/comments.ts):
  // polls count as presence by design, so a status run may list itself.
  const commentsRes = await doFetch(
    new URL(
      `/api/boards/${boardId}/comments`,
      originUrlFor(config.host, config.port),
    ),
    { headers },
  );
  if (!commentsRes.ok) {
    io.stderr(`board: ${await errorMessage(commentsRes)}`);
    return 1;
  }
  const { comments } = (await commentsRes.json()) as {
    comments: CommentView[];
  };

  // Board rows carry no ended_at — that timestamp lives on the board.ended
  // event (invariant 4: the event log is the audit trail), so read the events
  // route, and only for a board that is actually ended.
  let ended: string | null = null;
  if (board.status === "ended") {
    const eventsRes = await doFetch(
      new URL(
        `/api/boards/${boardId}/events`,
        originUrlFor(config.host, config.port),
      ),
      { headers },
    );
    if (!eventsRes.ok) {
      io.stderr(`board: ${await errorMessage(eventsRes)}`);
      return 1;
    }
    const { events } = (await eventsRes.json()) as { events: EventView[] };
    // endBoard never appends a second board.ended event (store.ts), so the
    // last match is the end timestamp.
    ended = events.filter((ev) => ev.type === "board.ended").at(-1)?.ts ?? null;
  }

  // Agent-visible: /api/boards/:id/subscribers is plain bearer auth (no scope
  // gating in server/src/auth.ts) returning the merged presence view.
  const subsRes = await doFetch(
    new URL(
      `/api/boards/${boardId}/subscribers`,
      originUrlFor(config.host, config.port),
    ),
    { headers },
  );
  if (!subsRes.ok) {
    io.stderr(`board: ${await errorMessage(subsRes)}`);
    return 1;
  }
  const subscribers = (await subsRes.json()) as SubscriberView[];

  for (const line of renderTable(
    ["FIELD", "VALUE"],
    [
      ["ID", board.id],
      ["TITLE", board.title],
      ["STATUS", board.status],
      ["VERSION", String(board.current_version)],
      ["UNRESOLVED", String(unresolvedRoots(comments))],
      ["CREATED", board.created_at],
      ["ENDED", ended ?? "-"],
    ],
  )) {
    io.stdout(line);
  }
  io.stdout("");
  if (subscribers.length === 0) {
    io.stdout("no subscribers");
    return 0;
  }
  for (const line of renderTable(
    ["KIND", "PRINCIPAL", "LAST SEQ", "LAST SEEN"],
    subscribers.map((s) => [
      s.kind,
      s.principal,
      String(s.last_seq),
      s.last_seen,
    ]),
  )) {
    io.stdout(line);
  }
  return 0;
}

export async function runStatusCommand(
  input: StatusCommandInput,
): Promise<number> {
  const parsed = parseArgs(input.argv, 1);
  if (typeof parsed === "string") {
    input.io.stderr(`board: ${parsed}`);
    input.io.stderr(STATUS_USAGE);
    return 1;
  }
  const boardId = parsed.positional[0];
  if (boardId === undefined || boardId.length === 0) {
    input.io.stderr("board: status needs a board id");
    input.io.stderr(STATUS_USAGE);
    return 1;
  }
  return runStatus(input, parsed, boardId);
}
