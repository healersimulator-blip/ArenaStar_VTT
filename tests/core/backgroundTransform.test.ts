import { describe, expect, test } from "vitest";
import {
  backgroundRect,
  backgroundTransformOf,
  backgroundWriteFields,
  gridAlignmentError,
  hitBackground,
  mapSquaresAsGrid,
  matchMapToGrid,
  moveBackground,
  placeBackground,
  resizeBackground,
  scaleBackgroundAbout,
  snapBackgroundPosition,
  type BackgroundTransform,
  type MapGridEstimate,
} from "../../src/core/backgroundTransform";

const natural = { width: 1000, height: 500 };
const start: BackgroundTransform = { x: 100, y: 200, scaleX: 1, scaleY: 1 };

describe("stored presentation", () => {
  test("scaleX/scaleY override the uniform scale; invalid values fall back", () => {
    expect(backgroundTransformOf({ offset: { x: 4, y: 5 }, scale: 2 })).toEqual({ x: 4, y: 5, scaleX: 2, scaleY: 2 });
    expect(backgroundTransformOf({ scale: 2, scaleX: 3, scaleY: 0.5 })).toMatchObject({ scaleX: 3, scaleY: 0.5 });
    expect(backgroundTransformOf({ scale: -1, scaleX: Number.NaN })).toMatchObject({ scaleX: 1, scaleY: 1 });
    expect(backgroundTransformOf(undefined)).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
  });

  test("writes keep the legacy `scale` equal to the X scale", () => {
    expect(backgroundWriteFields({ x: 1.23456, y: 2, scaleX: 0.5, scaleY: 0.25 })).toEqual({
      offset: { x: 1.235, y: 2 },
      scale: 0.5,
      scaleX: 0.5,
      scaleY: 0.25,
    });
  });
});

describe("hit testing", () => {
  const rect = backgroundRect(natural, start);

  test("handles win over the body, and the body moves the image", () => {
    expect(hitBackground(natural, start, { x: rect.left, y: rect.top }, 8)).toBe("nw");
    expect(hitBackground(natural, start, { x: rect.right, y: rect.top + rect.height / 2 }, 8)).toBe("e");
    expect(hitBackground(natural, start, { x: rect.left + 200, y: rect.top + 100 }, 8)).toBe("move");
    expect(hitBackground(natural, start, { x: rect.left - 50, y: rect.top - 50 }, 8)).toBeNull();
  });

  test("the handle radius is in scene pixels, so zooming changes its size on screen only", () => {
    // 6 scene px away from the corner: a handle at high zoom (radius 10), but not at low zoom (radius 4).
    expect(hitBackground(natural, start, { x: rect.left - 6, y: rect.top }, 10)).toBe("nw");
    expect(hitBackground(natural, start, { x: rect.left - 6, y: rect.top }, 4)).toBeNull();
  });
});

describe("resize", () => {
  test("a corner keeps the aspect ratio and the opposite corner stays fixed", () => {
    const next = resizeBackground(natural, start, "se", { x: 1100 + 500, y: 200 + 250 });
    // The larger relative change wins: drawn width 1000→1500 (×1.5), height follows.
    expect(next.scaleX).toBeCloseTo(1.5);
    expect(next.scaleY).toBeCloseTo(1.5);
    expect(next.x).toBe(100);
    expect(next.y).toBe(200);
  });

  test("dragging the north-west corner anchors the south-east corner", () => {
    const next = resizeBackground(natural, start, "nw", { x: 0, y: 0 }, { keepAspect: true });
    const r = backgroundRect(natural, next);
    expect(r.right).toBeCloseTo(1100);
    expect(r.bottom).toBeCloseTo(700);
    expect(next.scaleX).toBeCloseTo(next.scaleY);
  });

  test("an edge stretches one axis only unless the aspect is locked", () => {
    const stretched = resizeBackground(natural, start, "e", { x: 1600, y: 0 });
    expect(stretched.x).toBe(100);
    expect(stretched.scaleX).toBeCloseTo(1.5);
    expect(stretched.scaleY).toBe(1);
    const locked = resizeBackground(natural, start, "e", { x: 1600, y: 0 }, { keepAspect: true });
    expect(locked.scaleX).toBeCloseTo(1.5);
    expect(locked.scaleY).toBeCloseTo(1.5);
    // The inactive axis stays centred on its original centre when the aspect is locked.
    expect(locked.y + (natural.height * locked.scaleY) / 2).toBeCloseTo(200 + 250);
  });

  test("grid snapping moves the dragged edge onto a scene grid line", () => {
    const next = resizeBackground(natural, start, "e", { x: 1234, y: 0 }, { gridSize: 100 });
    expect(backgroundRect(natural, next).right).toBe(1200);
  });

  test("the size never drops below the minimum or flips", () => {
    const next = resizeBackground(natural, start, "e", { x: -500, y: 0 }, { minSceneSize: 4 });
    expect(next.scaleX * natural.width).toBeGreaterThanOrEqual(4);
    expect(next.x).toBe(100);
  });
});

