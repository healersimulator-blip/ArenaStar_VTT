/**
 * PF1e **attack resolution** (P3/A06, second slice) — the pure composition of
 * the A02/A03/A05 resolver layers around one derived attack line rolling
 * against one derived defender. No dice are rolled here and no store is
 * touched: the caller supplies the natural d20 faces and the evaluated damage
 * total (the chat flow gets them from the host-evaluated roll messages), and
 * this module decides hit/threat/confirm, applies the minimum-damage rule,
 * mitigates through the defender's DR/ER, and computes the authoritative HP
 * writes plus the condition annotations the card shows.
 *
 * Every layer is reused, never re-derived: `resolveAttackRoll` (A02),
 * `confirmCritical` (A03), `situationalAttackParts`/`damageIntentPenaltyPart`
 * (A02/D-135/D-136 — the numbers live once, in tactical.ts),
 * `damageComponentsFromRoll` + `applyMitigation` (A05). What this module adds
 * is the seam those layers lack: they consume weapon descriptors and modifier
 * stacks, while a derived attack line already **is** the stack — so the
 * composition works from `PF1eDerived` on both sides of the attack.
 *
 * Rules verified against primary texts before encoding (all recorded in
 * DECISIONS D-140):
 * - **Defense selection** (CRB p.179 ff./A.2): touch attacks (rays, splash
 *   weapons, touch spells) resolve against touch AC; the caller picks normal
 *   or flat-footed otherwise. The derivation owns the 22/16/17 trio.
 * - **Minimum damage** (CRB p.179, Gap List 2.3): a hit whose damage total is
 *   below 1 still deals **1 point of nonlethal damage** — lethal intent does
 *   not change that (D-136/A03 encode the same rule).
 * - **Nonlethal accumulation** (CRB p.191, AoN Rules ID 172): nonlethal damage
 *   is never deducted from hit points; at nonlethal == current HP the creature
 *   is staggered, above it unconscious; and when a creature's nonlethal damage
 *   is at its **total maximum** hit points, further nonlethal damage is treated
 *   as lethal — except for creatures with regeneration, which simply accrue.
 * - **Loss of hit points** (CRB p.189, AoN Rules ID 165–168): at exactly 0 HP
 *   disabled (staggered); below 0 unconscious and dying (losing 1 HP per
 *   round); dead when the negative total reaches the Constitution score. The
 *   stable/dying bookkeeping itself is P7 — this module only annotates.
 *
 * Deliberately not encoded here: defender critical-hit immunity and energy
 * immunity/vulnerability (no authored field exists on actors yet — E03/P4 own
 * the condition side, and A05's flags light up when authoring lands), DR
 * bypass facts beyond the mundane default (derived attack lines carry no
 * weapon descriptor — `attackFacts` is the seam for the A07/Weapons wiring),
 * precision/energy riders (a derived line has none), and any interrupt
 * resolution (the unarmed provocation is a note only — P6 owns the AoO queue).
 */
import type {
  PF1eAttackRollResult,
  PF1eSituationalModifiers,
} from "./tactical";
import {
  confirmCritical,
  resolveAttackRoll,
  situationalAttackParts,
  damageIntentPenaltyPart,
} from "./tactical";
import type {
  PF1eDrAttackFacts,
  PF1eMitigationDefender,
  PF1eMitigationResult,
} from "./mitigation";
import { applyMitigation, damageComponentsFromRoll } from "./mitigation";
import type { PF1ePhysicalDamageType } from "./weapons";

/** Which of the derived AC trio the attack resolves against. */
export type PF1eDefenseChoice = "normal" | "touch" | "flatFooted";

/**
 * The defender, straight off `derivePF1eActor` plus the A05 mitigation fields
 * the caller can honestly supply. Energy immunities/vulnerabilities and
 * physical immunity have no authored source yet and stay absent until E03.
 */
