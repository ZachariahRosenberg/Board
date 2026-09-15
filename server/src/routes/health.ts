import { jsonOk } from "../http.ts";
import type { Route } from "./route.ts";

export const healthRoute: Route = {
  method: "GET",
  path: "/api/health",
  handler: () => jsonOk({ ok: true }),
};
