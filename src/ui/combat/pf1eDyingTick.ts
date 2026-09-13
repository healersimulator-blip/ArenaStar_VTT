/**
 * P7/H01/D-205 — the dying round's stabilization outcome as a pure plan.
 * `combatState.pf1eNextTurn` reports the obligation (`dyingChecks`); the
 * CombatPanel rolls the Constitution check publicly and hands the verdict
 * here; this module turns it into the exact ops and the line the panel
 * shows. The verdict itself is `injury.ts`'s `stabilizationCheck`.
 */
import type { ActorDocument } from "../../core/documents";
import type { Op } from "../../core/ops";
import { injuryStateOf, type PF1eLethalState } from "../../packages/pf1e/injury";

export interface PF1eDyingTickPlanInput {
  actor: ActorDocument;
  /** `stabilizationCheck`'s verdict for this round's roll. */
  verdict: {
    success: boolean;
    hpAfter: number;
    note: string;
  };
  /** The actor's Constitution score (the death annotation reads it). */
  conScore: number;
}

export interface PF1eDyingTickPlan {
  ops: Op[];
  /** The status line the panel shows; never empty when the verdict ran. */
  note: string;
  /** The state after the write (the panel may badge the row). */
  state: PF1eLethalState;
}

/**
 * Plan the write: a success adds the authored **Stable** condition (which
 * suspends the round checks in favour of the hourly wake — the transition's
 * own gate reads it back); a failure writes the lost hit point. The death
 * annotation is appended when the loss crosses negative Constitution.
 */
export function planDyingTick(
  input: PF1eDyingTickPlanInput,
): PF1eDyingTickPlan {
  const pf1e =
    (input.actor.system as { pf1e?: Record<string, unknown> }).pf1e ?? {};
  const conditions = Array.isArray(pf1e.conditions)
    ? pf1e.conditions.filter((x): x is string => typeof x === "string")
    : [];

  if (input.verdict.success) {
    const nextConditions = conditions.some(
      (x) => x.toLowerCase() === "stable",
    )
      ? conditions
      : [...conditions, "Stable"];
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
      state: "dying",
    };
  }

  const after = injuryStateOf({
    hp: input.verdict.hpAfter,
    conScore: input.conScore,
  });
  const note =
    after.state === "dead"
      ? `${input.actor.name} — ${input.verdict.note}; ${after.note ?? ""}`
      : `${input.actor.name} — ${input.verdict.note}`;
  return {
    ops: [
      {
        kind: "update" as const,
        ref: { coll: "actors" as const, id: input.actor._id },
        diff: { "system.pf1e.hp": input.verdict.hpAfter },
      },
    ],
    note,
    state: after.state,
  };
}
