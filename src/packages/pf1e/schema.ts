/**
 * PF1e Schema definition, Bitfield Conditions, and Unit Profile compilation.
 */
import type { SysSchema } from "../../sim/pool";

/**
 * Pool columns the PF1e rules module owns (§12 modelColumns). Every column here MUST be
 * mirrored in `systems/pf1e-mass-battles/manifest.json` — the host builds the deploy schema
 * from the manifest (`src/app/hostBoot.ts`), not from this object, so a column that only
 * exists here is silently dropped from the pool, the diff, and the replica.
 * `tests/packages/pf1eManifest.test.ts` enforces the equality.
 */
export const PF1E_MODEL_SCHEMA: SysSchema = {
  /** 10 + armor + shield + Dex + natural + size + misc (Combat Statistics > Armor Class). */
  ac: "u8",
  /** 10 + Dex + size + misc + deflection — armor, shield and natural armor excluded. */
  touchAc: "u8",
  /** 10 + armor + shield + natural + size + misc — Dexterity and dodge bonuses excluded. */
  flatFootedAc: "u8",
  fort: "i8",
  ref: "i8",
  will: "i8",
  sr: "u8",
  drType: "u8",
  drVal: "u8",
  profileIdx: "u16",
  lethalDmg: "u16",
  /**
   * Nonlethal damage dealt (SRD: "Minimum Damage" — penalties that reduce a damage
   * result below 1 deal 1 point of *nonlethal* damage instead, and nonlethal damage
   * accumulates separately from hit points).
   */
  nonlethal: "u16",
  aooUsed: "u8",
};

/** PF1e Condition Bitfield Flags */
export const PF1eCondition = {
  DEAD: 1 << 0,
  DISRUPTED: 1 << 1,
  FLANKED: 1 << 2,
  GRAPPLED: 1 << 3,
  PRONE: 1 << 4,
  SHAKEN: 1 << 5,
  SICKENED: 1 << 6,
  STUNNED: 1 << 7,
  BLINDED: 1 << 8,
  MISFIRED: 1 << 9,
  BROKEN: 1 << 10,
  /**
   * Unconscious from nonlethal damage (SRD: Injury and Death > Dealing Nonlethal
   * Damage). Deliberately above bit 4 so it cannot alias a `ModelStatus` flag —
   * see PF1e_Combat_Fidelity_GapList.md §2.13 for the bits that still collide.
   */
  UNCONSCIOUS: 1 << 11,
} as const;

/** DR Type Bitfield Flags for Material/Type Bypass */
export const PF1eDrType = {
  NONE: 0,
  MAGIC: 1 << 0,
  COLD_IRON: 1 << 1,
  SILVER: 1 << 2,
  ADAMANTINE: 1 << 3,
  SLASHING: 1 << 4,
  PIERCING: 1 << 5,
  BLUDGEONING: 1 << 6,
  ALIGNMENT: 1 << 7,
} as const;

/** Damage Type Bitfield Flags for Regeneration Suppression */
export const PF1eDamageType = {
  NONE: 0,
  PHYSICAL: 1 << 0,
  FIRE: 1 << 1,
  ACID: 1 << 2,
  COLD: 1 << 3,
  ELECTRICITY: 1 << 4,
} as const;

export interface RawPF1eProfile {
  name?: string;
  bab?: number;
  strMod?: number;
  dexMod?: number;
  conMod?: number;
  intMod?: number;
  wisMod?: number;
  chaMod?: number;
  sizeMod?: number;
  ac?: number;
  touchAc?: number;
  /** Flat-footed AC; derived from the breakdown below (or from `ac`) when omitted. */
  flatFootedAc?: number;
  /** Armor Check-removed AC composition — when present, `ac`/`touchAc`/`flatFootedAc` derive from it. */
  armorBonus?: number;
  shieldBonus?: number;
  naturalArmor?: number;
  dodgeBonus?: number;
  miscAc?: number;
  /** Hit points per model at this profile (mass battles deploy with hp 1 placeholders). */
  hp?: number;
  cmd?: number;
  cmb?: number;
  fort?: number;
  ref?: number;
  will?: number;
  casterLevel?: number;
  castingStatMod?: number;
  spellPenetration?: number;
  maxAoos?: number;
  fastHealingVal?: number;
  regenerationVal?: number;
  regenerationSuppressFlags?: number;
  hasTrample?: boolean;
  trampleDc?: number;
  trampleDamageDiceCount?: number;
  trampleDamageDiceSides?: number;
  weapon?: {
    damageDiceCount?: number;
    damageDiceSides?: number;
    damageMod?: number;
    critThreatMin?: number;
    critMultiplier?: number;
    isFirearm?: boolean;
    isEarlyFirearm?: boolean;
    misfireMin?: number;
    rangeIncrement?: number;
    enhancementBonus?: number;
    material?: "cold_iron" | "silver" | "adamantine" | "none";
    damageType?: "slashing" | "piercing" | "bludgeoning";
    elementalType?: number; // PF1eDamageType flag
    isMagic?: boolean;
  };
  dr?: {
    typeFlags?: number;
    val?: number;
  };
  sr?: number;
}

