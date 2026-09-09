/**
 * PF1e **typed weapon attack descriptors** (P3/A01) — the data contract A02
 * (attack eligibility/arithmetic), A03 (damage/crits), A04 (range legality) and
 * A05 (defensive mitigation) consume. Authored under `system.pf1e.weapons[]`
 * per D-113: `system.pf1e` is the single authored tactical location, and
 * nothing derived (max increments, misfire escalation, broken penalties) is
 * ever persisted — it is recomputed on read by `resolvePF1eWeapon`.
 *
 * Verified sources for every number in this file:
 * - Range: thrown weapons max **5** range increments, projectile **10** (Gap
 *   List §2.8, CRB p.202 "Range Penalty"); early firearms max **5** and resolve
 *   vs touch AC only within the **1st** increment, advanced firearms max **10**
 *   and stay touch through the **5th** (§2.9, UC p.135).
 * - Broken weapons: −2 on attack **and** damage rolls, a critical only on a
 *   natural 20 dealing ×2 (AoN Rules ID 413, Conditions › Broken).
 * - Misfire: a broken weapon's misfire value rises **+4** (§2.9b). The Gun
 *   Training +2 variant is a feat matter (P3/A07), not encoded here.
 * - Unarmed: a light weapon, bludgeoning, all damage nonlethal, −4 to deal
 *   lethal, provokes from armed targets (AoN Rules ID 131, "Attack" › Unarmed
 *   Attacks); the dice ladder is corrected against that text (see
 *   `UNARMED_STRIKE_DAMAGE_BY_SIZE`).
 * - DR-relevant weapon properties: enhancement, material, alignment and the
 *   special-ability contribution that counts **only** toward `/epic` (total
 *   effective bonus ≥ 6, A.17). The bypass ladder itself is A05's resolver.
 *
 * Deliberately **not** encoded: the Two-Weapon Fighting penalty numbers (the
 * Gap List marks the SRD table "not yet transcribed in Appendix A — cite the
 * page when fixtures are written"), material-specific HP/hardness tables
 * (authored per item instead), and any weapon-name→statistics catalog (pack
 * data, not contract).
 */

import type { PF1eSize } from "./rulesTables";
import { normalizeSize } from "./rulesTables";
import type { PF1eItemWear } from "./items";

/** How the weapon reaches its target — decides max range increments and firearm rules. */
export type PF1eWeaponClass = "melee" | "thrown" | "projectile" | "firearm";

/** Firearm generation (UC p.135): early firearms are the default technological tier. */
export type PF1eFirearmGeneration = "early" | "advanced";

/** Weapon handedness. Light also covers unarmed strikes (they count as light weapons). */
export type PF1eWeaponHandedness = "light" | "one-handed" | "two-handed";

/** Proficiency group; a wielder without it takes −4 on attack rolls (§6.7, applied by A02). */
export type PF1eWeaponProficiency = "simple" | "martial" | "exotic";

/** Physical damage types that matter for DR bypass (A.17). */
export type PF1ePhysicalDamageType = "slashing" | "piercing" | "bludgeoning";

/** DR-relevant special materials. Mithral affects armor statistics, not DR — it is absent. */
export type PF1eWeaponMaterial = "none" | "cold iron" | "silver" | "adamantine";

/** Weapon alignment components a weapon may carry for overcoming alignment-based DR. */
export type PF1eWeaponAlignment = "good" | "evil" | "lawful" | "chaotic";

/** Maximum range increments by class (§2.8/§2.9); advanced firearms override to 10. */
export const MAX_RANGE_INCREMENTS: Readonly<Record<PF1eWeaponClass, number>> = {
  melee: 0,
  thrown: 5,
  projectile: 10,
  firearm: 5,
};

/** Advanced firearms reach 10 increments (UC p.135, §2.9). */
export const ADVANCED_FIREARM_MAX_INCREMENTS = 10;

/**
 * Within how many range increments a firearm resolves against touch AC: the
 * 1st for early firearms, the 5th for advanced (§2.9). Beyond that it resolves
 * normally — never "a touch attack" for feats like Deadly Aim.
 */
