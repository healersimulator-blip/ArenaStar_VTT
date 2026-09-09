/**
 * T05 panel glue — the PF1e action budget made visible in the combat tracker.
 * Pure helpers, tested without a browser (the Svelte panel only renders them):
 * which encounter uses the PF1e economy, what one combatant can still spend this
 * turn (and why not), and the authorized spend path that lands as a `combats`
 * update op. The ledger itself lives in `packages/pf1e/actions.ts` +
 * `combatState.ts`; nothing here re-implements a rule.
 */
import type { ActorDocument, CombatDocument } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import { can } from "../../core/permissions";
import { isPF1eActor } from "../sheets/pf1eSheetModel";
import {
  readCombatantState,
  spendCombatantAction,
} from "../../packages/pf1e/combatState";
import {
  actionRefusal,
  type PF1eActionLedger,
  type PF1eActionSpend,
} from "../../packages/pf1e/actions";

/**
 * An encounter runs the PF1e action economy when at least one combatant links a PF1e
 * actor — the same detection the initiative roller uses. Generic encounters keep the
 * plain core tracker with no PF1e flags written.
 */
export function isPf1eEncounter(
  combat: CombatDocument,
  actors: readonly ActorDocument[],
): boolean {
  return combat.combatants.some((member) => {
    const actorId = member.actorId;
    const actor = actorId ? actors.find((a) => a._id === actorId) : undefined;
    return actor !== undefined && isPF1eActor(actor);
  });
}

/** Why each spend the panel offers would be refused right now (null = allowed). */
export interface CombatantBudget {
  ledger: PF1eActionLedger;
  refusals: {
    standard: string | null;
    move: string | null;
    moveAsStandard: string | null;
    swift: string | null;
    fullRound: string | null;
    fiveFootStep: string | null;
    startFullRound: string | null;
    completeFullRound: string | null;
    immediate: string | null;
  };
}

/** The budget view for one combatant's current turn. */
export function combatantBudget(
  combat: CombatDocument,
  combatantId: string,
): CombatantBudget | null {
  const member = combat.combatants.find((c) => c._id === combatantId);
  if (!member) return null;
  const ledger = readCombatantState(member).actions;
  return {
    ledger,
    refusals: {
      standard: actionRefusal(ledger, { kind: "standard" }),
      move: actionRefusal(ledger, { kind: "move" }),
      moveAsStandard: actionRefusal(ledger, { kind: "move", asStandard: true }),
      swift: actionRefusal(ledger, { kind: "swift" }),
      fullRound: actionRefusal(ledger, { kind: "full-round" }),
      fiveFootStep: actionRefusal(ledger, { kind: "five-foot-step" }),
      startFullRound: actionRefusal(ledger, {
        kind: "start-full-round",
        action: "full-round",
      }),
      completeFullRound: actionRefusal(ledger, { kind: "complete-full-round" }),
      immediate: actionRefusal(ledger, { kind: "immediate", onTurn: false }),
    },
  };
}

/**
 * Spend from one combatant's budget, authorized against the encounter's update
 * permission. Returns the updated combat (the panel submits it with only its
 * combatants changed) plus the hook to fire, or the refusal/permission error.
 */
export function spendCombatantActionAuthorized(
  combat: CombatDocument,
  combatantId: string,
  spend: PF1eActionSpend,
  user: PermissionUser | null,
): { combat: CombatDocument | null; hooks: string[]; error: string | null } {
  if (!user || !can(user, "update", combat, "combats"))
    return {
      combat: null,
      hooks: [],
      error: "You cannot update this encounter.",
    };
  const result = spendCombatantAction(combat, combatantId, spend);
  if (!result.ok)
    return {
      combat: null,
      hooks: [],
      error: `Action refused: ${result.error}.`,
    };
  return {
    combat: result.value,
    hooks: ["combat:combatant:update"],
    error: null,
  };
}
