/**
 * Runtime-wiring tests for PF1e_Combat_Fidelity_GapList.md §1.3 (deploy seeding), §1.4
 * (stable profile ids) and §1.5 (deterministic dice).
 *
 * These are the "make PF1e actually fight" tests: before them, a deployed battle resolved
 * zero attacks because nothing ever wrote `profileIdx`, and the results could not be
 * replayed because the module rolled from `Math.random()` and a private LCG.
 */
import { describe, expect, test } from "vitest";
import {
  PF1E_MODEL_SCHEMA,
  PF1eProfileRegistry,
  pf1eProfileKey,
} from "../../src/packages/pf1e/schema";
import {
  buildUnitProfiles,
  rawProfileFromUnit,
  seedPF1ePool,
  sortUnitsForInterning,
} from "../../src/packages/pf1e/deploySeed";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { canonicalPoolHash } from "../../src/sim/codec";
import { XoshiroPRNG } from "../../src/sim/prng";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { OrderQueue } from "../../src/core/strategic";
import type { SimEvent } from "../../src/core/sim";

const context = (): RulesContext => ({
  sceneId: "scene-1",
  grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555" },
  walls: {
    x1: new Float32Array(),
    y1: new Float32Array(),
    x2: new Float32Array(),
    y2: new Float32Array(),
    restriction: new Uint8Array(),
  },
  factions: [],
  armies: [],
  leaderActors: {},
  worldSettings: {},
});

function unit(id: string, overrides: Partial<UnitView> = {}): UnitView {
  return {
    id,
    armyId: `army-${id}`,
    factionId: `f-${id}`,
    type: "infantry",
    name: `Unit ${id}`,
    profile: {},
    stats: {},
    orders: null,
    formation: "line",
    sceneId: "scene-1",
    modelRange: null,
    leaderTokenId: null,
    ...overrides,
  };
}

/** A pool exactly as `deploySnapshot` leaves it: hp/hpMax 1 and no system columns filled. */
function deployedPool(units: UnitView[], modelsPerUnit: number) {
  const pool = createModelPool(64, PF1E_MODEL_SCHEMA);
  for (let u = 0; u < units.length; u++) {
    const unit = units[u];
    if (!unit) continue;
    const start = pool.count;
    for (let i = 0; i < modelsPerUnit; i++) {
      allocModel(pool, {
        id: pool.count + 1,
        unitIdx: u,
        x: i * 4,
        y: u * 10,
        hp: 1,
        hpMax: 1,
        status: 0,
        facing: 0,
        sys: {},
      });
    }
    unit.modelRange = [start, pool.count];
  }
  return pool;
}

/** Every unit attacks the other one, so each side has an engagement regardless of order. */
const attackOrders = (units: UnitView[]): Map<string, OrderQueue> => {
  const orders = new Map<string, OrderQueue>();
  const sorted = [...units].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const [i, u] of sorted.entries()) {
    const target = sorted[(i + 1) % sorted.length];
    if (!target) continue;
    const order = { kind: "attack", targetUnitId: target.id } as const;
    orders.set(u.id, { issuedBy: u.id, issuedTurn: 1, pending: [order], active: order });
  }
  return orders;
};

describe("Profile interning (§1.4)", () => {
  test("the same unit set produces the same ids, in any order and in a fresh registry", () => {
    const units = [
      unit("u-b", { stats: { bab: 6, strMod: 3, ac: 16 } }),
      unit("u-a", { stats: { bab: 4, strMod: 2, ac: 14 } }),
    ];
    const first = buildUnitProfiles(units, new PF1eProfileRegistry());
    const shuffled = buildUnitProfiles([...units].reverse(), new PF1eProfileRegistry());
    const restarted = buildUnitProfiles(units, new PF1eProfileRegistry());

    // Sorting by unit id, not array order, is what makes pool `profileIdx` values survive a
    // SimWorker restart (a `Map` iteration order change used to shift every id by one).
    expect(first.byUnitId.get("u-a")?.id).toBe(shuffled.byUnitId.get("u-a")?.id);
    expect(first.byUnitId.get("u-b")?.id).toBe(restarted.byUnitId.get("u-b")?.id);
    expect(sortUnitsForInterning(units).map((u) => u.id)).toEqual(["u-a", "u-b"]);
  });

  test("identical stat lines share one slot, and the table stops growing", () => {
    const registry = new PF1eProfileRegistry();
    const twins = [unit("u-a", { stats: { bab: 6, ac: 16 } }), unit("u-b", { stats: { bab: 6, ac: 16 } })];
    const profiles = buildUnitProfiles(twins, registry);
    expect(profiles.byUnitId.get("u-a")?.id).toBe(profiles.byUnitId.get("u-b")?.id);
    expect(registry.size).toBe(1);

    buildUnitProfiles(twins, registry);
    buildUnitProfiles(twins, registry);
    expect(registry.size).toBe(1); // no per-turn churn: the old code grew this every turn

    expect(pf1eProfileKey({ bab: 6, ac: 16 })).toBe(pf1eProfileKey({ ac: 16, bab: 6, name: "x" }));
  });
});

