/**
 * P5/C04 — spell slot budgets: bonus spells from the key ability score, total slots per
 * level, prepared versus spontaneous bookkeeping, and overuse that warns rather than
 * refuses.
 *
 * Sources (transcribed 2026-09-11):
 * - CRB Table 1-3 "Ability Modifiers and Bonus Spells", via d20pfsrd.com
 *   /basics-ability-scores/ability-scores/ and cross-checked against dandwiki's PFSRD
 *   mirror. The table is **not** a formula, so it is transcribed row by row.
 * - "To learn, prepare, or cast a spell, the wizard must have an Intelligence score equal
 *   to at least 10 + the spell level" (legacy.aonprd.com/coreRuleBook/classes/wizard.html),
 *   generalized by the class write-ups to any spellcasting ability.
 * - "In addition, he receives bonus spells per day if he has a high Intelligence score
 *   (see Table: Ability Modifiers and Bonus Spells)" — and a bonus is only usable at a
 *   spell level the class actually grants slots at.
 */

/** Spell levels this module reports on: 0 through 9. */
export const PF1E_SLOT_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
export const PF1E_SLOT_LEVEL_COUNT = PF1E_SLOT_LEVELS.length;

/** One row of Table 1-3. `bonus` is indexed by spell level 1–9 (there is no 0th entry). */
export interface PF1eBonusSpellBand {
  minScore: number;
  maxScore: number;
  modifier: number;
  /** False below 10: the row reads "Can't cast spells tied to this ability". */
  canCast: boolean;
  /** Bonus spells per day for spell levels 1..9, in order. */
  bonus: readonly number[];
}

/**
 * Table 1-3, transcribed. Two properties are easy to get wrong from the shape of the
 * table and are the reason it is written out rather than computed:
 *
 * - **0th-level spells never receive a bonus spell**, at any ability score.
 * - The progression is not linear: 20–21 grants 2/1/1/1/1, not 2 at every level.
 *
 * Scores above 45 are not transcribed — the published table ends with "etc. . ." — so
 * they are reported as out of range rather than extrapolated.
 */
