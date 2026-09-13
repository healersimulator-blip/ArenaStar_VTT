import { describe, expect, test } from "vitest";
import { pf1eAidAnother, pf1eFeint } from "../../src/packages/pf1e/aidFeint";

describe("pf1eAidAnother (AoN 186)", () => {
  test("success on total ≥ 10 gives +2, provokes false by default", () => {
    const r = pf1eAidAnother({ die: 8, attackBonus: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("not ok");
    expect(r.success).toBe(true);
    expect(r.total).toBe(13);
    expect(r.bonus).toBe(2);
    expect(r.provokes).toBe(false);
    expect(r.notes.join(" ")).toContain("+2 bonus");
  });

  test("failure on total < 10", () => {
    const r = pf1eAidAnother({ die: 2, attackBonus: 2 });
    if (!r.ok) throw new Error("not ok");
    expect(r.success).toBe(false);
    expect(r.bonus).toBe(0);
  });

  test("natural 20 auto-succeeds even with terrible bonus", () => {
    const r = pf1eAidAnother({ die: 20, attackBonus: -20 });
    if (!r.ok) throw new Error("not ok");
    expect(r.success).toBe(true);
  });

  test("natural 1 auto-fails even with huge bonus", () => {
    const r = pf1eAidAnother({ die: 1, attackBonus: 20 });
    if (!r.ok) throw new Error("not ok");
    expect(r.success).toBe(false);
  });

  test("attack penalty and AoO damage subtract", () => {
    const r = pf1eAidAnother({ die: 15, attackBonus: 5, attackPenalty: 2, aooDamageTaken: 3 });
    if (!r.ok) throw new Error("not ok");
    // 15+5-5=15 => success vs AC 10
    expect(r.total).toBe(15);
    expect(r.success).toBe(true);
    expect(r.notes.join(" ")).toContain("provoked attack of opportunity dealt 3 damage");
  });

  test("aidedActionProvokes makes the attempt provoke (Table 7-2 fn2)", () => {
    const r = pf1eAidAnother({ die: 15, attackBonus: 5, aidedActionProvokes: true });
    if (!r.ok) throw new Error("not ok");
    expect(r.provokes).toBe(true);
    expect(r.notes.join(" ")).toContain("aiding another provokes");
  });

  test("aidChoice attack vs ac is reflected in note", () => {
    const rAtk = pf1eAidAnother({ die: 15, attackBonus: 5, aidChoice: "attack" });
    const rAc = pf1eAidAnother({ die: 15, attackBonus: 5, aidChoice: "ac" });
    if (!rAtk.ok || !rAc.ok) throw new Error("not ok");
    expect(rAtk.aidChoice).toBe("attack");
    expect(rAc.aidChoice).toBe("ac");
    expect(rAc.notes.join(" ")).toContain("bonus to AC");
  });
});

describe("pf1eFeint (AoN 195 / Bluff)", () => {
  test("DC is 10 + BAB + Wis, Sense-Motive-trained alternative wins if higher", () => {
    const base = pf1eFeint({ die: 10, bluffBonus: 5, defenderBab: 6, defenderWisMod: 2 });
    if (!base.ok) throw new Error("not ok");
    expect(base.dc).toBe(18);
    const withSM = pf1eFeint({ die: 10, bluffBonus: 5, defenderBab: 6, defenderWisMod: 2, defenderSenseMotiveBonus: 12, defenderSenseMotiveTrained: true });
    if (!withSM.ok) throw new Error("not ok");
    expect(withSM.dc).toBe(22);
    const withSMLower = pf1eFeint({ die: 10, bluffBonus: 5, defenderBab: 6, defenderWisMod: 2, defenderSenseMotiveBonus: 5, defenderSenseMotiveTrained: true });
    if (!withSMLower.ok) throw new Error("not ok");
    expect(withSMLower.dc).toBe(18);
  });

  test("success grants denied Dex, fail does not", () => {
    const succeed = pf1eFeint({ die: 15, bluffBonus: 10, defenderBab: 2, defenderWisMod: 1 }); // DC 13, total 25
    const fail = pf1eFeint({ die: 2, bluffBonus: 0, defenderBab: 6, defenderWisMod: 2 }); // DC 18, total 2
    if (!succeed.ok || !fail.ok) throw new Error("not ok");
    expect(succeed.success).toBe(true);
    expect(succeed.deniesDex).toBe(true);
    expect(fail.success).toBe(false);
    expect(fail.deniesDex).toBe(false);
  });

  test("nonhumanoid imposes –4", () => {
    const humanoid = pf1eFeint({ die: 10, bluffBonus: 5, defenderBab: 2, defenderWisMod: 1, defenderIsHumanoid: true });
    const nonhumanoid = pf1eFeint({ die: 10, bluffBonus: 5, defenderBab: 2, defenderWisMod: 1, defenderIsHumanoid: false });
    if (!humanoid.ok || !nonhumanoid.ok) throw new Error("not ok");
    expect(nonhumanoid.total).toBe(humanoid.total - 4);
    expect(nonhumanoid.penalty).toBe(4);
  });

  test("animal Intelligence 1–2 imposes –8, overrides –4", () => {
    const non = pf1eFeint({ die: 10, bluffBonus: 5, defenderBab: 2, defenderWisMod: 1, defenderIsHumanoid: false });
    const animal = pf1eFeint({ die: 10, bluffBonus: 5, defenderBab: 2, defenderWisMod: 1, defenderIsHumanoid: false, defenderIntScore: 2 });
    if (!non.ok || !animal.ok) throw new Error("not ok");
    expect(animal.penalty).toBe(8);
    expect(animal.total).toBe(non.total - 4); // 8 vs 4 => extra -4
  });

  test("mindless (Int null/0) is impossible", () => {
    const r1 = pf1eFeint({ die: 10, bluffBonus: 20, defenderBab: 2, defenderWisMod: 1, defenderIntScore: null });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain("lacking an Intelligence score");
    const r2 = pf1eFeint({ die: 10, bluffBonus: 20, defenderBab: 2, defenderWisMod: 1, defenderIntScore: 0 });
    expect(r2.ok).toBe(false);
  });

  test("Improved / Greater Feint notes and action", () => {
    const std = pf1eFeint({ die: 15, bluffBonus: 10, defenderBab: 2, defenderWisMod: 1 });
    const imp = pf1eFeint({ die: 15, bluffBonus: 10, defenderBab: 2, defenderWisMod: 1, hasImprovedFeint: true });
    const greater = pf1eFeint({ die: 15, bluffBonus: 10, defenderBab: 2, defenderWisMod: 1, hasGreaterFeint: true });
    if (!std.ok || !imp.ok || !greater.ok) throw new Error("not ok");
    expect(std.action).toBe("standard");
    expect(imp.action).toBe("move");
    expect(greater.greaterExtendsToNextTurn).toBe(true);
    expect(std.greaterExtendsToNextTurn).toBe(false);
    expect(greater.notes.join(" ")).toContain("Greater Feint");
  });

  test("feint never provokes", () => {
    const r = pf1eFeint({ die: 10, bluffBonus: 5, defenderBab: 2, defenderWisMod: 1 });
    if (!r.ok) throw new Error("not ok");
    expect(r.provokes).toBe(false);
  });
});
