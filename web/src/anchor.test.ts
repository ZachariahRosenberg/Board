import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  anchorDescriptor,
  anchorForElement,
  anchorFromRange,
  BOARD_ANCHOR,
  clearHighlight,
  highlightAnchor,
} from "./anchor.ts";

const window = new Window();
const { document } = window;

// happy-dom instances satisfy the lib.dom-shaped app signatures at runtime but
// not structurally (happy-dom carries private PropertySymbol fields) — adapt
// at this test boundary only.
const asDomElement = (node: unknown): Element => node as Element;
const asDomRange = (range: unknown): Range => range as Range;

function container() {
  const root = document.createElement("div");
  root.innerHTML = `
    <h1 data-ba="b1">Plan</h1>
    <p data-ba="b2">alpha beta gamma</p>
    <p data-ba="b3">with <strong>bold beta</strong> tail</p>
    <table data-ba="b4">
      <thead><tr data-ba="b4r1"><th>A</th></tr></thead>
      <tbody><tr data-ba="b4r2"><td>one</td></tr></tbody>
    </table>
  `;
  return root;
}

describe("anchorFromRange", () => {
  test("derives a text anchor from a selection within one section", () => {
    const root = container();
    const para = root.querySelector('[data-ba="b2"]');
    const text = para?.firstChild;
    if (text === undefined || text === null) {
      throw new Error("fixture missing text node");
    }
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 10);
    const anchor = anchorFromRange(asDomRange(range), asDomElement(root));
    expect(anchor).toEqual({
      type: "text",
      section_id: "b2",
      originalText: "beta",
      startOffset: 6,
      endOffset: 10,
    });
  });

  test("resolves the nearest data-ba ancestor through inline markup", () => {
    const root = container();
    const strong = root.querySelector("strong");
    const text = strong?.firstChild;
    if (text === undefined || text === null) {
      throw new Error("fixture missing text node");
    }
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, 9);
    const anchor = anchorFromRange(asDomRange(range), asDomElement(root));
    expect(anchor?.section_id).toBe("b3");
    expect(anchor?.originalText).toBe("beta");
  });

  test("returns null for whitespace-only selections", () => {
    const root = container();
    const para = root.querySelector('[data-ba="b2"]');
    const text = para?.firstChild;
    if (text === undefined || text === null) {
      throw new Error("fixture missing text node");
    }
    const range = document.createRange();
    range.setStart(text, 5);
    range.setEnd(text, 6);
    expect(anchorFromRange(asDomRange(range), asDomElement(root))).toBe(null);
  });

  test("returns null when the selection has no data-ba ancestor", () => {
    const root = container();
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(root, 1);
    expect(anchorFromRange(asDomRange(range), asDomElement(root))).toBe(null);
  });
});

describe("anchorForElement", () => {
  test("top-level elements become section anchors", () => {
    const root = container();
    const heading = root.querySelector('[data-ba="b1"]');
    if (heading === null) {
      throw new Error("fixture missing heading");
    }
    expect(anchorForElement(asDomElement(heading))).toEqual({
      type: "section",
      section_id: "b1",
    });
  });

  test("table rows become row anchors carrying the table's section id", () => {
    const root = container();
    const row = root.querySelector('[data-ba="b4r2"]');
    if (row === null) {
      throw new Error("fixture missing row");
    }
    expect(anchorForElement(asDomElement(row))).toEqual({
      type: "row",
      section_id: "b4",
      row_id: "b4r2",
    });
  });
});

describe("anchorDescriptor", () => {
  test("renders chip labels for every anchor type", () => {
    expect(anchorDescriptor(BOARD_ANCHOR)).toBe("board");
    expect(anchorDescriptor({ type: "section", section_id: "b1" })).toBe(
      "section b1",
    );
    expect(
      anchorDescriptor({
        type: "text",
        section_id: "b2",
        originalText: "beta",
        startOffset: 6,
        endOffset: 10,
      }),
    ).toBe("text b2: “beta”");
    expect(
      anchorDescriptor({ type: "row", section_id: "b4", row_id: "b4r2" }),
    ).toBe("row b4/b4r2");
  });
});

describe("highlightAnchor", () => {
  test("text anchors wrap the quoted range in a mark", () => {
    const root = asDomElement(container());
    highlightAnchor(
      {
        type: "text",
        section_id: "b2",
        originalText: "beta",
        startOffset: 6,
        endOffset: 10,
      },
      root,
    );
    expect(root.querySelector("mark.anchor-hit")?.textContent).toBe("beta");
    clearHighlight(root);
    expect(root.querySelector("mark.anchor-hit")).toBe(null);
    expect(root.querySelector('[data-ba="b2"]')?.textContent).toBe(
      "alpha beta gamma",
    );
  });

  test("section and row anchors outline the element", () => {
    const root = asDomElement(container());
    highlightAnchor({ type: "section", section_id: "b1" }, root);
    expect(
      root.querySelector('[data-ba="b1"]')?.classList.contains("anchor-target"),
    ).toBe(true);
    clearHighlight(root);
    highlightAnchor({ type: "row", section_id: "b4", row_id: "b4r2" }, root);
    expect(
      root
        .querySelector('[data-ba="b4r2"]')
        ?.classList.contains("anchor-target"),
    ).toBe(true);
    clearHighlight(root);
    expect(
      root
        .querySelector('[data-ba="b4r2"]')
        ?.classList.contains("anchor-target"),
    ).toBe(false);
  });

  test("quote drift re-anchors by the quote, ignoring stale offsets", () => {
    // dogfooded: after a version edit the stored offsets pointed at unrelated
    // text ("it highlights a different word") — the quote is the truth
    const root = asDomElement(container());
    highlightAnchor(
      {
        type: "text",
        section_id: "b2",
        originalText: "beta",
        startOffset: 0,
        endOffset: 4,
      },
      root,
    );
    expect(root.querySelector("mark.anchor-hit")?.textContent).toBe("beta");
    expect(root.querySelector('[data-ba="b2"]')?.textContent).toBe(
      "alpha beta gamma",
    );
    clearHighlight(root);
  });

  test("a quote that no longer exists outlines the section as moved", () => {
    const root = asDomElement(container());
    highlightAnchor(
      {
        type: "text",
        section_id: "b2",
        originalText: "delta",
        startOffset: 6,
        endOffset: 10,
      },
      root,
    );
    const section = root.querySelector('[data-ba="b2"]');
    expect(section?.classList.contains("anchor-target")).toBe(true);
    expect(section?.classList.contains("anchor-moved")).toBe(true);
    expect(root.querySelector("mark.anchor-hit")).toBe(null);
    clearHighlight(root);
    expect(section?.classList.contains("anchor-moved")).toBe(false);
    expect(section?.classList.contains("anchor-target")).toBe(false);
  });

  test("board anchors tint the whole document container", () => {
    const root = asDomElement(container());
    highlightAnchor(BOARD_ANCHOR, root);
    expect(root.classList.contains("anchor-board")).toBe(true);
    clearHighlight(root);
    expect(root.classList.contains("anchor-board")).toBe(false);
  });
});