export const PF1E_BONUS_SPELL_TABLE: readonly PF1eBonusSpellBand[] = [
  {
    minScore: 1,
    maxScore: 1,
    modifier: -5,
    canCast: false,
    bonus: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    minScore: 2,
    maxScore: 3,
    modifier: -4,
    canCast: false,
    bonus: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    minScore: 4,
    maxScore: 5,
    modifier: -3,
    canCast: false,
    bonus: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    minScore: 6,
    maxScore: 7,
    modifier: -2,
    canCast: false,
    bonus: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    minScore: 8,
    maxScore: 9,
    modifier: -1,
    canCast: false,
    bonus: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    minScore: 10,
    maxScore: 11,
    modifier: 0,
    canCast: true,
    bonus: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    minScore: 12,
    maxScore: 13,
    modifier: 1,
    canCast: true,
    bonus: [1, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    minScore: 14,
    maxScore: 15,
    modifier: 2,
    canCast: true,
    bonus: [1, 1, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    minScore: 16,
    maxScore: 17,
    modifier: 3,
    canCast: true,
    bonus: [1, 1, 1, 0, 0, 0, 0, 0, 0],
  },
  {
    minScore: 18,
    maxScore: 19,
    modifier: 4,
    canCast: true,
    bonus: [1, 1, 1, 1, 0, 0, 0, 0, 0],
  },
  {
    minScore: 20,
    maxScore: 21,
    modifier: 5,
    canCast: true,
    bonus: [2, 1, 1, 1, 1, 0, 0, 0, 0],
  },
  {
    minScore: 22,
    maxScore: 23,
    modifier: 6,
    canCast: true,
    bonus: [2, 2, 1, 1, 1, 1, 0, 0, 0],
  },
  {
    minScore: 24,
    maxScore: 25,
    modifier: 7,
    canCast: true,
    bonus: [2, 2, 2, 1, 1, 1, 1, 0, 0],
  },
  {
    minScore: 26,
    maxScore: 27,
    modifier: 8,
    canCast: true,
    bonus: [2, 2, 2, 2, 1, 1, 1, 1, 0],
  },
  {
    minScore: 28,
    maxScore: 29,
    modifier: 9,
    canCast: true,
    bonus: [3, 2, 2, 2, 2, 1, 1, 1, 1],
  },
  {
    minScore: 30,
    maxScore: 31,
    modifier: 10,
    canCast: true,
    bonus: [3, 3, 2, 2, 2, 2, 1, 1, 1],
  },
  {
    minScore: 32,
    maxScore: 33,
    modifier: 11,
    canCast: true,
    bonus: [3, 3, 3, 2, 2, 2, 2, 1, 1],
  },
  {
    minScore: 34,
    maxScore: 35,
    modifier: 12,
    canCast: true,
    bonus: [3, 3, 3, 3, 2, 2, 2, 2, 1],
  },
  {
    minScore: 36,
    maxScore: 37,
    modifier: 13,
    canCast: true,
    bonus: [4, 3, 3, 3, 3, 2, 2, 2, 2],
  },
  {
    minScore: 38,
    maxScore: 39,
    modifier: 14,
    canCast: true,
    bonus: [4, 4, 3, 3, 3, 3, 2, 2, 2],
  },
  {
    minScore: 40,
    maxScore: 41,
    modifier: 15,
    canCast: true,
    bonus: [4, 4, 4, 3, 3, 3, 3, 2, 2],
  },
  {
    minScore: 42,
    maxScore: 43,
    modifier: 16,
    canCast: true,
    bonus: [4, 4, 4, 4, 3, 3, 3, 3, 2],
  },
  {
    minScore: 44,
    maxScore: 45,
    modifier: 17,
    canCast: true,
    bonus: [5, 4, 4, 4, 4, 3, 3, 3, 3],
  },
];

export interface PF1eSlotIssue {
  field: string;
  message: string;
}

/**
 * "To learn, prepare, or cast a spell, the [caster] must have an [ability] score equal to
 * at least 10 + the spell level."
 */
export function minimumAbilityScore(spellLevel: number): number | null {
  if (!Number.isInteger(spellLevel) || spellLevel < 0 || spellLevel > 9)
    return null;
  return 10 + spellLevel;
}

export interface PF1eBonusSpells {
  ok: boolean;
  canCast: boolean;
  modifier: number | null;
  /** Indexed by spell level 0–9. Index 0 is always 0: 0th-level spells get no bonus. */
  byLevel: number[];
  issues: PF1eSlotIssue[];
}

/** Looks an ability score up in Table 1-3. */
export function bonusSpellsForAbility(abilityScore: number): PF1eBonusSpells {
  const blank = {
    ok: false,
    canCast: false,
    modifier: null as number | null,
    byLevel: new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0),
    issues: [] as PF1eSlotIssue[],
  };
  if (!Number.isInteger(abilityScore)) {
    return {
      ...blank,
      issues: [
        {
          field: "abilityScore",
          message: `${String(abilityScore)} is not an integer`,
        },
      ],
    };
  }
  const band = PF1E_BONUS_SPELL_TABLE.find(
    (b) => abilityScore >= b.minScore && abilityScore <= b.maxScore,
  );
  if (band === undefined) {
    return {
      ...blank,
      issues: [
        {
          field: "abilityScore",
          message:
            abilityScore < 1
              ? `ability score ${abilityScore} is below the table's range`
              : `ability score ${abilityScore} is above the published table (which ends at 45 with "etc."); not extrapolated`,
        },
      ],
    };
  }
  // Index 0 of the returned array is spell level 0, which never receives a bonus.
  const byLevel = [0, ...band.bonus];
  if (!band.canCast) {
    return {
      ok: true,
      canCast: false,
      modifier: band.modifier,
      byLevel: new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0),
      issues: [],
    };
  }
  return {
    ok: true,
    canCast: true,
    modifier: band.modifier,
    byLevel,
    issues: [],
  };
}

export interface PF1eSlotLevelReadout {
  level: number;
  /** Authored class budget, or null when the class grants no slots at this level. */
  base: number | null;
  bonus: number;
  /** base + bonus, or null when the class grants no slots at this level. */
  total: number | null;
  /** False when the key ability score is too low to prepare or cast this level. */
  castable: boolean;
}

export interface PF1eSlotBudget {
  ok: boolean;
  canCast: boolean;
  keyAbilityScore: number | null;
  levels: PF1eSlotLevelReadout[];
  /** Advisory only — nothing here refuses a cast. */
  warnings: string[];
  issues: PF1eSlotIssue[];
}

/**
 * Adds Table 1-3 bonus spells to an authored slot budget.
 *
 * A bonus at a level the class does not grant slots at is reported as a warning rather
 * than granted: a bonus spell is only usable where the class already provides the slot.
 */
