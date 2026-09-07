import { describe, expect, test } from "vitest";
import { ModelStatus } from "../../src/core/strategic";
import {
  REMOVED_INDEX,
  allocModel,
  bytesPerModel,
  clonePool,
  compactPool,
  createModelPool,
  freeModel,
  hashPool,
} from "../../src/sim/pool";

const SCHEMA = { ammo: "u8", fatigue: "f32" } as const;

function filledPool(n: number): ReturnType<typeof createModelPool> {
  const pool = createModelPool(n, SCHEMA);
  for (let i = 0; i < n; i++) {
    allocModel(pool, {
      id: 1000 + i,
      unitIdx: i % 4,
      x: i * 0.25,
      y: (i % 7) * 1.5,
      hp: 3,
      hpMax: 4,
      sys: { ammo: 10, fatigue: i * 0.01 },
    });
  }
  return pool;
}

describe("ModelPool (§4A)", () => {
  test("alloc fills sequentially and reuses the free-list", () => {
    const pool = createModelPool(4, SCHEMA);
    const a = allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hpMax: 1, hp: 1 });
    const b = allocModel(pool, { id: 2, unitIdx: 0, x: 1, y: 0, hpMax: 1, hp: 1 });
    expect(pool.count).toBe(2);
    freeModel(pool, a);
    const c = allocModel(pool, { id: 3, unitIdx: 1, x: 2, y: 0, hpMax: 1, hp: 1 });
    expect(c).toBe(a); // slot recycled
    expect(pool.count).toBe(2);
    expect(pool.id[c]).toBe(3);
    expect(b).toBe(1);
  });

  test("freeModel is idempotent (double free does not double-push)", () => {
    const pool = createModelPool(4);
    const a = allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0 });
    freeModel(pool, a);
    freeModel(pool, a);
    expect(pool.freeTop).toBe(1);
    expect(pool.status[a]).toBe(ModelStatus.dead);
  });

  test("alloc past capacity throws", () => {
    const pool = createModelPool(1);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0 });
    expect(() => allocModel(pool, { id: 2, unitIdx: 0, x: 0, y: 0 })).toThrow(/exhausted/);
  });

  test("compactPool drops dead slots, preserves order, remaps indices", () => {
    const pool = filledPool(10);
    freeModel(pool, 2);
    freeModel(pool, 5);
    freeModel(pool, 6);
    const remap = compactPool(pool);
    expect(pool.count).toBe(7);
    expect(remap[2]).toBe(REMOVED_INDEX);
    expect(remap[5]).toBe(REMOVED_INDEX);
    expect(remap[6]).toBe(REMOVED_INDEX);
    // surviving relative order preserved: ids ascending
    const ids = Array.from(pool.id.slice(0, pool.count));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(pool.freeTop).toBe(0);
    // a unit that owned [4,7) now owns contiguous remapped range
    expect(remap[4] ?? 0).toBeLessThan(remap[6] ?? 0);
  });

  test("clonePool is deep and independent", () => {
    const a = filledPool(8);
    const b = clonePool(a);
    b.x[3] = 99;
    if (b.sys.fatigue) b.sys.fatigue[3] = 99;
    expect(a.x[3]).not.toBe(99);
    expect(a.sys.fatigue?.[3]).not.toBe(99);
  });

  test("hashPool: equal states equal, any live-bit change differs", () => {
    const a = filledPool(16);
    const b = clonePool(a);
    expect(hashPool(a)).toBe(hashPool(b));
    b.hp[7] = (b.hp[7] ?? 0) + 0.5;
    expect(hashPool(a)).not.toBe(hashPool(b));
    // dead slots past count are not logical state
    const c = clonePool(a);
    c.x[c.count + 3] = 12345; // junk beyond live prefix
    expect(hashPool(a)).toBe(hashPool(c));
  });

  test("byte budget: ≤ 200 B/model with a realistic schema (§19)", () => {
    const pool = createModelPool(10_000, { ammo: "u8", fatigue: "f32", orders: "u16" });
    expect(bytesPerModel(pool)).toBeLessThanOrEqual(200);
  });
});
