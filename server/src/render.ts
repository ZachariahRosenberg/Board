import type { Config } from "dompurify";
import createDOMPurify from "dompurify";
import type { Document, Element, Node, Text } from "happy-dom";
import { Window } from "happy-dom";
import katex from "katex";
import { marked } from "marked";
import { codeToHtml } from "shiki";
import type { ExtractedAnchor } from "./domain.ts";

const window = new Window();

// happy-dom's Node.prototype.nodeName getter returns "" unconditionally (real
// names come from per-subclass getters), but dompurify caches exactly that base
// getter for its clobber-safe node-name reads — every element would classify as
// tagName "" and get stripped. Redefine the base getter to be receiver-correct
// (spec nodeType dispatch); subclasses still shadow it.
interface NodeNameLike {
  nodeType: number;
  tagName?: string;
  name?: string;
  target?: string;
}

function specNodeName(this: NodeNameLike): string {
  switch (this.nodeType) {
    case 1:
      return this.tagName ?? "";
    case 2:
      return this.name ?? "";
    case 3:
      return "#text";
    case 4:
      return "#cdata-section";
    case 7:
      return this.target ?? "";
    case 8:
      return "#comment";
    case 9:
      return "#document";
    case 10:
      return this.name ?? "";
    case 11:
      return "#document-fragment";
    default:
      return "";
  }
}

Object.defineProperty(window.Node.prototype, "nodeName", {
  configurable: true,
  get: specNodeName,
});

// happy-dom's NodeIterator stops returning nodes as soon as the walk removes
// one, but DOMPurify's whole design is "iterate + remove inline" — everything
// after the first removal would survive unsanitized (invariant 6,
// docs/security.md "Content rules"). Replace createNodeIterator on the exact
// document dompurify caches it from with a removal-robust pre-order iterator.
function withinRoot(root: Node, node: Node): boolean {
  let current: Node | null = node;
  while (current !== null) {
    if (current === root) {
      return true;
    }
    current = current.parentNode;
  }
  return false;
}

function preorderSuccessor(node: Node, root: Node): Node | null {
  if (node.firstChild !== null) {
    return node.firstChild;
  }
  let current: Node | null = node;
  while (current !== null && current !== root) {
    if (current.nextSibling !== null) {
      return current.nextSibling;
    }
    current = current.parentNode;
  }
  return null;
}

interface RobustNodeIterator {
  nextNode(): Node | null;
}

function createRobustNodeIterator(
  root: Node,
  whatToShow: number,
): RobustNodeIterator {
  const visited = new Set<Node>();
  let last: Node | null = null;
  let lastConnected: Node | null = null;
  const shows = (node: Node): boolean =>
    ((whatToShow >>> (node.nodeType - 1)) & 1) === 1;
  return {
    nextNode(): Node | null {
      let candidate: Node | null;
      if (last === null) {
        candidate = root;
      } else if (withinRoot(root, last)) {
        candidate = preorderSuccessor(last, root);
      } else if (lastConnected !== null && withinRoot(root, lastConnected)) {
        // last was removed by the walk: resume after the last surviving node —
        // hoisted children of the removed node sit right there
        candidate = preorderSuccessor(lastConnected, root);
      } else {
        candidate = root;
      }
      while (candidate !== null) {
        if (shows(candidate) && !visited.has(candidate)) {
          visited.add(candidate);
          last = candidate;
          lastConnected = candidate;
          return candidate;
        }
        candidate = preorderSuccessor(candidate, root);
      }
      return null;
    },
  };
}

function patchCreateNodeIterator(targetWindow: Window): void {
  // mirror dompurify's factory: it caches createNodeIterator from the template
  // contents owner document when the platform supports <template>
  const template = targetWindow.document.createElement("template");
  const doc =
    template.content?.ownerDocument ?? (targetWindow.document as Document);
  doc.createNodeIterator =
    createRobustNodeIterator as Document["createNodeIterator"];
}

patchCreateNodeIterator(window);

// dompurify v3 factory pattern: bind to our happy-dom window. Markdown rendered
// for the host chrome passes through DOMPurify, always (invariant 6,
// docs/security.md "Content rules").
const purifier = createDOMPurify(
  window as unknown as Parameters<typeof createDOMPurify>[0],
);

// script removal is DOMPurify default; the rest are the board-content forbid
// list (docs/plan.md "one document model").
const SANITIZE_CONFIG: Config = {
  FORBID_TAGS: ["script", "iframe", "object", "embed", "noscript"],
};

const MATH_RE = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const CODE_HIGHLIGHT_THEME = "github-light";

export interface RenderedDocument {
  html: string;
  anchors: ExtractedAnchor[];
}

export async function renderMarkdownDocument(
  md: string,
): Promise<RenderedDocument> {
  const fragment = await marked.parse(md);
  const sanitized = purifier.sanitize(fragment, SANITIZE_CONFIG);
  const doc = new window.DOMParser().parseFromString(sanitized, "text/html");
  const body = doc.body as unknown as Element;
  convertMermaidBlocks(doc, body);
  renderMath(doc, body);
  await highlightCodeBlocks(doc, body);
  const anchors = injectAnchors(body);
  return { html: wrapDocument(body.innerHTML), anchors };
}

