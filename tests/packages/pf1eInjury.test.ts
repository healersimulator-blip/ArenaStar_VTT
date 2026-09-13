/**
 * P7/H01/D-203 — injury and death (`injury.ts`), derived from Gap List A.13's
 * transcribed text: the lethal ladder, the disabled action economy, the
 * stabilization and wake checks, first aid, and the coup de grâce save.
 */
import { describe, expect, test } from "vitest";
import {
  coupDeGraceVerdict,
  disabledAfterAction,
  healFirstAid,
  injuryStateOf,
  nonlethalStateOf,
  stabilizationCheck,
} from "../../src/packages/pf1e/injury";

describe("H01 — the lethal ladder (A.13)", () => {
  test("healthy, disabled at exactly 0, dying below 0, dead at negative Con", () => {
    expect(injuryStateOf({ hp: 12, conScore: 14 })).toEqual({
      state: "healthy",
      note: null,
    });
    expect(injuryStateOf({ hp: 0, conScore: 14 }).state).toBe("disabled");
    expect(
      injuryStateOf({ hp: -13, conScore: 14 }).state,
    ).toBe("dying");
    expect(injuryStateOf({ hp: -14, conScore: 14 }).state).toBe("dead");
    expect(injuryStateOf({ hp: -15, conScore: 14 }).state).toBe("dead");
    expect(injuryStateOf({ hp: -1, conScore: 0 }).state).toBe("dying");
  });

  test("the card annotations name the rule (the strings resolve.ts prints)", () => {
    expect(injuryStateOf({ hp: -14, conScore: 14 }).note).toBe(
      "dead — negative HP (-14) reached Constitution 14 (CRB p.190)",
    );
    expect(injuryStateOf({ hp: -3, conScore: 14 }).note).toContain(
      "unconscious and dying",
    );
    expect(injuryStateOf({ hp: 0, conScore: 14 }).note).toContain("disabled");
  });

  test("the nonlethal thresholds: exactly equal staggers, exceeding knocks out", () => {
    expect(nonlethalStateOf({ hp: 5, nonlethalDamage: 4 })).toBe("clear");
    expect(nonlethalStateOf({ hp: 5, nonlethalDamage: 5 })).toBe("staggered");
    expect(nonlethalStateOf({ hp: 5, nonlethalDamage: 6 })).toBe("unconscious");
    // The lethal state dominates.
    expect(nonlethalStateOf({ hp: 0, nonlethalDamage: 0 })).toBe("clear");
    expect(nonlethalStateOf({ hp: -2, nonlethalDamage: 9 })).toBe("clear");
  });
});

describe("H01 — the disabled action economy (A.13)", () => {
  test("one move or standard, never both, never full-round; the standard costs 1 HP after the act", () => {
    expect(disabledAfterAction({ hp: 0, action: "move" })).toEqual({
      allowed: true,
      hpAfter: 0,
      note: null,
    });
    const strenuous = disabledAfterAction({ hp: 0, action: "standard" });
    expect(strenuous).toEqual({
      allowed: true,
      hpAfter: -1,
      note: "the strenuous standard action completes, then costs 1 HP — at −1 and dying, no check (A.13)",
    });
    expect(
      disabledAfterAction({ hp: 0, action: "full-round" }).allowed,
    ).toBe(false);
    expect(
      disabledAfterAction({ hp: 0, action: "move", actedAlready: true })
        .allowed,
    ).toBe(false);
    expect(
      disabledAfterAction({ hp: 0, action: "move", actedAlready: true }).note,
    ).toContain("never both");
    // Swift and free actions are never the "single action".
    expect(disabledAfterAction({ hp: 0, action: "swift" })).toEqual({
      allowed: true,
      hpAfter: 0,
      note: null,
    });
  });
});

