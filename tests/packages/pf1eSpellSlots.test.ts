/**
 * P5/C04 — spell slots, bonus spells, and prepared versus spontaneous bookkeeping.
 *
 * The Table 1-3 expectations below are transcribed from the Core Rulebook's own
 * table (CRB p.17, "Ability Modifiers and Bonus Spells") and cross-checked against
 * the SRD mirrors, not captured from a previous run of this code (V01). The minimum
 * ability score is the wizard text generalised to any spellcasting ability: "To
 * learn, prepare, or cast a spell, the wizard must have an Intelligence score equal
 * to at least 10 + the spell level" (CRB, Wizard).
 *
 * Per C04, overuse produces warnings rather than hard enforcement, so every
 * expectation about an over-budget cast asserts `allowed: true` plus a warning.
 */
import { describe, expect, it } from "vitest";
import {
  PF1E_BONUS_SPELL_TABLE,
  PF1E_SLOT_LEVELS,
  PF1E_SLOT_LEVEL_COUNT,
  bonusSpellsForAbility,
  emptySlotLedger,
  expendPrepared,
  minimumAbilityScore,
  resolveSpellSlotBudget,
  reviewPreparation,
  slotLedgerView,
  slotLevelLabel,
  spendSlot,
  spendSpontaneousSlot,
} from "../../src/packages/pf1e/spellSlots";

/** CRB Table 1-3, transcribed. `bonus` is levels 1st..9th; 0th is never granted. */
const CRB_TABLE_1_3: {
  band: string;
  scores: number[];
  modifier: number;
  canCast: boolean;
  /** Levels 1st through 9th. Shorter arrays are zero-padded. */
  bonus: number[];
}[] = [
  { band: "1", scores: [1], modifier: -5, canCast: false, bonus: [] },
  { band: "2-3", scores: [2, 3], modifier: -4, canCast: false, bonus: [] },
  { band: "4-5", scores: [4, 5], modifier: -3, canCast: false, bonus: [] },
  { band: "6-7", scores: [6, 7], modifier: -2, canCast: false, bonus: [] },
  { band: "8-9", scores: [8, 9], modifier: -1, canCast: false, bonus: [] },
  { band: "10-11", scores: [10, 11], modifier: 0, canCast: true, bonus: [] },
  { band: "12-13", scores: [12, 13], modifier: 1, canCast: true, bonus: [1] },
  {
    band: "14-15",
    scores: [14, 15],
    modifier: 2,
    canCast: true,
    bonus: [1, 1],
  },
  {
    band: "16-17",
    scores: [16, 17],
    modifier: 3,
    canCast: true,
    bonus: [1, 1, 1],
  },
  {
    band: "18-19",
    scores: [18, 19],
    modifier: 4,
    canCast: true,
    bonus: [1, 1, 1, 1],
  },
  {
    band: "20-21",
    scores: [20, 21],
    modifier: 5,
    canCast: true,
    bonus: [2, 1, 1, 1, 1],
  },
  {
    band: "22-23",
    scores: [22, 23],
    modifier: 6,
    canCast: true,
    bonus: [2, 2, 1, 1, 1, 1],
  },
  {
    band: "24-25",
    scores: [24, 25],
    modifier: 7,
    canCast: true,
    bonus: [2, 2, 2, 1, 1, 1, 1],
  },
  {
    band: "26-27",
    scores: [26, 27],
    modifier: 8,
    canCast: true,
    bonus: [2, 2, 2, 2, 1, 1, 1, 1],
  },
  {
    band: "28-29",
    scores: [28, 29],
    modifier: 9,
    canCast: true,
    bonus: [3, 2, 2, 2, 2, 1, 1, 1, 1],
  },
  {
    band: "30-31",
    scores: [30, 31],
    modifier: 10,
    canCast: true,
    bonus: [3, 3, 2, 2, 2, 2, 1, 1, 1],
  },
  {
    band: "32-33",
    scores: [32, 33],
    modifier: 11,
    canCast: true,
    bonus: [3, 3, 3, 2, 2, 2, 2, 1, 1],
  },
  {
    band: "34-35",
    scores: [34, 35],
    modifier: 12,
    canCast: true,
    bonus: [3, 3, 3, 3, 2, 2, 2, 2, 1],
  },
  {
    band: "36-37",
    scores: [36, 37],
    modifier: 13,
    canCast: true,
    bonus: [4, 3, 3, 3, 3, 2, 2, 2, 2],
  },
  {
    band: "38-39",
    scores: [38, 39],
    modifier: 14,
    canCast: true,
    bonus: [4, 4, 3, 3, 3, 3, 2, 2, 2],
  },
  {
    band: "40-41",
    scores: [40, 41],
    modifier: 15,
    canCast: true,
    bonus: [4, 4, 4, 3, 3, 3, 3, 2, 2],
  },
  {
    band: "42-43",
    scores: [42, 43],
    modifier: 16,
    canCast: true,
    bonus: [4, 4, 4, 4, 3, 3, 3, 3, 2],
  },
  {
    band: "44-45",
    scores: [44, 45],
    modifier: 17,
    canCast: true,
    bonus: [5, 4, 4, 4, 4, 3, 3, 3, 3],
  },
];

