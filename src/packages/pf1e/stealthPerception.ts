/**
 * C06, C07, C08 — PF1e Stealth, Perception, and Sensory Modes Engine.
 * Pure rules, diceless logic, and spatial queries.
 *
 * Transcribed from authoritative SRD references:
 * - CRB pp.102-103, AoN Skill 26 ("Perception"):
 *   Distance modifier: +1 to Perception DC per 10 feet of distance.
 *   Environmental / condition modifiers:
 *     Favorable conditions (e.g. bright light / stark contrast): -2 DC.
 *     Unfavorable conditions (e.g. dim light / background noise): +2 DC.
 *     Terrible conditions (e.g. darkness / howling wind): +5 DC.
 *     Perceiver through a closed door: +5 DC.
 *     Perceiver through a wall: +10 DC per foot of thickness (or +20 for stone).
 *     Perceiver asleep: +10 DC.
 * - CRB p.106, AoN Skill 30 ("Stealth"):
 *   Creature size modifier to Stealth: Fine +16, Diminutive +12, Tiny +8, Small +4, Medium 0,
 *     Large -4, Huge -8, Gargantuan -12, Colossal -16.
 *   Movement speed penalty: moving > half speed = -5 penalty to Stealth.
 *   Sniping: -20 penalty to Stealth check to hide again after a ranged attack.
 *   Invisibility: +40 bonus to Stealth when stationary, +20 bonus when moving.
 *   Cover / concealment: Improved cover gives +10 bonus to Stealth.
 *   Soft cover: gives +4 AC vs ranged, but specifically provides NO Stealth bonus (AoN 181).
 * - CRB pp.565-568, Bestiary Universal Monster Rules:
 *   Senses:
 *     - "Normal": Standard sight, blocked by darkness, fog, and total cover/walls.
 *     - "Low-Light Vision": Sees twice as far in dim light.
 *     - "Darkvision": Sees in darkness up to range (default 60 ft, up to 120 ft) in black and white.
 *     - "Scent": Detects presence of creatures within 30 ft (60 ft upwind, 15 ft downwind)
 *       regardless of visual line-of-sight/darkness/invisibility, but does NOT grant exact location
 *       unless adjacent (5 ft) or moving as a move action to pinpoint within 5 ft.
 *     - "Tremorsense": Automatically senses location of anything in contact with the ground
 *       within range (e.g. 60 ft); bypasses Stealth and visual concealment/invisibility.
 *     - "Blindsense": Knows square/location of creatures within range without sight; target still
 *       has total concealment (50% miss chance).
 *     - "Blindsight" / "True Seeing": Operates without sight; pinpoint location and ignores
 *       visual concealment (blur 20%, total invisibility 50%).
 *
 * C08 Mass Stealth Aggregation:
 *   Checking Perception vs. Stealth for thousands of models per tick is O(N * M).
 *   Aggregation is done at the Unit level:
 *     - Unit stealth policy: "lowest" (standard SRD march) or "average".
 *     - Hostile units failing Perception checks against an ambushing stealth unit
 *       suffer Flat-Footed AC during the initial ambush round.
 */

import type { PF1eSize, PF1eCoverGrade } from "./rulesTables";

/** Size modifier to Stealth checks (CRB p.106, AoN 30). */
export const PF1E_SIZE_STEALTH_MODIFIERS: Record<PF1eSize, number> = {
  Fine: 16,
  Diminutive: 12,
  Tiny: 8,
  Small: 4,
  Medium: 0,
  Large: -4,
  Huge: -8,
  Gargantuan: -12,
  Colossal: -16,
};

/** Stealth size modifier for a named size (or Medium fallback). */
export function sizeStealthModifier(size: PF1eSize | string | undefined): number {
  if (!size) return 0;
  return PF1E_SIZE_STEALTH_MODIFIERS[size as PF1eSize] ?? 0;
}

