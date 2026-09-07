import { describe, expect, test } from "vitest";
import { PF1E_MODEL_SCHEMA, PF1eDrType, PF1eProfileRegistry } from "../../src/packages/pf1e/schema";
import { createModelPool, allocModel } from "../../src/sim/pool";

describe("PF1e Schema & Profile Compaction (§12 / Task 2)", () => {
  test("creates ModelPool with PF1e sys columns", () => {
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 0,
      y: 0,
      sys: { ac: 16, touchAc: 12, fort: 4, ref: 2, will: 1, sr: 0, drType: 1, drVal: 5, profileIdx: 1 },
    });

    expect(pool.sys["ac"]?.[0]).toBe(16);
    expect(pool.sys["touchAc"]?.[0]).toBe(12);
    expect(pool.sys["drVal"]?.[0]).toBe(5);
    expect(pool.sys["profileIdx"]?.[0]).toBe(1);
  });

  test("compiles raw unit sheet data into PF1eUnitProfile", () => {
    const registry = new PF1eProfileRegistry();
    const profile = registry.register({
      name: "Elven Fighter",
      bab: 11,
      strMod: 3,
      dexMod: 2,
      ac: 18,
      touchAc: 12,
      fort: 5,
      ref: 4,
      will: 2,
      weapon: { damageDiceCount: 1, damageDiceSides: 8, critThreatMin: 19, critMultiplier: 2, damageMod: 3 },
      dr: { typeFlags: PF1eDrType.SLASHING, val: 5 },
      sr: 0,
    });

    expect(profile.id).toBe(1);
    expect(profile.iteratives).toEqual([14, 9, 4]); // BAB 11 (+11/+6/+1) + strMod 3
    expect(profile.ac).toBe(18);
    expect(profile.critThreatMin).toBe(19);
  });
});
