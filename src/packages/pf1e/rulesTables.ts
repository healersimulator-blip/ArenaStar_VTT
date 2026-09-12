/**
 * PF1e rules **tables and formulas** — the data both scales read.
 *
 * Per the Gap List §10 decision 1 (recorded as "two independent implementations") there is
 * deliberately **no shared resolution kernel**: the strategic sim (`combatEngine.ts`, pool-of-models
 * shaped) and the tactical derivation (`actor.ts`, actor-shaped) each implement the SRD. What they
 * must never disagree about is the *numbers*, so those live here — once, each with the SRD heading it
 * transcribes. Every value is taken from `PF1e_Combat_Fidelity_GapList.md` Appendix A (transcribed
 * from the d20pfsrd Combat chapter), not from memory.
 *
 * Rules we have NOT verified are deliberately absent: Fighting Defensively and Combat Expertise
 * exact numbers are flagged "re-read before encoding" in Appendix A.15, so this file exports no
 * constant for them and no caller may invent one.
 */

/** @srd "Using the Size Tables" — Appendix A.4/A.5. */
export const PF1E_SIZES = [
  "Fine",
  "Diminutive",
  "Tiny",
  "Small",
  "Medium",
  "Large",
  "Huge",
  "Gargantuan",
  "Colossal",
] as const;

export type PF1eSize = (typeof PF1E_SIZES)[number];

export function isPF1eSize(value: unknown): value is PF1eSize {
  return (
    typeof value === "string" &&
    PF1E_SIZES.some((s) => s.toLowerCase() === value.trim().toLowerCase())
  );
}

/** Canonical spelling of an authored size, or null when it is not a size category at all. */
export function normalizeSize(value: unknown): PF1eSize | null {
  if (typeof value !== "string") return null;
  const needle = value.trim().toLowerCase();
  return PF1E_SIZES.find((s) => s.toLowerCase() === needle) ?? null;
}

export interface PF1eSizeEntry {
  readonly size: PF1eSize;
  /**
   * Size modifier on attack rolls **and** on Armor Class (A.4) — the same number for both, so a
   * Small creature gets +1 to hit and +1 AC, a Large one −1 to both.
   */
  readonly attackAc: number;
  /** Special size modifier on CMB and CMD (A.4): the ladder runs the other way, bigger is better. */
  readonly cmbCmd: number;
  /** Space in feet across (A.5). */
  readonly spaceFeet: number;
  /**
   * Space as 5-ft squares of side (Medium 1, Large 2×2 = 4 occupied squares, …) —
   * `spaceFeet / 5`, squared. The side does **not** step by one per size category:
   * Colossal is 30 ft across, so 6×6 = 36 occupied squares (Table 8-4, AoN 179).
   * 0 means "less than 1 square of space" (Fine, Diminutive, Tiny), which is a
   * capacity fact — see `perSquare` and `geometry.occupancy()` — not a footprint
   * of zero cells.
   */
  readonly spaceSquares: number;
  /**
   * Natural reach in 5-ft squares; 0 = must enter an opponent's square to attack (A.5).
   * This is Table 8-4's **tall** column (AoN Rules ID 179, CRB p.194) — the figure the
   * table prints for Small/Medium, which have no tall/long distinction — in 5-ft squares,
   * i.e. the table's feet ÷ 5: Large 10 ft = 2, Huge 15 ft = 3, Gargantuan 20 ft = 4 and
   * Colossal 30 ft = **6**, not the 5 a "+1 per category" ladder would suggest.
   */
  readonly reachSquares: number;
  /**
   * Table 8-4's **long** column in 5-ft squares, or null where the table prints no long
   * row: "Large (long) 10 ft. space / 5 ft. reach", "Huge (long) 15/10", "Gargantuan
   * (long) 20/15", "Colossal (long) 30/20" (AoN 179). Fine through Medium have a single
   * reach figure, so body shape only distinguishes creatures that "take up more than
   * 1 square" — it is never a licence to invent a second number for them.
   */
  readonly longReachSquares: number | null;
  /** How many of these fit in one 5-ft square (A.5: Tiny 4, Diminutive 25, Fine 100). */
  readonly perSquare: number;
  /** Large+ can use reach weapons, but then cannot strike within its natural reach (A.5). */
  readonly reachWeapon: boolean;
  /** Tiny or smaller: Dexterity replaces Strength on CMB (A.9). */
  readonly dexToCmb: boolean;
  /** Tiny or smaller cannot flank and never threaten (A.5). */
  readonly cannotFlank: boolean;
}

