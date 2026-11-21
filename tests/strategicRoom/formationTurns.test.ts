/** Production codec-2 deployment → frozen resolver → published checkpoint. No UI or DB mock. */
import { expect, test } from "vitest";
import {
  deploy,
  parseScenario,
} from "../../services/strategic-room/src/scenario";
import { BattleView } from "../../services/strategic-room/src/battle";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";
import {
  checkpointPool,
  type FrozenOrder,
  type Published,
} from "../../services/strategic-room/src/state";
import { parseCommand } from "../../src/core/strategicRoom/protocol";
import { routeAroundSpellHazards, segmentHitsSpellHazard } from "../../src/core/strategicRoom/hazardAvoidance";

function field(strength: number, distance: number) {
  return parseScenario({
    format: "arenastar-strategic-scenario-v1",
    name: "Formation probe",
    seed: 17,
    bounds: { minX: -250, minY: -250, maxX: 250, maxY: 250 },
    factions: [
      { id: "blue", color: "#0000ff", name: "Blue" },
      { id: "red", color: "#ff0000", name: "Red" },
    ],
    commanders: ["blue", "red"].map((side, i) => ({
      id: `seat-${side}`,
      factionId: side,
      units: [
        {
          id: side,
          name: side,
          strength,
          weapon: "melee",
          anchor: { x: i * distance, y: 0 },
        },
      ],
    })),
  });
}
function models(state: Published) {
  const p = checkpointPool(state);
  return Array.from({ length: p.count }, (_, i) => ({
    id: p.id[i],
    unit: p.unitIdx[i],
    x: p.x[i],
    y: p.y[i],
  }));
}
test.each([1, 9, 10, 11, 19, 20, 21, 80, 99, 100])(
  "a %i-model line deploys distinct five-foot files and retains its slots on a march",
  (strength) => {
    const scenario = field(strength, 180),
      start = deploy(scenario);
    const before = models(start),
      blue = before.filter((m) => m.unit === 0);
    expect(new Set(blue.map((m) => `${m.x},${m.y}`)).size).toBe(strength);
    const ranks = new Map<(typeof blue)[number]["x"], typeof blue>();
    for (const m of blue) {
      const row = ranks.get(m.x) ?? [];
      row.push(m);
      ranks.set(m.x, row);
    }
    expect([...ranks].map(([x, row]) => [x, row.length])).toEqual(
      Array.from({ length: Math.ceil(strength / 10) }, (_, i) => [
        i === 0 ? 0 : -5 * i,
        Math.min(10, strength - 10 * i),
      ]),
    );
    for (const row of ranks.values())
      expect(row.map((m) => m.y)).toEqual(
        row.map((_, i) => (i - (Math.min(10, strength) - 1) / 2) * 5),
      );
    const order: FrozenOrder = {
      unitId: "blue",
      memberId: "seat-blue",
      order: {
        kind: "move" as const,
        pace: "march" as const,
        path: [{ x: 100, y: blue[0]?.y ?? 0 }],
      },
    };
    const result = resolveFrozen({
      start,
      scenario,
      orders: [order],
      turnId: 1,
      seed: 17,
    });
    expect(models(result.state)).toEqual(
      before.map((m) => ({ ...m, x: m.unit === 0 ? Number(m.x) + 20 : m.x })),
    );
  },
);

test("the leading file can have a legal destination while a rear rank would march off the map", () => {
  const scenario = field(100, 180);
  scenario.bounds.minX = -50;
  const start = deploy(scenario),
    battle = new BattleView(scenario, start, new Uint8Array(32));
  const member = {
    id: "seat-blue",
    role: "PLAYER" as const,
    factionId: "blue",
    epoch: 1,
  };
  const edit = (x: number) => ({
    unitId: "blue",
    order: {
      kind: "move" as const,
      pace: "march" as const,
      path: [{ x, y: -22.5 }],
    },
  });
  // Rear rank is already at x=-45. -5 is exactly legal; one codec-2 quantum farther is not.
  expect(battle.validate(member, edit(-5.0625))).toBe(
    "Formation would extend outside the battlefield.",
  );
  expect(battle.validate(member, edit(-5))).toBeNull();
  const { state } = resolveFrozen({
    start,
    scenario,
    seed: 17,
    turnId: 1,
    orders: [{ ...edit(-5), memberId: member.id }],
  });
  expect(
    Math.min(
      ...models(state)
        .filter((m) => m.unit === 0)
        .map((m) => Number(m.x)),
    ),
  ).toBe(-50);
});

