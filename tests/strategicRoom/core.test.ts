import { describe, expect, test } from "vitest";
import {
  parseAuth,
  parseCommand,
  type Command,
  type RegionPatch,
} from "../../src/core/strategicRoom/protocol";
import { RegionReplica } from "../../src/core/strategicRoom/regionReplica";
import { extractScenario } from "../../services/strategic-room/src/worldExtract";
import {
  BattleView,
  diffRegion,
} from "../../services/strategic-room/src/battle";
import {
  deploy,
  generatedScenario,
  parseScenario,
} from "../../services/strategic-room/src/scenario";
import { resolveFrozen } from "../../services/strategic-room/src/resolve";
import {
  checkpointPool,
  type Member,
} from "../../services/strategic-room/src/state";

const blue: Member = {
  id: "commander-1",
  role: "PLAYER",
  factionId: "blue",
  epoch: 1,
};
const mapKey = new Uint8Array(32);
const id = "request_12345678";
const order: Command = {
  kind: "orders.submit",
  requestId: id,
  turnId: 1,
  expectedRevision: 0,
  unitEdits: [{ unitId: "unit-1-1", order: { kind: "hold", stance: "hold" } }],
};

describe("hosted wire and allowlist", () => {
  test("does not accept generic Unit updates, duplicate edits or extra authority fields", () => {
    expect(parseCommand(order)).toEqual(order);
    for (const invalid of [
      null,
      { ...order, issuedBy: "gm" },
      { ...order, expectedRevision: -1 },
      { ...order, unitEdits: [...order.unitEdits, ...order.unitEdits] },
      { ...order, unitEdits: [] },
      { kind: "intent", requestId: id, ops: [] },
      {
        ...order,
        unitEdits: [
          {
            unitId: "unit-1-1",
            order: {
              kind: "move",
              pace: "march",
              path: [{ x: Infinity, y: 0 }],
            },
          },
        ],
      },
      {
        ...order,
        unitEdits: [
          {
            unitId: "unit-1-1",
            order: { kind: "custom", type: "spell_aoe", data: {} },
          },
        ],
      },
    ]) {
      expect(parseCommand(invalid)).toBeNull();
    }
    expect(
      parseAuth({
        kind: "auth",
        publicKey: "a".repeat(64),
        signature: "b".repeat(128),
      }),
    ).not.toBeNull();
    expect(
      parseAuth({
        kind: "auth",
        publicKey: "a".repeat(64),
        signature: "b".repeat(128),
        role: "GM",
      }),
    ).toBeNull();
  });
  test("rejects unapproved room features, unconstrained fog maps and overlapping formations", () => {
    const scenario = generatedScenario();
    expect(() => parseScenario({ ...scenario, walls: [] })).toThrow(
      /supported fields/,
    );
    expect(() =>
      parseScenario({
        ...scenario,
        bounds: { ...scenario.bounds, maxX: 55000 },
      }),
    ).toThrow(/span/);
    const b = scenario.commanders[0]?.units[0],
      r = scenario.commanders[1]?.units[0];
    if (!b || !r) throw new Error("Missing fixture units");
    r.anchor = b.anchor;
    expect(() => deploy(scenario)).toThrow(/overlap/);
  });
});