export const FIREARM_TOUCH_AC_INCREMENTS: Readonly<
  Record<PF1eFirearmGeneration, number>
> = {
  early: 1,
  advanced: 5,
};

/**
 * Unarmed strike damage by size. AoN Rules ID 131 verifies Small 1d2, Medium
 * **1d3** (the value this repo previously used was 1d2 — wrong, fixed with
 * this table) and Large 1d4; Tiny 1, Huge 1d6, Gargantuan 1d8 and Colossal 2d6
 * come from the SRD unarmed-strike weapon table, which Pathfinder did not
 * republish below Small or above Large. Fine and Diminutive have no published
 * unarmed row (the SRD table lists none) and fall back to the Tiny value — a
 * creature that size fights with natural attacks, not fists.
 */
export const UNARMED_STRIKE_DAMAGE_BY_SIZE: Readonly<Record<PF1eSize, string>> =
  {
    Fine: "1",
    Diminutive: "1",
    Tiny: "1",
    Small: "1d2",
    Medium: "1d3",
    Large: "1d4",
    Huge: "1d6",
    Gargantuan: "1d8",
    Colossal: "2d6",
  };

/** A double weapon's second head — its own damage line, wielded as a light off-hand. */
export interface PF1eWeaponHead {
  name?: string | undefined;
  /** Dice expression ("1d8") or flat count ("1"). */
  damageDice?: string | undefined;
  damageType?: PF1ePhysicalDamageType | undefined;
  /** Lowest roll that threatens (20 = 20 only). Carried, never inverted. */
  critThreatMin?: number | undefined;
  critMultiplier?: number | undefined;
}

/** Ammunition/reloading data for projectile and firearm weapons. */
export interface PF1eWeaponAmmo {
  /** Ammunition type label ("arrows", "bolts", "bullets and powder") — descriptive. */
  type?: string | undefined;
  /** Shots held before a reload is needed; absent ⇒ no capacity limit (bows). */
  capacity?: number | undefined;
  /** A.6 action id for reloading (e.g. "load-light-crossbow"); absent ⇒ not authored. */
  loadActionId?: string | undefined;
  /** Ammunition units spent per attack (default 1 for projectile/firearm). */
  consumedPerAttack?: number | undefined;
}

/** Everything an author may write for one weapon under `system.pf1e.weapons[]`. */
export interface PF1eWeaponAuthored extends PF1eItemWear {
  name?: string;
  class?: PF1eWeaponClass;
  firearmGeneration?: PF1eFirearmGeneration;
  handedness?: PF1eWeaponHandedness;
  proficiency?: PF1eWeaponProficiency;
  /** Dice expression ("1d8") or flat count ("1"). */
  damageDice?: string;
  damageType?: PF1ePhysicalDamageType;
  /** Damage is nonlethal (unarmed default; saps, whips). */
  nonlethal?: boolean;
  /** Lowest die roll that threatens a critical (20 = 20 only). Carried, never inverted. */
  critThreatMin?: number;
  critMultiplier?: number;
  rangeIncrementFt?: number;
  /** Enhancement bonus (+1…+5). Magic DR needs ≥ 1 (A.17). */
  enhancementBonus?: number;
  /** Special-ability bonus equivalent — counts toward `/epic` only, never the +1/+3/+4/+5 ladder (A.17). */
  specialAbilityBonus?: number;
  material?: PF1eWeaponMaterial;
  alignment?: PF1eWeaponAlignment[];
  /** Second head of a double weapon. */
  doubleHead?: PF1eWeaponHead;
  /** Natural attack — never iterates with BAB (A.2). */
  natural?: boolean;
  /** Secondary natural attack: half ability to damage (A.3), −5 on the roll (A02 applies). */
  naturalSecondary?: boolean;
  /** Unarmed strike: light, nonlethal, provokes from armed targets (AoN ID 131). */
  unarmed?: boolean;
  /** Touch attack (rays, touch spells): ignores armor, shield, natural armor (A.2). */
  touch?: boolean;
  /** Reach weapon: strikes at double natural reach, cannot strike adjacent (A.5). */
  reach?: boolean;
  trip?: boolean;
  disarm?: boolean;
  /** Splash weapon: grid-intersection targeting and scatter are A04/A.12. */
  splash?: boolean;
  ammo?: PF1eWeaponAmmo;
  /** Misfire value: a natural roll at or below it auto-misses and breaks the weapon (§2.9b). */
  misfireMinimum?: number;
}

