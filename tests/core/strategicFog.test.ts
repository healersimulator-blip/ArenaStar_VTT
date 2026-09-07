import { describe, expect, test } from "vitest";
import { DetectionGrid, poolBounds } from "../../src/core/detection";
import {
  buildStrategicFog,
  fogSyncKey,
  sceneIsStrategic,
  unitAnchor,
} from "../../src/core/strategicFog";
import { createModelPool, allocModel } from "../../src/sim/pool";
import type { BaseDocument } from "../../src/core/documents";
import type { ArmyDocument, FactionDocument, UnitDocument } from "../../src/core/strategic";

function faction(id: string, allies: string[] = []): FactionDocument {
  return {
    _id: id,
    type: "faction",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    color: "#fff",
    allies,
  };
}

function unit(id: string, range: [number, number]): UnitDocument {
  return {
    _id: id,
    type: "infantry",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    profile: {},
    formation: "line",
    sceneId: null,
    modelRange: range,
    orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
    stats: { strength: range ? range[1] - range[0] : 0, morale: 5, supply: 5, fatigue: 0 },
  };
}

function army(id: string, factionId: string, units: UnitDocument[]): ArmyDocument {
  return {
    _id: id,
    type: "army",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    factionId,
    commander: [],
    supply: {},
    units,
  };
}

describe("DetectionGrid cell rects (§9A fog)", () => {
  test("factionCellRects lists detected cells; allies share vision", () => {
    const grid = new DetectionGrid(10);
    grid.reseed([{ anchor: { x: 50, y: 50 }, factionId: "fA", radius: 15 }], {
      minX: 0,
      minY: 0,
      maxX: 200,
      maxY: 200,
    });
    const own = grid.factionCellRects("fA");
    expect(own.length).toBeGreaterThan(1);
    for (const r of own) {
      expect(r.width).toBe(10);
      expect(r.height).toBe(10);
    }
    // ally sees through shared vision
    const allyView = grid.factionCellRects("fB", ["fA"]);
    expect(allyView.length).toBe(own.length);
    // a stranger sees nothing
    expect(grid.factionCellRects("fC")).toEqual([]);
  });

  test("undetectedRectsInView covers the far region and skips the detected one", () => {
    const grid = new DetectionGrid(10);
    grid.reseed([{ anchor: { x: 20, y: 20 }, factionId: "fA", radius: 10 }], {
      minX: 0,
      minY: 0,
      maxX: 200,
      maxY: 200,
    });
    const dark = grid.undetectedRectsInView({ x: 0, y: 0, width: 200, height: 200 }, "fA");
    expect(dark.length).toBeGreaterThan(10); // most of the map is dark
    // no dark rect overlaps the detected origin cell
    for (const r of dark) {
      const overlapsOrigin = r.x <= 20 && r.x + r.width > 20 && r.y <= 20 && r.y + r.height > 20;
      expect(overlapsOrigin).toBe(false);
    }
  });
});

describe("strategic fog build (§9A)", () => {
  test("own units are allies; enemy units are not; anchors come from the pool", () => {
    const pool = createModelPool(16);
    const a0 = allocModel(pool, { id: 1, unitIdx: 0, x: 100, y: 100 });
    const a1 = allocModel(pool, { id: 2, unitIdx: 0, x: 110, y: 100 });
    const e0 = allocModel(pool, { id: 3, unitIdx: 0, x: 900, y: 900 });
    expect([a0, a1, e0]).toEqual([0, 1, 2]);

    const armies = [
      army("arA", "fA", [unit("uA", [0, 2])]),
      army("arB", ["fB", "fA"].map((f) => f)[0] as string, []), // placeholder replaced below
    ];
    // ally army shares vision; enemy army does not
    const factions = [faction("fA", ["fB"]), faction("fB", ["fA"]), faction("fE")];
    const list = [
      army("arA", "fA", [unit("uA", [0, 2])]),
      army("arB", "fB", [unit("uB", [2, 3])]),
      army("arE", "fE", [unit("uE", [2, 3])]),
    ];
    void armies;

    const fog = buildStrategicFog({
      pool,
      armies: list,
      factions,
      factionId: "fA",
      radiusOf: () => 20,
      cellSize: 10,
    });
    expect(fog.allyUnitIds.has("uA")).toBe(true);
    expect(fog.allyUnitIds.has("uB")).toBe(true); // fB is an ally
    expect(fog.allyUnitIds.has("uE")).toBe(false);

    // enemy region (900,900) is dark for fA even though fB detects near it? fB's
    // unit sits AT the enemy position — ally vision means it is lit:
    const lit = fog.grid.factionCellRects("fA", fog.allyFactionIds.slice(1));
    const nearEnemy = lit.some((r) => Math.abs(r.x - 900) < 30 && Math.abs(r.y - 900) < 30);
    expect(nearEnemy).toBe(true);
    // without the ally, the enemy region is dark
    const solo = buildStrategicFog({
      pool,
      armies: list,
      factions: [faction("fA"), faction("fB"), faction("fE")],
      factionId: "fA",
      radiusOf: () => 20,
      cellSize: 10,
    });
    const soloLit = solo.grid.factionCellRects("fA");
    expect(soloLit.some((r) => Math.abs(r.x - 900) < 30 && Math.abs(r.y - 900) < 30)).toBe(false);
  });

  test("unitAnchor averages live model positions; empty range → null", () => {
    const pool = createModelPool(8);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0 });
    allocModel(pool, { id: 2, unitIdx: 0, x: 10, y: 20 });
    const anchor = unitAnchor(pool, unit("u", [0, 2]));
    expect(anchor).toEqual({ x: 5, y: 10 });
    expect(unitAnchor(pool, unit("u2", [2, 2]))).toBeNull();
    expect(unitAnchor(pool, unit("u3", null as unknown as [number, number]))).toBeNull();
  });

  test("sceneIsStrategic reads flags.core.scale", () => {
    const scene = (core: unknown): BaseDocument =>
      ({
        _id: "s",
        type: "scene",
        name: "s",
        ownership: { default: 0 },
        system: {},
        flags: { core },
      }) as unknown as BaseDocument;
    expect(sceneIsStrategic(scene({ scale: "strategic" }))).toBe(true);
    expect(sceneIsStrategic(scene({ scale: "tactical" }))).toBe(false);
    expect(sceneIsStrategic(scene({}))).toBe(false);
    expect(sceneIsStrategic(null)).toBe(false);
  });

  test("poolBounds of an empty pool is the zero rect", () => {
    expect(poolBounds(createModelPool(2))).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe("fogSyncKey dedupe", () => {
  const rects = [
    { x: 0, y: 0 },
    { x: 10.4, y: 0 },
  ];
  test("same rects + same zoom bucket → same key; sub-bucket zoom change dedupes", () => {
    expect(fogSyncKey(rects, { scale: 1 })).toBe(fogSyncKey(rects, { scale: 0.95 })); // same bucket(6)
    expect(fogSyncKey(rects, { scale: 1 })).not.toBe(fogSyncKey(rects, { scale: 3 }));
    expect(fogSyncKey(rects, { scale: 1 })).not.toBe(fogSyncKey(rects.slice(0, 1), { scale: 1 }));
    const moved = [
      { x: 0, y: 0 },
      { x: 11, y: 0 },
    ];
    expect(fogSyncKey(rects, { scale: 1 })).not.toBe(fogSyncKey(moved, { scale: 1 }));
  });
});
