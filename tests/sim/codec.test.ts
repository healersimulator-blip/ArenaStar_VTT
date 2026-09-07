import { describe, expect, test } from "vitest";
import { ModelStatus } from "../../src/core/strategic";
import type { ModelPool } from "../../src/core/strategic";
import {
  applySimDelta,
  decodeSimDelta,
  decodeSimSnapshot,
  diffPools,
  encodeSimDelta,
  encodeSimSnapshot,
  poolFromSnapshot,
  snapshotFromPool,
} from "../../src/sim/codec";
import { allocModel, clonePool, createModelPool, hashPool } from "../../src/sim/pool";

const SYS = { ammo: "u8", fatigue: "f32" } as const;
const SCENE = "scene-test";

function filledPool(n: number, seed = 1): ModelPool {
  const pool = createModelPool(n, SYS);
  let rng = seed;
  const rand = (): number => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 0x100000000;
  };
  for (let i = 0; i < n; i++) {
    allocModel(pool, {
      id: 5000 + i,
      unitIdx: i % 4,
      x: rand() * 100,
      y: rand() * 100,
      rot: rand() * Math.PI * 2,
      hp: 1 + Math.floor(rand() * 4),
      hpMax: 4,
      status: rand() < 0.1 ? ModelStatus.engaged : 0,
      sys: { ammo: Math.floor(rand() * 12), fatigue: rand() },
    });
  }
  return pool;
}

const maxHpMax = (pool: ModelPool): number => {
  let m = 1;
  for (let i = 0; i < pool.count; i++) m = Math.max(m, pool.hpMax[i] ?? 0);
  return m;
};

describe("SimSnapshot codec (§5A)", () => {
  test("round-trips a pool within quantization error", () => {
    const pool = filledPool(500);
    const snap = snapshotFromPool(pool, SCENE, 7, SYS);
    const wire = encodeSimSnapshot(snap, maxHpMax(pool));
    const { snapshot, maxHpMax: m } = decodeSimSnapshot(wire);
    expect(snapshot.version).toBe(7);
    const replica = poolFromSnapshot(snapshot, m, SYS);
    expect(replica.count).toBe(pool.count);
    for (let i = 0; i < pool.count; i++) {
      expect(replica.id[i]).toBe(pool.id[i]);
      expect(replica.unitIdx[i]).toBe(pool.unitIdx[i]);
      expect(replica.status[i]).toBe(pool.status[i]);
      expect(replica.facing[i]).toBe(pool.facing[i]);
      expect(Math.abs(replica.x[i] ?? 0) - (pool.x[i] ?? 0)).toBeLessThanOrEqual(1 / 32); // grid/16
      expect(Math.abs(replica.y[i] ?? 0) - (pool.y[i] ?? 0)).toBeLessThanOrEqual(1 / 32);
      expect(replica.sys.ammo?.[i] ?? -1).toBe(pool.sys.ammo?.[i] ?? -1);
      expect(Math.abs((replica.sys.fatigue?.[i] ?? 0) - (pool.sys.fatigue?.[i] ?? 0))).toBeLessThan(
        1e-6,
      );
      // hp permille of hpMax round-trips to ~0.4% of hpMax
      expect(Math.abs((replica.hp[i] ?? 0) - (pool.hp[i] ?? 0))).toBeLessThanOrEqual(
        (pool.hpMax[i] ?? 0) * 0.0011,
      );
    }
  });

  test("snapshot wire size ≤ 1.5 MB at 10k models (§19 budget)", () => {
    const pool = filledPool(10_000);
    const wire = encodeSimSnapshot(snapshotFromPool(pool, SCENE, 1, SYS), maxHpMax(pool));
    expect(wire.byteLength).toBeLessThanOrEqual(1.5 * 1024 * 1024);
  });
});

