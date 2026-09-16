// Hand-rolled overlay renderer (no dependency — a plan requirement for the
// editor): draws an ImageOverlay as SVG in the PIXEL space of the displayed
// image box, shared by the board's display layer and the editor's canvas.
import { useEffect, useRef, useState } from "react";
import type { ImageOverlay } from "../../../server/src/domain.ts";
import { arrowHeadPoints, scaleOverlay } from "../image.ts";

// Measures a stage element (mount + window resize + any descendant img load —
// capture phase, since load does not bubble). A zero box stays null so the
// svg simply waits for the first real measurement (unloaded image, happy-dom).
export function useMeasuredSize(
  ref: React.RefObject<HTMLElement | null>,
): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  useEffect(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    measure();
    el.addEventListener("load", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      el.removeEventListener("load", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [ref]);
  return size;
}

export function ImageOverlaySvg({
  overlay,
  width,
  height,
}: {
  overlay: ImageOverlay;
  width: number;
  height: number;
}) {
  const scaled = scaleOverlay(overlay, width, height);
  return (
    <svg
      className="image-overlay-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
    >
      <title>annotation overlay</title>
      {scaled.arrows.map((arrow, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: overlay items are immutable entries of one stored list — they never reorder
        <g key={i}>
          <line
            x1={arrow.x1}
            y1={arrow.y1}
            x2={arrow.x2}
            y2={arrow.y2}
            stroke="var(--error)"
            strokeWidth={2.5}
          />
          <polygon
            points={arrowHeadPoints(arrow.x1, arrow.y1, arrow.x2, arrow.y2, 13)}
            fill="var(--error)"
          />
        </g>
      ))}
      {scaled.boxes.map((box, i) => (
        // positioned label, not prose — halo stroke keeps it readable over the image
        <text
          // biome-ignore lint/suspicious/noArrayIndexKey: see arrows above
          key={i}
          className="image-overlay-text"
          x={box.x}
          y={box.y}
        >
          {box.text}
        </text>
      ))}
    </svg>
  );
}

// Display-only layer for the board view: absolutely positioned over a board
// image (its wrapped parent), pointer events pass through.
export function ImageOverlayLayer({ overlay }: { overlay: ImageOverlay }) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useMeasuredSize(ref);
  return (
    <div ref={ref} className="image-overlay-layer">
      {size !== null && (
        <ImageOverlaySvg
          overlay={overlay}
          width={size.width}
          height={size.height}
        />
      )}
    </div>
  );
}
