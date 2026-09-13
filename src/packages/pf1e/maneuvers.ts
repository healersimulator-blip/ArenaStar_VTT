/**
 * P05/D-199 — the combat manœuvre check, the shared CMB-vs-CMD layer all of
 * A.9's manœuvres resolve through, plus **sunder** as the first composed
 * consumer (its item arithmetic already lives in `items.ts`). Gap List A.9,
 * transcribed where the check machinery is concerned:
 *
 *   "CMB = BAB + Str (Dex if Tiny or smaller) + special size + misc;
 *   CMD = 10 + BAB + Str + Dex + special size + misc (…; flat-footed loses
 *   Dex to CMD). Nat 20 auto-success (except escaping bonds), nat 1 auto-fail.
 *   Manœuvres are attack rolls → roll for concealment and take all attack
 *   penalties. Target immobilised/unconscious ⇒ auto-success; stunned ⇒ +4.
 *   No Improved X feat ⇒ provokes an AoO from the target; being hit by that
 *   AoO adds its damage as a penalty on the manœuvre roll. Size limit
 *   'no more than one category larger' for bull rush/trip/drag/reposition/
 *   overrun/grapple (with the listed exceptions)."
 *
 * The CMB/CMD *numbers* are the derivation's (`rulesTables.cmbFrom`/`cmdFrom`
 * already encode the formulas, the Tiny Dex substitution and the transferable
 * AC bonus types) — this module owns the **check**: the die, the states, the
 * penalties, the concealment roll and the provoke fact. The die is always the
 * caller's (the host is the only dice authority); the provoked attack of
 * opportunity resolves through the existing interrupt machinery, and its
 * damage comes back here as `aooDamageTaken` — the penalized-AoO rule.
 *
 * The per-manœuver aftermaths (bull rush's push, trip's fall, grapple's
 * options, …) land with their own consumers; `margin` is the fact they read.
 */
import {
  itemHpAfterDamage,
  sunderVerdict,
} from "./items";
import { normalizeSize, sizeSteps } from "./rulesTables";

/** A.9's manœuvres, as the check knows them. */
export type PF1eManeuverKind =
  | "bull-rush"
  | "trip"
  | "disarm"
  | "sunder"
  | "grapple"
  | "overrun"
  | "dirty-trick"
  | "drag"
  | "reposition"
  | "steal";

export const PF1E_MANEUVER_KINDS: readonly PF1eManeuverKind[] = [
  "bull-rush",
  "trip",
  "disarm",
  "sunder",
  "grapple",
  "overrun",
  "dirty-trick",
  "drag",
  "reposition",
  "steal",
];

/**
 * A.9's size-limited set: "no more than one category larger" applies to bull
 * rush, trip, drag, reposition, overrun and grapple. Disarm, sunder, dirty
 * trick and steal carry no size limit in the verified text.
 */
export const PF1E_SIZE_LIMITED_KINDS: readonly PF1eManeuverKind[] = [
  "bull-rush",
  "trip",
  "drag",
  "reposition",
  "overrun",
  "grapple",
];

export interface PF1eManeuverCheckInput {
  kind: PF1eManeuverKind;
  /** The natural d20 face of the manœuvre roll. */
  die: number;
  /** The attacker's CMB, straight off the derivation (misc already folded). */
  cmb: number;
  /** The defender's CMD — `cmdFrom`'s `normal`, or `flatFooted` when applicable. */
  cmd: number;
  attacker: {
    /** Authored size; an absent or unrecognized value is the derivation's Medium. */
    size?: string | null;
  };
  defender: {
    size?: string | null;
    /** A.9: an immobilised or unconscious target cannot resist — auto-success. */
    immobilizedOrUnconscious?: boolean;
    /** A.9: a stunned defender cannot resist as well — the check gains +4. */
    stunned?: boolean;
    /** PF1e trip/overrun: creatures with no legs, oozes, flying cannot be tripped. */
    cannotBeTripped?: boolean;
    /** Number of legs (trip/overrun): +2 CMD per leg beyond 2 (A.9). */
    legs?: number;
  };
  /**
   * Manœuvres are attack rolls (A.9): attack penalties apply. Already summed
   * by the caller (Power Attack, nonproficiency, …), positive = a penalty.
   */
  attackPenalty?: number;
  /**
   * The penalized-AoO rule: damage the provoked attack of opportunity dealt,
   * which becomes a penalty on this roll. The caller resolves the provoke
   * first and hands the damage back.
   */
  aooDamageTaken?: number;
  /** The Improved X feat for this manœuvre ⇒ no provoke. */
  hasImprovedFeat?: boolean;
  /** A live concealment miss chance (the manœuvre is an attack roll, AoN 182). */
  concealment?: { percent: number; label?: string };
  /** The d% face, required whenever a live miss chance meets a roll that would land. */
  concealmentDie?: number;
  /**
   * Escaping bonds: the natural 20 is **not** an auto-success (A.9's own
   * exception). Escape-artist-vs-CMD checks pass this.
   */
  escapingBonds?: boolean;
  /**
   * A caller-stated waiver of A.9's size limit (the appendix's "listed
   * exceptions" are feats the caller knows; this module never invents them).
   */
  sizeLimitWaived?: boolean;
}

