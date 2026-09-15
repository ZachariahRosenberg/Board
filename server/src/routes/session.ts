import { HttpError, jsonOk } from "../http.ts";
import { exchangeSession, InvalidExchangeToken } from "../sessions.ts";
import { asString } from "../validate.ts";
import type { RequestContext, Route } from "./route.ts";

// auth: false — this endpoint IS the auth bootstrap (docs/security.md: the
// one-time ?token= exchange). Every other middleware (Host allowlist,
// Sec-Fetch-Site rejection, JSON-only writes) still applies because the route
// runs through the same api pipeline as everything else.

// Non-object bodies read as {} so the field validator rejects them with
// "token must be a string" instead of crashing (same pattern as boards.ts).
function bodyFields(ctx: RequestContext): Record<string, unknown> {
  return typeof ctx.body === "object" && ctx.body !== null
    ? (ctx.body as Record<string, unknown>)
    : {};
}

function exchangeHandler(_req: Request, ctx: RequestContext): Response {
  const body = bodyFields(ctx);
  const exchangeToken = asString(body.token, "token");
  let sessionToken: string;
  try {
    sessionToken = exchangeSession(ctx.db, exchangeToken);
  } catch (err) {
    if (err instanceof InvalidExchangeToken) {
      // Invariant 8: describe the failure, never the credential.
      throw new HttpError(
        401,
        "unauthorized",
        "invalid, expired, or already-used exchange token",
      );
    }
    throw err;
  }
  return jsonOk({ token: sessionToken });
}

export const sessionRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/session/exchange",
    auth: false,
    handler: exchangeHandler,
  },
];
