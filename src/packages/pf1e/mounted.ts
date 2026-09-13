/**
 * P08/D-201 — mounted combat, Gap List A.11 transcribed:
 *
 *   "untrained mount ⇒ DC 20 Ride as a move action each round (fail ⇒ the move
 *   becomes a full-round action and you can do nothing else); DC 5 Ride as a
 *   free action to guide with the knees (hands free); +1 on melee attacks vs
 *   a foe **smaller than your mount** that is **on foot** (the higher-ground
 *   bonus, verified CRB p.202); if the mount moves more than 5 ft you can
 *   make **only one melee attack** (no full attack) at the end of the move;
 *   lance on a charge deals ×2; ranged weapons at −4 while the mount doubles
 *   its speed, −8 while it runs, attack at half-movement, full attack still
 *   allowed; casting while the mount moves both before and after ⇒
 *   concentration DC 10 + spell level, while running (up to ×2 speed) ⇒ DC 15
 *   + spell level; mount falls ⇒ DC 15 Ride or 1d6 damage; you go unconscious
 *   in the saddle ⇒ 50% (75% in a military saddle) to stay mounted, else fall
 *   for 1d6; the mount acts on your initiative and shares your space; Large
 *   mount occupies 2 squares; 'You can use the Ride-By Attack / Trick Riding
 *   feats' ⇒ order: move, attack, continue (Ride-By prevents the AoO)."
 *
 * Pure: every die is the caller's (the host is the only dice authority) and
 * every fact the rules read — the mount's size, speed, training, saddle, how
 * far it moved this round — is a caller fact, never a guess. The rider↔mount
 * **linkage** is authored on the rider (`system.pf1e.mount`, normalized
 * here); the structural facts (shared initiative, shared space, a Large
 * mount's 2×2 footprint) belong to the combat and scene glue that consumes
 * them and are named in each consumer's own docs.
 *
 * Deliberately not encoded: the ×3 spirited-charge lance multiplier and every
 * other mounted feat effect (the verified text gives only Ride-By Attack /
 * Trick Riding's ordering, quoted in the header) — `LANCE_CHARGE_MULTIPLIER`
 * is the verified ×2 and feats arrive as caller facts, exactly as
 * `rollData.ts` documents its `extraMultipliers` seam.
 */
import { normalizeSize, sizeSteps } from "./rulesTables";

/** The saddle kinds A.11 names — only the military one changes a number. */
export type PF1eSaddleKind = "none" | "military";

/** The rider's authored mount linkage (`system.pf1e.mount`), normalized. */
export interface PF1eMountLinkage {
  /** The mount's actor id; absent ⇒ the rider rides nothing. */
  actorId: string | null;
  /** A combat-trained mount needs no DC 20 control check each round. */
  combatTrained: boolean;
  saddle: PF1eSaddleKind;
}

/** Normalize the authored `system.pf1e.mount` block; `null` ⇒ no mount. */
export function mountLinkageOf(raw: unknown): PF1eMountLinkage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  const actorId =
    typeof rec.actorId === "string" && rec.actorId.trim() !== ""
      ? rec.actorId
      : null;
  const saddle: PF1eSaddleKind = rec.saddle === "military" ? "military" : "none";
  return {
    actorId,
    combatTrained: rec.combatTrained === true,
    saddle,
  };
}

/**
 * A.11's mounted melee bonus: **+1 on melee attacks vs a foe smaller than
 * your mount that is on foot** — the *higher-ground* bonus (verified CRB
 * p.202), so the fold is `situational.higherGround`, whose +1 the resolver
 * already limits to melee lines. A mounted foe never takes it (both ride).
 */
export function mountedHigherGround(input: {
  mountSize: string | null | undefined;
  targetSize: string | null | undefined;
  /** The target rides a mount of its own ⇒ it is not on foot. */
  targetMounted: boolean;
}): boolean {
  if (input.targetMounted) return false;
  const mount = normalizeSize(input.mountSize);
  const target = normalizeSize(input.targetSize);
  if (mount === null || target === null) return false;
  return sizeSteps(target, mount) < 0;
}

/**
 * A.11's full-attack bar: "if the mount moves more than 5 ft you can make
 * only one melee attack (no full attack) at the end of the move". Exactly
 * 5 ft (a 5-foot step with the mount) keeps the full attack.
 */
export function mountedMeleeFullAttack(input: {
  /** How far the mount moved this round, in feet. */
  mountMovedFt: number;
}): { fullAttack: boolean; reason: string | null } {
  if (input.mountMovedFt > 5) {
    return {
      fullAttack: false,
      reason:
        "the mount moved more than 5 ft — only one melee attack at the end of the move, no full attack (A.11)",
    };
  }
  return { fullAttack: true, reason: null };
}

