/**
 * P7/H01/D-206 — coup de grâce delivery as a pure plan.
 *
 * The attack itself (A.13, AoN 413) is a full-round action that provokes,
 * automatically hits and is a critical hit; a bow/crossbow must be adjacent.
 * The delivery's damage is already rolled when this planner runs — it turns
 * the (damage, Fort save) pair into the exact ops the panel submits. The
 * verdict is `injury.coupDeGraceVerdict`; this module turns it into HP
 * bookkeeping so the lethal ladder has one honest reader.
 *
 * Every die is the caller's; every refusal is named.
 */
import type { ActorDocument } from "../../core/documents";
import type { Op } from "../../core/ops";
import {
  coupDeGraceVerdict,
  injuryStateOf,
} from "../../packages/pf1e/injury";

export interface PF1eCoupGracePlanInput {
  attackerName: string;
  defender: ActorDocument;
  /** The critical damage already rolled (the automatic hit + crit). */
  damageDealt: number;
  /** The mandatory Fort save's d20 face (1–20), unless crit-immune. */
  saveDie?: number;
  fortBonus: number;
  critImmune?: boolean;
  /** The defender's Constitution score — dead when negative HP reaches it. */
  conScore: number;
}

export interface PF1eCoupGracePlan {
  ops: Op[];
  note: string;
  dead: boolean;
  /** True when the save was owed and failed / the damage killed outright. */
  killed: boolean;
}

export function planCoupGrace(
  input: PF1eCoupGracePlanInput,
): { ok: true; plan: PF1eCoupGracePlan } | { ok: false; error: string } {
  const pf1e =
    (input.defender.system as { pf1e?: Record<string, unknown> }).pf1e ?? {};
  const rawHp = (pf1e as Record<string, unknown>).hp;
  const hp =
    typeof rawHp === "number" && Number.isFinite(rawHp) ? rawHp : 0;

  const hpAfterDamage = hp - Math.max(0, Math.floor(input.damageDealt));
  const afterDamage = injuryStateOf({
    hp: hpAfterDamage,
    conScore: input.conScore,
  });
  const killedByDamage = afterDamage.state === "dead";

  const verdict = coupDeGraceVerdict({
    damageDealt: input.damageDealt,
    killedByDamage,
    ...(input.saveDie !== undefined ? { saveDie: input.saveDie } : {}),
    fortBonus: input.fortBonus,
    ...(input.critImmune ? { critImmune: true } : {}),
  });
  if (!verdict.ok) return { ok: false, error: verdict.error };

  const dead = verdict.dead;
  // The damage HP write always lands; when the save kills, negative Con marks death.
  const hpAfter = dead
    ? killedByDamage
      ? hpAfterDamage
      : Math.min(hpAfterDamage, -Math.max(0, input.conScore))
    : hpAfterDamage;

  const notes = [verdict.notes.join(" — ")];
  const summary = dead
    ? `${input.defender.name} dies to the coup de grâce (${String(input.damageDealt)} damage${verdict.save ? `, DC ${verdict.save.dc} Fort ${verdict.save.passed ? "made" : "failed"}` : ""})`
    : `${input.defender.name} survives the coup de grâce (${String(input.damageDealt)} damage, Fort DC ${verdict.save?.dc ?? "?" } ${verdict.save?.passed ? "made" : "?"}) — ${String(hp)} → ${String(hpAfter)} HP`;

  return {
    ok: true,
    plan: {
      ops: [
        {
          kind: "update" as const,
          ref: { coll: "actors" as const, id: input.defender._id },
          diff: { "system.pf1e.hp": hpAfter },
        },
      ],
      note: `${input.attackerName} — ${summary} — ${notes.join(" ")}`,
      dead,
      killed: dead,
    },
  };
}
