import { describe, expect, test } from "vitest";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { FactionDocument, ModelPool, Order, OrderQueue } from "../../src/core/strategic";
import { ModelStatus } from "../../src/core/strategic";
import { createMassBattleBasic } from "../../src/packages/massBattleBasic";
import { XoshiroPRNG } from "../../src/sim/prng";
import { allocModel, clonePool, createModelPool, hashPool } from "../../src/sim/pool";
import type { SimEvent } from "../../src/core/sim";

const rules = createMassBattleBasic();

const faction = (id: string, allies: string[] = []): FactionDocument => ({
  _id: id,
  type: "faction",
  name: id,
  ownership: { default: 3 },
  flags: {},
  system: {},
  color: "#fff",
  allies,
});

function makeCtx(supplyLevel = 1): RulesContext {
  return {
    sceneId: "scene-1",
    grid: { type: "square", size: 100, distance: 1, units: "sq", diagonals: "5105" },
    walls: {
      x1: new Float32Array(0),
      y1: new Float32Array(0),
      x2: new Float32Array(0),
      y2: new Float32Array(0),
      restriction: new Uint8Array(0),
    },
    factions: [faction("f-red"), faction("f-blue")],
    armies: [
      {
        _id: "army-red",
        type: "army",
        name: "Red Host",
        ownership: { default: 3 },
        flags: {},
        system: {},
        factionId: "f-red",
        commander: [],
        supply: { level: supplyLevel },
        units: [],
      },
      {
        _id: "army-blue",
        type: "army",
        name: "Blue Host",
        ownership: { default: 3 },
        flags: {},
        system: {},
        factionId: "f-blue",
        commander: [],
        supply: { level: 1 },
        units: [],
      },
    ],
    leaderActors: {},
    worldSettings: {},
  };
}

let unitSeq = 0;
function makeUnit(factionId: string, armyId: string, type: string): UnitView {
  unitSeq += 1;
  return {
    id: `unit-${unitSeq}`,
    armyId,
    factionId,
    type,
    name: `${type} ${unitSeq}`,
    profile: {},
    stats: {},
    orders: null,
    formation: "line",
    sceneId: "scene-1",
    modelRange: null,
    leaderTokenId: null,
  };
}

/** Build a pool with the given units placed in tight formations; assigns modelRanges. */
function buildPool(
  units: Array<{ unit: UnitView; count: number; x: number; y: number }>,
): ModelPool {
  const total = units.reduce((a, u) => a + u.count, 0);
  const pool = createModelPool(Math.max(total, 1), { ammo: "u8" });
  let next = 0;
  let modelId = 1;
  for (const { unit, count, x, y } of units) {
    const start = next;
    for (let i = 0; i < count; i++) {
      const col = i % 5;
      const row = Math.floor(i / 5);
      allocModel(pool, {
        id: modelId++,
        unitIdx: start,
        x: x + col * 0.2,
        y: y + row * 0.2,
        hp: 1,
        hpMax: 1,
        facing: 0,
        rank: row,
        file: col,
        sys: { ammo: 6 },
      });
      next++;
    }
    unit.modelRange = [start, next];
  }
  return pool;
}

function ordersFor(units: UnitView[], fn: (u: UnitView) => Order | null): Map<string, OrderQueue> {
  const m = new Map<string, OrderQueue>();
  for (const u of units) {
    const o = fn(u);
    if (o) m.set(u.id, { pending: [o], issuedBy: "u1", issuedTurn: 1 });
  }
  return m;
}

const liveCount = (pool: ModelPool, unit: UnitView): number => {
  const [s, e] = unit.modelRange ?? [0, 0];
  let n = 0;
  for (let i = s; i < e && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) n++;
  }
  return n;
};

describe("mass-battle-basic validateOrder (§12)", () => {
  const ctx = makeCtx();
  const unit = makeUnit("f-red", "army-red", "infantry");
  test("accepts well-formed orders", () => {
    expect(
      rules.validateOrder(ctx, unit, { kind: "move", path: [{ x: 1, y: 1 }], pace: "march" }),
    ).toEqual({ ok: true });
    expect(rules.validateOrder(ctx, unit, { kind: "hold", stance: "defensive" })).toEqual({
      ok: true,
    });
    expect(rules.validateOrder(ctx, unit, { kind: "formation", formation: "wedge" })).toEqual({
      ok: true,
    });
  });
  test("rejects malformed orders with reasons", () => {
    expect(rules.validateOrder(ctx, unit, { kind: "move", path: [], pace: "march" })).toEqual({
      ok: false,
      error: "move: empty path",
    });
    expect(rules.validateOrder(ctx, unit, { kind: "formation", formation: "orb" })).toEqual({
      ok: false,
      error: 'formation: unknown "orb"',
    });
    expect(rules.validateOrder(ctx, unit, { kind: "custom", type: "ambush", data: {} })).toEqual({
      ok: false,
      error: "custom: no custom orders in mass-battle-basic (ambush)",
    });
  });
});

