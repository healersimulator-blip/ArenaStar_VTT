/**
 * PF1e feat and combat-stance modifiers (P3/A07).
 *
 * This module is intentionally small and pure. Feat names come from packs, so
 * matching is case/spacing/hyphen insensitive; callers still supply the
 * prerequisites they have verified on the actor. It never grants a feat merely
 * because a name was malformed or because a prerequisite is absent.
 *
 * Sources: CRB Power Attack, Deadly Aim, Combat Expertise, Fighting
 * Defensively, Weapon Focus/Specialization, Weapon Finesse, Improved Critical,
 * Point-Blank Shot and the Two-Weapon Fighting tree.
 */

export type PF1eFeatModifierPart = { label: string; value: number };

function key(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

export function hasPF1eFeat(feats: readonly string[] | undefined, name: string): boolean {
  const wanted = key(name);
  return (feats ?? []).some((feat) => {
    const actual = key(feat);
    return actual === wanted || actual.replace(/-/g, "") === wanted.replace(/-/g, "");
  });
}

function hasWeaponFeat(
  feats: readonly string[] | undefined,
  featName: string,
  weaponName: string | undefined,
  weaponGroup: string | undefined,
): boolean {
  const target = key(weaponName ?? weaponGroup ?? "");
  return (feats ?? []).some((feat) => {
    const normalized = key(feat);
    if (normalized === key(featName)) return false;
    const match = normalized.match(new RegExp(`^${key(featName)}[- ]?\\((.+)\\)$`));
    return match?.[1] === target;
  });
}

export function powerAttackStep(bab: number): number {
  const base = Math.trunc(bab);
  return base < 1 ? 0 : Math.min(5, Math.floor(base / 4) + 1);
}

export function deadlyAimStep(bab: number): number {
  return powerAttackStep(bab);
}

export interface PF1eFeatPrerequisiteContext {
  bab?: number | undefined;
  abilities?: Partial<Record<"str" | "dex" | "int", number>> | undefined;
}

/** Reports unmet prerequisites without deleting or silently disabling authored feats. */
export function validatePF1eFeatSelection(
  feats: readonly string[] | undefined,
  context: PF1eFeatPrerequisiteContext,
): string[] {
  const result: string[] = [];
  const bab = context.bab ?? 0;
  const str = context.abilities?.str ?? 10;
  const dex = context.abilities?.dex ?? 10;
  const int = context.abilities?.int ?? 10;
  const require = (feat: string, condition: boolean, requirement: string) => {
    if (hasPF1eFeat(feats, feat) && !condition) result.push(`${feat}: unmet prerequisite (${requirement})`);
  };
  require("Power Attack", str >= 13 && bab >= 1, "Str 13 and BAB +1");
  require("Deadly Aim", dex >= 13 && bab >= 1, "Dex 13 and BAB +1");
  require("Combat Expertise", int >= 13 && bab >= 1, "Int 13 and BAB +1");
  require("Weapon Finesse", dex >= 13, "Dex 13");
  require("Improved Critical", bab >= 8, "BAB +8");
  require("Precise Shot", hasPF1eFeat(feats, "Point-Blank Shot"), "Point-Blank Shot");
  require(
    "Manyshot",
    dex >= 17 && bab >= 6 && hasPF1eFeat(feats, "Point-Blank Shot") && hasPF1eFeat(feats, "Rapid Shot"),
    "Dex 17, BAB +6, Point-Blank Shot, and Rapid Shot",
  );
  require(
    "Improved Two-Weapon Fighting",
    dex >= 17 && hasPF1eFeat(feats, "Two-Weapon Fighting"),
    "Dex 17 and Two-Weapon Fighting",
  );
  require(
    "Greater Two-Weapon Fighting",
    dex >= 19 && hasPF1eFeat(feats, "Improved Two-Weapon Fighting"),
    "Dex 19 and Improved Two-Weapon Fighting",
  );
  return result;
}

export interface PF1eFeatAttackInput {
  feats?: readonly string[] | undefined;
  bab: number;
  ranged: boolean;
  weaponName?: string | undefined;
  weaponGroup?: string | undefined;
  weaponFinesseEligible?: boolean | undefined;
  powerAttack?: boolean | undefined;
  deadlyAim?: boolean | undefined;
  combatExpertise?: boolean | undefined;
  fightingDefensively?: boolean | undefined;
  pointBlankShot?: boolean | undefined;
  distanceFt?: number | undefined;
}

/** Attack-side feat contributions. The caller supplies stance toggles; feats do not
 * silently turn on Power Attack, Expertise, or defensive fighting. */
export function featAttackParts(input: PF1eFeatAttackInput): PF1eFeatModifierPart[] {
  const feats = input.feats;
  const parts: PF1eFeatModifierPart[] = [];
  if (input.powerAttack && !input.ranged && hasPF1eFeat(feats, "Power Attack")) {
    const step = powerAttackStep(input.bab);
    parts.push({ label: "Power Attack", value: -step });
  }
  if (input.deadlyAim && input.ranged && hasPF1eFeat(feats, "Deadly Aim")) {
    const step = deadlyAimStep(input.bab);
    parts.push({ label: "Deadly Aim", value: -step });
  }
  if (input.combatExpertise && !input.ranged && hasPF1eFeat(feats, "Combat Expertise")) {
    parts.push({ label: "Combat Expertise", value: -Math.min(5, Math.max(1, Math.floor(Math.max(0, input.bab) / 4) + 1)) });
  }
  if (input.fightingDefensively) {
    parts.push({ label: "fighting defensively", value: -4 });
  }
  if (input.pointBlankShot && input.ranged && hasPF1eFeat(feats, "Point-Blank Shot") && (input.distanceFt ?? Infinity) <= 30) {
    parts.push({ label: "Point-Blank Shot", value: 1 });
  }
  if (hasWeaponFeat(feats, "Weapon Focus", input.weaponName, input.weaponGroup)) {
    parts.push({ label: "Weapon Focus", value: 1 });
  }
  if (input.weaponFinesseEligible && hasPF1eFeat(feats, "Weapon Finesse") && !input.ranged) {
    // This is a stat-selection marker, not a second numeric bonus. The tactical
    // caller consumes it when selecting Str/Dex for the base attack stack.
    parts.push({ label: "Weapon Finesse", value: 0 });
  }
  return parts;
}

export interface PF1eFeatDamageInput {
  feats?: readonly string[] | undefined;
  bab: number;
  ranged: boolean;
  weaponName?: string | undefined;
  weaponGroup?: string | undefined;
  hand?: "primary" | "off-hand" | "natural";
  twoHanded?: boolean | undefined;

  powerAttack?: boolean | undefined;
  deadlyAim?: boolean | undefined;
  pointBlankShot?: boolean | undefined;
  distanceFt?: number | undefined;
}

export function featDamageParts(input: PF1eFeatDamageInput): PF1eFeatModifierPart[] {
  const parts: PF1eFeatModifierPart[] = [];
  if (input.powerAttack && !input.ranged && hasPF1eFeat(input.feats, "Power Attack")) {
    const step = powerAttackStep(input.bab);
    const multiplier = input.twoHanded ? 3 : input.hand === "off-hand" ? 1 : 2;
    parts.push({ label: "Power Attack damage", value: step * multiplier });
  }
  if (input.deadlyAim && input.ranged && hasPF1eFeat(input.feats, "Deadly Aim")) {
    const step = deadlyAimStep(input.bab);
    parts.push({ label: "Deadly Aim damage", value: step * 2 });
  }
  if (input.pointBlankShot && input.ranged && hasPF1eFeat(input.feats, "Point-Blank Shot") && (input.distanceFt ?? Infinity) <= 30) {
    parts.push({ label: "Point-Blank Shot damage", value: 1 });
  }
  if (hasWeaponFeat(input.feats, "Weapon Specialization", input.weaponName, input.weaponGroup)) {
    parts.push({ label: "Weapon Specialization", value: 2 });
  }
  return parts;
}

export function featDefenseParts(input: {
  feats?: readonly string[] | undefined;
  totalDefense?: boolean | undefined;
  fightingDefensively?: boolean | undefined;
  combatExpertisePenalty?: number | undefined;
}): PF1eFeatModifierPart[] {
  const parts: PF1eFeatModifierPart[] = [];
  if (input.totalDefense) parts.push({ label: "total defense", value: 4 });
  else if (input.fightingDefensively) parts.push({ label: "fighting defensively AC", value: 2 });
  if (input.combatExpertisePenalty !== undefined && input.combatExpertisePenalty < 0 && hasPF1eFeat(input.feats, "Combat Expertise")) {
    parts.push({ label: "Combat Expertise AC", value: -input.combatExpertisePenalty });
  }
  return parts;
}

export function improvedCriticalApplies(input: {
  feats?: readonly string[] | undefined;
  weaponName?: string | undefined;
  weaponGroup?: string | undefined;
}): boolean {
  return hasWeaponFeat(
    input.feats,
    "Improved Critical",
    input.weaponName,
    input.weaponGroup,
  );
}

export function offHandAttackCount(feats: readonly string[] | undefined): number {
  if (hasPF1eFeat(feats, "Greater Two-Weapon Fighting")) return 3;
  if (hasPF1eFeat(feats, "Improved Two-Weapon Fighting")) return 2;
  return 1;
}

/**
 * Manyshot is a standard-action volley, not a full attack: every arrow uses
 * the first attack bonus and the attack takes −4. At BAB +11 and +16 it adds
 * one arrow, up to four total. The caller applies damage per arrow and keeps
 * precision/extra-dice riders single-use as required by the feat.
 */
export function manyshotPlan(input: {
  feats?: readonly string[] | undefined;
  bab: number;
  ranged: boolean;
}): { ok: true; arrows: number; attackPenalty: number } | { ok: false; reason: string } {
  if (!input.ranged) return { ok: false, reason: "Manyshot requires a ranged attack" };
  if (!hasPF1eFeat(input.feats, "Manyshot")) {
    return { ok: false, reason: "Manyshot feat is not present" };
  }
  if (input.bab < 6) return { ok: false, reason: "Manyshot requires base attack bonus +6" };
  return {
    ok: true,
    arrows: Math.min(4, 2 + Math.max(0, Math.floor((input.bab - 6) / 5))),
    attackPenalty: -4,
  };
}