/** Zero-pads a transcribed band to one entry per spell level 0–9. */
function expectedByLevel(row: (typeof CRB_TABLE_1_3)[number]): number[] {
  const byLevel = new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0);
  for (let level = 1; level < PF1E_SLOT_LEVEL_COUNT; level += 1) {
    byLevel[level] = row.bonus[level - 1] ?? 0;
  }
  return byLevel;
}

/** A 5th-level wizard's authored budget: 4 cantrips, 4/3/2/1. */
const WIZARD_5_SLOTS: readonly (number | null)[] = [
  4,
  4,
  3,
  2,
  1,
  null,
  null,
  null,
  null,
  null,
];

/** A 1st-level wizard's authored budget: 3 cantrips, 1 first (CRB, Wizard). */
const WIZARD_1_SLOTS: readonly (number | null)[] = [
  3,
  1,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
  null,
];

describe("Table 1-3 — ability modifiers and bonus spells (CRB p.17)", () => {
  it("matches every published band, band by band", () => {
    for (const row of CRB_TABLE_1_3) {
      for (const score of row.scores) {
        const result = bonusSpellsForAbility(score);
        expect(result.issues, `score ${score}`).toEqual([]);
        expect(result.ok, `score ${score}`).toBe(true);
        expect(result.canCast, `score ${score} band ${row.band}`).toBe(
          row.canCast,
        );
        expect(result.modifier, `score ${score} band ${row.band}`).toBe(
          row.modifier,
        );
        expect(result.byLevel, `score ${score} band ${row.band}`).toEqual(
          expectedByLevel(row),
        );
      }
    }
  });

  it("grants no bonus spell at 0th level at any ability score", () => {
    // The single easiest thing to get wrong from the shape of the table: the
    // "Bonus Spells per Day" columns start at 1st level.
    for (let score = 1; score <= 45; score += 1) {
      expect(bonusSpellsForAbility(score).byLevel[0], `score ${score}`).toBe(0);
    }
    for (const band of PF1E_BONUS_SPELL_TABLE) {
      expect(band.bonus, `band ${band.minScore}-${band.maxScore}`).toHaveLength(
        9,
      );
    }
  });

  it("is not linear — 20-21 grants 2/1/1/1/1 rather than 2 everywhere", () => {
    expect(bonusSpellsForAbility(20).byLevel).toEqual([
      0, 2, 1, 1, 1, 1, 0, 0, 0, 0,
    ]);
    expect(bonusSpellsForAbility(19).byLevel).toEqual([
      0, 1, 1, 1, 1, 0, 0, 0, 0, 0,
    ]);
    // One score apart, two different rows: the step up is at 20, not at 19.
    expect(bonusSpellsForAbility(20).byLevel[1]).toBe(2);
    expect(bonusSpellsForAbility(19).byLevel[1]).toBe(1);
  });

  it("treats every score below 10 as unable to cast spells of that ability", () => {
    for (const score of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const result = bonusSpellsForAbility(score);
      expect(result.canCast, `score ${score}`).toBe(false);
      expect(result.byLevel, `score ${score}`).toEqual(
        new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0),
      );
      expect(result.modifier, `score ${score}`).toBe(
        Math.floor((score - 10) / 2),
      );
    }
  });

  it("grants nothing at 10-11 (+0)", () => {
    expect(bonusSpellsForAbility(10).byLevel).toEqual(
      new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0),
    );
    expect(bonusSpellsForAbility(10).canCast).toBe(true);
    expect(bonusSpellsForAbility(11).modifier).toBe(0);
  });

  it("does not extrapolate past the published table", () => {
    // The table ends with "etc. . ." above 45; inventing a 46 row would be a
    // fabricated fixture (V01).
    const above = bonusSpellsForAbility(46);
    expect(above.ok).toBe(false);
    expect(above.issues[0]?.field).toBe("abilityScore");
    expect(above.issues[0]?.message).toMatch(/above the published table/);
    expect(above.byLevel).toEqual(
      new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0),
    );

    const below = bonusSpellsForAbility(0);
    expect(below.ok).toBe(false);
    expect(below.issues[0]?.message).toMatch(/below the table's range/);
  });

  it("rejects a non-integer ability score", () => {
    const result = bonusSpellsForAbility(14.5);
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toMatch(/not an integer/);
  });
});

