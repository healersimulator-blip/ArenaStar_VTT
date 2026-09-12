/**
 * P5/C03 touch spells and held charges (D-158) — the pure layer.
 *
 * Transcribed 2026-09-11 from Archives of Nethys Rules ID 133 ("Cast a
 * Spell", CRB pg. 183), "Touch Spells in Combat":
 *
 * - "To use these spells, you cast the spell and then touch the subject. In
 *   the same round that you cast the spell, you may also touch (or attempt to
 *   touch) as a free action."
 * - "Touching an opponent with a touch spell is considered to be an armed
 *   attack and therefore does not provoke attacks of opportunity."
 * - "You can score critical hits with either type of attack as long as the
 *   spell deals damage." D-159 encodes the confirmation: CRB "Critical Hits"
 *   (R02, Rules ID 131 "Attack", pg. 182) — "you immediately make an attempt
 *   to 'confirm' the critical hit—another attack roll with all the same
 *   modifiers as the attack roll you just made. If the confirmation roll also
 *   results in a hit against the target's AC, your original hit is a critical
 *   hit. ... If the confirmation roll is a miss, then your hit is just a
 *   regular hit." and "the threat range for a critical hit on an attack roll
 *   is 20, and the multiplier is ×2." The CRB also exempts precision damage
 *   and extra dice from special abilities; neither exists in this product's
 *   authored spell damage, so ×2 of the rolled total is exact.
 * - "You can automatically touch one friend or use the spell on yourself, but
 *   to touch an opponent, you must succeed on an attack roll." (D-159: the
 *   flows take a `willing` declaration and skip the attack roll entirely.)
 * - "Your opponent's AC against a touch attack does not include any armor
 *   bonus, shield bonus, or natural armor bonus. His size modifier, Dexterity
 *   modifier, and deflection bonus (if any) all apply normally." — the sheet
 *   reads the target's derived touch AC, which is exactly that composition.
 * - Holding the Charge: "If you don't discharge the spell in the round when
 *   you cast the spell, you can hold the charge indefinitely. You can
 *   continue to make touch attacks round after round. If you touch anything
 *   or anyone while holding a charge, even unintentionally, the spell
 *   discharges. If you cast another spell, the touch spell dissipates."
 * - "Ranged Touch Spells in Combat": the attack is "made as part of the spell
 *   and do[es] not require a separate action"; "Unless otherwise noted,
 *   ranged touch attacks cannot be held until a later turn."
 *
 * D-162 transcribed the rest of the same "Holding the Charge" paragraph
 * (AoN Rules ID 133, verbatim): "You can touch one friend as a standard
 * action or up to six friends as a full-round action. Alternatively, you may
 * make a normal unarmed attack (or an attack with a natural weapon) while
 * holding a charge. In this case, you aren't considered armed and you
 * provoke attacks of opportunity as normal for the attack. If your unarmed
 * attack or natural weapon attack normally doesn't provoke attacks of
 * opportunity, neither does this attack. If the attack hits, you deal normal
 * damage for your unarmed attack or natural weapon and the spell discharges.
 * If the attack misses, you are still holding the charge." The delivery is
 * therefore a NORMAL weapon attack against NORMAL AC — not a touch attack —
 * and on a hit the weapon's damage and the spell's full resolution both land.
 *
 * D-162 also transcribed AoN Rules ID 229 ("Duration", CRB pg. 215,
 * "Touch Spells and Holding the Charge"): "Some touch spells allow you to
 * touch multiple targets as part of the spell. You can't hold the charge of
 * such a spell; you must touch all targets of the spell in the same round
 * that you finish casting the spell." Multi-charge held spells are a
 * different, per-spell property: Chill Touch (CRB pg. 255) says "You can use
 * this melee touch attack up to one time per level" — each touch consumes
 * one of the spell's charges, so a held charge carries a charge count
 * (`charges`, default 1) and each successful delivery consumes exactly one.
 * The "touch multiple targets as part of the spell" restriction is a
 * spell-specific property this contract does not model; it is a GM call on
 * which spells may be held at all.
 *
 * Out of this slice (documented): attacks of opportunity provoked by ranged
 * touch attacks and by unarmed/natural release attacks (narrated, resolved
 * once P6's interrupt queue lands), and the spell-specific no-hold flag for
 * multi-target touch spells (ID 229).
 */
