import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { requireAuth } from "./auth.ts";
import { CommentNotFound, InvalidAnchor } from "./comments.ts";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { onEvent } from "./events.ts";
import {
  assertAllowedHost,
  HttpError,
  isUnsafeMethod,
  jsonError,
  readJsonBody,
  rejectCrossSite,
  requireJsonContentType,
} from "./http.ts";
import { handleMcpNonPost, handleMcpPost, requireMcpActor } from "./mcp.ts";
import { boardRoutes } from "./routes/boards.ts";
import { commentRoutes } from "./routes/comments.ts";
import { eventRoutes } from "./routes/events.ts";
import { healthRoute } from "./routes/health.ts";
import {
  matchPath,
  matchRoute,
  type RequestContext,
  type Route,
  routeRequiresAuth,
} from "./routes/route.ts";
import { sessionRoutes } from "./routes/session.ts";
import { streamRoute } from "./routes/stream.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import {
  BoardEnded,
  BoardNotFound,
  ContentTooLarge,
  VersionConflict,
  VersionNotFound,
} from "./store.ts";
import {
  type DispatcherOptions,
  InvalidWebhookUrl,
  SubscriptionNotFound,
  startWebhookDispatcher,
} from "./webhooks.ts";

interface Daemon {
  hostServer: Bun.Server<undefined>;
  hostUrl: string;
  db: Database;
  stop(): Promise<void>;
}

interface DaemonOptions {
  // Where resolveWebDist starts walking to find the repo root; the test seam
  // for pointing the daemon at a fixture web/dist.
  webRootHint?: string;
  // Webhook dispatcher knobs (test seam for the retry backoff).
  webhook?: DispatcherOptions;
}

const routes: Route[] = [
  healthRoute,
  ...sessionRoutes,
  ...boardRoutes,
  ...commentRoutes,
  ...eventRoutes,
  ...webhookRoutes,
  streamRoute,
];

// Host-app CSP, exact (D18). Agent board scripts run in the app's origin —
// hence script-src 'unsafe-inline' — at the owner's explicit risk acceptance
// (docs/decisions.md D18). What survives as the guard: connect-src 'self' is
// the exfiltration kill-switch (never opens), form-action 'self' keeps boards
// from form-navigating the app away, and frame-ancestors 'none' still
// protects the app from being framed by anyone.
export function hostSecurityHeaders(): Record<string, string> {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
    ].join("; "),
    "x-content-type-options": "nosniff",
  };
}

