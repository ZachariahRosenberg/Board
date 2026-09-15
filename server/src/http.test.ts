import { describe, expect, test } from "bun:test";
import { type Config, makeConfig } from "./config.ts";
import {
  assertAllowedHost,
  HttpError,
  isUnsafeMethod,
  jsonError,
  jsonOk,
  MAX_BODY_BYTES,
  readJsonBody,
  rejectCrossSite,
  requireJsonContentType,
} from "./http.ts";

async function expectHttpError(
  run: () => unknown,
  status: number,
  code: string,
): Promise<void> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    const httpErr = err as HttpError;
    expect(httpErr.status).toBe(status);
    expect(httpErr.code).toBe(code);
    return;
  }
  throw new Error(
    `expected HttpError ${status} ${code}, but nothing was thrown`,
  );
}

function request(
  headers: Record<string, string>,
  method = "GET",
  body?: string,
): Request {
  return new Request("http://127.0.0.1:7800/api/probe", {
    method,
    headers,
    body,
  });
}

const defaultConfig: Config = makeConfig({});

describe("jsonOk", () => {
  test("returns 200 with a JSON content type", async () => {
    const res = jsonOk({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  test("honors a custom status", () => {
    const res = jsonOk({ created: true }, 201);
    expect(res.status).toBe(201);
  });
});

describe("jsonError", () => {
  test("renders the error envelope", async () => {
    const res = jsonError(404, "not_found", "no such route");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: "no such route" },
    });
  });

  test("merges extra headers", () => {
    const res = jsonError(405, "method_not_allowed", "wrong method", {
      allow: "GET",
    });
    expect(res.headers.get("allow")).toBe("GET");
  });

  test("merges details into the error object", async () => {
    const res = jsonError(
      409,
      "version_conflict",
      "stale expected_version",
      {},
      { current_version: 2 },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "version_conflict",
        message: "stale expected_version",
        current_version: 2,
      },
    });
  });
});

describe("HttpError", () => {
  test("carries status and code", () => {
    const err = new HttpError(421, "bad_host", "nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(421);
    expect(err.code).toBe("bad_host");
    expect(err.message).toBe("nope");
  });
});

describe("isUnsafeMethod", () => {
  test("flags mutating methods case-insensitively", () => {
    for (const method of [
      "POST",
      "post",
      "PUT",
      "Put",
      "PATCH",
      "DELETE",
      "delete",
    ]) {
      expect(isUnsafeMethod(method)).toBe(true);
    }
  });

  test("passes safe methods", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isUnsafeMethod(method)).toBe(false);
    }
  });
});

describe("requireJsonContentType", () => {
  test("accepts application/json", () => {
    expect(() =>
      requireJsonContentType(
        request({ "content-type": "application/json" }, "POST"),
      ),
    ).not.toThrow();
  });

  test("accepts application/json with parameters", () => {
    expect(() =>
      requireJsonContentType(
        request({ "content-type": "application/json; charset=utf-8" }, "POST"),
      ),
    ).not.toThrow();
  });

  test("rejects other media types with 415", async () => {
    await expectHttpError(
      () =>
        requireJsonContentType(
          request({ "content-type": "text/plain" }, "POST"),
        ),
      415,
      "unsupported_media_type",
    );
  });

  test("rejects a missing content type with 415", async () => {
    await expectHttpError(
      () => requireJsonContentType(request({}, "POST")),
      415,
      "unsupported_media_type",
    );
  });
});