export type PF1eManeuverCheckResult =
  | { ok: false; error: string }
  | {
      ok: true;
      success: boolean;
      /** die + CMB − the summed penalties, what the chat card shows. */
      total: number;
      /** The CMD the roll was judged against (stunned +4 folded in). */
      cmdEffective: number;
      /** total − cmdEffective: bull rush's and drag's push distance reads it (+5 ft per 5). */
      margin: number;
      /** A.9's provoke fact for the interrupt machinery: no Improved X ⇒ true. */
      provokes: boolean;
      /** True when a live miss chance turned a would-be success into a miss. */
      concealmentMiss: boolean;
      notes: readonly string[];
    };

/**
 * One manœuvre check. Pure: the caller supplies the die and every state fact;
 * the module refuses by name rather than guessing (an unlivable size
 * disadvantage, a missing d% face behind a live miss chance).
 */
export function pf1eManeuverCheck(
  input: PF1eManeuverCheckInput,
): PF1eManeuverCheckResult {
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > 20) {
    return { ok: false, error: "the manœuvre die must be a natural d20 face (1–20)" };
  }
  const notes: string[] = [];

  // A.9's size limit, on the ladder `rulesTables` owns. "No more than one
  // category larger": steps ≤ 1 pass; 2+ refuse unless the caller waives
  // (the appendix's listed feat exceptions are caller facts, never guesses).
  if (
    input.sizeLimitWaived !== true &&
    PF1E_SIZE_LIMITED_KINDS.includes(input.kind)
  ) {
    const attackerSize = normalizeSize(input.attacker.size) ?? "Medium";
    const defenderSize = normalizeSize(input.defender.size) ?? "Medium";
    const steps = sizeSteps(defenderSize, attackerSize);
    if (steps > 1) {
      return {
        ok: false,
        error: `a ${input.kind} needs a target no more than one size category larger — ${defenderSize} is ${String(steps)} categories above ${attackerSize} (A.9)`,
      };
    }
  }

  // A.9's states: immobilised/unconscious cannot resist at all.
  if (input.defender.immobilizedOrUnconscious === true) {
    return {
      ok: true,
      success: true,
      total: input.die + input.cmb,
      cmdEffective: input.cmd,
      margin: Number.POSITIVE_INFINITY,
      provokes: input.hasImprovedFeat !== true,
      concealmentMiss: false,
      notes: [
        "the target is immobilised or unconscious — the manœuvre auto-succeeds (A.9)",
      ],
    };
  }

  // Trip/overrun vs multi-legged targets: +2 CMD per leg beyond 2 (A.9).
  // This is a CMD increase, not a roll bonus, so it is folded into cmdEffective.
  let legBonus = 0;
  if (
    (input.kind === "trip" || input.kind === "overrun") &&
    typeof input.defender.legs === "number" &&
    Number.isFinite(input.defender.legs) &&
    input.defender.legs > 2
  ) {
    legBonus = (Math.trunc(input.defender.legs) - 2) * 2;
    if (legBonus > 0) notes.push(`the target has ${String(Math.trunc(input.defender.legs))} legs — +${String(legBonus)} to CMD (A.9)`);
  }
  if (input.kind === "trip" && input.defender.cannotBeTripped === true) {
    return { ok: false, error: "this creature cannot be tripped — oozes, creatures without legs and flying creatures cannot be tripped (A.9)" };
  }
  // Stunned: +4 on the check — the appendix's "+4" sits on the attacker's
  // side of the comparison, so it is folded into the roll and the margin
  // keeps its sign for the aftermath consumers (push distance reads it).
  const stunnedBonus = input.defender.stunned === true ? 4 : 0;
  if (stunnedBonus > 0) {
    notes.push("the target is stunned — +4 on the manœuvre roll (A.9)");
  }
  const cmdEffective = input.cmd + legBonus;
  const penalties =
    (input.attackPenalty ?? 0) + (input.aooDamageTaken ?? 0);
  if (input.aooDamageTaken !== undefined && input.aooDamageTaken > 0) {
    notes.push(
      `the provoked attack of opportunity dealt ${String(input.aooDamageTaken)} damage — that much as a penalty on this roll (A.9)`,
    );
  }
  const total = input.die + input.cmb - penalties + stunnedBonus;

  // Manœuvres are attack rolls: a live concealment miss chance rolls its own
  // d%, and a face at or below the chance misses the manœuvre outright
  // (AoN 182) — including what would have been the natural 20, for the same
  // reason the attack resolver documents.
  const missChance = input.concealment?.percent ?? 0;
  const wouldSucceed =
    input.die === 20
      ? input.escapingBonds !== true
      : input.die === 1
        ? false
        : total >= cmdEffective;
  if (missChance > 0 && wouldSucceed) {
    const die = input.concealmentDie;
    if (
      die === undefined ||
      !Number.isInteger(die) ||
      die < 1 ||
      die > 100
    ) {
      return {
        ok: false,
        error: "the target is concealed — concealmentDie (the d% face, 1–100) is required to resolve the manœuvre (AoN 182)",
      };
    }
    if (die <= missChance) {
      const label = input.concealment?.label;
      notes.push(
        `concealment miss — d% ${String(die)} ≤ ${String(missChance)}${label !== undefined && label !== "" ? ` (${label})` : ""}; the manœuvre misses (AoN 182)`,
      );
      return {
        ok: true,
        success: false,
        total,
        cmdEffective,
        margin: total - cmdEffective,
        provokes: input.hasImprovedFeat !== true,
        concealmentMiss: true,
        notes,
      };
    }
  }

  // The natural faces (A.9): 20 auto-succeeds unless the check is escaping
  // bonds; 1 auto-fails.
  if (input.die === 20) {
    if (input.escapingBonds === true) {
      notes.push(
        "escaping bonds: the natural 20 is not an automatic success (A.9)",
      );
    } else {
      notes.push("natural 20 — the manœuvre automatically succeeds (A.9)");
      return {
        ok: true,
        success: true,
        total,
        cmdEffective,
        margin: total - cmdEffective,
        provokes: input.hasImprovedFeat !== true,
        concealmentMiss: false,
        notes,
      };
    }
  } else if (input.die === 1) {
    notes.push("natural 1 — the manœuvre automatically fails (A.9)");
    return {
      ok: true,
      success: false,
      total,
      cmdEffective,
      margin: total - cmdEffective,
      provokes: input.hasImprovedFeat !== true,
      concealmentMiss: false,
      notes,
    };
  }

  return {
    ok: true,
    success: total >= cmdEffective,
    total,
    cmdEffective,
    margin: total - cmdEffective,
    provokes: input.hasImprovedFeat !== true,
    concealmentMiss: false,
    notes,
  };
}

