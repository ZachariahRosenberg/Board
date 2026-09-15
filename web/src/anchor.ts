import type {
  Anchor,
  RowAnchor,
  SectionAnchor,
  TextAnchor,
} from "../../server/src/domain.ts";

export const BOARD_ANCHOR: Anchor = { type: "board" };

function closestDataBa(node: Node, root: Element): Element | null {
  let el =
    node.nodeType === 1 ? (node as Element) : (node.parentElement ?? null);
  while (el !== null && el !== root) {
    if (el.hasAttribute("data-ba")) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

export function anchorFromRange(
  range: Range,
  root: Element | null,
): TextAnchor | null {
  if (root === null) {
    return null;
  }
  const section = closestDataBa(range.commonAncestorContainer, root);
  if (section === null) {
    return null;
  }
  const originalText = range.toString();
  if (originalText.trim().length === 0) {
    return null;
  }
  const sectionText = section.textContent ?? "";
  // offsets are within the section's full text (docs/plan.md anchor model);
  // the quote itself is the re-anchor truth, so a -1 here just means the
  // selection is not text-shaped — callers drop the affordance
  const startOffset = sectionText.indexOf(originalText);
  if (startOffset === -1) {
    return null;
  }
  return {
    type: "text",
    section_id: section.getAttribute("data-ba") ?? "",
    originalText,
    startOffset,
    endOffset: startOffset + originalText.length,
  };
}

export function anchorFromSelection(
  selection: Selection,
  root: Element | null,
): TextAnchor | null {
  if (selection.rangeCount === 0) {
    return null;
  }
  return anchorFromRange(selection.getRangeAt(0), root);
}

export function anchorForElement(el: Element): SectionAnchor | RowAnchor {
  const id = el.getAttribute("data-ba") ?? "";
  if (el.tagName === "TR") {
    const table = el.closest("table");
    return {
      type: "row",
      section_id: table?.getAttribute("data-ba") ?? "",
      row_id: id,
    };
  }
  return { type: "section", section_id: id };
}

// html boards are aimed by URL fragment: the iframe src gains #<id> and the
// board's own bootstrap script (origin-libs/board-bootstrap-1.js) scrolls to
// and outlines the target — the sandbox allows no host access into the frame.
// Text anchors aim at their section (best available target); board/image
// anchors have no in-frame target.
export function anchorFragment(anchor: Anchor): string | null {
  switch (anchor.type) {
    case "board":
      return null;
    case "section":
      return anchor.section_id;
    case "text":
      return anchor.section_id;
    case "row":
      return anchor.row_id;
    case "image":
      return null;
  }
}

export function anchorDescriptor(anchor: Anchor): string {
  switch (anchor.type) {
    case "board":
      return "board";
    case "section":
      return `section ${anchor.section_id}`;
    case "text":
      return `text ${anchor.section_id}: “${anchor.originalText}”`;
    case "row":
      return `row ${anchor.section_id}/${anchor.row_id}`;
    case "image":
      return `image ${anchor.asset_id}`;
  }
}

function findByDataBa(root: Element, id: string): Element | null {
  for (const el of [...root.querySelectorAll("[data-ba]")]) {
    if (el.getAttribute("data-ba") === id) {
      return el;
    }
  }
  return null;
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walk = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        out.push(child as Text);
        continue;
      }
      if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(root);
  return out;
}

export function clearHighlight(root: Element): void {
  root.classList.remove("anchor-board");
  for (const el of [
    ...root.querySelectorAll(".anchor-target, .anchor-moved"),
  ]) {
    el.classList.remove("anchor-target", "anchor-moved");
  }
  for (const mark of [...root.querySelectorAll("mark.anchor-hit")]) {
    const parent = mark.parentNode;
    if (parent !== null) {
      while (mark.firstChild !== null) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
    }
  }
}

// Wrap [startOffset, endOffset) of the element's text in a mark; a range that
// cannot be surrounded (crosses node boundaries) falls back to outlining the
// section.
function markTextRange(
  el: Element,
  startOffset: number,
  endOffset: number,
): void {
  let consumed = 0;
  for (const node of textNodes(el)) {
    const len = node.data.length;
    if (startOffset >= consumed + len) {
      consumed += len;
      continue;
    }
    const localStart = Math.max(0, startOffset - consumed);
    const localEnd = Math.min(len, endOffset - consumed);
    if (localEnd > localStart) {
      const doc = node.ownerDocument;
      const mark = doc.createElement("mark");
      mark.className = "anchor-hit";
      const range = doc.createRange();
      range.setStart(node, localStart);
      range.setEnd(node, localEnd);
      try {
        range.surroundContents(mark);
      } catch {
        el.classList.add("anchor-target");
      }
      return;
    }
    consumed += len;
  }
  el.classList.add("anchor-target");
}

// Scroll to the anchor and mark it. Text anchors re-anchor QUOTE-FIRST: the
// stored quote is the truth and the offsets are a hint from the version of
// record — after an edit, blind offsets highlight whatever text now sits at
// those positions (dogfooded: "it highlights a different word"). The quote is
// re-located in the current document; if the quote itself is gone (section
// rewritten), the section is outlined and badged as moved rather than guessed
// at. Anchors that survive beyond quote re-match remain a phase-2 item.
export function highlightAnchor(anchor: Anchor, root: Element | null): void {
  if (root === null) {
    return;
  }
  clearHighlight(root);
  if (anchor.type === "board") {
    root.classList.add("anchor-board");
    return;
  }
  if (anchor.type === "image") {
    return;
  }
  const id = anchor.type === "row" ? anchor.row_id : anchor.section_id;
  const el = findByDataBa(root, id);
  if (el === null) {
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (anchor.type === "text") {
    const text = el.textContent ?? "";
    const idx = text.indexOf(anchor.originalText);
    if (idx === -1) {
      el.classList.add("anchor-target", "anchor-moved");
      return;
    }
    markTextRange(el, idx, idx + anchor.originalText.length);
    return;
  }
  el.classList.add("anchor-target");
}