/** One weapon, normalized and with the class-derived facts resolved. Nothing here is persisted. */
export interface PF1eWeaponDescriptor extends PF1eItemWear {
  name: string;
  class: PF1eWeaponClass;
  firearmGeneration: PF1eFirearmGeneration | null;
  handedness: PF1eWeaponHandedness;
  proficiency: PF1eWeaponProficiency;
  damageDice: string | null;
  damageType: PF1ePhysicalDamageType;
  nonlethal: boolean;
  critThreatMin: number;
  critMultiplier: number;
  rangeIncrementFt: number | null;
  /** 0 ⇒ no ranged use (melee weapons, or a ranged weapon with no increment authored). */
  maxRangeIncrements: number;
  /** Increments within which a firearm resolves vs touch AC (§2.9); null for non-firearms. */
  firearmTouchIncrements: number | null;
  enhancementBonus: number;
  specialAbilityBonus: number;
  /** Enhancement + special-ability equivalents — the `/epic` comparison value (A.17). */
  effectiveBonusTotal: number;
  material: PF1eWeaponMaterial;
  alignment: PF1eWeaponAlignment[];
  doubleHead: PF1eWeaponHead | null;
  natural: boolean;
  naturalSecondary: boolean;
  unarmed: boolean;
  touch: boolean;
  reach: boolean;
  trip: boolean;
  disarm: boolean;
  splash: boolean;
  ammo: PF1eWeaponAmmo | null;
  /** Authored misfire value + 4 while broken (§2.9b); 0 ⇒ never misfires. */
  misfireValue: number;
  broken: boolean;
}

export interface PF1eWeaponResolution {
  /** True when `raw` was a record with no unusable field (issues may still carry notes). */
  ok: boolean;
  weapon: PF1eWeaponDescriptor;
  issues: string[];
}

const WEAPON_CLASSES: readonly PF1eWeaponClass[] = [
  "melee",
  "thrown",
  "projectile",
  "firearm",
];
const HANDS: readonly PF1eWeaponHandedness[] = [
  "light",
  "one-handed",
  "two-handed",
];
const PROFICIENCIES: readonly PF1eWeaponProficiency[] = [
  "simple",
  "martial",
  "exotic",
];
const DAMAGE_TYPES: readonly PF1ePhysicalDamageType[] = [
  "slashing",
  "piercing",
  "bludgeoning",
];
const MATERIALS: readonly PF1eWeaponMaterial[] = [
  "none",
  "cold iron",
  "silver",
  "adamantine",
];
const ALIGNMENTS: readonly PF1eWeaponAlignment[] = [
  "good",
  "evil",
  "lawful",
  "chaotic",
];

const DICE_PATTERN = /^\d+(d\d+)?$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickEnum<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
  issues: string[],
  where: string,
): T {
  const v = raw[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string" && (values as readonly string[]).includes(v))
    return v as T;
  issues.push(
    `${where}.${key} = ${String(v)} is not one of ${values.join(" | ")} — defaulted to "${fallback}"`,
  );
  return fallback;
}

function readNonNegativeNumber(
  raw: Record<string, unknown>,
  key: string,
  issues: string[],
  where: string,
): number | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) {
    issues.push(
      `${where}.${key} = ${String(v)} is not a non-negative number — ignored`,
    );
    return null;
  }
  return n;
}

function readDice(
  raw: Record<string, unknown>,
  key: string,
  issues: string[],
  where: string,
): string | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v === "string" && DICE_PATTERN.test(v.trim())) return v.trim();
  issues.push(
    `${where}.${key} = ${String(v)} is not a dice expression like "1d8" or "1" — ignored`,
  );
  return null;
}

