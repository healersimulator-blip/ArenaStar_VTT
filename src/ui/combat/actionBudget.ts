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
  isFlatFootedByRound,
  readCombatantState,
  spendCombatantAction,
  useAttackOfOpportunity,
} from "../../packages/pf1e/combatState";
import { aooRefusal } from "../../packages/pf1e/interrupts";
import { deriveFromDocuments } from "../../packages/pf1e/actor";
import type { FlatDiff, Op } from "../../core/ops";
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

/**
 * P06/D-185 — one combatant's attack-of-opportunity budget, read from the same three
 * sources the queue and the sheet read: the encounter ledger (`aooUsed`/`aooMax`), the
 * actor's **derivation** for the number (D-183's `aooPerRound` — one per round, plus the
 * Dexterity bonus with Combat Reflexes) and for the combined "may not react at all"
 * fact (`canTakeAoO`: helpless, nothing threatened, or flat-footed without the feat), and
 * the round structure for *why* it is flat-footed (`isFlatFootedByRound`).
 *
 * The refusal string is `interrupts.aooRefusal`'s — the same function the tactical scene
 * seam and (through D-184's `aooRefusal` call) the strategic sim use — so a tooltip, a
 * log line and a refused spend cannot describe the same state three different ways.
 */
export interface AttackOfOpportunityBudget {
  combatantId: string;
  /** `deriveFromDocuments`' number for this combatant's linked PF1e actor. */
  max: number;
  used: number;
  left: number;
  canTake: boolean;
  /** Why not, in `aooRefusal`'s wording; null when the combatant may react. */
  reason: string | null;
  /** Structural flat-footed cause, for the tooltip (surprise round vs no turn yet). */
  flatFootedWhy: "surprise" | "no-turn-yet" | null;
  /** True when an effect or the `"aoo"` deny token refuses outright (paralyzed, …). */
  deniedByEffect: boolean;
  /** True when the derivation's own combined refusal applies (`PF1eDerived.canTakeAoO`). */
  derivationRefused: boolean;
}

/** The actor document one combatant links, or null. */
function linkedActor(
  combat: CombatDocument,
  combatantId: string,
  actors: readonly ActorDocument[],
): {
  combatant: CombatDocument["combatants"][number];
  actor: ActorDocument | null;
} | null {
  const combatant = combat.combatants.find((c) => c._id === combatantId);
  if (!combatant) return null;
  const actorId = combatant.actorId;
  const actor = actorId
    ? (actors.find((a) => a._id === actorId) ?? null)
    : null;
  return { combatant, actor };
}

/**
 * The budget for one combatant, or null when the encounter has no such combatant. A
 * combatant with no linked PF1e actor still gets a ledger read (the encounter's own
 * numbers) but its `max` is the ledger's cached value — never a guessed 1.
 */
export function attackOfOpportunityBudget(
  combat: CombatDocument,
  combatantId: string,
  actors: readonly ActorDocument[] = [],
): AttackOfOpportunityBudget | null {
  const linked = linkedActor(combat, combatantId, actors);
  if (linked === null) return null;
  const state = readCombatantState(linked.combatant);
  const actor = linked.actor;
  // The derivation must see the effects, both homes: the actor's own embedded list and the
  // encounter's referenced copy (`combinedTacticalEffects`, the E01 composition the sheet
  // derives from). Passing the system block alone would drop every condition the actor is
  // suffering — including the flat-footedness and the `cannotAoO` flag this budget exists
  // to read.
  const derived =
    actor !== null && isPF1eActor(actor)
      ? deriveFromDocuments({
          actor: { system: actor.system },
          effects: combinedTacticalEffects(actor, combat, combatantId).effects,
        })
      : null;
  const deniedByEffect = deniedActionsForCombatant(
    combat,
    combatantId,
    actors,
  ).has("aoo");
  const derivationRefused = derived !== null && !derived.canTakeAoO;
  const flatFooted = isFlatFootedByRound(combat, linked.combatant);
  const max = derived?.aooPerRound ?? state.aooMax;
  const used = state.aooUsed;
  const cannotTake = deniedByEffect || derivationRefused;
  const reason = aooRefusal({
    cannotTakeAoO: cannotTake,
    // Round-structural flat-footedness is not an effect, so the derivation cannot see it;
    // AoN 102's exception is read here through the flag the derivation exposes.
    flatFooted: flatFooted.flatFooted,
    combatReflexes: derived?.combatReflexes === true,
    used,
    budgetMax: max,
  });
  return {
    combatantId,
    max,
    used,
    left: Math.max(0, max - used),
    canTake: reason === null,
    reason,
    flatFootedWhy: flatFooted.why,
    deniedByEffect,
    derivationRefused,
  };
}

