import { describe, expect, test } from "vitest";
import { createMassBattlePf1e, casterInputsFromLeaderActor, PF1E_MASS_SPELLS, DEFAULT_MASS_SPELL_ID, type MassBattlePf1eOptions } from "../../src/packages/massBattlePf1e";
import { PF1E_STATUS_FLANKED } from "../../src/packages/pf1e/envelopment";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { createModelPool, allocModel } from "../../src/sim/pool";
import { ModelStatus } from "../../src/core/strategic";
import { XoshiroPRNG } from "../../src/sim/prng";
import type { RulesContext, UnitView, ArmyView } from "../../src/core/rules";
import type { OrderQueue } from "../../src/core/strategic";
import type { SimEvent } from "../../src/core/sim";

/** Shared RulesContext for the spell tests; `wall` adds one sight-blocking segment. */
function spellCtx(wall?: { x1: number; y1: number; x2: number; y2: number }, restriction = 2): RulesContext {
  return {
    sceneId: "scene-1",
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555" },
    walls: wall
      ? { x1: new Float32Array([wall.x1]), y1: new Float32Array([wall.y1]), x2: new Float32Array([wall.x2]), y2: new Float32Array([wall.y2]), restriction: new Uint8Array([restriction]) }
      : { x1: new Float32Array(), y1: new Float32Array(), x2: new Float32Array(), y2: new Float32Array(), restriction: new Uint8Array() },
    factions: [{ _id: "f0", type: "faction", name: "Red", color: "#ff0000", ownership: { default: 3 }, flags: {}, system: {}, allies: [] }, { _id: "f1", type: "faction", name: "Blue", color: "#0000ff", ownership: { default: 3 }, flags: {}, system: {}, allies: [] }],
    armies: [],
    leaderActors: {},
    worldSettings: {},
  };
}

/**
 * Shared battlefield: the caster's model at (10,10), two enemy models near it
 * ((16,10), (10,27)) and one far away ((90,90)). The (10,27) model is 17 ft out — inside
 * the pack's 20-ft spread, outside any old 15-ft literal. Both enemies sit beyond the
 * 5-ft threat range, so these casts stay unprovoked; the D-170 test builds its own
 * battlefield with an adjacent enemy to exercise defensive casting.
 */