/** Environmental hearing/visibility condition modifier to Perception DC (CRB p.102). */
export type PerceptionEnvironment =
  | "favorable"     // -2 DC
  | "normal"        // +0 DC
  | "unfavorable"   // +2 DC (dim light, background chatter)
  | "terrible";     // +5 DC (darkness, howling storm)

export const PERCEPTION_ENVIRONMENT_MODIFIERS: Record<PerceptionEnvironment, number> = {
  favorable: -2,
  normal: 0,
  unfavorable: 2,
  terrible: 5,
};

/** Sensory modes supported in PF1e (CRB & Bestiary). */
export type SensoryModeKind =
  | "normal"
  | "low-light"
  | "darkvision"
  | "scent"
  | "tremorsense"
  | "blindsense"
  | "blindsight"
  | "true-seeing";

export interface SensoryCapability {
  kind: SensoryModeKind;
  /** Maximum sensory range in feet. Null for limitless/normal vision. */
  rangeFt: number | null;
}

/** Detection state: presence (knows someone is near) vs located (knows exact square) vs visually seen. */
export type DetectionAwareness = "none" | "presence" | "located" | "seen";

/** Facts about a stealthed/hidden subject being detected. */
export interface StealthSubjectFacts {
  /** The natural + skill result rolled by the hider. */
  stealthRoll: number;
  /** Size of the hider (applies sizeStealthModifier if not already folded). */
  size?: PF1eSize | string | undefined;
  /** Distance in feet from observer to subject. */
  distanceFt: number;
  /** Cover grade relative to the observer. */
  cover?: PF1eCoverGrade | undefined;
  /** Concealment miss chance (e.g. 0.2 for blur, 0.5 for darkness/fog). */
  concealment?: number | undefined;
  /** Is the subject invisible? */
  invisible?: boolean | undefined;
  /** Was the subject moving when stealthing? */
  moving?: boolean | undefined;
  /** Was the subject moving faster than half speed? (-5 penalty). */
  fastMovement?: boolean | undefined;
  /** Sniping action? (-20 penalty to remain hidden). */
  sniping?: boolean | undefined;
  /** Is the subject in contact with the ground? (Relevant for Tremorsense). */
  grounded?: boolean | undefined;
  /** Wind direction relative to observer: "upwind" (scent range ×2), "downwind" (scent range ×0.5), or "neutral". */
  windRelation?: "upwind" | "downwind" | "neutral" | undefined;
}

/** Facts about the observing creature. */
export interface ObserverPerceptionFacts {
  /** Observer's total Perception check (roll + modifier, or 10 + modifier for passive). */
  perceptionTotal: number;
  /** Sensory capabilities available to this observer. */
  senses?: readonly SensoryCapability[] | undefined;
  /** Is observer asleep? (+10 DC). */
  asleep?: boolean | undefined;
  /** Environmental conditions. */
  environment?: PerceptionEnvironment | undefined;
  /** Through a closed door? (+5 DC). */
  throughDoor?: boolean | undefined;
}

/** Calculated DC breakdown for detecting a stealthed subject. */
export interface PerceptionDcBreakdown {
  baseStealthRoll: number;
  sizeMod: number;
  movementPenalty: number;
  snipingPenalty: number;
  invisibilityBonus: number;
  coverBonus: number;
  effectiveStealth: number;
  distanceMod: number;
  environmentMod: number;
  perceiverConditionMod: number;
  totalPerceptionDc: number;
}

/**
 * Calculates the exact Perception DC to notice a stealthed subject per CRB rules.
 *
 * Distance penalty: +1 DC per 10 feet (floor(dist / 10)).
 * Cover: Improved cover grants +10 Stealth bonus. Soft cover grants 0 Stealth bonus (AoN 181).
 * Invisibility: +40 stationary, +20 moving.
 * Speed: > half speed is -5 penalty. Sniping is -20 penalty.
 */
