// Pure geometry for image annotation overlays (docs/plan.md "Image
// annotation"): overlay coordinates are normalized to 0..1 of the DISPLAYED
// image box so a stored overlay scales with any layout. Components measure
// the image box and call these helpers — no DOM in here, so the math is
// testable without events.
import type { ImageOverlay } from "../../server/src/domain.ts";

export interface RectBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

// Client point → normalized overlay coordinates, clamped into the image box.
// A zero/absent box (unloaded image, happy-dom) would divide by zero and leak
// NaN past the clamps — map it to the origin, callers redraw on the next
// measurement anyway.
export function normalizePoint(
  box: RectBox,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  if (box.width <= 0 || box.height <= 0) {
    return { x: 0, y: 0 };
  }
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return {
    x: clamp((clientX - box.left) / box.width),
    y: clamp((clientY - box.top) / box.height),
  };
}

// Normalized overlay → pixel coordinates for an SVG sized to the image box.
export function scaleOverlay(
  overlay: ImageOverlay,
  width: number,
  height: number,
): ImageOverlay {
  return {
    arrows: overlay.arrows.map((arrow) => ({
      x1: arrow.x1 * width,
      y1: arrow.y1 * height,
      x2: arrow.x2 * width,
      y2: arrow.y2 * height,
    })),
    boxes: overlay.boxes.map((box) => ({
      x: box.x * width,
      y: box.y * height,
      text: box.text,
    })),
  };
}

// Arrowhead triangle at the arrow's tip (screen-space px), sized independently
// of the svg transform — the hand-rolled alternative to marker defs, whose
// markerUnits would need per-svg ids and scale with distorted viewboxes.
export function arrowHeadPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  size: number,
): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  const a = angle + Math.PI - spread;
  const b = angle + Math.PI + spread;
  return [
    [x2, y2],
    [x2 + size * Math.cos(a), y2 + size * Math.sin(a)],
    [x2 + size * Math.cos(b), y2 + size * Math.sin(b)],
  ]
    .map(([x, y]) => `${x},${y}`)
    .join(" ");
}

// Board images are exactly the imgs served from the asset route (markdown
// embeds are rewritten to /assets/<id> at publish; html boards reference the
// URL directly). The 10-base62-char shape check is what keeps the SPA's own
// hashed vite bundles (also under /assets/*) from ever matching.
const ASSET_SRC = /^\/assets\/([0-9A-Za-z]{10})(\?.*)?$/;

export function assetIdFromSrc(src: string): string | null {
  const match = ASSET_SRC.exec(src);
  return match === null ? null : match[1];
}
