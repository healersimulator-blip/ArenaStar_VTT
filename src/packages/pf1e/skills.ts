/**
 * PF1e Skills system (G-01 / T1).
 *
 * Core skills definitions, key abilities, armor check penalty applicability,
 * trained-only rules, and skill modifier derivation.
 *
 * Primary sources:
 * - Pathfinder Core Rulebook p.86-107 (Using Skills, Skill Descriptions)
 * - AoN Rules ID 129 ("Skills")
 *
 * Rule constraints:
 * - Each rank costs 1 skill point. Max ranks in any class skill or cross-class skill = total Hit Dice.
 * - Class skill training: +3 bonus if ranks >= 1 and the skill is a class skill (CRB p.86).
 * - Armor check penalty (ACP): applies to Strength- and Dexterity-based skills.
 * - Take 10: permitted on any skill check when not in immediate danger or distraction.
 * - Take 20: permitted when there is no penalty for failure and repeated attempts are possible.
 */

import type { PF1eAbilityKey } from "./actor";

export interface PF1eSkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly ability: PF1eAbilityKey;
  readonly trainedOnly: boolean;
  readonly armorCheckPenalty: boolean;
  readonly canTake10: boolean;
  readonly canTake20: boolean;
}

export const PF1E_SKILLS: readonly PF1eSkillDefinition[] = [
  { id: "acrobatics", name: "Acrobatics", ability: "dex", trainedOnly: false, armorCheckPenalty: true, canTake10: true, canTake20: false },
  { id: "appraise", name: "Appraise", ability: "int", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "bluff", name: "Bluff", ability: "cha", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "climb", name: "Climb", ability: "str", trainedOnly: false, armorCheckPenalty: true, canTake10: true, canTake20: false },
  { id: "craft", name: "Craft", ability: "int", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: true },
  { id: "diplomacy", name: "Diplomacy", ability: "cha", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "disableDevice", name: "Disable Device", ability: "dex", trainedOnly: true, armorCheckPenalty: true, canTake10: true, canTake20: true },
  { id: "disguise", name: "Disguise", ability: "cha", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "escapeArtist", name: "Escape Artist", ability: "dex", trainedOnly: false, armorCheckPenalty: true, canTake10: true, canTake20: true },
  { id: "fly", name: "Fly", ability: "dex", trainedOnly: false, armorCheckPenalty: true, canTake10: true, canTake20: false },
  { id: "handleAnimal", name: "Handle Animal", ability: "cha", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "heal", name: "Heal", ability: "wis", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "intimidate", name: "Intimidate", ability: "cha", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "knowledgeArcana", name: "Knowledge (arcana)", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "knowledgeDungeoneering", name: "Knowledge (dungeoneering)", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "knowledgeEngineering", name: "Knowledge (engineering)", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "knowledgeGeography", name: "Knowledge (geography)", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "knowledgeHistory", name: "Knowledge (history)", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "knowledgeLocal", name: "Knowledge (local)", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "knowledgeNature", name: "Knowledge (nature)", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "knowledgeNobility", name: "Knowledge (nobility)", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "knowledgePlanes", name: "Knowledge (planes)", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "knowledgeReligion", name: "Knowledge (religion)", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "linguistics", name: "Linguistics", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "perception", name: "Perception", ability: "wis", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: true },
  { id: "perform", name: "Perform", ability: "cha", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "profession", name: "Profession", ability: "wis", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "ride", name: "Ride", ability: "dex", trainedOnly: false, armorCheckPenalty: true, canTake10: true, canTake20: false },
  { id: "senseMotive", name: "Sense Motive", ability: "wis", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "sleightOfHand", name: "Sleight of Hand", ability: "dex", trainedOnly: true, armorCheckPenalty: true, canTake10: true, canTake20: false },
  { id: "spellcraft", name: "Spellcraft", ability: "int", trainedOnly: true, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "stealth", name: "Stealth", ability: "dex", trainedOnly: false, armorCheckPenalty: true, canTake10: true, canTake20: false },
  { id: "survival", name: "Survival", ability: "wis", trainedOnly: false, armorCheckPenalty: false, canTake10: true, canTake20: false },
  { id: "swim", name: "Swim", ability: "str", trainedOnly: false, armorCheckPenalty: true, canTake10: true, canTake20: false },
  { id: "useMagicDevice", name: "Use Magic Device", ability: "cha", trainedOnly: true, armorCheckPenalty: false, canTake10: false, canTake20: false },
] as const;

export type PF1eSkillId = (typeof PF1E_SKILLS)[number]["id"];

export const PF1E_SKILL_MAP: Readonly<Record<string, PF1eSkillDefinition>> = Object.freeze(
  Object.fromEntries(PF1E_SKILLS.map((s) => [s.id, s])),
);

/**
 * Short code / alias to standard skill id (e.g. from Foundry or converters).
 */
