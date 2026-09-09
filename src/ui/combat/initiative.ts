import type {
  ActorDocument,
  CombatDocument,
  CombatantDocument,
  SceneDocument,
} from "../../core/documents";
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
  if (
    combat.flags.core?.sceneId !== undefined &&
    combat.flags.core.sceneId !== scene._id
  )
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
    if (!Number.isSafeInteger(modifier))
      return fail("Invalid initiative modifier.");
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
    if (
      !Number.isInteger(die) ||
      die < 1 ||
      die > 20 ||
      !Number.isSafeInteger(total)
    )
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
    roster = [...roster].sort(
      (a, b) => (rank.get(a._id) ?? 0) - (rank.get(b._id) ?? 0),
    );
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

// ─── T02: verifiable hidden GM rolls ──────────────────────────────────────────

/** GM-facing receipt for a hidden initiative roll (flags.pf1e.hiddenInitiative). */
export interface HiddenInitiativeReceipt {
  die: number;
  modifier: number;
  total: number;
  explanation: string;
  actorId: string | null;
  /** Tie-break roll-offs for this hidden batch (recorded d20s, D-123 policy). */
  tieRolls: number[];
}

export interface HiddenRollResult {
  transition: CombatTransition | null;
  error: string | null;
  /** Combatant ids that were rolled (the hidden subset). */
  rolled: string[];
  /** Combatant ids skipped because they are not hidden — untouched, receipts intact. */
  skipped: string[];
}

/**
 * Roll initiative for the HIDDEN combatants only, GM-style (T02). The public control
 * refuses hidden tokens so a public roll can never expose them; this is the other
 * half: the GM rolls behind the screen.
 *
 * What is and is not secret, explicitly:
 *  - the ORDER must be authoritative, so `combatant.initiative` carries the real
 *    total — whose turn comes next is observable at the table anyway;
 *  - the BREAKDOWN (die, modifier, actor explanation) would leak stats, so it goes
 *    to `flags.pf1e.hiddenInitiative`, a GM-facing receipt, and the public
 *    `flags.core.initiativeRoll` is never written for hidden members;
 *  - the tracker shows "?" for hidden members to non-GM users
 *    (`hiddenInitiativeDisplay`), so no value is displayed to players.
 */
