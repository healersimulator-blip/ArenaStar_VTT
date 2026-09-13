/**
 * P05/D-199 — the combat manœuvre check (`maneuvers.ts`), derived from Gap
 * List A.9's transcription: the shared CMB-vs-CMD roll with its states
 * (immobilised/unconscious auto-success, stunned +4), the natural faces
 * (nat 20 auto-success except escaping bonds, nat 1 auto-fail), the attack
 * penalties and the penalized-AoO rule, concealment (manœuvres are attack
 * rolls), A.9's size limit, and the sunder consumer composed over
 * `items.ts`'s hardness/HP arithmetic.
 */
import { describe, expect, test } from "vitest";
import {
  PF1E_MANEUVER_KINDS,
  PF1E_SIZE_LIMITED_KINDS,
  pf1eManeuverCheck,
  pf1eSunder,
  type PF1eManeuverCheckInput,
} from "../../src/packages/pf1e/maneuvers";
import { cmbFrom, cmdFrom } from "../../src/packages/pf1e/rulesTables";

const base = (
  overrides: Partial<PF1eManeuverCheckInput> = {},
): PF1eManeuverCheckInput => ({
  kind: "trip",
  die: 15,
  cmb: 5,
  cmd: 18,
  attacker: { size: "Medium" },
  defender: { size: "Medium" },
  ...overrides,
});

describe("P05 — the manœuvre tables", () => {
  test("the ten kinds and A.9's size-limited six", () => {
    expect([...PF1E_MANEUVER_KINDS]).toEqual([
      "bull-rush",
      "trip",
      "disarm",
      "sunder",
      "grapple",
      "overrun",
      "dirty-trick",
      "drag",
      "reposition",
      "steal",
    ]);
    expect([...PF1E_SIZE_LIMITED_KINDS]).toEqual([
      "bull-rush",
      "trip",
      "drag",
      "reposition",
      "overrun",
      "grapple",
    ]);
  });
});

describe("P05 — the CMB-vs-CMD check (A.9)", () => {
  test("the plain roll: total vs CMD, with the margin the aftermaths read", () => {
    const hit = pf1eManeuverCheck(base());
    expect(hit).toMatchObject({ ok: true, success: true, total: 20, margin: 2 });
    const miss = pf1eManeuverCheck(base({ die: 10 }));
    expect(miss).toMatchObject({ ok: true, success: false, total: 15, margin: -3 });
  });

  test("the numbers are the derivation's: Tiny's Dex CMB and CMD's transferables", () => {
    // A Tiny striker substitutes Dex into CMB (A.9), and CMD carries the
    // transferable AC bonuses the appendix lists.
    const cmb = cmbFrom({
      bab: 3,
      strMod: -1,
      dexMod: 4,
      size: "Tiny",
    });
    expect(cmb).toBe(3 + 4 - 2); // Dex, not Str; Tiny's special size −2
    const cmd = cmdFrom({
      bab: 3,
      strMod: 2,
      dexMod: 3,
      size: "Medium",
      acTransfer: 2, // e.g. deflection + luck
    });
    expect(cmd.normal).toBe(10 + 3 + 2 + 3 + 2);
    expect(cmd.flatFooted).toBe(10 + 3 + 2 + 2); // flat-footed loses Dex (A.9)
  });

  test("A.9's size limit: no more than one category larger, waivable by the caller", () => {
    const tooBig = pf1eManeuverCheck(
      base({ attacker: { size: "Medium" }, defender: { size: "Huge" } }),
    );
    expect(tooBig).toMatchObject({
      ok: false,
      error:
        "a trip needs a target no more than one size category larger — Huge is 2 categories above Medium (A.9)",
    });
    // One category larger is legal; the caller's feat waiver lifts the rest.
    const oneUp = pf1eManeuverCheck(
      base({ attacker: { size: "Medium" }, defender: { size: "Large" } }),
    );
    expect(oneUp.ok).toBe(true);
    const waived = pf1eManeuverCheck(
      base({
        attacker: { size: "Medium" },
        defender: { size: "Huge" },
        sizeLimitWaived: true,
      }),
    );
    expect(waived.ok).toBe(true);
    // Disarm carries no size limit (A.9's list).
    const disarm = pf1eManeuverCheck(
      base({
        kind: "disarm",
        attacker: { size: "Tiny" },
        defender: { size: "Colossal" },
      }),
    );
    expect(disarm.ok).toBe(true);
  });

  test("immobilised or unconscious auto-succeeds; stunned grants +4", () => {
    const helpless = pf1eManeuverCheck(
      base({ defender: { size: "Medium", immobilizedOrUnconscious: true } }),
    );
    expect(helpless).toMatchObject({ ok: true, success: true });
    expect(helpless.ok && helpless.notes[0]).toContain("auto-succeeds");

    // 12 + 5 + 4 = 21 vs CMD 20: only the stunned bonus carries it.
    const stunned = pf1eManeuverCheck(
      base({ die: 12, cmd: 20, defender: { size: "Medium", stunned: true } }),
    );
    expect(stunned).toMatchObject({ ok: true, success: true, total: 21 });
    const notStunned = pf1eManeuverCheck(base({ die: 12, cmd: 20 }));
    expect(notStunned).toMatchObject({ ok: true, success: false, total: 17 });
  });

  test("the natural faces: 20 auto-succeeds, 1 auto-fails, escaping bonds excepts", () => {
    const twenty = pf1eManeuverCheck(base({ die: 20, cmb: 0, cmd: 30 }));
    expect(twenty).toMatchObject({ ok: true, success: true });
    expect(twenty.ok && twenty.notes.join(" ")).toContain("natural 20");

    const one = pf1eManeuverCheck(base({ die: 1, cmb: 20, cmd: 5 }));
    expect(one).toMatchObject({ ok: true, success: false });
    expect(one.ok && one.notes.join(" ")).toContain("natural 1");

    const bonds = pf1eManeuverCheck(
      base({ die: 20, cmb: 0, cmd: 30, escapingBonds: true }),
    );
    expect(bonds).toMatchObject({ ok: true, success: false });
    expect(bonds.ok && bonds.notes.join(" ")).toContain(
      "the natural 20 is not an automatic success",
    );
  });

  test("attack penalties and the penalized-AoO rule (A.9)", () => {
    // 15 + 5 = 20 vs 18 succeeds — but the provoked AoO dealt 6 damage.
    const penalized = pf1eManeuverCheck(base({ aooDamageTaken: 6 }));
    expect(penalized).toMatchObject({ ok: true, success: false, total: 14 });
    expect(penalized.ok && penalized.notes.join(" ")).toContain(
      "provoked attack of opportunity dealt 6 damage",
    );

    const attackPenalty = pf1eManeuverCheck(base({ attackPenalty: 4 }));
    expect(attackPenalty).toMatchObject({ ok: true, success: false, total: 16 });
  });

  test("the provoke fact: no Improved X feat ⇒ provokes from the target", () => {
    expect(pf1eManeuverCheck(base())).toMatchObject({ provokes: true });
    expect(
      pf1eManeuverCheck(base({ hasImprovedFeat: true })),
    ).toMatchObject({ provokes: false });
  });

  test("concealment: the manœuvre is an attack roll — d% on a would-be success (AoN 182)", () => {
    const missed = pf1eManeuverCheck(
      base({ concealment: { percent: 20 }, concealmentDie: 15 }),
    );
    expect(missed).toMatchObject({
      ok: true,
      success: false,
      concealmentMiss: true,
    });
    expect(missed.ok && missed.notes.join(" ")).toContain(
      "concealment miss — d% 15 ≤ 20",
    );

    const stands = pf1eManeuverCheck(
      base({ concealment: { percent: 20 }, concealmentDie: 21 }),
    );
    expect(stands).toMatchObject({ ok: true, success: true });

    // A would-be failure needs no d% at all.
    const alreadyMissed = pf1eManeuverCheck(
      base({ die: 2, concealment: { percent: 20 } }),
    );
    expect(alreadyMissed).toMatchObject({ ok: true, success: false });

    // A live miss chance without its face is a named refusal, not a guess.
    const missing = pf1eManeuverCheck(base({ concealment: { percent: 20 } }));
    expect(missing).toMatchObject({
      ok: false,
      error:
        "the target is concealed — concealmentDie (the d% face, 1–100) is required to resolve the manœuvre (AoN 182)",
    });
  });

  test("a die that is not a d20 face refuses by name", () => {
    expect(pf1eManeuverCheck(base({ die: 0 }))).toMatchObject({ ok: false });
    expect(pf1eManeuverCheck(base({ die: 21 }))).toMatchObject({ ok: false });
    expect(pf1eManeuverCheck(base({ die: 10.5 }))).toMatchObject({ ok: false });
  });
});