/** How the mount spent its movement this round — A.11's ranged penalty table. */
export type PF1eMountMovement =
  | "stationary"
  /** Moving up to its speed (attacking at half movement: no penalty). */
  | "single"
  /** Doubling its speed. */
  | "double"
  /** Running (up to ×4 speed). */
  | "run";

/**
 * A.11's mounted ranged penalties: **−4 while the mount doubles its speed,
 * −8 while it runs**; attacking while it moves at half speed costs nothing,
 * and — unlike melee — the full attack stays allowed. Returned as a labeled
 * part (0 = no part at all).
 */
export function mountedRangedPenalty(
  mountMovement: PF1eMountMovement,
): { label: string; value: number } | null {
  if (mountMovement === "double")
    return { label: "mounted, mount double-moving", value: -4 };
  if (mountMovement === "run")
    return { label: "mounted, mount running", value: -8 };
  return null;
}

/** A.11: a lance on a charge deals ×2 (feats may add more — caller facts). */
export const LANCE_CHARGE_MULTIPLIER = 2;

/**
 * A.11's concentration DCs for casting from a moving mount: moving both
 * before and after the cast ⇒ **10 + spell level**; a running mount (up to ×2
 * speed) ⇒ **15 + spell level**. Null ⇒ no mounted DC — the ordinary rules
 * (defensive casting, injury) are the cast gate's own.
 */
export function mountedCastingConcentrationDC(input: {
  spellLevel: number;
  /** The mount moved both before and after the cast this round. */
  movedBeforeAndAfter: boolean;
  mountRunning: boolean;
}): number | null {
  if (input.mountRunning) return 15 + input.spellLevel;
  if (input.movedBeforeAndAfter) return 10 + input.spellLevel;
  return null;
}

/**
 * A.11's Ride checks. The die is the caller's; each verdict names the
 * consequence so the UI can quote the rule it enforced.
 */
export function untrainedMountControl(input: {
  die: number;
  rideMod: number;
}): {
  controlled: boolean;
  /** Fail ⇒ the move becomes a full-round action and the rider does nothing else. */
  reason: string;
} {
  const ok = input.die + input.rideMod >= 20;
  return {
    controlled: ok,
    reason: ok
      ? "the mount is controlled as a move action (Ride DC 20, A.11)"
      : "the move becomes a full-round action and the rider can do nothing else this round (Ride DC 20 failed, A.11)",
  };
}

/** A.11: DC 5 Ride as a free action to guide the mount with the knees. */
export function guideWithKnees(input: {
  die: number;
  rideMod: number;
}): { handsFree: boolean; reason: string } {
  const ok = input.die + input.rideMod >= 5;
  return {
    handsFree: ok,
    reason: ok
      ? "the mount is guided with the knees as a free action — hands free (Ride DC 5, A.11)"
      : "the knees check failed — at least one hand stays on the mount (Ride DC 5, A.11)",
  };
}

/** A.11: the mount falls ⇒ DC 15 Ride or the rider falls for 1d6. */
export function stayInSaddle(input: {
  die: number;
  rideMod: number;
}): { stays: boolean; reason: string } {
  const ok = input.die + input.rideMod >= 15;
  return {
    stays: ok,
    reason: ok
      ? "the rider stays in the saddle (Ride DC 15, A.11)"
      : "the rider falls for 1d6 damage (Ride DC 15 failed, A.11)",
  };
}

/**
 * A.11: an unconscious rider stays mounted on a roll of 50% or less — 75% or
 * less in a military saddle — and falls for 1d6 otherwise. The roll is the
 * caller's d100 face.
 */
export function unconsciousRiderStays(input: {
  saddle: PF1eSaddleKind;
  /** The d100 face, 1–100. */
  roll: number;
}): { stays: boolean; reason: string } {
  if (!Number.isInteger(input.roll) || input.roll < 1 || input.roll > 100) {
    return {
      stays: false,
      reason: "the unconscious-rider roll must be a d100 face (1–100)",
    };
  }
  const chance = input.saddle === "military" ? 75 : 50;
  const stays = input.roll <= chance;
  return {
    stays,
    reason: stays
      ? `the unconscious rider stays in the saddle (roll ${String(input.roll)} ≤ ${String(chance)}%, A.11)`
      : `the unconscious rider falls for 1d6 damage (roll ${String(input.roll)} > ${String(chance)}%, A.11)`,
  };
}
