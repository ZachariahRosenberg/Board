import type { Database } from "bun:sqlite";
import { requireAuth } from "./auth.ts";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import {
  assertAllowedHost,
  HttpError,
  isUnsafeMethod,
  jsonError,
  readJsonBody,
  rejectCrossSite,
  requireJsonContentType,
} from "./http.ts";
import { boardRoutes } from "./routes/boards.ts";
import { eventRoutes } from "./routes/events.ts";
import { healthRoute } from "./routes/health.ts";
import {
  matchPath,
  matchRoute,
  type RequestContext,
  type Route,
  routeRequiresAuth,
} from "./routes/route.ts";
import {
  BoardEnded,
  BoardNotFound,
  ContentTooLarge,
  VersionConflict,
  VersionNotFound,
} from "./store.ts";

export interface Daemon {
  hostServer: Bun.Server<undefined>;
  originServer: Bun.Server<undefined>;
  hostUrl: string;
  originUrl: string;
  db: Database;
  stop(): Promise<void>;
}

const routes: Route[] = [healthRoute, ...boardRoutes, ...eventRoutes];

// Board-origin CSP allowlist from docs/security.md — never widen it (invariant 3); connect-src 'none' is the exfiltration kill switch. frame-ancestors is derived from the actual host origin at boot.
const BOARD_CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
];

const PERMISSIONS_POLICY =
  "geolocation=(), camera=(), microphone=(), clipboard-read=(), clipboard-write=(), fullscreen=(), payment=(), usb=(), bluetooth=()";

export function boardSecurityHeaders(
  hostOrigin: string,
): Record<string, string> {
  return {
    "content-security-policy": [
      ...BOARD_CSP_DIRECTIVES,
      `frame-ancestors ${hostOrigin}`,
    ].join("; "),
    "permissions-policy": PERMISSIONS_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

function originUrlFor(host: string, port: number): string {
  const hostname =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

// StoreError → HTTP translation lives here and nowhere else (style guide):
// handlers throw domain errors, this is the single mapping point.
function errorResponse(
  err: unknown,
  headers: Record<string, string> = {},
): Response {
  if (err instanceof HttpError) {
    return jsonError(err.status, err.code, err.message, headers);
  }
  if (err instanceof VersionConflict) {
    // open-artifacts 409 pattern: agents read current_version and retry
    return jsonError(409, "version_conflict", err.message, headers, {
      current_version: err.current,
    });
  }
  if (err instanceof BoardNotFound) {
    return jsonError(404, "board_not_found", err.message, headers);
  }
  if (err instanceof VersionNotFound) {
    return jsonError(404, "version_not_found", err.message, headers);
  }
  if (err instanceof BoardEnded) {
    return jsonError(409, "board_ended", err.message, headers);
  }
  if (err instanceof ContentTooLarge) {
    return jsonError(413, "payload_too_large", err.message, headers);
  }
  console.error("boardd: unhandled error", err);
  return jsonError(500, "internal_error", "internal error", headers);
}

async function handleApiRequest(
  req: Request,
  config: Config,
  db: Database,
  dataDir: string,
): Promise<Response> {
  try {
    assertAllowedHost(req, config);
    rejectCrossSite(req);
    let body: unknown;
    if (isUnsafeMethod(req.method)) {
      requireJsonContentType(req);
      body = await readJsonBody(req);
    }
    const { pathname } = new URL(req.url);
    for (const route of routes) {
      const params = matchRoute(route, req.method, pathname);
      if (params === null) {
        continue;
      }
      const ctx: RequestContext = { body, params, db, dataDir };
      if (routeRequiresAuth(route)) {
        ctx.actor = requireAuth(req, db);
      }
      return await route.handler(req, ctx);
    }
    // 405 is computed over routes whose pattern matches the concrete pathname
    const allowed = [
      ...new Set(
        routes
          .filter((route) => matchPath(route, pathname) !== null)
          .map((route) => route.method),
      ),
    ];
    if (allowed.length > 0) {
      return jsonError(
        405,
        "method_not_allowed",
        `${req.method} is not allowed for ${pathname}`,
        { allow: allowed.join(", ") },
      );
    }
    throw new HttpError(404, "not_found", `no route for ${pathname}`);
  } catch (err) {
    return errorResponse(err);
  }
}

// Board content routes land in M4; until then everything 404s, but every response still carries the full security header set.
async function handleBoardOriginRequest(
  req: Request,
  config: Config,
  securityHeaders: Record<string, string>,
): Promise<Response> {
  try {
    assertAllowedHost(req, config);
    rejectCrossSite(req);
    return jsonError(404, "not_found", "not found", securityHeaders);
  } catch (err) {
    return errorResponse(err, securityHeaders);
  }
}

function boundPort(server: Bun.Server<undefined>): number {
  const port = server.port;
  if (port === undefined) {
    throw new Error("server has no bound port");
  }
  return port;
}

export function startDaemon(config: Config): Daemon {
  const db = openDb(config.dataDir);
  let hostServer: Bun.Server<undefined>;
  try {
    hostServer = Bun.serve({
      hostname: config.host,
      port: config.port,
      fetch: (req) => handleApiRequest(req, config, db, config.dataDir),
    });
  } catch (err) {
    db.close();
    throw err;
  }
  let originServer: Bun.Server<undefined>;
  try {
    const securityHeaders = boardSecurityHeaders(
      originUrlFor(config.host, boundPort(hostServer)),
    );
    originServer = Bun.serve({
      hostname: config.host,
      port: config.originPort,
      fetch: (req) => handleBoardOriginRequest(req, config, securityHeaders),
    });
  } catch (err) {
    hostServer.stop(true);
    db.close();
    throw err;
  }
  return {
    hostServer,
    originServer,
    hostUrl: originUrlFor(config.host, boundPort(hostServer)),
    originUrl: originUrlFor(config.host, boundPort(originServer)),
    db,
    stop: async () => {
      await hostServer.stop(true);
      await originServer.stop(true);
      db.close();
    },
  };
}
