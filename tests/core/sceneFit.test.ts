import { describe, expect, test } from "vitest";
import {
  MAX_GRID_COUNT,
  cellSizeForCount,
  fitSceneToGridCount,
  gridCountOfMap,
  mapGridFromCount,
  normalizeGridCount,
  rescaleMapGrid,
} from "../../src/core/sceneFit";
import { gridAlignmentError } from "../../src/core/backgroundTransform";
import {
  DEFAULT_GRID_STYLE,
  gridSpecFromScene,
  gridStyleFromScene,
  parseGridColor,
} from "../../src/canvas/grid";

// D-465: fitting a scene by the map's grid *count* (the tester's "48 × 64 squares").
describe("grid-count fit (D-465)", () => {
  const cove = { width: 2250, height: 2250 }; // Assets/Maps/Cove3.jpg: 30 × 30 squares of 75 px

  test("a stated count sizes the scene to that many cells and scales the map to fill it", () => {
    const fit = fitSceneToGridCount({ natural: cove, count: { columns: 30, rows: 30 }, gridSize: 100, type: "square" });
    expect(fit).not.toBeNull();
    expect(fit).toMatchObject({ width: 3000, height: 3000, gridSize: 100, warning: null });
    expect(fit?.cell).toEqual({ width: 75, height: 75 });
    expect(fit?.transform).toEqual({ x: 0, y: 0, scaleX: 100 / 75, scaleY: 100 / 75 });
  });

  test("a measured phase shifts the map so its lines land on the grid lines", () => {
    const mapGrid = { sizeX: 75.05, sizeY: 75.05, offsetX: 0.9, offsetY: 73.66 };
    const fit = fitSceneToGridCount({ natural: cove, count: gridCountOfMap(cove, mapGrid), gridSize: 100, type: "square", mapGrid });
    expect(fit?.width).toBe(3000);
    // Map line at native 0.9 px → drawn at 0.9 × scale; the shift cancels it; the y line sits
    // 73.66 px in (≈ one square less 1.4 px) and is pulled forward onto the next grid line.
    const transform = fit?.transform ?? { x: NaN, y: NaN, scaleX: NaN, scaleY: NaN };
    const error = gridAlignmentError(transform, mapGrid, 100);
    expect(error.phasePx).toBeLessThan(0.01);
    expect(transform.x).toBeCloseTo(-1.2, 2);
    expect(transform.y).toBeCloseTo(100 - 73.66 * (100 / 75), 1);
  });

  test("the octave mistake testers hit (4 map squares in one cell) is one count away", () => {
    // The detector read every second line: 37.5 px → 60 × 60. Half the count → 75 px squares.
    const doubled = fitSceneToGridCount({ natural: cove, count: { columns: 60, rows: 60 }, gridSize: 100, type: "square" });
    expect(doubled?.cell.width).toBe(37.5);
    const corrected = rescaleMapGrid({ sizeX: 37.5, sizeY: 37.5, offsetX: 20, offsetY: 5 }, 2);
    expect(corrected).toEqual({ sizeX: 75, sizeY: 75, offsetX: 20, offsetY: 5 });
    expect(gridCountOfMap(cove, corrected)).toEqual({ columns: 30, rows: 30 });
    // and back down again folds the phase into the smaller period
    expect(rescaleMapGrid({ sizeX: 75, sizeY: 75, offsetX: 60, offsetY: 5 }, 0.5)).toEqual({ sizeX: 37.5, sizeY: 37.5, offsetX: 22.5, offsetY: 5 });
  });

  test("non-square counts warn but still fit exactly (per-axis scale)", () => {
    const fit = fitSceneToGridCount({ natural: { width: 1000, height: 1000 }, count: { columns: 10, rows: 12 }, gridSize: 50, type: "square" });
    expect(fit?.warning).toMatch(/not square/);
    expect(fit).toMatchObject({ width: 500, height: 600 });
    expect(fit?.transform.scaleX).toBeCloseTo(0.5, 3);
    expect(fit?.transform.scaleY).toBeCloseTo(0.6, 3);
  });

  test("hex counts use the layout's pitch and keep the image aspect", () => {
    const flat = cellSizeForCount({ width: 1000, height: 866 }, { columns: 10, rows: 10 }, "hex", "oddQ");
    // flat-top: 10 columns span (1.5·10 + 0.5) r = 15.5 r → r = 64.5; 10 rows span 10.5·√3 r → r = 47.6
    expect(flat.width).toBeCloseTo(1000 / 15.5, 3);
    expect(flat.height).toBeCloseTo(866 / (10.5 * Math.sqrt(3)), 3);
    const pointy = cellSizeForCount({ width: 1000, height: 866 }, { columns: 10, rows: 10 }, "hex", "oddR");
    expect(pointy.width).toBeCloseTo(1000 / (10.5 * Math.sqrt(3)), 3);
    expect(pointy.height).toBeCloseTo(866 / 15.5, 3);
    const fit = fitSceneToGridCount({ natural: { width: 1550, height: 1000 }, count: { columns: 10, rows: 5 }, gridSize: 50, type: "hex", hexLayout: "oddQ" });
    expect(fit?.transform.scaleX).toBeCloseTo(0.5, 3);
    expect(fit?.transform.scaleY).toBe(fit?.transform.scaleX);
    expect(fit).toMatchObject({ width: 775, height: 500 });
  });

  test("counts are whole, positive and bounded; the map grid from a count has phase 0", () => {
    expect(normalizeGridCount({ columns: 29.6, rows: 30.4 })).toEqual({ columns: 30, rows: 30 });
    expect(normalizeGridCount({ columns: 0, rows: 30 })).toBeNull();
    expect(normalizeGridCount({ columns: MAX_GRID_COUNT + 1, rows: 30 })).toBeNull();
    expect(normalizeGridCount({ columns: Number.NaN, rows: 30 })).toBeNull();
    expect(mapGridFromCount(cove, { columns: 30, rows: 30 })).toEqual({ sizeX: 75, sizeY: 75, offsetX: 0, offsetY: 0 });
    expect(mapGridFromCount(cove, { columns: 0, rows: 30 })).toBeNull();
    expect(fitSceneToGridCount({ natural: cove, count: { columns: 0, rows: 1 }, gridSize: 100, type: "square" })).toBeNull();
    expect(fitSceneToGridCount({ natural: cove, count: { columns: 30, rows: 30 }, gridSize: 0, type: "square" })).toBeNull();
  });
});

