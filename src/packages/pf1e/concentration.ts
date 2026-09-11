/**
 * P5/C03 — casting legality, components, arcane spell failure and concentration.
 *
 * This is the gate *in front of* the save flow in `casting.ts`: it answers "may this
 * caster cast this spell right now, and does it survive long enough to have an
 * effect?" It rolls nothing itself — every die face is supplied by the caller — so
 * the same resolution is testable, replayable and UI-drivable.
 *
 * Sources (transcribed 2026-09-11):
 * - Archives of Nethys Rules ID 203 / CRB pp.206–208, Table 9-1 "Concentration Check
 *   DCs" and the Spell Failure section.
 * - The Armor table's "Arcane Spell Failure Chance" column and its rules paragraph.
 * - CRB Table 7-2 "Actions in Combat" — already encoded in `actions.ts`, which this
 *   module reads rather than duplicating.
 */

import { pf1eActionById } from "./actions";
import type {
  PF1eActionCategory,
  PF1eActionEntry,
  PF1eProvokes,
} from "./actions";

/** The component abbreviations printed on a spell's Components line. */
export const PF1E_COMPONENT_CODES = ["V", "S", "M", "F", "DF", "XP"] as const;
export type PF1eComponentCode = (typeof PF1E_COMPONENT_CODES)[number];

/** Which half of an `F/DF` or `M/DF` pair a caster uses. */
export const PF1E_TRADITIONS = ["arcane", "divine"] as const;
export type PF1eSpellTradition = (typeof PF1E_TRADITIONS)[number];

export interface PF1eCastingIssue {
  field: string;
  message: string;
}

/**
 * Casting times, bucketed. The bucket is the caller's to assign because PF1e casting
 * times are free text ("1 standard action", "1 round", "10 minutes"); this module
 * refuses to parse that text rather than guess at a mapping.
 */
export const PF1E_CASTING_TIMES = [
  "free",
  "swift",
  "standard",
  "full-round",
  "longer",
] as const;
export type PF1eCastingTime = (typeof PF1E_CASTING_TIMES)[number];

/* ------------------------------------------------------------------ *
 * Components
 * ------------------------------------------------------------------ */

/**
 * One entry on the Components line. A bare `M` fills both sides; `M/DF` fills one
 * side each, per "If the Components line includes F/DF or M/DF, the arcane version of
 * the spell has a focus component or a material component (the abbreviation before the
 * slash) and the divine version has a divine focus component (the abbreviation after
 * the slash)".
 */
export interface PF1eComponentSegment {
  arcane: PF1eComponentCode | null;
  divine: PF1eComponentCode | null;
}

export interface PF1eComponentParse {
  ok: boolean;
  segments: PF1eComponentSegment[];
  issues: PF1eCastingIssue[];
}

/** Parses `"V, S, M/DF (a pinch of sulphur)"` into per-tradition segments. */
export function parseSpellComponents(line: string): PF1eComponentParse {
  const issues: PF1eCastingIssue[] = [];
  const segments: PF1eComponentSegment[] = [];
  if (typeof line !== "string" || line.trim().length === 0) {
    return {
      ok: false,
      segments: [],
      issues: [{ field: "components", message: "components line is empty" }],
    };
  }
  for (const raw of line.split(",")) {
    // The parenthetical names the material; it is not a component code.
    const cleaned = raw.replace(/\([^)]*\)/g, "").trim();
    if (cleaned.length === 0) continue;
    const parts = cleaned.split("/").map((p) => p.trim().toUpperCase());
    if (parts.length > 2) {
      issues.push({
        field: "components",
        message: `"${cleaned}" has more than one slash`,
      });
      continue;
    }
    for (const p of parts) {
      if (!(PF1E_COMPONENT_CODES as readonly string[]).includes(p)) {
        issues.push({
          field: "components",
          message: `"${p}" is not a component abbreviation`,
        });
      }
    }
    if (issues.length > 0) continue;
    if (parts.length === 1) {
      const code = parts[0] as PF1eComponentCode;
      segments.push({ arcane: code, divine: code });
    } else {
      segments.push({
        arcane: parts[0] as PF1eComponentCode,
        divine: parts[1] as PF1eComponentCode,
      });
    }
  }
  return { ok: issues.length === 0, segments, issues };
}

