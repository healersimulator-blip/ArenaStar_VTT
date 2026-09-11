/**
 * PF1e tactical **actor state** — what an actor *is* in combat, and the one derivation that turns
 * `system.pf1e` + active effects into the numbers combat consumes.
 *
 * Two load-bearing rules (Gap List §10.1 items 1–2, recorded as D-112):
 *  1. `actor.system.pf1e` is the **only** authored tactical location, and nothing derived from it is
 *     ever persisted. The strategic pack's `data.system.pf1e` is a *compat read*, not a second place
 *     to edit.
 *  2. Effects never write to the actor: they are read live (`effects.ts`), so an expired buff needs
 *     no undo, no restore, and no cleanup on delete. The derivation is pure, which is also why a UI
 *     can never drift from it.
 *
 * `derivePF1eActor` is **total**: a document missing every PF1e field yields a legal Medium commoner,
 * and every absent-or-malformed input is named in `issues` or `defaults`. Nothing is silently read
 * as 0 where the rules say 10, and nothing throws — a half-filled sheet must still render.
 */
import { err, okVal, type Result } from "../../core/result";
import {
  abilityMod,
  acFromBreakdown,
  attacksOfOpportunityPerRound,
  cmdFrom,
  cmbFrom,
  iterativeAttackBonuses,
  normalizeSize,
  sizeEntry,
  spellSaveDc,
  type PF1eBonusType,
  type PF1eSize,
} from "./rulesTables";
// The corrected unarmed ladder (P3/A01): Medium is 1d3 per AoN Rules ID 131, not the 1d2
// this module previously carried. Import, never duplicate.
import { UNARMED_STRIKE_DAMAGE_BY_SIZE } from "./weapons";
import {
  resolveEffects,
  type PF1eActiveEffect,
  type ResolvedEffects,
} from "./effects";
import {
  readPF1eHealth,
  type PF1eHealthAuthored,
  type PF1eHealthReadout,
} from "./healthState";
import { normalizePF1eSystem } from "./statBlock";

export const PF1E_ABILITY_KEYS = [
  "str",
  "dex",
  "con",
  "int",
  "wis",
  "cha",
] as const;
export type PF1eAbilityKey = (typeof PF1E_ABILITY_KEYS)[number];