const SIZES: readonly PF1eSizeEntry[] = [
  {
    size: "Fine",
    attackAc: 8,
    cmbCmd: -8,
    spaceFeet: 0.5,
    spaceSquares: 0,
    reachSquares: 0,
    longReachSquares: null,
    perSquare: 100,
    reachWeapon: false,
    dexToCmb: true,
    cannotFlank: true,
  },
  {
    size: "Diminutive",
    attackAc: 4,
    cmbCmd: -4,
    spaceFeet: 1,
    spaceSquares: 0,
    reachSquares: 0,
    longReachSquares: null,
    perSquare: 25,
    reachWeapon: false,
    dexToCmb: true,
    cannotFlank: true,
  },
  {
    size: "Tiny",
    attackAc: 2,
    cmbCmd: -2,
    spaceFeet: 2.5,
    spaceSquares: 0,
    reachSquares: 0,
    longReachSquares: null,
    perSquare: 4,
    reachWeapon: false,
    dexToCmb: true,
    cannotFlank: true,
  },
  {
    size: "Small",
    attackAc: 1,
    cmbCmd: -1,
    spaceFeet: 5,
    spaceSquares: 1,
    reachSquares: 1,
    longReachSquares: null,
    perSquare: 1,
    reachWeapon: false,
    dexToCmb: false,
    cannotFlank: false,
  },
  {
    size: "Medium",
    attackAc: 0,
    cmbCmd: 0,
    spaceFeet: 5,
    spaceSquares: 1,
    reachSquares: 1,
    longReachSquares: null,
    perSquare: 1,
    reachWeapon: false,
    dexToCmb: false,
    cannotFlank: false,
  },
  {
    size: "Large",
    attackAc: -1,
    cmbCmd: 1,
    spaceFeet: 10,
    spaceSquares: 4,
    reachSquares: 2,
    longReachSquares: 1,
    perSquare: 1,
    reachWeapon: true,
    dexToCmb: false,
    cannotFlank: false,
  },
  {
    size: "Huge",
    attackAc: -2,
    cmbCmd: 2,
    spaceFeet: 15,
    spaceSquares: 9,
    reachSquares: 3,
    longReachSquares: 2,
    perSquare: 1,
    reachWeapon: true,
    dexToCmb: false,
    cannotFlank: false,
  },
  {
    size: "Gargantuan",
    attackAc: -4,
    cmbCmd: 4,
    spaceFeet: 20,
    spaceSquares: 16,
    reachSquares: 4,
    longReachSquares: 3,
    perSquare: 1,
    reachWeapon: true,
    dexToCmb: false,
    cannotFlank: false,
  },
  {
    size: "Colossal",
    attackAc: -8,
    cmbCmd: 8,
    spaceFeet: 30,
    spaceSquares: 36,
    reachSquares: 6,
    longReachSquares: 4,
    perSquare: 1,
    reachWeapon: true,
    dexToCmb: false,
    cannotFlank: false,
  },
];

const MEDIUM = SIZES[4] as PF1eSizeEntry;

/** A missing or unrecognized size is Medium — an absent field must never invent a bonus. */
export function sizeEntry(size: string | undefined | null): PF1eSizeEntry {
  const needle = typeof size === "string" ? size.trim().toLowerCase() : "";
  return SIZES.find((s) => s.size.toLowerCase() === needle) ?? MEDIUM;
}

/** Distance in size categories between two sizes (positive = `a` larger). */
export function sizeSteps(a: PF1eSize, b: PF1eSize): number {
  return PF1E_SIZES.indexOf(a) - PF1E_SIZES.indexOf(b);
}

/** @srd "Ability Checks > Ability Modifiers" — floor((score − 10) / 2). */
export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/**
 * Iterative attacks from BAB (Appendix A.2's attack ladder): +11 → [11, 6, 1]. The ladder stops at
 * +1 — an iterative never drops to 0 or below. Natural attacks do not iterate (caller's choice).
 */