export interface PF1eComponentNeeds {
  /** The codes this tradition actually uses, in line order, deduplicated. */
  codes: PF1eComponentCode[];
  /** A verbal component requires speaking "in a strong voice". */
  mustSpeak: boolean;
  /** A somatic component requires "at least one hand free". */
  needsFreeHand: boolean;
  /** M/F/DF must be manipulated, so they must be in hand while grappling. */
  mustManipulateComponents: boolean;
}

/** Resolves a parsed Components line down to what one tradition must provide. */
export function componentNeeds(
  segments: readonly PF1eComponentSegment[],
  tradition: PF1eSpellTradition,
): PF1eComponentNeeds {
  const codes: PF1eComponentCode[] = [];
  for (const seg of segments) {
    const code = tradition === "arcane" ? seg.arcane : seg.divine;
    if (code !== null && !codes.includes(code)) codes.push(code);
  }
  return {
    codes,
    mustSpeak: codes.includes("V"),
    needsFreeHand: codes.includes("S"),
    mustManipulateComponents:
      codes.includes("M") || codes.includes("F") || codes.includes("DF"),
  };
}

/* ------------------------------------------------------------------ *
 * Legality
 * ------------------------------------------------------------------ */

/** The caster's physical and conditional state at the moment of casting. */
export interface PF1eCasterState {
  canSpeak: boolean;
  hasFreeHand: boolean;
  /** Material components/foci already in hand, not merely owned. */
  componentsInHand: boolean;
  deafened?: boolean | undefined;
  grappled?: boolean | undefined;
  pinned?: boolean | undefined;
}

export interface PF1eCastingLegality {
  legal: boolean;
  /** Named refusals; empty when the casting is legal. */
  reasons: string[];
}

/**
 * "To cast a spell, you must be able to speak (if the spell has a verbal component),
 * gesture (if it has a somatic component), and manipulate the material components or
 * focus (if any)."
 *
 * Grapple adds: "provided its casting time is no more than 1 standard action, it has
 * no somatic component, and you have in hand any material components or focuses you
 * might need." Pinned adds: "Pinned creatures can only cast spells that do not have
 * somatic components."
 */
