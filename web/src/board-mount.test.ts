import { beforeEach, describe, expect, test } from "bun:test";
import { mountBoardDocument } from "./board-mount.ts";
import { installDom } from "./test-dom.ts";

installDom();

// happy-dom evaluates scripts inside the WINDOW's realm — the script's
// `globalThis` is the window's, not bun's test-process global. Read counts
// through the window object (installDom exposes it as a global).
const INLINE =
  "globalThis.__dashInlineCount = (globalThis.__dashInlineCount ?? 0) + 1;";

function inlineCount(): number | undefined {
  return (window as unknown as { __dashInlineCount?: number })
    .__dashInlineCount;
}

// mirrors the real template: the chart lib loads from <head>, the board's
// inline code runs at the end of <body>
const DOC = [
  "<!doctype html><html><head><title>Dashboard</title>",
  "<style>.dash-card { color: red; }</style>",
  '<link rel="stylesheet" href="/libs/dash-1.css">',
  '<script src="/libs/chart-4.4.9.umd.min.js"></script>',
  "</head><body>",
  '<section data-ba="s-header" data-ba-label="Header"><h1>Dashboard</h1></section>',
  "<p>tail</p>",
  `<script>${INLINE}</script>`,
  "</body></html>",
].join("");

function newContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

// Resolve a pending external script mount by dispatching its load event —
// in a real browser the fetch does this; happy-dom never fetches src scripts.
function fireLoad(script: HTMLScriptElement): void {
  script.dispatchEvent(new Event("load"));
}

function srcScript(container: HTMLElement): HTMLScriptElement {
  return container.querySelector("script[src]") as HTMLScriptElement;
}

describe("mountBoardDocument", () => {
  beforeEach(() => {
    // reset through the window wrapper — a `delete` on the wrapper does not
    // reach happy-dom's VM realm, so counts would accumulate across tests
    (window as unknown as { __dashInlineCount?: number }).__dashInlineCount =
      undefined;
    for (const el of [...document.body.children]) {
      el.remove();
    }
  });

  test("mounts body children and head styles into the container", async () => {
    const container = newContainer();
    const mounted = mountBoardDocument(DOC, container);
    fireLoad(srcScript(container));
    await mounted;
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

  test("head scripts are not dropped — and an inline script waits for them", async () => {
    // dogfooded twice in one error ("Uncaught ReferenceError: Chart is not
    // defined"): the head pass silently dropped the /libs script, AND the
    // inline body code raced the fetch because async=false only orders
    // external scripts among themselves, never against inline ones
    const container = newContainer();
    const mounted = mountBoardDocument(DOC, container);
    // the head script is re-created and pending; the inline script has not
    // been created or executed — its turn has not come
    expect(container.querySelectorAll("script")).toHaveLength(1);
    expect(srcScript(container).getAttribute("src")).toBe(
      "/libs/chart-4.4.9.umd.min.js",
    );
    expect(inlineCount()).toBe(undefined);
    // the fetch lands — only then does the inline script run, exactly once
    // (parsed originals never enter the DOM, so no double execution)
    fireLoad(srcScript(container));
    await mounted;
    expect(inlineCount()).toBe(1);
    const scripts = [...container.querySelectorAll("script")];
    expect(scripts).toHaveLength(2);
    expect(scripts[1].getAttribute("src")).toBe(null);
    expect(scripts[1].text).toBe(INLINE);
  });

  test("root-relative /libs references are preserved verbatim", async () => {
    const container = newContainer();
    const mounted = mountBoardDocument(DOC, container);
    fireLoad(srcScript(container));
    await mounted;
    expect(srcScript(container).getAttribute("src")).toBe(
      "/libs/chart-4.4.9.umd.min.js",
    );
  });

  test("opt-in data-ba sections pass through untouched", async () => {
    const container = newContainer();
    const mounted = mountBoardDocument(DOC, container);
    fireLoad(srcScript(container));
    await mounted;
    const section = container.querySelector('[data-ba="s-header"]');
    expect(section?.getAttribute("data-ba-label")).toBe("Header");
  });

  test("clears the container on re-mount so version switches do not stack documents", async () => {
    const container = newContainer();
    for (let i = 0; i < 2; i++) {
      const mounted = mountBoardDocument(DOC, container);
      fireLoad(srcScript(container));
      await mounted;
    }
    expect(container.querySelectorAll("section")).toHaveLength(1);
    expect(inlineCount()).toBe(2);
  });

  test("a version switch aborts a pending script sequence — detached scripts never execute", async () => {
    const container = newContainer();
    const first = mountBoardDocument(DOC, container);
    const firstScript = srcScript(container);
    // switch versions before the first mount's external script ever loads:
    // the remount detaches firstScript and the whole old sequence must abort
    const second = mountBoardDocument(DOC, container);
    const secondScript = srcScript(container);
    expect(secondScript).not.toBe(firstScript);
    // a late load event on the detached script resolves the old mount's
    // await; its own pending script is no longer connected, so the sequence
    // aborts and the old inline never runs
    fireLoad(firstScript);
    fireLoad(secondScript);
    await Promise.all([first, second]);
    // exactly one inline execution — the second mount's
    expect(inlineCount()).toBe(1);
    expect(container.querySelectorAll("script")).toHaveLength(2);
  });
});
