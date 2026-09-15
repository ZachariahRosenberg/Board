import { describe, expect, test } from "bun:test";
import { jsonOk } from "../http.ts";
import {
  matchPath,
  matchRoute,
  type Route,
  routeRequiresAuth,
} from "./route.ts";

const noopHandler = (): Response => jsonOk({});

function route(path: string, method: Route["method"] = "GET"): Route {
  return { method, path, handler: noopHandler };
}

describe("matchPath", () => {
  test("matches a literal path with no params", () => {
    expect(matchPath(route("/api/health"), "/api/health")).toEqual({});
  });

  test("rejects non-matching literals, trailing slashes, and extra segments", () => {
    const health = route("/api/health");
    expect(matchPath(health, "/api/health/")).toBeNull();
    expect(matchPath(health, "/api/healthz")).toBeNull();
    expect(matchPath(health, "/api/health/extra")).toBeNull();
    expect(matchPath(health, "/api")).toBeNull();
  });

  test("extracts params from a pattern", () => {
    expect(
      matchPath(
        route("/api/boards/:id/versions/:n"),
        "/api/boards/ab12Cd34Ef/versions/3",
      ),
    ).toEqual({ id: "ab12Cd34Ef", n: "3" });
  });

  test("requires every param segment to be non-empty", () => {
    expect(matchPath(route("/api/boards/:id"), "/api/boards/")).toBeNull();
    expect(
      matchPath(
        route("/api/boards/:id/versions/:n"),
        "/api/boards/x/versions/",
      ),
    ).toBeNull();
  });

  test("a pattern does not capture across other literals", () => {
    expect(matchPath(route("/api/boards/:id"), "/api/events")).toBeNull();
    expect(
      matchPath(route("/api/boards/:id/publish"), "/api/boards/x/restore"),
    ).toBeNull();
  });

  test("decodes percent-encoded params without splitting segments, tolerating malformed escapes", () => {
    expect(matchPath(route("/api/boards/:id"), "/api/boards/a%2Fb")).toEqual({
      id: "a/b",
    });
    expect(matchPath(route("/api/boards/:id"), "/api/boards/a%")).toEqual({
      id: "a%",
    });
  });
});

describe("matchRoute", () => {
  test("matches only when both method and pattern match", () => {
    const get = route("/api/boards", "GET");
    expect(matchRoute(get, "GET", "/api/boards")).toEqual({});
    expect(matchRoute(get, "POST", "/api/boards")).toBeNull();
    expect(matchRoute(get, "GET", "/api/events")).toBeNull();
  });
});

describe("routeRequiresAuth", () => {
  test("auth defaults to true when absent", () => {
    expect(routeRequiresAuth(route("/api/boards"))).toBe(true);
  });

  test("explicit auth: false opts out", () => {
    expect(routeRequiresAuth({ ...route("/api/health"), auth: false })).toBe(
      false,
    );
  });
});