test.each([17, 42, 119])(
  "casualty compaction and checkpoint restart preserve each surviving unit and ID (seed %i)",
  (seed) => {
    // Two ten-file ranks each. The nearest files touch, without overlapping at deployment.
    const scenario = field(20, 10);
    let start = deploy(scenario),
      lost = 0;
    for (let turnId = 1; turnId <= 5; turnId++) {
      const orders: FrozenOrder[] = ["blue", "red"].flatMap((side, i) =>
        start.units[i]?.range && start.units[1 - i]?.range
          ? [
              {
                unitId: side,
                memberId: `seat-${side}`,
                order: {
                  kind: "attack",
                  mode: "melee",
                  targetUnitId: i ? "blue" : "red",
                },
              },
            ]
          : [],
      );
      const job = { scenario, start, orders, turnId, seed: seed + turnId };
      const { state, rows } = resolveFrozen(job);
      const replay = resolveFrozen(structuredClone(job));
      expect(replay.state.hash).toBe(state.hash);
      expect(replay.rows).toEqual(rows);
      const before = models(start),
        after = models(state);
      expect(new Set(after.map((m) => m.id)).size).toBe(after.length);
      for (const model of after)
        expect(before.find((m) => m.id === model.id)).toEqual(model); // a casualty isn't a free reposition/reform
      for (const [unit, row] of rows.entries()) {
        expect(row.before).toBe(before.filter((m) => m.unit === unit).length);
        expect(row.alive).toBe(after.filter((m) => m.unit === unit).length);
        expect(row.lost).toBe(row.before - row.alive);
        lost += row.lost;
        const range = state.units[unit]?.range;
        if (range)
          expect(after.slice(...range).map((m) => m.unit)).toEqual(
            Array(row.alive).fill(unit),
          );
        else expect(row.alive).toBe(0);
      }
      start = state;
    }
    expect(lost).toBeGreaterThan(0);
    expect(lost + models(start).length).toBe(40);
  },
);

test("a regular projected PF1e caster spends an Entangle slot and publishes a persistent area", () => {
  const scenario = field(20, 180);
  const caster = scenario.commanders[0]?.units[0];
  if (!caster) throw new Error("caster fixture missing");
  caster.spellcasting = { actorId: "druid", itemId: "pf1e-core-spells-entangle", casterLevel: 3,
    castingAbilityMod: 4, entangleSlots: 2 };
  const start = deploy(scenario);
  const battle = new BattleView(scenario, start, new Uint8Array(32));
  const member = { id: "seat-blue", role: "PLAYER" as const, factionId: "blue", epoch: 1 };
  const edit = { unitId: "blue", order: { kind: "cast" as const, spellId: "entangle" as const,
    itemId: "pf1e-core-spells-entangle", origin: { x: 40, y: 0 } } };
  expect(battle.validate(member, edit)).toBeNull();
  const first = resolveFrozen({ start, scenario, turnId: 1, seed: 44,
    orders: [{ ...edit, memberId: member.id }] });
  expect(first.state.units[0]?.stats.entangleSlots).toBe(1);
  expect(first.state.hazards).toEqual([expect.objectContaining({ spell: "entangle", at: { x: 40, y: 0 },
    radius: 40, dc: 15, startsTurn: 1, expiresAfterTurn: 30, casterLevel: 3,
    casterFactionId: "blue" })]);
  expect(first.state.actions).toEqual([expect.objectContaining({ kind: "cast", label: "Entangle",
    state: "resolved", source: expect.objectContaining({ actorId: "druid",
      itemId: "pf1e-core-spells-entangle" }) })]);
  const second = resolveFrozen({ start: first.state, scenario, turnId: 2, seed: 45, orders: [] });
  expect(second.state.hazards).toEqual(first.state.hazards);
  expect(second.state.actions).toEqual(first.state.actions);
});

test("leader-card policy is independent from unit/model cards and never suppresses spell rules", () => {
  const scenario = field(10, 180);
  scenario.actionCards = { playerCharacters: false, units: true, models: true };
  const caster = scenario.commanders[0]?.units[0];
  if (!caster) throw new Error("caster fixture missing");
  caster.spellcasting = { actorId: "druid", itemId: "pf1e-core-spells-entangle", casterLevel: 2,
    castingAbilityMod: 3, entangleSlots: 1 };
  const state = resolveFrozen({ start: deploy(scenario), scenario, turnId: 1, seed: 1,
    orders: [{ unitId: "blue", memberId: "seat-blue", order: { kind: "cast", spellId: "entangle",
      itemId: "pf1e-core-spells-entangle", origin: { x: 30, y: 0 } } }] }).state;
  expect(state.actions).toBeUndefined();
  expect(state.hazards).toHaveLength(1);
  expect(state.units[0]?.stats.entangleSlots).toBe(0);
});