/** The combatant behind a scene token, if the encounter tracks it (T01/T05 link). */
export function combatantForToken(
  combat: CombatDocument,
  tokenId: string,
): CombatDocument["combatants"][number] | null {
  return combat.combatants.find((c) => c.tokenId === tokenId) ?? null;
}

/**
 * Spend one attack of opportunity through the encounter's authoritative path: permission
 * first, then the queue's own eligibility (`attackOfOpportunityBudget`), then
 * `combatState.useAttackOfOpportunity` — which is what writes `aooUsed`/`aooMax` into
 * `combatant.flags.pf1e`. The returned ops are the panel's usual single combat update, so
 * the caller submits them and nothing else has to know the flag shape.
 */
export function spendAttackOfOpportunityAuthorized(
  combat: CombatDocument,
  combatantId: string,
  user: PermissionUser | null,
  actors: readonly ActorDocument[] = [],
  opts: { reason?: string } = {},
): {
  combat: CombatDocument | null;
  ops: Op[];
  hooks: string[];
  error: string | null;
  budget: AttackOfOpportunityBudget | null;
} {
  const budget = attackOfOpportunityBudget(combat, combatantId, actors);
  if (!budget)
    return {
      combat: null,
      ops: [],
      hooks: [],
      error: "That combatant is not in this encounter.",
      budget: null,
    };
  if (!user || !can(user, "update", combat, "combats"))
    return {
      combat: null,
      ops: [],
      hooks: [],
      error: "You cannot update this encounter.",
      budget,
    };
  if (budget.reason !== null)
    return {
      combat: null,
      ops: [],
      hooks: [],
      error: `Attack of opportunity refused: ${budget.reason}.`,
      budget,
    };
  const combatant = combat.combatants.find((c) => c._id === combatantId);
  if (!combatant)
    return {
      combat: null,
      ops: [],
      hooks: [],
      error: "That combatant is not in this encounter.",
      budget,
    };
  const spent = useAttackOfOpportunity(
    combatant,
    budget.max,
    opts.reason === undefined ? {} : { reason: `the ${opts.reason} reaction` },
  );
  if (!spent.ok)
    return {
      combat: null,
      ops: [],
      hooks: [],
      error: `Attack of opportunity refused: ${spent.error}.`,
      budget,
    };
  const next: CombatDocument = {
    ...combat,
    combatants: combat.combatants.map((c) =>
      c._id === combatantId ? spent.value.combatant : c,
    ),
  };
  return {
    combat: next,
    // The panel's own update shape (CombatPanel): the whole combatant array under one
    // `combats` update — the diff is the flat-diff wire format, so the array is cast the
    // way every other document-shaped diff already is.
    ops: [
      {
        kind: "update",
        ref: { coll: "combats", id: combat._id },
        diff: { combatants: next.combatants } as unknown as FlatDiff,
      },
    ],
    hooks: ["combat:combatant:update"],
    error: null,
    budget: {
      ...budget,
      used: spent.value.used,
      left: spent.value.left,
      canTake: spent.value.left > 0,
      reason:
        spent.value.left > 0
          ? null
          : aooRefusal({ used: spent.value.used, budgetMax: budget.max }),
    },
  };
}
