/**
 * P06 at the strategic scale — the march provokes, the budget caps it, and the round
 * refresh restores it.
 *
 * These are the sim half of the P06 acceptance line ("the authoritative queue must decide
 * … before the movement Op commits"): the events below are what the runner actually
 * emitted, not what a UI prompt would have displayed. The rule text behind each case is
 * quoted in `src/packages/pf1e/interrupts.ts` (AoN 102/151, fetched 2026-09-12).
 *
 * Geometry note: `cellFeet = 5`, so the cell (col, row) of a model at (x, y) is
 * (floor(x/5), floor(y/5)) and one square of reach is 5 ft. Infantry has 4 move points, so
 * a `move` order walks 20 ft and a `run` walks 80 ft in one turn.
 */
import { describe, expect, test } from "vitest";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { createModelPool, allocModel } from "../../src/sim/pool";
import { XoshiroPRNG } from "../../src/sim/prng";
import type { RulesContext, UnitView } from "../../src/core/rules";
import type { Order, OrderQueue } from "../../src/core/strategic";
import type { SimEvent } from "../../src/core/sim";

const CTX: RulesContext = {
  sceneId: "scene-1",
  grid: {
    type: "square",
    size: 100,
    distance: 5,
    units: "ft",
    diagonals: "555",
  },
  walls: {
    x1: new Float32Array(),
    y1: new Float32Array(),
    x2: new Float32Array(),
    y2: new Float32Array(),
    restriction: new Uint8Array(),
  },
  factions: [
    {
      _id: "f0",
      type: "faction",
      name: "Red",
      color: "#ff0000",
      ownership: { default: 3 },
      flags: {},
      system: {},
      allies: [],
    },
    {
      _id: "f1",
      type: "faction",
      name: "Blue",
      color: "#0000ff",
      ownership: { default: 3 },
      flags: {},
      system: {},
      allies: [],
    },
  ],
  armies: [],
  leaderActors: {},
  worldSettings: {},
};

const COLUMNS = {
  ac: 16,
  touchAc: 12,
  fort: 4,
  ref: 2,
  will: 1,
  sr: 0,
  drType: 0,
  drVal: 0,
};

/** One unit per faction: "mover" (Blue) and "reactor" (Red), placed by the caller. */
function battlefield(
  moverAt: { x: number; y: number },
  reactorModels: ReadonlyArray<{ x: number; y: number }>,
): { pool: ReturnType<typeof createModelPool>; units: UnitView[] } {
  const pool = createModelPool(32, PF1E_MODEL_SCHEMA);
  allocModel(pool, {
    id: 1,
    unitIdx: 0,
    x: moverAt.x,
    y: moverAt.y,
    hp: 60,
    hpMax: 60,
    sys: { ...COLUMNS, profileIdx: 1 },
  });
  reactorModels.forEach((at, i) =>
    allocModel(pool, {
      id: 10 + i,
      unitIdx: 1,
      x: at.x,
      y: at.y,
      hp: 60,
      hpMax: 60,
      sys: { ...COLUMNS, drVal: 0, profileIdx: 2 },
    }),
  );
  const units: UnitView[] = [
    {
      id: "u0",
      armyId: "a0",
      factionId: "f1",
      type: "infantry",
      name: "Blue Infantry",
      profile: {},
      stats: { bab: 4, strMod: 2, ac: 14 },
      orders: null,
      formation: "line",
      sceneId: "scene-1",
      modelRange: [0, 1],
      leaderTokenId: null,
    },
    {
      id: "u1",
      armyId: "a1",
      factionId: "f0",
      type: "infantry",
      name: "Red Infantry",
      profile: {},
      stats: { bab: 6, strMod: 3, ac: 16 },
      orders: null,
      formation: "line",
      sceneId: "scene-1",
      modelRange: [1, 1 + reactorModels.length],
      leaderTokenId: null,
    },
  ];
  return { pool, units };
}

function moveOrder(
  to: { x: number; y: number },
  pace: "march" | "run" = "march",
): OrderQueue {
  const order: Order = { kind: "move", path: [{ x: to.x, y: to.y }], pace };
  return { issuedBy: "u0", issuedTurn: 1, pending: [order], active: order };
}

const opportunities = (events: readonly SimEvent[]): SimEvent[] =>
  events.filter((e) => e.subPhase === "move" && e.type === "opportunity");

