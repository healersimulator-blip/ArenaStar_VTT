import { describe, expect, test } from "vitest";
import { applyHealing, applyNonlethalHealing, fastHealingTick, regenerationTick } from "../../src/packages/pf1e/healing";

describe("P7/H02 healing — CRB p.191 equal nonlethal removal, never temp HP", () => {
  test("applyHealing at full HP still removes nonlethal by rolled amount", () => {
    const r = applyHealing({ hp: 20, hpMax: 20, nonlethalDamage: 8, amount: 6 });
    if ((r as { ok: false }).ok === false) throw new Error("heal failed");
    const res = r as { hp: number; nonlethalDamage: number; healedHp: number; healedNonlethal: number };
    expect(res.hp).toBe(20);
    expect(res.nonlethalDamage).toBe(2);
    expect(res.healedHp).toBe(0);
    expect(res.healedNonlethal).toBe(6);
  });
  test("applyHealing heals HP up to max and removes equal nonlethal", () => {
    const r = applyHealing({ hp: 10, hpMax: 20, nonlethalDamage: 5, amount: 8 });
    if ((r as { ok: false }).ok === false) throw new Error("heal failed");
    const res = r as { hp: number; nonlethalDamage: number; healedHp: number; healedNonlethal: number };
    expect(res.hp).toBe(18);
    expect(res.nonlethalDamage).toBe(0);
    expect(res.healedHp).toBe(8);
    expect(res.healedNonlethal).toBe(5);
  });
  test("applyHealing capped at hpMax, excess still cures nonlethal", () => {
    // 5 HP deficit, 10 nonlethal, heal 8 => 5 HP + 8 nonlethal removal
    const r = applyHealing({ hp: 15, hpMax: 20, nonlethalDamage: 10, amount: 8 });
    if ((r as { ok: false }).ok === false) throw new Error("heal failed");
    const res = r as { hp: number; nonlethalDamage: number };
    expect(res.hp).toBe(20);
    expect(res.nonlethalDamage).toBe(2);
  });
  test("applyHealing zero amount no effect", () => {
    const r = applyHealing({ hp: 10, hpMax: 20, nonlethalDamage: 5, amount: 0 });
    if ((r as { ok: false }).ok === false) throw new Error("heal failed");
    expect((r as { healedHp: number }).healedHp).toBe(0);
  });
  test("applyNonlethalHealing removes only nonlethal", () => {
    const r = applyNonlethalHealing({ nonlethalDamage: 7, amount: 3 });
    if ((r as { ok: false }).ok === false) throw new Error("heal failed");
    expect((r as { nonlethalDamage: number }).nonlethalDamage).toBe(4);
  });
  test("fastHealingTick: dead creature does not heal", () => {
    // hp -12, Con 14 => dead at -14? Actually -12 <14 so not dead, use -15 dead
    const r = fastHealingTick({ hp: -15, hpMax: 20, nonlethalDamage: 5, amount: 5, conScore: 14 });
    if ((r as { ok: false }).ok === false) throw new Error("tick failed");
    expect((r as { healed: number }).healed).toBe(0);
    expect((r as { hp: number }).hp).toBe(-15);
  });
  test("fastHealingTick: living at -5 with Con 14 heals", () => {
    const r = fastHealingTick({ hp: -5, hpMax: 20, nonlethalDamage: 4, amount: 5, conScore: 14 });
    if ((r as { ok: false }).ok === false) throw new Error("tick failed");
    const res = r as { hp: number; nonlethalDamage: number; healed: number };
    expect(res.hp).toBe(0);
    expect(res.nonlethalDamage).toBe(0); // 4 removed (rolled 5, but only 4 present) -> 0
    expect(res.healed).toBe(5);
  });
  test("regenerationTick suppressed skips healing", () => {
    const r = regenerationTick({ hp: 5, hpMax: 20, nonlethalDamage: 5, amount: 10, suppressed: true, conScore: 14 });
    if ((r as { ok: false }).ok === false) throw new Error("tick failed");
    expect((r as { healed: number }).healed).toBe(0);
    expect((r as { note: string | null }).note).toMatch(/suppressed/i);
  });
  test("regenerationTick unsuppressed heals like healing", () => {
    const r = regenerationTick({ hp: 10, hpMax: 20, nonlethalDamage: 6, amount: 6, suppressed: false, conScore: 14 });
    if ((r as { ok: false }).ok === false) throw new Error("tick failed");
    const res = r as { hp: number; nonlethalDamage: number };
    expect(res.hp).toBe(16);
    expect(res.nonlethalDamage).toBe(0);
  });
  test("regenerationTick dead does not heal", () => {
    const r = regenerationTick({ hp: -20, hpMax: 20, nonlethalDamage: 0, amount: 10, conScore: 14 });
    if ((r as { ok: false }).ok === false) throw new Error("tick failed");
    expect((r as { healed: number }).healed).toBe(0);
  });
});

describe("combatEngine resolvePF1eHealing fastHealing integration", () => {
  test("engine tick uses healing.ts and removes nonlethal", async () => {
    const { resolvePF1eHealing } = await import("../../src/packages/pf1e/combatEngine");
    const pool: import("../../src/core/strategic").ModelPool = {
      status: [0],
      hp: [10],
      hpMax: [20],
      sys: {
        profileIdx: [1],
        nonlethal: [8],
        lethalDmg: [0],
        con: [14],
      },
      x: [0],
      y: [0],
    } as unknown as import("../../src/core/strategic").ModelPool;
    const registry = new Map([
      [1, { fastHealingVal: 5, regenerationVal: 0 } as unknown as import("../../src/packages/pf1e/schema").PF1eUnitProfile],
    ]) as unknown as import("../../src/packages/pf1e/schema").PF1eProfileRegistry;
    const res = resolvePF1eHealing(pool, [0], registry);
    expect(res.totalHealed).toBe(5);
    expect(pool.hp[0]).toBe(15);
    expect((pool.sys.nonlethal as unknown as number[])[0]).toBe(3); // 8-5
  });
});
