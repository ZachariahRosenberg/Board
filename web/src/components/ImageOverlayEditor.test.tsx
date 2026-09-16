import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ImageOverlay } from "../../../server/src/domain.ts";
import { installDom } from "../test-dom.ts";
import { ImageOverlayEditor } from "./ImageOverlayEditor.tsx";

installDom();

// Editor tests drive plain DOM events against a stubbed image box: the stage
// hugs the img, so its rect IS the displayed image box the coordinates are
// normalized against. Client points below map (210,220) → (0.25,0.5) etc.
const STAGE_RECT = { left: 10, top: 20, width: 800, height: 400 };

function mouse(type: string, clientX: number, clientY: number): Event {
  return new window.MouseEvent(type, { bubbles: true, clientX, clientY });
}

const roots: Root[] = [];

function render(element: React.ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(element);
  });
  return container;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
});

function openEditor(done: (overlay: ImageOverlay) => void, cancel: () => void) {
  const container = render(
    <ImageOverlayEditor assetId="assetImg01" onDone={done} onCancel={cancel} />,
  );
  const stage = container.querySelector(".overlay-editor-stage") as HTMLElement;
  stage.getBoundingClientRect = () => STAGE_RECT as DOMRect;
  act(() => {
    window.dispatchEvent(new window.Event("resize"));
  });
  return container;
}

function clickButton(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (button === null || button === undefined) {
    throw new Error(`no "${label}" button`);
  }
  act(() => {
    (button as HTMLElement).click();
  });
}

function canvasOf(container: HTMLElement): HTMLElement {
  return container.querySelector(".overlay-editor-canvas") as HTMLElement;
}

// One act per pointer event: React batches state within a single act, so a
// handler would read the pre-event closure (a mouseup would never see the
// draft the mousedown just queued).
function dragArrow(
  container: HTMLElement,
  from: [number, number],
  to: [number, number],
): void {
  const canvas = canvasOf(container);
  act(() => {
    canvas.dispatchEvent(mouse("mousedown", from[0], from[1]));
  });
  if (from[0] !== to[0] || from[1] !== to[1]) {
    act(() => {
      canvas.dispatchEvent(mouse("mousemove", to[0], to[1]));
    });
  }
  act(() => {
    canvas.dispatchEvent(mouse("mouseup", to[0], to[1]));
  });
}

describe("ImageOverlayEditor", () => {
  test("arrow tool: press-drag-release produces the plan schema in normalized coords", () => {
    const done: ImageOverlay[] = [];
    const container = openEditor(
      (overlay) => {
        done.push(overlay);
      },
      () => {},
    );
    dragArrow(container, [210, 220], [610, 220]); // (0.25,0.5) → (0.75,0.5)
    clickButton(container, "done");
    expect(done[0]).toEqual({
      arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
      boxes: [],
    });
  });

  test("arrow tool: a click without drag commits nothing", () => {
    const done: ImageOverlay[] = [];
    const container = openEditor(
      (overlay) => {
        done.push(overlay);
      },
      () => {},
    );
    dragArrow(container, [210, 220], [210, 220]); // no movement — no arrow
    clickButton(container, "done");
    expect(done[0]).toEqual({ arrows: [], boxes: [] });
  });

  test("text tool: click places a label; Enter commits its position and text", () => {
    const done: ImageOverlay[] = [];
    const container = openEditor(
      (overlay) => {
        done.push(overlay);
      },
      () => {},
    );
    clickButton(container, "text");
    act(() => {
      canvasOf(container).dispatchEvent(mouse("click", 410, 60)); // (0.5, 0.1)
    });
    const input = container.querySelector(
      ".overlay-editor-input",
    ) as HTMLInputElement;
    expect(input).not.toBe(null);
    // positioned at the click, by percentage of the displayed box
    expect(input.style.left).toBe("50%");
    expect(input.style.top).toBe("10%");
    input.value = "this label overflows";
    act(() => {
      input.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(container.querySelector(".overlay-editor-input")).toBe(null);
    clickButton(container, "done");
    expect(done[0]).toEqual({
      arrows: [],
      boxes: [{ x: 0.5, y: 0.1, text: "this label overflows" }],
    });
  });

  test("empty label entry discards the box", () => {
    const done: ImageOverlay[] = [];
    const container = openEditor(
      (overlay) => {
        done.push(overlay);
      },
      () => {},
    );
    clickButton(container, "text");
    act(() => {
      canvasOf(container).dispatchEvent(mouse("click", 410, 60));
    });
    const input = container.querySelector(
      ".overlay-editor-input",
    ) as HTMLInputElement;
    input.value = "   ";
    act(() => {
      input.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    clickButton(container, "done");
    expect(done[0]).toEqual({ arrows: [], boxes: [] });
  });

  test("undo pops the last added item", () => {
    const done: ImageOverlay[] = [];
    const container = openEditor(
      (overlay) => {
        done.push(overlay);
      },
      () => {},
    );
    dragArrow(container, [210, 220], [610, 220]); // arrow one
    dragArrow(container, [210, 120], [210, 220]); // arrow two
    clickButton(container, "undo");
    clickButton(container, "done");
    expect(done[0]).toEqual({
      arrows: [{ x1: 0.25, y1: 0.5, x2: 0.75, y2: 0.5 }],
      boxes: [],
    });
  });

  test("undo with an open label entry dismisses the entry first", () => {
    const done: ImageOverlay[] = [];
    const container = openEditor(
      (overlay) => {
        done.push(overlay);
      },
      () => {},
    );
    clickButton(container, "text");
    act(() => {
      canvasOf(container).dispatchEvent(mouse("click", 410, 60));
    });
    expect(container.querySelector(".overlay-editor-input")).not.toBe(null);
    clickButton(container, "undo");
    expect(container.querySelector(".overlay-editor-input")).toBe(null);
    clickButton(container, "done");
    expect(done[0]).toEqual({ arrows: [], boxes: [] });
  });

  test("cancel discards — onCancel runs, onDone never does", () => {
    let doneCount = 0;
    let cancelCount = 0;
    const container = openEditor(
      () => {
        doneCount += 1;
      },
      () => {
        cancelCount += 1;
      },
    );
    dragArrow(container, [210, 220], [610, 220]);
    clickButton(container, "cancel");
    expect(doneCount).toBe(0);
    expect(cancelCount).toBe(1);
  });
  test("clamps drags past the image edges into [0,1]", () => {
    const done: ImageOverlay[] = [];
    const container = openEditor(
      (overlay) => {
        done.push(overlay);
      },
      () => {},
    );
    dragArrow(container, [400, 200], [5000, -100]);
    clickButton(container, "done");
    expect(done[0]).toEqual({
      arrows: [{ x1: 0.4875, y1: 0.45, x2: 1, y2: 0 }],
      boxes: [],
    });
  });
});
