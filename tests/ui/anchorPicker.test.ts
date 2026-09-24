/**
 * D-293 — FX-wizard canvas picking is UI convenience, and these are its pure
 * parts: snapping to the **token-centre** rule (a point anchor on a cell lands
 * where a token would) and refusing exactly what the host refuses (an anchor
 * outside the scene). No host call, no draft mutation happens here — the panel
 * only writes a picked point into the unsaved draft.
 */
import { describe, expect, test } from "vitest";
import { anchorGridSpec, anchorPickError, snapAnchorPoint } from "../../src/ui/macros/anchorPicker";
import type { SceneGrid } from "../../src/core/documents";

const square: SceneGrid = { type: "square", size: 100, distance: 5, units: "ft",
  diagonals: "555", hexLayout: "oddR" };
const hex: SceneGrid = { ...square, type: "hex", size: 100, hexLayout: "oddR" };
const gridless: SceneGrid = { ...square, type: "gridless", size: 0 };

describe("snapAnchorPoint", () => {
  test("a square grid snaps to the nearest cell centre, not the intersection", () => {
    // (74, 31) is inside the cell whose centre is (50, 50); the intersection rule
    // would answer (100, 0) — a point on a line between four cells.
    expect(snapAnchorPoint({ x: 74, y: 31 }, square, true)).toEqual({ x: 50, y: 50 });
    expect(snapAnchorPoint({ x: 160, y: 149 }, square, true)).toEqual({ x: 150, y: 150 });
    expect(snapAnchorPoint({ x: 149, y: 151 }, square, true)).toEqual({ x: 150, y: 150 });
  });

  test("turning snapping off keeps the exact world point", () => {
    expect(snapAnchorPoint({ x: 74.5, y: 31.25 }, square, false)).toEqual({ x: 74.5, y: 31.25 });
  });

  test("a gridless scene never snaps, even with snapping on", () => {
    expect(snapAnchorPoint({ x: 74.5, y: 31.25 }, gridless, true)).toEqual({ x: 74.5, y: 31.25 });
  });

  test("a malformed grid size is treated as gridless rather than producing NaN", () => {
    const broken: SceneGrid = { ...square, size: 0 };
    expect(snapAnchorPoint({ x: 12, y: 13 }, broken, true)).toEqual({ x: 12, y: 13 });
    expect(anchorGridSpec(broken)).toEqual({ type: "square", size: 0 }); // spec stays honest
  });

  test("a hex grid snaps to a hex centre inside the scene", () => {
    const snapped = snapAnchorPoint({ x: 74, y: 31 }, hex, true);
    expect(Number.isFinite(snapped.x) && Number.isFinite(snapped.y)).toBe(true);
    expect(Math.abs(snapped.x - 74)).toBeLessThanOrEqual(hex.size);
    expect(Math.abs(snapped.y - 31)).toBeLessThanOrEqual(hex.size);
  });
});

describe("anchorPickError", () => {
  const bounds = { width: 1_000, height: 800 };

  test("inside the scene (edges included) is committable", () => {
    expect(anchorPickError({ x: 0, y: 0 }, bounds)).toBeNull();
    expect(anchorPickError({ x: 1_000, y: 800 }, bounds)).toBeNull();
    expect(anchorPickError({ x: 499.5, y: 12.25 }, bounds)).toBeNull();
  });

  test("outside the scene is refused — the same bounds the host enforces", () => {
    expect(anchorPickError({ x: -1, y: 10 }, bounds)).toBe("Outside the scene");
    expect(anchorPickError({ x: 10, y: -0.5 }, bounds)).toBe("Outside the scene");
    expect(anchorPickError({ x: 1_001, y: 10 }, bounds)).toBe("Outside the scene");
    expect(anchorPickError({ x: 10, y: 801 }, bounds)).toBe("Outside the scene");
  });

  test("a non-finite point never reads as committable", () => {
    expect(anchorPickError({ x: Number.NaN, y: 10 }, bounds)).toBe("Not a finite point");
    expect(anchorPickError({ x: 10, y: Number.POSITIVE_INFINITY }, bounds)).toBe("Not a finite point");
  });
});

describe("anchorGridSpec", () => {
  test("maps the three scene grid kinds onto the shared snapping spec", () => {
    expect(anchorGridSpec(square)).toEqual({ type: "square", size: 100 });
    expect(anchorGridSpec(hex)).toEqual({ type: "hex", size: 100, layout: "oddR" });
    expect(anchorGridSpec({ ...square, type: "gridless" })).toEqual({ type: "gridless" });
  });
});
