import { describe, expect, test } from "vitest";
import {
  absorbDamageWithTempHp,
  expireTempHpSource,
  grantTempHp,
  healingDoesNotRestoreTempHp,
  readTempHpSources,
} from "../../src/packages/pf1e/tempHp";
import { readPF1eHealth } from "../../src/packages/pf1e/healthState";
import { derivePF1eActor } from "../../src/packages/pf1e/actor";
import { pf1eResolveAttack } from "../../src/packages/pf1e/resolve";

describe("P7/H02 temp HP — stacking, absorption, expiry", () => {
  test("readTempHpSources: legacy scalar maps to legacy source", () => {
    const r = readTempHpSources({ tempHp: 8 } as Record<string, unknown>);
    expect(r.total).toBe(8);
    expect(r.sources).toEqual({ legacy: 8 });
    expect(r.issues).toEqual([]);
  });
  test("readTempHpSources: map stacks, scalar ignored with issue", () => {
    const r = readTempHpSources({ tempHp: 5, tempHpSources: { aid: 8, falseLife: 6 } } as Record<string, unknown>);
    expect(r.total).toBe(14);
    expect(r.sources).toEqual({ aid: 8, falseLife: 6 });
    expect(r.issues.join()).toMatch(/ignored/);
  });
  test("readTempHpSources: empty id and malformed values reported", () => {
    const r = readTempHpSources({ tempHpSources: { "": 5, ok: -1, bad: "x" } } as Record<string, unknown>);
    expect(r.total).toBe(0);
    expect(r.sources).toEqual({ ok: 0, bad: 0 });
    expect(r.issues.length).toBe(3);
  });
  test("readPF1eHealth derives tempHpSources total", () => {
    const raw = { hp: 10, hpMax: 20, tempHpSources: { aid: 8 }, abilities: { con: 14 } };
    const h = readPF1eHealth(raw);
    expect(h.tempHp).toBe(8);
    expect(h.tempHpSources).toEqual({ aid: 8 });
    const d = derivePF1eActor({ system: raw });
    expect(d.tempHp).toBe(8);
    expect(d.tempHpSources).toEqual({ aid: 8 });
  });
  test("grantTempHp: same source keeps highest, different stacks", () => {
    let s: Record<string, number> = {};
    let r = grantTempHp(s, "aid", 8);
    expect(r.total).toBe(8);
    s = r.sources as unknown as Record<string, number>;
    r = grantTempHp(s, "aid", 5);
    expect(r.total).toBe(8); // not stacked
    expect(r.note).toMatch(/do not stack/i);
    s = r.sources as unknown as Record<string, number>;
    r = grantTempHp(s, "aid", 12);
    expect(r.total).toBe(12);
    expect(r.sources.aid).toBe(12);
    s = r.sources as unknown as Record<string, number>;
    r = grantTempHp(s, "falseLife", 6);
    expect(r.total).toBe(18);
    expect(r.sources).toEqual({ aid: 12, falseLife: 6 });
  });
  test("grantTempHp: malformed inputs ignored", () => {
    const s = { a: 5 } as const;
    expect(grantTempHp(s, "", 5).issues.length).toBe(1);
    expect(grantTempHp(s, "a", -1).issues.length).toBe(1);
    expect(grantTempHp(s, "a", 2.5).issues.length).toBe(1);
  });
  test("absorbDamageWithTempHp: largest-first then alphabetical deterministic", () => {
    const sources = { b: 6, a: 8, c: 6 };
    const r = absorbDamageWithTempHp(sources, 10);
    // 8 from a +2 from b (b before c alphabetically)
    expect(r.absorbed).toBe(10);
    expect(r.leftover).toBe(0);
    expect(r.sources).toEqual({ b: 4, c: 6 });
  });
  test("absorbDamageWithTempHp: partial drain removes zeroed sources", () => {
    const r = absorbDamageWithTempHp({ aid: 5 }, 10);
    expect(r.absorbed).toBe(5);
    expect(r.leftover).toBe(5);
    expect(r.sources).toEqual({});
  });
  test("absorbDamageWithTempHp: zero damage no notes", () => {
    const r = absorbDamageWithTempHp({ aid: 5 }, 0);
    expect(r.absorbed).toBe(0);
    expect(r.notes).toEqual([]);
  });
  test("expireTempHpSource removes source", () => {
    const r = expireTempHpSource({ aid: 5, other: 3 }, "aid");
    expect(r.sources).toEqual({ other: 3 });
    expect(r.total).toBe(3);
    expect(r.note).toMatch(/expired/);
    const r2 = expireTempHpSource({ other: 3 }, "missing");
    expect(r2.note).toBeNull();
  });
  test("healingDoesNotRestoreTempHp never restores", () => {
    const s = { aid: 5 };
    const r = healingDoesNotRestoreTempHp(s);
    expect(r.sources).toEqual(s);
    expect(r.note).toMatch(/not restored/);
    expect(healingDoesNotRestoreTempHp({}).note).toBeNull();
  });
  test("resolve: temp HP absorbs before real HP, largest-first", () => {
    const defender = {
      name: "Target",
      ac: { normal: 10, touch: 10, flatFooted: 10 },
      hp: 12,
      hpMax: 20,
      nonlethalDamage: 0,
      tempHp: 14,
      tempHpSources: { aid: 8, falseLife: 6 },
    };
    // Defender AC 10, attack bonus 0, die 15 => hits, damage 10 lethal
    const res = pf1eResolveAttack({
      attack: { label: "Sword", bonus: 0, critThreatMin: 20, critMultiplier: 2 },
      die: 15,
      defense: "normal",
      defender: defender as unknown as Parameters<typeof pf1eResolveAttack>[0]["defender"],
      damageTotal: 10,
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.damage?.tempHpAbsorbed).toBe(10);
    expect(res.tempHp.before).toBe(14);
    expect(res.tempHp.after).toBe(4);
    expect(res.hp.before).toBe(12);
    expect(res.hp.after).toBe(12); // damage fully absorbed, no HP loss
    expect(res.tempHp.afterSources).toEqual({ falseLife: 4 }); // 8 from aid gone, 2 from falseLife
    // Check note exists
    expect(res.notes.join(" ")).toMatch(/temporary hit points absorbed/i);
  });
  test("resolve: temp HP absorption on miss/misfire preserves pool", () => {
    const defender = {
      name: "Target",
      ac: { normal: 30, touch: 30, flatFooted: 30 },
      hp: 12,
      hpMax: 20,
      nonlethalDamage: 0,
      tempHp: 5,
      tempHpSources: { aid: 5 },
    };
    const miss = pf1eResolveAttack({
      attack: { label: "Sword", bonus: 0, critThreatMin: 20, critMultiplier: 2 },
      die: 2,
      defense: "normal",
      defender: defender as unknown as Parameters<typeof pf1eResolveAttack>[0]["defender"],
      damageTotal: 10,
    });
    if (!miss.ok) throw new Error(miss.error);
    expect(miss.outcome).toBe("miss");
    expect(miss.tempHp.before).toBe(5);
    expect(miss.tempHp.after).toBe(5);
    expect(miss.hp.after).toBe(12);
  });
  test("resolve: legacy scalar tempHp still absorbs", () => {
    const defender = {
      name: "Target",
      ac: { normal: 10, touch: 10, flatFooted: 10 },
      hp: 10,
      hpMax: 20,
      nonlethalDamage: 0,
      tempHp: 6,
    };
    const res = pf1eResolveAttack({
      attack: { label: "Sword", bonus: 5, critThreatMin: 20, critMultiplier: 2 },
      die: 12,
      defense: "normal",
      defender: defender as unknown as Parameters<typeof pf1eResolveAttack>[0]["defender"],
      damageTotal: 8,
    });
    if (!res.ok) throw new Error(res.error);
    expect(res.tempHp.before).toBe(6);
    expect(res.tempHp.after).toBe(0);
    expect(res.hp.after).toBe(8); // 8 damage −6 temp =2 → 10−2=8
    expect(res.damage?.tempHpAbsorbed).toBe(6);
  });
});