export const PF1E_SKILL_ALIASES: Readonly<Record<string, PF1eSkillId>> = Object.freeze({
  acr: "acrobatics",
  apr: "appraise",
  art: "craft",
  blf: "bluff",
  clm: "climb",
  crf: "craft",
  dev: "disableDevice",
  dip: "diplomacy",
  dis: "disguise",
  esc: "escapeArtist",
  fly: "fly",
  han: "handleAnimal",
  hea: "heal",
  int: "intimidate",
  kar: "knowledgeArcana",
  kdu: "knowledgeDungeoneering",
  ken: "knowledgeEngineering",
  kge: "knowledgeGeography",
  khi: "knowledgeHistory",
  klo: "knowledgeLocal",
  kna: "knowledgeNature",
  kno: "knowledgeNobility",
  kpl: "knowledgePlanes",
  kre: "knowledgeReligion",
  lin: "linguistics",
  lor: "knowledgeHistory",
  per: "perception",
  prf: "profession",
  pro: "profession",
  rid: "ride",
  sen: "senseMotive",
  slt: "sleightOfHand",
  spl: "spellcraft",
  ste: "stealth",
  sur: "survival",
  swm: "swim",
  umd: "useMagicDevice",
});

/** Normalizes a skill identifier or alias to the canonical PF1eSkillId if recognized. */
export function normalizeSkillId(raw: string): PF1eSkillId | undefined {
  const clean = raw.trim().toLowerCase().replace(/[-_ ]+/g, "");
  if (PF1E_SKILL_ALIASES[clean]) return PF1E_SKILL_ALIASES[clean];
  for (const skill of PF1E_SKILLS) {
    if (skill.id.toLowerCase() === clean) return skill.id;
    if (skill.name.toLowerCase().replace(/[-_ ()]+/g, "") === clean) return skill.id;
  }
  return undefined;
}

/**
 * Authored skill entry on an actor's `system.pf1e.skills.<id>`.
 */
export interface PF1eAuthoredSkill {
  ranks?: number;
  classSkill?: boolean;
  customBonus?: number;
}

/**
 * Derived skill entry with all modifier components broken down.
 */
export interface PF1eDerivedSkill {
  id: PF1eSkillId;
  name: string;
  ability: PF1eAbilityKey;
  abilityMod: number;
  ranks: number;
  classSkill: boolean;
  classSkillBonus: number;
  armorCheckPenalty: number;
  effectBonus: number;
  customBonus: number;
  total: number;
  trainedOnly: boolean;
  isUsable: boolean;
  canTake10: boolean;
  canTake20: boolean;
}

export interface SkillDeriveContext {
  abilities: Record<PF1eAbilityKey, number>;
  armorCheckPenalty: number;
  effectMods?: Record<string, number>;
  negativeLevels?: number;
}

/**
 * Derives a single skill given authored parameters and actor context.
 *
 * Primary rule @srd "Core Rulebook p.86 — Skill Ranks & Class Skills":
 * - If you have at least 1 rank in a skill that is a class skill, you gain a +3 bonus on checks with that skill.
 * - Armor check penalty applies to Strength and Dexterity based skills.
 * - Each negative level imparts a -1 penalty on all skill checks (CRB p.562).
 */
export function derivePF1eSkill(
  def: PF1eSkillDefinition,
  authored: PF1eAuthoredSkill | undefined,
  context: SkillDeriveContext,
): PF1eDerivedSkill {
  const ranks = Math.max(0, Math.floor(Number(authored?.ranks) || 0));
  const classSkill = Boolean(authored?.classSkill);
  const classSkillBonus = classSkill && ranks >= 1 ? 3 : 0;
  const abilityMod = context.abilities[def.ability] ?? 0;
  const customBonus = Number(authored?.customBonus) || 0;

  // Armor check penalty applies only if definition specifies and there is a penalty (ACP is <= 0)
  const acp = def.armorCheckPenalty ? Math.min(0, -Math.abs(context.armorCheckPenalty || 0)) : 0;

  // Modifiers from active effects: general "skills" mod + specific skill mod (e.g. "perception", "stealth", "skill.acrobatics")
  const effects = context.effectMods ?? {};
  const skillEffect = (effects[def.id] ?? 0) + (effects[`skill.${def.id}`] ?? 0) + (effects["skills"] ?? 0);

  // Negative levels penalty (-1 per negative level)
  const negLevelPenalty = -(Math.max(0, context.negativeLevels ?? 0));

  const total = abilityMod + ranks + classSkillBonus + acp + customBonus + skillEffect + negLevelPenalty;
  const isUsable = !def.trainedOnly || ranks > 0;

  return {
    id: def.id,
    name: def.name,
    ability: def.ability,
    abilityMod,
    ranks,
    classSkill,
    classSkillBonus,
    armorCheckPenalty: acp,
    effectBonus: skillEffect + negLevelPenalty,
    customBonus,
    total,
    trainedOnly: def.trainedOnly,
    isUsable,
    canTake10: def.canTake10,
    canTake20: def.canTake20 && ranks > 0,
  };
}

/**
 * Derives all PF1e skills for an actor.
 */
export function deriveAllPF1eSkills(
  authoredSkills: Record<string, PF1eAuthoredSkill> | undefined,
  context: SkillDeriveContext,
): Record<PF1eSkillId, PF1eDerivedSkill> {
  const out = {} as Record<PF1eSkillId, PF1eDerivedSkill>;
  const raw = authoredSkills ?? {};

  for (const def of PF1E_SKILLS) {
    const authored = raw[def.id];
    out[def.id] = derivePF1eSkill(def, authored, context);
  }
  return out;
}