describe("Deploy seeding (§1.3)", () => {
  test("seeding fills the derived columns and gives models real hit points", () => {
    const units = [unit("u-a", { stats: { bab: 6, strMod: 3, ac: 16, touchAc: 12, hp: 12, fort: 5 } }), unit("u-b")];
    const pool = deployedPool(units, 2);
    const profiles = buildUnitProfiles(units, new PF1eProfileRegistry());

    const res = seedPF1ePool(pool, units, profiles);
    expect(res.seeded).toBe(4);
    expect(res.hpInitialized).toBe(4);
    expect(pool.sys["profileIdx"]?.[0]).toBeGreaterThan(0);
    expect(pool.sys["ac"]?.[0]).toBe(16);
    expect(pool.sys["touchAc"]?.[0]).toBe(12);
    // Flat-footed AC now exists as a real column (§2.1) — 16 - Dex 0.
    expect(pool.sys["flatFootedAc"]?.[0]).toBe(16);
    expect(pool.sys["fort"]?.[0]).toBe(5);
    expect(pool.hpMax[0]).toBe(12);
    expect(pool.hp[0]).toBe(12);

    // A unit with no stats still gets a sane AC instead of 0 (which used to auto-hit).
    expect(pool.sys["ac"]?.[2]).toBeGreaterThan(0);
  });

  test("seeding is idempotent: it never resurrects a model that has already fought", () => {
    const units = [unit("u-a", { stats: { bab: 6, ac: 16, hp: 12 } })];
    const pool = deployedPool(units, 2);
    const profiles = buildUnitProfiles(units, new PF1eProfileRegistry());

    seedPF1ePool(pool, units, profiles);
    pool.hp[0] = 3;
    const nonlethal = pool.sys["nonlethal"];
    const aooUsed = pool.sys["aooUsed"];
    expect(nonlethal).toBeDefined();
    expect(aooUsed).toBeDefined();
    if (nonlethal) nonlethal[0] = 7;
    if (aooUsed) aooUsed[0] = 1;

    const again = seedPF1ePool(pool, units, profiles);
    expect(again.hpInitialized).toBe(0);
    expect(pool.hp[0]).toBe(3);
    expect(pool.sys["nonlethal"]?.[0]).toBe(7);
    // ...but the per-turn refreshes do happen: AoO budget and derived AC are rewritten.
    expect(pool.sys["aooUsed"]?.[0]).toBe(0);
    expect(pool.sys["ac"]?.[0]).toBe(16);
  });

  test("rawProfileFromUnit exposes the SRD AC breakdown when a unit supplies one", () => {
    const raw = rawProfileFromUnit(unit("u-a", { stats: { armorBonus: 3, shieldBonus: 1, naturalArmor: 0, dexMod: 4, sizeMod: 1 } }));
    expect(raw.armorBonus).toBe(3);
    expect(raw.ac).toBeUndefined(); // derived, not typed
  });
});

describe("Deterministic resolution (§1.5)", () => {
  const run = (seed: number, units: UnitView[], pool = deployedPool(units, 3)) => {
    const events: SimEvent[] = [];
    createMassBattlePf1e().resolveTurn(
      context(),
      pool,
      units,
      attackOrders(units),
      new XoshiroPRNG(seed),
      (e) => events.push(e),
    );
    return { events, pool };
  };

  test("the same seed and inputs produce an identical pool hash and identical events", () => {
    const mk = () => [
      unit("u-a", { stats: { bab: 6, strMod: 3, ac: 16, hp: 20 } }),
      unit("u-b", { stats: { bab: 4, strMod: 2, ac: 14, hp: 20 } }),
    ];
    const a = run(1234, mk());
    const b = run(1234, mk());

    expect(a.events.map((e) => e.text)).toEqual(b.events.map((e) => e.text));
    expect(canonicalPoolHash(a.pool, PF1E_MODEL_SCHEMA)).toBe(canonicalPoolHash(b.pool, PF1E_MODEL_SCHEMA));
    expect(a.pool.count).toBeGreaterThan(0);
  });

  test("a deployed battle resolves attacks at all (the zero-attack regression)", () => {
    const units = [
      unit("u-a", { stats: { bab: 8, strMod: 4, ac: 18, hp: 25 } }),
      unit("u-b", { stats: { bab: 2, strMod: 1, ac: 12, hp: 10 } }),
    ];
    const { events, pool } = run(77, units);
    const melee = events.find((e) => e.type === "attack");
    expect(melee, `expected an attack event, got: ${events.map((e) => e.text).join(" | ")}`).toBeDefined();
    const metrics = melee?.data as unknown as { totalAttacks: number; hits: number };
    expect(metrics.totalAttacks).toBeGreaterThan(0);
    expect(metrics.hits).toBeGreaterThan(0);
    // And the defender actually lost hit points.
    const [dStart] = units[1]?.modelRange ?? [0, 0];
    expect(pool.hp[dStart ?? 0]).toBeLessThan(10);
  });

  test("unit processing order cannot change a unit's own outcome", () => {
    // §5A: rolls come from `rng.fork(hash(unit.id))`, so a unit's attack resolves the same
    // no matter where it sat in the array this turn. HP is deliberately huge: with deaths in
    // the mix, order would legitimately change *who is still standing*, which is not what
    // this asserts.
    const mk = (): UnitView[] => [
      unit("u-a", { stats: { bab: 6, strMod: 3, ac: 16, hp: 999 } }),
      unit("u-b", { stats: { bab: 6, strMod: 3, ac: 16, hp: 999 } }),
    ];
    const forward = run(555, mk());
    const reverse = run(555, mk().reverse());

    const metricsOf = (events: SimEvent[], name: string) => {
      const ev = events.find((e) => e.type === "attack" && e.text.startsWith(name));
      return ev?.data as unknown as { totalAttacks: number; hits: number; netDamageDealt: number } | undefined;
    };
    const a = metricsOf(forward.events, "Unit u-a");
    const b = metricsOf(reverse.events, "Unit u-a");
    expect(a?.totalAttacks).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });
});