test("hosted PF1e cast authority rejects wrong identity, control, bounds, range, and exhausted resources", () => {
  const scenario = field(10, 180);
  scenario.bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const caster = scenario.commanders[0]?.units[0];
  if (!caster) throw new Error("caster fixture missing");
  caster.spellcasting = { actorId: "druid", itemId: "pf1e-core-spells-entangle", casterLevel: 1,
    castingAbilityMod: 2, entangleSlots: 1 };
  const member = { id: "seat-blue", role: "PLAYER" as const, factionId: "blue", epoch: 1 };
  const start = deploy(scenario);
  const battle = new BattleView(scenario, start, new Uint8Array(32));
  const cast = (origin = { x: 40, y: 0 }, itemId = "pf1e-core-spells-entangle") => ({ unitId: "blue",
    order: { kind: "cast" as const, spellId: "entangle" as const, itemId, origin } });
  expect(battle.validate(member, cast({ x: 40, y: 0 }, "forged-item"))).toMatch(/does not have/);
  expect(battle.validate({ ...member, id: "seat-red", factionId: "red" }, cast())).toMatch(/not assigned/);
  expect(battle.validate(member, cast({ x: 1001, y: 0 }))).toMatch(/outside/);
  expect(battle.validate(member, cast({ x: 500, y: 0 }))).toMatch(/range/);

  const spent = resolveFrozen({ start, scenario, turnId: 1, seed: 1,
    orders: [{ ...cast(), memberId: member.id }] }).state;
  expect(spent.units[0]?.stats.entangleSlots).toBe(0);
  expect(new BattleView(scenario, spent, new Uint8Array(32)).validate(member, cast())).toMatch(/no remaining/);
});

test("duplicate cast orders are rejected before they can spend one slot twice", () => {
  const scenario = field(10, 180);
  const caster = scenario.commanders[0]?.units[0];
  if (!caster) throw new Error("caster fixture missing");
  caster.spellcasting = { actorId: "druid", itemId: "pf1e-core-spells-entangle", casterLevel: 2,
    castingAbilityMod: 3, entangleSlots: 1 };
  const start = deploy(scenario);
  const order: FrozenOrder = { unitId: "blue", memberId: "seat-blue", order: { kind: "cast",
    spellId: "entangle", itemId: "pf1e-core-spells-entangle", origin: { x: 20, y: 0 } } };
  expect(() => resolveFrozen({ start, scenario, turnId: 1, seed: 2,
    orders: [order, structuredClone(order)] })).toThrow(/duplicate orders/);
  expect(start.units[0]?.stats.entangleSlots).toBe(1);
  expect(start.hazards).toBeUndefined();
});

test("projected campaign walls block hosted formations and projected difficult terrain doubles cost", () => {
  const wallScenario = field(1, 180);
  wallScenario.walls = [{ x1: 10, y1: -20, x2: 10, y2: 20, restriction: 1 }];
  const wallStart = deploy(wallScenario);
  const move: FrozenOrder = { unitId: "blue", memberId: "seat-blue",
    order: { kind: "move", pace: "march", path: [{ x: 100, y: 0 }] } };
  const walled = resolveFrozen({ start: wallStart, scenario: wallScenario, turnId: 1,
    seed: 17, orders: [move] });
  expect(Number(models(walled.state).find((model) => model.unit === 0)?.x)).toBeLessThanOrEqual(10);

  const terrainScenario = field(1, 180);
  terrainScenario.terrain = { difficultCells: Array.from({ length: 8 }, (_, col) => ({ col, row: 0 })) };
  const terrainStart = deploy(terrainScenario);
  const slowed = resolveFrozen({ start: terrainStart, scenario: terrainScenario, turnId: 1,
    seed: 17, orders: [move] });
  const open = resolveFrozen({ start: deploy(field(1, 180)), scenario: field(1, 180), turnId: 1,
    seed: 17, orders: [move] });
  const slowedX = Number(models(slowed.state).find((model) => model.unit === 0)?.x);
  const openX = Number(models(open.state).find((model) => model.unit === 0)?.x);
  expect(slowedX).toBeLessThan(openX);
});

