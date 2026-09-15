import { describe, expect, test } from "bun:test";
import {
  currentRoute,
  navigate,
  onRouteChange,
  parseHash,
  type Route,
} from "./router.ts";
import { installDom } from "./test-dom.ts";

installDom();

describe("router", () => {
  test("parses list and board routes", () => {
    expect(parseHash("#/")).toEqual({ name: "list" });
    expect(parseHash("")).toEqual({ name: "list" });
    expect(parseHash("#/boards/x1")).toEqual({ name: "board", id: "x1" });
    expect(parseHash("#/boards/")).toEqual({ name: "list" });
  });

  test("navigate sets the hash", () => {
    const board: Route = { name: "board", id: "z9" };
    navigate(board);
    expect(location.hash).toBe("#/boards/z9");
    navigate({ name: "list" });
    expect(location.hash).toBe("#/");
  });

  test("currentRoute follows the hash", () => {
    location.hash = "#/boards/qq";
    expect(currentRoute()).toEqual({ name: "board", id: "qq" });
  });

  test("onRouteChange subscribes and unsubscribes", () => {
    let fired = 0;
    const off = onRouteChange(() => {
      fired += 1;
    });
    window.dispatchEvent(new Event("hashchange"));
    off();
    window.dispatchEvent(new Event("hashchange"));
    expect(fired).toBe(1);
  });
});
