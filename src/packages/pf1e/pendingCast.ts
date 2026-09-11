/**
 * P5/C03 multi-round casting (D-161) — the pure layer.
 *
 * Transcribed 2026-09-11 from Archives of Nethys Rules ID 147 ("Cast a
 * Spell", full-round action, CRB pg. 187):
 *
 * - "A spell that takes one round to cast is a full-round action. It comes
 *   into effect just before the beginning of your turn in the round after
 *   you began casting the spell. You then act normally after the spell is
 *   completed."
 * - "When you begin a spell that takes 1 round or longer to cast, you must
 *   continue the invocations, gestures, and concentration from 1 round to
 *   just before your turn in the next round (at least). If you lose
 *   concentration after starting the spell and before it is complete, you
 *   lose the spell."
 * - "You only provoke attacks of opportunity when you begin casting a spell,
 *   even though you might continue casting for at least 1 full round."
 * - Rules ID 133 ("Cast a Spell", Concentration, CRB pg. 183): "If you start
 *   casting a spell but something interferes with your concentration, you
 *   must make a concentration check or lose the spell. ... If you fail, the
 *   spell fizzles with no effect. If you prepare spells, it is lost from
 *   preparation. If you cast at will, it counts against your daily limit of
 *   spells even though you did not cast it successfully." — the slot and
 *   prepared row are therefore spent when the casting BEGINS.
 *
 * The pending casting rides the caster's actor document (the same home as
 * the D-158 held charge): replicated, joiner-visible and GM-authoritative.
 * Clearing the path uses the store's `"-=<path>"` delete marker — a literal
 * null would survive `applyDiff` and fail the actor's re-parse (the D-158
 * round-trip lesson).
 *
 * Out of this slice (documented): minute-plus castings are the same
 * machinery with more rounds between begin and complete (the GM judges the
 * completion either way), casting while mounted or otherwise restricted
 * beyond the existing gate, and AoO resolution at the begin (narrated, not
 * resolved).
 */
import type { Json } from "../../core/documents";

/** A spell begun this round whose effect is deferred to the caster's next turn. */
export interface PF1ePendingCast {
  name: string;
  level: number;
  slotLevel?: number;
  /** NdM dice, or "" for a spell that deals no damage. */
  damageFormula: string;
  saveType: "fort" | "ref" | "will";
  severity: string;
  energyType?: string;
  /** The actor the casting was begun against; completion must land there. */
  targetId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the pending casting from an actor's system block; null when absent. */
export function pendingCastFromSystem(
  system: Record<string, unknown> | null | undefined,
): PF1ePendingCast | null {
  const raw = system === null || system === undefined ? undefined : system.pf1e;
  const pf1e = isRecord(raw) ? raw : null;
  const pending = pf1e ? pf1e.pendingCast : undefined;
  if (!isRecord(pending)) return null;
  if (typeof pending.name !== "string" || pending.name === "") return null;
  if (!Number.isInteger(pending.level)) return null;
  if (typeof pending.targetId !== "string" || pending.targetId === "")
    return null;
  return {
    name: pending.name,
    level: pending.level as number,
    ...(Number.isInteger(pending.slotLevel)
      ? { slotLevel: pending.slotLevel as number }
      : {}),
    damageFormula:
      typeof pending.damageFormula === "string" ? pending.damageFormula : "",
    saveType:
      pending.saveType === "fort" ||
      pending.saveType === "ref" ||
      pending.saveType === "will"
        ? pending.saveType
        : "ref",
    severity: typeof pending.severity === "string" ? pending.severity : "none",
    ...(typeof pending.energyType === "string"
      ? { energyType: pending.energyType }
      : {}),
    targetId: pending.targetId,
  };
}

/**
 * The diff that stores `pending` on the caster; null deletes the path with
 * the store's `"-=<path>"` convention (a literal null would survive the
 * apply and fail the actor's re-parse).
 */
export function pendingCastDiff(
  pending: PF1ePendingCast | null,
): Record<string, Json> {
  if (pending === null) return { "-=system.pf1e.pendingCast": null };
  const value: Record<string, Json> = {
    name: pending.name,
    level: pending.level,
    damageFormula: pending.damageFormula,
    saveType: pending.saveType,
    severity: pending.severity,
    targetId: pending.targetId,
  };
  if (pending.slotLevel !== undefined) value.slotLevel = pending.slotLevel;
  if (pending.energyType !== undefined) value.energyType = pending.energyType;
  return { "system.pf1e.pendingCast": value };
}
