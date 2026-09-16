import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { Anchor } from "../../../server/src/domain.ts";
import { createComponentHarness, installDom } from "../test-dom.ts";
import { CommentSidebar } from "./CommentSidebar.tsx";
import {
  createdComments,
  getCommentsCalls,
  IMAGE_ANCHOR,
  installApiMock,
  replied,
  resolvedIds,
  TEXT_ANCHOR,
  uploadedAssets,
  uploadFailures,
} from "./test-api.ts";

installDom();
installApiMock();

const { render, cleanup } = createComponentHarness();
afterEach(cleanup);

// every test starts from the same default props (spread order: overrides win)
function sidebarProps() {
  return {
    boardId: "b1",
    boardStatus: "open" as const,
    versionN: 2,
    refreshKey: 0,
    pendingAnchor: null,
    onPendingAnchorConsumed: () => {},
    onCommentsChange: () => {},
    onImageHover: () => {},
    onOpenImage: () => {},
    onHighlight: () => {},
    onSwitchVersion: () => {},
  };
}

// React controlled-input helper: write via the prototype's native setter (not
// the element's, which React wraps with a value tracker), then drop the stale
// tracker so updateValueIfChanged sees the change when the input event lands.
function typeInto(field: Element, text: string): void {
  const proto =
    field instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(field, text);
  delete (field as unknown as { _valueTracker?: unknown })._valueTracker;
  field.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function dropEvent(files: File[]): Event {
  const event = new window.Event("drop", { bubbles: true }) as Event & {
    dataTransfer: { files: File[] };
  };
  event.dataTransfer = { files };
  return event;
}

describe("CommentSidebar", () => {
  test("renders threads with chips, authors, replies, and resolved state", async () => {
    getCommentsCalls.length = 0;
    const highlightCalls: Array<Anchor> = [];
    const container = render(
      <CommentSidebar
        {...sidebarProps()}
        onHighlight={(anchor) => {
          highlightCalls.push(anchor);
        }}
      />,
    );
    await act(async () => {});
    expect(getCommentsCalls).toEqual(["b1"]);
    expect(container.innerHTML).toContain(
      "The intro should mention the cache.",
    );
    expect(container.innerHTML).toContain("text b2:");
    expect(container.innerHTML).toContain("“beta”");
    expect(container.innerHTML).toContain("you");
    expect(container.innerHTML).toContain("agent-1");
    expect(container.innerHTML).toContain("Fixed in v2.");
    expect(container.innerHTML).toContain("✓ resolved");
    expect(container.innerHTML).toContain("2 unresolved / 3 threads");
    const chip = container.querySelector(
      "button.anchor-chip.clickable",
    ) as HTMLElement;
    await act(async () => {
      chip.click();
    });
    expect(highlightCalls.at(-1)).toEqual(TEXT_ANCHOR);
  });

  test("resolve click calls the API and refreshes", async () => {
    resolvedIds.length = 0;
    getCommentsCalls.length = 0;
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    const resolveButton = [
      ...container.querySelectorAll("button.linklike"),
    ].find((button) => button.textContent === "resolve") as HTMLElement;
    await act(async () => {
      resolveButton.click();
    });
    expect(resolvedIds).toEqual(["cm1"]);
    expect(getCommentsCalls).toHaveLength(2);
  });

  test("hide-resolved toggle folds resolved threads away and back", async () => {
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    expect(container.innerHTML).toContain("✓ resolved");
    const hide = [...container.querySelectorAll("button.pill")].find(
      (button) => button.textContent === "hide resolved",
    ) as HTMLElement;
    await act(async () => {
      hide.click();
    });
    expect(container.innerHTML).not.toContain("✓ resolved");
    // the header counts stay honest while folded
    expect(container.innerHTML).toContain("2 unresolved / 3 threads");
    const show = [...container.querySelectorAll("button.pill")].find(
      (button) => button.textContent === "show resolved",
    ) as HTMLElement;
    await act(async () => {
      show.click();
    });
    expect(container.innerHTML).toContain("✓ resolved");
  });

  test("no section picker anywhere (removed by D18 — host affordances cover every board)", async () => {
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    expect(container.innerHTML).not.toContain("+ section");
    expect(container.querySelectorAll("button.section-option")).toHaveLength(0);
  });

  test("pendingAnchor opens the composer with the anchor chip and quote", async () => {
    createdComments.length = 0;
    const container = render(
      <CommentSidebar {...sidebarProps()} pendingAnchor={TEXT_ANCHOR} />,
    );
    await act(async () => {});
    expect(container.innerHTML).toContain("on text b2:");
    expect(container.innerHTML).toContain("“beta”");
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBe(null);
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLButtonElement;
    // empty body keeps the composer guarded
    expect(submit.disabled).toBe(true);
    expect(createdComments).toHaveLength(0);
  });

  test("reply button opens a reply composer; an empty submit is a no-op", async () => {
    replied.length = 0;
    createdComments.length = 0;
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    const replyButton = [...container.querySelectorAll("button.linklike")].find(
      (button) => button.textContent === "reply",
    ) as HTMLElement;
    await act(async () => {
      replyButton.click();
    });
    expect(container.innerHTML).toContain("reply to you");
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => {
      submit.click();
    });
    expect(replied).toHaveLength(0);
    expect(createdComments).toHaveLength(0);
  });

  test("ended boards are read-only", async () => {
    const container = render(
      <CommentSidebar {...sidebarProps()} boardStatus="ended" />,
    );
    await act(async () => {});
    expect(container.innerHTML).toContain("read-only");
    expect(container.innerHTML).not.toContain("+ board");
    expect(
      [...container.querySelectorAll("button.linklike")].map(
        (button) => button.textContent,
      ),
    ).toEqual([]);
  });

  test("a thread pinned to another version gets an on v<n> jump that switches versions", async () => {
    const switchCalls: number[] = [];
    const container = render(
      <CommentSidebar
        {...sidebarProps()}
        versionN={1}
        onSwitchVersion={(n: number) => {
          switchCalls.push(n);
        }}
      />,
    );
    await act(async () => {});
    const jump = [...container.querySelectorAll("button.linklike")].find(
      (button) => button.textContent === "on v2",
    );
    expect(jump).not.toBe(undefined);
    await act(async () => {
      (jump as HTMLElement).click();
    });
    expect(switchCalls).toEqual([2]);
  });

  test("no jump affordance when the thread is pinned to the viewed version", async () => {
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    expect(
      [...container.querySelectorAll("button.linklike")].filter((button) =>
        (button.textContent ?? "").startsWith("on v"),
      ),
    ).toEqual([]);
  });
});