describe("H01 — the Constitution checks (A.13)", () => {
  test("DC 10 with a penalty equal to negative HP; nat 20 automatic; a failure costs 1 HP", () => {
    // At −5 HP the penalty is 5: die 14 + Con 1 − 5 = 10 — exactly stabilizes.
    const made = stabilizationCheck({ die: 14, conMod: 1, hp: -5 });
    expect(made).toMatchObject({ success: true, hpAfter: -5 });
    expect(made.note).toContain("stabilizes");

    const failed = stabilizationCheck({ die: 13, conMod: 1, hp: -5 });
    expect(failed).toMatchObject({ success: false, hpAfter: -6 });
    expect(failed.note).toContain("penalty 5");

    // Nat 20 at any penalty.
    expect(
      stabilizationCheck({ die: 20, conMod: -5, hp: -19 }).success,
    ).toBe(true);
    // A die that is not a face refuses by name.
    expect(stabilizationCheck({ die: 0, conMod: 1, hp: -5 }).note).toContain(
      "must be a natural d20 face",
    );
  });

  test("the stable character's hourly wake check is the same roll, named differently", () => {
    const wake = stabilizationCheck({
      die: 14,
      conMod: 1,
      hp: -5,
      purpose: "wake",
    });
    expect(wake.success).toBe(true);
    expect(wake.note).toContain("wakes disabled");
  });

  test("first aid: DC 15 Heal stabilizes the dying", () => {
    expect(healFirstAid({ die: 12, healMod: 3 })).toMatchObject({
      stabilized: true,
    });
    expect(healFirstAid({ die: 11, healMod: 3 })).toMatchObject({
      stabilized: false,
    });
    expect(healFirstAid({ die: 12, healMod: 3 }).note).toContain(
      "first aid stabilizes",
    );
  });
});

describe("H01 — the coup de grâce (A.13, AoN ID 413)", () => {
  test("a mandatory Fort save at DC 10 + damage, or death", () => {
    const saved = coupDeGraceVerdict({
      damageDealt: 20,
      killedByDamage: false,
      saveDie: 12,
      fortBonus: 8, // 20 ≥ 30? no: DC 30, total 20 — fails
    });
    expect(saved).toMatchObject({ ok: true, dead: true, saved: false });
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.save).toEqual({ dc: 30, passed: false });
    expect(saved.notes.join(" ")).toContain("DC 30 (10 + 20 damage)");
    expect(saved.notes.join(" ")).toContain("dies");

    // Even a natural 20 + 8 = 28 misses DC 30 — the save is genuinely mandatory.
    const evenNat20 = coupDeGraceVerdict({
      damageDealt: 20,
      killedByDamage: false,
      saveDie: 20,
      fortBonus: 8,
    });
    expect(evenNat20.ok && evenNat20.dead).toBe(true);

    const made = coupDeGraceVerdict({
      damageDealt: 12,
      killedByDamage: false,
      saveDie: 15,
      fortBonus: 7, // 22 ≥ 22
    });
    expect(made).toMatchObject({ ok: true, dead: false, saved: true });
  });

  test("the damage alone killing makes the save moot; a missing save face refuses by name", () => {
    const killed = coupDeGraceVerdict({
      damageDealt: 30,
      killedByDamage: true,
      saveDie: 20,
      fortBonus: 9,
    });
    expect(killed).toMatchObject({ ok: true, dead: true });
    if (!killed.ok) throw new Error(killed.error);
    expect(killed.notes.join(" ")).toContain("the save is moot");

    const missing = coupDeGraceVerdict({
      damageDealt: 10,
      killedByDamage: false,
      fortBonus: 0,
    });
    expect(missing).toMatchObject({ ok: false });
  });

  test("crit immunity waives the critical damage and the save", () => {
    const immune = coupDeGraceVerdict({
      damageDealt: 30,
      killedByDamage: false,
      fortBonus: 0,
      critImmune: true,
    });
    expect(immune).toMatchObject({ ok: true, dead: false, save: null });
    if (!immune.ok) throw new Error(immune.error);
    expect(immune.notes.join(" ")).toContain("no save is required");
  });
});