export function resolveSpellSlotBudget(input: {
  /** Authored slots by level 0–9; null or absent means the class grants none. */
  baseSlots: readonly (number | null)[];
  keyAbilityScore: number | null;
}): PF1eSlotBudget {
  const issues: PF1eSlotIssue[] = [];
  const warnings: string[] = [];

  if (
    !Array.isArray(input.baseSlots) ||
    input.baseSlots.length < PF1E_SLOT_LEVEL_COUNT
  ) {
    issues.push({
      field: "baseSlots",
      message: `expected ${PF1E_SLOT_LEVEL_COUNT} entries (levels 0–9), got ${
        Array.isArray(input.baseSlots) ? input.baseSlots.length : "none"
      }`,
    });
    return {
      ok: false,
      canCast: false,
      keyAbilityScore: null,
      levels: [],
      warnings,
      issues,
    };
  }

  const bonus =
    input.keyAbilityScore === null
      ? {
          ok: true as const,
          canCast: false,
          byLevel: new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0),
          issues: [] as PF1eSlotIssue[],
        }
      : bonusSpellsForAbility(input.keyAbilityScore);
  if (!bonus.ok) {
    return {
      ok: false,
      canCast: false,
      keyAbilityScore: input.keyAbilityScore,
      levels: [],
      warnings,
      issues: bonus.issues,
    };
  }

  const levels: PF1eSlotLevelReadout[] = [];
  for (let level = 0; level < PF1E_SLOT_LEVEL_COUNT; level += 1) {
    const raw = input.baseSlots[level];
    let base: number | null = null;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      base = Math.max(0, Math.trunc(raw));
    } else if (raw !== null && raw !== undefined) {
      issues.push({
        field: `baseSlots[${level}]`,
        message: `${String(raw)} is not a number of slots`,
      });
    }
    const b = bonus.byLevel[level] ?? 0;
    const minScore = minimumAbilityScore(level);
    const castable =
      minScore !== null &&
      input.keyAbilityScore !== null &&
      bonus.canCast &&
      input.keyAbilityScore >= minScore;

    if (b > 0 && (base === null || base === 0)) {
      warnings.push(
        `key ability score grants ${b} bonus ${level}-level spell${b === 1 ? "" : "s"} per day, but no ${level}-level slots are granted to spend them`,
      );
    }
    if (
      base !== null &&
      base > 0 &&
      !castable &&
      input.keyAbilityScore !== null
    ) {
      warnings.push(
        `${level}-level slots are granted but the key ability score ${input.keyAbilityScore} is below the required ${String(minScore)} to prepare or cast them`,
      );
    }

    levels.push({
      level,
      base,
      bonus: b,
      total: base === null ? null : base + b,
      castable,
    });
  }

  if (input.keyAbilityScore !== null && !bonus.canCast) {
    warnings.push(
      `key ability score ${input.keyAbilityScore} is too low to cast spells tied to that ability at all`,
    );
  }

  return {
    ok: issues.length === 0,
    canCast: bonus.canCast,
    keyAbilityScore: input.keyAbilityScore,
    levels,
    warnings,
    issues,
  };
}

/* ------------------------------------------------------------------ *
 * Bookkeeping — overuse warns, it does not refuse
 * ------------------------------------------------------------------ */

/** Slots spent so far today, indexed by spell level 0–9. */
export interface PF1eSlotLedger {
  spent: number[];
}

export function emptySlotLedger(): PF1eSlotLedger {
  return { spent: new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0) };
}

export interface PF1eSlotSpend {
  ok: boolean;
  /** Always true for a well-formed level: the MVP warns instead of enforcing. */
  allowed: boolean;
  remaining: number | null;
  /** Non-null when the cast exceeds the budget, or the level is not castable. */
  warning: string | null;
  issues: PF1eSlotIssue[];
}

/**
 * Records a spell being cast against the budget. Per C04's "MVP overuse produces
 * warnings, not hard enforcement", spending past the budget is allowed and reported.
 */
