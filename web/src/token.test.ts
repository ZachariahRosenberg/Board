import { describe, expect, test } from "bun:test";
import { installDom } from "./test-dom.ts";
import {
  clearSessionToken,
  extractOneTimeToken,
  getSessionToken,
  setSessionToken,
} from "./token.ts";

installDom();

describe("token store", () => {
  test("round-trips the session token", () => {
    expect(getSessionToken()).toBe(null);
    setSessionToken("sess-1");
    expect(getSessionToken()).toBe("sess-1");
    clearSessionToken();
    expect(getSessionToken()).toBe(null);
  });

  test("extracts a one-time token from ?token= and strips it from the URL", () => {
    window.location.href = "http://127.0.0.1:5173/?token=abc123#/boards/x1";
    expect(extractOneTimeToken()).toBe("abc123");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#/boards/x1");
    expect(extractOneTimeToken()).toBe(null);
  });

  test("returns null when no token param is present", () => {
    window.location.href = "http://127.0.0.1:5173/#/";
    expect(extractOneTimeToken()).toBe(null);
  });
});