export function calculatePerceptionDc(subject: StealthSubjectFacts, observer?: ObserverPerceptionFacts): PerceptionDcBreakdown {
  const sizeMod = 0; // Usually already part of the skill check on the sheet, or 0. If caller specifies, caller controls base.
  let movementPenalty = 0;
  if (subject.fastMovement) movementPenalty -= 5;

  let snipingPenalty = 0;
  if (subject.sniping) snipingPenalty -= 20;

  let invisibilityBonus = 0;
  if (subject.invisible) {
    invisibilityBonus = subject.moving ? 20 : 40;
  }

  // Cover bonus to Stealth: only improved cover grants +10 (rulesTables.ts / AoN 181). Soft cover provides NO Stealth bonus.
  let coverBonus = 0;
  if (subject.cover === "improved") {
    coverBonus = 10;
  }

  const effectiveStealth = Math.max(
    0,
    subject.stealthRoll + movementPenalty + snipingPenalty + invisibilityBonus + coverBonus,
  );

  // Distance penalty to Perception: +1 per 10 feet
  const distanceMod = Math.max(0, Math.floor(subject.distanceFt / 10));

  let environmentMod = 0;
  if (observer?.environment) {
    environmentMod = PERCEPTION_ENVIRONMENT_MODIFIERS[observer.environment] ?? 0;
  }

  let perceiverConditionMod = 0;
  if (observer?.asleep) perceiverConditionMod += 10;
  if (observer?.throughDoor) perceiverConditionMod += 5;

  const totalPerceptionDc = effectiveStealth + distanceMod + environmentMod + perceiverConditionMod;

  return {
    baseStealthRoll: subject.stealthRoll,
    sizeMod,
    movementPenalty,
    snipingPenalty,
    invisibilityBonus,
    coverBonus,
    effectiveStealth,
    distanceMod,
    environmentMod,
    perceiverConditionMod,
    totalPerceptionDc,
  };
}

/** Result of an observer evaluating a stealthed subject. */
export interface DetectionResult {
  awareness: DetectionAwareness;
  /** Did a visual or sensory check meet or exceed the DC? */
  detected: boolean;
  /** Did any special sensory mode bypass normal stealth? */
  bypassedBySense: SensoryModeKind | null;
  /** The Perception DC evaluated against. */
  dc: number;
  /** Observer's Perception check total. */
  perceptionTotal: number;
  /** Margin of success or failure (perceptionTotal - dc). */
  margin: number;
  /** Effective miss chance for targeting (0 = clear, 0.2 = blur/dim, 0.5 = invisible/darkness). */
  targetingMissChance: number;
  /** Is the target legally targetable for direct attacks/spells? */
  isTargetable: boolean;
  /** Descriptive audit note. */
  notes: string[];
}

/**
 * Evaluates whether an observer detects a stealthed target, taking sensory modes into account.
 * Distinguishes "presence" (Scent) from "located" (Tremorsense / Blindsense / heard) and "seen" (visual / Blindsight).
 */