/** The six abilities, as scores (modifiers are derived). */
export interface PF1eAbilities {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

/** Authored AC components — never the total (composing it is what Gap List §2.1 fixed strategically). */
export interface PF1eAcComponents {
  armor?: number;
  shield?: number;
  natural?: number;
  dodge?: number;
  misc?: number;
}

export interface PF1eArmorEntry {
  armorBonus?: number;
  shieldBonus?: number;
  /** Armor's maximum Dexterity bonus — a lower cap than the wearer's Dex modifier wins (A.2). */
  maxDexBonus?: number;
  /** Armor check penalty. */
  checkPenalty?: number;
  /** Arcane spell failure chance, percent. */
  spellFailure?: number;
}

/** An authored attack line; iterative extra attacks and ability damage are derived, not authored. */
export interface PF1eAttackEntry {
  name?: string;
  ranged?: boolean;
  rangeIncrementFt?: number;
  /** Authored damage dice, e.g. "1d8". */
  damageDice?: string;
  /** Flat damage already on the line (masterwork/magic weapon bonuses and friends). */
  damageBonus?: number;
  damageType?: string;
  /** Two-handed weapons add 1.5× Str, off-hand and secondary natural attacks 0.5× (A.3). */
  twoHanded?: boolean;
  offHand?: boolean;
  /** Natural attacks never iterate with BAB (A.2). */
  natural?: boolean;
  secondary?: boolean;
  reachSquares?: number;
  critMultiplier?: number;
  /** Lowest die roll that threatens a critical (20 = 20 only). Carried, never inverted. */
  critThreatMin?: number;
  /** Ranged touch (rays, touch spells): ignores armor, shield, and natural armor (A.2). */
  touchAttack?: boolean;
  /** The authored `damageBonus` already contains the ability contribution (stat blocks do). */
  abilityDamageIncluded?: boolean;
}

/** Spellcasting, authored once; prepared and spontaneous differ only in slot bookkeeping. */
export interface PF1eSpellsAuthored {
  keyAbility?: PF1eAbilityKey;
  casterLevel?: number;
  /**
   * Which component-resolution tradition the caster's spells use (D-157):
   * `M/DF` lines resolve to M for arcane casters and DF for divine ones, and
   * arcane spell failure from armour only applies to arcane casting.
   * Defaults to `"arcane"` at the point of use when absent.
   */
  tradition?: "arcane" | "divine";
  /** Extra flat bonus on save DCs (focus item, special). */
  dcBonus?: number;
  casterLevelBonus?: number;
  concentrationBonus?: number;
  mode?: "prepared" | "spontaneous";
  /** Slots per day by spell level (0–10). This is the authored budget. */
  slotsPerDay?: Partial<Record<number, number>>;
  /**
   * Slots already spent today (levels 0–9) — daily ledger STATE, not derived
   * data (D-155). Resting/resetting is manual until recovery lands (P7).
   */
  slotsUsed?: Partial<Record<number, number>>;
  /**
   * A prepared caster's current preparation (D-155): each entry names the
   * spell, the level it was prepared at, the slot it fills (defaults to its
   * level) and whether it has been expended. Spontaneous casters keep no list.
   */
  prepared?: Array<{
    name: string;
    level: number;
    slotLevel?: number;
    expended?: boolean;
    /**
     * The spell's Components line, e.g. "V, S, M/DF" (D-157). Drives the
     * C03a casting gate (legality, arcane spell failure, deafened spoilage,
     * concentration). Absent/empty means the cast flow skips the gate.
     */
    components?: string;
  }>;
}

/** Cap on the authored prepared-spell list (a defense against malformed packs). */
export const MAX_PREPARED_SPELLS = 200;

/** Everything a PF1e actor document may author under `system.pf1e`. */
export interface PF1eActorSystem extends PF1eHealthAuthored {
  size?: string;
  speedFt?: number;
  landSpeedFt?: number;
  climbSpeedFt?: number;
  flySpeedFt?: number;
  swimSpeedFt?: number;
  burrowSpeedFt?: number;
  abilities?: Partial<Record<PF1eAbilityKey, number>>;
  baseAttack?: number;
  attackBonus?: number;
  /** Authored misc CMB / CMD adjustments on top of the formula (racial, "Grab", …). */
  combatManeuverBonus?: number;
  cmb?: number;
  cmd?: number;
  cmdBonus?: number;
  armorClass?: PF1eAcComponents;
  armor?: PF1eArmorEntry;
  saves?: { fort?: number; ref?: number; will?: number };
  /** Non-Dexterity initiative adjustments (Improved Initiative, Trait, bonus feats). */
  initiative?: number;
  attacks?: PF1eAttackEntry[];
  spells?: PF1eSpellsAuthored;
  /**
   * A held touch-spell charge (D-158, "Holding the Charge"): written when a
   * melee touch attack misses on the round of casting, cleared when the
   * charge is delivered, dissipates when another spell is cast.
   */
  heldCharge?: {
    name: string;
    level: number;
    slotLevel?: number;
    damageFormula?: string;
    saveType?: "fort" | "ref" | "will";
    severity?: string;
    energyType?: string;
  };
  feats?: string[];
  traits?: string[];
  conditions?: string[];
  hp?: number;
  hpMax?: number;
  nonlethalDamage?: number;
  /** Damage reduction list is P7; the flat shortcut lives here for pack compatibility. */
  dr?: number;
  spellResistance?: number;
  spellResistanceNote?: string;
  /** Melee penalty for shooting a struck-then-withdraw snipe (A.9's sniping note). */
  snipingPenalty?: number;
  /**
   * AC published as totals by a stat block (`normalizePF1eSystem` writes this). Used only when no AC
   * components exist (unless acMode explicitly selects components). Effects still add on top.
   */
  acTotals?: { normal: number; touch?: number; flatFooted?: number };
  /** Explicit tactical choice; absent preserves the historical published-total behavior. */
  acMode?: "published" | "components";
  /** Set when `saves` holds published totals, so ability modifiers are not added twice. */
  savesAsTotal?: boolean;
  /**
   * Accumulated ability damage (CRB p.555, AoN Rules ID 416): the score itself is NOT reduced —
   * every 2 full points apply a –1 penalty to the statistics based on that ability. Damage ≥
   * score ⇒ unconscious until healed (dead, for Constitution). Bookkeeping only: natural and
   * magical healing are not automated here.
   */
  abilitiesDamage?: Partial<Record<PF1eAbilityKey, number>>;
  /** Ability drain (CRB p.555): actually reduces the score; every statistic follows it. */
  abilitiesDrain?: Partial<Record<PF1eAbilityKey, number>>;
  /**
   * Total Hit Dice. Needed only for the Constitution damage/drain hit-point adjustment
   * (current and maximum HP each lose Hit Dice × the Con penalty); when absent that
   * adjustment is reported as not computable, never guessed.
   */
  hitDice?: number;
  /** Stat blocks publish the generic size modifier, not a category (see A.4's deviation note). */
  sizeMod?: number;
  drBypass?: string[];
  regeneration?: number;
  regenSuppress?: string[];
  fastHealing?: number;
  spellPenetration?: number;
  casterLevel?: number;
  /** Anything a rule needs that this contract has no field for yet — preserved, never invented from. */
  [key: string]: unknown;
}

/** A resolved attack line: everything one attack roll and one damage roll need. */
export interface PF1eDerivedAttack {
  name: string;
  ranged: boolean;
  /** Every iterative bonus in order, already including ability, size, and effect modifiers (A.2). */
  attackBonuses: number[];
  /** The full attack bonus of the first iterative, for display and for AoO reads. */
  attackBonus: number;
  damageDice: string | null;
  /** Ability contribution after two-hand / off-hand multipliers (A.3). */
  abilityDamage: number;
  /** Everything added to damage: ability contribution, authored flat, and effect bonuses. */
  damageBonus: number;
  damageType: string;
  critThreatMin: number;
  critMultiplier: number;
  reachSquares: number;
  touchAttack: boolean;
  rangedTouch: boolean;
  explain: string;
}

export interface PF1eDerived extends Pick<
  PF1eHealthReadout,
  "tempHp" | "energyResistance"
> {
  size: PF1eSize;
  sizeEntry: ReturnType<typeof sizeEntry>;
  /** Scores after effects and drain — drain reduces the score (CRB p.555). */
  abilities: PF1eAbilities;
  /** Effective modifiers every ability-based statistic uses: mod(score) − damage penalty. */
  abilityMods: PF1eAbilities;
  /** Accumulated ability damage as authored (validated; zero when absent). */
  abilityDamageTaken: PF1eAbilities;
  /** Accumulated ability drain as authored (validated; zero when absent). */
  abilityDrainTaken: PF1eAbilities;
  /** The –1-per-2-points penalty each ability's statistics take (CRB p.555). */
  abilityDamagePenalty: PF1eAbilities;
  baseAttack: number;
  iterativeAttacks: number[];
  ac: { normal: number; touch: number; flatFooted: number };
  saves: { fort: number; ref: number; will: number };
  initiative: number;
  cmb: number;
  cmd: number;
  cmdFlatFooted: number;
  /** Empty list ⇒ the actor had no attack lines at all (a display concern, not an error). */
  attacks: PF1eDerivedAttack[];
  aooPerRound: number;
  canTakeAoO: boolean;
  speedFt: number;
  flySpeedFt: number | null;
  hp: number;
  hpMax: number;
  nonlethalDamage: number;
  conditions: string[];
  flatFooted: boolean;
  deniedDexToAc: boolean;
  immuneMindAffecting: boolean;
  denies: ReadonlySet<string>;
  grants: ReadonlySet<string>;
  dr: number;
  drBypass: string[];
  regeneration: number;
  regenerationSuppress: string[];
  fastHealing: number;
  spellResistance: number;
  spellPenetration: number;
  concentration: number;
  spellCasterLevel: number;
  spellKeyAbility: PF1eAbilityKey;
  casting: boolean;
  /** Index = spell level (0–10); value = save DC, or null when the actor cannot cast. */
  spellSaveDc: (number | null)[];
  /** Index = spell level; authored slots per day, null when the actor has no slots at that level. */
  spellSlots: (number | null)[];
  spellMode: "prepared" | "spontaneous";
  /** `key → why this number is what it is`, so the sheet shows its work instead of trusting itself. */
  explain: Record<string, string>;
  /** Per mod key, the contributions that summed to it (`resolveEffects`). */
  effectBreakdown: Partial<Record<string, string>>;
  /** Active effects that fed this derivation, for the UI's list. */
  effects: readonly PF1eActiveEffect[];
  /** Malformed authored data. */
  issues: string[];
  /** Fields the actor did not author, filled from a documented default. */
  defaults: string[];
  /** What a stat-block import had to reconstruct (empty for a hand-authored sheet). */
  converted: string[];
  /** Authored fields the tactical rules do not implement yet, each with the phase that owns it. */
  unsupported: string[];
  /** AC came from published totals rather than components. */
  acFromTotals: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Core `attributes.hp` is `{ value, max, temp }`; the pack's legacy block is a flat number. */
function unwrap(v: unknown, prefer: "value" | "max"): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (isRecord(v)) {
    const pick = v[prefer] ?? (prefer === "max" ? v.max : v.value) ?? v.total;
    if (typeof pick === "number" && Number.isFinite(pick))
      return Math.trunc(pick);
  }
  return undefined;
}

/**
 * Per-ability accumulated damage/drain (CRB p.555). Malformed entries are issues that
 * contribute zero, and unknown keys are refused — never silently mapped to an ability.
 */
function readAbilityAccum(
  raw: unknown,
  field: string,
  c: Collector,
): PF1eAbilities {
  const out: PF1eAbilities = { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 };
  if (raw === undefined || raw === null) return out;
  if (!isRecord(raw)) {
    c.issues.push(
      `${field}: expected an object of per-ability integers — ignored`,
    );
    return out;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!(PF1E_ABILITY_KEYS as readonly string[]).includes(k)) {
      c.issues.push(`${field}.${k}: not an ability key — ignored`);
      continue;
    }
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      c.issues.push(
        `${field}.${k}: ${JSON.stringify(v)} is not a nonnegative whole number — using 0`,
      );
      continue;
    }
    out[k as PF1eAbilityKey] = v;
  }
  return out;
}

