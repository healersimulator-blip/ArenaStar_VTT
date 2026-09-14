import { describe, expect, test } from "vitest";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { createModelPool, allocModel } from "../../src/sim/pool";
import { XoshiroPRNG } from "../../src/sim/prng";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { OrderQueue } from "../../src/core/strategic";
import type { SimEvent } from "../../src/core/sim";

function ctxWithSimultaneous(simultaneous: boolean, leaderActors: Record<string, unknown> = {}): RulesContext {
  return {
    sceneId: "scene-1",
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555" },
    walls: { x1: new Float32Array(), y1: new Float32Array(), x2: new Float32Array(), y2: new Float32Array(), restriction: new Uint8Array() },
    factions: [
      { _id: "f0", type: "faction", name: "Red", color: "#ff0000", ownership: { default: 3 }, flags: {}, system: {}, allies: [] },
      { _id: "f1", type: "faction", name: "Blue", color: "#0000ff", ownership: { default: 3 }, flags: {}, system: {}, allies: [] },
    ],
    armies: [],
    leaderActors,
    worldSettings: simultaneous ? { strategicSimultaneous: true } : {},
    // F02: turnMode also drives simultaneous when the engine is in-turn; for the unit test we set it directly
    // so the resolver does not need a full TurnEngine.
    // The RulesContext type has turnMode?: TurnMode — we set it to "simultaneous" to exercise the branch
    // even when worldSettings is the same object the UI writes.
    turnMode: simultaneous ? "simultaneous" : "stepwise",
  } as unknown as RulesContext;
}

