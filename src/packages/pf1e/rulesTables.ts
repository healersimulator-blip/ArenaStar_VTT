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

/**
 * Foundry pf1's short size keys (`traits.size: "med"`, `"lg"`, …). They are not size categories,
 * they are that system's *spelling* of one — and it is the spelling both the build-time converter
 * (`tools/convert/mappers.mjs`, which carries its own copy because it cannot import `src/`) and the
 * runtime character importer meet.
 */
export const SIZE_SHORT_KEYS: Readonly<Record<string, PF1eSize>> = {
  f: "Fine",
  d: "Diminutive",
  t: "Tiny",
  sm: "Small",
  med: "Medium",
  lg: "Large",
  xl: "Huge",
  g: "Gargantuan",
  co: "Colossal",
};

/** `normalizeSize`, plus the short keys a Foundry export states (`"med"` → `"Medium"`). */
export function normalizeSizeKey(value: unknown): PF1eSize | null {
  const full = normalizeSize(value);
  if (full !== null) return full;
  if (typeof value !== "string") return null;
  return SIZE_SHORT_KEYS[value.trim().toLowerCase()] ?? null;
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
  // "resistance" is the SRD's own name for the bonus a cloak of resistance grants; Foundry's
  // pithy spelling of the same type is `resist` (`itemChanges.ts` maps it here).
  "resistance",
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

// ── M17: the shared tables both scales read ─────────────────────────────────────────
//
// Before this section the numbers below lived where they were first needed: the two-weapon
// table inside the tactical attack builder, the cover grades inside `resolve.ts`, the armored
// speed rows nowhere at all. Gap List §6's charge was that table *presence* was being read as
// coverage — a rule counts when a row is pinned and both scales read the same one. So every
// row here names the appendix or decision it was transcribed from,
// `tests/packages/pf1eSrdTables.test.ts` asserts each row, and the content packs under
// `systems/pf1e-core/packs/` are checked against these rows rather than trusted.
//
// The doctrine at the top of this file still holds: a number the corpus does not transcribe
// is absent here, and no caller may invent one. Where that leaves a hole, it is named below
// and in DEVIATIONS rather than papered over with an extrapolation.

/** @srd Table 8-7 "Two-Weapon Fighting" — D-135 read all four rows off the primary text. */
export interface PF1eTwoWeaponPenaltyRow {
  /** The attacker has the Two-Weapon Fighting feat. */
  readonly feat: boolean;
  /** The off-hand weapon is light (an unarmed strike and a double weapon's off end always are). */
  readonly offHandLight: boolean;
  /** Penalty on every primary-hand attack. */
  readonly primaryHand: number;
  /** Penalty on the single off-hand attack. */
  readonly offHand: number;
}

/**
 * Table 8-7's rows: the feat reduces the primary-hand penalty by 2 and the off-hand penalty by
 * 6; a light off-hand weapon reduces each by 2. The book states both the table and the prose,
 * so the rows are pinned as numbers — deriving them from either sentence alone is how a
 * transcription error becomes load-bearing.
 */
export const PF1E_TWF_PENALTY_TABLE: readonly PF1eTwoWeaponPenaltyRow[] = [
  { feat: false, offHandLight: false, primaryHand: -6, offHand: -10 },
  { feat: false, offHandLight: true, primaryHand: -4, offHand: -8 },
  { feat: true, offHandLight: false, primaryHand: -4, offHand: -4 },
  { feat: true, offHandLight: true, primaryHand: -2, offHand: -2 },
];

/**
 * The two-weapon penalties for one hand. `tactical.ts` re-exports this under the name
 * `twfPenalties`, which is what the tactical attack builder has called since D-135; moving the
 * table here is what lets the strategic scale read the same four rows instead of re-declaring
 * two of them.
 */
export function twfPenalties(input: {
  feat?: boolean | undefined;
  offHandLight?: boolean | undefined;
}): { primaryHand: number; offHand: number } {
  const row =
    PF1E_TWF_PENALTY_TABLE.find(
      (r) =>
        r.feat === (input.feat === true) &&
        r.offHandLight === (input.offHandLight === true),
    ) ?? (PF1E_TWF_PENALTY_TABLE[0] as PF1eTwoWeaponPenaltyRow);
  return { primaryHand: row.primaryHand, offHand: row.offHand };
}

/** @srd A.8 "Cover / concealment" — the five published cover grades. */
export const PF1E_COVER_GRADES = [
  "partial",
  "soft",
  "standard",
  "improved",
  "total",
] as const;
export type PF1eCoverGrade = (typeof PF1E_COVER_GRADES)[number];

export interface PF1eCoverEntry {
  readonly cover: PF1eCoverGrade;
  /** Bonus to AC. Total cover grants none: the attack is refused, not penalised. */
  readonly acBonus: number;
  /** Bonus on Reflex saves — `soft` cover grants none ("soft cover: +4 AC only"). */
  readonly reflexBonus: number;
  /** Total cover blocks line of effect: no attack, no attack of opportunity. */
  readonly blocksLineOfEffect: boolean;
  /** Improved evasion still halves a Reflex-half effect behind improved cover (A.8). */
  readonly improvedEvasionHalves: boolean;
  /** Stealth bonus: only improved cover is printed with one (+10). */
  readonly stealthBonus: number;
}

/**
 * The cover rows in A.8's transcription: partial +2 AC / +1 Reflex, soft +4 AC only, standard
 * +4 / +2, improved +8 / +4 with +10 Stealth, total blocks the attack. "A low obstacle covers
 * only creatures within 30 ft. of it" is geometry rather than a row, so `positional.ts` keeps
 * owning it.
 */
export const PF1E_COVER: readonly PF1eCoverEntry[] = [
  {
    cover: "partial",
    acBonus: 2,
    reflexBonus: 1,
    blocksLineOfEffect: false,
    improvedEvasionHalves: false,
    stealthBonus: 0,
  },
  {
    cover: "soft",
    acBonus: 4,
    reflexBonus: 0,
    blocksLineOfEffect: false,
    improvedEvasionHalves: false,
    stealthBonus: 0,
  },
  {
    cover: "standard",
    acBonus: 4,
    reflexBonus: 2,
    blocksLineOfEffect: false,
    improvedEvasionHalves: false,
    stealthBonus: 0,
  },
  {
    cover: "improved",
    acBonus: 8,
    reflexBonus: 4,
    blocksLineOfEffect: false,
    improvedEvasionHalves: true,
    stealthBonus: 10,
  },
  {
    cover: "total",
    acBonus: 0,
    reflexBonus: 0,
    blocksLineOfEffect: true,
    improvedEvasionHalves: false,
    stealthBonus: 0,
  },
];

/** The cover row for a grade, or null when the grade is not one of the published five. */
export function coverEntry(
  cover: string | undefined | null,
): PF1eCoverEntry | null {
  if (typeof cover !== "string") return null;
  const needle = cover.trim().toLowerCase();
  return PF1E_COVER.find((c) => c.cover === needle) ?? null;
}

/**
 * @srd A.8 "Cover / concealment" — concealment is a miss chance that never stacks, rolled with a
 * d% only after the attack would have hit. Total concealment also denies attacks of opportunity.
 */
export const PF1E_CONCEALMENT_MISS_CHANCE: Readonly<{
  concealment: number;
  total: number;
}> = Object.freeze({ concealment: 20, total: 50 });

/** Armor categories that slow the wearer: medium and heavy. Light armor and shields never do. */
export function armorReducesSpeed(
  armorCategory: string | undefined | null,
): boolean {
  if (typeof armorCategory !== "string") return false;
  const needle = armorCategory.trim().toLowerCase();
  return needle === "medium" || needle === "heavy";
}

/**
 * The armored-speed pairs the corpus transcribes (Gap List §6/P5: "dwarf/gnome/halfling 20 ft,
 * 15 ft in medium/heavy, human/elf 30 → 20"). No other pair is encoded: the printed prose for
 * 25-, 35- and 50-ft. bases is not in the transcribed appendix, so an unlisted base speed comes
 * back unchanged and the hole is named in DEVIATIONS instead of being filled by extrapolation.
 */
export const PF1E_ARMORED_SPEED: Readonly<Record<number, number>> =
  Object.freeze({ 30: 20, 20: 15 });

/** Base speed after armor, in feet per round (0 keeps its base). */
export function speedAfterArmor(
  baseSpeedFeet: number,
  armorCategory: string | undefined | null,
): number {
  const base = Math.max(0, Math.trunc(baseSpeedFeet));
  if (!armorReducesSpeed(armorCategory)) return base;
  return PF1E_ARMORED_SPEED[base] ?? base;
}

/**
 * Arcane spell failure by armor category (the CRB armor tables print one value per category,
 * which is why a pack row can be checked against it). Not transcribed in Appendix A: the value
 * is corpus-external, so it is used only as a cross-check — `tests/packages/pf1eContentPacks
 * .test.ts` refuses a pack whose armor row disagrees with its own category, so one bad row
 * cannot pass, and DEVIATIONS records that both sides come from the same reading.
 */
export function arcaneSpellFailureForCategory(
  category: string | undefined | null,
): number {
  const needle =
    typeof category === "string" ? category.trim().toLowerCase() : "";
  if (needle === "light") return 5;
  if (needle === "medium") return 10;
  if (needle === "heavy") return 15;
  return 0;
}

/**
 * The save and base-attack progressions a class row declares, as the arithmetic the table must
 * produce: good saves 2 + 1/2 per level, poor saves 1/2 per level; good BAB 1 per level, average
 * 3/4, poor 1/2, each rounded down. Exported so `packs/classes.json` is validated row by row
 * rather than trusted, and so the iterative-attack ladder (`iterativeAttackBonuses`) that the
 * strategic engine already reads stays fed by the same numbers.
 */
export type PF1eSaveProgression = "good" | "poor";
export type PF1eBabProgression = "good" | "average" | "poor";

/** @srd "Class Basics > Saving Throws" — the good/poor ladders. */
export function saveBonusAtLevel(
  progression: PF1eSaveProgression,
  level: number,
): number {
  const lv = Math.max(0, Math.trunc(level));
  return progression === "good" ? 2 + Math.floor(lv / 2) : Math.floor(lv / 2);
}

/** @srd "Class Basics > Base Attack Bonus" — the good/average/poor ladders. */
export function babAtLevel(
  progression: PF1eBabProgression,
  level: number,
): number {
  const lv = Math.max(0, Math.trunc(level));
  switch (progression) {
    case "good":
      return lv;
    case "average":
      return Math.floor((lv * 3) / 4);
    case "poor":
      return Math.floor(lv / 2);
    default: {
      const never: never = progression;
      throw new Error(`unknown bab progression: ${String(never)}`);
    }
  }
}