export function spendSlot(
  ledger: PF1eSlotLedger,
  budget: PF1eSlotBudget,
  spellLevel: number,
): PF1eSlotSpend {
  const issues: PF1eSlotIssue[] = [];
  if (
    !Number.isInteger(spellLevel) ||
    spellLevel < 0 ||
    spellLevel >= PF1E_SLOT_LEVEL_COUNT
  ) {
    issues.push({
      field: "spellLevel",
      message: `spell level ${String(spellLevel)} is not an integer 0–9`,
    });
    return {
      ok: false,
      allowed: false,
      remaining: null,
      warning: null,
      issues,
    };
  }
  const row = budget.levels[spellLevel];
  if (row === undefined) {
    issues.push({
      field: "budget",
      message: `budget has no entry for level ${spellLevel}`,
    });
    return {
      ok: false,
      allowed: false,
      remaining: null,
      warning: null,
      issues,
    };
  }
  if (
    !Array.isArray(ledger.spent) ||
    ledger.spent.length < PF1E_SLOT_LEVEL_COUNT
  ) {
    issues.push({
      field: "ledger",
      message: "ledger does not cover spell levels 0–9",
    });
    return {
      ok: false,
      allowed: false,
      remaining: null,
      warning: null,
      issues,
    };
  }

  const spentNow = (ledger.spent[spellLevel] ?? 0) + 1;
  ledger.spent[spellLevel] = spentNow;

  let remaining: number | null = null;
  let warning: string | null = null;
  if (row.total === null) {
    warning = `${spellLevel}-level spell cast with no slots granted at that level`;
  } else {
    remaining = row.total - spentNow;
    if (remaining < 0) {
      warning = `${spellLevel}-level slots over budget: ${spentNow} spent of ${row.total} available`;
    } else if (!row.castable && budget.keyAbilityScore !== null) {
      warning = `${spellLevel}-level spell cast below the required key ability score`;
    }
  }

  return { ok: true, allowed: true, remaining, warning, issues };
}

/* ------------------------------------------------------------------ *
 * Prepared versus spontaneous
 * ------------------------------------------------------------------ */

/** One spell held in a prepared caster's slot. */
export interface PF1ePreparedSpell {
  name: string;
  /** The level of the spell as prepared, which may differ from the slot it fills. */
  level: number;
  /** The slot level it occupies; defaults to `level`. */
  slotLevel: number;
  expended: boolean;
}

export interface PF1ePreparation {
  ok: boolean;
  spells: PF1ePreparedSpell[];
  /** Prepared count by level 0–9. */
  preparedByLevel: number[];
  warnings: string[];
  issues: PF1eSlotIssue[];
}

/**
 * Validates a prepared caster's spell list against its slot budget. Over-preparation is
 * a warning, not a refusal.
 */
export function reviewPreparation(input: {
  spells: readonly { name: string; level: number; slotLevel?: number }[];
  budget: PF1eSlotBudget;
}): PF1ePreparation {
  const issues: PF1eSlotIssue[] = [];
  const warnings: string[] = [];
  const preparedByLevel = new Array<number>(PF1E_SLOT_LEVEL_COUNT).fill(0);
  const spells: PF1ePreparedSpell[] = [];

  for (const s of input.spells) {
    const slotLevel = s.slotLevel ?? s.level;
    if (
      !Number.isInteger(slotLevel) ||
      slotLevel < 0 ||
      slotLevel >= PF1E_SLOT_LEVEL_COUNT
    ) {
      issues.push({
        field: "slotLevel",
        message: `${s.name}: slot level ${String(slotLevel)} is not an integer 0–9`,
      });
      continue;
    }
    if (s.slotLevel !== undefined && s.level > slotLevel) {
      warnings.push(
        `${s.name}: a ${s.level}-level spell cannot fill a ${slotLevel}-level slot`,
      );
    }
    preparedByLevel[slotLevel] = (preparedByLevel[slotLevel] ?? 0) + 1;
    spells.push({ name: s.name, level: s.level, slotLevel, expended: false });
  }

  for (let level = 0; level < PF1E_SLOT_LEVEL_COUNT; level += 1) {
    const row = input.budget.levels[level];
    const count = preparedByLevel[level] ?? 0;
    if (count === 0) continue;
    if (row === undefined || row.total === null) {
      warnings.push(
        `${count} spell(s) prepared at level ${level}, which grants no slots`,
      );
    } else if (count > row.total) {
      warnings.push(
        `${count} spells prepared at level ${level}, exceeding the ${row.total} slots available`,
      );
    }
  }

  return { ok: issues.length === 0, spells, preparedByLevel, warnings, issues };
}

/** Expend a prepared spell by name; returns false when none is available. */
export function expendPrepared(
  preparation: PF1ePreparation,
  name: string,
): { ok: boolean; spell: PF1ePreparedSpell | null } {
  const spell = preparation.spells.find((s) => s.name === name && !s.expended);
  if (spell === undefined) return { ok: false, spell: null };
  spell.expended = true;
  return { ok: true, spell };
}