/** The sunder consumer: the check, then the item arithmetic `items.ts` owns. */
export function pf1eSunder(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
  item: {
    /** Authored hardness (A.17: damage − hardness, then HP). */
    hardness: number;
    /** Current item HP. */
    hp: number;
    /** The item's undamaged HP — the broken threshold reads it. */
    hpMax: number;
  };
  /** The sundering strike's damage total, caller-rolled. */
  damage: number;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      item: {
        hpAfter: number;
        broken: boolean;
        destroyed: boolean;
        /** A.9's choice point: at or below 0 HP the attacker may destroy or leave 1 HP + broken. */
        destroyedOrBroken: boolean;
      };
      notes: readonly string[];
    } {
  if (input.item.hpMax <= 0) {
    return {
      ok: false,
      error:
        "the target item has no hit-point budget authored — sunder cannot be tracked for it (A.17)",
    };
  }
  const check = pf1eManeuverCheck({ ...input.check, kind: "sunder" });
  if (!check.ok) return check;
  if (!check.success) {
    return {
      ok: true,
      check,
      item: {
        hpAfter: input.item.hp,
        broken: false,
        destroyed: false,
        destroyedOrBroken: false,
      },
      notes: [...check.notes, "the sunder misses — the item is untouched"],
    };
  }
  const hpAfter = itemHpAfterDamage(
    input.damage,
    input.item.hardness,
    input.item.hp,
  );
  const verdict = sunderVerdict({ hpMax: input.item.hpMax, hpAfter });
  const notes = [...check.notes];
  notes.push(
    `the strike deals ${String(input.damage)} damage — hardness ${String(input.item.hardness)} absorbs first, item HP ${String(input.item.hp)} → ${String(hpAfter)}`,
  );
  if (verdict.destroyed) {
    notes.push(
      "the item is at or below 0 HP — the attacker chooses: destroyed, or left at 1 HP and broken (A.9)",
    );
  } else if (verdict.broken) {
    notes.push(
      "the item has taken damage in excess of half its hit points — it is broken (AoN 413)",
    );
  }
  return {
    ok: true,
    check,
    item: { hpAfter, ...verdict },
    notes,
  };
}

/** Bull rush: push distance off the margin (5 ft + 5 per 5 over CMD). */
export function pf1eBullRush(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      success: boolean;
      /** Push in feet (5 + 5 per 5 over CMD). 0 when the check fails. */
      pushDistanceFt: number;
      /** The attacker may move with the target if they have movement remaining (caller fact). */
      canMoveWithTarget: boolean;
      notes: readonly string[];
    } {
  const check = pf1eManeuverCheck({ ...input.check, kind: "bull-rush" });
  if (!check.ok) return check;
  if (!check.success) {
    return {
      ok: true,
      check,
      success: false,
      pushDistanceFt: 0,
      canMoveWithTarget: false,
      notes: [...check.notes, "the bull rush fails — your movement ends in front of the target (A.9)"],
    };
  }
  // Margin Infinity (immobilised) → at least 5 ft; otherwise 5 + 5* floor(margin/5)
  const margin = Number.isFinite(check.margin) ? check.margin : Math.max(0, check.total - check.cmdEffective);
  const pushDistanceFt = 5 + Math.max(0, Math.floor(margin / 5)) * 5;
  const notes = [...check.notes, `the bull rush pushes the target ${String(pushDistanceFt)} feet straight back (A.9)`];
  if (pushDistanceFt > 5) notes.push(`for every 5 by which your attack exceeds CMD you push an additional 5 feet — margin ${String(check.margin)}`);
  notes.push("you can move with the target if you wish but you must have the available movement to do so");
  notes.push("an enemy being moved by a bull rush does not provoke an attack of opportunity because of the movement unless you possess Greater Bull Rush");
  return { ok: true, check, success: true, pushDistanceFt, canMoveWithTarget: true, notes };
}

