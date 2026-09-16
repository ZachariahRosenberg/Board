import { jsonOk } from "../http.ts";
import { BoardNotFound, getBoard } from "../store.ts";
import { asOptionalString, asString } from "../validate.ts";
import {
  listSubscribers,
  subscribeWebhook,
  unsubscribeWebhook,
} from "../webhooks.ts";
import {
  actorName,
  bodyFields,
  type RequestContext,
  type Route,
} from "./route.ts";

// webhook_url is REQUIRED here: webhook-less listening is already auto-detected
// from real behavior (SSE connections, cursor polls — docs/plan.md), so a
// registration without a URL has nothing to do.
function subscribeHandler(_req: Request, ctx: RequestContext): Response {
  const body = bodyFields(ctx.body);
  const subscription = subscribeWebhook(ctx.db, ctx.dataDir, ctx.params.id, {
    webhook_url: asString(body.webhook_url, "webhook_url"),
    webhook_secret: asOptionalString(body.webhook_secret, "webhook_secret"),
    actor: actorName(ctx),
  });
  return jsonOk(subscription, 201);
}

function unsubscribeHandler(_req: Request, ctx: RequestContext): Response {
  unsubscribeWebhook(ctx.db, ctx.params.id, actorName(ctx));
  return jsonOk({ ok: true });
}

function subscribersHandler(_req: Request, ctx: RequestContext): Response {
  const boardId = ctx.params.id;
  if (getBoard(ctx.db, boardId) === null) {
    throw new BoardNotFound(boardId);
  }
  return jsonOk(listSubscribers(ctx.db, boardId));
}

export const webhookRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/boards/:id/subscribe",
    handler: subscribeHandler,
  },
  {
    method: "DELETE",
    path: "/api/boards/:id/subscribe",
    handler: unsubscribeHandler,
  },
  {
    method: "GET",
    path: "/api/boards/:id/subscribers",
    handler: subscribersHandler,
  },
];
