import { describe, expect, test } from "vitest";
import {
  chooseUnitLods,
  DEFAULT_LOD_THRESHOLDS,
  desiredLod,
  drawableModelIndices,
  strengthFraction,
  UnitLodState,
  unitBBox,
  bboxIntersects,
  type LodThresholds,
} from "../../src/canvas/layers/ModelLayer/lod";
import { drawableUnits, parseHexColor } from "../../src/canvas/layers/ModelLayer/units";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { ModelStatus } from "../../src/core/strategic";
import type { ModelPool } from "../../src/core/strategic";
import type { ArmyDocument, FactionDocument } from "../../src/core/strategic";

const T = DEFAULT_LOD_THRESHOLDS;

describe("LOD selection (§9A)", () => {
  test("desiredLod follows zoom thresholds", () => {
    expect(desiredLod(1, T)).toBe(0);
    expect(desiredLod(0.61, T)).toBe(0);
    expect(desiredLod(0.59, T)).toBe(1);
    expect(desiredLod(0.23, T)).toBe(1);
    expect(desiredLod(0.21, T)).toBe(2);
  });

  test("hysteresis: zoom oscillating inside the band does not flicker", () => {
    const state = new UnitLodState();
    const units = [{ id: "u", modelRange: [0, 10] as [number, number] }];
    // establish LOD0
    expect(chooseUnitLods(units, 0.9, state, T).get("u")).toBe(0);
    // dip below lod1Zoom but not outside the band [0.51, 0.69]
    expect(chooseUnitLods(units, 0.58, state, T).get("u")).toBe(0);
    expect(chooseUnitLods(units, 0.62, state, T).get("u")).toBe(0);
    expect(chooseUnitLods(units, 0.55, state, T).get("u")).toBe(0);
    // fully below the band → switch
    expect(chooseUnitLods(units, 0.49, state, T).get("u")).toBe(1);
    // recover above the lower edge but inside the band → stay
    expect(chooseUnitLods(units, 0.55, state, T).get("u")).toBe(1);
    expect(chooseUnitLods(units, 0.6, state, T).get("u")).toBe(1);
    // fully above the band → back to LOD0
    expect(chooseUnitLods(units, 0.75, state, T).get("u")).toBe(0);
  });

  test("density demotion pushes largest LOD0 units to LOD1 within budget", () => {
    const state = new UnitLodState();
    const thresholds: LodThresholds = { ...T, modelBudget: 100 };
    const pool = createModelPool(200);
    for (let i = 0; i < 160; i++) {
      allocModel(pool, { id: i + 1, unitIdx: 0, x: i, y: 0, hp: 1, hpMax: 1 });
    }
    const units = [
      { id: "u-big", modelRange: [0, 120] as [number, number] },
      { id: "u-small", modelRange: [120, 160] as [number, number] },
    ];
    const lods = chooseUnitLods(units, 1, state, thresholds, pool);
    expect(lods.get("u-big")).toBe(1); // demoted first (larger)
    expect(lods.get("u-small")).toBe(0); // 40 ≤ 100 budget
  });

  test("density demotion tie-break is deterministic by id", () => {
    const state = new UnitLodState();
    const thresholds: LodThresholds = { ...T, modelBudget: 25 };
    const pool = createModelPool(40);
    for (let i = 0; i < 40; i++) {
      allocModel(pool, { id: i + 1, unitIdx: 0, x: i, y: 0, hp: 1, hpMax: 1 });
    }
    const units = [
      { id: "u-b", modelRange: [0, 20] as [number, number] },
      { id: "u-a", modelRange: [20, 40] as [number, number] },
    ];
    const lods = chooseUnitLods(units, 1, state, thresholds, pool);
    expect(lods.get("u-a")).toBe(1); // tie on 20 models → id asc demoted
    expect(lods.get("u-b")).toBe(0);
  });

  test("hysteresis state is zoom-driven only; demotion does not poison it", () => {
    const state = new UnitLodState();
    const thresholds: LodThresholds = { ...T, modelBudget: 10 };
    const pool = createModelPool(40);
    for (let i = 0; i < 40; i++) {
      allocModel(pool, { id: i + 1, unitIdx: 0, x: i, y: 0, hp: 1, hpMax: 1 });
    }
    const units = [{ id: "u", modelRange: [0, 40] as [number, number] }];
    expect(chooseUnitLods(units, 1, state, thresholds, pool).get("u")).toBe(1); // demoted
    expect(chooseUnitLods(units, 1, state, thresholds, pool).get("u")).toBe(1); // stable
    // half the models die → under budget → LOD0 returns (zoom never left LOD0 band)
    for (let i = 0; i < 30; i++) pool.status[i] = (pool.status[i] ?? 0) | ModelStatus.dead;
    expect(chooseUnitLods(units, 1, state, thresholds, pool).get("u")).toBe(0);
  });
});

