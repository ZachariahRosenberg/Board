import { jsonOk } from "../http.ts";
import type { Route } from "./route.ts";

// The live board-origin URL, assigned by the daemon once the origin server
// binds (startDaemon is synchronous, so no request can be served first —
// same placeholder pattern as webHeaders in daemon.ts). The SPA learns the
// URL at runtime because config allows BOARD_ORIGIN_PORT to move it.
export const originUrlRef: { url: string } = { url: "" };

export const originRoute: Route = {
  method: "GET",
  path: "/api/origin",
  // Unauthenticated like health: the URL is loopback-bound (invariant 1) and
  // already advertised to the browser in the host CSP's frame-src.
  auth: false,
  handler: () => jsonOk({ url: originUrlRef.url }),
};
