/**
 * P04 — the positional defenses threaded through the attack resolver
 * (`resolve.ts`): cover raises the effective AC (and total cover refuses the
 * attack), concealment turns a hit into a miss on a failed d%, and A.14's
 * defender-facing situational parts flip with the attack's rangedness.
 * Fixtures derived from AoN 181/182 and Appendix A.14.
 */
import { describe, expect, test } from "vitest";
import {
  COVER_AC_BONUS,
  pf1eResolveAttack,
  pf1eResolveManyshot,
  pf1eResolvePrepare,
} from "../../src/packages/pf1e/resolve";
import { situationalAttackParts } from "../../src/packages/pf1e/tactical";

const defender = {
  name: "Goblin",
  ac: { normal: 16, touch: 13, flatFooted: 14 },
  hp: 10,
  hpMax: 10,
  nonlethalDamage: 0,
  conScore: 10,
};
const meleeAttack = {
  label: "Longsword",
  bonus: 5,
  critThreatMin: 20,
  critMultiplier: 2,
  damageType: "slashing",
};
const rangedAttack = { ...meleeAttack, label: "Longbow", ranged: true };

describe("cover in the resolver (AoN 181)", () => {
  test("the cover grades are the printed +2/+4/+4/+8", () => {
    expect(COVER_AC_BONUS).toEqual({
      partial: 2,
      soft: 4,
      standard: 4,
      improved: 8,
      // Unreachable in the AC fold (total refuses the attack), listed for totality.
      total: 0,
    });
  });

  test("standard cover raises the effective AC by 4", () => {
    const p = pf1eResolvePrepare({
      attack: meleeAttack,
      die: 15,
      defense: "normal",
      defender,
      positional: { cover: "standard" },
    });
    if (!p.ok) throw new Error(p.error);
    expect(p.defenseAc).toBe(20);
    expect(p.coverBonus).toBe(4);
    expect(p.notes.join(" ")).toContain("standard cover");
  });

  test("improved cover raises the effective AC by 8", () => {
    const p = pf1eResolvePrepare({
      attack: meleeAttack,
      die: 15,
      defense: "normal",
      defender,
      positional: { cover: "improved" },
    });
    if (!p.ok) throw new Error(p.error);
    expect(p.defenseAc).toBe(24);
  });

  test("a hit against AC 16 + cover 4 misses when the roll beats only the base AC", () => {
    // die 14 + bonus 5 = 19: hits AC 16, misses AC 20.
    const r = pf1eResolveAttack({
      attack: meleeAttack,
      die: 14,
      defense: "normal",
      defender,
      damageTotal: 6,
      positional: { cover: "standard" },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.outcome).toBe("miss");
    expect(r.hp.after).toBe(10);
  });

  test("total cover refuses the attack outright", () => {
    const r = pf1eResolveAttack({
      attack: meleeAttack,
      die: 20,
      defense: "normal",
      defender,
      damageTotal: 99,
      positional: { cover: "total" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("total cover");
  });
});

describe("concealment in the resolver (AoN 182)", () => {
  test("prepare reports the miss chance the flow must roll", () => {
    const p = pf1eResolvePrepare({
      attack: meleeAttack,
      die: 15,
      defense: "normal",
      defender,
      positional: { concealment: { percent: 20, label: "undergrowth" } },
    });
    if (!p.ok) throw new Error(p.error);
    expect(p.needsConcealmentRoll).toEqual({
      percent: 20,
      label: "undergrowth",
    });
  });

  test("a d% at or below the miss chance turns the hit into a miss", () => {
    const r = pf1eResolveAttack({
      attack: meleeAttack,
      die: 15,
      defense: "normal",
      defender,
      damageTotal: 8,
      positional: { concealment: { percent: 20 } },
      concealmentDie: 20,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.outcome).toBe("miss");
    expect(r.hp.after).toBe(10);
    expect(r.notes.join(" ")).toContain("concealment miss");
  });

  test("a d% above the miss chance lets the hit land — even a confirmed critical", () => {
    const r = pf1eResolveAttack({
      attack: meleeAttack,
      die: 20,
      defense: "normal",
      defender,
      damageTotal: 8,
      confirmDie: 15,
      positional: { concealment: { percent: 50, label: "invisible" } },
      concealmentDie: 51,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.outcome).toBe("crit");
    expect(r.notes.join(" ")).toContain("beats the 50% miss chance");
  });

  test("a live miss chance without its d% face is a named refusal", () => {
    const r = pf1eResolveAttack({
      attack: meleeAttack,
      die: 15,
      defense: "normal",
      defender,
      damageTotal: 6,
      positional: { concealment: { percent: 20 } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("concealmentDie");
  });

  test("no concealment means no roll and no refusal", () => {
    const r = pf1eResolveAttack({
      attack: meleeAttack,
      die: 15,
      defense: "normal",
      defender,
      damageTotal: 6,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.outcome).toBe("hit");
  });
});

describe("A.14's defender-facing situational parts", () => {
  test("Manyshot folds the same positional defenses into every arrow", () => {
    // Two arrows at +5 vs AC 16 + 4 standard cover = 20: the first (11+5=16)
    // misses the covered AC; the second (15+5=20) hits exactly. Concealment
    // 20% then turns the second arrow's hit into a miss on d% 15 — the volley
    // lands nothing and the goblin keeps every hit point (AoN 181/182).
    const volley = pf1eResolveManyshot({
      attack: { ...rangedAttack, label: "Manyshot" },
      arrows: [
        { die: 11, damageTotal: 7 },
        { die: 15, concealmentDie: 15, damageTotal: 7 },
      ],
      defense: "normal",
      defender,
      positional: { cover: "standard", concealment: { percent: 20 } },
    });
    if (!volley.ok) throw new Error(volley.error);
    expect(volley.arrows[0]?.outcome).toBe("miss");
    expect(volley.arrows[1]?.outcome).toBe("miss");
    expect(volley.finalHp).toBe(10);
    // A d% above the chance lets the covered hit stand: 15+5=20 vs 20.
    const stands = pf1eResolveManyshot({
      attack: { ...rangedAttack, label: "Manyshot" },
      arrows: [
        { die: 11, damageTotal: 7 },
        { die: 15, concealmentDie: 21, damageTotal: 7 },
      ],
      defense: "normal",
      defender,
      positional: { cover: "standard", concealment: { percent: 20 } },
    });
    if (!stands.ok) throw new Error(stands.error);
    expect(stands.arrows[1]?.outcome).toBe("hit");
    expect(stands.finalHp).toBe(3);
  });

  test("higher ground is +1 melee and nothing at range", () => {
    expect(
      situationalAttackParts({ higherGround: true }, false).find((p) => p.label === "higher ground"),
    ).toEqual({ label: "higher ground", value: 1 });
    expect(
      situationalAttackParts({ higherGround: true }, true).find((p) => p.label === "higher ground"),
    ).toBeUndefined();
  });

  test("a prone defender is +4 melee and −4 ranged", () => {
    expect(
      situationalAttackParts({ defenderProne: true }, false),
    ).toEqual([{ label: "prone target", value: 4 }]);
    expect(
      situationalAttackParts({ defenderProne: true }, true),
    ).toEqual([{ label: "prone target (ranged)", value: -4 }]);
  });

  test("a helpless defender is +4 melee and nothing at range", () => {
    expect(
      situationalAttackParts({ defenderHelpless: true }, false),
    ).toEqual([{ label: "helpless target", value: 4 }]);
    expect(
      situationalAttackParts({ defenderHelpless: true }, true),
    ).toEqual([]);
  });

  test("the resolver folds the prone modifier into the effective bonus", () => {
    const melee = pf1eResolvePrepare({
      attack: meleeAttack,
      die: 10,
      defense: "normal",
      defender,
      situational: { defenderProne: true },
    });
    if (!melee.ok) throw new Error(melee.error);
    expect(melee.attackBonus).toBe(9);
    const ranged = pf1eResolvePrepare({
      attack: rangedAttack,
      die: 10,
      defense: "normal",
      defender,
      situational: { defenderProne: true },
    });
    if (!ranged.ok) throw new Error(ranged.error);
    expect(ranged.attackBonus).toBe(1);
  });

  test("the older situational parts are unchanged", () => {
    expect(situationalAttackParts({ flanking: true })).toEqual([
      { label: "flanking", value: 2 },
    ]);
    expect(situationalAttackParts({ squeezing: true })).toEqual([
      { label: "squeezing", value: -4 },
    ]);
  });
});
