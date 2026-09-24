/** PF1e health adapter for GM-authored MATT Hurt / Heal steps.
 * Positive amounts heal, negative amounts hurt. Use the same temporary-HP,
 * nonlethal and maximum-HP arithmetic as the host's verified roll.apply verb.
 * Reject unlinked/unauthored or malformed HP instead of inventing a commoner.
 */
import type { ActorDocument, Json } from "../../core/documents";
import { deriveFromActorDocument } from "./actor";
import { planRollApply } from "./rollApply";

export function planAutomationHealth(actor: ActorDocument, amount: number):
  { ok: true; diff: Record<string, Json | null>; note: string } | { ok: false; error: string } {
  const raw: unknown = actor.system?.pf1e;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, error: "actor has no authored PF1e health" };
  const pf1e = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(pf1e.hp) || !Number.isSafeInteger(pf1e.hpMax) ||
      (pf1e.hpMax as number) < 1 || (pf1e.hp as number) < 0 ||
      (pf1e.nonlethalDamage !== undefined && (!Number.isSafeInteger(pf1e.nonlethalDamage) ||
        (pf1e.nonlethalDamage as number) < 0)) ||
      (pf1e.tempHp !== undefined && (!Number.isSafeInteger(pf1e.tempHp) || (pf1e.tempHp as number) < 0)) ||
      (pf1e.tempHpSources !== undefined &&
        (typeof pf1e.tempHpSources !== "object" || !pf1e.tempHpSources || Array.isArray(pf1e.tempHpSources) ||
          Object.entries(pf1e.tempHpSources).some(([key, value]) => !key || !Number.isSafeInteger(value) ||
            (value as number) < 0))))
    return { ok: false, error: "actor has malformed or unauthored PF1e HP/temp HP" };
  const derived = deriveFromActorDocument(actor);
  const result = planRollApply({ mode: amount < 0 ? "damage" : "healing", amount: Math.abs(amount),
    hp: derived.hp, hpMax: derived.hpMax, nonlethalDamage: derived.nonlethalDamage,
    tempHpSources: derived.tempHpSources,
    legacyTempHp: pf1e.tempHpSources === undefined && typeof pf1e.tempHp === "number" });
  return result.ok ? { ok: true, diff: result.plan.diff, note: result.plan.note } : result;
}