export interface PF1eResolveDefender extends PF1eMitigationDefender {
  name: string;
  ac: { normal: number; touch: number; flatFooted: number };
  hp: number;
  hpMax: number;
  nonlethalDamage: number;
  /** Constitution score — dead at a negative total equal to it (CRB p.189). */
  conScore?: number | undefined;
  /**
   * Regeneration > 0: the nonlethal-at-max conversion never applies (CRB
   * p.191 — "This does not apply to creatures with regeneration").
   */
  regeneration?: number | undefined;
}

/** One derived attack line, as `PF1eDerivedAttack` provides it. */
export interface PF1eResolveAttack {
  label: string;
  /** The derived bonus of the iterative being rolled (ability/size/effects included). */
  bonus: number;
  critThreatMin: number;
  critMultiplier: number;
  /** Touch attacks (rays, splash, touch spells) force touch AC (A.2). */
  touchAttack?: boolean | undefined;
  ranged?: boolean | undefined;
  /** Authored damage-type string ("slashing", "piercing nonlethal", …). */
  damageType?: string | undefined;
}

export interface PF1eResolveAttackInput {
  attack: PF1eResolveAttack;
  /** The natural d20 face of the attack roll. */
  die: number;
  defense: PF1eDefenseChoice;
  defender: PF1eResolveDefender;
  situational?: PF1eSituationalModifiers | undefined;
  /**
   * The damage lands nonlethal. Defaults to the line's authored damageType
   * carrying "nonlethal"; an explicit choice that swaps the line's natural
   * bucket takes the CRB p.191 −4 (IUS waives it for unarmed strikes only).
   */
  nonlethalDamage?: boolean | undefined;
  /** The line is an unarmed strike (for the IUS waiver on the lethal swap). */
  unarmed?: boolean | undefined;
  /** Attacker feats, for the IUS waiver (same ids as `PF1eAttackRollContext`). */
  feats?: readonly string[] | undefined;
  /** Required when the attack threatened: the natural d20 face of the confirmation roll. */
  confirmDie?: number | undefined;
  /**
   * The evaluated damage total — the normal damage formula, or the crit
   * formula's N-group total (D-139) when the threat confirmed. A total below
   * 1 still deals 1 nonlethal (CRB p.179).
   */
  damageTotal: number;
  /**
   * DR bypass facts. Derived attack lines carry no weapon descriptor, so the
   * default is a mundane weapon of the line's damage type — magic/material/
   * alignment facts arrive here when the Weapons-tab linkage exists (A07+).
   */
  attackFacts?: PF1eDrAttackFacts | undefined;
  /** The attack provokes an AoO (the unarmed fallback without IUS) — note only, P6 owns the interrupt. */
  provokes?: boolean | undefined;
}

export type PF1eResolveResult =
  | { ok: false; error: string }
  | {
      ok: true;
      outcome: "miss" | "hit" | "crit";
      /** die + final bonus, what the chat card shows. */
      attackTotal: number;
      /** The derived bonus plus situational and intent deltas. */
      attackBonus: number;
      situationalDelta: number;
      intentPenalty: number;
      /** The defense actually used (a touch attack overrides the choice). */
      defenseUsed: PF1eDefenseChoice;
      defenseAc: number;
      threat: boolean;
      confirmed: boolean;
      damage: {
        /** The raw evaluated formula total, pre-minimum. */
        rolled: number;
        /** True when rolled < 1 and the 1-nonlethal minimum applied. */
        minimumApplied: boolean;
        /** Total damage dealt after mitigation. */
        dealt: number;
        lethal: number;
        nonlethal: number;
        drApplied: number;
        drBypassedVia: string | null;
        /** Nonlethal that converted to lethal at the max-HP boundary (CRB p.191). */
        convertedToLethal: number;
        notes: string[];
      } | null;
      /** HP before/after the write (equal on a miss). */
      hp: { before: number; after: number };
      /** Nonlethal damage before/after (never deducted from HP, CRB p.191). */
      nonlethal: { before: number; after: number };
      /** Condition annotations (dead/dying/disabled/unconscious/staggered) — P7 owns the writes. */
      conditionNotes: string[];
      notes: string[];
      provokes: boolean;
    };