describe("scene grid style and spec (D-465)", () => {
  test("colour and opacity come from the scene, with safe defaults for missing or bad values", () => {
    expect(gridStyleFromScene(undefined)).toEqual(DEFAULT_GRID_STYLE);
    expect(gridStyleFromScene({ color: "#ff8800", alpha: 0.8 })).toEqual({ color: 0xff8800, alpha: 0.8 });
    expect(gridStyleFromScene({ color: "#f80" })).toEqual({ color: 0xff8800, alpha: DEFAULT_GRID_STYLE.alpha });
    expect(gridStyleFromScene({ color: "orange", alpha: 7 })).toEqual({ color: DEFAULT_GRID_STYLE.color, alpha: 1 });
    expect(gridStyleFromScene({ alpha: -1 })).toEqual({ color: DEFAULT_GRID_STYLE.color, alpha: 0 });
    expect(gridStyleFromScene({ alpha: Number.NaN })).toEqual(DEFAULT_GRID_STYLE);
    expect(parseGridColor("5C6672")).toBe(0x5c6672);
    expect(parseGridColor("#12345")).toBeNull();
  });

  test("one spec for every shell: square, hex (with layout), gridless, and nothing for a bad size", () => {
    expect(gridSpecFromScene({ type: "square", size: 75, hexLayout: "oddR" })).toEqual({ type: "square", size: 75 });
    expect(gridSpecFromScene({ type: "hex", size: 40, hexLayout: "evenQ" })).toEqual({ type: "hex", size: 40, layout: "evenQ" });
    expect(gridSpecFromScene({ type: "gridless", size: 100, hexLayout: "oddR" })).toEqual({ type: "gridless" });
    expect(gridSpecFromScene({ type: "square", size: 0, hexLayout: "oddR" })).toBeNull();
    expect(gridSpecFromScene(null)).toBeNull();
  });
});