/** Trip: prone on success; on fail by 10+ the attacker falls prone. */
export function pf1eTrip(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      success: boolean;
      targetProne: boolean;
      attackerProne: boolean;
      notes: readonly string[];
    } {
  const check = pf1eManeuverCheck({ ...input.check, kind: "trip" });
  if (!check.ok) return check;
  if (check.success) {
    return {
      ok: true,
      check,
      success: true,
      targetProne: true,
      attackerProne: false,
      notes: [...check.notes, "the target is knocked prone (A.9)"],
    };
  }
  const failBy = check.cmdEffective - check.total;
  if (failBy >= 10) {
    return {
      ok: true,
      check,
      success: false,
      targetProne: false,
      attackerProne: true,
      notes: [...check.notes, "your trip fails by 10 or more — you are knocked prone instead (A.9)"],
    };
  }
  return {
    ok: true,
    check,
    success: false,
    targetProne: false,
    attackerProne: false,
    notes: [...check.notes, "the trip fails — the target stays standing"],
  };
}

/** Disarm: drop logic incl. the 10-point thresholds. */
export function pf1eDisarm(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
  /** True when the attacker is unarmed (—4 already in attackPenalty, but the note clarifies). */
  attackerUnarmed?: boolean;
  /** True when the disarm was made without a weapon — you may pick up the dropped item. */
  disarmedWithoutWeapon?: boolean;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      success: boolean;
      /** How many items the target drops (0, 1, or 2). */
      targetDrops: number;
      /** True when you drop your own weapon (fail by 10+). */
      attackerDrops: boolean;
      /** You disarmed without a weapon — you may automatically pick up the item. */
      canPickUp: boolean;
      notes: readonly string[];
    } {
  const check = pf1eManeuverCheck({ ...input.check, kind: "disarm" });
  if (!check.ok) return check;
  const notes = [...check.notes];
  if (input.attackerUnarmed === true) notes.push("attempting to disarm while unarmed imposes a –4 penalty on the attack (A.9)");
  if (!check.success) {
    const failBy = check.cmdEffective - check.total;
    if (failBy >= 10) {
      return {
        ok: true,
        check,
        success: false,
        targetDrops: 0,
        attackerDrops: true,
        canPickUp: false,
        notes: [...notes, "your disarm fails by 10 or more — you drop the weapon you were using to attempt the disarm (A.9)"],
      };
    }
    return {
      ok: true,
      check,
      success: false,
      targetDrops: 0,
      attackerDrops: false,
      canPickUp: false,
      notes: [...notes, "the disarm fails — the target keeps its item"],
    };
  }
  const margin = check.margin;
  const targetDrops = margin >= 10 ? 2 : 1;
  const canPickUp = input.disarmedWithoutWeapon === true;
  const extra = targetDrops === 2 ? " — exceeding CMD by 10 or more drops the items in both hands (maximum two)" : "";
  notes.push(`you disarm the target — it drops ${targetDrops === 2 ? "the items in both hands" : "one item of your choice (even if wielded with two hands)"}${extra} (A.9)`);
  if (canPickUp) notes.push("you disarmed without using a weapon — you may automatically pick up the item dropped");
  return { ok: true, check, success: true, targetDrops, attackerDrops: false, canPickUp, notes };
}

/** Overrun: move through, with prone on margin ≥5 and the target-may-avoid choice. */
export function pf1eOverrun(input: {
  check?: Omit<PF1eManeuverCheckInput, "kind">;
  /** The target chooses to avoid — you pass through without a check (A.9). */
  targetAvoids?: boolean;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }> | null;
      success: boolean;
      /** You move through the target's space. */
      moveThrough: boolean;
      /** Target knocked prone (margin ≥5). */
      targetProne: boolean;
      /** You stop in the space directly in front of the opponent on a failure. */
      stoppedInFront: boolean;
      notes: readonly string[];
    } {
  if (input.targetAvoids === true) {
    return {
      ok: true,
      check: null,
      success: true,
      moveThrough: true,
      targetProne: false,
      stoppedInFront: false,
      notes: ["the target chooses to avoid you — you pass through its square without requiring a check (A.9)"],
    };
  }
  if (!input.check) return { ok: false, error: "overrun: a check is required when the target does not avoid (A.9)" };
  const check = pf1eManeuverCheck({ ...input.check, kind: "overrun" });
  if (!check.ok) return check;
  if (!check.success) {
    return {
      ok: true,
      check,
      success: false,
      moveThrough: false,
      targetProne: false,
      stoppedInFront: true,
      notes: [...check.notes, "your overrun fails — you stop in the space directly in front of the opponent (A.9)"],
    };
  }
  const targetProne = check.margin >= 5;
  const notes = [...check.notes, "you move through the target's space (A.9)"];
  if (targetProne) notes.push("your attack exceeds CMD by 5 or more — the target is knocked prone (A.9)");
  return { ok: true, check, success: true, moveThrough: true, targetProne, stoppedInFront: false, notes };
}

