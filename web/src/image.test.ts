import { describe, expect, test } from "bun:test";
import {
  arrowHeadPoints,
  assetIdFromSrc,
  normalizePoint,
  scaleOverlay,
} from "./image.ts";

describe("normalizePoint", () => {
  const box = { left: 10, top: 20, width: 800, height: 400 };

  test("maps a client point into normalized [0,1] coordinates", () => {
    expect(normalizePoint(box, 210, 220)).toEqual({ x: 0.25, y: 0.5 });
    expect(normalizePoint(box, 10, 20)).toEqual({ x: 0, y: 0 });
    expect(normalizePoint(box, 810, 420)).toEqual({ x: 1, y: 1 });
  });

  test("clamps points outside the image box", () => {
    expect(normalizePoint(box, -50, -50)).toEqual({ x: 0, y: 0 });
    expect(normalizePoint(box, 9000, 9000)).toEqual({ x: 1, y: 1 });
    expect(normalizePoint(box, 500, -1)).toEqual({ x: 0.6125, y: 0 });
  });

  test("zero-size boxes return the origin instead of NaN", () => {
    expect(
      normalizePoint({ left: 0, top: 0, width: 0, height: 0 }, 5, 5),
    ).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("scaleOverlay", () => {
  test("scales normalized coordinates to the pixel size of the image box", () => {
    expect(
      scaleOverlay(
        {
          arrows: [{ x1: 0.25, y1: 0.5, x2: 1, y2: 0 }],
          boxes: [{ x: 0.5, y: 0.1, text: "hi" }],
        },
        800,
        400,
      ),
    ).toEqual({
      arrows: [{ x1: 200, y1: 200, x2: 800, y2: 0 }],
      boxes: [{ x: 400, y: 40, text: "hi" }],
    });
  });
});

describe("arrowHeadPoints", () => {
  test("tip sits at the arrow end with the base behind it", () => {
    // horizontal arrow pointing right: base strictly left of the tip,
    // symmetric above and below
    const points = arrowHeadPoints(100, 200, 300, 200, 12)
      .split(" ")
      .map((pair) => pair.split(",").map(Number));
    expect(points[0]).toEqual([300, 200]);
    expect(points[1][0]).toBeLessThan(300);
    expect(points[2][0]).toBeLessThan(300);
    // screen coordinates grow downward — the first base point sits below
    expect(points[1][1]).toBeGreaterThan(200);
    expect(points[2][1]).toBeLessThan(200);
  });

  test("flips with direction", () => {
    const points = arrowHeadPoints(300, 200, 100, 200, 12)
      .split(" ")
      .map((pair) => pair.split(",").map(Number));
    expect(points[0]).toEqual([100, 200]);
    expect(points[1][0]).toBeGreaterThan(100);
    expect(points[2][0]).toBeGreaterThan(100);
  });
});

describe("assetIdFromSrc", () => {
  test("parses asset ids from served asset URLs", () => {
    expect(assetIdFromSrc("/assets/abc123XYZ9")).toBe("abc123XYZ9");
    expect(assetIdFromSrc("/assets/abc123XYZ9?v=2")).toBe("abc123XYZ9");
  });

  test("rejects non-asset and wrong-shape srcs (vite bundles live under /assets/* too)", () => {
    expect(assetIdFromSrc("/assets/short")).toBe(null);
    expect(assetIdFromSrc("/assets/way-too-long-for-an-asset")).toBe(null);
    expect(assetIdFromSrc("https://elsewhere/assets/abc123XYZ9")).toBe(null);
    expect(assetIdFromSrc("/static/picture.png")).toBe(null);
  });
});
