/**
 * T01 — the selection-aware token context menu, as a pure model. The canvas layer
 * (interactions/index.ts) decides WHEN a menu opens (right-click, no drag, on a
 * token); this module decides WHAT it shows and WHICH ops/transition each entry
 * produces, from the live scene/encounter state. Everything is testable without a
 * browser; App.svelte only renders the entries.
 *
 * Entries (per the TODO): the token's initiative state in the active encounter,
 * add/remove combatant, and the token's hidden state. Effect/spell actions are
 * deliberately absent — they mount only when P4/P5 handlers exist.
 */
import type {
  ActorDocument,
  CombatDocument,
  SceneDocument,
  TokenDocument,
} from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import { can } from "../../core/permissions";
import type { Op } from "../../core/ops";
import { isPF1eActor } from "../sheets/pf1eSheetModel";
import { editSelectedRoster } from "./tokenSelection";
import type { CombatTransition } from "../../core/combat";

export type TokenMenuEntryId =
  | "initiative"
  | "add-combatant"
  | "remove-combatant"
  | "toggle-hidden"
  | "apply-effect";

export interface TokenMenuEntry {
  id: TokenMenuEntryId;
  /** Display text (already resolved, e.g. "Initiative: 17" / "Add to encounter"). */
  label: string;
  /** Disabled entries explain why (tooltip) — permission or state reasons, never silent. */
  disabled: boolean;
  reason: string | null;
}

export interface TokenMenuModel {
  title: string;
  entries: TokenMenuEntry[];
}

/** Is the combatant (if any) linked to this token hidden from tracker readers? */
export function tokenCombatant(
  combat: CombatDocument | null,
  token: TokenDocument,
): { id: string; initiative: number | null; hidden: boolean } | null {
  if (!combat) return null;
  const member = combat.combatants.find((c) => c.tokenId === token._id);
  if (!member) return null;
  return {
    id: member._id,
    initiative: member.initiative,
    hidden: member.hidden,
  };
}

/**
 * The menu for one token against the active encounter. `user` gates the mutating
 * entries; read-only state (initiative, hidden) is always shown so the menu is
 * honest about what the GM is looking at. `actors` backs the E02 "Apply effect…"
 * entry — shown only when the token links a PF1e actor (T01 deferred effect
 * actions until a P4 handler existed; `effectOps.ts` is that handler).
 */
export function tokenContextMenuModel(input: {
  combat: CombatDocument | null;
  scene: SceneDocument;
  token: TokenDocument;
  user: PermissionUser | null;
  actors: readonly ActorDocument[];
}): TokenMenuModel {
  const { combat, scene, token, user, actors } = input;
  const member = tokenCombatant(combat, token);
  const canUpdateEncounter =
    combat !== null && user !== null && can(user, "update", combat, "combats");
  const canUpdateScene = user !== null && can(user, "update", scene, "scenes");
  const linkedActor = token.actorId
    ? actors.find((a) => a._id === token.actorId)
    : undefined;
  const actorIsPF1e = linkedActor !== undefined && isPF1eActor(linkedActor);
  const canEditActor =
    linkedActor !== undefined &&
    user !== null &&
    can(user, "update", linkedActor, "actors");
  const entries: TokenMenuEntry[] = [];

  if (!combat) {
    entries.push({
      id: "initiative",
      label: "No active encounter",
      disabled: true,
      reason: "Create or activate an encounter first.",
    });
  } else if (!member) {
    entries.push({
      id: "initiative",
      label: "Not in the encounter",
      disabled: true,
      reason: null,
    });
  } else {
    entries.push({
      id: "initiative",
      label: `Initiative: ${member.initiative === null ? "not rolled" : member.initiative}`,
      disabled: true,
      reason: null,
    });
  }

  if (!combat) {
    entries.push({
      id: "add-combatant",
      label: "Add to encounter",
      disabled: true,
      reason: "No active encounter in this scene.",
    });
  } else if (member) {
    entries.push({
      id: "remove-combatant",
      label: "Remove from encounter",
      disabled: !canUpdateEncounter,
      reason: canUpdateEncounter ? null : "You cannot update this encounter.",
    });
  } else {
    entries.push({
      id: "add-combatant",
      label: "Add to encounter",
      disabled: !canUpdateEncounter,
      reason: canUpdateEncounter ? null : "You cannot update this encounter.",
    });
  }

  entries.push({
    id: "toggle-hidden",
    label: token.hidden ? "Show token" : "Hide token",
    disabled: !canUpdateScene,
    reason: canUpdateScene ? null : "You cannot update this scene.",
  });

  // E02 token application: the entry opens the actor's sheet on the Effects
  // tab (no op here) — the editor owns both persistence homes.
  if (linkedActor === undefined || !actorIsPF1e) {
    entries.push({
      id: "apply-effect",
      label: "Apply effect…",
      disabled: true,
      reason: "This token has no PF1e actor.",
    });
  } else {
    entries.push({
      id: "apply-effect",
      label: "Apply effect…",
      disabled: !canEditActor,
      reason: canEditActor ? null : "You cannot update this actor.",
    });
  }

  return { title: token.name, entries };
}