describe("projected checkpoints", () => {
  test("hides enemy IDs and coordinates until detected, and rejects an attack on a hidden unit", () => {
    const scenario = generatedScenario();
    const hidden = scenario.commanders[1]?.units[0];
    if (!hidden) throw new Error("Missing fixture unit");
    hidden.anchor.y = scenario.bounds.maxY - 25;
    hidden.name = "Hidden scout";
    const state = deploy(scenario);
    const battle = new BattleView(scenario, state, mapKey);
    expect(battle.own(blue)).toHaveLength(5);
    expect(JSON.stringify(battle.markers(blue))).not.toContain("Hidden scout");
    expect(battle.region(blue, "0,0").some((m) => m.unitId === hidden.id)).toBe(
      false,
    );
    expect(
      battle.validate(blue, {
        unitId: "unit-1-1",
        order: { kind: "attack", mode: "melee", targetUnitId: hidden.id },
      }),
    ).toBe("Target is not an available enemy.");
    expect(battle.validate(blue, { unitId: hidden.id, order: null })).toMatch(
      /not assigned/,
    );
    expect(
      battle.validate(blue, {
        unitId: "unit-1-1",
        order: { kind: "move", pace: "march", path: [{ x: 1e10, y: 0 }] },
      }),
    ).toMatch(/outside/);
  });
  test("replays identical wide checkpoints and reveal/move/leave patches with stable IDs", () => {
    const scenario = generatedScenario();
    const own = scenario.commanders[0]?.units[0];
    for (const commander of scenario.commanders)
      commander.units = commander.units.slice(0, 1);
    const red = scenario.commanders[1]?.units[0];
    if (!own || !red) throw new Error("Missing fixture unit");
    red.anchor.x = own.anchor.x + 40;
    const start = deploy(scenario);
    const first = new BattleView(scenario, start, mapKey);
    expect(first.markers(blue).some((m) => m.id === red.id)).toBe(false);
    const to = { x: own.anchor.x + 20, y: own.anchor.y - 22.5 };
    const job = {
      scenario,
      start,
      turnId: 1,
      seed: 21,
      orders: [
        {
          memberId: blue.id,
          unitId: own.id,
          order: { kind: "move", path: [to], pace: "march" } as const,
        },
      ],
    };
    // Make the waypoint list writable for the Order contract.
    const input = {
      ...job,
      orders: job.orders.map((o) => ({
        ...o,
        order: { ...o.order, path: [...o.order.path] },
      })),
    };
    const a = resolveFrozen(input),
      b = resolveFrozen(input);
    expect(a.state.hash).toBe(b.state.hash);
    expect(a.report).toEqual(b.report);
    expect(checkpointPool(a.state).x[0]).toBe(to.x);
    const second = new BattleView(scenario, a.state, mapKey);
    expect(second.markers(blue).some((m) => m.id === red.id)).toBe(true);
    const map = (view: BattleView) =>
      new Map(view.region(blue, "0,0").map((m) => [m.id, m]));
    const patch = diffRegion(map(first), map(second));
    expect(patch.enter.some((m) => m.unitId === red.id)).toBe(true);
    expect(
      patch.update.some((m) => m.unitId === own.id && map(first).has(m.id)),
    ).toBe(true);
    expect(diffRegion(map(second), map(first)).leave).toEqual(
      patch.enter.map((m) => m.id),
    );
  });
  test("only applies correct-region baselines and sequential cursor/epoch deltas", () => {
    const replica = new RegionReplica();
    replica.clear("current");
    const model = {
      id: "opaque-1",
      unitId: "visible",
      x: 4000,
      y: -10000,
      rotation: 0,
    };
    const baseline: RegionPatch = {
      epoch: "current",
      version: 1,
      cursor: 1,
      fromCursor: null,
      enter: [model],
      update: [],
      leave: [],
      truncated: false,
    };
    expect(replica.apply(baseline, 1)).toBe(true);
    const leave = {
      ...baseline,
      version: 2,
      cursor: 2,
      fromCursor: 1,
      enter: [],
      leave: [model.id],
    };
    expect(replica.apply({ ...leave, fromCursor: 7 }, 2)).toBe(false);
    expect(replica.apply({ ...leave, epoch: "old" }, 2)).toBe(false);
    expect(replica.apply(leave, 1)).toBe(false);
    expect(replica.models.get(model.id)).toEqual(model);
    expect(replica.apply(leave, 2)).toBe(true);
    expect(replica.models.size).toBe(0);
  });
});

test("offline extraction copies only allowed strategic deployment fields from a world export", () => {
  const scenario = generatedScenario();
  const docs = [
    {
      coll: "scenes",
      id: "field",
      doc: {
        grid: { type: "square", distance: 5 },
        flags: { core: { scale: "strategic" } },
        walls: [],
        img: "private-asset",
      },
    },
    ...scenario.factions.map((f) => ({ coll: "factions", id: f.id, doc: f })),
    ...scenario.commanders.map((c) => ({
      coll: "armies",
      id: c.id,
      doc: {
        factionId: c.factionId,
        commander: ["private-owner"],
        units: c.units.map((u) => ({
          _id: u.id,
          name: u.name,
          type: "infantry",
          formation: "line",
          sceneId: "field",
          stats: {
            strength: u.strength,
            weaponIsRanged: u.weapon === "shot" ? 1 : 0,
          },
          profile: { anchor: u.anchor },
          orders: { private: "pending spell" },
        })),
      },
    })),
  ];
  const layout = {
    sceneId: "field",
    name: scenario.name,
    bounds: scenario.bounds,
    seed: scenario.seed,
    slots: Object.fromEntries(scenario.commanders.map((c) => [c.id, c.id])),
  };
  const extracted = extractScenario({ docs }, layout);
  expect(extracted).toEqual(scenario);
  expect(JSON.stringify(extracted)).not.toMatch(
    /private-owner|private-asset|pending spell/,
  );
  expect(() =>
    extractScenario(
      { docs },
      { ...layout, slots: { one: "commander-1", two: "commander-1" } },
    ),
  ).toThrow(/unique/);
});