test("Entangle and Black Tentacles routes clamp goals and take a stable tangent without ping-pong", () => {
  const hazards = [
    { id: "entangle-1", spell: "entangle" as const, at: { x: 0, y: 0 }, radius: 10 },
    { id: "tentacles-1", spell: "blackTentacles" as const, at: { x: 45, y: 0 }, radius: 10 },
  ];
  const route = routeAroundSpellHazards({ x: -30, y: 0 }, { x: 60, y: 0 }, hazards, 5);
  expect(route.length).toBeGreaterThan(1);
  let from = { x: -30, y: 0 };
  for (const point of route) {
    for (const hazard of hazards)
      expect(segmentHitsSpellHazard(hazard, from, point)).toBe(false);
    from = point;
  }
  expect(routeAroundSpellHazards({ x: -30, y: 0 }, { x: 0, y: 0 }, hazards, 5).at(-1))
    .toEqual({ x: 15, y: 0 });
  expect(routeAroundSpellHazards({ x: -30, y: 0 }, { x: 60, y: 0 }, hazards, 5)).toEqual(route);
});

test("an 80-model hosted formation routes every file around an active Entangle zone", () => {
  const scenario = field(80, 300);
  const blueUnit = scenario.commanders[0]?.units[0];
  const redUnit = scenario.commanders[1]?.units[0];
  if (!blueUnit || !redUnit) throw new Error("hazard fixture units missing");
  blueUnit.anchor = { x: -150, y: 0 };
  redUnit.anchor = { x: 150, y: 0 };
  scenario.hazards = [{ id: "entangle-1", spell: "entangle", at: { x: -125, y: 0 }, radius: 10 }];
  const start = deploy(scenario);
  const result = resolveFrozen({
    start, scenario, turnId: 1, seed: 17,
    orders: [{
      unitId: "blue", memberId: "seat-blue",
      order: { kind: "move", pace: "march", path: [{ x: -100, y: 0 }] },
    }],
  });
  const blue = models(result.state).filter((model) => model.unit === 0);
  expect(blue.some((model, index) => model.x !== models(start)[index]?.x)).toBe(true);
  for (const model of blue)
    expect(Math.hypot(Number(model.x) + 125, Number(model.y))).toBeGreaterThan(10);
});

test("Burning Entanglement damage and Black Tentacles CMB/grapple/constriction are deterministic", () => {
  const scenario = field(20, 80);
  scenario.hazards = [
    { id: "burning-1", spell: "burningEntanglement", at: { x: 0, y: 0 }, radius: 40,
      dc: 18, startsTurn: 1, expiresAfterTurn: 3 },
    { id: "tentacles-1", spell: "blackTentacles", at: { x: 80, y: 0 }, radius: 40,
      casterLevel: 8, casterFactionId: "blue", startsTurn: 1, expiresAfterTurn: 3 },
  ];
  const start = deploy(scenario);
  const firstJob = { start, scenario, turnId: 1, seed: 991, orders: [] };
  const first = resolveFrozen(firstJob);
  expect(resolveFrozen(structuredClone(firstJob)).state.hash).toBe(first.state.hash);
  const firstPool = checkpointPool(first.state);
  const redHeld = Array.from(firstPool.sys.pfCondition ?? []).filter((value) =>
    (value & (1 << 14)) !== 0).length;
  expect(redHeld).toBeGreaterThan(0);
  expect(first.rows[0]?.lost).toBeGreaterThan(0);

  const secondJob = { start: first.state, scenario, turnId: 2, seed: 992, orders: [] };
  const second = resolveFrozen(secondJob);
  expect(resolveFrozen(structuredClone(secondJob)).state.hash).toBe(second.state.hash);
  expect(models(second.state).length).toBeLessThan(models(first.state).length); // held tentacles constrict
});

test("persistent spell hazards are replay-safe, expire, clear their condition, and allow reforming", () => {
  const scenario = field(20, 180);
  scenario.hazards = [{ id: "entangle-1", spell: "entangle", at: { x: 0, y: 0 },
    radius: 40, dc: 100, startsTurn: 1, expiresAfterTurn: 1, casterLevel: 5 }];
  const start = deploy(scenario);
  const order = (): FrozenOrder => ({ unitId: "blue", memberId: "seat-blue",
    order: { kind: "move", pace: "march", path: [{ x: 80, y: 0 }] } });
  const firstJob = { start, scenario, turnId: 1, seed: 719, orders: [order()] };
  const first = resolveFrozen(firstJob);
  expect(resolveFrozen(structuredClone(firstJob)).state.hash).toBe(first.state.hash);
  const firstPool = checkpointPool(first.state);
  expect(Array.from(firstPool.sys.pfCondition ?? []).some((value) => (value & (1 << 13)) !== 0)).toBe(true);

  const second = resolveFrozen({ start: first.state, scenario, turnId: 2, seed: 720, orders: [order()] });
  const secondPool = checkpointPool(second.state);
  expect(Array.from(secondPool.sys.pfCondition ?? []).every((value) => (value & (1 << 13)) === 0)).toBe(true);
  expect(models(second.state).filter((model) => model.unit === 0).some((model) => Number(model.x) > 0)).toBe(true);
});