describe("SimDelta codec (§5A)", () => {
  test("diff + apply reproduces the next state (subset changed)", () => {
    const prev = filledPool(300, 11);
    const next = clonePool(prev);
    // move ~10% of models, damage ~5%, flip one status, drain ammo on 3
    for (let i = 0; i < 30; i++) {
      next.x[i * 10] = (next.x[i * 10] ?? 0) + 2.5;
      next.y[i * 10] = (next.y[i * 10] ?? 0) - 1.25;
    }
    for (let i = 0; i < 15; i++) next.hp[i * 20] = Math.max(0, (next.hp[i * 20] ?? 0) - 1);
    next.status[9] = ModelStatus.pinned;
    for (let i = 0; i < 3; i++) {
      const ammo = next.sys.ammo;
      if (ammo) ammo[i] = 1;
    }

    const delta = diffPools(prev, next, SCENE, SYS);
    delta.fromVersion = 10;
    delta.toVersion = 11;
    const wire = encodeSimDelta(delta, maxHpMax(next));
    const { delta: decoded, maxHpMax: m } = decodeSimDelta(wire);
    expect(decoded.fromVersion).toBe(10);
    expect(decoded.toVersion).toBe(11);

    // replica starts from prev's snapshot, applies delta sequentially
    const replica = poolFromSnapshot(snapshotFromPool(prev, SCENE, 10, SYS), maxHpMax(prev), SYS);
    applySimDelta(replica, decoded, m, SYS);
    for (let i = 0; i < next.count; i++) {
      expect(Math.abs((replica.x[i] ?? 0) - (next.x[i] ?? 0))).toBeLessThanOrEqual(1 / 32);
      expect(Math.abs((replica.hp[i] ?? 0) - (next.hp[i] ?? 0))).toBeLessThanOrEqual(
        (next.hpMax[i] ?? 0) * 0.0011,
      );
      expect(replica.sys.ammo?.[i] ?? -1).toBe(next.sys.ammo?.[i] ?? -1);
    }
    expect(replica.status[9]).toBe(ModelStatus.pinned);
  });

  test("sub-quantum drift produces no delta columns", () => {
    const prev = filledPool(50, 3);
    const next = clonePool(prev);
    next.x[0] = (next.x[0] ?? 0) + 1 / 64; // below grid/16 quantum
    const delta = diffPools(prev, next, SCENE, SYS);
    expect(delta.columns.find((c) => c.column === "x")).toBeUndefined();
  });

  test("full resend when > 60% of a column changed", () => {
    const prev = filledPool(100, 5);
    const next = clonePool(prev);
    for (let i = 0; i < 70; i++) next.hp[i] = (prev.hp[i] ?? 0) === 1 ? 2 : 1;
    const delta = diffPools(prev, next, SCENE, SYS);
    const hp = delta.columns.find((c) => c.column === "hp");
    expect(hp?.fullResend).toBe(true);
    expect(hp?.runs).toEqual([]);
  });

  test("deltas are byte-deterministic for identical inputs", () => {
    const prev = filledPool(80, 9);
    const next = clonePool(prev);
    for (let i = 0; i < 8; i++) next.x[i] = (next.x[i] ?? 0) + 3;
    const d1 = { ...diffPools(prev, next, SCENE, SYS), fromVersion: 1, toVersion: 2 };
    const d2 = { ...diffPools(prev, next, SCENE, SYS), fromVersion: 1, toVersion: 2 };
    expect(Buffer.from(encodeSimDelta(d1, 4))).toEqual(Buffer.from(encodeSimDelta(d2, 4)));
  });

  test("wire budgets: delta ≤ 200 KB at 10% movement; tick ≤ 30 KB at 5 Hz drift (§19)", () => {
    const prev = filledPool(10_000, 13);
    const next = clonePool(prev);
    // 10% of the army moves ~2 grid units
    for (let i = 0; i < 1000; i++) {
      next.x[i] = (next.x[i] ?? 0) + 2.0625;
      next.y[i] = (next.y[i] ?? 0) - 1.0625;
    }
    const big = encodeSimDelta(
      { ...diffPools(prev, next, SCENE, SYS), fromVersion: 0, toVersion: 1 },
      4,
    );
    expect(big.byteLength).toBeLessThanOrEqual(200 * 1024);

    // a 5 Hz realtime tick moves ~2% slightly + hp attrition on 1%
    const tickPrev = clonePool(prev);
    const tickNext = clonePool(prev);
    for (let i = 0; i < 200; i++) {
      tickNext.x[i] = (tickNext.x[i] ?? 0) + 0.3125;
      tickNext.y[i] = (tickNext.y[i] ?? 0) + 0.1875;
    }
    for (let i = 0; i < 100; i++) tickNext.hp[i] = (tickNext.hp[i] ?? 0) - 0.25;
    const tick = encodeSimDelta(
      { ...diffPools(tickPrev, tickNext, SCENE, SYS), fromVersion: 1, toVersion: 2 },
      4,
    );
    expect(tick.byteLength).toBeLessThanOrEqual(30 * 1024);
  });

  test("hashPool over snapshot replica of a quantized-exact pool matches", () => {
    // Build a pool whose float coordinates are exact multiples of 1/16 so the
    // codec is lossless → replica hash must equal source hash (§5A replay).
    const pool = createModelPool(64, SYS);
    for (let i = 0; i < 64; i++) {
      allocModel(pool, {
        id: i,
        unitIdx: i % 2,
        x: (i % 8) * 1.5,
        y: Math.floor(i / 8) * 2,
        hp: 2,
        hpMax: 4,
        sys: { ammo: 5, fatigue: 0.5 },
      });
    }
    const replica = poolFromSnapshot(snapshotFromPool(pool, SCENE, 0, SYS), 4, SYS);
    expect(hashPool(replica)).toBe(hashPool(pool));
  });

  test("i8 sys columns round-trip (signed, 1 byte) — regression for the PF1e save columns", () => {
    // `ModelColumnType` admits i8, and `rulesLoader`/`packageManifest` validate it, but the
    // wire kinds once omitted it: an i8 column packed to a zero-length buffer (silently
    // dropped from the delta) and `canonicalPoolHash` threw RangeError on the first turn of
    // any battle whose module declared one.
    const I8_SYS = { fort: "i8", ref: "i8", will: "i8", ac: "u8" } as const;
    const pool = createModelPool(8, I8_SYS);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 4, hpMax: 8, sys: { fort: 7, ref: -3, will: 2, ac: 19 } });
    allocModel(pool, { id: 2, unitIdx: 0, x: 1, y: 0, hp: 8, hpMax: 8, sys: { fort: -128, ref: 127, will: 0, ac: 10 } });

    const replica = poolFromSnapshot(snapshotFromPool(pool, SCENE, 0, I8_SYS), 8, I8_SYS);
    expect(replica.sys["fort"]?.[0]).toBe(7);
    expect(replica.sys["ref"]?.[0]).toBe(-3); // negatives survive
    expect(replica.sys["will"]?.[0]).toBe(2);
    expect(replica.sys["fort"]?.[1]).toBe(-128); // full signed range
    expect(replica.sys["ref"]?.[1]).toBe(127);
    expect(replica.sys["ac"]?.[0]).toBe(19);

    // the same columns through the delta path, which packs per changed column
    const empty = createModelPool(8, I8_SYS);
    for (let i = 0; i < 2; i++) {
      allocModel(empty, { id: i + 1, unitIdx: 0, x: 0, y: 0, hp: 8, hpMax: 8, sys: { fort: 0, ref: 0, will: 0, ac: 10 } });
    }
    const wire = encodeSimDelta(diffPools(empty, pool, SCENE, I8_SYS), 8);
    const { delta: decoded, maxHpMax: m } = decodeSimDelta(wire);
    const live = poolFromSnapshot(snapshotFromPool(empty, SCENE, 0, I8_SYS), 8, I8_SYS);
    applySimDelta(live, decoded, m, I8_SYS);
    expect(live.sys["ref"]?.[0]).toBe(-3);
    expect(live.sys["fort"]?.[1]).toBe(-128);
  });
});