interface Collector {
  issues: string[];
  defaults: string[];
}

function readNumber(
  raw: unknown,
  field: string,
  c: Collector,
  opts: { fallback?: number; defaultWhenAbsent?: number } = {},
): number {
  const fallback = opts.fallback ?? 0;
  if (raw === undefined || raw === null || raw === "") {
    if (opts.defaultWhenAbsent !== undefined) {
      c.defaults.push(
        `${field}: not authored — using ${opts.defaultWhenAbsent}`,
      );
      return opts.defaultWhenAbsent;
    }
    return fallback;
  }
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  if (!Number.isFinite(n)) {
    c.issues.push(
      `${field}: ${JSON.stringify(raw)} is not a number — using ${fallback}`,
    );
    return fallback;
  }
  return Math.trunc(n);
}

/**
 * Read + validate a `system.pf1e` block. The sheet calls this **before** submitting so a bad edit
 * surfaces as a form error rather than as a silently wrong number on the character sheet.
 */
export function parsePF1eActorSystem(raw: unknown): Result<PF1eActorSystem> {
  if (raw === undefined || raw === null) return okVal({});
  if (!isRecord(raw)) return err("system.pf1e must be an object");
  const o = raw as Record<string, unknown>;
  if (
    o.acMode !== undefined &&
    o.acMode !== "published" &&
    o.acMode !== "components"
  )
    return err("system.pf1e.acMode must be published or components");
  if (
    o.size !== undefined &&
    o.size !== null &&
    o.size !== "" &&
    normalizeSize(o.size) === null
  ) {
    return err(
      `system.pf1e.size ${JSON.stringify(o.size)} is not a PF1e size category`,
    );
  }
  if (o.attacks !== undefined && !Array.isArray(o.attacks)) {
    return err("system.pf1e.attacks must be an array");
  }
  if (Array.isArray(o.attacks)) {
    for (const [i, a] of o.attacks.entries()) {
      if (!isRecord(a))
        return err(`system.pf1e.attacks[${i}] must be an object`);
    }
  }
  if (o.abilities !== undefined && !isRecord(o.abilities)) {
    return err("system.pf1e.abilities must be an object of scores");
  }
  if (isRecord(o.abilities)) {
    for (const [k, v] of Object.entries(o.abilities)) {
      if (!(PF1E_ABILITY_KEYS as readonly string[]).includes(k)) {
        return err(`system.pf1e.abilities: "${k}" is not an ability`);
      }
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return err(`system.pf1e.abilities.${k} must be a number`);
      }
    }
  }
  if (o.spells !== undefined) {
    if (!isRecord(o.spells)) return err("system.pf1e.spells must be an object");
    const s = o.spells as Record<string, unknown>;
    if (
      s.keyAbility !== undefined &&
      !(PF1E_ABILITY_KEYS as readonly string[]).includes(String(s.keyAbility))
    ) {
      return err(
        `system.pf1e.spells.keyAbility ${JSON.stringify(s.keyAbility)} is not an ability`,
      );
    }
    if (
      s.mode !== undefined &&
      s.mode !== "prepared" &&
      s.mode !== "spontaneous"
    ) {
      return err(
        `system.pf1e.spells.mode ${JSON.stringify(s.mode)} must be "prepared" or "spontaneous"`,
      );
    }
    if (
      s.tradition !== undefined &&
      s.tradition !== "arcane" &&
      s.tradition !== "divine"
    ) {
      return err(
        `system.pf1e.spells.tradition ${JSON.stringify(s.tradition)} must be "arcane" or "divine"`,
      );
    }
    if (s.slotsUsed !== undefined) {
      if (!isRecord(s.slotsUsed))
        return err("system.pf1e.spells.slotsUsed must be an object");
      for (const [k, v] of Object.entries(
        s.slotsUsed as Record<string, unknown>,
      )) {
        const level = Number(k);
        if (!Number.isInteger(level) || level < 0 || level > 9)
          return err(
            `system.pf1e.spells.slotsUsed level "${k}" must be an integer 0–9`,
          );
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0)
          return err(
            `system.pf1e.spells.slotsUsed["${k}"] must be a non-negative integer`,
          );
      }
    }
    if (s.prepared !== undefined) {
      if (!Array.isArray(s.prepared))
        return err("system.pf1e.spells.prepared must be an array");
      if (s.prepared.length > MAX_PREPARED_SPELLS)
        return err(
          `system.pf1e.spells.prepared supports at most ${MAX_PREPARED_SPELLS} entries`,
        );
      for (const p of s.prepared) {
        if (!isRecord(p))
          return err("system.pf1e.spells.prepared entries must be objects");
        const entry = p as Record<string, unknown>;
        if (typeof entry.name !== "string" || entry.name.trim() === "")
          return err("prepared spells need a non-empty name");
        if (entry.name.length > 120)
          return err("prepared spell names are at most 120 characters");
        if (
          !Number.isInteger(entry.level) ||
          (entry.level as number) < 0 ||
          (entry.level as number) > 9
        )
          return err(
            `prepared spell "${entry.name}": level must be an integer 0–9`,
          );
        if (
          entry.slotLevel !== undefined &&
          (!Number.isInteger(entry.slotLevel) ||
            (entry.slotLevel as number) < 0 ||
            (entry.slotLevel as number) > 9)
        )
          return err(
            `prepared spell "${entry.name}": slotLevel must be an integer 0–9`,
          );
        if (entry.expended !== undefined && typeof entry.expended !== "boolean")
          return err(
            `prepared spell "${entry.name}": expended must be a boolean`,
          );
        if (
          entry.components !== undefined &&
          (typeof entry.components !== "string" ||
            entry.components.length > 120)
        )
          return err(
            `prepared spell "${entry.name}": components must be a string of at most 120 characters`,
          );
      }
    }
  }
  if (o.heldCharge !== undefined && o.heldCharge !== null) {
    if (!isRecord(o.heldCharge))
      return err("system.pf1e.heldCharge must be an object");
    const hc = o.heldCharge as Record<string, unknown>;
    if (typeof hc.name !== "string" || hc.name.trim() === "")
      return err("heldCharge needs a non-empty name");
    if (hc.name.length > 120)
      return err("heldCharge names are at most 120 characters");
    if (!Number.isInteger(hc.level) || (hc.level as number) < 0 || (hc.level as number) > 9)
      return err("heldCharge level must be an integer 0–9");
    if (
      hc.slotLevel !== undefined &&
      (!Number.isInteger(hc.slotLevel) ||
        (hc.slotLevel as number) < 0 ||
        (hc.slotLevel as number) > 9)
    )
      return err("heldCharge slotLevel must be an integer 0–9");
    if (
      hc.damageFormula !== undefined &&
      typeof hc.damageFormula !== "string"
    )
      return err("heldCharge damageFormula must be a string");
    if (
      hc.saveType !== undefined &&
      hc.saveType !== "fort" &&
      hc.saveType !== "ref" &&
      hc.saveType !== "will"
    )
      return err('heldCharge saveType must be "fort", "ref" or "will"');
    if (hc.severity !== undefined && typeof hc.severity !== "string")
      return err("heldCharge severity must be a string");
    if (hc.energyType !== undefined && typeof hc.energyType !== "string")
      return err("heldCharge energyType must be a string");
  }
  if (o.armorClass !== undefined && !isRecord(o.armorClass)) {
    return err("system.pf1e.armorClass must be an object of AC components");
  }
  for (const field of ["abilitiesDamage", "abilitiesDrain"] as const) {
    const v = o[field];
    if (v === undefined || v === null) continue;
    if (!isRecord(v)) {
      return err(
        `system.pf1e.${field} must be an object of per-ability integers`,
      );
    }
    for (const [k, amount] of Object.entries(v)) {
      if (!(PF1E_ABILITY_KEYS as readonly string[]).includes(k)) {
        return err(`system.pf1e.${field}: "${k}" is not an ability`);
      }
      if (
        typeof amount !== "number" ||
        !Number.isSafeInteger(amount) ||
        amount < 0
      ) {
        return err(
          `system.pf1e.${field}.${k} must be a nonnegative whole number`,
        );
      }
    }
  }
  if (
    o.hitDice !== undefined &&
    o.hitDice !== null &&
    (typeof o.hitDice !== "number" ||
      !Number.isSafeInteger(o.hitDice) ||
      o.hitDice < 0)
  ) {
    return err("system.pf1e.hitDice must be a nonnegative whole number");
  }
  if (o.saves !== undefined && !isRecord(o.saves)) {
    return err("system.pf1e.saves must be an object with fort/ref/will");
  }
  if (
    o.feats !== undefined &&
    !Array.isArray(o.feats) &&
    typeof o.feats !== "string"
  ) {
    return err(
      "system.pf1e.feats must be a list of names or a comma-separated string",
    );
  }
  return okVal(o as PF1eActorSystem);
}