/** Parse a physical damage type out of an authored damage-type string. */
function parseDamageType(raw: string | undefined): {
  type: PF1ePhysicalDamageType;
  nonlethal: boolean;
} {
  const text = raw ?? "";
  const lower = text.toLowerCase();
  const type: PF1ePhysicalDamageType = lower.includes("slashing")
    ? "slashing"
    : lower.includes("piercing")
      ? "piercing"
      : "bludgeoning";
  return { type, nonlethal: lower.includes("nonlethal") };
}

/** The successful half of A02's result (prepare has already rejected the error case). */
type ResolvedAttackRoll = Extract<PF1eAttackRollResult, { ok: true }>;

/**
 * Compose one attack's full resolution (see `pf1eResolveAttack`). This type is
 * everything decidable before damage is rolled.
 */
export type PF1ePrepareResult =
  | {
      ok: true;
      /** The effective attack bonus (derived + situational + intent). */
      attackBonus: number;
      situationalDelta: number;
      intentPenalty: number;
      defenseUsed: PF1eDefenseChoice;
      defenseAc: number;
      /** The A02 resolution of the attack die. */
      roll: ResolvedAttackRoll;
      /** What the damage half needs: the effective bucket, the physical type
       * for DR facts, and the intent-swap label for the card. */
      damage: {
        nonlethal: boolean;
        physicalType: PF1ePhysicalDamageType;
        intentLabel: string | null;
      };
      /** Outcome-independent notes (touch override, provocation). */
      notes: string[];
    }
  | { ok: false; error: string };

/**
 * The first half of the resolution — everything decidable before damage is
 * rolled. The chat flow uses this to orchestrate: it must know whether the
 * attack hit and threatened before it rolls the confirmation and damage
 * formulas, and it needs the effective bonus for the confirmation formula
 * ("another attack roll with all the same modifiers", CRB p.182).
 * `pf1eResolveAttack` runs the same code, so the halves cannot disagree.
 */
export function pf1eResolvePrepare(
  input: Omit<PF1eResolveAttackInput, "confirmDie" | "damageTotal">,
): PF1ePrepareResult {
  const notes: string[] = [];
  const { attack, defender } = input;

  for (const [field, value] of [
    ["hp", defender.hp],
    ["hpMax", defender.hpMax],
    ["nonlethalDamage", defender.nonlethalDamage],
  ] as const) {
    if (!Number.isInteger(value)) {
      return {
        ok: false,
        error: `defender.${field} = ${String(value)} is not an integer`,
      };
    }
  }
  if (defender.hpMax < 1) {
    return {
      ok: false,
      error: `defender.hpMax = ${String(defender.hpMax)} must be at least 1`,
    };
  }
  if (defender.nonlethalDamage < 0) {
    return {
      ok: false,
      error: `defender.nonlethalDamage = ${String(defender.nonlethalDamage)} is negative`,
    };
  }

  // Defense selection: the derived trio is authoritative; a touch attack
  // overrides whatever the caller picked (CRB p.179/A.2).
  const wanted =
    input.defense === "touch"
      ? "touch"
      : input.defense === "flatFooted"
        ? "flatFooted"
        : "normal";
  const defenseUsed: PF1eDefenseChoice =
    attack.touchAttack === true && wanted !== "touch" ? "touch" : wanted;
  if (attack.touchAttack === true && wanted !== "touch") {
    notes.push("touch attack — resolves against touch AC regardless of choice");
  }
  const defenseAc =
    defenseUsed === "touch"
      ? defender.ac.touch
      : defenseUsed === "flatFooted"
        ? defender.ac.flatFooted
        : defender.ac.normal;

  // The modifier deltas on top of the derived line (numbers live in tactical.ts).
  const sitParts = situationalAttackParts(input.situational);
  const situationalDelta = sitParts.reduce((sum, part) => sum + part.value, 0);
  const parsedType = parseDamageType(attack.damageType);
  // An unarmed strike deals nonlethal damage by default even though its
  // derived damageType string ("bludgeoning") does not say so (AoN ID 131).
  const naturalNonlethal = parsedType.nonlethal || input.unarmed === true;
  const effectiveNonlethal = input.nonlethalDamage ?? naturalNonlethal;
  const intentPenaltyPart = damageIntentPenaltyPart({
    weaponNonlethal: naturalNonlethal,
    ...(input.unarmed === true ? { unarmed: true } : {}),
    ...(input.feats?.includes("improved-unarmed-strike")
      ? { improvedUnarmedStrike: true }
      : {}),
    // An explicit nonlethal choice against a naturally lethal line is the CRB p.191 swap.
    ...(effectiveNonlethal && !naturalNonlethal
      ? { nonlethalIntent: true }
      : {}),
    // A lethal choice against a naturally nonlethal line (sap, unarmed) is the mirror swap.
    ...(!effectiveNonlethal && naturalNonlethal ? { lethalIntent: true } : {}),
  });
  const intentPenalty = intentPenaltyPart?.value ?? 0;
  const attackBonus = attack.bonus + situationalDelta + intentPenalty;

  // The unarmed provocation is outcome-independent — P6 owns the interrupt.
  if (input.provokes === true) {
    notes.push(
      "⚠ provokes an attack of opportunity from the target — the interrupt resolution is P6",
    );
  }

  const roll: PF1eAttackRollResult = resolveAttackRoll({
    die: input.die,
    bonus: attackBonus,
    ac: defenseAc,
    ...(attack.critThreatMin !== 20
      ? { critThreatMin: attack.critThreatMin }
      : {}),
  });
  if (!roll.ok) return { ok: false, error: roll.error };

  return {
    ok: true,
    attackBonus,
    situationalDelta,
    intentPenalty,
    defenseUsed,
    defenseAc,
    roll,
    /** What the damage half needs from this half: the effective bucket, the
     * physical type for DR facts, and the intent-swap label for the card. */
    damage: {
      nonlethal: effectiveNonlethal,
      physicalType: parsedType.type,
      intentLabel: intentPenaltyPart === null ? null : intentPenaltyPart.label,
    },
    notes,
  };
}

