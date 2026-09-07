import { describe, expect, test } from "vitest";
import { PoolInterpolator, RT_INTERP_DELAY_MS } from "../../src/sim/interpolate";
import { createModelPool, allocModel } from "../../src/sim/pool";
import { MASS_BATTLE_SCHEMA_COLUMNS } from "../../src/packages/massBattleBasic";
import type { ModelPool } from "../../src/core/strategic";

function poolAt(x0: number): ModelPool {
  const pool = createModelPool(4, MASS_BATTLE_SCHEMA_COLUMNS);
  for (let i = 0; i < 3; i++) {
    allocModel(pool, {
      id: i + 1,
      unitIdx: 0,
      x: x0 + i,
      y: 10,
      hp: 1,
      hpMax: 1,
      sys: { ammo: 6 },
    });
  }
  return pool;
}

describe("PoolInterpolator (§5A realtime interpolation)", () => {
  test("mid-interval sample lerps between the last two states", () => {
    const interp = new PoolInterpolator(200);
    const a = poolAt(0);
    interp.push(a, 1_000);
    const b = poolAt(10);
    interp.push(b, 1_200); // 200 ms apart
    expect(interp.interpolating).toBe(true);

    // exactly halfway (now - delay === prevAt + span/2 → alpha 0.5)
    const half = interp.sampleXY(1_000 + 100 + 200);
    expect(half.x[0]).toBeCloseTo(5, 5);
    expect(half.y[0]).toBeCloseTo(10, 5);
    expect(interp.stats.interpolatedMoves).toBe(1);
  });

  test("clamps to prev before the window and cur after it", () => {
    const interp = new PoolInterpolator(200);
    interp.push(poolAt(0), 1_000);
    interp.push(poolAt(10), 1_200);
    expect(interp.sampleXY(1_000).x[0]).toBeCloseTo(0, 5); // before window
    expect(interp.sampleXY(2_000).x[0]).toBeCloseTo(10, 5); // after window
  });

  test("single state (nothing to interpolate) snaps to current", () => {
    const interp = new PoolInterpolator();
    interp.push(poolAt(42), 1_000);
    expect(interp.interpolating).toBe(false);
    const s = interp.sampleXY(1_500);
    expect(s.x[0]).toBeCloseTo(42, 5);
    expect(interp.stats.interpolatedMoves).toBe(0);
  });

  test("pool count change never lerps across the boundary", () => {
    const interp = new PoolInterpolator(200);
    const small = poolAt(0);
    interp.push(small, 1_000);
    const bigger = poolAt(10);
    allocModel(bigger, { id: 99, unitIdx: 0, x: 99, y: 10, hp: 1, hpMax: 1, sys: { ammo: 6 } });
    interp.push(bigger, 1_200);
    const s = interp.sampleXY(1_300); // mid-window, but count changed
    expect(s.x.length).toBe(4);
    expect(s.x[3]).toBeCloseTo(99, 5);
  });

  test("default delay is ~two 5 Hz flush intervals", () => {
    expect(RT_INTERP_DELAY_MS).toBe(240);
  });
});