export interface DeriveInput {
  system?: PF1eActorSystem | Record<string, unknown> | null | undefined;
  /** Core-owned attributes (`hp`, `ac`, `movement`), which is where pack documents keep them. */
  attributes?: Record<string, unknown> | undefined;
  effects?: readonly PF1eActiveEffect[] | undefined;
}

/**
 * The single tactical derivation. The order is the rules' order: ability scores first (effects can
 * raise them), then everything that consumes a modifier, so a +2 Strength buff moves damage, CMB,
 * and CMD exactly the way the SRD does.
 */
export function derivePF1eActor(input: DeriveInput): PF1eDerived {
  const c: Collector = { issues: [], defaults: [] };
  // Stat blocks (`bab`, `strMod`, `ac`, `weapon`, …) are converted to components where that is
  // possible and carried as totals where it is not; `converted`/`unsupported` say which is which.
  const normalized = normalizePF1eSystem(input.system ?? {});
  for (const line of normalized.converted) c.defaults.push(line);
  const sys = (normalized.system ?? {}) as PF1eActorSystem;
  const health = readPF1eHealth(sys);
  c.issues.push(...health.issues);
  const attrs = isRecord(input.attributes) ? input.attributes : {};
  const effects = input.effects ?? [];
  const resolved: ResolvedEffects = resolveEffects(effects);

  // 1. Ability scores, then typed modifiers *on the scores* (bull's strength and friends), then
  //    the modifiers themselves. An untyped +2 to Str and an enhancement +2 to Str both move the score.
  const base: PF1eAbilities = {
    str: 10,
    dex: 10,
    con: 10,
    int: 10,
    wis: 10,
    cha: 10,
  };
  const authoredAbilities = isRecord(sys.abilities) ? sys.abilities : {};
  if (sys.abilities !== undefined && !isRecord(sys.abilities)) {
    c.issues.push("abilities: expected an object of scores — ignored");
  }
  const abilities: PF1eAbilities = { ...base };
  for (const k of PF1E_ABILITY_KEYS) {
    const v = authoredAbilities[k];
    if (v === undefined) continue;
    const n = readNumber(v, `abilities.${k}`, c, { fallback: 10 });
    if (n < 3 || n > 55)
      c.issues.push(
        `abilities.${k} = ${n} is outside the 3–55 range — kept as authored`,
      );
    abilities[k] = n;
  }
  for (const k of PF1E_ABILITY_KEYS) {
    const m = resolved.mods[`ability.${k}`];
    if (m !== undefined) abilities[k] = abilities[k] + m;
  }
  // 1b. Ability drain and damage (CRB p.555, AoN Rules ID 416). Drain ACTUALLY reduces the
  //     score, so it applies before the modifiers; damage never touches the score — every two
  //     full points apply a –1 penalty to the statistics that use that ability's modifier.
  const abilityDrainTaken = readAbilityAccum(
    sys.abilitiesDrain,
    "abilitiesDrain",
    c,
  );
  const abilityDamageTaken = readAbilityAccum(
    sys.abilitiesDamage,
    "abilitiesDamage",
    c,
  );
  const conModBeforeDrain = abilityMod(abilities.con);
  for (const k of PF1E_ABILITY_KEYS) {
    if (abilityDrainTaken[k] === 0) continue;
    abilities[k] = Math.max(0, abilities[k] - abilityDrainTaken[k]);
  }
  /** Con drain's hit-point effect: Δ modifier × Hit Dice (computed after the drain loop). */
  const conModDelta = abilityMod(abilities.con) - conModBeforeDrain;
  const mods: PF1eAbilities = {
    str: abilityMod(abilities.str),
    dex: abilityMod(abilities.dex),
    con: abilityMod(abilities.con),
    int: abilityMod(abilities.int),
    wis: abilityMod(abilities.wis),
    cha: abilityMod(abilities.cha),
  };
  const abilityDamagePenalty: PF1eAbilities = {
    str: Math.floor(abilityDamageTaken.str / 2),
    dex: Math.floor(abilityDamageTaken.dex / 2),
    con: Math.floor(abilityDamageTaken.con / 2),
    int: Math.floor(abilityDamageTaken.int / 2),
    wis: Math.floor(abilityDamageTaken.wis / 2),
    cha: Math.floor(abilityDamageTaken.cha / 2),
  };
  // Effective modifiers: what every ability-based statistic actually rolls with. `mods`
  // (the raw modifiers of the drained scores) stays available for the readout below.
  const eff: PF1eAbilities = {
    str: mods.str - abilityDamagePenalty.str,
    dex: mods.dex - abilityDamagePenalty.dex,
    con: mods.con - abilityDamagePenalty.con,
    int: mods.int - abilityDamagePenalty.int,
    wis: mods.wis - abilityDamagePenalty.wis,
    cha: mods.cha - abilityDamagePenalty.cha,
  };

  // 2. Size and base attack bonus.
  let size: PF1eSize = "Medium";
  const authoredSize = normalizeSize(sys.size);
  if (authoredSize !== null) {
    size = authoredSize;
  } else if (typeof sys.size === "string" && sys.size.trim() !== "") {
    c.issues.push(
      `size ${JSON.stringify(sys.size)} is not a PF1e size category — using Medium`,
    );
  } else if (sys.size !== undefined && sys.size !== null) {
    c.issues.push(
      `size ${JSON.stringify(sys.size)} is not a string — using Medium`,
    );
  } else {
    c.defaults.push("size: not authored — using Medium");
  }
  const sz = sizeEntry(size);
  // A stat block that only published `sizeMod` keeps that number for attack/AC *and* CMB/CMD — the
  // SRD wants the special size ladder there (A.4), which is the recorded strategic deviation.
  const sizeAttackAc = sys.sizeMod ?? sz.attackAc;
  const babRaw =
    sys.baseAttack ??
    sys.attackBonus ??
    attrs.baseAttack ??
    attrs.baseAttackBonus;
  const baseAttack = readNumber(babRaw, "baseAttack", c);
  const iterativeAttacks = iterativeAttackBonuses(baseAttack);

  // 3. Armor, the Dexterity cap it imposes, and the three ACs (A.2).
  const armor = isRecord(sys.armor) ? (sys.armor as PF1eArmorEntry) : {};
  const acC = isRecord(sys.armorClass)
    ? (sys.armorClass as PF1eAcComponents)
    : {};
  const legacyAc = isRecord(attrs.ac)
    ? (attrs.ac as Record<string, unknown>)
    : {};
  const armorBonus = readNumber(
    armor.armorBonus ?? acC.armor ?? attrs.armor ?? legacyAc.armor,
    "armor.armorBonus",
    c,
  );
  const shieldBonus = readNumber(
    armor.shieldBonus ?? acC.shield ?? attrs.shield,
    "armor.shieldBonus",
    c,
  );
  const naturalArmor = readNumber(
    acC.natural ?? attrs.naturalArmor,
    "armorClass.natural",
    c,
  );
  const dodgeBonus = readNumber(acC.dodge, "armorClass.dodge", c);
  const acMisc = readNumber(acC.misc, "armorClass.misc", c);
  const maxDex =
    armor.maxDexBonus === undefined || armor.maxDexBonus === null
      ? Number.POSITIVE_INFINITY
      : readNumber(armor.maxDexBonus, "armor.maxDexBonus", c, {
          fallback: Number.POSITIVE_INFINITY,
        });
  const cappedDex = Number.isFinite(maxDex)
    ? Math.min(eff.dex, maxDex)
    : eff.dex;
  /** The un-penalized Dex contribution, for reconstructing totals a stat block published whole. */
  const cappedRawDex = Number.isFinite(maxDex)
    ? Math.min(mods.dex, maxDex)
    : mods.dex;
  const flatFooted = resolved.flatFooted;
  const deniedDex = flatFooted || resolved.deniedDexToAc;
  const authoredTotals =
    sys.acMode !== "components" && isRecord(sys.acTotals)
      ? (sys.acTotals as PF1eActorSystem["acTotals"])
      : null;
  const composedAc = acFromBreakdown({
    armor: armorBonus,
    shield: shieldBonus,
    dex: deniedDex ? 0 : cappedDex,
    natural: naturalArmor,
    dodge: deniedDex ? 0 : dodgeBonus, // dodge bonuses are lost when flat-footed (A.2)
    misc: acMisc,
    size: sizeAttackAc,
  });
  const acMod = resolved.mods.ac ?? 0;
  // A stat block publishes totals that cannot be recomposed (no armor/natural breakdown was authored),
  // so those totals stand and only the effect layer is added on top — the same precedence
  // `compilePF1eProfile` uses, which is what keeps the two scales from disagreeing about the content.
  const acBase =
    authoredTotals === null || authoredTotals === undefined
      ? composedAc
      : {
          // Published totals stand, but the Dexterity damage penalty still applies to
          // normal and touch AC (CRB p.555 lists AC among Dex statistics); flat-footed
          // already excludes Dex, so it never takes the penalty. Reconstruction
          // arithmetic subtracts the RAW Dex contribution, then the penalty once.
          normal: (authoredTotals.normal ?? 10) - abilityDamagePenalty.dex,
          touch:
            authoredTotals.touch !== undefined
              ? authoredTotals.touch - abilityDamagePenalty.dex
              : Math.max(
                  10,
                  (authoredTotals.normal ?? 10) -
                    cappedRawDex -
                    dodgeBonus -
                    abilityDamagePenalty.dex,
                ),
          flatFooted:
            authoredTotals.flatFooted !== undefined
              ? authoredTotals.flatFooted
              : Math.max(
                  10,
                  (authoredTotals.normal ?? 10) -
                    (deniedDex ? 0 : cappedRawDex) -
                    dodgeBonus,
                ),
        };
  const ac = {
    // A general "+N AC" effect applies to all three; `acTouch`/`acFlatFooted` add on top of the
    // ones they name. Armor, shield, and natural bonuses never apply to touch (A.2).
    normal: acBase.normal + acMod,
    touch: acBase.touch + acMod + (resolved.mods.acTouch ?? 0),
    flatFooted: acBase.flatFooted + acMod + (resolved.mods.acFlatFooted ?? 0),
  };

  // 4. Saving throws (A.16's basis: class base + key ability + typed mods).
  const savesAuthored = isRecord(sys.saves) ? sys.saves : {};
  const allSaves = resolved.mods.saves ?? 0;
  const totalsArePublished = sys.savesAsTotal === true;
  const abilitySave = (
    base: unknown,
    key: keyof PF1eAbilities,
    field: string,
  ): number =>
    // Published totals already contain the original ability modifier, so only the damage
    // penalty applies on top; component saves take the effective modifier (CRB p.555).
    readNumber(base, field, c) +
    (totalsArePublished ? -abilityDamagePenalty[key] : eff[key]);
  const saves = {
    fort:
      abilitySave(savesAuthored.fort, "con", "saves.fort") +
      allSaves +
      (resolved.mods["save.fort"] ?? 0),
    ref:
      abilitySave(savesAuthored.ref, "dex", "saves.ref") +
      allSaves +
      (resolved.mods["save.ref"] ?? 0),
    will:
      abilitySave(savesAuthored.will, "wis", "saves.will") +
      allSaves +
      (resolved.mods["save.will"] ?? 0),
  };

  // 5. Initiative = Dexterity check + authored adjustments + effect modifiers (A.1). Ties, surprise,
  //    and the flat-footed-until-first-turn state are `combatState.ts`'s business.
  const initiativeAuthored = readNumber(sys.initiative, "initiative", c);
  const initiativeEffects = resolved.mods.initiative ?? 0;
  // CRB p.178 Initiative: flat-footed denies Dex to AC, not to this Dexterity check.
  // Dex damage's penalty applies to it (CRB p.555 lists initiative among Dex statistics).
  const initiative = eff.dex + initiativeAuthored + initiativeEffects;

  // 6. CMB and CMD (A.9): the special size ladder, not the attack one, and CMD borrows the
  //    transferable AC bonuses plus every AC penalty.
  const cmbMisc = readNumber(
    sys.combatManeuverBonus ?? sys.cmb,
    "combatManeuverBonus",
    c,
  );
  const cmdMisc = readNumber(sys.cmdBonus ?? sys.cmd, "cmdBonus", c);
  const cmb = cmbFrom({
    bab: baseAttack,
    strMod: eff.str,
    dexMod: eff.dex,
    size,
    misc: cmbMisc + (resolved.mods.cmb ?? 0),
    ...(sys.sizeMod !== undefined ? { sizeModOverride: sys.sizeMod } : {}),
  });
  const cmdParts = cmdFrom({
    bab: baseAttack,
    strMod: eff.str,
    dexMod: eff.dex,
    size,
    misc: cmdMisc + (resolved.mods.cmd ?? 0),
    acTransfer: resolved.acTransfer,
    acPenalties: resolved.acPenalties,
    ...(sys.sizeMod !== undefined ? { sizeModOverride: sys.sizeMod } : {}),
  });

  // 7. Attack lines (A.2/A.3).
  const authoredAttacks: PF1eAttackEntry[] = Array.isArray(sys.attacks)
    ? sys.attacks.filter(isRecord).map((a) => a as PF1eAttackEntry)
    : [];
  if (sys.attacks !== undefined && !Array.isArray(sys.attacks)) {
    c.issues.push("attacks: expected an array — ignored");
  }
  const toHit = (ranged: boolean): number =>
    (resolved.mods.attack ?? 0) +
    (ranged
      ? (resolved.mods.attackRanged ?? 0)
      : (resolved.mods.attackMelee ?? 0));
  const lines: PF1eAttackEntry[] =
    authoredAttacks.length > 0
      ? authoredAttacks
      : [{ name: "Unarmed strike", damageDice: unarmedDamageDice(size) }];
  const attacks: PF1eDerivedAttack[] = lines.map((a, idx) => {
    const ranged = a.ranged === true || a.rangeIncrementFt !== undefined;
    const natural = a.natural === true || a.secondary === true;
    const ability = ranged ? eff.dex : eff.str;
    const strMult =
      a.twoHanded === true
        ? 1.5
        : a.offHand === true || a.secondary === true
          ? 0.5
          : 1;
    const abilityDamage =
      a.abilityDamageIncluded === true
        ? 0 // the authored `damageBonus` already contains it (stat-block weapon.damageMod)
        : ranged
          ? 0
          : Math.floor(ability * strMult);
    // A stat-block damage line that already contains the Strength contribution cannot be
    // decomposed, but the roll still relies on Strength: the damage penalty applies flat
    // (CRB p.555). Ranged damage never relies on Strength, so it takes no penalty.
    const includedLinePenalty =
      a.abilityDamageIncluded === true && !ranged
        ? abilityDamagePenalty.str
        : 0;
    const flatDamage = readNumber(
      a.damageBonus,
      `attacks[${idx}].damageBonus`,
      c,
    );
    const effectDamage = resolved.mods.damage ?? 0;
    const ladder = natural ? [baseAttack] : iterativeAttacks;
    const bonus = ability + sizeAttackAc + toHit(ranged);
    const damageBonus =
      abilityDamage + flatDamage + effectDamage - includedLinePenalty;
    const critMultiplier = readNumber(
      a.critMultiplier,
      `attacks[${idx}].critMultiplier`,
      c,
      { fallback: 2 },
    );
    const critThreatMin = readNumber(
      a.critThreatMin,
      `attacks[${idx}].critThreatMin`,
      c,
      {
        fallback: 20,
      },
    );
    if (critThreatMin < 1 || critThreatMin > 20) {
      c.issues.push(
        `attacks[${idx}].critThreatMin = ${critThreatMin} is outside 1–20 — kept, 20 is the default`,
      );
    }
    return {
      name:
        typeof a.name === "string" && a.name !== ""
          ? a.name
          : ranged
            ? "Ranged attack"
            : "Unarmed strike",
      ranged,
      attackBonuses: ladder.map((b) => b + bonus),
      attackBonus: (ladder[0] ?? 0) + bonus,
      damageDice:
        typeof a.damageDice === "string" && a.damageDice !== ""
          ? a.damageDice
          : null,
      abilityDamage,
      damageBonus,
      damageType:
        typeof a.damageType === "string"
          ? a.damageType
          : ranged
            ? "piercing"
            : "bludgeoning",
      critThreatMin: critThreatMin,
      critMultiplier: critMultiplier < 2 ? 2 : critMultiplier,
      reachSquares:
        a.reachSquares !== undefined
          ? readNumber(a.reachSquares, `attacks[${idx}].reachSquares`, c)
          : sz.reachSquares,
      touchAttack: a.touchAttack === true,
      rangedTouch: a.touchAttack === true && ranged,
      explain:
        `${bonus >= 0 ? "+" : ""}${bonus} = ${ranged ? `Dex ${fmt(eff.dex)}` : `Str ${fmt(ability)}${strMult !== 1 ? ` ×${strMult}` : ""}`}` +
        `, size ${fmt(sz.attackAc)}${toHit(ranged) !== 0 ? `, effects ${fmt(toHit(ranged))}` : ""}` +
        `; damage ${fmt(damageBonus)}`,
    };
  });

  // 8. Attacks of opportunity budget (A.10) and the denials that zero it.
  const feats = featList(sys, c.issues);
  const combatReflexes = feats.some(
    (f) => f.trim().toLowerCase() === "combat reflexes",
  );
  // The AoO count is a Dexterity statistic (Combat Reflexes keys on the Dex bonus), so the
  // effective modifier feeds it; the budget formula itself stays A.10's recorded reading.
  const aooPerRound = attacksOfOpportunityPerRound(eff.dex, combatReflexes);
  const canTakeAoO = !resolved.cannotAoO && !flatFooted && aooPerRound > 0;

  // 9. Movement, hit points, conditions.
  const speedRaw = sys.landSpeedFt ?? sys.speedFt ?? attrs.movement;
  const speedFt = readNumber(speedRaw, "speedFt", c, { defaultWhenAbsent: 30 });
  const flySpeedFt =
    sys.flySpeedFt === undefined
      ? null
      : readNumber(sys.flySpeedFt, "flySpeedFt", c);
  const hpMax = readNumber(
    sys.hpMax ?? attrs.hpMax ?? unwrap(attrs.hp, "max"),
    "hpMax",
    c,
  );
  const hp = readNumber(
    sys.hp ?? unwrap(attrs.hp, "value") ?? attrs.hpValue,
    "hp",
    c,
    { fallback: hpMax },
  );
  const nonlethalDamage = readNumber(sys.nonlethalDamage, "nonlethalDamage", c);
  // 9b. Constitution damage/drain hit points (CRB p.555): "multiply your total Hit Dice by
  //     this penalty and subtract that amount from your current and total hit points" (the
  //     damage penalty), plus drain's Δ modifier × Hit Dice. Both apply only when Hit Dice
  //     are authored — without them the adjustment is reported, never guessed.
  const hitDice = readNumber(sys.hitDice, "hitDice", c);
  const conHpPerDie = conModDelta - abilityDamagePenalty.con;
  const conHpAdjustment = hitDice * conHpPerDie;
  const localUnsupported = [...normalized.unsupported];
  if (conHpPerDie !== 0 && hitDice <= 0) {
    localUnsupported.push(
      "hitDice: not authored — the Constitution damage/drain hit-point adjustment cannot be computed; author Hit Dice or adjust hp manually",
    );
  }
  const hpConAdjusted =
    conHpPerDie !== 0 && hitDice > 0 ? hp + conHpAdjustment : hp;
  const hpMaxConAdjusted =
    conHpPerDie !== 0 && hitDice > 0 ? hpMax + conHpAdjustment : hpMax;
  const dr = readNumber(sys.dr, "dr", c);
  const spellResistance = readNumber(sys.spellResistance, "spellResistance", c);
  const authoredConditions = Array.isArray(sys.conditions)
    ? sys.conditions.filter((x): x is string => typeof x === "string")
    : [];
  // 9c. Ability-damage thresholds (CRB p.555): damage ≥ score ⇒ unconscious until it heals
  //     below the score; Constitution damage ≥ score kills outright.
  const thresholdConditions: string[] = [];
  for (const k of PF1E_ABILITY_KEYS) {
    if (abilityDamageTaken[k] > 0 && abilityDamageTaken[k] >= abilities[k]) {
      thresholdConditions.push(k === "con" ? "dead" : "unconscious");
    }
  }
  const conditions = [
    ...new Set([
      ...authoredConditions,
      ...resolved.conditions,
      ...thresholdConditions,
    ]),
  ];

  // 10. Spellcasting (A.16): DC = 10 + spell level + key ability modifier, per level.
  const spellsAuthored = isRecord(sys.spells)
    ? (sys.spells as PF1eSpellsAuthored)
    : {};
  const keyAbility: PF1eAbilityKey =
    typeof spellsAuthored.keyAbility === "string" &&
    (PF1E_ABILITY_KEYS as readonly string[]).includes(spellsAuthored.keyAbility)
      ? spellsAuthored.keyAbility
      : "int";
  const dcBonus = readNumber(spellsAuthored.dcBonus, "spells.dcBonus", c);
  const casterLevel =
    readNumber(spellsAuthored.casterLevel, "spells.casterLevel", c) +
    readNumber(spellsAuthored.casterLevelBonus, "spells.casterLevelBonus", c) +
    (resolved.mods.casterLevel ?? 0);
  const hasSlots = isRecord(spellsAuthored.slotsPerDay)
    ? Object.values(spellsAuthored.slotsPerDay as Record<string, unknown>).some(
        (v) => typeof v === "number" && v > 0,
      )
    : false;
  const casting = hasSlots || (sys.spells !== undefined && casterLevel > 0);
  const spellSaveDcs: (number | null)[] = [];
  const spellSlots: (number | null)[] = [];
  for (let level = 0; level <= 10; level += 1) {
    const slots = spellsAuthored.slotsPerDay?.[level];
    spellSlots.push(
      typeof slots === "number" && Number.isFinite(slots)
        ? Math.max(0, Math.trunc(slots))
        : null,
    );
    // A DC exists for a level the actor has slots at, which is what a sheet lists; a caster level with
    // no slot budget (a stat block's "caster level 3") publishes no per-level DC rather than a guess.
    const slotsLeft =
      typeof slots === "number" && Number.isFinite(slots) && slots > 0;
    spellSaveDcs.push(
      casting && slotsLeft
        ? spellSaveDc({
            spellLevel: level,
            // Int/Wis/Cha damage penalizes the DCs based on that ability (CRB p.555).
            keyMod: eff[keyAbility],
            focus: dcBonus,
          }) + (resolved.mods.spellDc ?? 0)
        : null,
    );
  }
  const concentration =
    readNumber(
      spellsAuthored.concentrationBonus,
      "spells.concentrationBonus",
      c,
    ) + (resolved.mods.concentration ?? 0);

  return {
    size,
    sizeEntry: sz,
    abilities,
    abilityMods: eff,
    abilityDamageTaken,
    abilityDrainTaken,
    abilityDamagePenalty,
    baseAttack,
    iterativeAttacks,
    ac,
    saves,
    initiative,
    cmb,
    cmd: cmdParts.normal,
    cmdFlatFooted: cmdParts.flatFooted,
    attacks,
    aooPerRound,
    canTakeAoO,
    speedFt,
    flySpeedFt,
    hp: hpConAdjusted,
    hpMax: hpMaxConAdjusted,
    tempHp: health.tempHp,
    energyResistance: health.energyResistance,
    nonlethalDamage,
    conditions,
    flatFooted,
    deniedDexToAc: deniedDex,
    immuneMindAffecting: resolved.immuneMindAffecting,
    denies: resolved.denies,
    grants: resolved.grants,
    dr,
    drBypass: Array.isArray(sys.drBypass)
      ? sys.drBypass.filter((x): x is string => typeof x === "string")
      : [],
    regeneration: readNumber(sys.regeneration, "regeneration", c),
    regenerationSuppress: Array.isArray(sys.regenSuppress)
      ? sys.regenSuppress.filter((x): x is string => typeof x === "string")
      : [],
    fastHealing: readNumber(sys.fastHealing, "fastHealing", c),
    spellResistance,
    spellPenetration: readNumber(sys.spellPenetration, "spellPenetration", c),
    concentration,
    spellCasterLevel: casting ? Math.max(0, casterLevel) : 0,
    spellKeyAbility: keyAbility,
    casting,
    spellSaveDc: spellSaveDcs,
    spellSlots,
    spellMode:
      spellsAuthored.mode === "spontaneous" ? "spontaneous" : "prepared",
    explain: {
      abilities: abilityExplain(
        abilities,
        abilityDamageTaken,
        abilityDrainTaken,
        abilityDamagePenalty,
      ),
      hp:
        conHpPerDie === 0 || hitDice <= 0
          ? `${hpConAdjusted} hp (no Constitution adjustment)`
          : `${hpConAdjusted} hp = authored ${hp} ${conHpAdjustment >= 0 ? "+" : "−"} ${Math.abs(conHpAdjustment)} (Con: ${
              conModDelta !== 0
                ? `drain Δ ${conModDelta} × ${hitDice} HD`
                : "drain 0"
            }${abilityDamagePenalty.con !== 0 ? `; damage −${abilityDamagePenalty.con} × ${hitDice} HD` : ""})`,
      ac: authoredTotals
        ? `authored total ${authoredTotals.normal}${acMod !== 0 ? ` + effects ${fmt(acMod)}` : ""}${abilityDamagePenalty.dex !== 0 ? ` − Dex damage ${abilityDamagePenalty.dex}` : ""} — no components to recompose from`
        : `10 + armor ${armorBonus} + shield ${shieldBonus} + Dex ${deniedDex ? "0 (denied)" : cappedDex}` +
          ` + natural ${naturalArmor} + size ${fmt(sz.attackAc)} + dodge ${deniedDex ? "0 (flat-footed)" : dodgeBonus}` +
          ` + misc ${acMisc}${acMod !== 0 ? ` + effects ${fmt(acMod)}` : ""}`,
      touch:
        `10 + Dex ${deniedDex ? "0 (denied)" : cappedDex} + size ${fmt(sizeAttackAc)} + dodge ${deniedDex ? "0" : dodgeBonus}` +
        ` + misc ${acMisc}${acMod !== 0 ? ` + effects ${fmt(acMod)}` : ""}${
          (resolved.mods.acTouch ?? 0) !== 0
            ? ` + touch ${fmt(resolved.mods.acTouch ?? 0)}`
            : ""
        }`,
      flatFooted: `10 + armor ${armorBonus} + shield ${shieldBonus} + natural ${naturalArmor} + size ${fmt(sizeAttackAc)} + misc ${acMisc}`,
      saves: `base + ability (Con/Dex/Wis)${allSaves !== 0 ? ` + ${fmt(allSaves)} all-saves` : ""}`,
      cmb:
        `BAB ${baseAttack} + ${sz.dexToCmb ? `Dex ${fmt(eff.dex)}` : `Str ${fmt(eff.str)}`}` +
        ` + size ${fmt(sys.sizeMod ?? sz.cmbCmd)} + misc ${fmt(cmbMisc)}${(resolved.mods.cmb ?? 0) !== 0 ? ` + effects ${fmt(resolved.mods.cmb ?? 0)}` : ""}`,
      cmd:
        `10 + BAB ${baseAttack} + Str ${fmt(eff.str)} + Dex ${flatFooted ? "0 (flat-footed)" : fmt(eff.dex)}` +
        ` + size ${fmt(sys.sizeMod ?? sz.cmbCmd)} + transferable AC ${fmt(resolved.acTransfer)} + AC penalties ${fmt(resolved.acPenalties)}`,
      initiative:
        `Dex ${fmt(eff.dex)} + authored ${initiativeAuthored}` +
        `${initiativeEffects !== 0 ? ` + effects ${fmt(initiativeEffects)}` : ""}`,
      aoo: `${aooPerRound}/round${combatReflexes ? " (Combat Reflexes)" : ""}${
        flatFooted ? " — none while flat-footed" : ""
      }`,
      speed: `${speedFt} ft; ${sz.spaceFeet} ft space, ${sz.reachSquares} reach`,
    },
    effectBreakdown: resolved.breakdown,
    effects,
    issues: c.issues,
    defaults: c.defaults,
    converted: normalized.converted,
    unsupported: localUnsupported,
    acFromTotals: authoredTotals !== null && authoredTotals !== undefined,
  };
}

