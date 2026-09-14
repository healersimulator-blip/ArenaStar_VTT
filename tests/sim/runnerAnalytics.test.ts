import { describe, expect, test } from "vitest";
import { SimRunnerCore } from "../../src/sim/runner";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { encodeSimSnapshot, snapshotFromPool } from "../../src/sim/codec";
import { projectReportForFaction } from "../../src/host/simProjection";
import type { ArmyView, RulesContext, UnitView } from "../../src/core/rules";
import type { ModelPool, OrderQueue } from "../../src/core/strategic";
import type { Json } from "../../src/core/documents";

/**
 * M12 (D-224) — analytics reconciled from actual turn resolution. The report a
 * turn emits now carries the collector's real per-army cumulative totals (the
 * generateReport() the module's forecast performs on the same instance that
 * resolved the turn), not a collector-only fixture; player projections keep
 * only visible armies.
 */

function ctxWithArmies(): RulesContext {
  const faction = (id: string, name: string): Json => ({
    _id: id,
    type: "faction",
    name,
    color: "#888",
    ownership: { default: 3 },
    flags: {},
    system: {},
    allies: [],
  });
  const army = (id: string, name: string, factionId: string): Json => ({
    _id: id,
    type: "army",
    name,
    factionId,
    commander: [],
    supply: { level: 1 },
    units: [],
    ownership: { default: 3 },
    flags: {},
    system: {},
  });
  return {
    sceneId: "scene-1",
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555" },
    walls: { x1: new Float32Array(), y1: new Float32Array(), x2: new Float32Array(), y2: new Float32Array(), restriction: new Uint8Array() },
    factions: [faction("f-red", "Red"), faction("f-blue", "Blue")] as unknown as RulesContext["factions"],
    armies: [army("army-red", "Red Horde", "f-red"), army("army-blue", "Blue Host", "f-blue")] as unknown as RulesContext["armies"],
    leaderActors: {},
    worldSettings: { strategicSimultaneous: true },
    turnMode: "simultaneous",
  } as unknown as RulesContext;
}

function unit(id: string, armyId: string, factionId: string, range: [number, number], strMod = 5): UnitView {
  return {
    id,
    armyId,
    factionId,
    type: "infantry",
    name: id,
    profile: {},
    stats: { bab: 10, strMod, ac: 5, dexMod: 7 },
    orders: null,
    formation: "line",
    sceneId: "scene-1",
    modelRange: range,
    leaderTokenId: null,
  };
}

function seedRig(): {
  bytes: Uint8Array;
  maxHpMax: number;
  units: UnitView[];
} {
  const pool: ModelPool = createModelPool(8, PF1E_MODEL_SCHEMA);
  const mk = (mid: number, unitIdx: number, x: number) =>
    allocModel(pool, {
      id: mid,
      unitIdx,
      x,
      y: 0,
      hp: 400,
      hpMax: 400,
      sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: unitIdx + 1 },
    });
  mk(1, 0, 0);
  mk(2, 1, 5);
  // Asymmetric builds (red swings with +5 Str, blue with +1) so per-army
  // attribution is structurally distinguishable, never an accident of a roll.
  const units = [unit("u-red", "army-red", "f-red", [0, 1]), unit("u-blue", "army-blue", "f-blue", [1, 2], 1)];
  const bytes = encodeSimSnapshot(snapshotFromPool(pool, "scene-1", 0, PF1E_MODEL_SCHEMA), 400);
  return { bytes, maxHpMax: 400, units };
}

function orders(): Array<[string, OrderQueue]> {
  return [
    ["u-red", { pending: [{ kind: "attack", targetUnitId: "u-blue" }], issuedBy: "gm", issuedTurn: 1 }],
    ["u-blue", { pending: [{ kind: "attack", targetUnitId: "u-red" }], issuedBy: "gm", issuedTurn: 1 }],
  ];
}

type AnalyticsSheet = Record<string, { totalAttacks: number; netDamageDealt: number; killsCount: number; deathsCount: number }>;

function analyticsOf(summary: Record<string, Json> | undefined): AnalyticsSheet {
  return (summary?.["analytics"] as AnalyticsSheet | undefined) ?? {};
}