// HTML-format documents are stored verbatim (the sandbox isolates them —
// docs/plan.md "one document model"); anchors come from opt-in data-ba markers.
export function extractHtmlAnchors(html: string): ExtractedAnchor[] {
  const doc = new window.DOMParser().parseFromString(html, "text/html");
  const body = doc.body as unknown as Element;
  const anchors: ExtractedAnchor[] = [];
  for (const el of [...body.querySelectorAll("[data-ba]")]) {
    anchors.push({
      id: el.getAttribute("data-ba") ?? "",
      kind: "block",
      label: el.getAttribute("data-ba-label") || undefined,
    });
  }
  return anchors;
}

function parseFragment(doc: Document, html: string): Element {
  const holder = doc.createElement("div");
  holder.innerHTML = html;
  return holder;
}

// Mermaid renders client-side in the web UI later; here we only swap the
// fenced block for the pre.mermaid source container.
function convertMermaidBlocks(doc: Document, body: Element): void {
  for (const code of [...body.querySelectorAll("pre > code")]) {
    if (!code.classList.contains("language-mermaid")) {
      continue;
    }
    const pre = code.parentElement;
    if (pre === null) {
      continue;
    }
    const mermaidPre = doc.createElement("pre");
    mermaidPre.setAttribute("class", "mermaid");
    mermaidPre.textContent = code.textContent ?? "";
    pre.replaceWith(mermaidPre);
  }
}

// $ and $$ math only in prose text nodes — never inside code/pre (literal
// source) or already-rendered katex output; style/script literals with $ are
// likewise not math.
function collectMathTextNodes(root: Element): Text[] {
  const skipTags = new Set(["CODE", "PRE", "SCRIPT", "STYLE"]);
  const out: Text[] = [];
  const walk = (node: Node): void => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        out.push(child as Text);
        continue;
      }
      if (child.nodeType !== 1) {
        continue;
      }
      const el = child as Element;
      if (
        skipTags.has(el.tagName) ||
        el.classList.contains("katex") ||
        el.classList.contains("katex-display")
      ) {
        continue;
      }
      walk(el);
    }
  };
  walk(root);
  return out;
}

function renderMath(doc: Document, body: Element): void {
  for (const textNode of collectMathTextNodes(body)) {
    const text = textNode.data;
    const matches = [...text.matchAll(MATH_RE)];
    if (matches.length === 0) {
      continue;
    }
    const parent = textNode.parentNode;
    if (parent === null) {
      continue;
    }
    let last = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      const before = text.slice(last, index);
      if (before.length > 0) {
        parent.insertBefore(doc.createTextNode(before), textNode);
      }
      const display = match[1] !== undefined;
      const tex = (display ? match[1] : match[2]) ?? "";
      let rendered: string | null = null;
      try {
        rendered = katex.renderToString(tex, {
          throwOnError: false,
          displayMode: display,
        });
      } catch {
        rendered = null;
      }
      if (rendered === null) {
        // leave the raw text in place when katex refuses the input
        parent.insertBefore(doc.createTextNode(match[0]), textNode);
      } else {
        const holder = parseFragment(doc, rendered);
        while (holder.firstChild !== null) {
          parent.insertBefore(holder.firstChild, textNode);
        }
      }
      last = index + match[0].length;
    }
    const tail = text.slice(last);
    if (tail.length > 0) {
      parent.insertBefore(doc.createTextNode(tail), textNode);
    }
    parent.removeChild(textNode);
  }
}

async function highlightCodeBlocks(
  doc: Document,
  body: Element,
): Promise<void> {
  for (const code of [...body.querySelectorAll("pre > code")]) {
    const lang = /language-(\S+)/.exec(code.className)?.[1];
    if (lang === undefined) {
      continue;
    }
    const pre = code.parentElement;
    if (pre === null) {
      continue;
    }
    let highlighted: string;
    try {
      highlighted = await codeToHtml(code.textContent ?? "", {
        lang,
        theme: CODE_HIGHLIGHT_THEME,
      });
    } catch {
      // unknown language: keep the plain pre/code block
      continue;
    }
    const holder = parseFragment(doc, highlighted);
    pre.replaceWith(...holder.childNodes);
  }
}

// data-ba scheme: b<i> for each top-level element (1-based, elements only);
// table rows get b<i>r<j> (1-based across the whole table, header included).
// Deterministic: same input, same ids.
function injectAnchors(body: Element): ExtractedAnchor[] {
  const anchors: ExtractedAnchor[] = [];
  let i = 0;
  for (const child of [...body.childNodes]) {
    if (child.nodeType !== 1) {
      continue;
    }
    const el = child as Element;
    i++;
    const id = `b${i}`;
    el.setAttribute("data-ba", id);
    if (el.tagName === "TABLE") {
      anchors.push({ id, kind: "block" });
      let j = 0;
      for (const row of [...el.querySelectorAll("tr")]) {
        j++;
        const rowId = `${id}r${j}`;
        row.setAttribute("data-ba", rowId);
        anchors.push({ id: rowId, kind: "row" });
      }
    } else if (HEADING_TAGS.has(el.tagName)) {
      anchors.push({ id, kind: "heading", label: el.textContent ?? undefined });
    } else {
      anchors.push({ id, kind: "block" });
    }
  }
  return anchors;
}

function wrapDocument(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${bodyHtml}</body></html>`;
}