function fmt(n: number): string {
  return `${n >= 0 ? "+" : ""}${n}`;
}

/**
 * CRB p.555 (AoN Rules ID 416) readout: drain reduces the score, damage is a
 * –1-per-2-points penalty on that ability's statistics and never reduces the score itself.
 */
function abilityExplain(
  abilities: PF1eAbilities,
  damageTaken: PF1eAbilities,
  drainTaken: PF1eAbilities,
  penalty: PF1eAbilities,
): string {
  const drained = PF1E_ABILITY_KEYS.filter((k) => drainTaken[k] > 0);
  const damaged = PF1E_ABILITY_KEYS.filter((k) => damageTaken[k] > 0);
  if (drained.length === 0 && damaged.length === 0)
    return "scores as authored (no ability damage or drain)";
  const parts: string[] = [];
  if (drained.length > 0)
    parts.push(
      `drain ${drained.map((k) => `${k.toUpperCase()} −${drainTaken[k]}`).join(", ")} (reduces the score)`,
    );
  if (damaged.length > 0)
    parts.push(
      `damage ${damaged.map((k) => `${k.toUpperCase()} ${damageTaken[k]}`).join(", ")} → penalties ${damaged
        .map((k) => `${k.toUpperCase()} −${penalty[k]}`)
        .join(", ")} (–1 per 2 points; the score is not reduced)`,
    );
  const remaining = PF1E_ABILITY_KEYS.filter(
    (k) => damageTaken[k] > 0 && damageTaken[k] >= abilities[k],
  );
  if (remaining.length > 0)
    parts.push(
      `threshold: ${remaining.map((k) => (k === "con" ? "dead" : "unconscious")).join(", ")}`,
    );
  return `${parts.join("; ")} — CRB p.555`;
}

