import { expect, test } from "vitest";
import { SimRunnerCore } from "../../src/sim/runner";
import { emptyRulesWalls } from "../../src/sim/turnPlan";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { encodeSimSnapshot, snapshotFromPool } from "../../src/sim/codec";
import { createMassBattleBasic } from "../../src/packages/massBattleBasic";
import { SimPositionRangeError } from "../../src/core/sim";

test("refuses an overflowing resolution without changing its published pool, version or rules state", () => {
  const pool = createModelPool(1);
  allocModel(pool, { id: 1, unitIdx: 0, x: -2050, y: 2550, hp: 1 });
  const basic = createMassBattleBasic();
  let attempts = 0;
  let shouldOverflow = true;
  const runner = new SimRunnerCore(
    {
      sceneId: "map",
      sys: {},
      codecVersion: 2,
      ctx: {
        sceneId: "map",
        grid: {
          size: 100,
          type: "square",
          distance: 5,
          units: "ft",
          diagonals: "555",
        },
        walls: emptyRulesWalls(),
        factions: [],
        armies: [],
        leaderActors: {},
        worldSettings: {},
      },
      units: [],
      snapshot: {
        bytes: encodeSimSnapshot(snapshotFromPool(pool, "map", 9, {}, 2), 1),
        maxHpMax: 1,
        version: 9,
      },
    },
    {
      ...basic,
      prepareRollback() {
        const before = attempts;
        return () => {
          attempts = before;
        };
      },
      resolveTurn(_ctx, moving) {
        attempts++;
        moving.x[0] = shouldOverflow ? 524288 : -4050;
      },
    },
  );
  const before = runner.hash();
  const request = { orders: [], seed: 13, turnNumber: 10 };
  expect(() => runner.resolve(request)).toThrow(SimPositionRangeError);
  expect(runner.hash()).toBe(before);
  expect(runner.poolVersion).toBe(9);
  expect(attempts).toBe(0);
  shouldOverflow = false;
  expect(runner.resolve(request).toVersion).toBe(10);
  expect(attempts).toBe(1);
});