describe("CommentSidebar image upload", () => {
  const pngFile = new window.File(
    [new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    "shot.png",
    { type: "image/png" },
  );

  test("dropping an image uploads it to /api/assets with the board id and opens the editor", async () => {
    uploadedAssets.length = 0;
    uploadFailures.error = null;
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    const sidebar = container.querySelector("aside.comment-sidebar");
    expect(sidebar).not.toBe(null);
    await act(async () => {
      (sidebar as HTMLElement).dispatchEvent(dropEvent([pngFile]));
    });
    expect(uploadedAssets).toEqual([
      { boardId: "b1", file: expect.anything() },
    ]);
    const editor = container.querySelector(".overlay-editor");
    expect(editor).not.toBe(null);
    expect(
      container.querySelector(".overlay-editor-stage img")?.getAttribute("src"),
    ).toBe("/assets/uploadedAsset");
  });

  test("editor done → composer holds the pending image anchor; posting sends it", async () => {
    uploadedAssets.length = 0;
    createdComments.length = 0;
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    await act(async () => {
      (
        container.querySelector("aside.comment-sidebar") as HTMLElement
      ).dispatchEvent(dropEvent([pngFile]));
    });
    const done = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "done",
    ) as HTMLElement;
    await act(async () => {
      done.click();
    });
    expect(container.innerHTML).toContain("on image uploadedAsset");
    const textarea = container.querySelector("textarea") as HTMLElement;
    await act(async () => {
      typeInto(textarea, "look at the arrow");
    });
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLElement;
    await act(async () => {
      submit.click();
    });
    expect(createdComments).toHaveLength(1);
    expect(createdComments[0].boardId).toBe("b1");
    expect(createdComments[0].input.anchor).toEqual({
      type: "image",
      asset_id: "uploadedAsset",
      overlay: { arrows: [], boxes: [] },
    });
    expect(createdComments[0].input.body).toBe("look at the arrow");
  });

  test("an overlay-only annotation posts with an empty body (the overlay is the payload)", async () => {
    uploadedAssets.length = 0;
    createdComments.length = 0;
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    await act(async () => {
      (
        container.querySelector("aside.comment-sidebar") as HTMLElement
      ).dispatchEvent(dropEvent([pngFile]));
    });
    // draw one arrow, commit no text
    const stage = container.querySelector(
      ".overlay-editor-stage",
    ) as HTMLElement;
    stage.getBoundingClientRect = () =>
      ({ left: 10, top: 20, width: 800, height: 400 }) as DOMRect;
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
    const canvas = container.querySelector(
      ".overlay-editor-canvas",
    ) as HTMLElement;
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mousedown", {
          bubbles: true,
          clientX: 210,
          clientY: 220,
        }),
      );
    });
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mousemove", {
          bubbles: true,
          clientX: 610,
          clientY: 220,
        }),
      );
    });
    await act(async () => {
      canvas.dispatchEvent(
        new window.MouseEvent("mouseup", {
          bubbles: true,
          clientX: 610,
          clientY: 220,
        }),
      );
    });
    const done = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "done",
    ) as HTMLElement;
    await act(async () => {
      done.click();
    });
    // empty body does NOT guard the composer anymore — the overlay enables it
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.click();
    });
    expect(createdComments).toHaveLength(1);
    expect(createdComments[0].input.body).toBe("");
    expect(createdComments[0].input.anchor).toEqual({
      type: "image",
      asset_id: "uploadedAsset",
      overlay: {
        arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
        boxes: [],
      },
    });
  });

  test("editor done with an EMPTY overlay still requires body text", async () => {
    uploadedAssets.length = 0;
    createdComments.length = 0;
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    await act(async () => {
      (
        container.querySelector("aside.comment-sidebar") as HTMLElement
      ).dispatchEvent(dropEvent([pngFile]));
    });
    const done = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "done",
    ) as HTMLElement;
    await act(async () => {
      done.click();
    });
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Comment",
    ) as HTMLButtonElement;
    // no overlay items + no text → still guarded, Enter included
    expect(submit.disabled).toBe(true);
    const textarea = container.querySelector("textarea") as HTMLElement;
    await act(async () => {
      textarea.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
    });
    await act(async () => {});
    expect(createdComments).toHaveLength(0);
  });

  test("editor cancel discards — no composer, no comment", async () => {
    uploadedAssets.length = 0;
    createdComments.length = 0;
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    await act(async () => {
      (
        container.querySelector("aside.comment-sidebar") as HTMLElement
      ).dispatchEvent(dropEvent([pngFile]));
    });
    const cancel = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "cancel",
    ) as HTMLElement;
    await act(async () => {
      cancel.click();
    });
    expect(container.querySelector(".overlay-editor")).toBe(null);
    expect(container.querySelector("div.composer")).toBe(null);
    expect(createdComments).toHaveLength(0);
  });

  test("upload errors surface in the composer area", async () => {
    uploadedAssets.length = 0;
    uploadFailures.error = new Error(
      'asset type not allowed: "image/x-icon" is not on the image allowlist',
    );
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    await act(async () => {
      (
        container.querySelector("aside.comment-sidebar") as HTMLElement
      ).dispatchEvent(dropEvent([pngFile]));
    });
    expect(container.innerHTML).toContain("asset type not allowed");
    expect(container.querySelector(".overlay-editor")).toBe(null);
    // a failed upload opens no editor and never stages a local blob: preview
    // (the host CSP is img-src 'self' data: — blob: could never render)
    expect(container.innerHTML).not.toContain("blob:");
    expect(container.querySelector(".overlay-editor-stage img")).toBe(null);
    uploadFailures.error = null;
  });

  test("image-anchored thread renders a thumbnail from the served asset URL", async () => {
    // dogfooded: the thread chip was a bare text label — nothing confirmed
    // the attachment existed. The thumb rides the same /assets/<id> URL the
    // board uses (CSP img-src 'self'), on the thread root's image anchor.
    const container = render(<CommentSidebar {...sidebarProps()} />);
    await act(async () => {});
    const thumbs = [
      ...container.querySelectorAll("img.comment-image-thumb"),
    ] as HTMLImageElement[];
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0].getAttribute("src")).toBe("/assets/assetImg01");
    expect(thumbs[0].getAttribute("src")).not.toContain("blob:");
    // it belongs to the image-anchored thread, not the text ones
    expect(thumbs[0].closest(".thread")?.textContent).toContain(
      "The arrow points at the regression.",
    );
  });

  test("thread thumbnails render the comment's own overlay and click through to the lightbox", async () => {
    // dogfooded ask [163]: "I don't see the annotations in the thumbnail" —
    // the shared overlay renderer scales the comment's overlay onto the thumb
    const openCalls: string[] = [];
    const container = render(
      <CommentSidebar
        {...sidebarProps()}
        onOpenImage={(assetId) => {
          openCalls.push(assetId);
        }}
      />,
    );
    await act(async () => {});
    const thumb = container.querySelector(
      "button.comment-thumb",
    ) as HTMLElement;
    expect(thumb).not.toBe(null);
    const layer = thumb.querySelector(".image-overlay-layer") as HTMLElement;
    expect(layer).not.toBe(null);
    // measure at the thumb's box (160px max width) → svg renders in that space
    layer.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 160, height: 120 }) as DOMRect;
    await act(async () => {
      window.dispatchEvent(new window.Event("resize"));
    });
    const svg = thumb.querySelector("svg.image-overlay-svg");
    expect(svg?.getAttribute("width")).toBe("160");
    expect(svg?.getAttribute("height")).toBe("120");
    // arrow (0.25, 0.5) → (0.75, 0.5) scaled onto the 160×120 thumb
    const line = svg?.querySelector("line");
    expect(line?.getAttribute("x1")).toBe("40");
    expect(line?.getAttribute("y1")).toBe("60");
    expect(line?.getAttribute("x2")).toBe("120");
    expect(line?.getAttribute("y2")).toBe("60");
    expect(svg?.querySelector("text")?.textContent).toBe("watch this");
    // clicking reports the asset up to the board view (the lightbox lives
    // there); the chip's hover-preview and highlight behaviors are untouched
    await act(async () => {
      thumb.click();
    });
    expect(openCalls).toEqual(["assetImg01"]);
  });

  test("composer with a pending image anchor previews the held image", async () => {
    const container = render(
      <CommentSidebar {...sidebarProps()} pendingAnchor={IMAGE_ANCHOR} />,
    );
    await act(async () => {});
    const composer = container.querySelector("div.composer");
    expect(composer).not.toBe(null);
    const thumb = composer?.querySelector(
      "img.comment-image-thumb",
    ) as HTMLImageElement;
    expect(thumb).not.toBe(null);
    expect(thumb.getAttribute("src")).toBe("/assets/assetImg01");
    // the annotate affordance stays next to the preview
    expect(composer?.innerHTML).toContain("annotate");
  });

  test("an overlay-only thread (empty body) shows the anchor affordance alone", async () => {
    const container = render(
      <CommentSidebar {...sidebarProps()} boardId="b-empty" />,
    );
    await act(async () => {});
    const thread = container.querySelector("div.thread") as HTMLElement;
    expect(thread).not.toBe(null);
    // the image affordances render — thumbnail + chip
    expect(thread.querySelector("img.comment-image-thumb")).not.toBe(null);
    expect(thread.querySelector("button.anchor-chip")).not.toBe(null);
    // no empty body block
    expect(thread.querySelector(".thread-body")).toBe(null);
  });
});