/** Feats may be authored as a list or (as in the shipped pack) as a comma string or JSON blob. */
function featList(raw: Record<string, unknown>, issues: string[]): string[] {
  const direct = raw.feats;
  if (Array.isArray(direct))
    return direct.filter((f): f is string => typeof f === "string");
  if (typeof direct === "string" && direct.trim() !== "") {
    const text = direct.trim();
    if (text.startsWith("[") || text.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (Array.isArray(parsed)) {
          return parsed
            .map((e) =>
              typeof e === "string"
                ? e
                : isRecord(e) && typeof e.name === "string"
                  ? e.name
                  : "",
            )
            .filter((s) => s !== "");
        }
      } catch {
        issues.push(
          'feats: looked like JSON but did not parse — read as "name, name"',
        );
      }
    }
    return text
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }
  if (direct !== undefined)
    issues.push("feats: expected a list of names — ignored");
  return [];
}

/** Unarmed strike damage by size (AoN Rules ID 131: Medium 1d3; see `weapons.ts` for the ladder). */
export function unarmedDamageDice(size: PF1eSize): string {
  return UNARMED_STRIKE_DAMAGE_BY_SIZE[size];
}

/** A derived view straight from documents, for the sheet and the combat panel. */
export function deriveFromDocuments(input: {
  actor: {
    system?: Record<string, unknown> | undefined;
    attributes?: Record<string, unknown> | undefined;
  };
  effects?: readonly PF1eActiveEffect[] | undefined;
}): PF1eDerived {
  const block = input.actor.system?.pf1e;
  const parsed = parsePF1eActorSystem(block);
  const d = derivePF1eActor({
    system: parsed.ok ? parsed.value : {},
    attributes: input.actor.attributes,
    effects: input.effects ?? [],
  });
  return parsed.ok ? d : { ...d, issues: [parsed.error, ...d.issues] };
}

/** Bonus types that move CMD through AC (re-exported so the editor can label them). */
export const CMD_TRANSFER_TYPES: readonly PF1eBonusType[] = [
  "deflection",
  "dodge",
  "insight",
  "luck",
  "morale",
  "profane",
  "sacred",
  "circumstance",
];
