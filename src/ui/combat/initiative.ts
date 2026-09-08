import type { ActorDocument, CombatDocument, SceneDocument } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import { can } from "../../core/permissions";
import {
  applyInitiative,
  currentCombatant,
  sortCombatants,
  type CombatTransition,
} from "../../core/combat";
import { isPF1eActor, pf1eSheetView } from "../sheets/pf1eSheetModel";

import { selectedTokens, type TokenSelection } from "./tokenSelection";
import { resolveInitiativeOrder } from "../../packages/pf1e/initiativeOrder";

type RollResult = { transition: CombatTransition | null; error: string | null };

/** Explicit rerolls preserve the active combatant, not their obsolete sorted index. */
export function retainActiveTurn(
  before: CombatDocument,
  transition: CombatTransition,
): CombatTransition {
  // The initial roll at encounter start establishes who goes first. Subsequent edits
  // must not silently grant/skip a turn just because the sorted indices changed.
  if (
    before.round === 1 &&
    before.turn === 0 &&
    before.combatants.every((c) => c.initiative === null)
  )
    return transition;
  const active = currentCombatant(before);
  if (!active) return transition;
  const index = sortCombatants(transition.combat.combatants).findIndex(
    (c) => c._id === active._id,
  );
  return index < 0
    ? transition
    : { ...transition, combat: { ...transition.combat, turn: index } };
}

/** Public local rolls only. PF1e ties are resolved for actor-aware batches; no hidden-roll or automatic stat-change re-sort. */
export function rollEncounterInitiative(
  combat: CombatDocument,
  scene: SceneDocument,
  actors: readonly ActorDocument[],
  user: PermissionUser | null,
  d20: () => number,
): RollResult {
  const fail = (error: string): RollResult => ({ transition: null, error });
  if (!user || !can(user, "update", combat, "combats"))
    return fail("You cannot roll this encounter's initiative.");
  if (combat.flags.core?.sceneId !== undefined && combat.flags.core.sceneId !== scene._id)
    return fail("Encounter belongs to a different scene.");
  // Validate the entire roster before consuming randomness or proposing any writes.
  const inputs: {
    id: string;
    actorId: string | null;
    modifier: number;
    explanation: string;
  }[] = [];
  let pf1e = false;
  for (const member of combat.combatants) {
    const token = member.tokenId
      ? scene.tokens.find((t) => t._id === member.tokenId)
      : undefined;
    if (member.tokenId && !token)
      return fail(
        "A combatant's token is missing from the active scene. Repair the roster before rolling.",
      );
    if (member.hidden || token?.hidden)
      return fail(
        "Hidden initiative is not supported by this public roll control. No rolls were applied.",
      );
    const actorId = member.actorId ?? token?.actorId ?? null;
    const actor = actorId ? actors.find((a) => a._id === actorId) : undefined;
    if (actorId && (!actor || !can(user, "read", actor, "actors")))
      return fail("A linked actor is unavailable. No rolls were applied.");
    let modifier = 0;
    let explanation = "Generic initiative: unmodified d20";
    if (actor && isPF1eActor(actor)) {
      pf1e = true;
      const view = pf1eSheetView(actor);
      if (view.effectErrors.length || view.derived.issues.length)
        return fail(
          "A PF1e actor has invalid data or effects. Review its sheet diagnostics before rolling.",
        );
      modifier = view.derived.initiative;
      explanation = view.derived.explain.initiative ?? "PF1e initiative";
    }
    if (!Number.isSafeInteger(modifier)) return fail("Invalid initiative modifier.");
    inputs.push({ id: member._id, actorId, modifier, explanation });
  }
  const rolls: Record<string, number> = {};
  const records = new Map<
    string,
    {
      die: number;
      modifier: number;
      total: number;
      explanation: string;
      actorId: string | null;
    }
  >();
  for (const input of inputs) {
    const die = d20();
    const total = die + input.modifier;
    if (!Number.isInteger(die) || die < 1 || die > 20 || !Number.isSafeInteger(total))
      return fail("Invalid d20 result. No rolls were applied.");
    rolls[input.id] = total;
    records.set(input.id, {
      die,
      modifier: input.modifier,
      total,
      explanation: input.explanation,
      actorId: input.actorId,
    });
  }
  let roster = combat.combatants;
  let tieRolls: Record<string, number[]> = {};
  if (pf1e) {
    const ordering = resolveInitiativeOrder(
      inputs.map((input) => ({
        id: input.id,
        modifier: input.modifier,
        total: rolls[input.id] ?? NaN,
      })),
      d20,
    );
    if (ordering.error) return fail(ordering.error);
    tieRolls = ordering.tieRolls;
    const rank = new Map(ordering.order.map((id, index) => [id, index]));
    roster = [...roster].sort((a, b) => (rank.get(a._id) ?? 0) - (rank.get(b._id) ?? 0));
  }
  // Core's stable equal-total sort preserves this persisted order through every transition.
  // Compare the active identity against the original roster, not the preordered one.
  const transition = retainActiveTurn(
    combat,
    applyInitiative({ ...combat, combatants: roster }, rolls),
  );
  transition.combat = {
    ...transition.combat,
    combatants: transition.combat.combatants.map((c) => {
      const record = records.get(c._id);
      return record
        ? {
            ...c,
            flags: {
              ...c.flags,
              core: {
                ...c.flags.core,
                initiativeRoll: {
                  ...record,
                  tiePolicy: pf1e ? "pf1e" : "stable",
                  tieRolls: tieRolls[c._id] ?? [],
                },
              },
            },
          }
        : c;
    }),
  };
  return { transition, error: null };
}