describe("minimum ability score — 10 + the spell level", () => {
  it("is 10 + spell level across 0-9", () => {
    for (const level of PF1E_SLOT_LEVELS) {
      expect(minimumAbilityScore(level), `level ${level}`).toBe(10 + level);
    }
    expect(minimumAbilityScore(0)).toBe(10);
    expect(minimumAbilityScore(9)).toBe(19);
  });

  it("returns null outside 0-9", () => {
    expect(minimumAbilityScore(-1)).toBeNull();
    expect(minimumAbilityScore(10)).toBeNull();
    expect(minimumAbilityScore(3.5)).toBeNull();
  });
});

describe("resolveSpellSlotBudget — base slots plus Table 1-3 bonuses", () => {
  it("adds bonus spells to the authored budget, level by level", () => {
    // Intelligence 18 (+4) grants 1/1/1/1 at 1st-4th, on top of the class budget.
    // 0th level gets nothing, so it stays at the authored 4.
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    expect(budget.ok).toBe(true);
    expect(budget.canCast).toBe(true);
    expect(budget.levels.map((l) => l.total)).toEqual([
      4,
      5,
      4,
      3,
      2,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(budget.levels.map((l) => l.bonus)).toEqual([
      0, 1, 1, 1, 1, 0, 0, 0, 0, 0,
    ]);
    expect(budget.levels.map((l) => l.base)).toEqual([
      4,
      4,
      3,
      2,
      1,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(budget.warnings).toEqual([]);
  });

  it("reports a bonus at a level with no slots as a warning, not as a slot", () => {
    // A 1st-level wizard with Intelligence 18 earns bonuses at 2nd-4th level that
    // he has no slots to spend: the CRB's own gloss is that the bonus is usable
    // only where the class already grants the slot.
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_1_SLOTS,
      keyAbilityScore: 18,
    });
    expect(budget.levels[0]?.total).toBe(3);
    expect(budget.levels[1]?.total).toBe(2);
    for (const level of [2, 3, 4]) {
      expect(budget.levels[level]?.base, `level ${level}`).toBeNull();
      expect(budget.levels[level]?.bonus, `level ${level}`).toBe(1);
      expect(budget.levels[level]?.total, `level ${level}`).toBeNull();
    }
    expect(budget.warnings).toHaveLength(3);
    expect(budget.warnings[0]).toMatch(/no 2-level slots are granted/);
    expect(budget.warnings[2]).toMatch(/no 4-level slots are granted/);
  });

  it("marks levels below the minimum ability score uncastable, and warns", () => {
    // Intelligence 12 prepares or casts up to 2nd level (10 + 2).
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 12,
    });
    expect(budget.levels.slice(0, 5).map((l) => l.castable)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(budget.warnings).toHaveLength(2);
    expect(budget.warnings[0]).toMatch(/below the required 13/);
    expect(budget.warnings[1]).toMatch(/below the required 14/);
  });

  it("keeps castability false everywhere for a key ability that cannot cast at all", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 8,
    });
    expect(budget.canCast).toBe(false);
    expect(budget.levels.every((l) => !l.castable)).toBe(true);
    expect(budget.warnings.at(-1)).toMatch(
      /too low to cast spells tied to that ability/,
    );
    // Slots are still reported — the character sheet shows the grant even when the
    // caster cannot currently use it.
    expect(budget.levels[0]?.total).toBe(4);
  });

  it("reports castability as unknown when no key ability is recorded", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: null,
    });
    expect(budget.ok).toBe(true);
    expect(budget.levels.every((l) => !l.castable)).toBe(true);
    // No bonus spells without a score, and no false warnings.
    expect(budget.levels[1]?.bonus).toBe(0);
    expect(budget.warnings).toEqual([]);
  });

  it("refuses a budget that is not 10 levels long", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: [4, 4, 3],
      keyAbilityScore: 18,
    });
    expect(budget.ok).toBe(false);
    expect(budget.levels).toEqual([]);
    expect(budget.issues[0]?.message).toMatch(/expected 10 entries/);
  });

  it("flags a non-numeric slot entry rather than silently dropping it", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: [
        4,
        "lots",
        3,
        2,
        1,
        null,
        null,
        null,
        null,
        null,
      ] as readonly (number | null)[],
      keyAbilityScore: 18,
    });
    expect(budget.ok).toBe(false);
    expect(budget.issues[0]?.field).toBe("baseSlots[1]");
  });

  it("treats a null slot entry as a level the class does not grant", () => {
    // Intelligence 19 clears the 15 needed for 5th level, so `castable` here is
    // about the score and the null base is what is under test.
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 19,
    });
    expect(budget.levels[5]).toEqual({
      level: 5,
      base: null,
      bonus: 0,
      total: null,
      castable: true,
    });
    expect(budget.warnings).toEqual([]);
  });
});

