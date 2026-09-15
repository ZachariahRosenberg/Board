import { jsonOk } from "../http.ts";
import type { Route } from "./route.ts";

export const healthRoute: Route = {
  method: "GET",
  path: "/api/health",
  // the single public route — every other endpoint is bearer-authed
  auth: false,
  handler: () => jsonOk({ ok: true }),
};
