/**
 * P07/D-193 — **delay** and **ready** as pure `(combat) → combat` transitions, the first half of
 * the P07 checklist (G §4.11; I P2/P6). This module owns the *state* and the *legality* of the two
 * mid-combat reordering actions, in the same style as `combatState.ts` and `core/combat.ts`: every
 * function returns a new combat plus hook names, and a refusal is a reason string the UI shows
 * verbatim — nothing here rolls dice or touches Pixi.
 *
 * The rules it encodes (CRB p.203, AoN 200/201), quoted in the Gap List §4 item 11:
 *   • **Delay** — act normally at any *lower* count you choose; your initiative permanently becomes
 *     that count; you can't interrupt others and you never regain the waited time. You still act
 *     once, later — never twice.
 *   • **Ready** — a standard action (does not provoke) to prepare a standard/move/swift/free action
 *     (never full-round) with a trigger; the readied action resolves *just before* the trigger; your
 *     initiative permanently becomes the count immediately ahead of the triggering creature; unspent
 *     ⇒ lost at your next turn (you may ready again); a 5-foot step may accompany it if you haven't
 *     otherwise moved (the step is the caller's ledger spend, not this module's).
 *
 * The turn pointer is core's (`combat.turn` indexes `sortCombatants(combat.combatants)`). Both
 * transitions re-sort and then point `turn` at whoever acts next, which is what prevents the
 * extra-turn exploits the checklist names: a delayer is never revisited in the round it left, and a
 * readied combatant re-enters *before* the triggerer (so the pointer passes them once, then moves on
 * to the triggerer — never back).
 */
import type { CombatDocument, CombatantDocument } from "../../core/documents";
import { err, okVal, type Result } from "../../core/result";
import {
  sortCombatants,
  currentCombatant,
  endTurnEffects,
  type CombatTransition,
} from "../../core/combat";
import {
  readCombatantState,
  readRoundState,
  withCombatantState,
  activePF1eCombatant,
  type PF1eReadiedAction,
  type PF1eReadyTrigger,
} from "./combatState";
import { spendAction, type PF1eActionSpend } from "./actions";

/**
 * One transition's product. It is exactly core's `CombatTransition` shape — including `expired`,
 * because a delay ends the delayer's turn on the spot and its effect durations tick — so the
 * tracker's existing `push` accepts it unchanged.
 */
export type ReadyDelayTransition = CombatTransition;

/** A described event a ready might answer (the caller — GM/UI — judges whether it matches). */
export interface PF1eReadyEvent {
  kind: PF1eReadyTrigger["kind"];
  /** The combatant whose action is the event (the one a readied action would interrupt). */
  triggererId: string;
}

/** The action kinds the SRD lets you ready — never a full-round action (CRB p.203). */
const READYABLE_ACTIONS: ReadonlySet<PF1eActionSpend["kind"]> = new Set([
  "standard",
  "move",
  "swift",
  "free",
]);

function combatantOf(
  combat: CombatDocument,
  combatantId: string,
): CombatantDocument | null {
  return combat.combatants.find((c) => c._id === combatantId) ?? null;
}

/**
 * Delay: the current combatant sets its initiative permanently to a lower count and re-enters the
 * order later in the round. Refused when the combatant is not current, already last in the order,
 * defeated, or the chosen count does not actually move it later.
 */
export function delayTo(
  combat: CombatDocument,
  combatantId: string,
  initiative: number,
): Result<ReadyDelayTransition> {
  const state = readRoundState(combat);
  if (state.phase === "setup") return err("the encounter has not started");
  if (state.phase === "surprise") {
    return err(
      "delay is not allowed during the surprise round — a single action only",
    );
  }
  const target = combatantOf(combat, combatantId);
  if (target === null) return err("combatant is not part of this encounter");
  const current = currentCombatant(combat);
  if (current === null || current._id !== combatantId) {
    return err("only the current combatant can delay");
  }
  if (target.defeated) return err("a defeated combatant cannot delay");
  if (target.initiative === null) {
    return err("this combatant has no initiative to delay from");
  }
  if (!Number.isSafeInteger(initiative)) {
    return err("delay to a whole-number initiative count");
  }
  if (initiative >= target.initiative) {
    return err("delay moves you to a lower initiative count");
  }

  const oldIndex = sortCombatants(combat.combatants).findIndex(
    (c) => c._id === combatantId,
  );
  const next = combat.combatants.map((c) =>
    c._id === combatantId ? { ...c, initiative } : c,
  );
  const newIndex = sortCombatants(next).findIndex((c) => c._id === combatantId);
  if (newIndex <= oldIndex) {
    return err(
      "that count does not move you later in the order — choose a lower initiative",
    );
  }
  // Everyone between the old slot and the new slot shifted up one, so the next actor now
  // occupies the combatant's old slot. Pointing `turn` there continues the round exactly
  // once per combatant — the delayer is not revisited this round.
  const stepped: CombatDocument = {
    ...combat,
    turn: oldIndex,
    combatants: next,
  };
  // The delayer's turn ends here: its effect durations tick exactly as they would at a turn
  // boundary, and the expired ones report the same hook `nextTurn` fires for them.
  const ended = endTurnEffects(stepped, combatantId);
  return okVal({
    combat: ended.combat,
    hooks: [
      "combat:turn:end",
      "combat:combatant:delay",
      ...ended.expired.map(() => "combat:effect:expire"),
    ],
    expired: ended.expired,
  });
}

/**
 * Ready: the current combatant spends its standard action to prepare an action that fires just
 * before a declared trigger. The prepared action must be a standard/move/swift/free action. The
 * readied action itself costs nothing further when it fires — the standard action was the price.
 */