test("the hosted service does not silently accept remaining reference-only mechanics", () => {
  const scenario = field(10, 20);
  for (const attr of [
    { areas: [{ type: "blackTentacles" }] },
    { terrain: { difficultCells: [{ col: 999, row: 1 }] } },
    { strategicDoctrine: true },
  ])
    expect(() => parseScenario({ ...scenario, ...attr })).toThrow();
  const submit = (order: unknown) =>
    parseCommand({
      kind: "orders.submit",
      turnId: 1,
      requestId: "request_12345678",
      expectedRevision: 0,
      unitEdits: [{ unitId: "blue", order }],
    });
  expect(submit({ kind: "hold", stance: "hold" })).not.toBeNull();
  for (const order of [
    { kind: "formation", formation: "column" },
    { kind: "reform" },
    { kind: "envelop" },
    { kind: "custom", type: "avoidHazard" },
  ])
    expect(submit(order)).toBeNull();
});

function marches(
  strength: number,
  distance: number,
  paths: { x: number; y: number }[][],
  reverse = false,
) {
  const scenario = field(strength, distance),
    start = deploy(scenario),
    battle = new BattleView(scenario, start, new Uint8Array(32));
  const orders: FrozenOrder[] = paths.map((path, i) => {
    const side = i ? "red" : "blue";
    return {
      unitId: side,
      memberId: `seat-${side}`,
      order: { kind: "move", pace: "march", path },
    };
  });
  for (const edit of orders)
    expect(
      battle.validate(
        { role: "PLAYER", epoch: 1, id: edit.memberId, factionId: edit.unitId },
        edit,
      ),
    ).toBeNull();
  const result = resolveFrozen({
    scenario,
    start,
    orders: reverse ? orders.reverse() : orders,
    seed: 17,
    turnId: 1,
  });
  const positions = models(result.state);
  expect(
    new Set(
      positions.map(
        (p) => `${Math.floor(Number(p.x) / 5)},${Math.floor(Number(p.y) / 5)}`,
      ),
    ).size,
  ).toBe(positions.length);
  return {
    positions,
    hash: result.state.hash,
    blocked: result.rows.filter((r) => r.marchBlocked).map((r) => r.unitId),
  };
}
test("simultaneous converging marches reserve cells in roster order, independent of submission order", () => {
  const paths = [[{ x: 10, y: 0 }], [{ x: 10, y: 0 }]];
  const forward = marches(1, 20, paths);
  expect(marches(1, 20, paths, true)).toEqual(forward);
  expect(forward.positions.map((m) => m.x)).toEqual([10, 15]);
  expect(forward.blocked).toEqual(["red"]);
});
test("an entire company stops short of a stationary rank even if the ordered endpoint is clear", () => {
  const { positions, blocked } = marches(20, 10, [[{ x: 20, y: -22.5 }]]);
  expect(blocked).toEqual(["blue"]);
  expect(positions[0]?.x).toBe(4);
  expect(positions[10]?.x).toBe(-1);
});
test("waypoint legs cannot tunnel through a blocker and return to a clear endpoint", () => {
  const { positions, blocked } = marches(1, 10, [
    [
      { x: 12, y: 0 },
      { x: 5, y: 0 },
    ],
  ]);
  expect(blocked).toEqual(["blue"]);
  expect(positions[0]?.x).toBe(9);
});

test("checks outlying files, not only the anchor path", () => {
  const scenario = field(10, 10),
    foe = scenario.commanders[1]?.units[0];
  if (!foe) throw Error("missing defender");
  foe.strength = 1;
  foe.anchor.y = 22.5;
  const { state, rows } = resolveFrozen({
    start: deploy(scenario),
    scenario,
    turnId: 1,
    seed: 17,
    orders: [
      {
        unitId: "blue",
        memberId: "seat-blue",
        order: { kind: "move", pace: "march", path: [{ x: 20, y: -22.5 }] },
      },
    ],
  });
  expect(rows[0]?.marchBlocked).toBe(true);
  expect(
    models(state)
      .slice(0, 10)
      .map((m) => m.x),
  ).toEqual(Array(10).fill(9));
});
test("a clear multi-leg route around the defender can use its full budget", () => {
  const { positions, blocked } = marches(1, 5, [
    [
      { x: 0, y: 5 },
      { x: 10, y: 5 },
      { x: 10, y: 0 },
    ],
  ]);
  expect(blocked).toEqual([]);
  expect(positions[0]).toMatchObject({ x: 10, y: 0 });
});
