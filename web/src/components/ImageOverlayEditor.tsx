// The hand-rolled overlay editor (docs/plan.md "Image annotation" — minimal
// editor, no excalidraw dependency): arrow = press-drag-release; textbox = the
// plan's positioned label, click to place + inline entry. All coordinates are
// captured normalized to the displayed image box (web/src/image.ts) so a
// stored overlay scales with any layout.
import { useEffect, useRef, useState } from "react";
import type { ImageOverlay } from "../../../server/src/domain.ts";
import { normalizePoint } from "../image.ts";
import { ImageOverlaySvg, useMeasuredSize } from "./ImageOverlaySvg.tsx";

type Tool = "arrow" | "text";
type Draft = { x1: number; y1: number; x2: number; y2: number };

const EMPTY_OVERLAY: ImageOverlay = { arrows: [], boxes: [] };

export function ImageOverlayEditor({
  assetId,
  onDone,
  onCancel,
}: {
  assetId: string;
  onDone(overlay: ImageOverlay): void;
  onCancel(): void;
}) {
  const [overlay, setOverlay] = useState<ImageOverlay>(EMPTY_OVERLAY);
  const [tool, setTool] = useState<Tool>("arrow");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pendingBox, setPendingBox] = useState<{ x: number; y: number } | null>(
    null,
  );
  // the label text is read from the DOM at commit — an uncontrolled input
  // keeps this editor testable with plain dispatched events (React's
  // input→onChange mapping is module-init-detected and unreliable to
  // synthesize under happy-dom) and avoids a state sync per keystroke
  const inputRef = useRef<HTMLInputElement>(null);
  // undo pops the array last added to; when that array is empty again the
  // other one drains next — insertion order across the two arrays stays
  // reasonable without tracking a merged list (the schema needs two arrays)
  const lastAddedRef = useRef<"arrows" | "boxes" | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const size = useMeasuredSize(stageRef);

  // focus follows the label entry (noAutofocus: focus is an effect decision
  // here — the modal opens first, the entry appears on click)
  useEffect(() => {
    if (pendingBox !== null) {
      inputRef.current?.focus();
    }
  }, [pendingBox]);

  // the stage hugs the img (fit-content), so its box IS the displayed image
  // box — both measurement and pointer normalization read it
  const pointFrom = (event: React.MouseEvent): { x: number; y: number } => {
    const stage = stageRef.current;
    const rect =
      stage === null
        ? { left: 0, top: 0, width: 0, height: 0 }
        : stage.getBoundingClientRect();
    return normalizePoint(rect, event.clientX, event.clientY);
  };

  const onMouseDown = (event: React.MouseEvent): void => {
    if (tool !== "arrow" || pendingBox !== null) {
      return;
    }
    event.preventDefault(); // keep the img's native drag from stealing the gesture
    const { x, y } = pointFrom(event);
    setDraft({ x1: x, y1: y, x2: x, y2: y });
  };

  const onMouseMove = (event: React.MouseEvent): void => {
    if (draft === null) {
      return;
    }
    const { x, y } = pointFrom(event);
    setDraft({ ...draft, x2: x, y2: y });
  };

  const onMouseUp = (event: React.MouseEvent): void => {
    if (draft === null) {
      return;
    }
    const { x, y } = pointFrom(event);
    const moved = x !== draft.x1 || y !== draft.y1;
    setDraft(null);
    if (!moved) {
      return; // a click is not an arrow — degenerate arrows carry no geometry
    }
    setOverlay((current) => ({
      ...current,
      arrows: [...current.arrows, { x1: draft.x1, y1: draft.y1, x2: x, y2: y }],
    }));
    lastAddedRef.current = "arrows";
  };

  const placeBox = (event: React.MouseEvent): void => {
    if (tool !== "text" || pendingBox !== null || draft !== null) {
      return;
    }
    setPendingBox(pointFrom(event));
    if (inputRef.current !== null) {
      inputRef.current.value = "";
    }
  };

  const commitBox = (): void => {
    if (pendingBox === null) {
      return;
    }
    const text = (inputRef.current?.value ?? "").trim();
    setPendingBox(null);
    if (text.length === 0) {
      return; // empty entry discards the label
    }
    setOverlay((current) => ({
      ...current,
      boxes: [...current.boxes, { x: pendingBox.x, y: pendingBox.y, text }],
    }));
    lastAddedRef.current = "boxes";
  };

  const undo = (): void => {
    if (pendingBox !== null) {
      setPendingBox(null);
      return;
    }
    const popFrom = lastAddedRef.current;
    if (popFrom === "arrows" && overlay.arrows.length > 0) {
      setOverlay({ ...overlay, arrows: overlay.arrows.slice(0, -1) });
      return;
    }
    if (overlay.boxes.length > 0) {
      setOverlay({ ...overlay, boxes: overlay.boxes.slice(0, -1) });
      lastAddedRef.current = "boxes";
    }
  };

  const display: ImageOverlay =
    draft === null
      ? overlay
      : { ...overlay, arrows: [...overlay.arrows, draft] };

  return (
    <div className="overlay-editor-backdrop">
      <div className="overlay-editor">
        <div className="overlay-editor-toolbar">
          <button
            type="button"
            className={`pill${tool === "arrow" ? " active" : ""}`}
            onClick={() => {
              setTool("arrow");
            }}
          >
            arrow
          </button>
          <button
            type="button"
            className={`pill${tool === "text" ? " active" : ""}`}
            onClick={() => {
              setTool("text");
            }}
          >
            text
          </button>
          <button
            type="button"
            className="pill"
            disabled={
              pendingBox === null &&
              overlay.arrows.length === 0 &&
              overlay.boxes.length === 0
            }
            onClick={undo}
          >
            undo
          </button>
          <span className="overlay-editor-hint">
            arrow: press-drag-release · text: click to place a label
          </span>
          <button
            type="button"
            className="pill"
            onClick={() => {
              onCancel();
            }}
          >
            cancel
          </button>
          <button
            type="button"
            className="pill active"
            onClick={() => {
              onDone(display);
            }}
          >
            done
          </button>
        </div>
        <div className="overlay-editor-stage" ref={stageRef}>
          {/* served unauthenticated like every board image (img cannot send
              headers) — same URL the rendered board uses for this asset */}
          <img src={`/assets/${assetId}`} alt="" draggable={false} />
          {/* a drawing canvas is pointer-driven by design: the arrow gesture
              has no keyboard equivalent (a11y lint) — every committed item is
              also undoable, and label text entry is a real input */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: drawing canvas — see above */}
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: click places labels; the input itself handles Enter/Escape */}
          <div
            className={`overlay-editor-canvas${tool === "text" ? " placing" : ""}`}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onClick={placeBox}
          >
            {size !== null && (
              <ImageOverlaySvg
                overlay={display}
                width={size.width}
                height={size.height}
              />
            )}
            {pendingBox !== null && (
              <input
                className="overlay-editor-input"
                ref={inputRef}
                // positioned by percentage — no measurement needed for entry
                style={{
                  left: `${pendingBox.x * 100}%`,
                  top: `${pendingBox.y * 100}%`,
                }}
                placeholder="label…"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitBox();
                  }
                  if (event.key === "Escape") {
                    setPendingBox(null);
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