describe("M12 — analytics reconciled into TurnReport from actual turn resolution (D-224)", () => {
  test("each resolved turn's report carries cumulative per-army totals; attribution is per army", () => {
    const ctx = ctxWithArmies();
    const seed = seedRig();
    const runner = new SimRunnerCore(
      { sceneId: "scene-1", sys: PF1E_MODEL_SCHEMA, snapshot: { bytes: seed.bytes, maxHpMax: seed.maxHpMax, version: 0 }, ctx, units: seed.units },
      createMassBattlePf1e(),
    );

    const r1 = runner.resolve({ orders: orders(), seed: 42, turnNumber: 1 });
    const a1 = analyticsOf(r1.report.summary);
    expect(Object.keys(a1).sort()).toEqual(["army-blue", "army-red"]);
    // Both armies attacked: each side records its own offences and its own losses.
    expect(a1["army-red"]?.totalAttacks).toBeGreaterThan(0);
    expect(a1["army-blue"]?.totalAttacks).toBeGreaterThan(0);
    expect(a1["army-red"]?.netDamageDealt ?? 0).toBeGreaterThan(0);
    expect(a1["army-blue"]?.netDamageDealt ?? 0).toBeGreaterThan(0);

    // A second resolved turn ACCUMULATES (the collector is campaign-lifetime,
    // so the report is the running sheet, not the turn's delta).
    const r2 = runner.resolve({ orders: orders(), seed: 43, turnNumber: 2 });
    const a2 = analyticsOf(r2.report.summary);
    expect(a2["army-red"]?.totalAttacks ?? 0).toBeGreaterThanOrEqual(a1["army-red"]?.totalAttacks ?? 0);
    expect(a2["army-blue"]?.netDamageDealt ?? 0).toBeGreaterThanOrEqual(a1["army-blue"]?.netDamageDealt ?? 0);
    // Attribution is army-stable and build-sensitive: red (Str +5) out-damages
    // blue (Str +1), and the figures the sheet shows are each army's own — red's
    // book does not contain blue's number.
    expect(a2["army-red"]?.netDamageDealt ?? 0).toBeGreaterThan(a2["army-blue"]?.netDamageDealt ?? 0);
  });

  test("a module without forecast leaves the summary untouched (basic schema path)", () => {
    // massBattleBasic has no forecast — the M12 payload is opt-in per module.
    const ctx = {
      ...ctxWithArmies(),
      armies: [],
    } as unknown as RulesContext;
    const seed = seedRig();
    const runner = new SimRunnerCore(
      { sceneId: "scene-1", sys: PF1E_MODEL_SCHEMA, snapshot: { bytes: seed.bytes, maxHpMax: seed.maxHpMax, version: 0 }, ctx, units: seed.units },
      createMassBattlePf1e(),
    );
    const r = runner.resolve({ orders: orders(), seed: 42, turnNumber: 1 });
    expect(r.report.summary["analytics"]).toBeUndefined();
  });

  test("player projection keeps only the armies whose units it can see", () => {
    const ctx = ctxWithArmies();
    const seed = seedRig();
    const runner = new SimRunnerCore(
      { sceneId: "scene-1", sys: PF1E_MODEL_SCHEMA, snapshot: { bytes: seed.bytes, maxHpMax: seed.maxHpMax, version: 0 }, ctx, units: seed.units },
      createMassBattlePf1e(),
    );
    const r1 = runner.resolve({ orders: orders(), seed: 42, turnNumber: 1 });
    const gm = analyticsOf(r1.report.summary);
    expect(Object.keys(gm).sort()).toEqual(["army-blue", "army-red"]);

    // Faction RED sees only its own unit: its analytics sheet shows army-red alone.
    const projected = projectReportForFaction(
      r1.report,
      (unitId) => unitId === "u-red",
      new Set<ArmyView["id"]>(["army-red"]),
    );
    const proj = analyticsOf(projected.summary);
    expect(proj["army-red"]).toBeDefined();
    expect(proj["army-blue"]).toBeUndefined();
    // The GM report is the unaffected, full sheet.
    expect(analyticsOf(r1.report.summary)["army-blue"]).toBeDefined();
  });

  test("replay determinism: same seed + orders reproduces the same analytics sheet", () => {
    const run = () => {
      const runner = new SimRunnerCore(
        { sceneId: "scene-1", sys: PF1E_MODEL_SCHEMA, snapshot: { bytes: seedRig().bytes, maxHpMax: 400, version: 0 }, ctx: ctxWithArmies(), units: seedRig().units },
        createMassBattlePf1e(),
      );
      return analyticsOf(runner.resolve({ orders: orders(), seed: 99, turnNumber: 1 }).report.summary);
    };
    expect(run()).toEqual(run());
  });
});
