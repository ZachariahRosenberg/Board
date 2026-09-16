import type { Database } from "bun:sqlite";
import type { Actor } from "../domain.ts";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestContext {
  body?: unknown;
  params: Record<string, string>;
  actor?: Actor;
  db: Database;
  dataDir: string;
}

export interface Route {
  method: HttpMethod;
  // pattern: literals plus ":name" path params, e.g. "/api/boards/:id/versions/:n"
  path: string;
  // default true: bearer auth on everything; only health opts out
  auth?: boolean;
  // raw-body routes read their own request body — the daemon skips its
  // JSON-only content-type enforcement + parse for them (binary asset ingest)
  rawBody?: boolean;
  handler: (req: Request, ctx: RequestContext) => Response | Promise<Response>;
}

export function routeRequiresAuth(route: Route): boolean {
  return route.auth ?? true;
}

const PATH_PATTERN_CACHE = new Map<string, RegExp>();

// ":name" segments become non-empty named captures ([^/]+ — no crossing into
// the next segment); literal segments are escaped verbatim.
function patternRegExp(path: string): RegExp {
  let re = PATH_PATTERN_CACHE.get(path);
  if (re === undefined) {
    const source = path
      .split("/")
      .map((segment) =>
        segment.startsWith(":")
          ? `(?<${segment.slice(1)}>[^/]+)`
          : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/");
    re = new RegExp(`^${source}$`);
    PATH_PATTERN_CACHE.set(path, re);
  }
  return re;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // malformed percent-escape: keep the raw segment rather than 500ing on bad input
    return value;
  }
}

// Pattern-only match (method ignored) — the daemon uses this to compute 405 Allow.
export function matchPath(
  route: Route,
  pathname: string,
): Record<string, string> | null {
  const match = patternRegExp(route.path).exec(pathname);
  if (match === null) {
    return null;
  }
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(match.groups ?? {})) {
    params[name] = decodeSegment(value);
  }
  return params;
}

export function matchRoute(
  route: Route,
  method: string,
  pathname: string,
): Record<string, string> | null {
  if (route.method !== method) {
    return null;
  }
  return matchPath(route, pathname);
}