export function iterativeAttackBonuses(bab: number): number[] {
  const out: number[] = [];
  for (let cur = Math.trunc(bab); cur > 0; cur -= 5) out.push(cur);
  return out.length > 0 ? out : [0];
}

/** AC contributions, all already-signed (A.2). */
export interface AcBreakdown {
  armor?: number;
  shield?: number;
  /** Dexterity actually applied, i.e. after the armor's maximum Dexterity bonus. */
  dex?: number;
  natural?: number;
  dodge?: number;
  /** Untyped/miscellaneous adjustments, including size-independent racial notes. */
  misc?: number;
  size?: number;
}

/**
 * The three ACs from one breakdown, so they can never disagree (the bug Gap List §2.1 fixed at
 * strategic scale). @srd "Armor Class" (A.2): normal = 10 + armor + shield + Dex + natural + size +
 * misc + dodge; touch = 10 + Dex + size + misc + dodge; flat-footed = normal without Dex and dodge.
 */
export function acFromBreakdown(b: AcBreakdown): {
  normal: number;
  touch: number;
  flatFooted: number;
} {
  const armor = b.armor ?? 0;
  const shield = b.shield ?? 0;
  const dex = b.dex ?? 0;
  const natural = b.natural ?? 0;
  const dodge = b.dodge ?? 0;
  const misc = b.misc ?? 0;
  const size = b.size ?? 0;
  return {
    normal: 10 + armor + shield + dex + natural + size + misc + dodge,
    touch: 10 + dex + size + misc + dodge,
    flatFooted: 10 + armor + shield + natural + size + misc,
  };
}

/** CMB (A.9): BAB + Str — Dexterity instead for Tiny or smaller — + special size + misc. */
export function cmbFrom(i: {
  bab: number;
  strMod: number;
  dexMod: number;
  size: PF1eSize;
  misc?: number;
  /** Stat blocks publish the generic size modifier instead of a category (A.4 deviation). */
  sizeModOverride?: number;
}): number {
  const entry = sizeEntry(i.size);
  const ability = entry.dexToCmb ? i.dexMod : i.strMod;
  return i.bab + ability + (i.sizeModOverride ?? entry.cmbCmd) + (i.misc ?? 0);
}

/**
 * CMD (A.9): 10 + BAB + Str + Dex + special size + misc, plus the transferable AC bonuses and the
 * AC penalties. Flat-footed CMD loses Dexterity entirely — including a negative modifier, because
 * "losing a bonus" never makes you worse.
 */
export function cmdFrom(i: {
  bab: number;
  strMod: number;
  dexMod: number;
  size: PF1eSize;
  misc?: number;
  /** Summed transferable AC bonuses — see CMD_TRANSFERABLE_BONUS_TYPES. */
  acTransfer?: number;
  /** Summed AC penalties (they always transfer). */
  acPenalties?: number;
  /** See `cmbFrom`. */
  sizeModOverride?: number;
}): { normal: number; flatFooted: number } {
  const common =
    10 +
    i.bab +
    i.strMod +
    (i.sizeModOverride ?? sizeEntry(i.size).cmbCmd) +
    (i.misc ?? 0) +
    (i.acTransfer ?? 0) +
    (i.acPenalties ?? 0);
  return { normal: common + i.dexMod, flatFooted: common };
}

/**
 * Bonus types whose value also raises CMD, and note that AC *penalties* transfer too (A.9).
 * Armor/shield/natural/enhancement do not.
 */
export const CMD_TRANSFERABLE_BONUS_TYPES: readonly PF1eBonusType[] = [
  "deflection",
  "dodge",
  "insight",
  "luck",
  "morale",
  "profane",
  "sacred",
  "circumstance",
];

/** Every bonus type the effect payload may name (SRD "Bonuses and Penalties"). */
export const PF1E_BONUS_TYPES = [
  "untyped",
  "armor",
  "circumstance",
  "competence",
  "deflection",
  "dodge",
  "enhancement",
  "insight",
  "luck",
  "morale",
  "natural",
  "profane",
  "racial",
  "sacred",
  "shield",
  "size",
  "trait",
  "feet",
  "alchemical",
  "rage",
] as const;

export type PF1eBonusType = (typeof PF1E_BONUS_TYPES)[number];