describe("unit bbox + culling (§9A)", () => {
  function pool(): ModelPool {
    const p = createModelPool(8);
    allocModel(p, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 1, hpMax: 1 });
    allocModel(p, { id: 2, unitIdx: 0, x: 14, y: 12, hp: 1, hpMax: 1 });
    allocModel(p, { id: 3, unitIdx: 0, x: 12, y: 16, hp: 1, hpMax: 1 });
    return p;
  }

  test("unitBBox covers drawable models; hidden/dead excluded", () => {
    const p = pool();
    p.status[2] = (p.status[2] ?? 0) | ModelStatus.hidden; // (12,16) is a zeroed projected slot
    p.x[2] = 0;
    p.y[2] = 0;
    const box = unitBBox(p, [0, 3]);
    expect(box).toEqual({ minX: 10, minY: 10, maxX: 14, maxY: 12 });
    expect(unitBBox(p, null)).toBeNull();
  });

  test("bboxIntersects matches viewport overlap", () => {
    const box = { minX: 10, minY: 10, maxX: 20, maxY: 20 };
    expect(bboxIntersects(box, { x: 0, y: 0, width: 15, height: 15 })).toBe(true);
    expect(bboxIntersects(box, { x: 0, y: 0, width: 9, height: 9 })).toBe(false);
    expect(bboxIntersects(box, { x: 15, y: 15, width: 50, height: 50 })).toBe(true);
  });

  test("drawableModelIndices culls to rect and skips dead/hidden", () => {
    const p = pool();
    p.status[0] = (p.status[0] ?? 0) | ModelStatus.dead;
    const out: number[] = [];
    const n = drawableModelIndices(p, [0, 3], { x: 0, y: 0, width: 30, height: 13 }, out);
    expect(n).toBe(1); // (10,10) dead → skipped; (12,16) outside y; (14,12) inside
    expect(out).toEqual([1]);
  });

  test("strengthFraction counts alive models over full range", () => {
    const p = pool();
    p.hp[0] = 0;
    p.status[0] = (p.status[0] ?? 0) | ModelStatus.dead;
    expect(strengthFraction(p, [0, 3])).toBeCloseTo(2 / 3);
    expect(strengthFraction(p, null)).toBe(0);
  });
});

describe("drawableUnits (§9A)", () => {
  const faction = (id: string, color: string): FactionDocument =>
    ({
      _id: id,
      type: "faction",
      name: id,
      color,
      allies: [],
      ownership: { default: 0 },
      flags: {},
      system: {},
    }) as FactionDocument;
  const army = (id: string, factionId: string, range: [number, number] | null): ArmyDocument =>
    ({
      _id: id,
      type: "army",
      name: id === "army-r" ? "Red Host" : "Blue Host",
      ownership: { default: 0 },
      flags: {},
      system: {},
      factionId,
      commander: [],
      supply: { level: 5 },
      units: [
        {
          _id: id + "-u1",
          type: "infantry",
          name: "1st",
          ownership: { default: 0 },
          flags: {},
          system: {},
          profile: {},
          formation: "line",
          sceneId: null,
          modelRange: range,
          orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
          stats: { strength: 5 },
        },
      ],
    }) as unknown as ArmyDocument;

  test("derives color, army name and ranges", () => {
    const units = drawableUnits(
      [army("army-r", "f-red", [0, 10]), army("army-b", "f-blue", null)],
      [faction("f-red", "#c0392b"), faction("f-blue", "#2e6f9e")],
    );
    expect(units.length).toBe(2);
    const [u0, u1] = units;
    if (!u0 || !u1) throw new Error("expected two units");
    expect(u0).toMatchObject({
      id: "army-r-u1",
      armyId: "army-r",
      armyName: "Red Host",
      factionId: "f-red",
      color: 0xc0392b,
      modelRange: [0, 10],
    });
    expect(u1.modelRange).toBeNull();
    expect(u1.color).toBe(0x2e6f9e);
  });

  test("parseHexColor handles #rgb, #rrggbb and garbage", () => {
    expect(parseHexColor("#f00")).toBe(0xff0000);
    expect(parseHexColor("#2e6f9e")).toBe(0x2e6f9e);
    expect(parseHexColor("2e6f9e")).toBe(0x2e6f9e);
    expect(parseHexColor("nope", 0x123456)).toBe(0x123456);
  });
});
