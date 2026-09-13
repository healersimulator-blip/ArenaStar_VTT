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

  // Stunned: +4 on the check — the appendix's "+4" sits on the attacker's
  // side of the comparison, so it is folded into the roll and the margin
  // keeps its sign for the aftermath consumers (push distance reads it).
  const stunnedBonus = input.defender.stunned === true ? 4 : 0;
  if (stunnedBonus > 0) {
    notes.push("the target is stunned — +4 on the manœuvre roll (A.9)");
  }
  const cmdEffective = input.cmd;
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
