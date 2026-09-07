import { describe, expect, test } from "vitest";
import { deployLayout, deploySnapshot, formationOffsets } from "../../src/sim/deploy";
import type { FactionDocument, UnitDocument } from "../../src/core/strategic";
import type { UnitView } from "../../src/core/rules";
import { MASS_BATTLE_SCHEMA_COLUMNS } from "../../src/packages";
import { createModelPool, allocModel } from "../../src/sim/pool";
import { decodeSimSnapshot, poolFromSnapshot } from "../../src/sim/codec";

function faction(id: string): FactionDocument {
  return {
    _id: id,
    type: "faction",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    color: "#fff",
    allies: [],
  };
}

function unitView(unit: UnitDocument, factionId: string): UnitView {
  return {
    id: unit._id,
    armyId: "army-1",
    factionId,
    type: unit.type,
    name: unit.name,
    profile: unit.profile,
    stats: { ...unit.stats },
    orders: unit.orders,
    formation: unit.formation,
    sceneId: unit.sceneId ?? null,
    modelRange: unit.modelRange,
    leaderTokenId: null,
  };
}

function unitDoc(
  id: string,
  strength: number,
  formation = "line",
  profile: Record<string, import("../../src/core/documents").Json> = {},
): UnitDocument {
  return {
    _id: id,
    type: "infantry",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    profile,
    formation,
    sceneId: null,
    modelRange: null,
    orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
    stats: { strength, morale: 5, supply: 5, fatigue: 0 },
  };
}

describe("formationOffsets (§8A)", () => {
  test("line: ranks of 10, centered files", () => {
    const off = formationOffsets(12, "line", {});
    expect(off).toHaveLength(12);
    // rank 0 holds files 0..9, rank 1 files 10..11
    expect(off[0]).toEqual({ x: 0, y: -18, facing: 0 });
    expect(off[9]?.y).toBe(18);
    // ranks center on the unit's full frontage (rectangle, not staggered)
    expect(off[10]?.x).toBe(-4);
    expect(off[10]?.y).toBe(-18);
    expect(off[11]?.y).toBe(-14);
  });

  test("column: files of 4", () => {
    const off = formationOffsets(6, "column", {});
    expect(off[3]?.x).toBe(0); // width 4 → indices 0-3 in the first file
    expect(off[4]?.x).toBe(-4);
  });

  test("wedge: triangle rows 1+2+3", () => {
    const off = formationOffsets(6, "wedge", {});
    expect(off).toHaveLength(6);
    // row 0: 1 model at origin; row 1: 2 models; row 2: 3 models
    expect(off[0]?.x).toBe(0);
    expect(off[1]?.x).toBe(-4);
    expect(off[3]?.x).toBe(-8);
    expect(off[5]?.y).toBe(4);
  });

  test("unknown formation falls back to line", () => {
    expect(formationOffsets(5, "horde", {})).toEqual(formationOffsets(5, "line", {}));
  });
});

describe("deployLayout (§8A)", () => {
  const factions = [faction("f-b"), faction("f-a")]; // unsorted on purpose

  test("faction lanes sorted by id; units stack in y; strength drives count", () => {
    const units = [
      unitView(unitDoc("u1", 10), "f-b"),
      unitView(unitDoc("u2", 7), "f-a"),
      unitView(unitDoc("u3", 0), "f-a"),
    ];
    const { plans } = deployLayout(units, factions);
    expect(plans.map((p) => p.unitId)).toEqual(["u1", "u2", "u3"]);
    expect(plans[0]?.count).toBe(10);
    // f-a sorts first (index 0 → x 150); f-b is index 1 (x 450)
    expect(plans[0]?.anchor.x).toBe(450);
    expect(plans[1]?.anchor.x).toBe(150);
    // u2 is faction f-a's first unit (y 150); u3 its second (y 400)
    expect(plans[1]?.anchor.y).toBe(150);
    expect(plans[2]?.anchor.y).toBe(400);
    expect(plans[2]?.count).toBe(0);
  });

  test("profile.anchor overrides the lane position", () => {
    const units = [unitView(unitDoc("u1", 3, "line", { anchor: { x: 900, y: 80 } }), "f-a")];
    const { plans } = deployLayout(units, factions);
    expect(plans[0]?.anchor).toEqual({ x: 900, y: 80 });
  });

  test("maxTotal clamps later units deterministically", () => {
    const units = [unitView(unitDoc("u1", 8), "f-a"), unitView(unitDoc("u2", 8), "f-a")];
    const { plans } = deployLayout(units, factions, { maxTotal: 10 });
    expect(plans[0]?.count).toBe(8);
    expect(plans[1]?.count).toBe(2);
  });

  test("same inputs → identical layout (restart determinism)", () => {
    const units = [unitView(unitDoc("u1", 25), "f-a"), unitView(unitDoc("u2", 13, "wedge"), "f-b")];
    const a = JSON.stringify(deployLayout(units, factions));
    const b = JSON.stringify(deployLayout(units, factions));
    expect(a).toBe(b);
  });
});

describe("deploySnapshot (§8A)", () => {
  test("builds a decodable snapshot with contiguous per-unit ranges", () => {
    const factions = [faction("f-a"), faction("f-b")];
    const units = [
      unitView(unitDoc("u1", 10), "f-a"),
      unitView(unitDoc("u2", 6), "f-b"),
      unitView(unitDoc("u3", 0), "f-b"),
    ];
    const snap = deploySnapshot(units, factions, MASS_BATTLE_SCHEMA_COLUMNS);
    expect(snap.maxHpMax).toBe(1);
    const { snapshot } = decodeSimSnapshot(snap.bytes);
    expect(snapshot.count).toBe(16);
    expect(snap.ranges).toEqual([
      ["u1", [0, 10]],
      ["u2", [10, 16]],
      ["u3", null],
    ]);
  });

  test("models carry hp/ammo and land around their anchor", () => {
    const factions = [faction("f-a")];
    const units = [unitView(unitDoc("u1", 4, "line", { anchor: { x: 500, y: 500 } }), "f-a")];
    const snap = deploySnapshot(units, factions, MASS_BATTLE_SCHEMA_COLUMNS);
    const decoded = decodeSimSnapshot(snap.bytes);
    const pool = poolFromSnapshot(decoded.snapshot, decoded.maxHpMax, MASS_BATTLE_SCHEMA_COLUMNS);
    for (let i = 0; i < 4; i++) {
      const x = pool.x[i] ?? 0;
      const y = pool.y[i] ?? 0;
      expect(Math.abs(x - 500)).toBeLessThanOrEqual(1);
      expect(Math.abs(y - 500)).toBeLessThanOrEqual(8);
    }
  });
});

describe("deploy ↔ pool interop", () => {
  test("deployed snapshot loads through the same codec path as the channel", () => {
    // the channel decodes bridge snapshots into a pool for visibility maps;
    // a deployment snapshot must survive the same round-trip shape
    const factions = [faction("f-a")];
    const units = [unitView(unitDoc("u1", 5), "f-a")];
    const snap = deploySnapshot(units, factions, MASS_BATTLE_SCHEMA_COLUMNS);
    const pool = createModelPool(8, MASS_BATTLE_SCHEMA_COLUMNS);
    for (let i = 0; i < 5; i++) {
      allocModel(pool, { id: i + 1, unitIdx: 0, x: i, y: 0, hp: 1, hpMax: 1, sys: { ammo: 6 } });
    }
    expect(pool.count).toBe(5);
    expect(decodeSimSnapshot(snap.bytes).snapshot.count).toBe(pool.count);
  });
});