import type { Json } from "../../core/documents";

/** The attack roll that delivers a touch spell. */
export interface PF1eTouchAttackInput {
  /** The d20 face. */
  die: number;
  /** BAB + the touch ability modifier (Str melee / Dex ranged) + size. */
  bonus: number;
  /** The target's touch AC (no armour, shield or natural armour). */
  touchAc: number;
}

export interface PF1eTouchAttackResult {
  ok: boolean;
  error: string | null;
  total: number;
  /** Natural 20 threatens; damage-dealing touch spells can crit. */
  threat: boolean;
  hit: boolean;
}

/** A touch attack hits when its total meets the touch AC. */
export function resolveTouchAttack(
  input: PF1eTouchAttackInput,
): PF1eTouchAttackResult {
  const fail = (error: string): PF1eTouchAttackResult => ({
    ok: false,
    error,
    total: 0,
    threat: false,
    hit: false,
  });
  if (!Number.isInteger(input.die) || input.die < 1 || input.die > 20)
    return fail(`d20 face ${String(input.die)} is not an integer 1–20`);
  if (!Number.isInteger(input.bonus))
    return fail(`bonus ${String(input.bonus)} is not an integer`);
  if (!Number.isInteger(input.touchAc) || input.touchAc < 0)
    return fail(`touch AC ${String(input.touchAc)} is not an integer >= 0`);
  const total = input.die + input.bonus;
  return {
    ok: true,
    error: null,
    total,
    threat: input.die === 20,
    hit: total >= input.touchAc,
  };
}

/**
 * Whether a touch attack needs a critical confirmation roll (D-159). A threat
 * confirms only for damage-dealing spells: Rules ID 133 — "You can score
 * critical hits with either type of attack as long as the spell deals
 * damage." The confirmation roll itself is "another attack roll with all the
 * same modifiers" (Rules ID 131), so the flows reuse `resolveTouchAttack`.
 */
export function touchCriticalNeedsConfirmation(
  threat: boolean,
  dealsDamage: boolean,
): boolean {
  return threat && dealsDamage;
}

/**
 * The confirmed critical's damage: "roll your damage more than once, with all
 * your usual bonuses, and add the rolls together" with the touch-spell
 * multiplier ×2 (Rules ID 131). Authored spell damage carries no precision
 * dice or special-ability dice, so doubling the rolled total is exact.
 */
export function criticalDamageTotal(baseTotal: number): number {
  return baseTotal * 2;
}

/* ------------------------------------------------------------------ *
 * The held charge — persisted on the caster's own actor document.
 * ------------------------------------------------------------------ */

/**
 * The most charges a held touch spell can carry. Spell-derived counts scale
 * with caster level ("up to one time per level", Chill Touch, CRB pg. 255);
 * the cap is an authoring bound, not a rule.
 */
export const PF1E_HELD_CHARGE_MAX_CHARGES = 50;

/**
 * "You can touch one friend as a standard action or up to six friends as a
 * full-round action" (Rules ID 133) — the full-round action touches at most
 * six willing targets.
 */
export const PF1E_ALLY_TOUCH_MAX = 6;

/** A charge held after a missed melee touch attack ("holding the charge"). */
export interface PF1eHeldCharge {
  name: string;
  level: number;
  slotLevel?: number;
  /** NdM dice, or "" for a spell that deals no damage. */
  damageFormula: string;
  saveType: "fort" | "ref" | "will";
  severity: string;
  energyType?: string;
  /**
   * Remaining touches the held spell can still deliver (D-162). Absent or 1
   * for ordinary touch spells; a spell like Chill Touch holds one charge per
   * caster level ("up to one time per level"). Each successful delivery —
   * touch attack, willing auto-touch or unarmed/natural release — consumes
   * exactly one charge.
   */
  charges?: number;
}

