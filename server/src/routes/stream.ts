import { resolveRequestToken } from "../auth.ts";
import type { Actor, BoardEvent } from "../domain.ts";
import { getEvents, onEvent } from "../events.ts";
import { HttpError } from "../http.ts";
import { verifySessionToken } from "../sessions.ts";
import { verifyToken } from "../tokens.ts";
import { asNonNegativeIntString } from "../validate.ts";
import type { RequestContext, Route } from "./route.ts";

// Env override exists for tests; production default is the 25s heartbeat
// (docs/plan.md "GET /stream"). Read per-connection so tests can flip it.
function heartbeatMs(): number {
  const raw = Number(process.env.BOARD_SSE_HEARTBEAT_MS ?? 25000);
  return Number.isFinite(raw) ? raw : 25000;
}

function frame(ev: BoardEvent): string {
  return `id: ${ev.seq}\nevent: board\ndata: ${JSON.stringify(ev)}\n\n`;
}

// EventSource cannot set Authorization headers — the ?token= query param is
// the sanctioned fallback (docs/security.md session model); header preferred.
function resolveStreamActor(req: Request, db: RequestContext["db"]): Actor {
  const token = resolveRequestToken(req);
  if (token === null || token.length === 0) {
    throw new HttpError(401, "unauthorized", "missing bearer token");
  }
  const info = verifyToken(db, token);
  if (info !== null) {
    return { kind: "agent", name: info.name };
  }
  if (verifySessionToken(db, token)) {
    return { kind: "human", name: "human" };
  }
  throw new HttpError(401, "unauthorized", "invalid or revoked token");
}

async function streamHandler(
  req: Request,
  ctx: RequestContext,
): Promise<Response> {
  resolveStreamActor(req, ctx.db);
  const url = new URL(req.url);
  const sinceParam = asNonNegativeIntString(
    url.searchParams.get("since"),
    "since",
  );
  const lastEventId = req.headers.get("last-event-id");
  const sinceHeader =
    lastEventId === null
      ? undefined
      : asNonNegativeIntString(lastEventId, "last-event-id");
  const since = sinceParam ?? sinceHeader;

  const encoder = new TextEncoder();
  let closed = false;
  let live = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const sent = new Set<number>();
  // Race-close: subscribe BEFORE replaying; anything appended mid-replay
  // buffers here and drains dedup'd by seq after the replayed prefix.
  const buffer: BoardEvent[] = [];

  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const off = onEvent((ev) => {
    if (closed || sent.has(ev.seq)) {
      return;
    }
    if (!live) {
      buffer.push(ev);
      return;
    }
    sent.add(ev.seq);
    try {
      controllerRef?.enqueue(encoder.encode(frame(ev)));
    } catch {
      cleanup();
    }
  });

  function cleanup(): void {
    if (closed) {
      return;
    }
    closed = true;
    off();
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      if (since !== undefined) {
        for (const ev of getEvents(ctx.db, { since })) {
          sent.add(ev.seq);
          controller.enqueue(encoder.encode(frame(ev)));
        }
      }
      live = true;
      for (const ev of buffer.splice(0)) {
        if (sent.has(ev.seq)) {
          continue;
        }
        sent.add(ev.seq);
        controller.enqueue(encoder.encode(frame(ev)));
      }
      heartbeat = setInterval(() => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, heartbeatMs());
    },
    cancel() {
      cleanup();
    },
  });

  req.signal?.addEventListener("abort", cleanup);

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

export const streamRoute: Route = {
  method: "GET",
  path: "/api/stream",
  auth: false,
  handler: streamHandler,
};
