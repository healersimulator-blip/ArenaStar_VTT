/**
 * PF1e Schema definition, Bitfield Conditions, and Unit Profile compilation.
 */
import type { SysSchema } from "../../sim/pool";

export const PF1E_MODEL_SCHEMA: SysSchema = {
  ac: "u8",
  touchAc: "u8",
  fort: "i8",
  ref: "i8",
  will: "i8",
  sr: "u8",
  drType: "u8",
  drVal: "u8",
  profileIdx: "u16",
  lethalDmg: "u16",
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
    ac: raw.ac ?? 10,
    touchAc: raw.touchAc ?? 10,
    cmd: calculatedCmd,
    cmb: calculatedCmb,
    fort: raw.fort ?? 0,
    ref: raw.ref ?? 0,
    will: raw.will ?? 0,
    casterLevel: raw.casterLevel ?? 1,
    castingStatMod: raw.castingStatMod ?? 3,
    spellPenetration: raw.spellPenetration ?? 0,
    maxAoos: raw.maxAoos ?? (1 + Math.max(0, dexMod)),
    fastHealingVal: raw.fastHealingVal ?? 0,
    regenerationVal: raw.regenerationVal ?? 0,
    regenerationSuppressFlags: raw.regenerationSuppressFlags ?? (PF1eDamageType.FIRE | PF1eDamageType.ACID),
    hasTrample: raw.hasTrample ?? false,
    trampleDc: raw.trampleDc ?? (10 + Math.floor(bab / 2) + strMod),
    trampleDamageDiceCount: raw.trampleDamageDiceCount ?? 1,
    trampleDamageDiceSides: raw.trampleDamageDiceSides ?? 8,
  };
}

export class PF1eProfileRegistry {
  private profiles = new Map<number, PF1eUnitProfile>();
  private nextId = 1;

  register(raw: RawPF1eProfile): PF1eUnitProfile {
    const id = this.nextId++;
    const compiled = compilePF1eProfile(id, raw);
    this.profiles.set(id, compiled);
    return compiled;
  }

  get(id: number): PF1eUnitProfile | undefined {
    return this.profiles.get(id);
  }

  clear(): void {
    this.profiles.clear();
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