/** How many touches the held charge can still deliver (default 1). */
export function heldChargeCount(charge: PF1eHeldCharge): number {
  const charges = charge.charges;
  if (!Number.isInteger(charges) || (charges as number) < 1) return 1;
  return charges as number;
}

/**
 * The charge state after one successful delivery (D-162): a multi-charge
 * spell keeps holding `charges − 1`; the last charge clears to null. The
 * caller writes the result with `heldChargeDiff`.
 */
export function consumeHeldCharge(
  charge: PF1eHeldCharge,
): PF1eHeldCharge | null {
  const left = heldChargeCount(charge) - 1;
  if (left <= 0) return null;
  return { ...charge, charges: left };
}

/**
 * Consume `count` charges at once (the full-round ally touch, D-162): the
 * state after touching `count` willing targets, or null when the spell is
 * fully discharged. Refuses to consume more charges than are held.
 */
export function consumeHeldCharges(
  charge: PF1eHeldCharge,
  count: number,
): PF1eHeldCharge | null {
  const left = heldChargeCount(charge) - count;
  if (left <= 0) return null;
  return { ...charge, charges: left };
}

/** Read the held charge from an actor's system block; null when absent. */
export function heldChargeFromSystem(
  system: Record<string, unknown> | null | undefined,
): PF1eHeldCharge | null {
  const raw = system === null || system === undefined ? undefined : system.pf1e;
  const pf1e = isRecord(raw) ? raw : null;
  const charge = pf1e ? pf1e.heldCharge : undefined;
  if (!isRecord(charge)) return null;
  if (typeof charge.name !== "string" || charge.name === "") return null;
  if (!Number.isInteger(charge.level)) return null;
  return {
    name: charge.name,
    level: charge.level as number,
    ...(Number.isInteger(charge.slotLevel)
      ? { slotLevel: charge.slotLevel as number }
      : {}),
    damageFormula:
      typeof charge.damageFormula === "string" ? charge.damageFormula : "",
    saveType:
      charge.saveType === "fort" ||
      charge.saveType === "ref" ||
      charge.saveType === "will"
        ? charge.saveType
        : "ref",
    severity: typeof charge.severity === "string" ? charge.severity : "none",
    ...(typeof charge.energyType === "string"
      ? { energyType: charge.energyType }
      : {}),
    // D-162: a non-integer or out-of-range count reads as the single-charge
    // default rather than rejecting the actor (a refused value is not a
    // guessed one; the schema still names the error for authored writes).
    ...(Number.isInteger(charge.charges) &&
    (charge.charges as number) >= 1 &&
    (charge.charges as number) <= PF1E_HELD_CHARGE_MAX_CHARGES
      ? { charges: charge.charges as number }
      : {}),
  };
}

/**
 * The diff that stores `charge` on the caster; null deletes the path with the
 * store's `"-=<path>"` convention (a literal null would survive the apply and
 * fail the actor's re-parse).
 */
export function heldChargeDiff(
  charge: PF1eHeldCharge | null,
): Record<string, Json | null> {
  if (charge === null) return { "-=system.pf1e.heldCharge": null };
  const value: Record<string, Json> = {
    name: charge.name,
    level: charge.level,
    damageFormula: charge.damageFormula,
    saveType: charge.saveType,
    severity: charge.severity,
  };
  if (charge.slotLevel !== undefined) value.slotLevel = charge.slotLevel;
  if (charge.energyType !== undefined) value.energyType = charge.energyType;
  if (charge.charges !== undefined) value.charges = charge.charges;
  return { "system.pf1e.heldCharge": value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