/**
 * Compose one attack's full resolution. Pure: same inputs ⇒ same outputs, no
 * dice, no store. The caller rolls (or supplies) the d20 faces and the damage
 * total; everything else — defense, threat, confirmation, minimum damage,
 * DR/ER, the nonlethal boundary conversion and the resulting HP writes — is
 * decided here with named notes for the chat card.
 */
export function pf1eResolveAttack(
  input: PF1eResolveAttackInput,
): PF1eResolveResult {
  if (!Number.isInteger(input.damageTotal)) {
    return {
      ok: false,
      error: `damageTotal = ${String(input.damageTotal)} is not an integer`,
    };
  }
  const prepared = pf1eResolvePrepare(input);
  if (!prepared.ok) return { ok: false, error: prepared.error };
  const { attack, defender } = input;
  const { attackBonus, defenseAc, roll, notes } = prepared;
  const preparedFields = {
    attackBonus,
    situationalDelta: prepared.situationalDelta,
    intentPenalty: prepared.intentPenalty,
    defenseUsed: prepared.defenseUsed,
    defenseAc,
    threat: roll.threat,
  };

  if (!roll.hits) {
    return {
      ok: true,
      outcome: "miss",
      attackTotal: input.die + attackBonus,
      ...preparedFields,
      threat: false,
      confirmed: false,
      damage: null,
      hp: { before: defender.hp, after: defender.hp },
      nonlethal: {
        before: defender.nonlethalDamage,
        after: defender.nonlethalDamage,
      },
      conditionNotes: [],
      notes,
      provokes: input.provokes === true,
    };
  }

  // Threat ⇒ a confirmation roll is mandatory (CRB p.182): leaving it out is a
  // caller bug, not a rules state.
  let confirmed = false;
  if (roll.threat) {
    if (input.confirmDie === undefined || !Number.isInteger(input.confirmDie)) {
      return {
        ok: false,
        error:
          "the attack threatened — confirmDie (the confirmation d20 face) is required",
      };
    }
    const confirm = confirmCritical({
      die: input.confirmDie,
      attackBonus,
      ac: defenseAc,
    });
    if (!confirm.ok) return { ok: false, error: confirm.error };
    confirmed = confirm.confirmed;
  }
  // A multiplier below 2 is the resolver's clamped domain (D-139) — a
  // "confirmed" crit on such a line is scored as a normal hit.
  let crit = confirmed;
  if (crit && !(attack.critMultiplier >= 2)) {
    crit = false;
    notes.push(
      `critMultiplier ${String(attack.critMultiplier)} is below 2 — the confirmed threat scores as a normal hit`,
    );
  }

  // Minimum damage (CRB p.179/Gap List 2.3): below 1 ⇒ 1 point of nonlethal.
  const minimumApplied = input.damageTotal < 1;
  const dealtRaw = minimumApplied ? 1 : input.damageTotal;
  if (minimumApplied) {
    notes.push(
      `damage total ${String(input.damageTotal)} is below 1 — deals 1 point of nonlethal damage`,
    );
  }
  const damageNonlethal = prepared.damage.nonlethal || minimumApplied;
  if (prepared.damage.intentLabel !== null) {
    notes.push(
      `${prepared.damage.intentLabel}: ${String(prepared.intentPenalty)} on the attack roll`,
    );
  }

  // One physical weapon component (a derived line carries no riders); A05 owns
  // DR/ER and the mixed-bucket allocation, including DR negating the minimum.
  const facts: PF1eDrAttackFacts = input.attackFacts ?? {
    enhancementBonus: 0,
    effectiveBonusTotal: 0,
    material: "none",
    alignment: [],
    damageType: prepared.damage.physicalType,
    name: attack.label,
  };
  if (input.attackFacts === undefined) {
    notes.push(
      "DR facts: mundane weapon of the line's damage type (derived attack lines carry no weapon descriptor)",
    );
  }
  const components = damageComponentsFromRoll({
    weaponContribution: {
      lethal: damageNonlethal ? 0 : dealtRaw,
      nonlethal: damageNonlethal ? dealtRaw : 0,
    },
    bonusContributions: [],
  });
  const mitigation: PF1eMitigationResult = applyMitigation({
    attack: facts,
    components,
    defender,
    ...(attack.ranged === true && defender.object !== undefined
      ? { rangedWeaponAgainstObject: true }
      : {}),
  });
  if (!mitigation.ok) return { ok: false, error: mitigation.error };
  notes.push(...mitigation.notes);

  // HP writes. Lethal damage subtracts; nonlethal accumulates and converts to
  // lethal above the max-HP boundary unless the creature regenerates (CRB p.191).
  let lethalDealt = mitigation.lethal;
  let nonlethalDealt = mitigation.nonlethal;
  let convertedToLethal = 0;
  if (
    nonlethalDealt > 0 &&
    (defender.regeneration ?? 0) <= 0 &&
    defender.nonlethalDamage >= defender.hpMax
  ) {
    convertedToLethal = nonlethalDealt;
    lethalDealt += nonlethalDealt;
    nonlethalDealt = 0;
    notes.push(
      "nonlethal damage is at the maximum-HP boundary — further nonlethal damage is treated as lethal (CRB p.191)",
    );
  }
  const hpAfter = defender.hp - lethalDealt;
  const nonlethalAfter = defender.nonlethalDamage + nonlethalDealt;

  // Condition annotations (CRB p.189–191/A.13): order matters — the lethal
  // state dominates; the writes themselves are P7's.
  const conditionNotes: string[] = [];
  const con = defender.conScore ?? 0;
  if (hpAfter < 0 && con > 0 && -hpAfter >= con) {
    conditionNotes.push(
      `dead — negative HP (${String(hpAfter)}) reached Constitution ${String(con)} (CRB p.190)`,
    );
  } else if (hpAfter < 0) {
    conditionNotes.push(
      "unconscious and dying (below 0 HP, loses 1 HP per round — the stable/dying bookkeeping is P7)",
    );
  } else if (hpAfter === 0) {
    conditionNotes.push(
      "disabled (staggered at exactly 0 HP; a strenuous standard action costs 1 HP and starts dying)",
    );
  }
  if (hpAfter > 0) {
    if (nonlethalAfter > hpAfter) {
      conditionNotes.push(
        "unconscious — nonlethal damage exceeds current HP (CRB p.191)",
      );
    } else if (nonlethalAfter === hpAfter) {
      conditionNotes.push(
        "staggered — nonlethal damage equals current HP (CRB p.191)",
      );
    }
  }
  return {
    ok: true,
    outcome: crit ? "crit" : "hit",
    attackTotal: input.die + attackBonus,
    ...preparedFields,
    confirmed,
    damage: {
      rolled: input.damageTotal,
      minimumApplied,
      dealt: mitigation.lethal + mitigation.nonlethal,
      lethal: lethalDealt,
      nonlethal: nonlethalDealt,
      drApplied: mitigation.drApplied,
      drBypassedVia: mitigation.drBypassedVia,
      convertedToLethal,
      notes: [...mitigation.notes],
    },
    hp: { before: defender.hp, after: hpAfter },
    nonlethal: {
      before: defender.nonlethalDamage,
      after: nonlethalAfter,
    },
    conditionNotes,
    notes,
    provokes: input.provokes === true,
  };
}