function readHead(
  raw: Record<string, unknown>,
  key: string,
  issues: string[],
  where: string,
): PF1eWeaponHead | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) {
    issues.push(`${where}.${key} is not an object — ignored`);
    return null;
  }
  const headWhere = `${where}.${key}`;
  const damageDice = readDice(v, "damageDice", issues, headWhere);
  const critThreatMin = readNonNegativeNumber(
    v,
    "critThreatMin",
    issues,
    headWhere,
  );
  if (critThreatMin !== null && (critThreatMin < 1 || critThreatMin > 20)) {
    issues.push(
      `${headWhere}.critThreatMin = ${critThreatMin} is outside 1–20 — kept, caller treats 20 as the only face`,
    );
  }
  const critMultiplier = readNonNegativeNumber(
    v,
    "critMultiplier",
    issues,
    headWhere,
  );
  if (critMultiplier !== null && critMultiplier < 2) {
    issues.push(
      `${headWhere}.critMultiplier = ${critMultiplier} is below 2 — clamped to 2`,
    );
  }
  const damageType = pickEnum(
    v,
    "damageType",
    DAMAGE_TYPES,
    "bludgeoning",
    issues,
    headWhere,
  );
  return {
    name:
      typeof v.name === "string" && v.name.trim() !== ""
        ? v.name.trim()
        : undefined,
    damageDice: damageDice ?? undefined,
    damageType:
      damageDice === null && v.damageType === undefined
        ? undefined
        : damageType,
    critThreatMin: critThreatMin ?? undefined,
    critMultiplier:
      critMultiplier === null ? undefined : Math.max(2, critMultiplier),
  };
}

function readAmmo(
  raw: Record<string, unknown>,
  issues: string[],
  where: string,
): PF1eWeaponAmmo | null {
  const v = raw.ammo;
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) {
    issues.push(`${where}.ammo is not an object — ignored`);
    return null;
  }
  const ammoWhere = `${where}.ammo`;
  const capacity = readNonNegativeNumber(v, "capacity", issues, ammoWhere);
  const consumedPerAttack = readNonNegativeNumber(
    v,
    "consumedPerAttack",
    issues,
    ammoWhere,
  );
  return {
    type:
      typeof v.type === "string" && v.type.trim() !== ""
        ? v.type.trim()
        : undefined,
    capacity: capacity ?? undefined,
    loadActionId:
      typeof v.loadActionId === "string" && v.loadActionId.trim() !== ""
        ? v.loadActionId.trim()
        : undefined,
    consumedPerAttack: consumedPerAttack ?? undefined,
  };
}

/**
 * Total weapon validator: garbage in ⇒ a usable unarmed-strike-shaped fallback
 * out, every malformed field named in `issues` (the `derivePF1eActor`
 * convention — never throw, never guess). Out-of-range critical values are
 * **kept** with an issue, matching `derivePF1eActor`'s attack-line policy.
 */
