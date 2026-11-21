import { describe, expect, test } from "vitest";
import { fitRect, LARGE_SCENE_ZOOM_LIMITS, screenToWorld, zoomAt } from "../../src/canvas/camera";
import { OWNERSHIP_LEVELS, type TileDocument } from "../../src/core/documents";
import {
  defaultStitchColumns,
  isStitchedMapTile,
  mergeStitchedSceneTiles,
  planStitchedMapTiles,
} from "../../src/core/mapStitching";

describe("multi-image map stitching & large-scene camera math", () => {
  test("stitches 2x2 and 3x3 panels edge-to-edge with zero integer seam gaps", () => {
    expect(defaultStitchColumns(4)).toBe(2);
    expect(defaultStitchColumns(6)).toBe(3);
    expect(defaultStitchColumns(9)).toBe(3);

    const panels = Array.from({ length: 9 }, (_, i) => ({
      id: `panel-${i + 1}`,
      name: `Sector ${i + 1}`,
      image: `${(i + 1).toString(16).padStart(64, "0")}`,
      width: 2048,
      height: 2048,
    }));
    // Odd scene dimensions (16,001 x 12,001 px = >800x600 squares at 20px) still share exact integer edges.
    const plan = planStitchedMapTiles(panels, {
      columns: 3,
      mode: "fitScene",
      sceneSize: { width: 16_001, height: 12_001 },
      gridSize: 20,
    });
    expect(plan.columns).toBe(3);
    expect(plan.rows).toBe(3);
    expect(plan.tiles).toHaveLength(9);

    for (let row = 0; row < 3; row++) {
      let rowWidth = 0;
      for (let col = 0; col < 3; col++) {
        const cur = plan.tiles[row * 3 + col];
        expect(cur).toBeDefined();
        if (!cur) continue;
        expect(isStitchedMapTile(cur)).toBe(true);
        expect(cur.above).toBe(false);
        rowWidth += cur.width;
        if (col > 0) {
          const left = plan.tiles[row * 3 + col - 1];
          expect(cur.x).toBe((left?.x ?? 0) + (left?.width ?? 0));
        }
        if (row > 0) {
          const up = plan.tiles[(row - 1) * 3 + col];
          expect(cur.y).toBe((up?.y ?? 0) + (up?.height ?? 0));
        }
      }
      expect(rowWidth).toBe(16_001);
    }
  });

  test("resizeScene derives >500x500 square dimensions and mergeStitchedSceneTiles keeps prop tiles", () => {
    const panels = Array.from({ length: 4 }, (_, i) => ({
      id: `quad-${i}`,
      name: `Quad ${i}`,
      image: "a".repeat(64),
      width: 8000,
      height: 8000,
    }));
    const plan = planStitchedMapTiles(panels, {
      columns: 2,
      mode: "resizeScene",
      sceneSize: { width: 5000, height: 5000 },
      gridSize: 20,
      targetSquares: { cols: 1200, rows: 1000 },
    });
    expect(plan.width).toBe(24_000);
    expect(plan.height).toBe(20_000);
    expect(plan.tiles.map((t) => [t.x, t.y, t.width, t.height])).toEqual([
      [0, 0, 12_000, 10_000],
      [12_000, 0, 12_000, 10_000],
      [0, 10_000, 12_000, 10_000],
      [12_000, 10_000, 12_000, 10_000],
    ]);

    const userPropTile: TileDocument = {
      _id: "prop-bridge",
      type: "tile",
      name: "Stone bridge",
      ownership: { default: OWNERSHIP_LEVELS.NONE },
      flags: {},
      system: {},
      x: 500,
      y: 500,
      width: 200,
      height: 100,
      img: "b".repeat(64),
      above: false,
      occlusion: { mode: "roof", alpha: 0.5 },
    };
    const firstTile = plan.tiles[0];
    if (!firstTile) throw new Error("Missing first tile");
    const merged = mergeStitchedSceneTiles([firstTile, userPropTile], plan.tiles.slice(0, 2));
    expect(merged.map((t) => t._id)).toEqual(["quad-0", "quad-1", "prop-bridge"]);
  });

  test("camera fitRect and LARGE_SCENE_ZOOM_LIMITS fit 1,000x1,000 and 5,000x5,000 square maps", () => {
    // 5,000 x 5,000 squares at 20px = 100,000 x 100,000 px scene
    const cam = fitRect({ x: 0, y: 0, width: 100_000, height: 100_000 }, { width: 1280, height: 800 }, 24);
    expect(cam.scale).toBeLessThan(0.01);
    expect(cam.scale).toBeGreaterThanOrEqual(LARGE_SCENE_ZOOM_LIMITS.min);
    const center = screenToWorld(cam, 640, 400);
    expect(center.x).toBeCloseTo(50_000, 3);
    expect(center.y).toBeCloseTo(50_000, 3);

    const zoomedOut = zoomAt({ x: 0, y: 0, scale: 0.05 }, 640, 400, 0.1, LARGE_SCENE_ZOOM_LIMITS);
    expect(zoomedOut.scale).toBeCloseTo(0.005, 5);
  });
});