export function isPF1eBonusType(value: unknown): value is PF1eBonusType {
  return (
    typeof value === "string" &&
    (PF1E_BONUS_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Stacking lives with the resolver that needs it: `effects.ts:contributionsCombine`.
 *
 * Attacks of opportunity per round.
 *
 * **AoN Rules ID 102 — "Attacks of Opportunity", CRB p.180** (re-verified 2026-09-12):
 *   "An attack of opportunity is a single melee attack, and most characters can only make
 *    one per round."
 * **Combat Reflexes (Combat), CRB p.119** (re-verified 2026-09-12 from the feat entry):
 *   "You may make a number of additional attacks of opportunity per round equal to your
 *    Dexterity bonus. With this feat, you may also make attacks of opportunity while
 *    flat-footed. **Normal**: A character without this feat can make only one attack of
 *    opportunity per round and can't make attacks of opportunity while flat-footed."
 *
 * So the budget is **one per round**, plus the Dexterity bonus for a character who has the
 * feat. The previous reading — "one, plus one more whenever the Dexterity modifier is
 * positive, plus one per point of Dex with Combat Reflexes" — granted a second opportunity
 * to any character with a positive Dexterity bonus, which no fetched text supports, and
 * then double-counted that point for a Combat Reflexes character (Dex 16: 5, where the
 * feat gives 4). Corrected here and in the strategic `maxAoos` default (D-183); the flat-
 * footed exception the same feat entry grants is applied by `actor.ts`'s `canTakeAoO`.
 *
 * Clamped at one: a negative Dexterity bonus cannot take away the single attack whose
 * Normal entry the feat itself restates. The clamp is a documented reading, not
 * transcribed text — the feat says "additional … equal to your Dexterity bonus" without
 * saying what a negative bonus does.
 */
export function attacksOfOpportunityPerRound(
  dexMod: number,
  combatReflexes = false,
): number {
  if (!combatReflexes) return 1;
  return Math.max(1, 1 + dexMod);
}

/**
 * Spell save DC (A.16's basis): 10 + spell level + caster's key ability modifier, plus a focus item
 * or other flat adjustment. Returned per level by the derivation so a sheet can list every DC.
 * @srd "Magic > Spells per Class > Concentration & save DC"
 */
export function spellSaveDc(i: {
  spellLevel: number;
  keyMod: number;
  focus?: number;
}): number {
  return 10 + i.spellLevel + i.keyMod + (i.focus ?? 0);
}

/**
 * Concentration DC after taking damage (A.19): 10 + damage dealt + spell level.
 * @srd "Special Initiative Actions > Concentration"
 */
export function concentrationDc(i: {
  damageTaken: number;
  spellLevel: number;
}): number {
  return 10 + i.damageTaken + i.spellLevel;
}

/** Concentration DC for casting defensively in a threatened square (A.19): 10 + attacker's BAB + spell level. */
export function defensiveCastingDc(i: {
  attackerBab: number;
  spellLevel: number;
}): number {
  return 10 + i.attackerBab + i.spellLevel;
}

/**
 * A Strength (or penalty) reduction that drives damage below 1 leaves **1 point of nonlethal
 * damage** (A.3). This is *not* damage reduction — see `damageAfterDr`.
 */
export function damageAfterPenalties(raw: number): {
  lethal: number;
  nonlethal: number;
} {
  return raw >= 1 ? { lethal: raw, nonlethal: 0 } : { lethal: 0, nonlethal: 1 };
}

/** Damage reduction can take a hit to 0 (it removes damage, it does not convert it). */
export function damageAfterDr(raw: number, dr: number): number {
  return Math.max(0, raw - Math.max(0, dr));
}

/** Energy resistance halves nothing; it subtracts, minimum 0 (A.14's DR/ER ladder). */
export function damageAfterEr(raw: number, er: number): number {
  return Math.max(0, raw - Math.max(0, er));
}

/**
 * Critical multipliers **add** rather than multiply (A.3): ×2 and ×2 is ×3, not ×4. Each entry is a
 * full multiplier (×2, ×3, …), so "improved critical-style" stacking is `combinedCritMultiplier([2,2])`
 * → 3. Never multiply precision damage or bonus dice.
 */
export function combinedCritMultiplier(multipliers: readonly number[]): number {
  let extra = 0;
  for (const m of multipliers) extra += Math.max(0, Math.trunc(m) - 1);
  return extra + 1;
}