export function resolvePF1eWeapon(raw: unknown): PF1eWeaponResolution {
  const issues: string[] = [];
  if (!isRecord(raw)) {
    return {
      ok: false,
      weapon: unarmedStrikeWeapon("Medium"),
      issues: ["weapon: not an object — unarmed-strike fallback returned"],
    };
  }
  const where = "weapon";
  const name =
    typeof raw.name === "string" && raw.name.trim() !== ""
      ? raw.name.trim()
      : null;
  const unarmed = raw.unarmed === true;
  const weaponClass = pickEnum(
    raw,
    "class",
    WEAPON_CLASSES,
    "melee",
    issues,
    where,
  );
  const natural = raw.natural === true || raw.naturalSecondary === true;
  const naturalSecondary = raw.naturalSecondary === true;
  const handedness = pickEnum(
    raw,
    "handedness",
    HANDS,
    unarmed ? "light" : "one-handed",
    issues,
    where,
  );
  const proficiency = pickEnum(
    raw,
    "proficiency",
    PROFICIENCIES,
    unarmed ? "simple" : "martial",
    issues,
    where,
  );
  const damageType = pickEnum(
    raw,
    "damageType",
    DAMAGE_TYPES,
    unarmed ? "bludgeoning" : weaponClass === "melee" ? "slashing" : "piercing",
    issues,
    where,
  );

  let firearmGeneration: PF1eFirearmGeneration | null = null;
  if (weaponClass === "firearm") {
    firearmGeneration = pickEnum(
      raw,
      "firearmGeneration",
      ["early", "advanced"] as const as readonly PF1eFirearmGeneration[],
      "early",
      issues,
      where,
    );
  } else if (raw.firearmGeneration !== undefined) {
    issues.push(
      `${where}.firearmGeneration is authored on a non-firearm weapon — ignored`,
    );
  }

  const damageDice = readDice(raw, "damageDice", issues, where);
  const critThreatMin = readNonNegativeNumber(
    raw,
    "critThreatMin",
    issues,
    where,
  );
  if (
    raw.critThreatMin !== undefined &&
    (critThreatMin === null || critThreatMin < 1 || critThreatMin > 20)
  ) {
    issues.push(
      `${where}.critThreatMin = ${String(raw.critThreatMin)} is outside 1–20 — kept, caller treats 20 as the only face`,
    );
  }
  const critMultiplier = readNonNegativeNumber(
    raw,
    "critMultiplier",
    issues,
    where,
  );
  if (
    raw.critMultiplier !== undefined &&
    (critMultiplier === null || critMultiplier < 2)
  ) {
    issues.push(
      `${where}.critMultiplier = ${String(raw.critMultiplier)} is below 2 — clamped to 2`,
    );
  }

  const rangeIncrementFt = readNonNegativeNumber(
    raw,
    "rangeIncrementFt",
    issues,
    where,
  );
  let maxRangeIncrements = MAX_RANGE_INCREMENTS[weaponClass];
  if (weaponClass === "firearm" && firearmGeneration === "advanced") {
    maxRangeIncrements = ADVANCED_FIREARM_MAX_INCREMENTS;
  }
  if (rangeIncrementFt === null || rangeIncrementFt === 0) {
    if (weaponClass !== "melee") {
      issues.push(
        `${where}: ${weaponClass} weapon without a positive rangeIncrementFt — no ranged use`,
      );
      maxRangeIncrements = 0;
    }
  } else if (weaponClass === "melee") {
    issues.push(
      `${where}.rangeIncrementFt on a melee weapon — carried for display, melee has no range increments`,
    );
  }

  const enhancementBonus =
    readNonNegativeNumber(raw, "enhancementBonus", issues, where) ?? 0;
  const specialAbilityBonus =
    readNonNegativeNumber(raw, "specialAbilityBonus", issues, where) ?? 0;
  const material = pickEnum(raw, "material", MATERIALS, "none", issues, where);
  const alignment: PF1eWeaponAlignment[] = Array.isArray(raw.alignment)
    ? raw.alignment.filter(
        (a): a is PF1eWeaponAlignment =>
          typeof a === "string" &&
          (ALIGNMENTS as readonly string[]).includes(a),
      )
    : [];
  if (raw.alignment !== undefined && !Array.isArray(raw.alignment)) {
    issues.push(`${where}.alignment is not an array — ignored`);
  } else if (
    Array.isArray(raw.alignment) &&
    alignment.length !== raw.alignment.length
  ) {
    issues.push(
      `${where}.alignment holds unknown components — they were dropped (known: ${ALIGNMENTS.join(" | ")})`,
    );
  }

  const doubleHead = readHead(raw, "doubleHead", issues, where);
  if (doubleHead !== null && handedness !== "two-handed") {
    issues.push(
      `${where}.doubleHead on a ${handedness} weapon — double weapons are two-handed; head carried`,
    );
  }
  const ammo = readAmmo(raw, issues, where);
  if (
    ammo !== null &&
    weaponClass !== "projectile" &&
    weaponClass !== "firearm"
  ) {
    issues.push(
      `${where}.ammo on a ${weaponClass} weapon — ammunition data is consumed by projectile/firearm paths`,
    );
  }

  const misfireMinimum =
    readNonNegativeNumber(raw, "misfireMinimum", issues, where) ?? 0;
  if (
    raw.misfireMinimum !== undefined &&
    (misfireMinimum === 0 || misfireMinimum > 20)
  ) {
    issues.push(
      `${where}.misfireMinimum = ${String(raw.misfireMinimum)} is outside 1–20 — treated as never misfiring`,
    );
  }
  const itemHp = readNonNegativeNumber(raw, "itemHp", issues, where);
  const itemHardness = readNonNegativeNumber(
    raw,
    "itemHardness",
    issues,
    where,
  );
  const broken = raw.broken === true;
  if (raw.broken !== undefined && typeof raw.broken !== "boolean") {
    issues.push(
      `${where}.broken = ${String(raw.broken)} is not a boolean — ignored`,
    );
  }
  if (broken && misfireMinimum > 0) {
    // §2.9b: a broken weapon's misfire value rises +4. The check gates on d20 !== 20
    // (no misfire on a natural 20) — that ordering belongs to the attack resolver (A02).
    issues.push(
      `${where}: broken raises the misfire value from ${misfireMinimum} to ${misfireMinimum + 4} (§2.9b)`,
    );
  }

  return {
    ok: issues.length === 0,
    weapon: {
      name: name ?? (unarmed ? "Unarmed strike" : "Weapon"),
      class: weaponClass,
      firearmGeneration,
      handedness,
      proficiency,
      damageDice,
      damageType,
      nonlethal: raw.nonlethal === true || (unarmed && raw.nonlethal !== false),
      critThreatMin: critThreatMin ?? 20,
      critMultiplier: Math.max(2, critMultiplier ?? 2),
      rangeIncrementFt: rangeIncrementFt === 0 ? null : rangeIncrementFt,
      maxRangeIncrements,
      firearmTouchIncrements:
        weaponClass === "firearm" && firearmGeneration !== null
          ? FIREARM_TOUCH_AC_INCREMENTS[firearmGeneration]
          : null,
      enhancementBonus,
      specialAbilityBonus,
      effectiveBonusTotal: enhancementBonus + specialAbilityBonus,
      material,
      alignment,
      doubleHead,
      natural,
      naturalSecondary,
      unarmed,
      touch: raw.touch === true,
      reach: raw.reach === true,
      trip: raw.trip === true,
      disarm: raw.disarm === true,
      splash: raw.splash === true,
      ammo,
      misfireValue:
        misfireMinimum > 0 && broken ? misfireMinimum + 4 : misfireMinimum,
      broken,
      itemHp: itemHp ?? undefined,
      itemHardness: itemHardness ?? undefined,
    },
    issues,
  };
}

