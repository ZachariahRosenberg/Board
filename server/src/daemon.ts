import type { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { requireAuth } from "./auth.ts";
import { CommentNotFound, InvalidAnchor } from "./comments.ts";
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
import { handleMcpNonPost, handleMcpPost, requireMcpActor } from "./mcp.ts";
import { boardRoutes } from "./routes/boards.ts";
import { commentRoutes } from "./routes/comments.ts";
import { eventRoutes } from "./routes/events.ts";
import { healthRoute } from "./routes/health.ts";
import { originRoute, originUrlRef } from "./routes/origin.ts";
import {
  matchPath,
  matchRoute,
  type RequestContext,
  type Route,
  routeRequiresAuth,
} from "./routes/route.ts";
import { sessionRoutes } from "./routes/session.ts";
import { streamRoute } from "./routes/stream.ts";
import {
  BoardEnded,
  BoardNotFound,
  ContentTooLarge,
  getBoard,
  getVersion,
  VersionConflict,
  VersionNotFound,
} from "./store.ts";
import { asNonNegativeIntString } from "./validate.ts";

export interface Daemon {
  hostServer: Bun.Server<undefined>;
  originServer: Bun.Server<undefined>;
  hostUrl: string;
  originUrl: string;
  db: Database;
  stop(): Promise<void>;
}

export interface DaemonOptions {
  // Where resolveWebDist starts walking to find the repo root; the test seam
  // for pointing the daemon at a fixture web/dist.
  webRootHint?: string;
}

const routes: Route[] = [
  healthRoute,
  originRoute,
  ...sessionRoutes,
  ...boardRoutes,
  ...commentRoutes,
  ...eventRoutes,
  streamRoute,
];

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

// Host-app CSP from docs/security.md, exact. The board-origin URL is derived
// from the actual bound origin port at boot (mirroring how the board CSP
// derives frame-ancestors), so the two origins always agree in dev and tests.
export function hostSecurityHeaders(originUrl: string): Record<string, string> {
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: ${originUrl}`,
      "connect-src 'self'",
      `frame-src ${originUrl}`,
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
// JSON-mode MCP transport (server/src/mcp.ts).
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

// The host server is two servers in one: /api/* through the route table,
// everything else the built SPA — with the same request hardening.
async function handleHostRequest(
  req: Request,
  config: Config,
  db: Database,
  dataDir: string,
  webDist: string,
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
        headers,
        { allow: "GET" },
      );
    }
    return serveWebPath(pathname, webDist, headers);
  } catch (err) {
    return errorResponse(err, headers);
  }
}

// Versions are immutable by design (restoring republishes as a NEW version —
// never a rewrite), so version documents cache forever.
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

// Board ids are [A-Za-z0-9]{10} (server/src/ids.ts) — anything else cannot
// exist and short-circuits to not-found without a db round-trip.
const BOARD_ID_PATTERN = /^[A-Za-z0-9]{10}$/;

// GET /b/:id/:n serves the stored version document verbatim, no auth: the
// origin serves public-to-the-browser documents — loopback binding plus the
// opaque-origin iframe sandbox is the boundary (docs/security.md). Content
// comes from the db, the source of truth: the bundle file at
// <dataDir>/boards/<id>/versions/<n>.html is the portable copy, and store.ts
// already treats a stray file as harmless while a missing db row is not.
function serveBoardVersion(
  db: Database,
  boardId: string,
  rawN: string,
  headers: Record<string, string>,
): Response {
  if (!BOARD_ID_PATTERN.test(boardId)) {
    throw new BoardNotFound(boardId);
  }
  // same boundary parse as the host's GET /api/boards/:id/versions/:n
  const n = asNonNegativeIntString(rawN, "n");
  if (n === undefined) {
    throw new HttpError(
      400,
      "invalid_request",
      "n must be a non-negative integer",
    );
  }
  if (getBoard(db, boardId) === null) {
    throw new BoardNotFound(boardId);
  }
  const version = getVersion(db, boardId, n);
  if (version === null) {
    throw new VersionNotFound(boardId, n);
  }
  return new Response(version.content, {
    headers: {
      ...headers,
      "content-type": "text/html; charset=utf-8",
      "cache-control": IMMUTABLE_CACHE,
    },
  });
}

// GET /libs/<file> serves the vendored, version-stamped libraries from
// <repo>/server/origin-libs: the board CSP's script-src 'self' means boards
// load pinned libs from the origin itself (docs/security.md). Filenames carry
// the lib version, so an upgrade adds a file and immutable caching can never
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

// The board-origin server: sandbox documents (/b/:id/:n) and their pinned
// vendored libs (/libs/<file>). Every response carries the locked header set —
// including errors (docs/security.md "Sandbox architecture").
async function handleBoardOriginRequest(
  req: Request,
  config: Config,
  db: Database,
  libsDir: string,
  securityHeaders: Record<string, string>,
): Promise<Response> {
  try {
    assertAllowedHost(req, config);
    rejectCrossSite(req);
    const { pathname } = new URL(req.url);
    if (req.method !== "GET") {
      return jsonError(
        405,
        "method_not_allowed",
        `${req.method} is not allowed for ${pathname}`,
        { ...securityHeaders, allow: "GET" },
      );
    }
    if (pathname.startsWith("/libs/")) {
      return serveLib(libsDir, pathname, securityHeaders);
    }
    const boardMatch = /^\/b\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (boardMatch !== null) {
      return serveBoardVersion(
        db,
        boardMatch[1] ?? "",
        boardMatch[2] ?? "",
        securityHeaders,
      );
    }
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

export function startDaemon(config: Config, opts: DaemonOptions = {}): Daemon {
  const db = openDb(config.dataDir);
  // Placeholder until the origin server binds below: the host CSP embeds the
  // real origin port. startDaemon is fully synchronous, so no request can be
  // served before the assignment.
  const webHeaders: { headers: Record<string, string> } = { headers: {} };
  let hostServer: Bun.Server<undefined>;
  try {
    const webDist = resolveWebDist(opts.webRootHint);
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
          webHeaders.headers,
        ),
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
    // Vendored pinned libs for sandboxed boards (docs/security.md: script-src
    // 'self' on the board origin). Missing dir just 404s at serve time.
    const libsDir = join(
      resolveRepoRoot(opts.webRootHint),
      "server",
      "origin-libs",
    );
    originServer = Bun.serve({
      hostname: config.host,
      port: config.originPort,
      fetch: (req) =>
        handleBoardOriginRequest(req, config, db, libsDir, securityHeaders),
    });
  } catch (err) {
    hostServer.stop(true);
    db.close();
    throw err;
  }
  const originUrl = originUrlFor(config.host, boundPort(originServer));
  webHeaders.headers = hostSecurityHeaders(originUrl);
  // feeds GET /api/origin — the SPA's runtime discovery of this URL
  originUrlRef.url = originUrl;
  return {
    hostServer,
    originServer,
    hostUrl: originUrlFor(config.host, boundPort(hostServer)),
    originUrl,
    db,
    stop: async () => {
      await hostServer.stop(true);
      await originServer.stop(true);
      db.close();
    },
  };
}