export interface PF1eUnitProfile {
  id: number;
  name: string;
  bab: number;
  strMod: number;
  dexMod: number;
  conMod: number;
  sizeMod: number;
  iteratives: number[];
  damageDiceCount: number;
  damageDiceSides: number;
  damageMod: number;
  critThreatMin: number;
  critMultiplier: number;
  isFirearm: boolean;
  isEarlyFirearm: boolean;
  misfireMin: number;
  rangeIncrement: number;
  enhancementBonus: number;
  material: "cold_iron" | "silver" | "adamantine" | "none";
  damageType: "slashing" | "piercing" | "bludgeoning";
  elementalType: number;
  isMagic: boolean;
  drTypeFlags: number;
  drVal: number;
  sr: number;
  ac: number;
  touchAc: number;
  flatFootedAc: number;
  hp: number;
  cmd: number;
  cmb: number;
  fort: number;
  ref: number;
  will: number;
  casterLevel: number;
  castingStatMod: number;
  spellPenetration: number;
  maxAoos: number;
  fastHealingVal: number;
  regenerationVal: number;
  regenerationSuppressFlags: number;
  hasTrample: boolean;
  trampleDc: number;
  trampleDamageDiceCount: number;
  trampleDamageDiceSides: number;
}

export function compilePF1eProfile(id: number, raw: RawPF1eProfile): PF1eUnitProfile {
  const bab = raw.bab ?? 1;
  const strMod = raw.strMod ?? 0;
  const dexMod = raw.dexMod ?? 0;
  const conMod = raw.conMod ?? 2;
  const sizeMod = raw.sizeMod ?? 0;
  
  // Calculate iterative attack bonuses (e.g. BAB 11 -> [11, 6, 1])
  const iteratives: number[] = [];
  let currentBab = bab;
  while (currentBab > 0) {
    iteratives.push(currentBab + strMod);
    currentBab -= 5;
  }
  if (iteratives.length === 0) iteratives.push(strMod);

  const calculatedCmb = raw.cmb ?? (bab + strMod + sizeMod);
  const calculatedCmd = raw.cmd ?? (10 + bab + strMod + dexMod + sizeMod);

  // --- Armor Class composition (SRD: Combat Statistics > Armor Class) ---------------
  // With an equipment breakdown all three ACs are derived so they can never disagree;
  // without one, the caller's typed values win and flat-footed falls back to `ac` minus
  // the Dexterity/dodge bonuses it must exclude.
  const armorBonus = raw.armorBonus ?? 0;
  const shieldBonus = raw.shieldBonus ?? 0;
  const naturalArmor = raw.naturalArmor ?? 0;
  const dodgeBonus = raw.dodgeBonus ?? 0;
  const miscAc = raw.miscAc ?? 0;
  const hasBreakdown =
    raw.armorBonus !== undefined ||
    raw.shieldBonus !== undefined ||
    raw.naturalArmor !== undefined ||
    raw.miscAc !== undefined;
  const calculatedAc =
    raw.ac ?? (hasBreakdown ? 10 + armorBonus + shieldBonus + naturalArmor + sizeMod + dexMod + dodgeBonus + miscAc : 10 + sizeMod + dexMod);
  // Touch AC: no armor, no shield, no natural armor.
  const calculatedTouchAc = raw.touchAc ?? (hasBreakdown ? 10 + sizeMod + dexMod + dodgeBonus + miscAc : 10 + sizeMod + dexMod);
  // Flat-footed AC: armor/shield/natural/size/misc only — Dexterity and dodge are lost.
  const calculatedFlatFootedAc =
    raw.flatFootedAc ??
    (hasBreakdown
      ? 10 + armorBonus + shieldBonus + naturalArmor + sizeMod + miscAc
      : Math.max(10, calculatedAc - dexMod - dodgeBonus));

  return {
    id,
    name: raw.name ?? "PF1e Unit",
    bab,
    strMod,
    dexMod,
    conMod,
    sizeMod,
    iteratives,
    damageDiceCount: raw.weapon?.damageDiceCount ?? 1,
    damageDiceSides: raw.weapon?.damageDiceSides ?? 6,
    damageMod: (raw.weapon?.damageMod ?? 0) + strMod,
    critThreatMin: raw.weapon?.critThreatMin ?? 20,
    critMultiplier: raw.weapon?.critMultiplier ?? 2,
    isFirearm: raw.weapon?.isFirearm ?? false,
    isEarlyFirearm: raw.weapon?.isEarlyFirearm ?? true,
    misfireMin: raw.weapon?.misfireMin ?? (raw.weapon?.isFirearm ? 1 : 0),
    rangeIncrement: raw.weapon?.rangeIncrement ?? (raw.weapon?.isFirearm ? 20 : 5),
    enhancementBonus: raw.weapon?.enhancementBonus ?? 0,
    material: raw.weapon?.material ?? "none",
    damageType: raw.weapon?.damageType ?? "slashing",
    elementalType: raw.weapon?.elementalType ?? PF1eDamageType.NONE,
    isMagic: raw.weapon?.isMagic ?? ((raw.weapon?.enhancementBonus ?? 0) > 0),
    drTypeFlags: raw.dr?.typeFlags ?? PF1eDrType.NONE,
    drVal: raw.dr?.val ?? 0,
    sr: raw.sr ?? 0,
    ac: calculatedAc,
    touchAc: calculatedTouchAc,
    flatFootedAc: calculatedFlatFootedAc,
    hp: raw.hp ?? 10,
    cmd: calculatedCmd,
    cmb: calculatedCmb,
    fort: raw.fort ?? 0,
    ref: raw.ref ?? 0,
    will: raw.will ?? 0,
    casterLevel: raw.casterLevel ?? 1,
    castingStatMod: raw.castingStatMod ?? 3,
    spellPenetration: raw.spellPenetration ?? 0,
    // D-183: the Normal line of the Combat Reflexes entry — "A character without this
    // feat can make only one attack of opportunity per round" (CRB p.119, AoN 102 for the
    // base rule). The old default was `1 + max(0, dexMod)`, which granted a second
    // opportunity for having a positive Dexterity bonus and ignored the feat entirely
    // (Gap List A.10's note). Authored profile data still wins, so a strategic unit that
    // *is* the feat's owner authors its budget (see `rawProfileFromUnit`).
    maxAoos: raw.maxAoos ?? 1,
    fastHealingVal: raw.fastHealingVal ?? 0,
    regenerationVal: raw.regenerationVal ?? 0,
    regenerationSuppressFlags: raw.regenerationSuppressFlags ?? (PF1eDamageType.FIRE | PF1eDamageType.ACID),
    hasTrample: raw.hasTrample ?? false,
    trampleDc: raw.trampleDc ?? (10 + Math.floor(bab / 2) + strMod),
    trampleDamageDiceCount: raw.trampleDamageDiceCount ?? 1,
    trampleDamageDiceSides: raw.trampleDamageDiceSides ?? 8,
  };
}