/**
 * The unarmed strike as a weapon (AoN Rules ID 131): a **light** weapon,
 * bludgeoning, all damage **nonlethal**, ×2 critical on a 20 only, no reach.
 * The −4 to deal lethal damage and the provoke rule are attack-time decisions
 * (A02), not weapon data. Damage dice follow `UNARMED_STRIKE_DAMAGE_BY_SIZE`.
 */
export function unarmedStrikeWeapon(
  size: string | PF1eSize,
): PF1eWeaponDescriptor {
  const normalized = normalizeSize(size) ?? "Medium";
  const resolved = resolvePF1eWeapon({
    name: "Unarmed strike",
    unarmed: true,
    class: "melee",
    handedness: "light",
    proficiency: "simple",
    damageDice: UNARMED_STRIKE_DAMAGE_BY_SIZE[normalized],
    damageType: "bludgeoning",
    nonlethal: true,
    critThreatMin: 20,
    critMultiplier: 2,
  });
  // Total by construction; the only issue path is an author-supplied field,
  // which this helper does not supply.
  return resolved.weapon;
}

/**
 * Broken-weapon adjustments (AoN Rules ID 413): −2 on attack **and** damage
 * rolls, a critical hit only on a natural 20, and only ×2 damage on a
 * confirmed critical — the weapon's authored threat range and multiplier do
 * not survive the condition.
 */
export function brokenWeaponAdjustments(
  weapon: Pick<
    PF1eWeaponDescriptor,
    "critMultiplier" | "critThreatMin" | "broken"
  >,
): {
  attack: number;
  damage: number;
  critThreatMin: number;
  critMultiplier: number;
} {
  if (weapon.broken !== true) {
    return {
      attack: 0,
      damage: 0,
      critThreatMin: weapon.critThreatMin,
      critMultiplier: weapon.critMultiplier,
    };
  }
  return { attack: -2, damage: -2, critThreatMin: 20, critMultiplier: 2 };
}