export function rollHiddenInitiative(
  combat: CombatDocument,
  scene: SceneDocument,
  actors: readonly ActorDocument[],
  user: PermissionUser | null,
  d20: () => number,
  selection?: TokenSelection,
): HiddenRollResult {
  const fail = (error: string): HiddenRollResult => ({
    transition: null,
    error,
    rolled: [],
    skipped: [],
  });
  if (!user || !can(user, "update", combat, "combats"))
    return fail("You cannot roll this encounter's initiative.");
  if (
    combat.flags.core?.sceneId !== undefined &&
    combat.flags.core.sceneId !== scene._id
  )
    return fail("Encounter belongs to a different scene.");

  let scope: readonly CombatantDocument[] = combat.combatants;
  if (selection && selection.ids.length > 0) {
    const resolved = selectedTokens(scene, selection);
    if (resolved.error) return fail(resolved.error);
    const ids = new Set(resolved.tokens.map((t) => t._id));
    scope = combat.combatants.filter((c) => c.tokenId && ids.has(c.tokenId));
    if (
      scope.some(
        (c) => c.tokenId && !scene.tokens.some((t) => t._id === c.tokenId),
      )
    )
      return fail("A combatant's token is missing from the active scene.");
  }

  const hidden = scope.filter(
    (c) =>
      c.hidden ||
      (c.tokenId !== null &&
        scene.tokens.find((t) => t._id === c.tokenId)?.hidden === true),
  );
  const skipped = scope.filter((c) => !hidden.includes(c)).map((c) => c._id);
  if (hidden.length === 0) return fail("No hidden combatants to roll for.");

  // Same validation as the public path (token presence, actor readability), minus the
  // hidden refusal — hidden is the entry condition here.
  const rolls: Record<string, number> = {};
  const records = new Map<string, HiddenInitiativeReceipt>();
  let pf1e = false;
  for (const member of hidden) {
    const token = member.tokenId
      ? scene.tokens.find((t) => t._id === member.tokenId)
      : undefined;
    if (member.tokenId && !token)
      return fail(
        "A combatant's token is missing from the active scene. No rolls were applied.",
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
    if (!Number.isSafeInteger(modifier))
      return fail("Invalid initiative modifier.");
    const die = d20();
    const total = die + modifier;
    if (
      !Number.isInteger(die) ||
      die < 1 ||
      die > 20 ||
      !Number.isSafeInteger(total)
    )
      return fail("Invalid d20 result. No rolls were applied.");
    rolls[member._id] = total;
    records.set(member._id, {
      die,
      modifier,
      total,
      explanation,
      actorId,
      tieRolls: [],
    });
  }

  // PF1e tie policy applies to the hidden batch too (order is observable); the
  // roll-offs are recorded in the HIDDEN receipts, not public ones.
  let roster = combat.combatants;
  let tieRolls: Record<string, number[]> = {};
  if (pf1e) {
    const ordering = resolveInitiativeOrder(
      hidden.map((c) => ({
        id: c._id,
        modifier: records.get(c._id)?.modifier ?? 0,
        total: rolls[c._id] ?? NaN,
      })),
      d20,
    );
    if (ordering.error) return fail(ordering.error);
    tieRolls = ordering.tieRolls;
    const rank = new Map(ordering.order.map((id, index) => [id, index]));
    const sortedHidden = [...hidden].sort(
      (a, b) => (rank.get(a._id) ?? 0) - (rank.get(b._id) ?? 0),
    );
    const hiddenIds = new Set(hidden.map((c) => c._id));
    roster = [
      ...combat.combatants.filter((c) => !hiddenIds.has(c._id)),
      ...sortedHidden,
    ];
  }

  const transition = retainActiveTurn(
    combat,
    applyInitiative({ ...combat, combatants: roster }, rolls),
  );
  transition.combat = {
    ...transition.combat,
    combatants: transition.combat.combatants.map((c) => {
      const record = records.get(c._id);
      if (!record) return c; // untouched members keep everything, receipts included
      const tieRollsFor = tieRolls[c._id] ?? [];
      const core = { ...(c.flags.core ?? {}) };
      // No public receipt for a hidden member — the old one, if any, is replaced.
      delete core.initiativeRoll;
      return {
        ...c,
        flags: {
          ...c.flags,
          core,
          pf1e: {
            ...(c.flags.pf1e as Record<string, unknown> | undefined),
            hiddenInitiative: { ...record, tieRolls: tieRollsFor },
          },
        },
      };
    }),
  };
  return {
    transition,
    error: null,
    rolled: hidden.map((c) => c._id),
    skipped,
  };
}

/**
 * What the tracker shows for a combatant's initiative: hidden members read "?" to
 * anyone who is not GM/ASSISTANT — no value is displayed to players (T02). The
 * ordering itself stays authoritative in the document.
 */
export function hiddenInitiativeDisplay(
  member: { initiative: number | null; hidden: boolean },
  user: PermissionUser | null,
): string {
  if (
    member.hidden &&
    user !== null &&
    user.role !== "GM" &&
    user.role !== "ASSISTANT"
  )
    return "?";
  return member.initiative === null ? "—" : String(member.initiative);
}

/**
 * Verify a hidden GM receipt without revealing anything to other users: the recorded
 * die is a d20 face, the total is exactly die + modifier, and the tie roll-offs (if
 * any) are d20 faces. Pure and local — nothing is broadcast.
 */
export function verifyHiddenInitiativeReceipt(record: unknown): {
  ok: boolean;
  error: string | null;
} {
  if (typeof record !== "object" || record === null)
    return { ok: false, error: "hidden receipt is missing" };
  const r = record as Record<string, unknown>;
  const { die, modifier, total } = r;
  if (!Number.isInteger(die) || (die as number) < 1 || (die as number) > 20)
    return { ok: false, error: "recorded die is not a d20 face" };
  if (!Number.isSafeInteger(modifier))
    return { ok: false, error: "recorded modifier is not an integer" };
  if (
    !Number.isSafeInteger(total) ||
    total !== (die as number) + (modifier as number)
  )
    return { ok: false, error: "recorded total is not die + modifier" };
  const ties = r.tieRolls;
  if (ties !== undefined) {
    if (
      !Array.isArray(ties) ||
      ties.some((x) => !Number.isInteger(x) || x < 1 || x > 20)
    )
      return { ok: false, error: "recorded tie roll-offs are not d20 faces" };
  }
  return { ok: true, error: null };
}

/** A manual override invalidates the old roll receipt; unrelated metadata survives. */
export function manualInitiative(
  combat: CombatDocument,
  id: string,
  value: number,
): CombatTransition {
  const transition = retainActiveTurn(
    combat,
    applyInitiative(combat, { [id]: value }),
  );
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
  if (
    resolved.tokens.some(
      (t) => !combat.combatants.some((c) => c.tokenId === t._id),
    )
  )
    return {
      transition: null,
      error:
        "Some selected tokens are not in this encounter. Add them before rolling.",
    };
  const ids = new Set(resolved.tokens.map((t) => t._id));
  const chosen = combat.combatants.filter(
    (c) => c.tokenId && ids.has(c.tokenId),
  );
  const untouched = combat.combatants.filter(
    (c) => !c.tokenId || !ids.has(c.tokenId),
  );
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
    if (
      !tied ||
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt)
    )
      return c;
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