/** A manual override invalidates the old roll receipt; unrelated metadata survives. */
export function manualInitiative(
  combat: CombatDocument,
  id: string,
  value: number,
): CombatTransition {
  const transition = retainActiveTurn(combat, applyInitiative(combat, { [id]: value }));
  transition.combat = {
    ...transition.combat,
    combatants: transition.combat.combatants.map((c) => {
      if (c._id !== id || !c.flags.core) return c;
      const { initiativeRoll: _old, ...core } = c.flags.core;
      void _old;
      return { ...c, flags: { ...c.flags, core } };
    }),
  };
  return transition;
}

/** Roll only selected roster members. Never reroll or rewrite an unselected receipt. */
export function rollSelectedInitiative(
  combat: CombatDocument,
  scene: SceneDocument,
  actors: readonly ActorDocument[],
  user: PermissionUser | null,
  d20: () => number,
  selection: TokenSelection,
): RollResult {
  if (selection.ids.length === 0)
    return rollEncounterInitiative(combat, scene, actors, user, d20);
  const resolved = selectedTokens(scene, selection);
  if (resolved.error) return { transition: null, error: resolved.error };
  if (resolved.tokens.some((t) => !combat.combatants.some((c) => c.tokenId === t._id)))
    return {
      transition: null,
      error: "Some selected tokens are not in this encounter. Add them before rolling.",
    };
  const ids = new Set(resolved.tokens.map((t) => t._id));
  const chosen = combat.combatants.filter((c) => c.tokenId && ids.has(c.tokenId));
  const untouched = combat.combatants.filter((c) => !c.tokenId || !ids.has(c.tokenId));
  const result = rollEncounterInitiative(
    { ...combat, round: 0, turn: 0, combatants: chosen },
    scene,
    actors,
    user,
    d20,
  );
  if (!result.transition) return result;
  // A cross-selection tie is not a reason to veto the GM's edit. Keep the old
  // relative slots for those ties; do not reroll or rewrite unselected members.
  const rolled = result.transition.combat.combatants.map((c) => {
    const tied = untouched.some(
      (other) => other.initiative !== null && other.initiative === c.initiative,
    );
    const receipt = c.flags.core?.initiativeRoll;
    if (!tied || !receipt || typeof receipt !== "object" || Array.isArray(receipt)) return c;
    return {
      ...c,
      flags: {
        ...c.flags,
        core: {
          ...c.flags.core,
          initiativeRoll: { ...receipt, crossSelectionTie: "stable-order" },
        },
      },
    };
  });
  let index = 0;
  const merged = combat.combatants.map((c) =>
    c.tokenId && ids.has(c.tokenId) ? (rolled[index++] ?? c) : c,
  );
  const transition = {
    ...result.transition,
    combat: { ...combat, combatants: sortCombatants(merged) },
  };
  return { error: null, transition: retainActiveTurn(combat, transition) };
}