describe("move and scale about a point", () => {
  test("moving translates the image without changing its scale", () => {
    expect(moveBackground(start, 15, -20)).toEqual({ x: 115, y: 180, scaleX: 1, scaleY: 1 });
  });

  test("scaling about an anchor keeps that point where it was", () => {
    const anchor = { x: 300, y: 400 };
    const next = scaleBackgroundAbout(natural, start, 2, anchor);
    const before = { x: (anchor.x - start.x) / start.scaleX, y: (anchor.y - start.y) / start.scaleY };
    const after = { x: (anchor.x - next.x) / next.scaleX, y: (anchor.y - next.y) / next.scaleY };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(next.scaleX).toBeCloseTo(2);
  });
});

describe("fit, cover, native, centre", () => {
  const scene = { width: 1200, height: 800 };
  test("fit keeps the whole image visible and centred", () => {
    const t = placeBackground(natural, scene, "fit", start);
    expect(t.scaleX).toBeCloseTo(1.2);
    expect(t.scaleY).toBeCloseTo(1.2);
    expect(t.x).toBeCloseTo(0);
    expect(t.y).toBeCloseTo((800 - 600) / 2);
  });

  test("cover fills the scene and centres the overflow", () => {
    const t = placeBackground(natural, scene, "cover", start);
    // max(1200/1000, 800/500): the height decides, so the width overflows and is centred.
    expect(t.scaleX).toBeCloseTo(1.6);
    expect(t.x).toBeCloseTo((1200 - 1600) / 2);
    expect(t.y).toBeCloseTo(0);
  });

  test("native is 1:1 at the scene origin, and centre keeps the current scale", () => {
    expect(placeBackground(natural, scene, "native", start)).toEqual({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
    const centred = placeBackground(natural, scene, "center", { x: 0, y: 0, scaleX: 0.5, scaleY: 0.5 });
    expect(centred).toEqual({ x: (1200 - 500) / 2, y: (800 - 250) / 2, scaleX: 0.5, scaleY: 0.5 });
  });
});

describe("alignment to the scene grid", () => {
  // Native map: 75 px squares, lines at x = 1 + k·75 and y = 1 + k·75 (boundary coordinates).
  const map: MapGridEstimate = { sizeX: 75, sizeY: 75, offsetX: 1, offsetY: 1 };

  test("snapping grid mode puts the top-left on an intersection", () => {
    const t = snapBackgroundPosition({ x: 37, y: -22, scaleX: 1, scaleY: 1 }, 50, "grid");
    expect(t.x).toBe(50);
    expect(t.y).toBe(-0);
  });

  test("snapping map mode lines a map line up with a scene line, and needs a detected grid", () => {
    const t = snapBackgroundPosition({ x: 13, y: 0, scaleX: 1, scaleY: 1 }, 50, "map", map);
    expect(gridAlignmentError(t, map, 50).phasePx).toBeLessThan(1e-9);
    expect(snapBackgroundPosition({ x: 13, y: 0, scaleX: 1, scaleY: 1 }, 50, "map", null).x).toBe(13);
  });

  test("matching the map to the grid makes one map square exactly the grid size", () => {
    const aligned = matchMapToGrid({ x: 412, y: -90, scaleX: 1, scaleY: 1 }, map, 50);
    expect(aligned.scaleX).toBeCloseTo(50 / 75);
    expect(aligned.scaleY).toBeCloseTo(50 / 75);
    const error = gridAlignmentError(aligned, map, 50);
    expect(error.phasePx).toBeLessThan(1e-9);
    expect(error.pitchPx).toBeLessThan(1e-9);
  });

  test("using the map's squares as the grid keeps the image scale and shifts it onto the lines", () => {
    const { gridSize, transform } = mapSquaresAsGrid({ x: 0, y: 0, scaleX: 0.5, scaleY: 0.5 }, map);
    expect(gridSize).toBe(38);
    expect(gridAlignmentError(transform, { ...map, sizeX: 75, sizeY: 75 }, gridSize).phasePx).toBeLessThan(1e-9);
    expect(transform.scaleX).toBe(0.5);
  });

  test("the alignment report shows phase error and per-square pitch error", () => {
    const off = gridAlignmentError({ x: 10, y: 0, scaleX: 1, scaleY: 1 }, map, 50);
    expect(off.phasePx).toBeGreaterThan(9);
    expect(off.pitchPx).toBe(25);
  });
});
