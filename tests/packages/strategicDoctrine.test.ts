import { describe, expect, test } from "vitest";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { createModelPool, allocModel } from "../../src/sim/pool";
import { XoshiroPRNG } from "../../src/sim/prng";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { OrderQueue } from "../../src/core/strategic";
import type { SimEvent } from "../../src/core/sim";

/** G-04/D-223 — Combat_Resolver_5 fidelity mode (doctrine / envelop / B12 army initiative). */

function ctxWith(
  settings: Record<string, unknown>,
  armies: { _id: string; name: string }[] = [],
): RulesContext {
  return {
    sceneId: "scene-1",
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555" },
    walls: { x1: new Float32Array(), y1: new Float32Array(), x2: new Float32Array(), y2: new Float32Array(), restriction: new Uint8Array() },
    factions: [
      { _id: "f0", type: "faction", name: "Red", color: "#ff0000", ownership: { default: 3 }, flags: {}, system: {}, allies: [] },
      { _id: "f1", type: "faction", name: "Blue", color: "#0000ff", ownership: { default: 3 }, flags: {}, system: {}, allies: [] },
    ],
    armies,
    leaderActors: {},
    worldSettings: settings,
    turnMode: "simultaneous",
  } as unknown as RulesContext;
}

describe("G-04 doctrine mode (Combat_Resolver_5 parallel execution port)", () => {
  test("un-ordered doctrine-advance units auto-march on the nearest enemy; hold stays put", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 60, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    allocModel(pool, { id: 3, unitIdx: 2, x: 0, y: 40, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });

    const units: UnitView[] = [
      { id: "uA", armyId: "a0", factionId: "f0", type: "infantry", name: "Red Advance", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
      { id: "uB", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue Target", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null },
      { id: "uHold", armyId: "a0", factionId: "f0", type: "infantry", name: "Red Hold", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [2, 3], leaderTokenId: null, doctrine: "hold" },
    ];
    const orders = new Map<string, OrderQueue>();
    const events: SimEvent[] = [];
    rules.resolveTurn(
      ctxWith({ strategicDoctrine: true, strategicSimultaneous: true }),
      pool,
      units,
      orders,
      new XoshiroPRNG(7),
      (ev) => events.push(ev),
    );

    // Infantry = 4 move × 5 ft = 20 ft march toward the nearest enemy model (60 ft away).
    expect(pool.x[0]).toBe(20);
    // The hold-doctrine unit never received an order and never moved.
    expect(pool.x[2]).toBe(0);
    expect(pool.y[2]).toBe(40);
    const advances = events.filter((e) => e.type === "doctrine-advance").map((e) => e.unitId);
    expect(advances).toContain("uA");
    expect(advances).not.toContain("uHold");
    // Synthesised orders are honest: the map carries issuedBy "doctrine".
    expect(orders.get("uA")?.issuedBy).toBe("doctrine");
    // No order materialises for hold units.
    expect(orders.get("uHold")).toBeUndefined();
  });

  test("explicit orders beat doctrine (order channel wins over autonomy)", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(2, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 60, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    const units: UnitView[] = [
      { id: "uA", armyId: "a0", factionId: "f0", type: "infantry", name: "Red Ordered", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
      { id: "uB", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null },
    ];
    const orders = new Map<string, OrderQueue>();
    orders.set("uA", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "hold", stance: "defend" } });
    orders.set("uB", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "hold", stance: "defend" } });
    const events: SimEvent[] = [];
    rules.resolveTurn(
      ctxWith({ strategicDoctrine: true, strategicSimultaneous: true }),
      pool,
      units,
      orders,
      new XoshiroPRNG(7),
      (ev) => events.push(ev),
    );
    expect(pool.x[0]).toBe(0);
    expect(events.filter((e) => e.type.startsWith("doctrine-"))).toHaveLength(0);
    expect(orders.get("uA")?.issuedBy).toBe("gm");
    expect(pool.x[1]).toBe(60);
  });

  test("contact flips doctrine to an attack order: un-ordered units fight on reach", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    // Both in melee reach (5 ft apart), 1 hp, AC 5, bab+str 15 → any die ≥ -10 hits.
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 1, hpMax: 1, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 5, y: 0, hp: 1, hpMax: 1, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    const units: UnitView[] = [
      { id: "uA", armyId: "a0", factionId: "f0", type: "infantry", name: "Red", profile: {}, stats: { bab: 10, strMod: 5, ac: 5 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
      { id: "uB", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue", profile: {}, stats: { bab: 10, strMod: 5, ac: 5 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null },
    ];
    const orders = new Map<string, OrderQueue>();
    const events: SimEvent[] = [];
    rules.resolveTurn(
      ctxWith({ strategicDoctrine: true, strategicSimultaneous: true }),
      pool,
      units,
      orders,
      new XoshiroPRNG(11),
      (ev) => events.push(ev),
    );
    const engages = events.filter((e) => e.type === "doctrine-engage").map((e) => e.unitId).sort();
    expect(engages).toEqual(["uA", "uB"]);
    // Both attack orders were synthesised and resolved through the real melee pipeline.
    const attacks = events.filter((e) => e.type === "attack").map((e) => e.unitId).sort();
    expect(attacks).toEqual(["uA", "uB"]);
    // Nobody moved (they were already engaged).
    expect(pool.x[0]).toBe(0);
    expect(pool.x[1]).toBe(5);
  });

  test("wider front wraps excess models around the defender's flanks (envelop)", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(16, PF1E_MODEL_SCHEMA);
    // Attacker: 10 files across (perpendicular to the advance direction), anchor at (0,0).
    const aYs = [0, 5, -5, 10, -10, 15, -15, 20, -20, 25];
    aYs.forEach((y, k) => {
      allocModel(pool, { id: k + 1, unitIdx: 0, x: 0, y, hp: 20, hpMax: 20, sys: { ac: 12, touchAc: 10, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    });
    // Defender: 2 files wide, engaged (4 ft from the front files).
    allocModel(pool, { id: 11, unitIdx: 1, x: 4, y: 0, hp: 20, hpMax: 20, sys: { ac: 12, touchAc: 10, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    allocModel(pool, { id: 12, unitIdx: 1, x: 4, y: 5, hp: 20, hpMax: 20, sys: { ac: 12, touchAc: 10, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });

    const units: UnitView[] = [
      { id: "uWide", armyId: "a0", factionId: "f0", type: "infantry", name: "Wide Line", profile: {}, stats: { bab: 4, strMod: 2, ac: 12 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 10], leaderTokenId: null },
      { id: "uNarrow", armyId: "a1", factionId: "f1", type: "infantry", name: "Narrow Line", profile: {}, stats: { bab: 4, strMod: 2, ac: 12 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [10, 12], leaderTokenId: null },
    ];
    const orders = new Map<string, OrderQueue>();
    orders.set("uWide", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "uNarrow" } });
    const events: SimEvent[] = [];
    rules.resolveTurn(
      ctxWith({ strategicDoctrine: true, strategicSimultaneous: true }),
      pool,
      units,
      orders,
      new XoshiroPRNG(13),
      (ev) => events.push(ev),
    );

    const env = events.find((e) => e.type === "envelop");
    expect(env).toBeDefined();
    expect(env?.unitId).toBe("uWide");
    // Defender frontage 5 ft + tolerance: excess files y=±{10,15,20,25} (beyond
    // +frontage/+ and −frontage/− respectively) — 8 models wrap; the front
    // files at y ∈ {0, 5, −5? …} stay.
    expect((env?.data as { wrapped: number }).wrapped).toBe(8);
    // Front files (within the defender's frontage 0..5) did not move.
    expect(pool.x[0]).toBe(0);
    expect(pool.y[0]).toBe(0);
    const second = 1; // y=5 file stays too (5 ≤ foeEdge+2.5? → 5 > 5+2.5 false — stays)
    expect(pool.x[second]).toBe(0);
    expect(pool.y[second]).toBe(5);
    // Wrapped models now stand beside the defender's flank at reach (y=10 / y=−5 rows),
    // stepping down the enemy side one square per rank. Side +1 corner is (4,5):
    // slots (4,10), (−1,10), (−6,10), (−11,10) taken by the +side excess in
    // descending y (25, 20, 15, 10 → pool indices 9, 7, 5, 3).
    expect([pool.x[9], pool.y[9]]).toEqual([4, 10]);
    expect([pool.x[7], pool.y[7]]).toEqual([-1, 10]);
    expect([pool.x[5], pool.y[5]]).toEqual([-6, 10]);
    expect([pool.x[3], pool.y[3]]).toEqual([-11, 10]);
    // Side −1 corner is (4,0): slots (4,−5), (−1,−5), (−6,−5), (−11,−5),
    // excess in ascending y (−20, −15, −10, −5 → pool indices 8, 6, 4, 2).
    expect([pool.x[8], pool.y[8]]).toEqual([4, -5]);
    expect([pool.x[6], pool.y[6]]).toEqual([-1, -5]);
    expect([pool.x[4], pool.y[4]]).toEqual([-6, -5]);
    expect([pool.x[2], pool.y[2]]).toEqual([-11, -5]);
  });

  test("envelop per-unit opt-out (envelop: false) leaves excess files standing", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(16, PF1E_MODEL_SCHEMA);
    const aYs = [0, 5, -5, 10, -10, 15, -15, 20, -20, 25];
    aYs.forEach((y, k) => {
      allocModel(pool, { id: k + 1, unitIdx: 0, x: 0, y, hp: 20, hpMax: 20, sys: { ac: 12, touchAc: 10, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    });
    allocModel(pool, { id: 11, unitIdx: 1, x: 4, y: 0, hp: 20, hpMax: 20, sys: { ac: 12, touchAc: 10, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    allocModel(pool, { id: 12, unitIdx: 1, x: 4, y: 5, hp: 20, hpMax: 20, sys: { ac: 12, touchAc: 10, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    const units: UnitView[] = [
      { id: "uWide", armyId: "a0", factionId: "f0", type: "infantry", name: "Wide Line", profile: {}, stats: { bab: 4, strMod: 2, ac: 12 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 10], leaderTokenId: null, envelop: false },
      { id: "uNarrow", armyId: "a1", factionId: "f1", type: "infantry", name: "Narrow Line", profile: {}, stats: { bab: 4, strMod: 2, ac: 12 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [10, 12], leaderTokenId: null },
    ];
    const orders = new Map<string, OrderQueue>();
    orders.set("uWide", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "uNarrow" } });
    const events: SimEvent[] = [];
    rules.resolveTurn(
      ctxWith({ strategicDoctrine: true, strategicSimultaneous: true }),
      pool,
      units,
      orders,
      new XoshiroPRNG(13),
      (ev) => events.push(ev),
    );
    expect(events.find((e) => e.type === "envelop")).toBeUndefined();
    aYs.forEach((y, k) => {
      expect(pool.x[k]).toBe(0);
      expect(pool.y[k]).toBe(y);
    });
  });

  test("B12 army initiative — d20 + modifier per army, totals then modifiers order the damage", () => {
    const rules = createMassBattlePf1e();
    const setup = (seed: number) => {
      const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
      allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 40, hpMax: 40, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
      allocModel(pool, { id: 2, unitIdx: 1, x: 5, y: 0, hp: 40, hpMax: 40, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
      const units: UnitView[] = [
        // Losing side deliberately has the higher per-unit initiative mod: without the
        // army key it would strike first — the army roll must outrank it.
        { id: "uPurple", armyId: "a1", factionId: "f1", type: "infantry", name: "Purple", profile: {}, stats: { bab: 10, strMod: 5, ac: 5, dexMod: 12 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null, armyInitiative: 1 },
        { id: "uRed", armyId: "a0", factionId: "f0", type: "infantry", name: "Red", profile: {}, stats: { bab: 10, strMod: 5, ac: 5, dexMod: 7 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null, armyInitiative: 2 },
      ];
      const orders = new Map<string, OrderQueue>();
      orders.set("uRed", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "uPurple" } });
      orders.set("uPurple", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "uRed" } });
      const events: SimEvent[] = [];
      rules.resolveTurn(
        ctxWith({ strategicArmyInitiative: true, strategicSimultaneous: true }, [
          { _id: "a0", name: "Red Horde" },
          { _id: "a1", name: "Purple Host" },
        ]),
        pool,
        units,
        orders,
        new XoshiroPRNG(seed),
        (ev) => events.push(ev),
      );
      return { events };
    };

    const { events } = setup(42);
    const init = events.find((e) => e.type === "army-initiative");
    expect(init).toBeDefined();
    const rolls = (init?.data as { rolls: { armyId: string; die: number; modifier: number; total: number }[] }).rolls;
    expect(rolls).toHaveLength(2);
    for (const r of rolls) expect(r.total).toBe(r.die + r.modifier);
    // Property: the first melee attack belongs to the army with the higher total —
    // this is the whole-alpha strike the reference gets by acting half-army at a time.
    const winner = [...rolls].sort((a, b) => b.total - a.total || b.modifier - a.modifier || a.armyId.localeCompare(b.armyId))[0];
    const firstMelee = events.find((e) => e.type === "attack");
    const unitArmy = { uRed: "a0", uPurple: "a1" } as const;
    expect(unitArmy[firstMelee?.unitId as keyof typeof unitArmy]).toBe(winner?.armyId);
    // The event text transcribes the reference's log line shape (B12).
    expect(init?.text).toContain("Initiative:");
    expect(init?.text).toContain("acts first");
    expect(init?.text).toContain(`d20 ${winner?.die} + ${winner?.modifier}`);
  });

  test("B12 ties: equal totals fall to the higher initiative modifier, then roster order", () => {
    // Find a seed in [1, 200] where the two armies roll equal dice. Such seeds
    // exist (~1/20); we assert the tie-break path deterministically on it.
    const rules = createMassBattlePf1e();
    const rollDice = (seed: number): [number, number] => {
      const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
      allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 40, hpMax: 40, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
      allocModel(pool, { id: 2, unitIdx: 1, x: 5, y: 0, hp: 40, hpMax: 40, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
      const units: UnitView[] = [
        { id: "uR", armyId: "a0", factionId: "f0", type: "infantry", name: "R", profile: {}, stats: { bab: 2, strMod: 2, ac: 5 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null, armyInitiative: 3 },
        { id: "uP", armyId: "a1", factionId: "f1", type: "infantry", name: "P", profile: {}, stats: { bab: 2, strMod: 2, ac: 5 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null, armyInitiative: 3 },
      ];
      const orders = new Map<string, OrderQueue>();
      const events: SimEvent[] = [];
      rules.resolveTurn(
        ctxWith({ strategicArmyInitiative: true, strategicSimultaneous: true }),
        pool,
        units,
        orders,
        new XoshiroPRNG(seed),
        (ev) => events.push(ev),
      );
      const data = events.find((e) => e.type === "army-initiative")?.data as
        | { rolls: { armyId: string; die: number }[] }
        | undefined;
      return [data?.rolls.find((r) => r.armyId === "a0")?.die ?? -1, data?.rolls.find((r) => r.armyId === "a1")?.die ?? -1];
    };
    let tieSeed = -1;
    for (let s = 1; s <= 400; s++) {
      const [d0, d1] = rollDice(s);
      if (d0 === d1 && d0 > 0) {
        tieSeed = s;
        break;
      }
    }
    expect(tieSeed).toBeGreaterThan(0);
    // Equal dice + equal modifiers ⇒ the RAW chain exhausts to stable roster order: a0 acts first.
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 40, hpMax: 40, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 5, y: 0, hp: 40, hpMax: 40, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    const units: UnitView[] = [
      { id: "uR", armyId: "a0", factionId: "f0", type: "infantry", name: "R", profile: {}, stats: { bab: 10, strMod: 5, ac: 5 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null, armyInitiative: 3 },
      { id: "uP", armyId: "a1", factionId: "f1", type: "infantry", name: "P", profile: {}, stats: { bab: 10, strMod: 5, ac: 5 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null, armyInitiative: 3 },
    ];
    const orders = new Map<string, OrderQueue>();
    orders.set("uR", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "uP" } });
    orders.set("uP", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "uR" } });
    const events: SimEvent[] = [];
    rules.resolveTurn(
      ctxWith({ strategicArmyInitiative: true, strategicSimultaneous: true }),
      pool,
      units,
      orders,
      new XoshiroPRNG(tieSeed),
      (ev) => events.push(ev),
    );
    expect(events.find((e) => e.type === "attack")?.unitId).toBe("uR");
  });

  test("everything off by default: no doctrine, no events, no displacement without settings", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 60, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    const units: UnitView[] = [
      { id: "uA", armyId: "a0", factionId: "f0", type: "infantry", name: "Red", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
      { id: "uB", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null },
    ];
    const orders = new Map<string, OrderQueue>();
    const events: SimEvent[] = [];
    rules.resolveTurn(
      ctxWith({ strategicSimultaneous: true }),
      pool,
      units,
      orders,
      new XoshiroPRNG(7),
      (ev) => events.push(ev),
    );
    expect(pool.x[0]).toBe(0);
    expect(pool.x[1]).toBe(60);
    expect(events.filter((e) => e.type === "doctrine-advance" || e.type === "doctrine-engage" || e.type === "army-initiative" || e.type === "envelop")).toHaveLength(0);
    expect(orders.size).toBe(0);
  });
});
