import { describe, expect, test } from "vitest";
import {
  ORDER_TEMPLATES,
  armyCards,
  casualtySummary,
  eventsToCsv,
  filterReportEvents,
  filterRoster,
  flattenTree,
  moveUnitOps,
  rosterRows,
  sortRoster,
  windowRows,
} from "../../src/ui/armies/armyModel";
import type { ArmyDocument, FactionDocument, UnitDocument } from "../../src/core/strategic";
import type { SimEvent, TurnReport } from "../../src/core/sim";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { ModelStatus } from "../../src/core/strategic";

function unit(id: string, type: string, over: Partial<UnitDocument> = {}): UnitDocument {
  return {
    _id: id,
    type,
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    profile: {},
    formation: "line",
    sceneId: null,
    modelRange: null,
    orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
    stats: { strength: 10, morale: 5, supply: 5, fatigue: 0 },
    ...over,
  };
}

function army(id: string, factionId: string, units: UnitDocument[]): ArmyDocument {
  return {
    _id: id,
    type: "army",
    name: id === "army-r" ? "Red Host" : "Blue Host",
    ownership: { default: 0 },
    flags: {},
    system: {},
    factionId,
    commander: [],
    supply: { level: 4 },
    units,
  };
}

function faction(id: string, color: string): FactionDocument {
  return {
    _id: id,
    type: "faction",
    name: id.slice(2),
    color,
    allies: [],
    ownership: { default: 0 },
    flags: {},
    system: {},
  };
}

describe("armyCards (§10 Armies tab)", () => {
  test("aggregates strength, morale average and supply per army", () => {
    const units = [
      unit("u-1", "infantry", { stats: { strength: 30, morale: 4, supply: 5, fatigue: 0 } }),
      unit("u-2", "cavalry", { stats: { strength: 20, morale: 6, supply: 5, fatigue: 0 } }),
    ];
    const cards = armyCards([army("army-r", "f-red", units)], [faction("f-red", "#c0392b")]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      id: "army-r",
      name: "Red Host",
      factionName: "red",
      color: "#c0392b",
      unitCount: 2,
      strength: 50,
      morale: 5,
      supplyLevel: 4,
    });
  });
});

describe("flattenTree (§10 hierarchy)", () => {
  test("army → echelons by unit type (sorted) → units", () => {
    const rows = flattenTree(
      army("army-r", "f-red", [
        unit("u-inf-1", "infantry"),
        unit("u-cav-1", "cavalry"),
        unit("u-inf-2", "infantry"),
      ]),
    );
    expect(rows.map((r) => r.kind)).toEqual(["army", "echelon", "unit", "echelon", "unit", "unit"]);
    const echelon = rows[1];
    if (echelon?.kind !== "echelon") throw new Error("expected echelon");
    expect(echelon.type).toBe("cavalry"); // sorted: cavalry < infantry
    expect(echelon.count).toBe(1);
    const infantry = rows[3];
    if (infantry?.kind !== "echelon") throw new Error("expected echelon");
    expect(infantry.count).toBe(2);
    expect(infantry.strength).toBe(20);
  });
});

describe("moveUnitOps (§10 drag-drop reorg)", () => {
  test("cross-army move = delete + create under new parent, data carries over", () => {
    const u = unit("u-1", "infantry", { modelRange: [0, 10] });
    const ops = moveUnitOps(u, "army-r", "army-b");
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({
      kind: "delete",
      ref: { coll: "units", id: "u-1", parent: { coll: "armies", id: "army-r" } },
    });
    expect(ops[1]).toMatchObject({
      kind: "create",
      coll: "units",
      parent: { coll: "armies", id: "army-b" },
    });
    expect((ops[1] as unknown as { data: UnitDocument }).data.modelRange).toEqual([0, 10]);
    expect(moveUnitOps(u, "army-r", "army-r")).toEqual([]);
  });
});