export function originUrlFor(host: string, port: number): string {
  const hostname =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${hostname}:${port}`;
}

// The daemon locates the repo root by walking up from daemon.ts (or a
// caller-supplied hint) until it sees package.json + Makefile, so it never
// needs a configured path. rootHint is the seam tests use to point at a
// fixture tree.
export function resolveRepoRoot(rootHint?: string): string {
  let dir = rootHint ?? import.meta.dir;
  for (;;) {
    if (
      existsSync(join(dir, "package.json")) &&
      existsSync(join(dir, "Makefile"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `could not locate the board repo root (package.json + Makefile) starting from ${
          rootHint ?? import.meta.dir
        }`,
      );
    }
    dir = parent;
  }
}

export function resolveWebDist(rootHint?: string): string {
  return join(resolveRepoRoot(rootHint), "web", "dist");
}

// Small explicit map (not Bun.file's sniffing) so header values are pinned by
// tests and never pick up charset quirks per environment.
const MIME_BY_EXTENSION: Record<string, string> = {
  css: "text/css; charset=utf-8",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  mjs: "text/javascript; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  woff2: "font/woff2",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  // Unknown extensions stay octet-stream: never guess an active type.
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // malformed percent-escape: keep the raw segment rather than 500ing
    return value;
  }
}

// URL pathname → relative path inside web/dist. Segments are decoded first
// (assets can carry %20 etc.), then anything that could escape the dist dir —
// dot segments, embedded separators, NUL — rejects outright.
function staticRelativePath(pathname: string): string | null {
  const segments: string[] = [];
  for (const raw of pathname.split("/")) {
    if (raw.length === 0) {
      continue;
    }
    const segment = decodeSegment(raw);
    if (
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      return null;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function staticFileResponse(
  path: string,
  headers: Record<string, string>,
): Response {
  return new Response(Bun.file(path), {
    headers: { ...headers, "content-type": contentTypeFor(path) },
  });
}

function hasExtension(rel: string): boolean {
  return rel.slice(rel.lastIndexOf("/") + 1).includes(".");
}

// SPA cache policy: vite emits content-hashed files under assets/ — those are
// immutable forever. Everything else (index.html, the SPA shell fallback,
// fonts) revalidates on every load so a rebuild can never leave a tab running
// a stale bundle (dogfooded the hard way: Enter-to-submit "missing" was an old
// cached bundle; the new one was on disk all along).
function cacheControlFor(rel: string): string {
  return rel.startsWith("assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

// Static serving for the host server: real files, the SPA shell for
// extensionless unknown paths (hash routing means routes never hit the
// server), and a pointed 404 when the SPA simply isn't built.
function serveWebPath(
  pathname: string,
  webDist: string,
  headers: Record<string, string>,
): Response {
  if (!existsSync(webDist)) {
    return jsonError(404, "web_not_built", "run: make web", headers);
  }
  const rel = staticRelativePath(pathname);
  if (rel === null) {
    return jsonError(404, "not_found", "not found", headers);
  }
  const index = join(webDist, "index.html");
  const candidate = rel.length === 0 ? index : join(webDist, rel);
  const cacheHeaders = { ...headers, "cache-control": cacheControlFor(rel) };
  if (isFile(candidate)) {
    return staticFileResponse(candidate, cacheHeaders);
  }
  if (rel.length === 0 || hasExtension(rel)) {
    return jsonError(404, "not_found", "not found", headers);
  }
  if (isFile(index)) {
    return staticFileResponse(index, cacheHeaders);
  }
  return jsonError(404, "not_found", "not found", headers);
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
  if (err instanceof CommentNotFound) {
    return jsonError(404, "comment_not_found", err.message, headers);
  }
  if (err instanceof InvalidAnchor) {
    return jsonError(400, "invalid_anchor", err.message, headers);
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
  if (err instanceof InvalidWebhookUrl) {
    return jsonError(400, "invalid_webhook_url", err.message, headers);
  }
  if (err instanceof SubscriptionNotFound) {
    return jsonError(404, "subscription_not_found", err.message, headers);
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

// The MCP endpoint: same request hardening as /api (DNS-rebinding, CSRF,
// JSON-only writes), then agent-only bearer auth, then the stateless
// JSON-mode MCP transport (D16, server/src/mcp.ts).
async function handleMcpRequest(
  req: Request,
  config: Config,
  db: Database,
  dataDir: string,
): Promise<Response> {
  try {
    assertAllowedHost(req, config);
    rejectCrossSite(req);
    if (req.method !== "POST") {
      return handleMcpNonPost();
    }
    requireJsonContentType(req);
    const actor = requireMcpActor(req, db);
    return await handleMcpPost(req, { db, dataDir, actor });
  } catch (err) {
    return errorResponse(err);
  }
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

// The host server is three things in one: /api/* through the route table,
// /libs/* (vendored pinned libs — D18: board scripts run in the app origin
// and load them root-relative), and everything else the built SPA — all with
// the same request hardening.
async function handleHostRequest(
  req: Request,
  config: Config,
  db: Database,
  dataDir: string,
  webDist: string,
  libsDir: string,
  headers: Record<string, string>,
): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (isApiPath(pathname)) {
    return handleApiRequest(req, config, db, dataDir);
  }
  if (pathname === "/mcp") {
    return handleMcpRequest(req, config, db, dataDir);
  }
  try {
    assertAllowedHost(req, config);
    rejectCrossSite(req);
    if (req.method !== "GET") {
      return jsonError(
        405,
        "method_not_allowed",
        `${req.method} is not allowed for static paths`,
        { ...headers, allow: "GET" },
      );
    }
    if (pathname.startsWith("/libs/")) {
      return serveLib(libsDir, pathname, headers);
    }
    return serveWebPath(pathname, webDist, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
}

// Version documents are immutable by design (restoring republishes as a NEW
// version — never a rewrite), and so are the vendored libs (filenames carry
// the lib version — the upgrade contract adds a file, never rewrites one).
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

// GET /libs/<file> serves the vendored, version-stamped libraries from
// <repo>/server/libs — D18: board scripts run in the app origin and load
// them root-relative, so the host serves them itself. Filenames carry the
// lib version, so an upgrade adds a file and immutable caching can never
// strand an old board.
function serveLib(
  libsDir: string,
  pathname: string,
  headers: Record<string, string>,
): Response {
  // same decode-then-reject rules as web/dist statics: one flat segment, no
  // dot segments, no embedded separators
  const rel = staticRelativePath(pathname.slice("/libs/".length));
  if (rel === null || rel.includes("/")) {
    return jsonError(404, "not_found", "not found", headers);
  }
  const candidate = join(libsDir, rel);
  if (!isFile(candidate)) {
    return jsonError(404, "not_found", "not found", headers);
  }
  return staticFileResponse(candidate, {
    ...headers,
    "cache-control": IMMUTABLE_CACHE,
  });
}

function boundPort(server: Bun.Server<undefined>): number {
  const port = server.port;
  if (port === undefined) {
    throw new Error("server has no bound port");
  }
  return port;
}

export function startDaemon(config: Config, opts: DaemonOptions = {}): Daemon {
  const db = openDb(config.dataDir);
  // Webhook dispatcher: fire-and-forget off the event bus — event appends and
  // request handling never wait on deliveries (docs/architecture.md).
  const dispatchWebhooks = startWebhookDispatcher(
    db,
    config.dataDir,
    opts.webhook,
  );
  const offDispatch = onEvent(dispatchWebhooks);
  // Vendored pinned libs for board scripts (D18: they run in the app origin
  // and load /libs/* root-relative). Missing dir just 404s at serve time.
  const libsDir = join(resolveRepoRoot(opts.webRootHint), "server", "libs");
  let hostServer: Bun.Server<undefined>;
  try {
    const webDist = resolveWebDist(opts.webRootHint);
    const webHeaders = hostSecurityHeaders();
    hostServer = Bun.serve({
      hostname: config.host,
      port: config.port,
      fetch: (req) =>
        handleHostRequest(
          req,
          config,
          db,
          config.dataDir,
          webDist,
          libsDir,
          webHeaders,
        ),
    });
  } catch (err) {
    offDispatch();
    db.close();
    throw err;
  }
  return {
    hostServer,
    hostUrl: originUrlFor(config.host, boundPort(hostServer)),
    db,
    stop: async () => {
      offDispatch();
      await hostServer.stop(true);
      db.close();
    },
  };
}
