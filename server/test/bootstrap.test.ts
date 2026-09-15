import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { resolveRepoRoot } from "../src/daemon.ts";

// The vendored bootstrap under test (version-stamped filename = upgrade
// contract, see server/origin-libs/README.md).
const SCRIPT_PATH = join(
  resolveRepoRoot(),
  "server",
  "origin-libs",
  "board-bootstrap-1.js",
);

interface Loaded {
  window: Window;
  scrolled: Array<{ id: string; options: unknown }>;
}

// Execute the vendored script against a fresh happy-dom document. The script
// is browser-global code, so window/document/location are bound as function
// parameters rather than polluting the test runner's own globals.
function loadBootstrap(url: string, bodyHtml: string): Loaded {
  const window = new Window({ url });
  window.document.body.innerHTML = bodyHtml;
  const scrolled: Array<{ id: string; options: unknown }> = [];
  window.HTMLElement.prototype.scrollIntoView = function intercept(
    this: HTMLElement,
    options?: ScrollIntoViewOptions,
  ) {
    scrolled.push({ id: this.getAttribute("data-ba") ?? "", options });
  };
  const script = readFileSync(SCRIPT_PATH, "utf8");
  new Function("window", "document", "location", script)(
    window,
    window.document,
    window.location,
  );
  return { window, scrolled };
}

describe("board bootstrap (origin-libs)", () => {
  test("an anchor fragment scrolls to and outlines the matching data-ba element", () => {
    const { window, scrolled } = loadBootstrap(
      "http://127.0.0.1:7801/b/b1/1#b2",
      '<h1 data-ba="b1">Plan</h1><p data-ba="b2">alpha</p>',
    );
    const target = window.document.querySelector('[data-ba="b2"]');
    expect(target?.classList.contains("board-anchor-target")).toBe(true);
    expect(window.document.querySelector('[data-ba="b1"]')?.className).not.toBe(
      "board-anchor-target",
    );
    expect(scrolled).toEqual([{ id: "b2", options: { block: "center" } }]);
    // the outline style is injected into the frame's own head, once
    const style = window.document.getElementById("board-bootstrap-style");
    expect(style?.textContent).toContain(".board-anchor-target");
  });

  test("hashchange re-aims the outline to the new target", () => {
    const { window, scrolled } = loadBootstrap(
      "http://127.0.0.1:7801/b/b1/1#b2",
      '<h1 data-ba="b1">Plan</h1><p data-ba="b2">alpha</p>',
    );
    scrolled.length = 0;
    window.location.hash = "#b1";
    window.dispatchEvent(new window.Event("hashchange"));
    const aim = scrolled.at(-1);
    expect(aim?.id).toBe("b1");
    const previous = window.document.querySelector('[data-ba="b2"]');
    const current = window.document.querySelector('[data-ba="b1"]');
    expect(previous?.classList.contains("board-anchor-target")).toBe(false);
    expect(current?.classList.contains("board-anchor-target")).toBe(true);
  });

  test("an unknown hash is a no-op", () => {
    const { window, scrolled } = loadBootstrap(
      "http://127.0.0.1:7801/b/b1/1#nope",
      '<h1 data-ba="b1">Plan</h1>',
    );
    expect(window.document.querySelector(".board-anchor-target")).toBe(null);
    expect(window.document.getElementById("board-bootstrap-style")).toBe(null);
    expect(scrolled).toEqual([]);
  });
});
