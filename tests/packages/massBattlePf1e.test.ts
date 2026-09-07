import { describe, expect, test } from "vitest";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { createModelPool, allocModel } from "../../src/sim/pool";
import { XoshiroPRNG } from "../../src/sim/prng";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { OrderQueue } from "../../src/core/strategic";
import type { SimEvent } from "../../src/core/sim";

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
});
