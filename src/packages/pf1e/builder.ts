/**
 * PF1e Character Builder & Leveling System (G-02 / T2, T4).
 *
 * Rules & Tables:
 * - Point Buy & Standard Array (CRB p.15-16, Table 1-1: Ability Score Costs)
 * - Races & Racial Ability Adjustments (CRB p.21-27)
 * - Core Classes base statistics: HD, BAB progression, good saves, skill points per level, class skills (CRB p.30-67)
 * - Level-up & XP progression (CRB p.30, Table 3-1: Character Advancement and Level-Dependent Rewards)
 * - Multiclassing progression aggregation (T2)
 */

import { babAtLevel, saveBonusAtLevel, type PF1eBabProgression } from "./rulesTables";
import type { PF1eAbilityKey } from "./actor";
import type { PF1eSkillId } from "./skills";

/** Point buy cost table for ability scores 7 to 18 (CRB Table 1-1). */
export const PF1E_POINT_BUY_COSTS: Readonly<Record<number, number>> = Object.freeze({
  7: -4,
  8: -2,
  9: -1,
  10: 0,
  11: 1,
  12: 2,
  13: 3,
  14: 5,
  15: 7,
  16: 10,
  17: 13,
  18: 17,
});

/** Standard campaign budget tiers for point buy. */
export const PF1E_POINT_BUY_TIERS = [
  { id: "low", label: "Low Fantasy (10 pts)", points: 10 },
  { id: "standard", label: "Standard Fantasy (15 pts)", points: 15 },
  { id: "high", label: "High Fantasy (20 pts)", points: 20 },
  { id: "epic", label: "Epic Fantasy (25 pts)", points: 25 },
] as const;

/** Standard array values: [15, 14, 13, 12, 10, 8] (CRB p.16). */
export const PF1E_STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;

/** Calculates total points spent given 6 ability scores. */
export function calculatePointBuyTotal(scores: Record<PF1eAbilityKey, number>): number {
  let total = 0;
  for (const key of ["str", "dex", "con", "int", "wis", "cha"] as const) {
    const score = scores[key] ?? 10;
    const cost = PF1E_POINT_BUY_COSTS[score];
    if (cost === undefined) {
      // extrapolate or clamp
      if (score < 7) total += -4 - (7 - score);
      else total += 17 + (score - 18) * 4;
    } else {
      total += cost;
    }
  }
  return total;
}

export interface PF1eRaceDefinition {
  readonly id: string;
  readonly name: string;
  readonly size: "Medium" | "Small";
  readonly speedFt: number;
  readonly abilityMods: Partial<Record<PF1eAbilityKey, number>>;
  readonly flexibleAbilityBonus?: boolean; // +2 to any one ability (Human, Half-Elf, Half-Orc)
  readonly racialTraits: readonly string[];
}

export const PF1E_CORE_RACES: readonly PF1eRaceDefinition[] = [
  {
    id: "human",
    name: "Human",
    size: "Medium",
    speedFt: 30,
    abilityMods: {},
    flexibleAbilityBonus: true,
    racialTraits: ["Bonus Feat", "Skilled (+1 skill rank per level)"],
  },
  {
    id: "elf",
    name: "Elf",
    size: "Medium",
    speedFt: 30,
    abilityMods: { dex: 2, con: -2, int: 2 },
    racialTraits: ["Low-Light Vision", "Elven Immunities", "Elven Magic", "Keen Senses"],
  },
  {
    id: "dwarf",
    name: "Dwarf",
    size: "Medium",
    speedFt: 20,
    abilityMods: { con: 2, wis: 2, cha: -2 },
    racialTraits: ["Darkvision 60 ft.", "Defensive Training", "Hardy", "Stability", "Stonecunning"],
  },
  {
    id: "halfling",
    name: "Halfling",
    size: "Small",
    speedFt: 20,
    abilityMods: { dex: 2, cha: 2, str: -2 },
    racialTraits: ["Fearless", "Halfling Luck", "Keen Senses", "Sure-Footed"],
  },
  {
    id: "gnome",
    name: "Gnome",
    size: "Small",
    speedFt: 20,
    abilityMods: { con: 2, cha: 2, str: -2 },
    racialTraits: ["Low-Light Vision", "Defensive Training", "Gnome Magic", "Illusion Resistance", "Keen Senses"],
  },
  {
    id: "half-elf",
    name: "Half-Elf",
    size: "Medium",
    speedFt: 30,
    abilityMods: {},
    flexibleAbilityBonus: true,
    racialTraits: ["Low-Light Vision", "Adaptability (Skill Focus)", "Elf Blood", "Elven Immunities", "Keen Senses"],
  },
  {
    id: "half-orc",
    name: "Half-Orc",
    size: "Medium",
    speedFt: 30,
    abilityMods: {},
    flexibleAbilityBonus: true,
    racialTraits: ["Darkvision 60 ft.", "Intimidating", "Orc Blood", "Orc Ferocity", "Weapon Familiarity"],
  },
] as const;