describe("P05 — sunder, the composed consumer (A.9 + A.17)", () => {
  const item = { hardness: 5, hp: 10, hpMax: 20 };

  test("a successful strike breaks the item past half its hit points", () => {
    // Check 15 + 5 = 20 vs CMD 18 succeeds; 12 damage − hardness 5 = 7 to HP:
    // 10 → 3, under half of 20 ⇒ broken, not destroyed.
    const res = pf1eSunder({
      check: base({ kind: "sunder" }),
      item,
      damage: 12,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.check.success).toBe(true);
    expect(res.item).toEqual({
      hpAfter: 3,
      broken: true,
      destroyed: false,
      destroyedOrBroken: false,
    });
    expect(res.notes.join(" ")).toContain(
      "hardness 5 absorbs first, item HP 10 → 3",
    );
    expect(res.notes.join(" ")).toContain("broken");
  });

  test("at or below zero HP the attacker chooses destroy or leave at 1 HP + broken", () => {
    const res = pf1eSunder({
      check: base({ kind: "sunder" }),
      item,
      damage: 20, // 20 − 5 = 15 to HP: 10 → −5
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error);
    expect(res.item).toEqual({
      hpAfter: -5,
      broken: true,
      destroyed: true,
      destroyedOrBroken: true,
    });
    expect(res.notes.join(" ")).toContain(
      "the attacker chooses: destroyed, or left at 1 HP and broken",
    );
  });

  test("hardness can absorb the whole strike; a missed check leaves the item untouched", () => {
    const absorbed = pf1eSunder({
      check: base({ kind: "sunder" }),
      item,
      damage: 5,
    });
    expect(absorbed.ok && absorbed.item.hpAfter).toBe(10);
    expect(absorbed.ok && absorbed.item.broken).toBe(false);

    const missed = pf1eSunder({
      check: base({ kind: "sunder", die: 2 }),
      item,
      damage: 20,
    });
    expect(missed.ok && missed.item).toEqual({
      hpAfter: 10,
      broken: false,
      destroyed: false,
      destroyedOrBroken: false,
    });
    expect(missed.ok && missed.notes.join(" ")).toContain(
      "the sunder misses — the item is untouched",
    );
  });

  test("an item without a hit-point budget refuses by name", () => {
    const res = pf1eSunder({
      check: base({ kind: "sunder" }),
      item: { hardness: 5, hp: 0, hpMax: 0 },
      damage: 10,
    });
    expect(res).toMatchObject({
      ok: false,
      error:
        "the target item has no hit-point budget authored — sunder cannot be tracked for it (A.17)",
    });
  });
});