/** Dirty trick: impose one of six conditions for 1 + floor(margin/5) rounds (Greater: 1d4 + floor). */
export function pf1eDirtyTrick(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
  /** One of the six allowed conditions (A.9: blinded/dazzled/deafened/entangled/shaken/sickened). */
  condition?: string;
  hasGreaterDirtyTrick?: boolean;
  /** The d4 face for Greater Dirty Trick (1–4), required when hasGreaterDirtyTrick is true. */
  greaterDie?: number;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      success: boolean;
      condition: string | null;
      /** Duration in rounds. 0 when the check fails. */
      durationRounds: number;
      notes: readonly string[];
    } {
  const allowed = ["blinded", "dazzled", "deafened", "entangled", "shaken", "sickened"] as const;
  const condition = input.condition ?? "sickened";
  if (!allowed.includes(condition as typeof allowed[number])) {
    return { ok: false, error: `dirty trick condition must be one of ${allowed.join("/")} — got ${JSON.stringify(condition)} (A.9)` };
  }
  const check = pf1eManeuverCheck({ ...input.check, kind: "dirty-trick" });
  if (!check.ok) return check;
  if (!check.success) {
    return { ok: true, check, success: false, condition: null, durationRounds: 0, notes: [...check.notes, "the dirty trick fails"] };
  }
  let durationRounds: number;
  const notes = [...check.notes];
  if (input.hasGreaterDirtyTrick === true) {
    const die = input.greaterDie;
    if (die === undefined || !Number.isInteger(die) || die < 1 || die > 4) {
      return { ok: false, error: "Greater Dirty Trick: greaterDie (the d4 face, 1–4) is required to compute duration (A.9)" };
    }
    durationRounds = die + Math.max(0, Math.floor(check.margin / 5));
    notes.push(`Greater Dirty Trick: the ${condition} condition lasts ${String(die)} + floor(margin/5) = ${String(durationRounds)} rounds (A.9)`);
    notes.push("removing the condition requires the target to spend a standard action");
  } else {
    durationRounds = 1 + Math.max(0, Math.floor(check.margin / 5));
    notes.push(`the ${condition} condition lasts ${String(durationRounds)} round${durationRounds === 1 ? "" : "s"} (1 + 1 per 5 over CMD, A.9)`);
    notes.push("the penalty can usually be removed if the target spends a move action");
  }
  return { ok: true, check, success: true, condition, durationRounds, notes };
}

/** Drag: both you and target move 5 ft + 5 per 5 over CMD behind you. */
export function pf1eDrag(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      success: boolean;
      dragDistanceFt: number;
      notes: readonly string[];
    } {
  const check = pf1eManeuverCheck({ ...input.check, kind: "drag" });
  if (!check.ok) return check;
  if (!check.success) {
    return { ok: true, check, success: false, dragDistanceFt: 0, notes: [...check.notes, "the drag fails — you and the target stay where you are"] };
  }
  const dragDistanceFt = 5 + Math.max(0, Math.floor(check.margin / 5)) * 5;
  const notes = [...check.notes, `you drag the target ${String(dragDistanceFt)} feet straight back, with your opponent occupying your original space and you in the space behind that (A.9)`];
  notes.push("you must be able to move with the target to perform this maneuver — if you do not have enough movement, the drag goes to the maximum available and ends");
  return { ok: true, check, success: true, dragDistanceFt, notes };
}

/** Reposition: move target 5 ft + 5 per 5 over CMD within your reach (final 5 may be adjacent). */
export function pf1eReposition(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      success: boolean;
      repositionDistanceFt: number;
      notes: readonly string[];
    } {
  const check = pf1eManeuverCheck({ ...input.check, kind: "reposition" });
  if (!check.ok) return check;
  if (!check.success) {
    return { ok: true, check, success: false, repositionDistanceFt: 0, notes: [...check.notes, "the reposition fails"] };
  }
  const repositionDistanceFt = 5 + Math.max(0, Math.floor(check.margin / 5)) * 5;
  const notes = [...check.notes, `you may move the target ${String(repositionDistanceFt)} feet to a new location — the target must remain within your reach at all times during this movement, except for the final 5 feet which can be to a space adjacent to your reach (A.9)`];
  return { ok: true, check, success: true, repositionDistanceFt, notes };
}