/** The token-visibility op behind the "Hide/Show token" entry. */
export function toggleTokenHiddenOp(
  scene: SceneDocument,
  token: TokenDocument,
): Op {
  return {
    kind: "update",
    ref: {
      coll: "tokens",
      id: token._id,
      parent: { coll: "scenes", id: scene._id },
    },
    diff: { hidden: !token.hidden },
  };
}

/**
 * Apply one menu entry. Add/remove reuse the selection-roster path (idempotent,
 * active-turn preserving, D-124/D-125 semantics) scoped to this single token;
 * hidden toggling is one token update op. Returns exactly what App submits.
 */
export function applyTokenMenuEntry(input: {
  combat: CombatDocument | null;
  scene: SceneDocument;
  token: TokenDocument;
  user: PermissionUser | null;
  actors: readonly ActorDocument[];
  entryId: TokenMenuEntryId;
  nextId: () => string;
}): {
  transition: CombatTransition | null;
  ops: Op[];
  error: string | null;
  /** E02: set for "apply-effect" — the caller opens this actor's Effects tab. */
  openEffectEditorActorId: string | null;
} {
  const { combat, scene, token, user, actors, entryId, nextId } = input;
  const fail = (error: string) => ({
    transition: null,
    ops: [],
    error,
    openEffectEditorActorId: null,
  });

  if (entryId === "toggle-hidden") {
    if (!user || !can(user, "update", scene, "scenes"))
      return fail("You cannot update this scene.");
    return {
      transition: null,
      ops: [toggleTokenHiddenOp(scene, token)],
      error: null,
      openEffectEditorActorId: null,
    };
  }

  if (entryId === "apply-effect") {
    const linkedActor = token.actorId
      ? actors.find((a) => a._id === token.actorId)
      : undefined;
    if (!linkedActor || !isPF1eActor(linkedActor))
      return fail("This token has no PF1e actor.");
    if (!user || !can(user, "update", linkedActor, "actors"))
      return fail("You cannot update this actor.");
    return {
      transition: null,
      ops: [],
      error: null,
      openEffectEditorActorId: linkedActor._id,
    };
  }

  if (!combat) return fail("No active encounter in this scene.");
  if (entryId !== "add-combatant" && entryId !== "remove-combatant")
    return fail("This entry is informational.");
  const action: "add" | "remove" =
    entryId === "add-combatant" ? "add" : "remove";
  // Reuse the roster editor against a one-token selection so add/remove keep every
  // invariant the tracker's buttons rely on (idempotence, active-member policy).
  const result = editSelectedRoster(
    combat,
    scene,
    { sceneId: scene._id, ids: [token._id] },
    user,
    action,
    nextId,
  );
  if (result.error) return fail(result.error);
  return {
    transition: result.transition,
    ops: [],
    error: null,
    openEffectEditorActorId: null,
  };
}