export function readyCombatant(
  combat: CombatDocument,
  combatantId: string,
  input: {
    action: PF1eActionSpend;
    trigger: PF1eReadyTrigger;
    note?: string;
  },
): Result<ReadyDelayTransition> {
  const state = readRoundState(combat);
  if (state.phase === "setup") return err("the encounter has not started");
  const target = combatantOf(combat, combatantId);
  if (target === null) return err("combatant is not part of this encounter");
  const current = activePF1eCombatant(combat);
  if (current === null || current._id !== combatantId) {
    return err("only the current combatant can ready an action");
  }
  if (target.defeated)
    return err("a defeated combatant cannot ready an action");
  const cs = readCombatantState(target);
  if (cs.ready !== null)
    return err("this combatant already has a readied action");
  if (!READYABLE_ACTIONS.has(input.action.kind)) {
    return err(
      `a readied action must be a standard, move, swift or free action — "${input.action.kind}" is not legal to ready`,
    );
  }
  // The ready is a standard action and does not provoke (CRB p.203, AoN 201).
  const spent = spendAction(cs.actions, { kind: "standard", action: "ready" });
  if (!spent.ok) return err(`cannot ready — ${spent.error}`);

  const ready: PF1eReadiedAction = {
    action: input.action,
    trigger: input.trigger,
    sinceRound: combat.round,
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  return okVal({
    combat: {
      ...combat,
      combatants: combat.combatants.map((c) =>
        c._id === combatantId
          ? withCombatantState(c, { ...cs, actions: spent.value, ready })
          : c,
      ),
    },
    hooks: ["combat:combatant:ready"],
    expired: [],
  });
}

/**
 * The readied combatants whose trigger matches the described event, in combatant order. A trigger
 * with a `targetId` only matches that combatant; a trigger without one matches anyone. The caller
 * picks from the result and calls `resolveReady`.
 */
export function findReadied(
  combat: CombatDocument,
  event: PF1eReadyEvent,
): Array<{ combatantId: string; trigger: PF1eReadyTrigger }> {
  const out: Array<{ combatantId: string; trigger: PF1eReadyTrigger }> = [];
  for (const c of combat.combatants) {
    const ready = readCombatantState(c).ready;
    if (ready === null || c.defeated) continue;
    const trigger = ready.trigger;
    if (trigger.kind !== event.kind) continue;
    if (
      trigger.targetId !== undefined &&
      trigger.targetId !== event.triggererId
    ) {
      continue;
    }
    out.push({ combatantId: c._id, trigger });
  }
  return out;
}

/**
 * Fire a readied action: the readied combatant's initiative permanently becomes the count
 * immediately ahead of the triggerer (`triggerer.initiative + 1`), its ready is spent, and the
 * turn pointer moves to it so the readied action resolves *now*, before the trigger. The prepared
 * action is returned for the caller to execute through the normal attack/cast/move flow. Refused on
 * an initiative collision that would leave the readied combatant anywhere but immediately ahead.
 */
export function resolveReady(
  combat: CombatDocument,
  readiedCombatantId: string,
  triggererCombatantId: string,
): Result<
  ReadyDelayTransition & { action: PF1eActionSpend; trigger: PF1eReadyTrigger }
> {
  const state = readRoundState(combat);
  if (state.phase === "setup") return err("the encounter has not started");
  const readied = combatantOf(combat, readiedCombatantId);
  if (readied === null) return err("combatant is not part of this encounter");
  const cs = readCombatantState(readied);
  if (cs.ready === null)
    return err("this combatant has no readied action to fire");
  if (readied.defeated)
    return err("a defeated combatant's readied action cannot fire");
  const triggerer = combatantOf(combat, triggererCombatantId);
  if (triggerer === null) {
    return err("the triggering combatant is not part of this encounter");
  }
  if (triggerer._id === readiedCombatantId) {
    return err("a combatant cannot be interrupted by its own readied action");
  }
  if (triggerer.defeated)
    return err("a defeated combatant cannot be interrupted");
  if (triggerer.initiative === null) {
    return err("the triggering combatant has no initiative to move ahead of");
  }

  const fired = cs.ready;
  const newInitiative = triggerer.initiative + 1;
  const next = combat.combatants.map((c) =>
    c._id === readiedCombatantId
      ? withCombatantState(
          { ...c, initiative: newInitiative },
          { ...cs, ready: null },
        )
      : c,
  );
  const sorted = sortCombatants(next);
  const readyIndex = sorted.findIndex((c) => c._id === readiedCombatantId);
  const triggerIndex = sorted.findIndex((c) => c._id === triggererCombatantId);
  if (readyIndex + 1 !== triggerIndex) {
    return err(
      "initiative collision — the readied combatant would not land immediately ahead of the triggerer; adjust the order manually",
    );
  }
  return okVal({
    combat: { ...combat, turn: readyIndex, combatants: next },
    hooks: ["combat:combatant:ready:resolve"],
    expired: [],
    action: fired.action,
    trigger: fired.trigger,
  });
}

/**
 * The turn-boundary rule: an unspent ready whose trigger never fired is lost when this combatant's
 * next turn starts (`ready.sinceRound < round`), and re-ready is then allowed. `pf1eNextTurn` calls
 * the same check inline; this predicate is exported so a caller can test or surface the loss
 * without walking the whole transition.
 */
export function readyIsLost(ready: PF1eReadiedAction, round: number): boolean {
  return ready.sinceRound < round;
}