describe("P06 — the strategic sim decides attacks of opportunity itself", () => {
  test("a march out of a threatened square provokes, and the reactor's budget is spent", () => {
    // Blue at (10,10) walks 20 ft east to (30,10), leaving cells (10,10), (15,10), (20,10)
    // and (25,10). Red at (25,10) threatens the four squares around its own, (20,10) among
    // them — so Blue's march leaves a square Red threatens, and Red gets the one attack.
    const { pool, units } = battlefield({ x: 10, y: 10 }, [{ x: 25, y: 10 }]);
    const orders = new Map<string, OrderQueue>([
      ["u0", moveOrder({ x: 30, y: 10 })],
    ]);
    const events: SimEvent[] = [];
    createMassBattlePf1e().resolveTurn(
      CTX,
      pool,
      units,
      orders,
      new XoshiroPRNG(7),
      (e) => events.push(e),
    );

    const aoo = opportunities(events);
    expect(aoo).toHaveLength(1);
    const data = aoo[0]?.data as Record<string, unknown>;
    expect(data.kind).toBe("attack-of-opportunity");
    expect(data.reactorId).toBe("u1");
    expect(data.provokerId).toBe("u0");
    // Resolved in the square the provoker was attacked in, not where the march ended.
    expect(data.square).toEqual({ x: 20, y: 10 });
    expect(data.squaresLeft).toBe(4);
    // The mover did keep walking: the opportunity interrupts, it does not cancel the move.
    expect(pool.x[0]).toBe(30);

    // Budget: the reactor spent its one opportunity this round; the mover spent none.
    expect(pool.sys["aooUsed"]?.[1]).toBe(1);
    expect(pool.sys["aooUsed"]?.[0]).toBe(0);
  });

  test("one march provokes at most once from the same opponent, however many squares it leaves", () => {
    // Red's unit has two models, at (25,10) and (35,10), so the unit's threat covers both
    // (20,10) and (30,10). Blue runs 80 ft east to (90,10) and leaves squares threatened by
    // both models — of the same unit. AoN 102: "Moving out of more than one square
    // threatened by the same opponent in the same round doesn't count as more than one
    // opportunity for that opponent."
    const { pool, units } = battlefield({ x: 10, y: 10 }, [
      { x: 25, y: 10 },
      { x: 35, y: 10 },
    ]);
    const orders = new Map<string, OrderQueue>([
      ["u0", moveOrder({ x: 90, y: 10 }, "run")],
    ]);
    const events: SimEvent[] = [];
    createMassBattlePf1e().resolveTurn(
      CTX,
      pool,
      units,
      orders,
      new XoshiroPRNG(7),
      (e) => events.push(e),
    );

    const aoo = opportunities(events);
    expect(aoo).toHaveLength(1);
    expect((aoo[0]?.data as Record<string, unknown>).reactorId).toBe("u1");
    expect(pool.sys["aooUsed"]?.[1]).toBe(1);
    // Only one of Red's two models reacted, and only one opportunity was spent.
    expect(pool.sys["aooUsed"]?.[2] ?? 0).toBe(0);
  });

  test("the budget refreshes at the start of the next turn", () => {
    const { pool, units } = battlefield({ x: 10, y: 10 }, [{ x: 25, y: 10 }]);
    const rules = createMassBattlePf1e();
    const events: SimEvent[] = [];
    const emit = (e: SimEvent) => events.push(e);

    // Turn 1: 10 → 30 (leaves (20,10)).
    rules.resolveTurn(
      CTX,
      pool,
      units,
      new Map<string, OrderQueue>([["u0", moveOrder({ x: 30, y: 10 })]]),
      new XoshiroPRNG(7),
      emit,
    );
    expect(opportunities(events)).toHaveLength(1);
    expect(pool.sys["aooUsed"]?.[1]).toBe(1);

    // Turn 2: 30 → 40 leaves (30,10), which Red at (25,10) also threatens.
    events.length = 0;
    rules.resolveTurn(
      CTX,
      pool,
      units,
      new Map<string, OrderQueue>([["u0", moveOrder({ x: 40, y: 10 })]]),
      new XoshiroPRNG(8),
      emit,
    );
    expect(opportunities(events)).toHaveLength(1);
    // Refreshed and spent again: still 1, not 2.
    expect(pool.sys["aooUsed"]?.[1]).toBe(1);
  });

  test("a march that leaves no threatened square provokes nothing", () => {
    // Red at (25,10) threatens (20,10)–(30,10); Blue walks west, away from it, leaving only
    // (10,10) and (5,10) — neither within Red's reach.
    const { pool, units } = battlefield({ x: 10, y: 10 }, [{ x: 25, y: 10 }]);
    const orders = new Map<string, OrderQueue>([
      ["u0", moveOrder({ x: 0, y: 10 })],
    ]);
    const events: SimEvent[] = [];
    createMassBattlePf1e().resolveTurn(
      CTX,
      pool,
      units,
      orders,
      new XoshiroPRNG(7),
      (e) => events.push(e),
    );
    expect(opportunities(events)).toEqual([]);
    expect(pool.sys["aooUsed"]?.[1]).toBe(0);
  });

  test("a withdraw exempts the square it started in — and only that square (AoN 151)", () => {
    // Red's unit is adjacent to Blue's start square (20,10) and a second enemy unit — this
    // one via its own firing line — threatens the next square Blue leaves, (15,10). Under a
    // retreat (SRD: "The square you start out in is not considered threatened by any
    // opponent you can see … If, during the process of withdrawing, you move out of a
    // threatened square (other than the one you started in), enemies get attacks of
    // opportunity as normal"), the adjacent enemy must NOT get an attack, and the far unit
    // must.
    const pool = createModelPool(32, PF1E_MODEL_SCHEMA);
    allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 20,
      y: 10,
      hp: 60,
      hpMax: 60,
      sys: { ...COLUMNS, profileIdx: 1 },
    });
    allocModel(pool, {
      id: 2,
      unitIdx: 1,
      x: 25,
      y: 10,
      hp: 60,
      hpMax: 60,
      sys: { ...COLUMNS, profileIdx: 2 },
    });
    allocModel(pool, {
      id: 3,
      unitIdx: 2,
      x: 15,
      y: 15,
      hp: 60,
      hpMax: 60,
      sys: { ...COLUMNS, profileIdx: 2 },
    });
    const base = {
      armyId: "a",
      profile: {},
      orders: null,
      formation: "line",
      sceneId: "scene-1",
      leaderTokenId: null,
    } as const;
    const units: UnitView[] = [
      {
        ...base,
        id: "u0",
        factionId: "f1",
        type: "infantry",
        name: "Blue Infantry",
        stats: { bab: 4, strMod: 2, ac: 14 },
        modelRange: [0, 1],
      },
      {
        ...base,
        id: "u1",
        factionId: "f0",
        type: "infantry",
        name: "Red Adjacent",
        stats: { bab: 6, strMod: 3, ac: 16 },
        modelRange: [1, 2],
      },
      {
        ...base,
        id: "u2",
        factionId: "f0",
        type: "infantry",
        name: "Red Flankers",
        stats: { bab: 6, strMod: 3, ac: 16 },
        modelRange: [2, 3],
      },
    ];
    // A withdraw is a full-round move at double speed, west to (10,10): it leaves (20,10)
    // (exempt) and (15,10) (threatened by u2's model at (15,15)).
    const order: Order = { kind: "retreat", toward: { x: 10, y: 10 } };
    const orders = new Map<string, OrderQueue>([
      [
        "u0",
        { issuedBy: "u0", issuedTurn: 1, pending: [order], active: order },
      ],
    ]);
    const events: SimEvent[] = [];
    createMassBattlePf1e().resolveTurn(
      CTX,
      pool,
      units,
      orders,
      new XoshiroPRNG(7),
      (e) => events.push(e),
    );

    const aoo = opportunities(events);
    expect(aoo).toHaveLength(1);
    const data = aoo[0]?.data as Record<string, unknown>;
    expect(data.reactorId).toBe("u2"); // the unit threatening a square *after* the start one
    expect(data.square).toEqual({ x: 15, y: 10 });
    // The adjacent unit — the one that only threatened the exempt start square — never
    // reacted, and spent nothing.
    expect(pool.sys["aooUsed"]?.[1]).toBe(0);
    expect(pool.sys["aooUsed"]?.[2]).toBe(1);
  });
});