describe("spendSlot — overuse warns, it does not refuse", () => {
  it("counts down a level's budget and reports the remainder", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const ledger = emptySlotLedger();
    const first = spendSlot(ledger, budget, 1);
    expect(first.allowed).toBe(true);
    expect(first.warning).toBeNull();
    expect(first.remaining).toBe(4);
    expect(ledger.spent[1]).toBe(1);

    for (let i = 0; i < 4; i += 1) spendSlot(ledger, budget, 1);
    expect(ledger.spent[1]).toBe(5);
    const spent = spendSlot(ledger, budget, 1);
    expect(spent.allowed, "the MVP must not refuse an over-budget cast").toBe(
      true,
    );
    expect(spent.remaining).toBe(-1);
    expect(spent.warning).toMatch(/over budget: 6 spent of 5/);
  });

  it("warns when the level grants no slots at all, and still allows the cast", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const ledger = emptySlotLedger();
    const result = spendSlot(ledger, budget, 7);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeNull();
    expect(result.warning).toMatch(/no slots granted at that level/);
    expect(ledger.spent[7]).toBe(1);
  });

  it("warns when the key ability score is too low for the level", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 12,
    });
    const ledger = emptySlotLedger();
    const result = spendSlot(ledger, budget, 3);
    expect(result.allowed).toBe(true);
    expect(result.warning).toMatch(/below the required key ability score/);
  });

  it("rejects a spell level outside 0-9 without touching the ledger", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const ledger = emptySlotLedger();
    for (const level of [-1, 10, 2.5]) {
      const result = spendSlot(ledger, budget, level);
      expect(result.ok, `level ${level}`).toBe(false);
      expect(result.allowed, `level ${level}`).toBe(false);
    }
    expect(ledger.spent).toEqual(
      new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0),
    );
  });
});