export function checkCastingLegality(input: {
  needs: PF1eComponentNeeds;
  caster: PF1eCasterState;
  castingTime: PF1eCastingTime;
}): PF1eCastingLegality {
  const reasons: string[] = [];
  const { needs, caster } = input;
  if (needs.mustSpeak && !caster.canSpeak) {
    reasons.push(
      "cannot speak: a verbal component requires a strong voice (silence or a gag spoils it)",
    );
  }
  if (needs.needsFreeHand && !caster.hasFreeHand) {
    reasons.push(
      "no free hand: a somatic component requires at least one hand free",
    );
  }
  if (needs.mustManipulateComponents && !caster.componentsInHand) {
    reasons.push(
      `components not in hand: ${needs.codes.filter((c) => c === "M" || c === "F" || c === "DF").join(", ")} must be manipulated`,
    );
  }
  if (caster.pinned === true && needs.needsFreeHand) {
    reasons.push(
      "pinned: pinned creatures can only cast spells without somatic components",
    );
  }
  if (
    caster.grappled === true &&
    input.castingTime !== "standard" &&
    input.castingTime !== "swift" &&
    input.castingTime !== "free"
  ) {
    reasons.push(
      `grappling: casting time "${input.castingTime}" exceeds the 1-standard-action limit while grappling`,
    );
  }
  return { legal: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ *
 * Arcane spell failure
 * ------------------------------------------------------------------ */

export interface PF1eArcaneSpellFailureGear {
  /** The table's percentage for this item alone. */
  chance: number;
  /** True when a class feature ignores this item's chance (e.g. bard light armour). */
  exempt?: boolean | undefined;
}

export interface PF1eArcaneSpellFailureResult {
  chance: number;
  applies: boolean;
  issues: PF1eCastingIssue[];
}

/**
 * "The number in the Arcane Spell Failure Chance column … is the percentage chance
 * that the spell fails and is ruined. If the spell lacks a somatic component, however,
 * it can be cast with no chance of arcane spell failure."
 *
 * "Shields: If a character is wearing armor and using a shield, add the two numbers
 * together to get a single arcane spell failure chance." Each item is resolved first,
 * so an exemption (bard light armour, mithral, Arcane Armour Training) is applied per
 * item before the totals are summed.
 */
export function arcaneSpellFailureChance(input: {
  armor?: PF1eArcaneSpellFailureGear | undefined;
  shield?: PF1eArcaneSpellFailureGear | undefined;
  hasSomatic: boolean;
}): PF1eArcaneSpellFailureResult {
  const issues: PF1eCastingIssue[] = [];
  const parts = [input.armor, input.shield].filter(
    (g): g is PF1eArcaneSpellFailureGear => g !== undefined,
  );
  for (const gear of parts) {
    if (!Number.isFinite(gear.chance) || gear.chance < 0 || gear.chance > 100) {
      issues.push({
        field: "arcaneSpellFailure",
        message: `chance ${String(gear.chance)} is not a percentage 0–100`,
      });
    }
  }
  if (issues.length > 0) return { chance: 0, applies: false, issues };
  if (!input.hasSomatic) {
    return { chance: 0, applies: false, issues };
  }
  const chance = parts.reduce(
    (sum, g) => sum + (g.exempt === true ? 0 : g.chance),
    0,
  );
  return { chance, applies: chance > 0, issues };
}

/**
 * Percentile roll against the chance. The convention is "roll 1d100; if the result is
 * the chance or lower, the spell fails and is ruined". A chance of 0 can therefore
 * never fail, since the lowest face is 1.
 */
export function resolveArcaneSpellFailure(input: {
  die: number;
  chance: number;
}): { failed: boolean; issues: PF1eCastingIssue[] } {
  const issues: PF1eCastingIssue[] = [];
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > 100) {
    issues.push({
      field: "die",
      message: `d100 face ${String(input.die)} is not an integer 1–100`,
    });
  }
  if (issues.length > 0) return { failed: false, issues };
  return { failed: input.die <= input.chance, issues };
}

/**
 * "A spellcaster who has been deafened has a 20% chance to spoil any spell with a
 * verbal component that he or she tries to cast."
 */
export const PF1E_DEAFENED_SPOIL_PERCENT = 20;

export function resolveDeafenedSpoilage(die: number): {
  spoiled: boolean;
  issues: PF1eCastingIssue[];
} {
  const r = resolveArcaneSpellFailure({
    die,
    chance: PF1E_DEAFENED_SPOIL_PERCENT,
  });
  return {
    spoiled: r.failed,
    issues: r.issues.map((i) => ({ ...i, field: "deafenedDie" })),
  };
}

/* ------------------------------------------------------------------ *
 * Concentration — Table 9-1
 * ------------------------------------------------------------------ */

export const PF1E_CONCENTRATION_SITUATIONS = [
  "castDefensively",
  "injured",
  "continuousDamage",
  "nonDamagingSpell",
  "grappledOrPinned",
  "vigorousMotion",
  "violentMotion",
  "extremelyViolentMotion",
  "windRainSleet",
  "windHailDebris",
  "entangled",
] as const;
export type PF1eConcentrationSituation =
  (typeof PF1E_CONCENTRATION_SITUATIONS)[number];

/**
 * A distractor the caster must roll against, with its own die: several can apply to one
 * casting ("two checks, possibly three") and each is a separate roll.
 */
export type PF1eConcentrationTrigger =
  | { situation: "castDefensively"; die: number }
  | { situation: "injured"; damage: number; die: number }
  | { situation: "continuousDamage"; damage: number; die: number }
  | { situation: "nonDamagingSpell"; spellDc: number; die: number }
  | { situation: "grappledOrPinned"; grapplerCmb: number; die: number }
  | { situation: "vigorousMotion"; die: number }
  | { situation: "violentMotion"; die: number }
  | { situation: "extremelyViolentMotion"; die: number }
  | { situation: "windRainSleet"; die: number }
  | { situation: "windHailDebris"; die: number }
  | { situation: "entangled"; die: number };

export interface PF1eConcentrationDc {
  dc: number;
  issues: PF1eCastingIssue[];
}

/**
 * Table 9-1. `spellLevel` is the level of the spell *being cast*, which every row adds.
 *
 * The continuous-damage row reads "10 + 1/2 damage dealt + spell level" without stating
 * a rounding rule; Pathfinder's general convention is to round fractions down, so this
 * floors. That is an assumption, not a transcribed sentence, and is recorded as such in
 * DECISIONS (D-150).
 */
export function concentrationDc(
  trigger: PF1eConcentrationTrigger,
  spellLevel: number,
): PF1eConcentrationDc {
  const issues: PF1eCastingIssue[] = [];
  if (!Number.isInteger(spellLevel) || spellLevel < 0 || spellLevel > 9) {
    issues.push({
      field: "spellLevel",
      message: `spell level ${String(spellLevel)} is not an integer 0–9`,
    });
    return { dc: 0, issues };
  }
  const nonNegative = (value: number, field: string): number | null => {
    if (!Number.isInteger(value)) {
      issues.push({
        field,
        message: `${field} ${String(value)} is not an integer`,
      });
      return null;
    }
    return value;
  };
  switch (trigger.situation) {
    case "castDefensively":
      return { dc: 15 + 2 * spellLevel, issues };
    case "injured": {
      const d = nonNegative(trigger.damage, "damage");
      if (d === null) return { dc: 0, issues };
      return { dc: 10 + d + spellLevel, issues };
    }
    case "continuousDamage": {
      const d = nonNegative(trigger.damage, "damage");
      if (d === null) return { dc: 0, issues };
      return { dc: 10 + Math.floor(d / 2) + spellLevel, issues };
    }
    case "nonDamagingSpell": {
      const dc = nonNegative(trigger.spellDc, "spellDc");
      if (dc === null) return { dc: 0, issues };
      return { dc: dc + spellLevel, issues };
    }
    case "grappledOrPinned": {
      const cmb = nonNegative(trigger.grapplerCmb, "grapplerCmb");
      if (cmb === null) return { dc: 0, issues };
      return { dc: 10 + cmb + spellLevel, issues };
    }
    case "vigorousMotion":
      return { dc: 10 + spellLevel, issues };
    case "violentMotion":
      return { dc: 15 + spellLevel, issues };
    case "extremelyViolentMotion":
      return { dc: 20 + spellLevel, issues };
    case "windRainSleet":
      return { dc: 5 + spellLevel, issues };
    case "windHailDebris":
      return { dc: 10 + spellLevel, issues };
    case "entangled":
      return { dc: 15 + spellLevel, issues };
  }
}

/**
 * "You roll d20 and add your caster level and the ability score modifier used to
 * determine bonus spells of the same type."
 *
 * `featBonus` is caller-derived — Combat Casting is +4, but no feat is activated from
 * authored content here (D-141).
 */
export function concentrationBonus(input: {
  casterLevel: number;
  keyAbilityMod: number;
  featBonus?: number | undefined;
}): { bonus: number; issues: PF1eCastingIssue[] } {
  const issues: PF1eCastingIssue[] = [];
  if (!Number.isInteger(input.casterLevel) || input.casterLevel < 1) {
    issues.push({
      field: "casterLevel",
      message: `caster level ${String(input.casterLevel)} is not an integer >= 1`,
    });
  }
  if (!Number.isInteger(input.keyAbilityMod)) {
    issues.push({
      field: "keyAbilityMod",
      message: `key ability modifier ${String(input.keyAbilityMod)} is not an integer`,
    });
  }
  if (input.featBonus !== undefined && !Number.isInteger(input.featBonus)) {
    issues.push({
      field: "featBonus",
      message: "feat bonus is not an integer",
    });
  }
  if (issues.length > 0) return { bonus: 0, issues };
  return {
    bonus: input.casterLevel + input.keyAbilityMod + (input.featBonus ?? 0),
    issues,
  };
}

export interface PF1eConcentrationCheckResult {
  situation: PF1eConcentrationSituation;
  dc: number;
  total: number;
  passed: boolean;
}

export interface PF1eConcentrationResult {
  checks: PF1eConcentrationCheckResult[];
  /** True when any check failed, which means the spell is lost. */
  lost: boolean;
  issues: PF1eCastingIssue[];
}

/** Resolves every applicable Table 9-1 check. Any single failure loses the spell. */
export function resolveConcentration(input: {
  triggers: readonly PF1eConcentrationTrigger[];
  spellLevel: number;
  casterLevel: number;
  keyAbilityMod: number;
  featBonus?: number | undefined;
}): PF1eConcentrationResult {
  const { bonus, issues } = concentrationBonus({
    casterLevel: input.casterLevel,
    keyAbilityMod: input.keyAbilityMod,
    featBonus: input.featBonus,
  });
  if (issues.length > 0) return { checks: [], lost: false, issues };
  const checks: PF1eConcentrationCheckResult[] = [];
  const allIssues: PF1eCastingIssue[] = [];
  for (const trigger of input.triggers) {
    const { dc, issues: dcIssues } = concentrationDc(trigger, input.spellLevel);
    if (dcIssues.length > 0) {
      allIssues.push(...dcIssues);
      continue;
    }
    if (!Number.isInteger(trigger.die) || trigger.die < 1 || trigger.die > 20) {
      allIssues.push({
        field: "die",
        message: `d20 face ${String(trigger.die)} is not an integer 1–20 (${trigger.situation})`,
      });
      continue;
    }
    checks.push({
      situation: trigger.situation,
      dc,
      total: trigger.die + bonus,
      passed: trigger.die + bonus >= dc,
    });
  }
  return { checks, lost: checks.some((c) => !c.passed), issues: allIssues };
}

/* ------------------------------------------------------------------ *
 * Casting time → action
 * ------------------------------------------------------------------ */

export interface PF1eCastingAction {
  actionId: string | null;
  category: PF1eActionCategory;
  provokes: PF1eProvokes | null;
  notes: string[];
}

/**
 * Maps a casting time to the Table 7-2 row, reusing `actions.ts` rather than
 * re-encoding the provoke column.
 *
 * - "You can cast a quickened spell…, or any spell whose casting time is designated as
 *   a free or swift action, as a swift action. … Casting a spell as a swift action
 *   doesn't incur an attack of opportunity."
 * - "If a spell's normal casting time is 1 standard action, casting a metamagic version
 *   of the spell is a full-round action for a sorcerer or bard (except for spells
 *   modified by the Quicken Spell feat, which take 1 swift action to cast)."
 *
 * Table 7-2 lists only the 1-standard-action row, so full-round and longer casting
 * times get no provoke answer rather than an invented one.
 */
export function castingAction(input: {
  castingTime: PF1eCastingTime;
  metamagic?: boolean | undefined;
  /** Sorcerers and bards pay a full-round action for metamagic; prepared casters do not. */
  spontaneousCaster?: boolean | undefined;
  quickened?: boolean | undefined;
}): PF1eCastingAction {
  const notes: string[] = [];
  const quickened = input.quickened === true;
  let time = input.castingTime;
  if (quickened) {
    time = "swift";
    notes.push("Quicken Spell: cast as a swift action");
  } else if (input.metamagic === true && input.spontaneousCaster === true) {
    if (time === "standard") {
      time = "full-round";
      notes.push(
        "metamagic for a spontaneous caster: a 1-standard-action spell becomes a full-round action",
      );
    } else if (time === "full-round" || time === "longer") {
      notes.push(
        "metamagic for a spontaneous caster: adds a full-round action to the casting time",
      );
    }
  }
  const row: PF1eActionEntry | null =
    time === "standard"
      ? pf1eActionById("cast-spell")
      : time === "swift" || time === "free"
        ? pf1eActionById("cast-quickened")
        : null;
  if (row === null) {
    return {
      actionId: null,
      category: "full-round",
      provokes: null,
      notes: [
        ...notes,
        `casting time "${time}" has no Table 7-2 row; provocation is not encoded rather than guessed`,
      ],
    };
  }
  return {
    actionId: row.id,
    category: row.category,
    provokes: row.provokes,
    notes,
  };
}

/* ------------------------------------------------------------------ *
 * The combined gate
 * ------------------------------------------------------------------ */

export interface PF1eCastingAttemptInput {
  /** The spell's Components line, e.g. `"V, S, M/DF"`. */
  components: string;
  tradition: PF1eSpellTradition;
  caster: PF1eCasterState;
  castingTime: PF1eCastingTime;
  spellLevel: number;
  armor?: PF1eArcaneSpellFailureGear | undefined;
  shield?: PF1eArcaneSpellFailureGear | undefined;
  /** Percentile roll for arcane spell failure. Required only when the chance is > 0. */
  arcaneDie?: number | undefined;
  /** Percentile roll for the deafened spoilage. Required only when deafened. */
  deafenedDie?: number | undefined;
  triggers?: readonly PF1eConcentrationTrigger[] | undefined;
  casterLevel: number;
  keyAbilityMod: number;
  featBonus?: number | undefined;
}

export interface PF1eCastingAttemptResult {
  /** False only for malformed input; an illegal or lost casting is still a result. */
  ok: boolean;
  error: string | null;
  legal: boolean;
  reasons: string[];
  /** "cast" survives every check; "lost" is ruined; "blocked" could not be attempted. */
  outcome: "cast" | "lost" | "blocked";
  codes: PF1eComponentCode[];
  needs: PF1eComponentNeeds;
  asfChance: number;
  asfFailed: boolean | null;
  deafenedFailed: boolean | null;
  concentration: PF1eConcentrationResult;
  notes: string[];
}

/**
 * Runs the whole pre-save gate. Every stage is evaluated and reported even after one
 * has already lost the spell, because which check failed is what the table needs to
 * show; the outcome is `lost` if any of them failed.
 */
export function resolveCastingAttempt(
  input: PF1eCastingAttemptInput,
): PF1eCastingAttemptResult {
  const notes: string[] = [];
  const parsed = parseSpellComponents(input.components);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.issues.map((i) => `${i.field}: ${i.message}`).join("; "),
      legal: false,
      reasons: [],
      outcome: "blocked",
      codes: [],
      needs: {
        codes: [],
        mustSpeak: false,
        needsFreeHand: false,
        mustManipulateComponents: false,
      },
      asfChance: 0,
      asfFailed: null,
      deafenedFailed: null,
      concentration: { checks: [], lost: false, issues: [] },
      notes,
    };
  }
  if (!(PF1E_CASTING_TIMES as readonly string[]).includes(input.castingTime)) {
    return {
      ok: false,
      error: `castingTime "${String(input.castingTime)}" is not one of ${PF1E_CASTING_TIMES.join(", ")}`,
      legal: false,
      reasons: [],
      outcome: "blocked",
      codes: [],
      needs: {
        codes: [],
        mustSpeak: false,
        needsFreeHand: false,
        mustManipulateComponents: false,
      },
      asfChance: 0,
      asfFailed: null,
      deafenedFailed: null,
      concentration: { checks: [], lost: false, issues: [] },
      notes,
    };
  }
  const needs = componentNeeds(parsed.segments, input.tradition);
  const legality = checkCastingLegality({
    needs,
    caster: input.caster,
    castingTime: input.castingTime,
  });
  if (!legality.legal) {
    return {
      ok: true,
      error: null,
      legal: false,
      reasons: legality.reasons,
      outcome: "blocked",
      codes: needs.codes,
      needs,
      asfChance: 0,
      asfFailed: null,
      deafenedFailed: null,
      concentration: { checks: [], lost: false, issues: [] },
      notes,
    };
  }

  let lost = false;

  // Arcane spell failure.
  const asf = arcaneSpellFailureChance({
    armor: input.armor,
    shield: input.shield,
    hasSomatic: needs.needsFreeHand,
  });
  if (asf.issues.length > 0) {
    return {
      ok: false,
      error: asf.issues.map((i) => `${i.field}: ${i.message}`).join("; "),
      legal: true,
      reasons: [],
      outcome: "blocked",
      codes: needs.codes,
      needs,
      asfChance: 0,
      asfFailed: null,
      deafenedFailed: null,
      concentration: { checks: [], lost: false, issues: [] },
      notes,
    };
  }
  let asfFailed: boolean | null = null;
  if (asf.applies) {
    if (input.arcaneDie === undefined) {
      notes.push(
        `arcane spell failure ${asf.chance}% applies but no d100 was rolled`,
      );
    } else {
      const roll = resolveArcaneSpellFailure({
        die: input.arcaneDie,
        chance: asf.chance,
      });
      if (roll.issues.length > 0) {
        return {
          ok: false,
          error: roll.issues.map((i) => `${i.field}: ${i.message}`).join("; "),
          legal: true,
          reasons: [],
          outcome: "blocked",
          codes: needs.codes,
          needs,
          asfChance: asf.chance,
          asfFailed: null,
          deafenedFailed: null,
          concentration: { checks: [], lost: false, issues: [] },
          notes,
        };
      }
      asfFailed = roll.failed;
      if (asfFailed === true) {
        lost = true;
        notes.push(
          `arcane spell failure: rolled ${input.arcaneDie} against ${asf.chance}% — the spell is ruined`,
        );
      }
    }
  }

  // Deafened spoilage on a verbal component.
  let deafenedFailed: boolean | null = null;
  if (input.caster.deafened === true && needs.mustSpeak) {
    if (input.deafenedDie === undefined) {
      notes.push(
        `deafened: ${PF1E_DEAFENED_SPOIL_PERCENT}% spoilage applies but no d100 was rolled`,
      );
    } else {
      const spoil = resolveDeafenedSpoilage(input.deafenedDie);
      if (spoil.issues.length > 0) {
        return {
          ok: false,
          error: spoil.issues.map((i) => `${i.field}: ${i.message}`).join("; "),
          legal: true,
          reasons: [],
          outcome: "blocked",
          codes: needs.codes,
          needs,
          asfChance: asf.chance,
          asfFailed,
          deafenedFailed: null,
          concentration: { checks: [], lost: false, issues: [] },
          notes,
        };
      }
      deafenedFailed = spoil.spoiled;
      if (deafenedFailed === true) {
        lost = true;
        notes.push("deafened: the verbal component is spoiled");
      }
    }
  }

  // Concentration.
  const concentration = resolveConcentration({
    triggers: input.triggers ?? [],
    spellLevel: input.spellLevel,
    casterLevel: input.casterLevel,
    keyAbilityMod: input.keyAbilityMod,
    featBonus: input.featBonus,
  });
  if (concentration.issues.length > 0) {
    return {
      ok: false,
      error: concentration.issues
        .map((i) => `${i.field}: ${i.message}`)
        .join("; "),
      legal: true,
      reasons: [],
      outcome: "blocked",
      codes: needs.codes,
      needs,
      asfChance: asf.chance,
      asfFailed,
      deafenedFailed,
      concentration,
      notes,
    };
  }
  if (concentration.lost) {
    lost = true;
    const failed = concentration.checks
      .filter((c) => !c.passed)
      .map((c) => `${c.situation} (${c.total} vs DC ${c.dc})`)
      .join(", ");
    notes.push(
      `concentration failed on ${failed} — the spell is lost as if cast to no effect`,
    );
  }

  return {
    ok: true,
    error: null,
    legal: true,
    reasons: [],
    outcome: lost ? "lost" : "cast",
    codes: needs.codes,
    needs,
    asfChance: asf.chance,
    asfFailed,
    deafenedFailed,
    concentration,
    notes,
  };
}