/**
 * A spontaneous caster spends any slot of the spell's level or higher; the lowest
 * sufficient slot is used. Overuse warns rather than refuses, as above.
 */
export function spendSpontaneousSlot(
  ledger: PF1eSlotLedger,
  budget: PF1eSlotBudget,
  spellLevel: number,
): PF1eSlotSpend & { slotLevel: number | null } {
  if (
    !Number.isInteger(spellLevel) ||
    spellLevel < 0 ||
    spellLevel >= PF1E_SLOT_LEVEL_COUNT
  ) {
    return {
      ok: false,
      allowed: false,
      remaining: null,
      warning: null,
      slotLevel: null,
      issues: [
        {
          field: "spellLevel",
          message: `spell level ${String(spellLevel)} is not an integer 0–9`,
        },
      ],
    };
  }
  for (let level = spellLevel; level < PF1E_SLOT_LEVEL_COUNT; level += 1) {
    const row = budget.levels[level];
    if (row === undefined || row.total === null) continue;
    const spent = ledger.spent[level] ?? 0;
    if (spent < row.total) {
      const r = spendSlot(ledger, budget, level);
      return { ...r, slotLevel: level };
    }
  }
  // Nothing available at the spell's level or above: warn, then spend at the spell's own
  // level so the overuse is visible in the ledger rather than silently dropped.
  const r = spendSlot(ledger, budget, spellLevel);
  return {
    ...r,
    slotLevel: spellLevel,
    warning: r.warning ?? `no unspent slot at level ${spellLevel} or above`,
  };
}

/* ------------------------------------------------------------------ *
 * Readouts
 * ------------------------------------------------------------------ */

/** "0th", "1st", "2nd", "3rd", "4th"… for a spell level 0–9. */
export function slotLevelLabel(spellLevel: number): string {
  if (!Number.isInteger(spellLevel)) return `${String(spellLevel)}`;
  const suffix =
    spellLevel === 1 ? "st" : spellLevel === 2 ? "nd" : spellLevel === 3 ? "rd" : "th";
  return `${spellLevel}${suffix}`;
}

export interface PF1eSlotReadoutRow {
  level: number;
  /** e.g. "3rd". */
  label: string;
  /** `spent/total`, plus `prepared` for a prepared caster, or "—" when no slots. */
  text: string;
  /** True when more has been spent at this level than the budget grants. */
  over: boolean;
  /** Total slots available at this level, or null when the class grants none. */
  total: number | null;
  spent: number;
}

export interface PF1eSlotLedgerView {
  rows: PF1eSlotReadoutRow[];
  /** Levels the class actually grants slots at, highest first. */
  grantedLevels: number[];
  /** One-line summary for a compact display, e.g. "1st 1/4 · 2nd 0/3". */
  summary: string;
  /** Budget warnings plus any level spent past its budget. */
  warnings: string[];
}

/**
 * Renders a budget plus an optional spend ledger (and, for a prepared caster, prepared
 * counts) into row and one-line readouts. Levels with no slots are omitted from the
 * summary but kept as rows so a sheet can show the full 0–9 range.
 */
export function slotLedgerView(
  budget: PF1eSlotBudget,
  ledger?: PF1eSlotLedger | null,
  preparedByLevel?: readonly number[] | null,
): PF1eSlotLedgerView {
  const rows: PF1eSlotReadoutRow[] = [];
  const grantedLevels: number[] = [];
  const warnings: string[] = [...budget.warnings];

  for (const level of PF1E_SLOT_LEVELS) {
    const row = budget.levels[level];
    const spent = ledger ? (ledger.spent[level] ?? 0) : 0;
    const prepared = preparedByLevel ? (preparedByLevel[level] ?? 0) : 0;
    const total = row === undefined ? null : row.total;
    const label = slotLevelLabel(level);
    if (total === null) {
      rows.push({ level, label, text: "—", over: false, total: null, spent });
      continue;
    }
    grantedLevels.push(level);
    const over = spent > total;
    if (over) {
      warnings.push(`${label} slots over budget: ${spent} spent of ${total}`);
    }
    const text = preparedByLevel
      ? `${spent}/${total} · ${prepared} prepared`
      : `${spent}/${total}`;
    rows.push({ level, label, text, over, total, spent });
  }

  grantedLevels.reverse();
  const summary =
    rows
      .filter((r) => r.total !== null)
      .map((r) => `${r.label} ${r.spent}/${String(r.total)}`)
      .join(" · ") || "None";

  return { rows, grantedLevels, summary, warnings };
}