export function evaluateDetection(
  subject: StealthSubjectFacts,
  observer: ObserverPerceptionFacts,
): DetectionResult {
  const breakdown = calculatePerceptionDc(subject, observer);
  const dc = breakdown.totalPerceptionDc;
  const pTotal = observer.perceptionTotal;
  const margin = pTotal - dc;
  const senses = observer.senses ?? [{ kind: "normal", rangeFt: null }];
  const notes: string[] = [];

  // Check special non-visual sensory modes first:
  // 1. Tremorsense: automatically senses location of anything grounded within range. Bypasses Stealth & Invisibility.
  const tremorsense = senses.find((s) => s.kind === "tremorsense");
  if (tremorsense) {
    const range = tremorsense.rangeFt ?? 60;
    if (subject.distanceFt <= range && subject.grounded !== false) {
      notes.push(`Tremorsense (${range} ft) pinpoints grounded subject at ${subject.distanceFt} ft.`);
      return {
        awareness: "located",
        detected: true,
        bypassedBySense: "tremorsense",
        dc,
        perceptionTotal: pTotal,
        margin: Math.max(0, margin),
        targetingMissChance: subject.invisible ? 0.5 : (subject.concealment ?? 0),
        isTargetable: true,
        notes,
      };
    }
  }

  // 2. Blindsight / True Seeing: operates without sight or sees true form. Pinpoints location and ignores visual concealment/invisibility.
  const blindsight = senses.find((s) => s.kind === "blindsight" || s.kind === "true-seeing");
  if (blindsight) {
    const range = blindsight.rangeFt ?? 60;
    if (subject.distanceFt <= range) {
      notes.push(`${blindsight.kind} (${range} ft) fully detects subject, ignoring visual concealment.`);
      return {
        awareness: "seen",
        detected: true,
        bypassedBySense: blindsight.kind,
        dc,
        perceptionTotal: pTotal,
        margin: Math.max(0, margin),
        targetingMissChance: 0, // Ignores blur & invisibility
        isTargetable: true,
        notes,
      };
    }
  }

  // 3. Blindsense: knows square/location of creatures within range, but target still has total concealment (50%).
  const blindsense = senses.find((s) => s.kind === "blindsense");
  if (blindsense) {
    const range = blindsense.rangeFt ?? 30;
    if (subject.distanceFt <= range) {
      notes.push(`Blindsense (${range} ft) locates subject square; subject retains 50% total concealment.`);
      return {
        awareness: "located",
        detected: true,
        bypassedBySense: "blindsense",
        dc,
        perceptionTotal: pTotal,
        margin: Math.max(0, margin),
        targetingMissChance: 0.5,
        isTargetable: true,
        notes,
      };
    }
  }

  // 4. Scent: detects presence within 30 ft (60 ft upwind, 15 ft downwind). Does NOT pinpoint location unless <= 5 ft.
  const scent = senses.find((s) => s.kind === "scent");
  if (scent) {
    let scentRange = scent.rangeFt ?? 30;
    if (subject.windRelation === "upwind") scentRange *= 2;
    else if (subject.windRelation === "downwind") scentRange = Math.max(5, Math.floor(scentRange / 2));

    if (subject.distanceFt <= scentRange) {
      if (subject.distanceFt <= 5) {
        notes.push(`Scent (${scentRange} ft) pinpoints adjacent subject at ${subject.distanceFt} ft.`);
        return {
          awareness: "located",
          detected: true,
          bypassedBySense: "scent",
          dc,
          perceptionTotal: pTotal,
          margin: Math.max(0, margin),
          targetingMissChance: subject.invisible ? 0.5 : (subject.concealment ?? 0),
          isTargetable: true,
          notes,
        };
      } else {
        notes.push(`Scent detects presence of creature within ${scentRange} ft (cannot pinpoint exact square beyond 5 ft).`);
        // If normal Perception also succeeds, it may locate; otherwise Scent gives presence only
        if (pTotal < dc) {
          return {
            awareness: "presence",
            detected: true,
            bypassedBySense: "scent",
            dc,
            perceptionTotal: pTotal,
            margin,
            targetingMissChance: 0.5,
            isTargetable: false, // Cannot directly target a square from presence alone without pinpointing
            notes,
          };
        }
      }
    }
  }

  // 5. Standard Perception vs Stealth check
  if (pTotal >= dc) {
    // Check vision range/darkness limitations for "seen" vs "located"
    const isDarkness = observer.environment === "terrible";
    const darkvision = senses.find((s) => s.kind === "darkvision");
    const hasDarkvisionInRange = darkvision && (darkvision.rangeFt === null || subject.distanceFt <= darkvision.rangeFt);

    let awareness: DetectionAwareness = "seen";
    let targetingMissChance = subject.concealment ?? 0;

    if (subject.invisible) {
      // Perceived an invisible creature: you know its location (heard footsteps/rustling), but it still has 50% total concealment!
      awareness = "located";
      targetingMissChance = 0.5;
      notes.push(`Perception beat Stealth DC (${pTotal} >= ${dc}); heard/noticed invisible subject location (50% miss chance).`);
    } else if (isDarkness && !hasDarkvisionInRange) {
      // In darkness without darkvision: noticed location, but total darkness confers 50% miss chance
      awareness = "located";
      targetingMissChance = 0.5;
      notes.push(`Perception beat Stealth DC in darkness; located subject by sound (50% miss chance).`);
    } else {
      notes.push(`Perception beat Stealth DC (${pTotal} >= ${dc}); visually spotted subject.`);
    }

    return {
      awareness,
      detected: true,
      bypassedBySense: null,
      dc,
      perceptionTotal: pTotal,
      margin,
      targetingMissChance,
      isTargetable: true,
      notes,
    };
  }

  // Failed to detect
  notes.push(`Failed Perception check (${pTotal} < DC ${dc}). Subject remains undetected.`);
  return {
    awareness: "none",
    detected: false,
    bypassedBySense: null,
    dc,
    perceptionTotal: pTotal,
    margin,
    targetingMissChance: 0.5,
    isTargetable: false,
    notes,
  };
}

