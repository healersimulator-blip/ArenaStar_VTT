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
test.each([1, 9, 10, 11, 19, 20, 21, 99, 100])(
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

test("the hosted service does not silently accept reference-only mechanics", () => {
  const scenario = field(10, 20);
  for (const attr of [
    { areas: [{ type: "blackTentacles" }] },
    { terrain: { difficultCells: [{ col: 2, row: 1 }] } },
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
