import type { CombatDocument, SceneDocument, TokenDocument } from "../../core/documents";
import type { PermissionUser } from "../../core/ownership";
import { can } from "../../core/permissions";
import { currentCombatant, sortCombatants, type CombatTransition } from "../../core/combat";
import { newEncounter } from "./encounters";

/** Local canvas state, never replicated or interpreted as document ownership. */
export interface TokenSelection {
  sceneId: string | null;
  ids: readonly string[];
}
export function selectedTokens(
  scene: SceneDocument,
  selection: TokenSelection,
  fallbackAll = false,
): { tokens: TokenDocument[]; error: string | null } {
  if (selection.ids.length === 0)
    return { tokens: fallbackAll ? [...scene.tokens] : [], error: null };
  if (selection.sceneId !== scene._id)
    return {
      tokens: [],
      error: "Selection belongs to another scene. Select again or clear it.",
    };
  const ids = new Set(selection.ids);
  if ([...ids].some((id) => !scene.tokens.some((t) => t._id === id)))
    return {
      tokens: [],
      error: "Selected tokens changed or were deleted. Select again or clear the selection.",
    };
  return { tokens: scene.tokens.filter((t) => ids.has(t._id)), error: null };
}

export function editSelectedRoster(
  combat: CombatDocument,
  scene: SceneDocument,
  selection: TokenSelection,
  user: PermissionUser | null,
  action: "add" | "remove",
  nextId: () => string,
): { transition: CombatTransition | null; error: string | null } {
  const fail = (error: string) => ({ transition: null, error });
  if (!user || !can(user, "update", combat, "combats"))
    return fail("You cannot edit this encounter.");
  if (combat.flags.core?.sceneId !== undefined && combat.flags.core.sceneId !== scene._id)
    return fail("Encounter belongs to another scene.");
  const resolved = selectedTokens(scene, selection);
  if (resolved.error) return fail(resolved.error);
  if (!resolved.tokens.length) return fail("Select at least one token first.");
  const ids = new Set(resolved.tokens.map((t) => t._id));
  const active = currentCombatant(combat);
  const roster =
    action === "remove"
      ? combat.combatants.filter((c) => !c.tokenId || !ids.has(c.tokenId))
      : [
          ...combat.combatants,
          ...newEncounter(
            {
              ...scene,
              tokens: resolved.tokens.filter(
                (t) => !combat.combatants.some((c) => c.tokenId === t._id),
              ),
            },
            "unused",
            "unused",
            nextId,
          ).combatants,
        ];
  if (roster.length === combat.combatants.length) return { transition: null, error: null };
  const sorted = sortCombatants(roster);
  // GM roster edits are not turn advancement. If the active member is removed,
  // choose its next surviving successor in the old order (wrapping if necessary).
  // Do not tick effects, advance the round, or require the GM to end combat first.
  const oldOrder = sortCombatants(combat.combatants);
  const activeIndex = oldOrder.findIndex((c) => c._id === active?._id);
  const successor =
    active && !sorted.some((c) => c._id === active._id)
      ? [...oldOrder.slice(activeIndex + 1), ...oldOrder.slice(0, activeIndex)].find((c) =>
          sorted.some((remaining) => remaining._id === c._id),
        )
      : active;
  const turn = successor
    ? Math.max(
        0,
        sorted.findIndex((c) => c._id === successor._id),
      )
    : 0;
  return {
    error: null,
    transition: {
      combat: { ...combat, combatants: sorted, turn },
      hooks: ["combat:combatant:update"],
      expired: [],
    },
  };
}