/**
 * Canonical, order-independent key for a profile. Two profiles that will compile to the
 * same numbers must produce the same key, so equal units share one registry slot.
 */
export function pf1eProfileKey(raw: RawPF1eProfile): string {
  const keys = Object.keys(raw)
    .filter((k) => k !== "name")
    .sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = (raw as unknown as Record<string, unknown>)[k];
    if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
      parts.push(`${k}=${String(v)}`);
    } else {
      const inner = Object.keys(v as object)
        .sort()
        .map((ik) => `${ik}=${String((v as Record<string, unknown>)[ik])}`)
        .join(",");
      parts.push(`${k}{${inner}}`);
    }
  }
  return parts.join("|");
}

/**
 * Profile table shared by the sim and (later) the tactical sheet.
 *
 * Ids are **content-addressed within a build pass** (`internAll`), which makes them a pure
 * function of the unit set: rebuilding the table from the same units in the same order —
 * in another turn, another process, or after a SimWorker restart — yields the same ids, so
 * a `profileIdx` written into the pool stays valid. The previous `nextId++`-per-`register()`
 * design gave every turn fresh ids while the pool kept pointing at the old ones, which is
 * how a deployed battle ended up resolving zero attacks
 * (PF1e_Combat_Fidelity_GapList.md §1.3/§1.4).
 */