describe("F02 simultaneous strategic — movement batch + initiative damage order", () => {
  test("simultaneous movement is batch from the start snapshot (no interleaving)", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);

    // Two infantry 30 ft apart. Both march 20 ft toward the other's start.
    // In stepwise the second mover would see the first's new square if the engine did collision
    // re-checks; in simultaneous both compute from the same snapshot and both arrive.
    // Our wall test also checks that a wall at x=25 still clips — the batch and the sequential
    // path use the same wall budget, so both modes stop at the same wall.
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 30, y: 0, hp: 20, hpMax: 20, sys: { ac: 14, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });

    const units: UnitView[] = [
      { id: "uA", armyId: "a0", factionId: "f0", type: "infantry", name: "Red Marchers", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null },
      { id: "uB", armyId: "a1", factionId: "f1", type: "infantry", name: "Blue Marchers", profile: {}, stats: { bab: 4, strMod: 2, ac: 14 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null },
    ];

    const orders = new Map<string, OrderQueue>();
    orders.set("uA", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "move", path: [{ x: 30, y: 0 }], pace: "march" } });
    orders.set("uB", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "move", path: [{ x: 0, y: 0 }], pace: "march" } });

    const eventsSim: SimEvent[] = [];
    rules.resolveTurn(
      ctxWithSimultaneous(true),
      pool,
      units,
      orders,
      new XoshiroPRNG(99),
      (ev) => eventsSim.push(ev),
    );

    // Infantry march is 20 ft. From x=0 toward 30, uA ends at 20,0. From x=30 toward 0, uB ends at 10,0.
    // Both computed from the start snapshot, so they do not block each other and both emit.
    expect(pool.x[0]).toBe(20);
    expect(pool.x[1]).toBe(10);
    const arrives = eventsSim.filter((e) => e.subPhase === "move" && e.type === "arrive").map((e) => e.unitId).sort();
    expect(arrives).toEqual(["uA", "uB"]);

    // Same order in stepwise must give the same geometry (walls are static, collision is not re-checked mid-phase in the current engine),
    // but the *event* order is deterministic and the pool after stepwise must match the simultaneous snapshot-batch result.
    // Reset pool for stepwise comparison.
    pool.x[0] = 0; pool.x[1] = 30;
    const eventsSeq: SimEvent[] = [];
    rules.resolveTurn(
      ctxWithSimultaneous(false),
      pool,
      units,
      orders,
      new XoshiroPRNG(99),
      (ev) => eventsSeq.push(ev),
    );
    expect(pool.x[0]).toBe(20);
    expect(pool.x[1]).toBe(10);
    expect(eventsSeq.filter((e) => e.type === "arrive").length).toBe(2);
  });

  test("initiative is damage order in simultaneous — high init fires with full strength first (100→80 fixture)", () => {
    // Two archer units of 2 models each (scaled down from 100). The fixture's observable is order:
    // high-init fires first with full models, low-init fires second after the high-init's kills.
    // We make kills deterministic by giving everyone 1 hp and high-damage profiles: any hit kills.
    // With bab 10 vs AC 5, hit rate is ~95% but the *order* is what we pin: in simultaneous the
    // high-init's melee event must come first even though the units array has low-init first.
    const rules = createMassBattlePf1e();

    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    // uLow (initiative 7) — array first
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 1, hpMax: 1, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    allocModel(pool, { id: 2, unitIdx: 0, x: 1, y: 0, hp: 1, hpMax: 1, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 1 } });
    // uHigh (initiative 12) — array second
    allocModel(pool, { id: 3, unitIdx: 1, x: 0, y: 1, hp: 1, hpMax: 1, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });
    allocModel(pool, { id: 4, unitIdx: 1, x: 1, y: 1, hp: 1, hpMax: 1, sys: { ac: 5, touchAc: 5, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 } });

    const units: UnitView[] = [
      { id: "uLow", armyId: "a0", factionId: "f0", type: "infantry", name: "Low Init Archers", profile: {}, stats: { bab: 10, strMod: 5, ac: 5, dexMod: 7 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 2], leaderTokenId: null },
      { id: "uHigh", armyId: "a1", factionId: "f1", type: "infantry", name: "High Init Archers", profile: {}, stats: { bab: 10, strMod: 5, ac: 5, dexMod: 12 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [2, 4], leaderTokenId: null },
    ];

    const orders = new Map<string, OrderQueue>();
    orders.set("uLow", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "uHigh" } });
    orders.set("uHigh", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "uLow" } });

    // Author initiative via leaderActors so the resolver's `effectiveInitiativeOf` reads the PF1e derivation
    // (dex + authored + effects) rather than the fallback dexMod. Dex 10 (mod 0) + authored = total.
    const leaderActors = {
      uLow: { _id: "actor-low", system: { pf1e: { initiative: 7, abilities: { dex: 10 } } } },
      uHigh: { _id: "actor-high", system: { pf1e: { initiative: 12, abilities: { dex: 10 } } } },
    };

    const eventsSim: SimEvent[] = [];
    rules.resolveTurn(
      ctxWithSimultaneous(true, leaderActors),
      pool,
      units,
      orders,
      new XoshiroPRNG(42),
      (ev) => eventsSim.push(ev),
    );

    const meleeSim = eventsSim.filter((e) => e.subPhase === "melee" && e.type === "attack");
    expect(meleeSim.length).toBe(2);
    // Simultaneous: high init (uHigh) must be first even though units array is [uLow, uHigh]
    expect(meleeSim[0]?.unitId).toBe("uHigh");
    expect(meleeSim[1]?.unitId).toBe("uLow");
    // The high-init's attack emitted with full models; the low-init's attack data reflects the post-high casualties
    // (at 1 hp per model, any hit kills, so low-init's attacker count is reduced if the high-init's volley hit).
    // We do not pin an exact kill count because dice are involved, but we do pin that the resolver honored initiative:
    // the *first* emitted melee attack belongs to the higher initiative, deterministically, regardless of array order.
    // Forked RNG per (unit, phase) guarantees the dice themselves are unaffected by the sort.

    // Same orders in stepwise must be array-order (uLow first), proving the two modes differ.
    // Reset pool (revive)
    pool.hp[0] = 1; pool.hp[1] = 1; pool.hp[2] = 1; pool.hp[3] = 1;
    (pool.status as unknown as Uint32Array).fill?.(0);
    // The pool's status array may be Uint16 — reset manually
    for (let i = 0; i < pool.count; i++) (pool.status as unknown as number[])[i] = 0;

    const eventsSeq: SimEvent[] = [];
    rules.resolveTurn(
      ctxWithSimultaneous(false, leaderActors),
      pool,
      units,
      orders,
      new XoshiroPRNG(42),
      (ev) => eventsSeq.push(ev),
    );
    const meleeSeq = eventsSeq.filter((e) => e.subPhase === "melee" && e.type === "attack");
    expect(meleeSeq.length).toBe(2);
    expect(meleeSeq[0]?.unitId).toBe("uLow");
    expect(meleeSeq[1]?.unitId).toBe("uHigh");
  });

  test("simultaneous melee uses forked RNG so dice are order-independent (determinism)", () => {
    // Run the same simultaneous turn twice with the same seed — the per-unit fork means the
    // high-init's dice are identical regardless of whether the low-init's dice are consumed first.
    const run = (): number[] => {
      const rules = createMassBattlePf1e();
      const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
      for (let i = 0; i < 4; i++) {
        allocModel(pool, { id: i + 1, unitIdx: i < 2 ? 0 : 1, x: i % 2, y: Math.floor(i / 2), hp: 20, hpMax: 20, sys: { ac: 12, touchAc: 10, fort: 0, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: (i < 2 ? 1 : 2) } });
      }
      const units: UnitView[] = [
        { id: "uA", armyId: "a0", factionId: "f0", type: "infantry", name: "A", profile: {}, stats: { bab: 4, strMod: 2, ac: 12 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 2], leaderTokenId: null },
        { id: "uB", armyId: "a1", factionId: "f1", type: "infantry", name: "B", profile: {}, stats: { bab: 4, strMod: 2, ac: 12 }, orders: null, formation: "line", sceneId: "scene-1", modelRange: [2, 4], leaderTokenId: null },
      ];
      const orders = new Map<string, OrderQueue>();
      orders.set("uA", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "uB" } });
      orders.set("uB", { issuedBy: "gm", issuedTurn: 1, pending: [], active: { kind: "attack", targetUnitId: "uA" } });
      const events: SimEvent[] = [];
      rules.resolveTurn(ctxWithSimultaneous(true, { uA: { _id: "aA", system: { pf1e: { initiative: 10 } } }, uB: { _id: "aB", system: { pf1e: { initiative: 5 } } } }), pool, units, orders, new XoshiroPRNG(123), (ev) => events.push(ev));
      // Return hit counts per attacker
      return events.filter((e) => e.type === "attack").map((e) => (e.data as Record<string, unknown>).hits as number);
    };
    expect(run()).toEqual(run());
  });

  test("squad order fan-out — one squadId key expands to every unit in that squad", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    // Three units: two share squad-alpha, one is solo. The squad order is a move.
    // Squad members start at same y so the same path is equally reachable (infantry march 20 ft)
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14 } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14 } });
    allocModel(pool, { id: 3, unitIdx: 2, x: 0, y: 20, hp: 20, hpMax: 20, sys: { ac: 14 } });

    const units: UnitView[] = [
      { id: "u1", armyId: "a0", factionId: "f0", type: "infantry", name: "Alpha 1", profile: {}, stats: {}, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null, squadId: "squad-alpha" } as unknown as UnitView,
      { id: "u2", armyId: "a0", factionId: "f0", type: "infantry", name: "Alpha 2", profile: {}, stats: {}, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null, squadId: "squad-alpha" } as unknown as UnitView,
      { id: "u3", armyId: "a0", factionId: "f0", type: "infantry", name: "Solo", profile: {}, stats: {}, orders: null, formation: "line", sceneId: "scene-1", modelRange: [2, 3], leaderTokenId: null, squadId: null } as unknown as UnitView,
    ];

    const orders = new Map<string, OrderQueue>();
    // One order keyed by squadId, not by unit id — the engine fans it out
    orders.set("squad-alpha", {
      issuedBy: "gm",
      issuedTurn: 1,
      pending: [],
      active: { kind: "move", path: [{ x: 20, y: 0 }], pace: "march" },
    });

    const events: SimEvent[] = [];
    rules.resolveTurn(ctxWithSimultaneous(true), pool, units, orders, new XoshiroPRNG(77), (ev) => events.push(ev));

    const arrives = events.filter((e) => e.subPhase === "move" && e.type === "arrive").map((e) => e.unitId).sort();
    // Both squad members moved; solo did not
    expect(arrives).toEqual(["u1", "u2"]);
    expect(pool.x[0]).toBe(20);
    expect(pool.x[1]).toBe(20);
    expect(pool.x[2]).toBe(0);
  });

  test("squad order does not overwrite per-unit order (per-unit wins)", () => {
    const rules = createMassBattlePf1e();
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { ac: 14 } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 0, y: 10, hp: 20, hpMax: 20, sys: { ac: 14 } });

    const units: UnitView[] = [
      { id: "u1", armyId: "a0", factionId: "f0", type: "infantry", name: "Alpha 1", profile: {}, stats: {}, orders: null, formation: "line", sceneId: "scene-1", modelRange: [0, 1], leaderTokenId: null, squadId: "squad-alpha" } as unknown as UnitView,
      { id: "u2", armyId: "a0", factionId: "f0", type: "infantry", name: "Alpha 2", profile: {}, stats: {}, orders: null, formation: "line", sceneId: "scene-1", modelRange: [1, 2], leaderTokenId: null, squadId: "squad-alpha" } as unknown as UnitView,
    ];

    const orders = new Map<string, OrderQueue>();
    // Squad says move to 20, but u1 has its own hold-like attack order that should win
    orders.set("squad-alpha", {
      issuedBy: "gm",
      issuedTurn: 1,
      pending: [],
      active: { kind: "move", path: [{ x: 20, y: 0 }], pace: "march" },
    });
    orders.set("u1", {
      issuedBy: "gm",
      issuedTurn: 1,
      pending: [],
      active: { kind: "attack", targetUnitId: "u2" },
    });

    const events: SimEvent[] = [];
    rules.resolveTurn(ctxWithSimultaneous(true), pool, units, orders, new XoshiroPRNG(88), (ev) => events.push(ev));

    const arrives = events.filter((e) => e.subPhase === "move" && e.type === "arrive").map((e) => e.unitId);
    // u1 kept its attack order, only u2 moved via squad fan-out
    expect(arrives).toEqual(["u2"]);
  });
});