// ─── C08: Mass Stealth Aggregation ─────────────────────────────────────────────

export type MassStealthPolicy = "lowest" | "average";

export interface MassStealthUnit {
  unitId: string;
  policy: MassStealthPolicy;
  /** Individual stealth values or rolls for models in the unit. */
  stealthRolls: readonly number[];
  /** Unit distance to target observer/enemy unit in feet. */
  distanceFt: number;
  /** Cover grade of the formation. */
  cover?: PF1eCoverGrade | undefined;
  /** Is the entire formation invisible? */
  invisible?: boolean | undefined;
}

/** Aggregate stealth score of a mass unit based on unit policy. */
export function aggregateUnitStealth(unit: MassStealthUnit): number {
  if (unit.stealthRolls.length === 0) return 0;
  if (unit.policy === "lowest") {
    return Math.min(...unit.stealthRolls);
  }
  const sum = unit.stealthRolls.reduce((a, b) => a + b, 0);
  return Math.round(sum / unit.stealthRolls.length);
}

export interface UnitAmbushVerdict {
  unitId: string;
  ambushSuccess: boolean;
  effectiveUnitStealth: number;
  perceptionDc: number;
  observerPerception: number;
  notes: string[];
}

/**
 * Evaluates whether an ambushing unit surprises a defending observer unit.
 * If ambush succeeds, the defending unit is caught flat-footed during the ambush round.
 */
export function evaluateUnitAmbush(
  ambusher: MassStealthUnit,
  observerPerception: number,
  observerEnvironment: PerceptionEnvironment = "normal",
): UnitAmbushVerdict {
  const effectiveStealth = aggregateUnitStealth(ambusher);
  const dcBreakdown = calculatePerceptionDc(
    {
      stealthRoll: effectiveStealth,
      distanceFt: ambusher.distanceFt,
      cover: ambusher.cover,
      invisible: ambusher.invisible,
    },
    {
      perceptionTotal: observerPerception,
      environment: observerEnvironment,
    },
  );

  const notes: string[] = [];
  const ambushSuccess = observerPerception < dcBreakdown.totalPerceptionDc;
  if (ambushSuccess) {
    notes.push(
      `Ambush succeeded! Observer Perception ${observerPerception} failed against unit stealth DC ${dcBreakdown.totalPerceptionDc} (policy: ${ambusher.policy}). Defenders caught Flat-Footed.`,
    );
  } else {
    notes.push(
      `Ambush detected! Observer Perception ${observerPerception} met or beat unit stealth DC ${dcBreakdown.totalPerceptionDc}. Defenders are aware.`,
    );
  }

  return {
    unitId: ambusher.unitId,
    ambushSuccess,
    effectiveUnitStealth: effectiveStealth,
    perceptionDc: dcBreakdown.totalPerceptionDc,
    observerPerception,
    notes,
  };
}