export interface PF1eClassDefinition {
  readonly id: string;
  readonly name: string;
  readonly hitDie: number;
  readonly babProgression: PF1eBabProgression;
  readonly goodSaves: readonly ("fort" | "ref" | "will")[];
  readonly skillPointsPerLevel: number;
  readonly classSkills: readonly PF1eSkillId[];
  readonly spellcaster?: {
    readonly type: "prepared" | "spontaneous";
    readonly keyAbility: PF1eAbilityKey;
  };
}

export const PF1E_CORE_CLASSES: readonly PF1eClassDefinition[] = [
  {
    id: "barbarian",
    name: "Barbarian",
    hitDie: 12,
    babProgression: "good",
    goodSaves: ["fort"],
    skillPointsPerLevel: 4,
    classSkills: ["acrobatics", "climb", "craft", "handleAnimal", "intimidate", "knowledgeNature", "perception", "ride", "survival", "swim"],
  },
  {
    id: "bard",
    name: "Bard",
    hitDie: 8,
    babProgression: "average",
    goodSaves: ["ref", "will"],
    skillPointsPerLevel: 6,
    classSkills: ["acrobatics", "appraise", "bluff", "climb", "craft", "diplomacy", "disguise", "escapeArtist", "intimidate", "knowledgeArcana", "knowledgeDungeoneering", "knowledgeEngineering", "knowledgeGeography", "knowledgeHistory", "knowledgeLocal", "knowledgeNature", "knowledgeNobility", "knowledgePlanes", "knowledgeReligion", "linguistics", "perception", "perform", "profession", "senseMotive", "sleightOfHand", "spellcraft", "stealth", "useMagicDevice"],
    spellcaster: { type: "spontaneous", keyAbility: "cha" },
  },
  {
    id: "cleric",
    name: "Cleric",
    hitDie: 8,
    babProgression: "average",
    goodSaves: ["fort", "will"],
    skillPointsPerLevel: 2,
    classSkills: ["appraise", "craft", "diplomacy", "heal", "knowledgeArcana", "knowledgeHistory", "knowledgeNobility", "knowledgePlanes", "knowledgeReligion", "linguistics", "profession", "senseMotive", "spellcraft"],
    spellcaster: { type: "prepared", keyAbility: "wis" },
  },
  {
    id: "druid",
    name: "Druid",
    hitDie: 8,
    babProgression: "average",
    goodSaves: ["fort", "will"],
    skillPointsPerLevel: 4,
    classSkills: ["climb", "craft", "fly", "handleAnimal", "heal", "knowledgeGeography", "knowledgeNature", "perception", "profession", "ride", "spellcraft", "survival", "swim"],
    spellcaster: { type: "prepared", keyAbility: "wis" },
  },
  {
    id: "fighter",
    name: "Fighter",
    hitDie: 10,
    babProgression: "good",
    goodSaves: ["fort"],
    skillPointsPerLevel: 2,
    classSkills: ["climb", "craft", "handleAnimal", "intimidate", "knowledgeDungeoneering", "knowledgeEngineering", "profession", "ride", "survival", "swim"],
  },
  {
    id: "monk",
    name: "Monk",
    hitDie: 8,
    babProgression: "average",
    goodSaves: ["fort", "ref", "will"],
    skillPointsPerLevel: 4,
    classSkills: ["acrobatics", "climb", "craft", "escapeArtist", "intimidate", "knowledgeHistory", "knowledgeReligion", "perception", "perform", "profession", "ride", "senseMotive", "stealth", "swim"],
  },
  {
    id: "paladin",
    name: "Paladin",
    hitDie: 10,
    babProgression: "good",
    goodSaves: ["fort", "will"],
    skillPointsPerLevel: 2,
    classSkills: ["craft", "diplomacy", "handleAnimal", "heal", "knowledgeNobility", "knowledgeReligion", "profession", "ride", "senseMotive", "spellcraft"],
    spellcaster: { type: "prepared", keyAbility: "cha" },
  },
  {
    id: "ranger",
    name: "Ranger",
    hitDie: 10,
    babProgression: "good",
    goodSaves: ["fort", "ref"],
    skillPointsPerLevel: 6,
    classSkills: ["climb", "craft", "handleAnimal", "heal", "intimidate", "knowledgeDungeoneering", "knowledgeGeography", "knowledgeNature", "perception", "profession", "ride", "spellcraft", "stealth", "survival", "swim"],
    spellcaster: { type: "prepared", keyAbility: "wis" },
  },
  {
    id: "rogue",
    name: "Rogue",
    hitDie: 8,
    babProgression: "average",
    goodSaves: ["ref"],
    skillPointsPerLevel: 8,
    classSkills: ["acrobatics", "appraise", "bluff", "climb", "craft", "diplomacy", "disableDevice", "disguise", "escapeArtist", "intimidate", "knowledgeDungeoneering", "knowledgeLocal", "linguistics", "perception", "perform", "profession", "senseMotive", "sleightOfHand", "stealth", "swim", "useMagicDevice"],
  },
  {
    id: "sorcerer",
    name: "Sorcerer",
    hitDie: 6,
    babProgression: "poor",
    goodSaves: ["will"],
    skillPointsPerLevel: 2,
    classSkills: ["appraise", "bluff", "craft", "fly", "intimidate", "knowledgeArcana", "profession", "spellcraft", "useMagicDevice"],
    spellcaster: { type: "spontaneous", keyAbility: "cha" },
  },
  {
    id: "wizard",
    name: "Wizard",
    hitDie: 6,
    babProgression: "poor",
    goodSaves: ["will"],
    skillPointsPerLevel: 2,
    classSkills: ["appraise", "craft", "fly", "knowledgeArcana", "knowledgeDungeoneering", "knowledgeEngineering", "knowledgeGeography", "knowledgeHistory", "knowledgeLocal", "knowledgeNature", "knowledgeNobility", "knowledgePlanes", "knowledgeReligion", "linguistics", "profession", "spellcraft"],
    spellcaster: { type: "prepared", keyAbility: "int" },
  },
] as const;