describe("spendSpontaneousSlot — the lowest sufficient slot is used", () => {
  // Intelligence 11 throughout: the lowest score that casts 1st level, and the
  // 10-11 band grants no bonus spells, so the escalation logic is what is under
  // test rather than the bonus table.
  it("spends at the spell's own level while slots remain", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: [6, 6, 4, 2, null, null, null, null, null, null],
      keyAbilityScore: 11,
    });
    const ledger = emptySlotLedger();
    const result = spendSpontaneousSlot(ledger, budget, 1);
    expect(result.slotLevel).toBe(1);
    expect(result.remaining).toBe(5);
    expect(result.warning).toBeNull();
  });

  it("escalates to a higher level once the spell's own level is exhausted", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: [6, 1, 4, 2, null, null, null, null, null, null],
      keyAbilityScore: 13,
    });
    const ledger = emptySlotLedger();
    // 1st level totals 2: the authored 1 plus the +1 bonus Intelligence 13 grants.
    expect(budget.levels[1]?.total).toBe(2);
    ledger.spent[1] = 2;
    const result = spendSpontaneousSlot(ledger, budget, 1);
    expect(
      result.slotLevel,
      "1st level is full, so a 2nd-level slot is spent",
    ).toBe(2);
    expect(result.warning).toBeNull();
    expect(ledger.spent[2]).toBe(1);
    expect(ledger.spent[1]).toBe(2);
  });

  it("warns rather than refusing when no slot remains at any level", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: [6, 1, 0, null, null, null, null, null, null, null],
      keyAbilityScore: 13,
    });
    const ledger = emptySlotLedger();
    ledger.spent[1] = 2;
    const result = spendSpontaneousSlot(ledger, budget, 1);
    expect(result.allowed).toBe(true);
    expect(result.slotLevel).toBe(1);
    expect(result.warning).toMatch(/over budget: 3 spent of 2/);
  });

  it("rejects a spell level outside 0-9", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: [6, 6, 4, 2, null, null, null, null, null, null],
      keyAbilityScore: 11,
    });
    const result = spendSpontaneousSlot(emptySlotLedger(), budget, 12);
    expect(result.ok).toBe(false);
    expect(result.slotLevel).toBeNull();
  });
});

describe("reviewPreparation / expendPrepared — prepared casters", () => {
  it("counts prepared spells by slot level, defaulting the slot to the spell's level", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const preparation = reviewPreparation({
      spells: [
        { name: "detect magic", level: 0 },
        { name: "magic missile", level: 1 },
        { name: "shield", level: 1 },
        { name: "fireball", level: 3 },
      ],
      budget,
    });
    expect(preparation.ok).toBe(true);
    expect(preparation.preparedByLevel[0]).toBe(1);
    expect(preparation.preparedByLevel[1]).toBe(2);
    expect(preparation.preparedByLevel[3]).toBe(1);
    expect(preparation.spells.map((s) => s.slotLevel)).toEqual([0, 1, 1, 3]);
    expect(preparation.spells.every((s) => !s.expended)).toBe(true);
  });

  it("honours a spell prepared into a higher slot, and warns on over-preparation", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_1_SLOTS,
      keyAbilityScore: 10,
    });
    const preparation = reviewPreparation({
      spells: [
        { name: "magic missile", level: 1, slotLevel: 3 },
        { name: "magic missile 2", level: 1 },
        { name: "magic missile 3", level: 1 },
      ],
      budget,
    });
    expect(preparation.spells[0]?.slotLevel).toBe(3);
    expect(preparation.preparedByLevel[1]).toBe(2);
    expect(preparation.preparedByLevel[3]).toBe(1);
    // Over-preparation is reported, not refused (C04: warnings, not enforcement).
    expect(preparation.ok).toBe(true);
    expect(preparation.warnings).toEqual([
      "2 spells prepared at level 1, exceeding the 1 slots available",
      "1 spell(s) prepared at level 3, which grants no slots",
    ]);
  });

  it("warns when a higher-level spell is written into a lower slot", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const preparation = reviewPreparation({
      spells: [{ name: "fireball", level: 3, slotLevel: 1 }],
      budget,
    });
    expect(preparation.warnings[0]).toMatch(
      /a 3-level spell cannot fill a 1-level slot/,
    );
    expect(preparation.preparedByLevel[1]).toBe(1);
  });

  it("expendPrepared marks a spell used and refuses a second copy", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const preparation = reviewPreparation({
      spells: [
        { name: "shield", level: 1 },
        { name: "shield", level: 1 },
      ],
      budget,
    });
    const first = expendPrepared(preparation, "shield");
    expect(first.ok).toBe(true);
    expect(preparation.spells[0]?.expended).toBe(true);

    const second = expendPrepared(preparation, "shield");
    expect(second.ok).toBe(true);
    expect(preparation.spells[1]?.expended).toBe(true);

    const third = expendPrepared(preparation, "shield");
    expect(third.ok, "both copies are spent").toBe(false);
    expect(third.spell).toBeNull();

    expect(expendPrepared(preparation, "fireball").ok).toBe(false);
  });

  it("rejects a prepared spell with a level outside 0-9", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const preparation = reviewPreparation({
      spells: [{ name: "wish", level: 12 }],
      budget,
    });
    expect(preparation.ok).toBe(false);
    expect(preparation.spells).toEqual([]);
    expect(preparation.issues[0]?.message).toMatch(/not an integer 0–9/);
  });
});