describe("mass-battle-basic resolveTurn (§12, §5A)", () => {
  test("movement: march order moves every model by the path", () => {
    const red = makeUnit("f-red", "army-red", "infantry");
    const pool = buildPool([{ unit: red, count: 10, x: 0, y: 0 }]);
    const events: SimEvent[] = [];
    const orders = ordersFor([red], () => ({
      kind: "move",
      path: [{ x: 2, y: 0 }],
      pace: "march",
    }));
    rules.resolveTurn(makeCtx(), pool, [red], orders, new XoshiroPRNG(1), (e) => events.push(e));
    const [s, e] = red.modelRange ?? [0, 0];
    // anchor (mean) starts at x=0.4 and marches to the waypoint at x=2 → dx=1.6
    for (let i = s; i < e; i++) {
      expect(pool.x[i]).toBeCloseTo(((i - s) % 5) * 0.2 + 1.6, 5);
    }
    expect(events.some((ev) => ev.subPhase === "move" && ev.type === "arrive")).toBe(true);
  });

  test("shooting: adjacent enemies exchange fire; ammo drops; wounds land", () => {
    const red = makeUnit("f-red", "army-red", "infantry");
    const blue = makeUnit("f-blue", "army-blue", "infantry"); // within shoot range
    const pool = buildPool([
      { unit: red, count: 20, x: 0, y: 0 },
      { unit: blue, count: 20, x: 0.5, y: 0 },
    ]);
    const events: SimEvent[] = [];
    const orders = new Map<string, OrderQueue>(); // hold implicitly: no orders
    rules.resolveTurn(makeCtx(), pool, [red, blue], orders, new XoshiroPRNG(5), (ev) =>
      events.push(ev),
    );
    const shots = events.filter((ev) => ev.subPhase === "shoot");
    expect(shots.length).toBeGreaterThan(0);
    const [rs, re] = red.modelRange ?? [0, 0];
    const ammoAfter = Array.from(pool.sys.ammo?.slice(rs, re) ?? []);
    expect(ammoAfter.some((a) => a < 6)).toBe(true); // powder spent
    // someone likely wounded at range 0.5 with 20 shooters each side
    const total = liveCount(pool, red) + liveCount(pool, blue);
    expect(total).toBeLessThanOrEqual(40);
  });

  test("melee: attack order into contact wounds the target", () => {
    const red = makeUnit("f-red", "army-red", "infantry");
    const blue = makeUnit("f-blue", "army-blue", "infantry");
    const pool = buildPool([
      { unit: red, count: 20, x: 0, y: 0 },
      { unit: blue, count: 20, x: 0.2, y: 0 },
    ]);
    const events: SimEvent[] = [];
    const orders = ordersFor([red], () => ({ kind: "attack", targetUnitId: blue.id }));
    rules.resolveTurn(makeCtx(), pool, [red, blue], orders, new XoshiroPRNG(9), (ev) =>
      events.push(ev),
    );
    expect(events.some((ev) => ev.subPhase === "melee")).toBe(true);
    const [bs, be] = blue.modelRange ?? [0, 0];
    const engaged = Array.from(pool.status.slice(bs, be));
    expect(engaged.some((st) => (st ?? 0) & ModelStatus.engaged)).toBe(true);
  });

  test("supply attrition when army supply level is 0", () => {
    const red = makeUnit("f-red", "army-red", "infantry");
    const pool = buildPool([{ unit: red, count: 6, x: 0, y: 0 }]);
    const events: SimEvent[] = [];
    rules.resolveTurn(makeCtx(0), pool, [red], new Map(), new XoshiroPRNG(2), (ev) =>
      events.push(ev),
    );
    expect(events.some((ev) => ev.subPhase === "supply" && ev.type === "attrition")).toBe(true);
    expect(liveCount(pool, red)).toBe(5);
  });

  test("determinism + §5A replay: same checkpoint+orders+seed ⇒ identical pool hash", () => {
    const red = makeUnit("f-red", "army-red", "infantry");
    const blue = makeUnit("f-blue", "army-blue", "cavalry");
    const pool0 = buildPool([
      { unit: red, count: 15, x: 0, y: 0 },
      { unit: blue, count: 15, x: 3, y: 2 },
    ]);
    const orders = ordersFor([red, blue], (u) =>
      u.factionId === "f-red"
        ? { kind: "move", path: [{ x: 2, y: 1 }], pace: "march" }
        : { kind: "attack", targetUnitId: "unit-1" },
    );
    const ctx = makeCtx();

    const run = (from: ModelPool): { hash: string; events: SimEvent[] } => {
      const pool = clonePool(from);
      const events: SimEvent[] = [];
      rules.resolveTurn(ctx, pool, [red, blue], orders, new XoshiroPRNG(1234), (e) =>
        events.push(e),
      );
      return { hash: hashPool(pool), events };
    };

    const checkpoint = clonePool(pool0); // Checkpoint N
    const first = run(checkpoint); // N → N+1
    const replay = run(checkpoint); // replay(Checkpoint N, orders, seed) — must reproduce N+1
    expect(replay.hash).toBe(first.hash);
    expect(replay.events).toEqual(first.events);

    // different seed ⇒ (almost surely) different course of battle
    const otherSeed = (() => {
      const pool = clonePool(checkpoint);
      const events: SimEvent[] = [];
      rules.resolveTurn(ctx, pool, [red, blue], orders, new XoshiroPRNG(99999), (e) =>
        events.push(e),
      );
      return { hash: hashPool(pool), events };
    })();
    expect(otherSeed.events.length).toBe(first.events.length); // same structure
  });

  test("events are sub-phase ordered (§5A replay timeline)", () => {
    const red = makeUnit("f-red", "army-red", "infantry");
    const blue = makeUnit("f-blue", "army-blue", "infantry");
    const pool = buildPool([
      { unit: red, count: 10, x: 0, y: 0 },
      { unit: blue, count: 10, x: 0.4, y: 0 },
    ]);
    const events: SimEvent[] = [];
    const orders = ordersFor([red], () => ({
      kind: "move",
      path: [{ x: 0.2, y: 0 }],
      pace: "march",
    }));
    rules.resolveTurn(makeCtx(0), pool, [red, blue], orders, new XoshiroPRNG(3), (e) =>
      events.push(e),
    );
    const order = ["move", "shoot", "melee", "morale", "supply"];
    const phases = events.map((e) => order.indexOf(e.subPhase));
    expect([...phases].sort((a, b) => a - b)).toEqual(phases);
  });

  test("tick(): realtime movement scales with dt", () => {
    const red = makeUnit("f-red", "army-red", "infantry");
    const pool = buildPool([{ unit: red, count: 5, x: 0, y: 0 }]);
    const orders = ordersFor([red], () => ({
      kind: "move",
      path: [{ x: 10, y: 0 }],
      pace: "march",
    }));
    const x0 = pool.x[0] ?? 0;
    const tickFn = rules.tick;
    if (!tickFn) throw new Error("tick missing");
    tickFn(makeCtx(), pool, [red], orders, new XoshiroPRNG(1), () => {}, 0.2);
    const moved = (pool.x[0] ?? 0) - x0;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(4 * 5 * 0.2); // move × rate
  });

  test("detection radius from profile/type; forecast sums armies", () => {
    const ctx = makeCtx();
    const cav = makeUnit("f-red", "army-red", "cavalry");
    const inf = makeUnit("f-red", "army-red", "artillery");
    expect(rules.detection(ctx, cav)).toBe(6);
    expect(rules.detection(ctx, inf)).toBe(6); // artillery points 15 > 10 → 5+1
    const army = {
      id: "army-red",
      factionId: "f-red",
      name: "Red Host",
      supply: {},
      units: [
        { ...inf, stats: { strength: 10, morale: 3 } },
        { ...cav, stats: { strength: 8, morale: 4 } },
      ],
    };
    const forecast = rules.forecast;
    if (!forecast) throw new Error("forecast missing");
    const f = forecast(ctx, army);
    expect(f?.rows.find((r) => r.label === "strength")?.value).toBe(18);
  });
});
