import { describe, expect, test } from "bun:test";
import {
  renderHtmlDocument,
  renderMarkdownDocument,
  TASK_LIST_TITLE,
} from "../../server/src/render.ts";
import { installDom } from "./test-dom.ts";

installDom();

// Cross-boundary contract test: the render pipeline (marked GFM → DOMPurify →
// glyph replacement in server/src/render.ts) is the implementation of the
// task-list affordance; the muted/inert LOOK is CSS (styles.css, scoped to
// .board-content.markdown). It lives web-side because what it guards is the
// DOM the web styles key off.
describe("markdown task-list glyphs (static snapshot affordance)", () => {
  test("GFM task lists render glyph spans, not checkbox inputs", async () => {
    const { html } = await renderMarkdownDocument(
      "- [ ] unchecked thing\n- [x] checked thing\n",
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    // no control semantics left — the dogfooded complaint was that a disabled
    // input still LOOKS interactive
    expect(doc.querySelectorAll("input")).toHaveLength(0);
    const glyphs = [...doc.querySelectorAll("span.task-glyph")];
    expect(glyphs).toHaveLength(2);
    for (const glyph of glyphs) {
      expect(glyph.getAttribute("title")).toBe(TASK_LIST_TITLE);
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
    }
    // `- [x]` state survives the pipeline, as a clearly distinct glyph
    expect(glyphs[0].textContent).toBe("☐");
    expect(glyphs[1].textContent).toBe("☑");
  });

  test("html boards get no snapshot title — their checkboxes may be interactive (D18)", () => {
    const { html } = renderHtmlDocument(
      '<body><form><input type="checkbox"></form></body>',
    );
    expect(html).not.toContain(TASK_LIST_TITLE);
    expect(html).toContain('type="checkbox"');
  });
});
