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
 *   spell deals damage." (Critical confirmation is not encoded in this slice;
 *   the threat face is reported for the table.)
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
 * Out of this slice (documented): critical confirmation, unarmed/natural
 * delivery of a held charge, touching up to six friends as a full-round
 * action, multi-touch spells (one charge per level), and attacks of
 * opportunity against ranged touch casters.
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

/* ------------------------------------------------------------------ *
 * The held charge — persisted on the caster's own actor document.
 * ------------------------------------------------------------------ */

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
  return { "system.pf1e.heldCharge": value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
