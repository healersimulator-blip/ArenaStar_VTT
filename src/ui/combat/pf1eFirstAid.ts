/**
 * P7/H01/D-206 — first aid (stabilize a dying creature with the Heal skill).
 *
 * `healFirstAid` owns the DC 15 verdict; this module turns it into the exact
 * ops and the status line the CombatPanel shows — the same shape as
 * `pf1eDyingTick.planDyingTick` so the dying machinery has one honest
 * vocabulary: a success adds the authored **Stable** condition (which suspends
 * the round checks in favour of the hourly wake — the transition's own gate
 * reads it back), a failure writes nothing.
 *
 * The provision (A.13, AoN 164) is a standard action that provokes — the panel
 * threads it through the same `resolveActionProvokes` every other action uses,
 * so the queued interrupt is visible before the die is rolled.
 */
import type { ActorDocument } from "../../core/documents";
import type { Op } from "../../core/ops";

export interface PF1eFirstAidPlanInput {
  actor: ActorDocument;
  verdict: { stabilized: boolean; note: string };
}

export interface PF1eFirstAidPlan {
  ops: Op[];
  note: string;
}

export function planFirstAid(input: PF1eFirstAidPlanInput): PF1eFirstAidPlan {
  const pf1e =
    (input.actor.system as { pf1e?: Record<string, unknown> }).pf1e ?? {};
  const conditions = Array.isArray(pf1e.conditions)
    ? pf1e.conditions.filter((x): x is string => typeof x === "string")
    : [];

  if (!input.verdict.stabilized) {
    return {
      ops: [],
      note: `${input.actor.name} — ${input.verdict.note}`,
    };
  }

  const stable = conditions.some((x) => x.toLowerCase() === "stable");
  const nextConditions = stable ? conditions : [...conditions, "Stable"];
  return {
    ops:
      nextConditions === conditions
        ? []
        : [
            {
              kind: "update" as const,
              ref: { coll: "actors" as const, id: input.actor._id },
              diff: { "system.pf1e.conditions": nextConditions },
            },
          ],
    note: `${input.actor.name} — ${input.verdict.note}`,
  };
}