/** Steal: take an item that is neither held nor hidden in a bag. */
export function pf1eSteal(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
  /** At least one hand free (holding nothing) is required (A.9). */
  attackerFreeHand?: boolean;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      success: boolean;
      stolen: boolean;
      notes: readonly string[];
    } {
  if (input.attackerFreeHand === false) {
    return { ok: false, error: "steal: you must have at least one hand free (holding nothing) to attempt this maneuver (A.9)" };
  }
  const check = pf1eManeuverCheck({ ...input.check, kind: "steal" });
  if (!check.ok) return check;
  if (!check.success) {
    return { ok: true, check, success: false, stolen: false, notes: [...check.notes, "the steal fails"] };
  }
  const notes = [...check.notes, "you may take one item from your opponent that is neither held nor hidden in a bag or pack (A.9)"];
  notes.push("items that are closely worn (armor, backpacks, boots, clothing, rings) cannot be taken with this maneuver — use disarm for held items");
  return { ok: true, check, success: true, stolen: true, notes };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Grapple — the SRD's most branched manœuvre (AoN 191, CRB p.199). Every
 * option below is a pure verdict over the same CMB-vs-CMD core. The map
 * tells the die; the sheet tells the CMB/CMD; the caller tells the hands,
 * the adjacency and the hazardous placement — this module refuses by name
 * rather than guessing any of them.
 * ────────────────────────────────────────────────────────────────────────── */

/** Helper: humanoid without two free hands ⇒ –4 (AoN 191). */
function grappleHumanoidPenalty(opts: {
  attackerIsHumanoid?: boolean | undefined;
  attackerFreeHands?: number | undefined;
}): { penalty: number; note: string | null } {
  if (opts.attackerIsHumanoid === true) {
    const hands = opts.attackerFreeHands;
    if (typeof hands === "number" && hands < 2) {
      return { penalty: 4, note: "humanoid without two free hands — –4 on the grapple check (AoN 191)" };
    }
    if (hands === undefined) {
      // unknown hands — do not assume, no penalty
      return { penalty: 0, note: null };
    }
  }
  return { penalty: 0, note: null };
}

/**
 * Initial grapple — standard action, provokes unless Improved Grapple / grab
 * (AoN 191). On success both gain Grappled; if the target was not adjacent
 * you must move it to an adjacent open space (if none, the grapple fails).
 */
export function pf1eGrapple(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
  /** True when the attacker is a humanoid (affects the –4). */
  attackerIsHumanoid?: boolean;
  /** Number of free hands (0–2). Absent ⇒ not evaluated. */
  attackerFreeHands?: number;
  /** Whether the target was adjacent before the grapple. */
  targetAdjacent?: boolean;
  /** Whether an adjacent open space exists to pull a non-adjacent target into. */
  hasAdjacentSpace?: boolean;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      success: boolean;
      /** Both combatants gain Grappled on success. */
      bothGrappled: boolean;
      /** The grapple succeeded on the die but had nowhere to put a non-adjacent target. */
      noSpaceFails: boolean;
      /** True when the initial success requires the caller to move the target adjacent. */
      needsMoveAdjacent: boolean;
      notes: readonly string[];
    } {
  const hp = grappleHumanoidPenalty({ attackerIsHumanoid: input.attackerIsHumanoid, attackerFreeHands: input.attackerFreeHands });
  const effectiveCheck = { ...input.check } as PF1eManeuverCheckInput & { kind: PF1eManeuverKind };
  // Fold humanoid penalty into attackPenalty (positive = penalty)
  if (hp.penalty > 0) {
    effectiveCheck.attackPenalty = (effectiveCheck.attackPenalty ?? 0) + hp.penalty;
  }
  const check = pf1eManeuverCheck({ ...effectiveCheck, kind: "grapple" } as PF1eManeuverCheckInput);
  if (!check.ok) return check;
  const notes = [...check.notes];
  if (hp.note) notes.push(hp.note);
  if (!check.success) {
    return { ok: true, check: { ...check, notes } as Extract<PF1eManeuverCheckResult, { ok: true }>, success: false, bothGrappled: false, noSpaceFails: false, needsMoveAdjacent: false, notes: [...notes, "the grapple fails — neither combatant is grappled"] };
  }
  // Success but non-adjacent target with no open space ⇒ grapple fails
  if (input.targetAdjacent === false && input.hasAdjacentSpace === false) {
    return {
      ok: true,
      check: { ...check, notes } as Extract<PF1eManeuverCheckResult, { ok: true }>,
      success: false,
      bothGrappled: false,
      noSpaceFails: true,
      needsMoveAdjacent: false,
      notes: [...notes, "you successfully grapple a creature that is not adjacent, but there is no adjacent open space — the grapple fails (AoN 191)"],
    };
  }
  const needsMoveAdjacent = input.targetAdjacent === false;
  if (needsMoveAdjacent) notes.push("you successfully grapple a creature that is not adjacent — move that creature to an adjacent open space (AoN 191)");
  notes.push("both you and the target gain the grappled condition (AoN 191 / Appendix 2)");
  notes.push("you can release the grapple as a free action, removing the condition from both (AoN 191)");
  if (check.provokes) notes.push("this grapple provokes an attack of opportunity from the target unless you have Improved Grapple, grab or a similar ability (AoN 191)");
  return { ok: true, check: { ...check, notes } as Extract<PF1eManeuverCheckResult, { ok: true }>, success: true, bothGrappled: true, noSpaceFails: false, needsMoveAdjacent, notes };
}

/**
 * Maintain grapple — standard action each round to keep the hold. If the
 * target did not break the grapple since your last turn you gain +5
 * circumstance on this check (AoN 191). A successful maintain continues the
 * grappled condition and lets you pick one of move / damage / pin / tie-up
 * as part of that same standard action.
 */
export function pf1eGrappleMaintain(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
  attackerIsHumanoid?: boolean;
  attackerFreeHands?: number;
  /** +5 circumstance when target did not break since your last turn. */
  hasMaintainBonus?: boolean;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      success: boolean;
      /** Grapple continues on success; breaks on failure. */
      continues: boolean;
      notes: readonly string[];
    } {
  const hp = grappleHumanoidPenalty({ attackerIsHumanoid: input.attackerIsHumanoid, attackerFreeHands: input.attackerFreeHands });
  let effectiveCmb = input.check.cmb;
  const notesExtra: string[] = [];
  if (hp.penalty > 0) {
    effectiveCmb -= hp.penalty;
    notesExtra.push(hp.note!);
  }
  if (input.hasMaintainBonus === true) {
    effectiveCmb += 5;
    notesExtra.push("your target did not break the grapple — +5 circumstance bonus on this maintain check (AoN 191)");
  }
  const checkInput = { ...input.check, cmb: effectiveCmb };
  const check = pf1eManeuverCheck({ ...checkInput, kind: "grapple" } as PF1eManeuverCheckInput);
  if (!check.ok) return check;
  const notes = [...check.notes, ...notesExtra];
  if (!check.success) {
    return { ok: true, check: { ...check, notes } as Extract<PF1eManeuverCheckResult, { ok: true }>, success: false, continues: false, notes: [...notes, "you fail to maintain the grapple — the grapple ends"] };
  }
  notes.push("you continue grappling the foe and may perform one of: move half speed with target, damage, pin, or tie-up (AoN 191)");
  return { ok: true, check: { ...check, notes } as Extract<PF1eManeuverCheckResult, { ok: true }>, success: true, continues: true, notes };
}

/** Grapple: move — half speed with the target, hazardous placement grants a free break. */
export function pf1eGrappleMove(input: {
  /** The maintain check must have succeeded to choose this option. */
  maintainSuccess: boolean;
  /** Your speed in feet; the move is at most half. */
  speedFt?: number;
  /** True when you place the foe in a hazardous location (wall of fire, pit, …). */
  hazardousPlacement?: boolean;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      success: boolean;
      /** Maximum distance you may move both with the target. */
      maxDistanceFt: number;
      /** Hazardous placement grants the target a free break attempt with +4. */
      targetFreeBreakWithBonus: boolean;
      notes: readonly string[];
    } {
  if (!input.maintainSuccess) return { ok: false, error: "grapple move requires a successful maintain check (AoN 191)" };
  const speed = input.speedFt ?? 30;
  const maxDistanceFt = Math.floor(speed / 2);
  const notes: string[] = [`you may move both yourself and your target up to ${String(maxDistanceFt)} feet (half your speed; AoN 191)`, "at the end of your movement you may place your target in any square adjacent to you"];
  if (input.hazardousPlacement === true) {
    notes.push("you attempt to place your foe in a hazardous location — the target receives a free attempt to break your grapple with a +4 bonus (AoN 191)");
    return { ok: true, success: true, maxDistanceFt, targetFreeBreakWithBonus: true, notes };
  }
  return { ok: true, success: true, maxDistanceFt, targetFreeBreakWithBonus: false, notes };
}

/** Grapple: damage — unarmed / natural / armor spikes / light-or-one-handed weapon. */
export function pf1eGrappleDamage(input: {
  maintainSuccess: boolean;
  /** Damage you roll (caller-provided). Required to name the total. */
  damage?: number;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      success: boolean;
      damage: number | null;
      notes: readonly string[];
    } {
  if (!input.maintainSuccess) return { ok: false, error: "grapple damage requires a successful maintain check (AoN 191)" };
  const notes: string[] = ["you may inflict damage to your target equal to your unarmed strike, a natural attack, or an attack made with armor spikes or a light or one-handed weapon; this damage can be lethal or nonlethal (AoN 191)"];
  if (typeof input.damage === "number") {
    notes.push(`damage dealt: ${String(input.damage)}`);
    return { ok: true, success: true, damage: input.damage, notes };
  }
  return { ok: true, success: true, damage: null, notes };
}

/**
 * Grapple: pin — the opponent gains Pinned; you remain only Grappled but
 * lose Dex bonus to AC (AoN 191 / Appendix 2).
 */
export function pf1eGrapplePin(input: {
  maintainSuccess: boolean;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      success: boolean;
      targetPinned: boolean;
      attackerGrappledNoDex: boolean;
      notes: readonly string[];
    } {
  if (!input.maintainSuccess) return { ok: false, error: "grapple pin requires a successful maintain check (AoN 191)" };
  return {
    ok: true,
    success: true,
    targetPinned: true,
    attackerGrappledNoDex: true,
    notes: ["you give your opponent the pinned condition — they cannot move and are denied Dex bonus, +4 to AC but limited actions (Appendix 2)", "despite pinning your opponent, you still only have the grappled condition, but you lose your Dexterity bonus to AC (AoN 191)"],
  };
}

/**
 * Grapple: tie-up — pin-like, but the DC to escape is 20 + your CMB and the
 * ropes need no check each round. Requires the target pinned / otherwise
 * restrained / unconscious. If you are grappling while tying, –10 on the
 * check (AoN 191). If 20+CMB > 20+target CMB, even a natural 20 cannot escape.
 */
export function pf1eGrappleTieUp(input: {
  check: Omit<PF1eManeuverCheckInput, "kind">;
  /** The target must be pinned, otherwise restrained, or unconscious. */
  targetPinnedOrRestrainedOrUnconscious?: boolean;
  /** True when you are currently grappling the target while tying (–10). */
  grapplingWhileTying?: boolean;
  attackerIsHumanoid?: boolean;
  attackerFreeHands?: number;
  /** Your CMB — the tie-up DC is 20 + CMB. */
  attackerCmbForDc: number;
  /** Target's CMB — to test the “cannot escape even with 20” threshold. */
  targetCmbForEscape?: number;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      check: Extract<PF1eManeuverCheckResult, { ok: true }>;
      success: boolean;
      /** DC to escape the ropes. */
      escapeDc: number;
      /** True when escape DC > 20 + target CMB ⇒ natural 20 insufficient. */
      cannotEscapeEvenWith20: boolean;
      notes: readonly string[];
    } {
  if (input.targetPinnedOrRestrainedOrUnconscious !== true) {
    return { ok: false, error: "tie up requires the target pinned, otherwise restrained, or unconscious (AoN 191)" };
  }
  let effectiveCmb = input.check.cmb;
  const extraNotes: string[] = [];
  if (input.grapplingWhileTying === true) {
    effectiveCmb -= 10;
    extraNotes.push("you are grappling the target while tying him up — –10 penalty on the combat maneuver check (AoN 191)");
  }
  const hp = grappleHumanoidPenalty({ attackerIsHumanoid: input.attackerIsHumanoid, attackerFreeHands: input.attackerFreeHands });
  if (hp.penalty > 0) {
    effectiveCmb -= hp.penalty;
    extraNotes.push(hp.note!);
  }
  const checkInput = { ...input.check, cmb: effectiveCmb };
  const check = pf1eManeuverCheck({ ...checkInput, kind: "grapple" } as PF1eManeuverCheckInput);
  if (!check.ok) return check;
  const notes = [...check.notes, ...extraNotes];
  const escapeDc = 20 + input.attackerCmbForDc;
  const threshold = input.targetCmbForEscape !== undefined ? 20 + input.targetCmbForEscape : null;
  const cannotEscapeEvenWith20 = threshold !== null ? escapeDc > threshold : false;
  if (!check.success) {
    return { ok: true, check: { ...check, notes } as Extract<PF1eManeuverCheckResult, { ok: true }>, success: false, escapeDc, cannotEscapeEvenWith20: false, notes: [...notes, "the tie-up fails"] };
  }
  notes.push(`you tie up the target — this works like a pin, but the DC to escape is 20 + your CMB = ${String(escapeDc)} (instead of your CMD); the ropes do not need a check each round to maintain (AoN 191)`);
  if (cannotEscapeEvenWith20) notes.push(`with DC ${String(escapeDc)} vs 20 + target CMB ${String(threshold)} — the target cannot escape the bonds, even with a natural 20 (AoN 191)`);
  else if (threshold !== null) notes.push(`DC ${String(escapeDc)} is escapable with a natural 20 (needs ≤ ${String(threshold)} + roll)`);
  return { ok: true, check: { ...check, notes } as Extract<PF1eManeuverCheckResult, { ok: true }>, success: true, escapeDc, cannotEscapeEvenWith20, notes };
}

/**
 * If grappled — break or reverse. Standard action, does not provoke. CMB vs
 * CMD or Escape Artist vs CMD (AoN 191). On success the grappled creature
 * can break free and act normally, or become the grappler.
 */
export function pf1eGrappleEscape(input: {
  /** The grappled creature's die and bonus. For CMB use `bonusIsCmb:true`; for Escape Artist the skill total. */
  die: number;
  /** The bonus on the check (CMB or Escape Artist). */
  bonus: number;
  /** Opponent's CMD. */
  defenderCmd: number;
  /** Escaping bonds exception — natural 20 not auto-success when escaping bonds (not grapple). */
  escapingBonds?: boolean;
  /** True when this Escape Artist-or-CMB check should become the grappler on success. */
  becomeGrappler?: boolean;
  /** Optional extra notes from hazardous placement (+4 free break). */
  hasHazardBonus?: boolean;
}):
  | { ok: false; error: string }
  | {
      ok: true;
      success: boolean;
      escaped: boolean;
      reversed: boolean;
      notes: readonly string[];
    } {
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > 20) {
    return { ok: false, error: "the grapple escape die must be a natural d20 face (1–20)" };
  }
  let effectiveBonus = input.bonus;
  const notes: string[] = [];
  if (input.hasHazardBonus === true) {
    effectiveBonus += 4;
    notes.push("hazardous placement — the target receives a +4 bonus on this break attempt (AoN 191)");
  }
  // Escape never provokes and has no size limit / concealment — reuse the core
  // roll logic without those wrappers. We replicate the nat 20/1 handling so the
  // size/humanoid/concealment machinery does not double-apply.
  const total = input.die + effectiveBonus;
  const cmdEffective = input.defenderCmd;
  let success: boolean;
  if (input.die === 20 && input.escapingBonds !== true) {
    notes.push("natural 20 — the grapple escape automatically succeeds (A.9)");
    success = true;
  } else if (input.die === 1) {
    notes.push("natural 1 — the grapple escape automatically fails (A.9)");
    success = false;
  } else {
    if (input.escapingBonds === true) notes.push("escaping bonds: the natural 20 is not an automatic success (A.9)");
    success = total >= cmdEffective;
  }
  notes.push(`grapple escape does not provoke an attack of opportunity (AoN 191)`);
  if (!success) {
    return { ok: true, success: false, escaped: false, reversed: false, notes: [...notes, `escape fails — ${String(total)} vs CMD ${String(cmdEffective)}`] };
  }
  if (input.becomeGrappler === true) {
    notes.push("you succeed and become the grappler, grappling the other creature — the other creature cannot freely release the grapple without a check, while you can (AoN 191)");
    return { ok: true, success: true, escaped: false, reversed: true, notes };
  }
  notes.push("you succeed and break the grapple — you can act normally (AoN 191)");
  return { ok: true, success: true, escaped: true, reversed: false, notes };
}

/** Hazardous-place free break — a grappled defender's +4 attempt when moved into hazard. */
export function pf1eGrappleHazardBreak(input: {
  die: number;
  bonus: number;
  defenderCmd: number;
}): ReturnType<typeof pf1eGrappleEscape> {
  return pf1eGrappleEscape({ die: input.die, bonus: input.bonus, defenderCmd: input.defenderCmd, hasHazardBonus: true });
}



