import { describe, expect, test } from "bun:test";
import { mountBoardDocument } from "./board-mount.ts";
import { installDom } from "./test-dom.ts";

installDom();

const DOC = [
  "<!doctype html><html><head><title>Dashboard</title>",
  "<style>.dash-card { color: red; }</style>",
  '<link rel="stylesheet" href="/libs/dash-1.css">',
  "</head><body>",
  '<section data-ba="s-header" data-ba-label="Header"><h1>Dashboard</h1></section>',
  "<p>tail</p>",
  '<script src="/libs/chart-4.4.9.umd.min.js"></script>',
  "<script>exportInert();</script>",
  "</body></html>",
].join("");

function newContainer(): HTMLElement {
  return document.createElement("div");
}

describe("mountBoardDocument", () => {
  test("mounts body children and head styles into the container", () => {
    const container = newContainer();
    mountBoardDocument(DOC, container);
    expect(container.querySelector("section h1")?.textContent).toBe(
      "Dashboard",
    );
    expect(container.querySelector("p")?.textContent).toBe("tail");
    // the template keeps its styles in <head> — losing them breaks rendering
    expect(container.querySelector("style")?.textContent).toContain(
      ".dash-card",
    );
    expect(
      container.querySelector("link[rel='stylesheet']")?.getAttribute("href"),
    ).toBe("/libs/dash-1.css");
  });

  test("re-creates script elements preserving src, inline text, and order", () => {
    const container = newContainer();
    mountBoardDocument(DOC, container);
    const scripts = [...container.querySelectorAll("script")];
    expect(scripts).toHaveLength(2);
    // structural assertion: the mounted script is a fresh element carrying
    // the same attributes — the re-creation is what makes the browser
    // evaluate it (innerHTML would not)
    expect(scripts[0].getAttribute("src")).toBe("/libs/chart-4.4.9.umd.min.js");
    expect(scripts[0].async).toBe(false);
    expect(scripts[1].getAttribute("src")).toBe(null);
    expect(scripts[1].text).toBe("exportInert();");
  });

  test("root-relative /libs references are preserved verbatim", () => {
    const container = newContainer();
    mountBoardDocument(DOC, container);
    const src = container.querySelector("script[src]")?.getAttribute("src");
    expect(src).toBe("/libs/chart-4.4.9.umd.min.js");
  });

  test("opt-in data-ba sections pass through untouched", () => {
    const container = newContainer();
    mountBoardDocument(DOC, container);
    const section = container.querySelector('[data-ba="s-header"]');
    expect(section?.getAttribute("data-ba-label")).toBe("Header");
  });

  test("clears the container on re-mount so version switches do not stack documents", () => {
    const container = newContainer();
    mountBoardDocument(DOC, container);
    mountBoardDocument(DOC, container);
    expect(container.querySelectorAll("section")).toHaveLength(1);
  });
});