describe("slot readouts", () => {
  it("labels spell levels 0th through 9th", () => {
    expect(slotLevelLabel(0)).toBe("0th");
    expect(slotLevelLabel(1)).toBe("1st");
    expect(slotLevelLabel(2)).toBe("2nd");
    expect(slotLevelLabel(3)).toBe("3rd");
    expect(slotLevelLabel(9)).toBe("9th");
  });

  it("renders spent/total per granted level, highest first, and a one-line summary", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const ledger = emptySlotLedger();
    ledger.spent[0] = 1;
    ledger.spent[1] = 5;
    const view = slotLedgerView(budget, ledger);

    expect(view.grantedLevels).toEqual([4, 3, 2, 1, 0]);
    expect(view.summary).toBe(
      "0th 1/4 · 1st 5/5 · 2nd 0/4 · 3rd 0/3 · 4th 0/2",
    );
    const first = view.rows.find((r) => r.level === 1);
    expect(first?.text).toBe("5/5");
    expect(first?.over).toBe(false);
    // Levels with no slots are kept as rows so a sheet can show the full 0-9 range.
    const none = view.rows.find((r) => r.level === 6);
    expect(none?.text).toBe("—");
    expect(none?.total).toBeNull();
  });

  it("flags an over-budget level in the readout", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const ledger = emptySlotLedger();
    ledger.spent[2] = 9;
    const view = slotLedgerView(budget, ledger);
    const row = view.rows.find((r) => r.level === 2);
    expect(row?.over).toBe(true);
    expect(view.warnings).toEqual([
      expect.stringContaining("2nd slots over budget: 9 spent of 4"),
    ]);
  });

  it("shows prepared counts for a prepared caster and nothing spent without a ledger", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const preparation = reviewPreparation({
      spells: [
        { name: "magic missile", level: 1 },
        { name: "shield", level: 1 },
      ],
      budget,
    });
    const view = slotLedgerView(budget, null, preparation.preparedByLevel);
    expect(view.rows.find((r) => r.level === 1)?.text).toBe("0/5 · 2 prepared");
    expect(view.summary).toBe(
      "0th 0/4 · 1st 0/5 · 2nd 0/4 · 3rd 0/3 · 4th 0/2",
    );
  });

  it("summarises a caster with no slots as None", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: new Array<number | null>(PF1E_SLOT_LEVEL_COUNT).fill(null),
      keyAbilityScore: 18,
    });
    expect(slotLedgerView(budget).summary).toBe("None");
    expect(slotLedgerView(budget).grantedLevels).toEqual([]);
  });

  it("carries the budget's own warnings into the view", () => {
    const budget = resolveSpellSlotBudget({
      baseSlots: WIZARD_5_SLOTS,
      keyAbilityScore: 18,
    });
    const view = slotLedgerView(budget, emptySlotLedger());
    expect(view.warnings).toEqual(budget.warnings);
  });
});
