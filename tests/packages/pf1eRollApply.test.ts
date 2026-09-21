/**
 * §2.2/G-20 (D-261) — applying a roll card's total to an actor.
 *
 * The planner is the *only* place damage or healing arithmetic happens for an apply; the host
 * commits its diff verbatim after re-reading the total from its own card, so these tests are the
 * rules evidence for the verb: temp HP absorbs first (H02/D-206), a legacy scalar pool is never
 * silently reinterpreted, healing removes an equal amount of nonlethal damage (CRB p.191) and
 * never touches temp HP, damage floors at 0, and every refusal is named.
 */
import { describe, expect, test } from "vitest";
import {
  appliedWith,
  planRollApply,
  readRollApplications,
  type PF1eRollApplyInput,
} from "../../src/packages/pf1e/rollApply";

const base: PF1eRollApplyInput = {
  mode: "damage",
  amount: 8,
  hp: 12,
  hpMax: 12,
  nonlethalDamage: 0,
  tempHpSources: {},
};

const plan = (input: Partial<PF1eRollApplyInput>) =>
  planRollApply({ ...base, ...input });

describe("planRollApply — damage", () => {
  test("subtracts from hit points and writes only the hit-point diff", () => {
    const result = plan({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.diff).toEqual({ "system.pf1e.hp": 4 });
    expect(result.plan).toMatchObject({ hpBefore: 12, hpAfter: 4, tempHpBefore: 0, tempHpAfter: 0 });
    expect(result.plan.note).toBe("damage 8 — hp 12 → 4");
  });

  test("temporary hit points absorb first, and the source map replaces the legacy scalar", () => {
    const result = plan({ amount: 10, tempHpSources: { "spell:false-life": 6 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 6 absorbed, 4 through: hp 12 → 8, the spent source is gone (not left as a zero) and the
    // scalar the map supersedes is deleted in the same diff.
    expect(result.plan.diff).toEqual({
      "system.pf1e.hp": 8,
      "-=system.pf1e.tempHpSources": null,
      "-=system.pf1e.tempHp": null,
    });
    expect(result.plan.note).toContain("temporary hit points absorbed 6");
  });

  test("a pool that covers the whole hit leaves hit points alone but still spends it", () => {
    const result = plan({ amount: 5, tempHpSources: { a: 3, b: 4 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `absorbDamageWithTempHp` spends the largest source first, then alphabetically: b's 4 goes,
    // then 1 of a's 3 — so a keeps 2 and the spent source is dropped, not zeroed.
    expect(result.plan.diff).toEqual({
      "system.pf1e.tempHpSources": { a: 2 },
      "-=system.pf1e.tempHp": null,
    });
    expect(result.plan).toMatchObject({ hpBefore: 12, hpAfter: 12, tempHpBefore: 7, tempHpAfter: 2 });
  });

  test("a legacy scalar pool is reported, never reinterpreted into a source map", () => {
    const result = plan({ amount: 4, tempHpSources: { legacy: 6 }, legacyTempHp: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The pool still absorbs (CRB p.191), and it is spent *in place*: writing a source map over an
    // old document would silently migrate it — `tempHp.ts` says the editor does that, not a card.
    expect(result.plan.diff).toEqual({ "system.pf1e.tempHp": 2 });
    expect(result.plan).toMatchObject({ hpAfter: 12, tempHpBefore: 6, tempHpAfter: 2 });

    // Spent to nothing, the scalar goes away entirely rather than lingering as a 0 the
    // derivation would have to special-case.
    const drained = plan({ amount: 6, tempHpSources: { legacy: 6 }, legacyTempHp: true });
    expect(drained.ok).toBe(true);
    if (!drained.ok) return;
    expect(drained.plan.diff).toEqual({ "-=system.pf1e.tempHp": null });
  });

  test("hit points floor at 0 (the dying state reads hp <= 0, never a negative ledger)", () => {
    const result = plan({ amount: 40, hp: 9 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.diff).toEqual({ "system.pf1e.hp": 0 });
    expect(result.plan.note).toContain("at 0 hit points");
  });
});

describe("planRollApply — healing", () => {
  test("restores hit points up to the maximum and removes an equal amount of nonlethal damage", () => {
    const result = plan({ mode: "healing", amount: 10, hp: 4, hpMax: 12, nonlethalDamage: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // CRB p.191: the *rolled* amount removes nonlethal (5 < 10 ⇒ all of it) even though only 8
    // hit points were missing — and the wasted 2 are named for the table.
    expect(result.plan.diff).toEqual({
      "system.pf1e.hp": 12,
      "system.pf1e.nonlethalDamage": 0,
    });
    expect(result.plan.note).toContain("cap at 12");
    expect(result.plan).toMatchObject({ hpBefore: 4, hpAfter: 12, nonlethalAfter: 0 });
  });

  test("healing at full hit points still cures nonlethal damage", () => {
    const result = plan({ mode: "healing", amount: 4, hp: 12, nonlethalDamage: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.diff).toEqual({ "system.pf1e.nonlethalDamage": 0 });
  });

  test("nothing to heal is an empty diff, not a refusal", () => {
    const result = plan({ mode: "healing", amount: 4, hp: 12, nonlethalDamage: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.diff).toEqual({});
    expect(result.plan.note).toContain("no effect");
  });

  test("temporary hit points are never restored", () => {
    const result = plan({ mode: "healing", amount: 5, hp: 4, tempHpSources: { a: 2 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.plan.diff)).not.toContain("system.pf1e.tempHpSources");
  });
});

describe("planRollApply — refusals are named", () => {
  test.each([
    [{ amount: 0 }, "a roll of 0 has nothing to apply"],
    [{ amount: 2.5 }, "is not a non-negative whole number"],
    [{ amount: -3 }, "is not a non-negative whole number"],
    [{ hpMax: 0 }, "no usable hit points"],
    [{ nonlethalDamage: -1 }, "not a non-negative whole number"],
  ])("%j", (patch, needle) => {
    const result = plan(patch as Partial<PF1eRollApplyInput>);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain(needle as string);
  });
});

describe("the card's applied record", () => {
  test("reads what the host wrote, ignoring malformed entries", () => {
    expect(
      readRollApplications({
        flags: {
          pf1e: {
            applied: {
              "a-hero": { damage: 8 },
              "a-orc": { healing: 3, damage: "nope" },
              "a-rock": {},
              "a-void": 7,
            },
          },
        },
      }),
    ).toEqual({ "a-hero": { damage: 8 }, "a-orc": { healing: 3 } });
    expect(readRollApplications({})).toEqual({});
    expect(readRollApplications({ flags: { pf1e: { applied: [] } } })).toEqual({});
  });

  test("merges the second verb instead of replacing the first", () => {
    const first = appliedWith({}, "a-hero", "damage", 8);
    const second = appliedWith(first, "a-hero", "healing", 3);
    expect(second).toEqual({ "a-hero": { damage: 8, healing: 3 } });
    expect(appliedWith(second, "a-hero", "damage", 5)).toEqual({
      "a-hero": { damage: 5, healing: 3 },
    });
  });
});