function spellBattlefield(pool: ReturnType<typeof createModelPool>): void {
  allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 60, hpMax: 60, sys: { ac: 16, touchAc: 12, fort: 4, ref: 2, will: 1, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
  allocModel(pool, { id: 2, unitIdx: 1, x: 16, y: 10, hp: 60, hpMax: 60, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
  allocModel(pool, { id: 3, unitIdx: 1, x: 10, y: 27, hp: 60, hpMax: 60, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
  allocModel(pool, { id: 4, unitIdx: 1, x: 90, y: 90, hp: 60, hpMax: 60, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
}

/** The casting unit's stats drive caster level and the DC's key-ability modifier. */
function spellUnits(casterStats: Record<string, number>): UnitView[] {
  return [
    { id: "u0", armyId: "a0", factionId: "f0", type: "artillery", name: "Red Wizards", profile: {}, stats: { bab: 3, strMod: 0, ac: 12, ...casterStats }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
    { id: "u1", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue Infantry", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 4], leaderTokenId: null },
  ];
}

/** Resolve one spell_aoe order with the given payload and return the events. */
function castWithPayload(casterStats: Record<string, number>, data: unknown, ctx: RulesContext = spellCtx(), moduleOpts: MassBattlePf1eOptions = {}): SimEvent[] {
  const rules = createMassBattlePf1e(moduleOpts);
  const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
  spellBattlefield(pool);
  const units = spellUnits(casterStats);
  const orders = new Map<string, OrderQueue>();
  orders.set("u0", { issuedBy: "u0", issuedTurn: 1, pending: [], active: { kind: "custom", type: "spell_aoe", data } });
  const events: SimEvent[] = [];
  rules.resolveTurn(ctx, pool, units, orders, new XoshiroPRNG(1234), (ev) => events.push(ev));
  return events;
}

/** A synthetic 30-ft cone entry (CRB p.214 geometry), injected until a pack ships one. */
const CONE_ENTRY = {
  name: "Test Cone",
  system: {
    savingThrow: "Reflex half",
    spellResistance: false,
    massBattle: { shape: "cone", radiusFeet: 30, saveType: "ref", halfOnSave: true, damageDiceCount: 2, damageDiceSides: 6 },
  },
} as const;

describe("createMassBattlePf1e System Package (§12 / Task 9)", () => {
  test("instantiates RulesModule and resolves a turn with PF1e combat analytics", () => {
    const rules = createMassBattlePf1e();
    expect(rules.schema.version).toBe("1.0.0");
    expect(rules.schema.modelColumns).toEqual(PF1E_MODEL_SCHEMA);

    const pool = createModelPool(20, PF1E_MODEL_SCHEMA);

    // Unit 0: Attacker
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 16, touchAc: 12, fort: 4, ref: 2, will: 1, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 0, x: 1, y: 0, hp: 20, hpMax: 20, sys: { ac: 16, touchAc: 12, fort: 4, ref: 2, will: 1, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });

    // Unit 1: Defender
    allocModel(pool, { id: 3, unitIdx: 1, x: 0, y: 1, hp: 15, hpMax: 15, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 2, profileIdx: 2 } });
    allocModel(pool, { id: 4, unitIdx: 1, x: 1, y: 1, hp: 15, hpMax: 15, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 2, profileIdx: 2 } });

    const units: UnitView[] = [
      { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Red Infantry", profile: {}, stats: { bab: 6, strMod: 3, ac: 16 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 2], leaderTokenId: null },
      { id: "u1", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue Infantry", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [2, 4], leaderTokenId: null },
    ];

    const orders = new Map<string, OrderQueue>();
    orders.set("u0", {
      issuedBy: "u0",
      issuedTurn: 1,
      pending: [{ kind: "attack", targetUnitId: "u1" }],
      active: { kind: "attack", targetUnitId: "u1" },
    });

    const ctx: RulesContext = {
      sceneId: "scene-1",
      grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555" },
      walls: { x1: new Float32Array(), y1: new Float32Array(), x2: new Float32Array(), y2: new Float32Array(), restriction: new Uint8Array() },
      factions: [{ _id: "f0", type: "faction", name: "Red", color: "#ff0000", ownership: { default: 3 }, flags: {}, system: {}, allies: [] }, { _id: "f1", type: "faction", name: "Blue", color: "#0000ff", ownership: { default: 3 }, flags: {}, system: {}, allies: [] }],
      armies: [],
      leaderActors: {},
      worldSettings: {},
    };

    const rng = new XoshiroPRNG(12345);
    const events: SimEvent[] = [];

    rules.resolveTurn(ctx, pool, units, orders, rng, (ev) => events.push(ev));

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.text).toContain("attacks");
  });

  test("the AOE order is built from the pack and the profile, not from literals (D-2)", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
    // The (10,27) model is 17 ft out — inside the pack's 20-ft spread but outside the old
    // hard-coded 15 ft. It makes this test fail if the call site goes back to a literal.
    spellBattlefield(pool);
    const units = spellUnits({ casterLevel: 5, castingStatMod: 4 });

    const orders = new Map<string, OrderQueue>();
    // The point of origin rides the order (C05): this cast targets (10,10).
    orders.set("u0", { issuedBy: "u0", issuedTurn: 1, pending: [], active: { kind: "custom", type: "spell_aoe", data: { x: 10, y: 10 } } });

    const events: SimEvent[] = [];
    rules.resolveTurn(spellCtx(), pool, units, orders, new XoshiroPRNG(1234), (ev) => events.push(ev));

    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect(cast).toBeDefined();
    const data = cast?.data as Record<string, unknown>;
    // Reported parameters, i.e. the order was built from the pack…
    expect(data.spellName).toBe("Fireball");
    expect(data.spellRadius).toBe(20); // pack: "20-ft.-radius spread" (CRB p.283)
    expect(data.spellDice).toBe("5d6"); // 1d6/level at CL 5, capped at 10d6
    // …and the caster inputs from the profile…
    expect(data.casterLevel).toBe(5);
    expect(data.spellDc).toBe(17); // 10 + spell level 3 + key mod 4, via spellSaveDc
    // …and the location/range from the order and the pack's range category.
    expect(data.epicenterX).toBe(10);
    expect(data.epicenterY).toBe(10);
    expect(data.rangeCategory).toBe("long");
    expect(data.rangeFeet).toBe(600); // 400 ft. + 40 ft./level at CL 5 (CRB p.213)
    // And the resolution actually used them: three models are in a 20-ft spread, where a
    // 15-ft literal would have reached only two.
    expect(data.modelsTargeted).toBe(3);
    expect((data.savesPassed as number) + (data.savesFailed as number)).toBe(3);
    expect((data.damageDealt as number) > 0).toBe(true);
  });

  test("the point of origin is order-driven, not a fixed constant (C05)", () => {
    // The same battlefield, but the order aims at the lone far model at (90,90): only
    // that model is within the 20-ft spread. If the origin regressed to a fixed (10,10),
    // three models would be targeted instead of one.
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 90, y: 90 });
    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect(cast).toBeDefined();
    const data = cast?.data as Record<string, unknown>;
    expect(data.epicenterX).toBe(90);
    expect(data.epicenterY).toBe(90);
    expect(data.modelsTargeted).toBe(1);
  });

  test("caster level and DC come from the casting unit's profile, not a demo constant (C05)", () => {
    // CL 7 scales the dice to 7d6 (still under the 10d6 cap) and the long range to
    // 680 ft; key modifier +2 sets the DC. A regression to the old constants would report
    // 5d6, DC 17 and 600 ft.
    const events = castWithPayload({ casterLevel: 7, castingStatMod: 2 }, { x: 10, y: 10 });
    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect(cast).toBeDefined();
    const data = cast?.data as Record<string, unknown>;
    expect(data.spellDice).toBe("7d6");
    expect(data.casterLevel).toBe(7);
    expect(data.spellDc).toBe(15); // 10 + spell level 3 + key mod 2
    expect(data.rangeFeet).toBe(680);
  });

  test("the area's outcome is attributed per owning unit, friendly fire included (M11)", () => {
    // Epicenter (10,10): u0's own model sits at ground zero (friendly fire is rules-
    // correct for an Area spell) and two of u1's models are in the 20-ft spread. The
    // per-unit breakdown must reconstruct the aggregate.
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 10, y: 10 });
    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect(cast).toBeDefined();
    const data = cast?.data as Record<string, unknown>;
    const hits = data.hitsByUnit as Record<string, { modelsHit: number; damageDealt: number; kills: number }>;
    expect(Object.keys(hits).sort()).toEqual(["u0", "u1"]);
    expect(hits["u0"]?.modelsHit).toBe(1); // the caster's own model at (10,10)
    expect(hits["u1"]?.modelsHit).toBe(2); // (12,10) and (10,27); (90,90) is out
    const totalModels = (hits["u0"]?.modelsHit ?? 0) + (hits["u1"]?.modelsHit ?? 0);
    const totalDamage = (hits["u0"]?.damageDealt ?? 0) + (hits["u1"]?.damageDealt ?? 0);
    const totalKills = (hits["u0"]?.kills ?? 0) + (hits["u1"]?.kills ?? 0);
    expect(totalModels).toBe(data.modelsTargeted);
    expect(totalDamage).toBe(data.damageDealt);
    expect(totalKills).toBe(data.killsCount);
  });

  test("a point of origin beyond the pack range is refused by name (C05)", () => {
    // Anchor at (10,10), CL 5 long range = 600 ft. (10,700) is 690 ft out — beyond range.
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 10, y: 700 });
    const refused = events.find((e) => e.subPhase === "spell" && e.type === "spellRefused");
    expect(refused).toBeDefined();
    expect((refused?.data as Record<string, unknown>).refusal).toBe("out_of_range");
    expect(refused?.text).toContain("beyond");
    expect(events.some((e) => e.subPhase === "spell" && e.type === "spell")).toBe(false);
  });

  test("a point of origin exactly at the range limit still casts (C05)", () => {
    // 600 ft is exactly the CL 5 long range: the limit is inclusive.
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 10, y: 610 });
    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect(cast).toBeDefined();
    const data = cast?.data as Record<string, unknown>;
    expect(data.modelsTargeted).toBe(0); // nothing lives that far away, but the cast stands
  });

  test("a move order translates the formation within the turn's movement budget (M05/D-173)", () => {
    // Infantry move 4 × 5-ft grid cell = 20 ft per turn (march). The formation keeps its
    // spacing: both models translate by the anchor's delta; a unit without a move order
    // stays put.
    const rules = createMassBattlePf1e();
    const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 0, x: 12, y: 10, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 3, unitIdx: 1, x: 60, y: 10, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    const units: UnitView[] = [
      { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Red Infantry", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 2], leaderTokenId: null },
      { id: "u1", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue Infantry", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [2, 3], leaderTokenId: null },
    ];
    const orders = new Map<string, OrderQueue>();
    orders.set("u0", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "move", path: [{ x: 90, y: 10 }], pace: "march" } });
    const events: SimEvent[] = [];
    rules.resolveTurn(spellCtx(), pool, units, orders, new XoshiroPRNG(3), (ev) => events.push(ev));

    expect(pool.x[0]).toBe(30); // anchor: 10 + 20 ft budget, path not exhausted
    expect(pool.y[0]).toBe(10);
    expect(pool.x[1]).toBe(32); // spacing preserved
    expect(pool.x[2]).toBe(60); // no order → no movement

    const arrive = events.find((e) => e.subPhase === "move" && e.type === "arrive");
    expect(arrive).toBeDefined();
    const data = arrive?.data as Record<string, unknown>;
    expect(data.pace).toBe("march");
    expect(data.distance).toBe(20);
    expect(arrive?.at).toEqual({ x: 30, y: 10 });
  });

  test("movement consumes waypoints in order and honours the SRD pace multipliers (M05/D-173)", () => {
    // R02 (CRB Movement/Run/Charge): a round's move covers your speed, charge "up to
    // twice your speed", run "up to four times your speed". Cavalry move 8 → 40 ft per
    // cell-scaled turn at march; 80 charge; 160 run.
    const runPace = (pace: "march" | "run" | "charge"): { x: number; distance: unknown } => {
      const rules = createMassBattlePf1e();
      const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
      allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
      const units: UnitView[] = [
        { id: "u0", armyId: "a0", factionId: "f0", type: "cavalry", name: "Riders", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
      ];
      const orders = new Map<string, OrderQueue>();
      orders.set("u0", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "move", path: [{ x: 1000, y: 0 }], pace } });
      const events: SimEvent[] = [];
      rules.resolveTurn(spellCtx(), pool, units, orders, new XoshiroPRNG(3), (ev) => events.push(ev));
      const data = events.find((e) => e.type === "arrive")?.data as Record<string, unknown>;
      return { x: pool.x[0] ?? -1, distance: data?.distance };
    };
    expect(runPace("march").x).toBe(40);
    expect(runPace("charge").x).toBe(80);
    const run = runPace("run");
    expect(run.x).toBe(160);
    expect(run.distance).toBe(160);

    // Waypoints consume the budget in order: infantry (20 ft) reaches the first waypoint
    // exactly and has nothing left for the second leg.
    const rules = createMassBattlePf1e();
    const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    const units: UnitView[] = [
      { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Walkers", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
    ];
    const orders = new Map<string, OrderQueue>();
    orders.set("u0", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "move", path: [{ x: 20, y: 0 }, { x: 20, y: 50 }], pace: "march" } });
    rules.resolveTurn(spellCtx(), pool, units, orders, new XoshiroPRNG(3), () => {});
    expect(pool.x[0]).toBe(20);
    expect(pool.y[0]).toBe(0);
  });

  test("movement leaves the dead where they fell and skips units with no living models (M05/D-173)", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 0, x: 2, y: 0, hp: 0, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 3, unitIdx: 1, x: 5, y: 0, hp: 0, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    pool.status[1] = (pool.status[1] ?? 0) | ModelStatus.dead;
    pool.status[2] = (pool.status[2] ?? 0) | ModelStatus.dead;
    const units: UnitView[] = [
      { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Red", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 2], leaderTokenId: null },
      { id: "u1", armyId: "a1", factionId: "f1", type: "infantry", name: "Gone", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [2, 3], leaderTokenId: null },
    ];
    const orders = new Map<string, OrderQueue>();
    orders.set("u0", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "move", path: [{ x: 100, y: 0 }], pace: "march" } });
    orders.set("u1", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "move", path: [{ x: 0, y: 100 }], pace: "march" } });
    const events: SimEvent[] = [];
    rules.resolveTurn(spellCtx(), pool, units, orders, new XoshiroPRNG(3), (ev) => events.push(ev));

    expect(pool.x[0]).toBe(20); // the living model moved
    expect(pool.x[1]).toBe(2); // the dead model stayed
    expect(pool.x[2]).toBe(5); // an all-dead unit never moves
    const arrivals = events.filter((e) => e.type === "arrive").map((e) => e.unitId);
    expect(arrivals).toEqual(["u0"]);
  });

  test("validateOrder names NaN waypoints and accepts a finite path (M05/D-173)", () => {
    const rules = createMassBattlePf1e();
    const unit = spellUnits({})[0] as UnitView;
    expect(rules.validateOrder(spellCtx(), unit, { kind: "move", path: [], pace: "march" }).ok).toBe(false);
    expect(rules.validateOrder(spellCtx(), unit, { kind: "move", path: [{ x: Number.NaN, y: 0 }], pace: "march" }).ok).toBe(false);
    expect(rules.validateOrder(spellCtx(), unit, { kind: "move", path: [{ x: 10, y: 0 }], pace: "march" })).toEqual({ ok: true });
  });

  test("movement stops at movement-blocking walls, and sight-only walls never block (M05/D-174)", () => {
    // The §0 wall contract: restriction bit 0 blocks movement, bit 1 blocks sight only.
    // Infantry marching from x=10 toward x=90 (budget 20 → would end at 30) meets a
    // wall at x=25: it stops just short of the wall and reports the block.
    const run = (restriction: number): { x: number | undefined; data: Record<string, unknown> } => {
      const rules = createMassBattlePf1e();
      const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
      allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
      const units: UnitView[] = [
        { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Red", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
      ];
      const orders = new Map<string, OrderQueue>();
      orders.set("u0", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "move", path: [{ x: 90, y: 10 }], pace: "march" } });
      const events: SimEvent[] = [];
      rules.resolveTurn(spellCtx({ x1: 25, y1: -100, x2: 25, y2: 200 }, restriction), pool, units, orders, new XoshiroPRNG(3), (ev) => events.push(ev));
      return { x: pool.x[0], data: (events.find((e) => e.type === "arrive")?.data ?? {}) as Record<string, unknown> };
    };

    const blocked = run(1); // move-blocking
    expect(blocked.x).toBeCloseTo(24.999, 3);
    expect(blocked.data.distance).toBe(15); // 14.999 ft traveled, emitted rounded to 2 dp
    expect(blocked.data.blockedByWall).toBe(true);

    const clear = run(2); // sight-only: march proceeds to the budget limit
    expect(clear.x).toBe(30);
    expect(clear.data.distance).toBe(20);
    expect(clear.data.blockedByWall).toBeUndefined();
  });

  test("a wall past the first waypoint clips the second leg and no waypoint is skipped (M05/D-174)", () => {
    // Budget 20: leg one reaches (20,10) in full (10 ft), leg two toward (90,10) meets
    // the move-blocking wall at x=22 — the march ends there; the remainder of the path
    // lies beyond the wall and is never attempted (the sim does not route around).
    const rules = createMassBattlePf1e();
    const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    const units: UnitView[] = [
      { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Red", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
    ];
    const orders = new Map<string, OrderQueue>();
    orders.set("u0", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "move", path: [{ x: 20, y: 10 }, { x: 90, y: 10 }, { x: 90, y: -60 }], pace: "march" } });
    const events: SimEvent[] = [];
    rules.resolveTurn(spellCtx({ x1: 22, y1: -100, x2: 22, y2: 200 }, 1), pool, units, orders, new XoshiroPRNG(3), (ev) => events.push(ev));
    expect(pool.x[0]).toBeCloseTo(21.999, 3);
    expect(pool.y[0]).toBe(10);
    const data = events.find((e) => e.type === "arrive")?.data as Record<string, unknown>;
    expect(data.distance).toBe(12); // 10 ft leg one + 1.999 ft of leg two, rounded to 2 dp
    expect(data.blockedByWall).toBe(true);
  });

  test("a retreat order withdraws toward the rally point at double speed (M05/D-175)", () => {
    // SRD Withdraw: "When you withdraw, you can move up to double your speed." Infantry
    // (move 4 × 5 ft) therefore withdraws up to 40 ft toward the rally point; a nearer
    // rally point ends the march early; a movement-blocking wall clips it like any march
    // (D-174).
    const run = (toward: { x: number; y: number }, wall?: { x: number; restriction: number }) => {
      const rules = createMassBattlePf1e();
      const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
      allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
      allocModel(pool, { id: 2, unitIdx: 0, x: 12, y: 10, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
      const units: UnitView[] = [
        { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Red", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 2], leaderTokenId: null },
      ];
      const orders = new Map<string, OrderQueue>();
      orders.set("u0", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "retreat", toward } });
      const ctx = wall ? spellCtx({ x1: wall.x, y1: -100, x2: wall.x, y2: 200 }, wall.restriction) : spellCtx();
      const events: SimEvent[] = [];
      rules.resolveTurn(ctx, pool, units, orders, new XoshiroPRNG(3), (ev) => events.push(ev));
      return { x0: pool.x[0], x1: pool.x[1], data: (events.find((e) => e.type === "arrive")?.data ?? {}) as Record<string, unknown> };
    };

    // Far rally point: the full 40-ft withdraw lands, formation intact.
    const far = run({ x: 200, y: 10 });
    expect(far.x0).toBe(50);
    expect(far.x1).toBe(52);
    expect(far.data.pace).toBe("retreat");
    expect(far.data.distance).toBe(40);

    // Nearer rally point: the march ends there, budget unspent.
    const near = run({ x: 30, y: 10 });
    expect(near.x0).toBe(30);
    expect(near.data.distance).toBe(20);
    expect(near.data.blockedByWall).toBeUndefined();

    // Move-blocking wall between the unit and the rally point clips the withdraw.
    const walled = run({ x: 200, y: 10 }, { x: 40, restriction: 1 });
    expect(walled.x0).toBeCloseTo(39.999, 3);
    expect(walled.data.distance).toBe(30);
    expect(walled.data.blockedByWall).toBe(true);
  });

  test("validateOrder names a NaN retreat destination (M05/D-175)", () => {
    const rules = createMassBattlePf1e();
    const unit = spellUnits({})[0] as UnitView;
    expect(rules.validateOrder(spellCtx(), unit, { kind: "retreat", toward: { x: Number.NaN, y: 0 } }).ok).toBe(false);
    expect(rules.validateOrder(spellCtx(), unit, { kind: "retreat", toward: { x: 0, y: Number.NaN } }).ok).toBe(false);
    expect(rules.validateOrder(spellCtx(), unit, { kind: "retreat", toward: { x: 5, y: 5 } })).toEqual({ ok: true });
  });

  test("fast healing and regeneration restore hit points once per turn (M06/D-176)", () => {
    // SRD Universal Monster Rules: fast healing "regains the listed number of Hit
    // Points at the start of its turn … can never exceed its maximum Hit Points";
    // regeneration heals "as with fast healing". The mass-battle heal sub-phase runs
    // once per turn before any damage resolves, and heals only living models.
    const rules = createMassBattlePf1e();
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    const sys = { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 };
    // u0: one wounded model (11/20) and one at full health (the cap probe).
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 11, hpMax: 20, sys: { ...sys } });
    allocModel(pool, { id: 2, unitIdx: 0, x: 5, y: 0, hp: 20, hpMax: 20, sys: { ...sys } });
    // u1: regeneration 5 with 5 points of lethal damage — the effective maximum is
    // 20 − 5 = 15, so the 10-hp model heals only 5.
    allocModel(pool, { id: 3, unitIdx: 1, x: 50, y: 0, hp: 10, hpMax: 20, sys: { ...sys, lethalDmg: 5 } });
    const units: UnitView[] = [
      { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Red Trolls", profile: {}, stats: { bab: 2, strMod: 1, ac: 14, fastHealing: 3 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 2], leaderTokenId: null },
      { id: "u1", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue Trolls", profile: {}, stats: { bab: 2, strMod: 1, ac: 14, regeneration: 5 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [2, 3], leaderTokenId: null },
    ];
    const events: SimEvent[] = [];
    rules.resolveTurn(spellCtx(), pool, units, new Map(), new XoshiroPRNG(11), (ev) => events.push(ev));

    expect(pool.hp[0]).toBe(14); // 11 + fast healing 3
    expect(pool.hp[1]).toBe(20); // never exceeds maximum
    expect(pool.hp[2]).toBe(15); // regeneration capped by the lethal damage

    const heals = events.filter((e) => e.subPhase === "heal");
    expect(heals).toHaveLength(2);
    expect(heals.find((e) => e.unitId === "u0")?.data).toEqual({ healed: 3, revived: 0 });
    expect(heals.find((e) => e.unitId === "u1")?.data).toEqual({ healed: 5, revived: 0 });
  });

  test("the heal sub-phase skips ability-less units and dead models (M06/D-176)", () => {
    // Fast healing "continues to function until a creature dies"; a unit with neither
    // ability never heals, and a healed-looking ability on an all-dead unit emits nothing.
    const rules = createMassBattlePf1e();
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    const sys = { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 };
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 10, hpMax: 20, sys: { ...sys } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 50, y: 0, hp: 0, hpMax: 20, sys: { ...sys } });
    pool.status[1] = (pool.status[1] ?? 0) | ModelStatus.dead;
    const units: UnitView[] = [
      { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Red", profile: {}, stats: { bab: 2, strMod: 1, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
      { id: "u1", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue", profile: {}, stats: { bab: 2, strMod: 1, ac: 14, regeneration: 5 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null },
    ];
    const events: SimEvent[] = [];
    rules.resolveTurn(spellCtx(), pool, units, new Map(), new XoshiroPRNG(11), (ev) => events.push(ev));

    expect(pool.hp[0]).toBe(10); // no ability: no healing
    expect(pool.hp[1]).toBe(0); // dead models never heal
    expect(events.some((e) => e.subPhase === "heal")).toBe(false);
  });

  test("envelopment reach is measured in feet and the FLANKED bit expires each round (M04/D-177)", () => {
    // SRD Combat: Medium creatures have a 5-ft natural reach, so the envelopment query
    // runs in feet (SpatialGrid), and the FLANKED bit it sets is recomputed every
    // round — it no longer lingers for the rest of the battle (Gap List §5).
    const rules = createMassBattlePf1e();
    const ctx = spellCtx();
    const sys = { ac: 16, touchAc: 12, fort: 4, ref: 2, will: 1, sr: 0, drType: 0, drVal: 0, profileIdx: 1 };
    const pool = createModelPool(8, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 30, hpMax: 30, sys: { ...sys } });
    allocModel(pool, { id: 2, unitIdx: 0, x: 6, y: 0, hp: 30, hpMax: 30, sys: { ...sys } });
    allocModel(pool, { id: 3, unitIdx: 1, x: 3, y: 0, hp: 30, hpMax: 30, sys: { ...sys } });
    const units: UnitView[] = [
      { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Red", profile: {}, stats: { bab: 4, strMod: 2, ac: 16 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 2], leaderTokenId: null },
      { id: "u1", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue", profile: {}, stats: { bab: 4, strMod: 2, ac: 16 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [2, 3], leaderTokenId: null },
    ];
    const orders = new Map<string, OrderQueue>();
    orders.set("u0", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "u1" } });

    // Round 1: both attackers stand 3 ft from the lone defender ⇒ enveloped ⇒ FLANKED.
    rules.resolveTurn(ctx, pool, units, orders, new XoshiroPRNG(7), () => {});
    expect((pool.status[2] ?? 0) & PF1E_STATUS_FLANKED).not.toBe(0);

    // Round 2: the attackers are beyond natural reach ⇒ no engagement ⇒ the bit expires.
    pool.x[0] = -50;
    pool.x[1] = -50;
    rules.resolveTurn(ctx, pool, units, orders, new XoshiroPRNG(7), () => {});
    expect((pool.status[2] ?? 0) & PF1E_STATUS_FLANKED).toBe(0);
  });

  test("hero cleave is one extra attack against an adjacent enemy (M07/D-178)", () => {
    // SRD Cleave: "one extra melee attack at your full attack bonus against a foe
    // adjacent to you … You take a −2 penalty to your Armor Class until your next
    // turn." The probe for EXACTLY one extra attack is a BAB 9 hero, whose normal
    // routine iterates twice (9/+4): 3 total attacks with cleave, 2 without — and
    // none at all beyond adjacency. High defender hp keeps kills out of the dice.
    const run = (hero: boolean, defenderX: number): { attacks: number; ac: number } => {
      const rules = createMassBattlePf1e();
      const pool = createModelPool(8, PF1E_MODEL_SCHEMA);
      const sys = { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 };
      allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 200, hpMax: 200, sys: { ...sys } });
      allocModel(pool, { id: 2, unitIdx: 1, x: defenderX, y: 0, hp: 200, hpMax: 200, sys: { ...sys, profileIdx: 2 } });
      const units: UnitView[] = [
        { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Red", profile: {}, stats: { bab: 9, strMod: 4, ac: 14, ...(hero ? { hero: 1 } : {}) }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
        { id: "u1", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null },
      ];
      const orders = new Map<string, OrderQueue>();
      orders.set("u0", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "u1" } });
      const events: SimEvent[] = [];
      rules.resolveTurn(spellCtx(), pool, units, orders, new XoshiroPRNG(21), (ev) => events.push(ev));
      const attack = events.find((e) => e.subPhase === "melee" && e.type === "attack");
      return { attacks: (attack?.data as Record<string, unknown>).totalAttacks as number, ac: pool.sys["ac"]?.[0] ?? 0 };
    };

    const cleaved = run(true, 3);
    expect(cleaved.attacks).toBe(3); // two iteratives + exactly one cleave attack
    expect(cleaved.ac).toBe(12); // the cleave's −2 AC penalty until the hero's next turn

    expect(run(false, 3)).toEqual({ attacks: 2, ac: 14 }); // no cleave without a hero
    expect(run(true, 30)).toEqual({ attacks: 2, ac: 14 }); // no adjacent foe: no cleave, no penalty
  });

  test("a unit bound to a leader actor counts as a hero: its allies get the aura (M07/D-169)", () => {
    // u0 is ordinary infantry — no `type: "hero"`, no `stats.hero` — but it has a leader
    // actor, so the M07 data path identifies it and its non-anchor model gets the aura's
    // +2 to Fort/Will. Without the actor the same battlefield stays unbuffed.
    const run = (leaderActors: RulesContext["leaderActors"]) => {
      const rules = createMassBattlePf1e();
      const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
      allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
      allocModel(pool, { id: 2, unitIdx: 0, x: 12, y: 10, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
      const units: UnitView[] = [
        { id: "u0", armyId: "a0", factionId: "f0", type: "infantry", name: "Escort", profile: {}, stats: { bab: 4, strMod: 2, ac: 14, fort: 3, will: 0 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 2], leaderTokenId: null },
      ];
      rules.resolveTurn({ ...spellCtx(), leaderActors }, pool, units, new Map(), new XoshiroPRNG(7), () => {});
      return pool;
    };

    const actorDoc = { _id: "actor-hero", system: { pf1e: { spells: { casterLevel: 5 } } } };
    const withHero = run({ u0: actorDoc });
    // Seeding writes Fort 3 each turn; the aura adds +2 to every friendly model except
    // the anchor.
    expect(withHero.sys["fort"]?.[0]).toBe(3);
    expect(withHero.sys["fort"]?.[1]).toBe(5);
    expect(withHero.sys["will"]?.[1]).toBe(2);

    const plain = run({});
    expect(plain.sys["fort"]?.[1]).toBe(3);
    expect(plain.sys["will"]?.[1]).toBe(0);
  });

  test("a threatened caster fails the defensive cast, provokes an AoO, and forecast reports it (M11/D-170)", () => {
    // Own battlefield: the caster's anchor (10,10) is within 5 ft of a Blue model
    // (12,10), so casting is defensive: DC 15 + 2×level = 21. At CL 1 with a −8 key
    // modifier even a natural 20 only reaches 13 — the check always fails, provoking
    // exactly one swing (the adjacent enemy's full AoO budget). The caster's AC 40 makes
    // the swing miss deterministically: executed=1, hits=0, no damage, so the spell
    // still resolves.
    const rules = createMassBattlePf1e();
    const ctx = spellCtx();
    const pool = createModelPool(20, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 60, hpMax: 60, sys: { ac: 16, touchAc: 12, fort: 4, ref: 2, will: 1, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 12, y: 10, hp: 30, hpMax: 30, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    allocModel(pool, { id: 3, unitIdx: 1, x: 10, y: 27, hp: 30, hpMax: 30, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    const units = spellUnits({ casterLevel: 1, castingStatMod: -8, ac: 40 });
    const orders = new Map<string, OrderQueue>();
    orders.set("u0", { issuedBy: "u0", issuedTurn: 1, pending: [], active: { kind: "custom", type: "spell_aoe", data: { x: 10, y: 25 } } });
    const events: SimEvent[] = [];
    rules.resolveTurn(ctx, pool, units, orders, new XoshiroPRNG(1234), (ev) => events.push(ev));
    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect(cast).toBeDefined();
    const data = cast?.data as Record<string, unknown>;
    expect(data.concentrationFailed).toBe(1);
    expect(data.aooExecuted).toBe(1);
    expect(data.aooHits).toBe(0);
    expect(data.spellInterrupted).toBe(false);

    // The same turn's ledger is what forecast reports: per-army rows instead of the old
    // empty placeholder (M11 `generateReport` finally has a caller).
    const caster = units.find((u) => u.id === "u0");
    expect(caster).toBeDefined();
    const army: ArmyView = {
      id: "a0",
      factionId: "f0",
      name: "Red Army",
      supply: {},
      units: caster ? [caster] : [],
    };
    const forecast = rules.forecast?.(ctx, army);
    expect(forecast).toBeDefined();
    expect(forecast?.summary).toContain("Red Army");
    expect(forecast?.rows).toHaveLength(1);
    expect(forecast?.data["concentrationFailed"]).toBe(1);
    expect(forecast?.data["aooExecuted"]).toBe(1);
  });

  test("the spell registry ships fireball and burning-hands with verified levels (D-171)", () => {
    // Levels are the CRB constants verified by R02 (D-151/D-171), never the pack's
    // `level` table: fireball sorcerer/wizard 3 (CRB p.283), burning hands 1 (pg. 251).
    expect(Object.keys(PF1E_MASS_SPELLS).sort()).toEqual(["burning-hands", "fireball"]);
    expect(PF1E_MASS_SPELLS["fireball"]?.level).toBe(3);
    expect(PF1E_MASS_SPELLS["burning-hands"]?.level).toBe(1);
    expect(DEFAULT_MASS_SPELL_ID).toBe("fireball");
  });

  test("an order can name a pack spell: burning-hands casts as a cone from the caster (D-171)", () => {
    // CL 5 / key mod +4: 1d4/level capped at 5d4 → 5d4; DC = 10 + level 1 + 4 = 15.
    // Cone aimed +X from the anchor (10,10) covers the caster itself and the enemy at
    // (16,10); the (10,27) model is behind the caster and outside the quarter-circle.
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { spell: "burning-hands", dirX: 1, dirY: 0 });
    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect(cast).toBeDefined();
    const data = cast?.data as Record<string, unknown>;
    expect(data.spellId).toBe("burning-hands");
    expect(data.spellName).toBe("Burning Hands");
    expect(data.spellShape).toBe("cone");
    expect(data.spellRadius).toBe(15);
    expect(data.spellDice).toBe("5d4");
    expect(data.spellDc).toBe(15);
    expect(data.spellLevel).toBe(1);
    expect(data.rangeCategory).toBeNull();
    expect(data.epicenterX).toBe(10); // the cone starts at the caster, not a designated point
    expect(data.epicenterY).toBe(10);
    expect(data.modelsTargeted).toBe(2);

    // Dice scale with caster level until the 5d4 cap.
    const lowLevel = castWithPayload({ casterLevel: 2, castingStatMod: 4 }, { spell: "burning-hands", dirX: 1, dirY: 0 });
    const lowCast = lowLevel.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect((lowCast?.data as Record<string, unknown>).spellDice).toBe("2d4");

    // No `spell` field still means the default spell (fireball) — the circle payload
    // keeps working unchanged.
    const defaultCast = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 10, y: 10 });
    expect((defaultCast.find((e) => e.type === "spell")?.data as Record<string, unknown>).spellId).toBe("fireball");
  });

  test("a circle payload on a named cone spell, and unknown spell ids, are refused (D-171)", () => {
    const rules = createMassBattlePf1e();
    const ctx = spellCtx();
    const unit = spellUnits({})[0] as UnitView;
    // Cone spells need a direction, not a point of origin.
    expect(rules.validateOrder(ctx, unit, { kind: "custom", type: "spell_aoe", data: { spell: "burning-hands", x: 10, y: 10 } }).ok).toBe(false);
    expect(rules.validateOrder(ctx, unit, { kind: "custom", type: "spell_aoe", data: { spell: "burning-hands", dirX: 1, dirY: 0 } })).toEqual({ ok: true });
    // Unknown ids are refused by name at issue…
    expect(rules.validateOrder(ctx, unit, { kind: "custom", type: "spell_aoe", data: { spell: "acid-splash", dirX: 1, dirY: 0 } })).toEqual({
      ok: false,
      error: 'spell_aoe: unknown spell "acid-splash"',
    });

    // …and at resolve, where the refusal is emitted with the same name.
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { spell: "acid-splash", dirX: 1, dirY: 0 });
    const refused = events.find((e) => e.subPhase === "spell" && e.type === "spellRefused");
    expect(refused).toBeDefined();
    expect((refused?.data as Record<string, unknown>).refusal).toBe("unknown_spell");
    expect(events.some((e) => e.subPhase === "spell" && e.type === "spell")).toBe(false);
  });

  test("a bound leader actor overrides the caster level and DC modifier (M07/D-168)", () => {
    // The unit stats say CL 5 / +4, but the leader actor is a 9th-level Int-20 caster:
    // the actor's authored numbers must win — dice 9d6, DC 18, long range 760 ft.
    const actorDoc = {
      _id: "actor-hero",
      system: { pf1e: { abilities: { int: 20 }, spells: { keyAbility: "int", casterLevel: 9 } } },
    };
    const ctx = { ...spellCtx(), leaderActors: { u0: actorDoc } };
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 10, y: 10 }, ctx);
    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect(cast).toBeDefined();
    const data = cast?.data as Record<string, unknown>;
    expect(data.casterLevel).toBe(9);
    expect(data.spellDice).toBe("9d6");
    expect(data.spellDc).toBe(18); // 10 + 3 + Int mod 5
    expect(data.rangeFeet).toBe(760); // 400 + 40*9
  });

  test("a leader actor that is not a caster falls back to the unit profile (M07/D-168)", () => {
    // No spells block → spellCasterLevel 0 → the profile's CL 5 / +4 stay in charge.
    const actorDoc = { _id: "actor-hero", system: { pf1e: { abilities: { str: 16 } } } };
    const ctx = { ...spellCtx(), leaderActors: { u0: actorDoc } };
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 10, y: 10 }, ctx);
    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    const data = cast?.data as Record<string, unknown>;
    expect(data.casterLevel).toBe(5);
    expect(data.spellDc).toBe(17);
    expect(data.spellDice).toBe("5d6");
  });

  test("casterInputsFromLeaderActor refuses garbage and non-casters, parses casters (M07)", () => {
    expect(casterInputsFromLeaderActor(null)).toBeNull();
    expect(casterInputsFromLeaderActor("wizard")).toBeNull();
    expect(casterInputsFromLeaderActor({ system: null })).toBeNull();
    expect(casterInputsFromLeaderActor({ system: { pf1e: { abilities: { str: 18 } } } })).toBeNull();
    expect(
      casterInputsFromLeaderActor({ system: { pf1e: { abilities: { int: 20 }, spells: { keyAbility: "int", casterLevel: 9, dcBonus: 1 } } } }),
    ).toEqual({ casterLevel: 9, keyAbilityMod: 5, spellPenetration: 0 });
    expect(
      casterInputsFromLeaderActor({ system: { pf1e: { spells: { casterLevel: 7, keyAbility: "wis" }, spellPenetration: 2, abilities: { wis: 18 } } } }),
    ).toEqual({ casterLevel: 7, keyAbilityMod: 4, spellPenetration: 2 });
  });

  test("a cone order aims from the caster: direction-driven, no range designation (D-167)", () => {
    // The 30-ft cone shoots +x from the caster's anchor at (10,10): it catches the
    // caster's own model (the cone starts at the caster, CRB p.214) and (12,10), but not
    // (10,27) — 17 ft sideways is outside the quarter-circle at 0 ft along the aim — nor
    // (90,90), past the length. No range category applies: cones reach their length.
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { dirX: 1, dirY: 0 }, spellCtx(), { spellEntry: CONE_ENTRY });
    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect(cast).toBeDefined();
    const data = cast?.data as Record<string, unknown>;
    expect(data.spellShape).toBe("cone");
    expect(data.epicenterX).toBe(10); // the caster's anchor, not an order-supplied point
    expect(data.epicenterY).toBe(10);
    expect(data.rangeCategory).toBeNull();
    expect(data.modelsTargeted).toBe(2);
  });

  test("a cone order without a direction is refused at issue and at resolve (D-167)", () => {
    const rules = createMassBattlePf1e({ spellEntry: CONE_ENTRY });
    const ctx = spellCtx();
    const unit = spellUnits({})[0] as UnitView;
    expect(rules.validateOrder(ctx, unit, { kind: "custom", type: "spell_aoe", data: { dirX: 1, dirY: 0 } })).toEqual({ ok: true });
    expect(rules.validateOrder(ctx, unit, { kind: "custom", type: "spell_aoe", data: { x: 10, y: 10 } }).ok).toBe(false);
    expect(rules.validateOrder(ctx, unit, { kind: "custom", type: "spell_aoe", data: { dirX: 0, dirY: 0 } }).ok).toBe(false);

    // And a circle-module order ({x,y}) on the cone module is refused at resolve too.
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 10, y: 10 }, spellCtx(), { spellEntry: CONE_ENTRY });
    const refused = events.find((e) => e.subPhase === "spell" && e.type === "spellRefused");
    expect(refused).toBeDefined();
    expect((refused?.data as Record<string, unknown>).refusal).toBe("bad_order");
  });

  test("a wall between caster and point of origin refuses the cast by name (D-166)", () => {
    // "You must have a clear line of effect to the point of origin of any spell you cast"
    // (CRB p.214). The sight-blocking wall at x=50 crosses the line (10,10)→(90,90).
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 90, y: 90 }, spellCtx({ x1: 50, y1: -100, x2: 50, y2: 200 }));
    const refused = events.find((e) => e.subPhase === "spell" && e.type === "spellRefused");
    expect(refused).toBeDefined();
    expect((refused?.data as Record<string, unknown>).refusal).toBe("no_line_of_effect");
    expect(events.some((e) => e.subPhase === "spell" && e.type === "spell")).toBe(false);
    // Without the wall the same cast stands.
    const clear = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 90, y: 90 });
    expect(clear.some((e) => e.subPhase === "spell" && e.type === "spell")).toBe(true);
  });

  test("a model with total cover from the point of origin is skipped, and reported (D-166)", () => {
    // Epicenter (10,10); the wall at y=20 blocks the line to the model at (10,27) but not
    // to (12,10) — three in-area models become two targeted + one cover-blocked.
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, { x: 10, y: 10 }, spellCtx({ x1: -50, y1: 20, x2: 60, y2: 20 }));
    const cast = events.find((e) => e.subPhase === "spell" && e.type === "spell");
    expect(cast).toBeDefined();
    const data = cast?.data as Record<string, unknown>;
    expect(data.modelsTargeted).toBe(2);
    expect(data.modelsBlockedByCover).toBe(1);
    const hits = data.hitsByUnit as Record<string, { modelsHit: number }>;
    expect(hits["u1"]?.modelsHit).toBe(1); // only (12,10); (10,27) is behind the wall
  });

  test("a spell_aoe order without a point of origin is refused by name (C05)", () => {
    // `data: null` is what the old demo order looked like — it must now be refused,
    // never silently re-anchored on a fixed spot.
    const events = castWithPayload({ casterLevel: 5, castingStatMod: 4 }, null);
    const refused = events.find((e) => e.subPhase === "spell" && e.type === "spellRefused");
    expect(refused).toBeDefined();
    expect((refused?.data as Record<string, unknown>).refusal).toBe("bad_order");
    expect(events.some((e) => e.subPhase === "spell" && e.type === "spell")).toBe(false);
  });

  test("validateOrder names a spell_aoe order with no usable point of origin (C05)", () => {
    const rules = createMassBattlePf1e();
    const ctx = spellCtx();
    const unit = spellUnits({})[0] as UnitView;
    const cast = (data: unknown) => rules.validateOrder(ctx, unit, { kind: "custom", type: "spell_aoe", data });

    expect(cast({ x: 10, y: 10 })).toEqual({ ok: true });
    expect(cast(null).ok).toBe(false);
    expect(cast({ x: 10 }).ok).toBe(false);
    expect(cast({ x: "10", y: 10 }).ok).toBe(false);
    expect(cast({ x: Number.NaN, y: 10 }).ok).toBe(false);
    // Other custom orders are still module-specific and pass through.
    expect(rules.validateOrder(ctx, unit, { kind: "custom", type: "other", data: null })).toEqual({ ok: true });
  });
});
