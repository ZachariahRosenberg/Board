import type { Anchor, ImageAnchor, ImageOverlay } from "./domain.ts";
import { HttpError } from "./http.ts";

// Boundary validation (style guide): parse external input into typed values
// here, never with ad-hoc checks sprinkled through handlers.

function invalid(field: string, expected: string): HttpError {
  return new HttpError(400, "invalid_request", `${field} must be ${expected}`);
}

export function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw invalid(field, "a string");
  }
  return value;
}

export function asOptionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asString(value, field);
}

export function asInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalid(field, "an integer");
  }
  return value;
}

export function asEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  for (const candidate of allowed) {
    if (value === candidate) {
      return candidate;
    }
  }
  throw invalid(field, `one of: ${allowed.join(", ")}`);
}

export function asStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw invalid(field, "an array of strings");
  }
  return value;
}

// Query params and path params arrive as strings: absent (null) maps to
// undefined; anything else must be a decimal non-negative integer. The
// MAX_SAFE_INTEGER guard keeps absurd digit strings from becoming float seqs.
export function asNonNegativeIntString(
  raw: string | null,
  field: string,
): number | undefined {
  if (raw === null) {
    return undefined;
  }
  if (!/^\d+$/.test(raw) || Number(raw) > Number.MAX_SAFE_INTEGER) {
    throw invalid(field, "a non-negative integer");
  }
  return Number(raw);
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalid(field, "a finite number");
  }
  return value;
}

// Overlay shape (docs/plan.md "Image annotation"): arrows + positioned-label
// boxes. Type shapes only — coordinate ranges, caps, and asset existence are
// semantic checks in the comments store (same split as section ids).
function asImageOverlay(value: unknown, field: string): ImageOverlay {
  if (typeof value !== "object" || value === null) {
    throw invalid(field, "an overlay object");
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.arrows) || !Array.isArray(obj.boxes)) {
    throw invalid(`${field}.arrows/boxes`, "arrays");
  }
  return {
    arrows: obj.arrows.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) {
        throw invalid(`${field}.arrows[${i}]`, "an arrow object");
      }
      const arrow = entry as Record<string, unknown>;
      return {
        x1: asNumber(arrow.x1, `${field}.arrows[${i}].x1`),
        y1: asNumber(arrow.y1, `${field}.arrows[${i}].y1`),
        x2: asNumber(arrow.x2, `${field}.arrows[${i}].x2`),
        y2: asNumber(arrow.y2, `${field}.arrows[${i}].y2`),
      };
    }),
    boxes: obj.boxes.map((entry, i) => {
      if (typeof entry !== "object" || entry === null) {
        throw invalid(`${field}.boxes[${i}]`, "a box object");
      }
      const box = entry as Record<string, unknown>;
      return {
        x: asNumber(box.x, `${field}.boxes[${i}].x`),
        y: asNumber(box.y, `${field}.boxes[${i}].y`),
        text: asString(box.text, `${field}.boxes[${i}].text`),
      };
    }),
  };
}

// Anchor JSON from the wire, discriminated by `type` (docs/plan.md "Data model").
// Shape-level only — semantic validity (does the section exist? is the asset on
// this board? are overlay coordinates in range?) is the comments store's job.
export function asAnchor(value: unknown, field: string): Anchor {
  if (typeof value !== "object" || value === null) {
    throw invalid(field, "an anchor object");
  }
  const obj = value as Record<string, unknown>;
  switch (obj.type) {
    case "board":
      return { type: "board" };
    case "section":
      return {
        type: "section",
        section_id: asString(obj.section_id, `${field}.section_id`),
      };
    case "text":
      return {
        type: "text",
        section_id: asString(obj.section_id, `${field}.section_id`),
        originalText: asString(obj.originalText, `${field}.originalText`),
        startOffset: asInt(obj.startOffset, `${field}.startOffset`),
        endOffset: asInt(obj.endOffset, `${field}.endOffset`),
      };
    case "row":
      return {
        type: "row",
        section_id: asString(obj.section_id, `${field}.section_id`),
        row_id: asString(obj.row_id, `${field}.row_id`),
      };
    case "image": {
      const anchor: ImageAnchor = {
        type: "image",
        asset_id: asString(obj.asset_id, `${field}.asset_id`),
      };
      // overlay is optional (docs/plan.md anchor model: `overlay?`) — present
      // or absent, semantic validation happens in the comments store
      if (obj.overlay !== undefined) {
        anchor.overlay = asImageOverlay(obj.overlay, `${field}.overlay`);
      }
      return anchor;
    }
    default:
      throw invalid(
        `${field}.type`,
        "one of: board, section, text, row, image",
      );
  }
}