/** Class level entry for multiclass aggregation. */
export interface PF1eClassLevelEntry {
  classId: string;
  level: number;
}

/**
 * Aggregates BAB, base saves, and Hit Dice across multiple classes (T2 Multiclass aggregation).
 * CRB p.30 Multiclassing:
 * - Total BAB is the sum of BAB from each class.
 * - Base saves: each save is sum of base saves from each class.
 */
export function aggregateClassProgression(
  classes: readonly PF1eClassLevelEntry[],
  catalog: readonly PF1eClassDefinition[] = PF1E_CORE_CLASSES,
): {
  totalLevel: number;
  bab: number;
  baseSaves: { fort: number; ref: number; will: number };
  hitDice: number;
} {
  const map = new Map(catalog.map((c) => [c.id, c]));
  let totalLevel = 0;
  let bab = 0;
  const baseSaves = { fort: 0, ref: 0, will: 0 };

  for (const entry of classes) {
    const def = map.get(entry.classId);
    if (!def || entry.level <= 0) continue;
    totalLevel += entry.level;
    bab += babAtLevel(def.babProgression, entry.level);
    for (const save of ["fort", "ref", "will"] as const) {
      const isGood = def.goodSaves.includes(save);
      baseSaves[save] += saveBonusAtLevel(isGood ? "good" : "poor", entry.level);
    }
  }

  return {
    totalLevel,
    bab,
    baseSaves,
    hitDice: totalLevel,
  };
}

/**
 * Computes skill points available per level for a class + Int modifier (minimum 1 per level).
 * Human gains +1 skill point per level.
 */
export function calculateSkillPointsPerLevel(
  classDef: PF1eClassDefinition,
  intMod: number,
  isHuman = false,
): number {
  const base = classDef.skillPointsPerLevel;
  const perLevel = Math.max(1, base + intMod);
  return perLevel + (isHuman ? 1 : 0);
}