describe("rosterRows (§10 roster grid)", () => {
  test("unit rows + expanded model rows from the replica; hidden collapse to gap", () => {
    const pool = createModelPool(8);
    for (let i = 0; i < 6; i++) {
      allocModel(pool, { id: 100 + i, unitIdx: 0, x: i, y: 2, hp: 1, hpMax: 1 });
    }
    pool.status[1] = (pool.status[1] ?? 0) | ModelStatus.hidden;
    pool.status[2] = (pool.status[2] ?? 0) | ModelStatus.dead;
    pool.hp[2] = 0;
    const u = unit("u-1", "infantry", { modelRange: [0, 6] });
    const rows = rosterRows(army("army-r", "f-red", [u]), pool, new Set(["u-1"]));
    expect(rows.filter((r) => r.kind === "unit").length).toBe(1);
    // live strength skips dead (hp 0) and hidden
    const unitRow = rows[0];
    if (unitRow?.kind !== "unit") throw new Error("expected unit row");
    expect(unitRow.liveStrength).toBe(4);
    const models = rows.filter((r) => r.kind === "model");
    expect(models).toHaveLength(5); // hidden collapsed; dead still listed (hp 0)
    const gaps = rows.filter((r) => r.kind === "modelGap");
    expect(gaps).toHaveLength(1);
    const gap = gaps[0];
    if (gap?.kind !== "modelGap") throw new Error("expected gap");
    expect(gap.hidden).toBe(1);
  });

  test("no replica → liveStrength null, no model rows", () => {
    const u = unit("u-1", "infantry", { modelRange: [0, 6] });
    const rows = rosterRows(army("army-r", "f-red", [u]), null, new Set(["u-1"]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("unit");
  });
});

describe("windowRows (virtualization math)", () => {
  test("windows with overscan and pads; small totals clamp", () => {
    const w = windowRows(10_000, 26 * 100, 320, 26);
    expect(w.start).toBe(100 - 6);
    expect(w.end).toBeGreaterThan(100);
    expect(w.padTop).toBe(w.start * 26);
    expect(w.padBottom).toBe((10_000 - w.end) * 26);
    expect(w.end - w.start).toBeLessThanOrEqual(Math.ceil(320 / 26) + 12);
    const tiny = windowRows(5, 0, 320, 26);
    expect(tiny).toMatchObject({ start: 0, end: 5, padTop: 0, padBottom: 0 });
    const neg = windowRows(10, -50, 320, 26); // overscroll bounce
    expect(neg.start).toBe(0);
  });
});

describe("sort/filter roster", () => {
  const units = [
    unit("u-b", "cavalry", {
      name: "Zeta",
      stats: { strength: 5, morale: 2, supply: 0, fatigue: 0 },
    }),
    unit("u-a", "infantry", {
      name: "Alpha",
      stats: { strength: 9, morale: 7, supply: 0, fatigue: 0 },
    }),
  ];
  const doc = army("army-r", "f-red", units);

  test("sort by key and direction; composes with filterRoster", () => {
    expect(sortRoster(doc.units, "name", 1).map((u) => u.name)).toEqual(["Alpha", "Zeta"]);
    expect(sortRoster(doc.units, "name", -1).map((u) => u.name)).toEqual(["Zeta", "Alpha"]);
    expect(sortRoster(doc.units, "strength", 1)[0]?.name).toBe("Zeta");
    expect(sortRoster(doc.units, "strength", -1)[0]?.name).toBe("Alpha");
    expect(sortRoster(doc.units, "type", 1)[0]?.type).toBe("cavalry");
    expect(sortRoster(filterRoster(doc, ""), "name", 1)).toHaveLength(2);
  });

  test("filter matches name and type, case-insensitive", () => {
    expect(filterRoster(doc, "zeta").map((u) => u._id)).toEqual(["u-b"]);
    expect(filterRoster(doc, "INFANTRY").map((u) => u._id)).toEqual(["u-a"]);
    expect(filterRoster(doc, "  ")).toHaveLength(2);
    expect(filterRoster(doc, "nope")).toHaveLength(0);
  });
});

describe("order templates (§10 order editor)", () => {
  test("advance builds a march move along facing; fall back retreats opposite", () => {
    const anchor = { x: 10, y: 10 };
    const advance = ORDER_TEMPLATES.find((t) => t.id === "advance");
    if (!advance) throw new Error("missing advance");
    const move = advance.build(anchor, 0);
    if (move.kind !== "move") throw new Error("expected move");
    expect(move.pace).toBe("march");
    expect(move.path[0]).toEqual({ x: 22, y: 10 });
    const back = ORDER_TEMPLATES.find((t) => t.id === "fallBack");
    if (!back) throw new Error("missing fallBack");
    const retreat = back.build(anchor, 90);
    if (retreat.kind !== "retreat") throw new Error("expected retreat");
    expect(retreat.toward).toEqual({ x: 10, y: -2 });
  });

  test("screen holds", () => {
    const screen = ORDER_TEMPLATES.find((t) => t.id === "screen");
    if (!screen) throw new Error("missing screen");
    expect(screen.build({ x: 0, y: 0 }, 0)).toEqual({ kind: "hold", stance: "screen" });
  });
});

describe("reports tab data (§10)", () => {
  const events: SimEvent[] = [
    {
      subPhase: "melee",
      type: "attack",
      unitId: "u-1",
      targetUnitId: "u-9",
      text: "charge, 3 kills",
    },
    { subPhase: "melee", type: "casualty", unitId: "u-9", text: "lost 4", data: { count: 4 } },
    { subPhase: "morale", type: "rout", unitId: "u-9", text: "breaks" },
    { subPhase: "move", type: "arrive", unitId: "u-2", text: 'at "the mill"' },
  ];
  const report: TurnReport = {
    turn: 3,
    sceneId: "sc",
    subPhases: ["move", "melee", "morale"],
    events,
    summary: {},
    rulesVersion: "1",
  };

  test("filter by unit (subject or target) and type", () => {
    expect(filterReportEvents(report, { unitId: "u-9" })).toHaveLength(3); // attack(target), casualty, rout
    expect(filterReportEvents(report, { unitId: "u-1" })).toHaveLength(1);
    expect(filterReportEvents(report, { type: "attack" })).toHaveLength(1);
    expect(filterReportEvents(report, {})).toHaveLength(4);
  });

  test("casualty summary counts casualties/routs/attacks", () => {
    expect(casualtySummary(events)).toEqual({ casualties: 4, routed: 1, attacks: 1 });
  });

  test("CSV export quotes RFC-4180 style", () => {
    const csv = eventsToCsv(events);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("turn,subPhase,type,unitId,targetUnitId,text");
    expect(lines[1]).toBe('melee,attack,u-1,u-9,"charge, 3 kills"'); // comma inside text → quoted
    expect(csv).toContain('"at ""the mill"""'); // embedded quotes doubled
    expect(csv).toContain("melee,casualty,u-9,,lost 4");
  });
});
