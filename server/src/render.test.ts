import { describe, expect, test } from "bun:test";
import type { Element } from "happy-dom";
import { Window } from "happy-dom";
import { extractHtmlAnchors, renderMarkdownDocument } from "./render.ts";

// Code fences in plain double-quoted strings — no escaping needed there.
const DOC = [
  "# Board Title",
  "",
  "Intro paragraph with $x^2$ inline math.",
  "",
  "| Col A | Col B |",
  "| --- | --- |",
  "| a1 | b1 |",
  "| a2 | b2 |",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
  "```mermaid",
  "graph TD; A-->B;",
  "```",
  "",
].join("\n");

// Frozen expected output — same input must always produce this exact document.
const GOLDEN = `<!doctype html><html><head><meta charset="utf-8"></head><body><h1 data-ba="b1">Board Title</h1>
<p data-ba="b2">Intro paragraph with <span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mi>x</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="katex-base"><span class="katex-strut" style="height:0.8141em;"></span><span class="mord"><span class="mord mathnormal">x</span><span class="msupsub"><span class="vlist-t"><span class="vlist-r"><span class="vlist" style="height:0.8141em;"><span style="top:-3.063em;margin-right:0.05em;"><span class="pstrut" style="height:2.7em;"></span><span class="katex-sizing reset-size6 size3 mtight"><span class="mord mtight">2</span></span></span></span></span></span></span></span></span></span></span> inline math.</p>
<table data-ba="b3">
<thead>
<tr data-ba="b3r1">
<th>Col A</th>
<th>Col B</th>
</tr>
</thead>
<tbody><tr data-ba="b3r2">
<td>a1</td>
<td>b1</td>
</tr>
<tr data-ba="b3r3">
<td>a2</td>
<td>b2</td>
</tr>
</tbody></table>
<pre class="shiki github-light" style="background-color:#fff;color:#24292e" tabindex="0" data-ba="b4"><code><span class="line"><span style="color:#D73A49">const</span><span style="color:#005CC5"> x</span><span style="color:#D73A49">:</span><span style="color:#005CC5"> number</span><span style="color:#D73A49"> =</span><span style="color:#005CC5"> 1</span><span style="color:#24292E">;</span></span>
<span class="line"></span></code></pre>
<pre class="mermaid" data-ba="b5">graph TD; A--&gt;B;
</pre>
</body></html>`;

const window = new Window();

function parseBody(html: string): Element {
  const doc = new window.DOMParser().parseFromString(html, "text/html");
  return doc.body as unknown as Element;
}

describe("renderMarkdownDocument", () => {
  test("produces the exact golden document", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    expect(html).toBe(GOLDEN);
  });

  test("is deterministic across runs", async () => {
    const first = await renderMarkdownDocument(DOC);
    const second = await renderMarkdownDocument(DOC);
    expect(second.html).toBe(first.html);
    expect(second.anchors).toEqual(first.anchors);
  });

  test("wraps the body in a full html document with charset meta", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    expect(html.startsWith("<!doctype html><html><head>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("</head><body>");
    expect(html.endsWith("</body></html>")).toBe(true);
  });

  test("extracts the anchor set: heading, blocks, table + rows", async () => {
    const { anchors } = await renderMarkdownDocument(DOC);
    expect(anchors).toEqual([
      { id: "b1", kind: "heading", label: "Board Title" },
      { id: "b2", kind: "block" },
      { id: "b3", kind: "block" },
      { id: "b3r1", kind: "row" },
      { id: "b3r2", kind: "row" },
      { id: "b3r3", kind: "row" },
      { id: "b4", kind: "block" },
      { id: "b5", kind: "block" },
    ]);
  });

  test("every top-level element carries a data-ba id", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    const body = parseBody(html);
    const elements = [...body.children];
    expect(elements.length).toBe(5);
    for (const [index, el] of elements.entries()) {
      expect(el.getAttribute("data-ba")).toBe(`b${index + 1}`);
    }
  });

  test("table rows carry b3r<j> data-ba ids, header included", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    const table = parseBody(html).querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.getAttribute("data-ba")).toBe("b3");
    const rows = [...(table?.querySelectorAll("tr") ?? [])];
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      expect(row.getAttribute("data-ba")).toBe(`b3r${index + 1}`);
    }
  });

  test("inline math becomes katex markup", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    expect(html).toContain('class="katex');
    expect(html).not.toContain("$x^2$");
  });

  test("mermaid fences become pre.mermaid with the raw source", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    expect(html).toContain('class="mermaid"');
    expect(html).toContain("graph TD; A--&gt;B;");
    expect(html).not.toContain("language-mermaid");
  });

  test("ts fences are shiki-highlighted", async () => {
    const { html } = await renderMarkdownDocument(DOC);
    expect(html).toContain("shiki");
    expect(html).toContain("github-light");
  });

  test("script tags in markdown input are gone", async () => {
    const md = ["before", "", "<script>alert(1)</script>", "", "after"].join(
      "\n",
    );
    const { html } = await renderMarkdownDocument(md);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  test("iframe/object/embed/noscript are forbidden", async () => {
    const md = [
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x"></object>',
      '<embed src="x" />',
      "<noscript>no</noscript>",
      "text",
    ].join("\n");
    const { html } = await renderMarkdownDocument(md);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<embed");
    expect(html).not.toContain("<noscript");
    expect(html).toContain("text");
  });

  test("display math $$...$$ renders in display mode", async () => {
    const { html } = await renderMarkdownDocument("$$x = y$$");
    expect(html).toContain("katex-display");
    expect(html).not.toContain("$$x = y$$");
  });

  test("math inside code fences is left alone", async () => {
    const md = ["```ts", 'const s = "$x^2$";', "```"].join("\n");
    const { html } = await renderMarkdownDocument(md);
    expect(html).toContain("$x^2$");
    expect(html).not.toContain("katex");
  });

  test("invalid math does not throw and keeps the document", async () => {
    const { html } = await renderMarkdownDocument("costs $5 and $10 today");
    expect(html).toContain("costs");
    expect(html.endsWith("</body></html>")).toBe(true);
  });
});

describe("extractHtmlAnchors", () => {
  test("extracts data-ba markers with labels, in document order", () => {
    const html = [
      "<!doctype html><html><body>",
      '<div data-ba="s1" data-ba-label="Intro"><p data-ba="s1a">x</p></div>',
      '<section data-ba="s2">y</section>',
      "</body></html>",
    ].join("");
    const anchors = extractHtmlAnchors(html);
    expect(anchors).toEqual([
      { id: "s1", kind: "block", label: "Intro" },
      { id: "s1a", kind: "block" },
      { id: "s2", kind: "block" },
    ]);
  });

  test("empty label attribute is treated as no label", () => {
    const html = '<div data-ba="a" data-ba-label=""></div>';
    const anchors = extractHtmlAnchors(html);
    expect(anchors).toEqual([{ id: "a", kind: "block" }]);
  });

  test("html without markers yields no anchors", () => {
    expect(extractHtmlAnchors("<p>plain</p>")).toEqual([]);
  });
});
