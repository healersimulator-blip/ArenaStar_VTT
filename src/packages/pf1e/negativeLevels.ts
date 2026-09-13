/**
 * P7/H04/D-204 — negative levels, transcribed from the verified texts:
 *
 *   AoN Rules ID 427 (CRB p.562, "Energy Drain and Negative Levels") — "For
 *   each negative level a creature has, it takes a cumulative –1 penalty on
 *   all ability checks, attack rolls, combat maneuver checks, Combat
 *   Maneuver Defense, saving throws, and skill checks. In addition, the
 *   creature reduces its current and total hit points by 5 for each negative
 *   level it possesses. The creature is also treated as one level lower for
 *   the purpose of level-dependent variables (such as spellcasting) for each
 *   negative level possessed. Spellcasters do not lose any prepared spells
 *   or slots as a result of negative levels. If a creature's negative levels
 *   equal or exceed its total Hit Dice, it dies. A creature with temporary
 *   negative levels receives a new saving throw to remove the negative level
 *   each day. The DC of this save is the same as the effect that caused the
 *   negative levels. Some abilities and spells (such as raise dead) bestow
 *   permanent level drain… treated just like temporary negative levels, but
 *   they do not allow a new save each day to remove them. Level drain can be
 *   removed through spells like restoration."
 *
 *   AoN UMR "Energy Drain" (Bestiary) — "Negative levels remain until 24
 *   hours have passed or until they are removed… If a negative level is not
 *   removed before 24 hours have passed, the affected creature must attempt
 *   a Fortitude save (DC = 10 + 1/2 draining creature's racial HD +
 *   draining creature's Charisma modifier…). On a success, the negative
 *   level goes away with no harm to the creature. On a failure, the negative
 *   level becomes permanent. A separate saving throw is required for each
 *   negative level."
 *
 * The two removal rhythms are encoded as named kinds: **temporary**
 * negative levels (a spell's fixed-duration drain) get a *new save each day*
 * at the causing effect's DC; **energy-drain** levels get *one* save after
 * 24 hours, failure making the level permanent. **Permanent** drain allows
 * no save — restoration-class magic is the only removal, a caller fact (the
 * spell specifics are not encoded here).
 */
/** The authored negative-level counts (both homes, different removal rules). */
export interface PF1eNegativeLevelsAuthored {
  /** Fixed-duration drain (enervation and friends): a new save each day. */
  temporary?: number;
  /** Raise-dead-style permanent drain: no daily save; restoration only. */
  permanent?: number;
}

/** The normalized counts, invalid input coerced to zero and named. */
export interface PF1eNegativeLevelTotals {
  temporary: number;
  permanent: number;
  total: number;
  issues: readonly string[];
}

export function negativeLevelTotalsOf(
  raw: unknown,
): PF1eNegativeLevelTotals {
  const issues: string[] = [];
  const read = (value: unknown, key: string): number => {
    if (value === undefined || value === null) return 0;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      issues.push(
        `negativeLevels.${key} = ${JSON.stringify(value)} is not a whole number ≥ 0 — treated as 0`,
      );
      return 0;
    }
    return value;
  };
  if (typeof raw !== "object" || raw === null) {
    if (raw !== undefined) issues.push("negativeLevels must be an object — ignored");
    return { temporary: 0, permanent: 0, total: 0, issues };
  }
  const rec = raw as Record<string, unknown>;
  const temporary = read(rec.temporary, "temporary");
  const permanent = read(rec.permanent, "permanent");
  return { temporary, permanent, total: temporary + permanent, issues };
}

/** The cumulative penalties AoN 427 states, per negative level. */
export interface PF1eNegativeLevelPenalties {
  /** Cumulative −1 per level on attack rolls. */
  attack: number;
  /** Cumulative −1 per level on saving throws. */
  saves: number;
  /** Cumulative −1 per level on skill checks. */
  skills: number;
  /** Cumulative −1 per level on ability checks. */
  abilityChecks: number;
  /** Cumulative −1 per level on combat maneuver checks. */
  cmb: number;
  /** Cumulative −1 per level on Combat Maneuver Defense. */
  cmd: number;
  /** Current and total hit points both reduce by 5 per level. */
  hp: number;
  /** One level lower per level, for level-dependent variables. */
  effectiveLevelDelta: number;
}

export function negativeLevelPenalties(
  levels: number,
): PF1eNegativeLevelPenalties {
  const n = Math.max(0, Math.floor(levels));
  // `|| 0` normalizes −0: a creature with no negative levels takes exactly
  // zero, never a negative zero the card would print as "-0".
  const perLevel = -n || 0;
  return {
    attack: perLevel,
    saves: perLevel,
    skills: perLevel,
    abilityChecks: perLevel,
    cmb: perLevel,
    cmd: perLevel,
    hp: -5 * n || 0,
    effectiveLevelDelta: perLevel,
  };
}

/** AoN 427: a creature whose negative levels equal or exceed its Hit Dice dies. */
export function negativeLevelDeath(input: {
  levels: number;
  hitDice: number;
}): boolean {
  return input.hitDice > 0 && input.levels >= input.hitDice;
}

/** The DC formula the energy drain universal monster rule states. */
export function energyDrainSaveDC(input: {
  /** The draining creature's racial Hit Dice. */
  racialHd: number;
  /** The draining creature's Charisma modifier. */
  chaMod: number;
}): number {
  return 10 + Math.floor(input.racialHd / 2) + input.chaMod;
}

/**
 * The removal save. Temporary levels retry each day at the causing effect's
 * own DC; energy-drain levels get one save after 24 hours and a failure
 * makes the level permanent — a separate save per level.
 */
export function negativeLevelSaveVerdict(input: {
  kind: "temporary" | "energy-drain";
  die: number;
  fortBonus: number;
  dc: number;
}): {
  removed: boolean;
  /** Energy drain only: a failed save makes this level permanent. */
  becomesPermanent: boolean;
  note: string;
} {
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > 20) {
    return {
      removed: false,
      becomesPermanent: false,
      note: "the negative-level save die must be a natural d20 face (1–20)",
    };
  }
  const total = input.die + input.fortBonus;
  const passed = total >= input.dc;
  if (passed) {
    return {
      removed: true,
      becomesPermanent: false,
      note: `Fortitude ${String(total)} ≥ ${String(input.dc)} — the negative level goes away with no harm (AoN 427/UMR Energy Drain)`,
    };
  }
  return {
    removed: false,
    becomesPermanent: input.kind === "energy-drain",
    note:
      input.kind === "energy-drain"
        ? `Fortitude ${String(total)} < ${String(input.dc)} — the negative level becomes permanent (one save, 24 hours after the drain)`
        : `Fortitude ${String(total)} < ${String(input.dc)} — the temporary negative level remains; a new save comes tomorrow (AoN 427)`,
  };
}