/**
 * Resolve a Manyshot volley against one target. Manyshot is a standard-action
 * volley: every arrow uses the same first attack bonus and −4 penalty, while
 * damage is applied in order to the same defender state. The caller supplies
 * host-evaluated attack/confirmation faces and damage totals for each arrow.
 * Precision/extra-dice rider allocation is deliberately not inferred here;
 * callers must supply each arrow's already-correct damage total.
 */
export interface PF1eManyshotArrow {
  die: number;
  confirmDie?: number | undefined;
  damageTotal: number;
}

export type PF1eManyshotResult =
  | { ok: false; error: string }
  | {
      ok: true;
      arrows: Extract<PF1eResolveResult, { ok: true }>[];
      finalHp: number;
      finalNonlethal: number;
    };

export function pf1eResolveManyshot(input: {
  attack: PF1eResolveAttack;
  arrows: readonly PF1eManyshotArrow[];
  defense: PF1eDefenseChoice;
  defender: PF1eResolveDefender;
  situational?: PF1eSituationalModifiers | undefined;
  nonlethalDamage?: boolean | undefined;
  unarmed?: boolean | undefined;
  feats?: readonly string[] | undefined;
  attackFacts?: PF1eDrAttackFacts | undefined;
  provokes?: boolean | undefined;
}): PF1eManyshotResult {
  if (input.attack.ranged !== true) {
    return { ok: false, error: "Manyshot requires a ranged attack" };
  }
  if (input.arrows.length < 2 || input.arrows.length > 4) {
    return { ok: false, error: "Manyshot requires between 2 and 4 arrows" };
  }
  let defender = { ...input.defender };
  const results: Extract<PF1eResolveResult, { ok: true }>[] = [];
  for (const arrow of input.arrows) {
    const resolved = pf1eResolveAttack({
      attack: input.attack,
      die: arrow.die,
      ...(arrow.confirmDie === undefined ? {} : { confirmDie: arrow.confirmDie }),
      damageTotal: arrow.damageTotal,
      defense: input.defense,
      defender,
      ...(input.situational === undefined ? {} : { situational: input.situational }),
      ...(input.nonlethalDamage === undefined ? {} : { nonlethalDamage: input.nonlethalDamage }),
      ...(input.unarmed === undefined ? {} : { unarmed: input.unarmed }),
      ...(input.feats === undefined ? {} : { feats: input.feats }),
      ...(input.attackFacts === undefined ? {} : { attackFacts: input.attackFacts }),
      ...(input.provokes === undefined ? {} : { provokes: input.provokes }),
    });
    if (!resolved.ok) return resolved;
    results.push(resolved);
    defender = { ...defender, hp: resolved.hp.after, nonlethalDamage: resolved.nonlethal.after };
  }
  return {
    ok: true,
    arrows: results,
    finalHp: defender.hp,
    finalNonlethal: defender.nonlethalDamage,
  };
}
