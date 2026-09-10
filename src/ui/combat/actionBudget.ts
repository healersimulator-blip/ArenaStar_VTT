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
import {
  combinedTacticalEffects,
  deniedActionTokens,
  resolveTacticalEffects,
} from "../../packages/pf1e/effectOps";

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
  /** Deny tokens resolved from the combatant's active effects (E01), for the tooltip. */
  denied: ReadonlySet<string>;
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

/**
 * The deny tokens for one combatant: its linked PF1e actor's effects, read through the
 * same combined homes (actor-embedded + combatant-referenced) the sheet derives from.
 * Non-PF1e combatants (no actor, or a generic one) are never denied.
 */
export function deniedActionsForCombatant(
  combat: CombatDocument,
  combatantId: string,
  actors: readonly ActorDocument[],
): ReadonlySet<string> {
  const member = combat.combatants.find((c) => c._id === combatantId);
  const actorId = member?.actorId;
  const actor = actorId ? actors.find((a) => a._id === actorId) : undefined;
  if (!member || !actor || !isPF1eActor(actor)) return new Set<string>();
  const combined = combinedTacticalEffects(actor, combat, combatantId);
  return deniedActionTokens(resolveTacticalEffects(combined.effects));
}

/** The budget view for one combatant's current turn. */
export function combatantBudget(
  combat: CombatDocument,
  combatantId: string,
  actors: readonly ActorDocument[] = [],
): CombatantBudget | null {
  const member = combat.combatants.find((c) => c._id === combatantId);
  if (!member) return null;
  const ledger = readCombatantState(member).actions;
  const denied = deniedActionsForCombatant(combat, combatantId, actors);
  return {
    ledger,
    denied,
    refusals: {
      standard: actionRefusal(ledger, { kind: "standard" }, denied),
      move: actionRefusal(ledger, { kind: "move" }, denied),
      moveAsStandard: actionRefusal(
        ledger,
        { kind: "move", asStandard: true },
        denied,
      ),
      swift: actionRefusal(ledger, { kind: "swift" }, denied),
      fullRound: actionRefusal(ledger, { kind: "full-round" }, denied),
      fiveFootStep: actionRefusal(ledger, { kind: "five-foot-step" }, denied),
      startFullRound: actionRefusal(
        ledger,
        {
          kind: "start-full-round",
          action: "full-round",
        },
        denied,
      ),
      completeFullRound: actionRefusal(
        ledger,
        { kind: "complete-full-round" },
        denied,
      ),
      immediate: actionRefusal(
        ledger,
        { kind: "immediate", onTurn: false },
        denied,
      ),
    },
  };
}

/**
 * Spend from one combatant's budget, authorized against the encounter's update
 * permission. Returns the updated combat (the panel submits it with only its
 * combatants changed) plus the hook to fire, or the refusal/permission error.
 * `actors` feeds the effect-deny gate (E01); omit it for non-PF1e encounters.
 */
export function spendCombatantActionAuthorized(
  combat: CombatDocument,
  combatantId: string,
  spend: PF1eActionSpend,
  user: PermissionUser | null,
  actors: readonly ActorDocument[] = [],
): { combat: CombatDocument | null; hooks: string[]; error: string | null } {
  if (!user || !can(user, "update", combat, "combats"))
    return {
      combat: null,
      hooks: [],
      error: "You cannot update this encounter.",
    };
  const denied = deniedActionsForCombatant(combat, combatantId, actors);
  const result = spendCombatantAction(combat, combatantId, spend, denied);
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