export class PF1eProfileRegistry {
  private profiles = new Map<number, PF1eUnitProfile>();
  private ids = new Map<string, number>();
  private nextId = 1;

  /**
   * Rebuild the table deterministically from `raws`, de-duplicating identical profiles.
   * Ids are assigned in input order (1-based); the caller is responsible for passing a
   * deterministically ordered list.
   */
  internAll(raws: readonly RawPF1eProfile[]): PF1eUnitProfile[] {
    this.profiles.clear();
    this.ids.clear();
    this.nextId = 1;
    return raws.map((raw) => this.intern(raw));
  }

  /** Intern one profile, reusing the id of an identical one when it is already present. */
  intern(raw: RawPF1eProfile): PF1eUnitProfile {
    const key = pf1eProfileKey(raw);
    const existingId = this.ids.get(key);
    if (existingId !== undefined) {
      const existing = this.profiles.get(existingId);
      if (existing) return existing;
    }
    const id = this.nextId++;
    const compiled = compilePF1eProfile(id, raw);
    this.profiles.set(id, compiled);
    this.ids.set(key, id);
    return compiled;
  }

  /**
   * Always allocate a fresh id, even for a profile identical to one already registered.
   * Kept for tests/fixtures that need distinct handles for identical stat lines; production
   * paths use `internAll`/`intern`.
   */
  register(raw: RawPF1eProfile): PF1eUnitProfile {
    const id = this.nextId++;
    const compiled = compilePF1eProfile(id, raw);
    this.profiles.set(id, compiled);
    this.ids.set(pf1eProfileKey(raw), this.ids.get(pf1eProfileKey(raw)) ?? id);
    return compiled;
  }

  get(id: number): PF1eUnitProfile | undefined {
    return this.profiles.get(id);
  }

  /** Look up by content (used by the parity/inspection helpers). */
  idOf(raw: RawPF1eProfile): number | undefined {
    return this.ids.get(pf1eProfileKey(raw));
  }

  get size(): number {
    return this.profiles.size;
  }

  clear(): void {
    this.profiles.clear();
    this.ids.clear();
    this.nextId = 1;
  }
}

/** Precreated PF1e Unit Profile Templates */
export const PRECREATED_PF1E_UNITS: Record<string, RawPF1eProfile> = {
  infantry: {
    name: "Heavy Infantry",
    bab: 6,
    strMod: 3,
    ac: 16,
    touchAc: 11,
    weapon: { damageDiceCount: 1, damageDiceSides: 8, damageMod: 3 },
  },
  cavalry: {
    name: "Heavy Cavalry",
    bab: 8,
    strMod: 4,
    sizeMod: 1,
    ac: 18,
    touchAc: 11,
    hasTrample: true,
    trampleDamageDiceCount: 2,
    trampleDamageDiceSides: 6,
    dr: { typeFlags: PF1eDrType.SLASHING, val: 2 },
    weapon: { damageDiceCount: 1, damageDiceSides: 8, damageMod: 4 },
  },
  artillery: {
    name: "Siege Bombard",
    bab: 4,
    strMod: 1,
    ac: 12,
    touchAc: 8,
    weapon: { damageDiceCount: 3, damageDiceSides: 6, rangeIncrement: 100 },
  },
  hero: {
    name: "Paladin Hero",
    bab: 11,
    strMod: 5,
    ac: 20,
    touchAc: 12,
    dr: { typeFlags: PF1eDrType.MAGIC, val: 5 },
    weapon: { enhancementBonus: 2, damageDiceCount: 1, damageDiceSides: 10, critThreatMin: 19, critMultiplier: 2 },
  },
  troll: {
    name: "Troll Vanguard",
    bab: 6,
    strMod: 6,
    conMod: 4,
    sizeMod: 1,
    ac: 16,
    touchAc: 10,
    regenerationVal: 5,
    regenerationSuppressFlags: PF1eDamageType.FIRE | PF1eDamageType.ACID,
    weapon: { damageDiceCount: 1, damageDiceSides: 8, damageMod: 6 },
  },
  golem: {
    name: "Clay Golem",
    bab: 9,
    strMod: 7,
    sizeMod: 1,
    ac: 22,
    touchAc: 9,
    dr: { typeFlags: PF1eDrType.ADAMANTINE, val: 10 },
    sr: 25,
    fastHealingVal: 0,
    weapon: { damageDiceCount: 2, damageDiceSides: 10, damageMod: 7 },
  },
};