describe("readJsonBody", () => {
  test("parses a JSON body", async () => {
    const body = await readJsonBody(
      request({ "content-type": "application/json" }, "POST", '{"a":1}'),
    );
    expect(body).toEqual({ a: 1 });
  });

  test("returns undefined for an empty body", async () => {
    const body = await readJsonBody(
      request({ "content-type": "application/json" }, "POST", ""),
    );
    expect(body).toBeUndefined();
  });

  test("rejects invalid JSON with 400", async () => {
    await expectHttpError(
      () => readJsonBody(request({}, "POST", "not json")),
      400,
      "invalid_json",
    );
  });

  test("rejects bodies over the 8 MB cap with 413", async () => {
    const oversized = `"${"x".repeat(MAX_BODY_BYTES)}"`;
    expect(oversized.length).toBeGreaterThan(MAX_BODY_BYTES);
    await expectHttpError(
      () => readJsonBody(request({}, "POST", oversized)),
      413,
      "payload_too_large",
    );
  });

  test("accepts a body exactly at the cap", async () => {
    const atCap = `{"pad":"${" ".repeat(MAX_BODY_BYTES - 10)}"}`;
    expect(atCap.length).toBe(MAX_BODY_BYTES);
    const body = (await readJsonBody(request({}, "POST", atCap))) as {
      pad: string;
    };
    expect(body.pad.length).toBe(MAX_BODY_BYTES - 10);
  });
});

describe("assertAllowedHost", () => {
  test("accepts 127.0.0.1 with any port", () => {
    expect(() =>
      assertAllowedHost(request({ host: "127.0.0.1:54321" }), defaultConfig),
    ).not.toThrow();
  });

  test("accepts localhost case-insensitively", () => {
    expect(() =>
      assertAllowedHost(request({ host: "LOCALHOST:80" }), defaultConfig),
    ).not.toThrow();
  });

  test("accepts IPv6 loopback in bracketed and bare form", () => {
    expect(() =>
      assertAllowedHost(request({ host: "[::1]:7800" }), defaultConfig),
    ).not.toThrow();
    expect(() =>
      assertAllowedHost(request({ host: "::1" }), defaultConfig),
    ).not.toThrow();
  });

  test("rejects other hostnames with 421", async () => {
    await expectHttpError(
      () => assertAllowedHost(request({ host: "evil.com" }), defaultConfig),
      421,
      "bad_host",
    );
    await expectHttpError(
      () =>
        assertAllowedHost(request({ host: "127.0.0.2:7800" }), defaultConfig),
      421,
      "bad_host",
    );
  });

  test("rejects a missing Host header with 421", async () => {
    await expectHttpError(
      () => assertAllowedHost(request({}), defaultConfig),
      421,
      "bad_host",
    );
  });

  test("accepts hosts from the configured bind list", async () => {
    const dockerConfig = makeConfig({
      BOARD_BIND: "127.0.0.1,host.docker.internal",
    });
    expect(() =>
      assertAllowedHost(
        request({ host: "host.docker.internal:7800" }),
        dockerConfig,
      ),
    ).not.toThrow();
    await expectHttpError(
      () =>
        assertAllowedHost(
          request({ host: "other.internal:7800" }),
          dockerConfig,
        ),
      421,
      "bad_host",
    );
  });
});

describe("rejectCrossSite", () => {
  test("blocks unsafe cross-site methods with 403", async () => {
    await expectHttpError(
      () =>
        rejectCrossSite(request({ "sec-fetch-site": "cross-site" }, "POST")),
      403,
      "cross_site_blocked",
    );
    await expectHttpError(
      () => rejectCrossSite(request({ "sec-fetch-site": "cross-site" }, "PUT")),
      403,
      "cross_site_blocked",
    );
  });

  test("allows safe methods even when cross-site", () => {
    expect(() =>
      rejectCrossSite(request({ "sec-fetch-site": "cross-site" }, "GET")),
    ).not.toThrow();
  });

  test("allows same-site, none, and absent Sec-Fetch-Site on unsafe methods", () => {
    expect(() =>
      rejectCrossSite(request({ "sec-fetch-site": "same-site" }, "POST")),
    ).not.toThrow();
    expect(() =>
      rejectCrossSite(request({ "sec-fetch-site": "same-origin" }, "POST")),
    ).not.toThrow();
    expect(() =>
      rejectCrossSite(request({ "sec-fetch-site": "none" }, "POST")),
    ).not.toThrow();
    expect(() => rejectCrossSite(request({}, "POST"))).not.toThrow();
  });
});
