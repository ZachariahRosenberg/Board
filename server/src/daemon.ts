import type { Config } from "./config.ts";
import {
  assertAllowedHost,
  HttpError,
  isUnsafeMethod,
  jsonError,
  readJsonBody,
  rejectCrossSite,
  requireJsonContentType,
} from "./http.ts";
import { healthRoute } from "./routes/health.ts";
import type { RequestContext, Route } from "./routes/route.ts";

export interface Daemon {
  hostServer: Bun.Server<undefined>;
  originServer: Bun.Server<undefined>;
  hostUrl: string;
  originUrl: string;
  stop(): Promise<void>;
}

const routes: Route[] = [healthRoute];

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

function errorResponse(
  err: unknown,
  headers: Record<string, string> = {},
): Response {
  if (err instanceof HttpError) {
    return jsonError(err.status, err.code, err.message, headers);
  }
  console.error("boardd: unhandled error", err);
  return jsonError(500, "internal_error", "internal error", headers);
}

async function handleApiRequest(
  req: Request,
  config: Config,
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
    const forPath = routes.filter((route) => route.path === pathname);
    if (forPath.length === 0) {
      throw new HttpError(404, "not_found", `no route for ${pathname}`);
    }
    const route = forPath.find((candidate) => candidate.method === req.method);
    if (route === undefined) {
      const allow = forPath.map((candidate) => candidate.method).join(", ");
      return jsonError(
        405,
        "method_not_allowed",
        `${req.method} is not allowed for ${pathname}`,
        { allow },
      );
    }
    const ctx: RequestContext = { body };
    return await route.handler(req, ctx);
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
  const hostServer = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (req) => handleApiRequest(req, config),
  });
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
    throw err;
  }
  return {
    hostServer,
    originServer,
    hostUrl: originUrlFor(config.host, boundPort(hostServer)),
    originUrl: originUrlFor(config.host, boundPort(originServer)),
    stop: async () => {
      await hostServer.stop(true);
      await originServer.stop(true);
    },
  };
}
