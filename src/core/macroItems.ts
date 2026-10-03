/**
 * MC-02/D-393: typed item references and the caller's selected item context.
 *
 * Bare ids name WORLD items only; actorId/itemId names exactly one embedded item.
 * Never search every actor for a bare id: copied inventories legitimately share
 * ids, and a name/id collision must not silently select someone else's item.
 * References are scalar text on the existing invocation wire, not document bodies
 * or authority. Read the parent and item live under the ACTUAL caller's rights.
 */
import type { ActorDocument, ItemDocument } from "./documents";
import type { PermissionUser } from "./ownership";
import { can } from "./permissions";
import type { WindowSpec } from "./windows";

const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
export interface MacroItemRef {
  itemId: string;
  actorId: string | null;
}
export interface MacroItemWorld {
  items: readonly ItemDocument[];
  actors: readonly ActorDocument[];
}
export interface MacroItemChoice {
  reference: string;
  label: string;
}

/** Each id is 1–128 wire-safe characters; an embedded reference is at most 257. */
export function parseMacroItemRef(value: unknown): MacroItemRef | null {
  if (typeof value !== "string" || value.length > 257) return null;
  const parts = value.split("/");
  if (parts.length < 1 || parts.length > 2 || parts.some((id) => !DOC_ID.test(id))) return null;
  return parts.length === 1 ? { itemId: parts[0] ?? "", actorId: null }
    : { actorId: parts[0] ?? "", itemId: parts[1] ?? "" };
}

export function macroItemReference(itemId: string, actorId: string | null = null): string | null {
  if (!DOC_ID.test(itemId) || actorId !== null && !DOC_ID.test(actorId)) return null;
  return actorId === null ? itemId : `${actorId}/${itemId}`;
}

/** Read visibility, not update authority. Supplying a ref never authorizes item mechanics. */
export function macroItemReadable(world: MacroItemWorld, user: PermissionUser | null, reference: string): boolean {
  const ref = parseMacroItemRef(reference);
  if (!ref || !user) return false;
  if (ref.actorId === null) {
    const item = world.items.find((candidate) => candidate._id === ref.itemId);
    return !!item && can(user, "read", item, "items");
  }
  const actor = world.actors.find((candidate) => candidate._id === ref.actorId);
  if (!actor || !can(user, "read", actor, "actors")) return false;
  const item = actor.items.find((candidate) => candidate._id === ref.itemId);
  return !!item && can(user, "read", item, "items", { parent: actor });
}

/** The run form's picker uses only the caller's readable catalog, with unambiguous labels. */
export function macroItemChoices(world: MacroItemWorld, user: PermissionUser | null): MacroItemChoice[] {
  if (!user) return [];
  const choices: MacroItemChoice[] = [];
  for (const item of world.items) {
    const reference = macroItemReference(item._id);
    if (reference && can(user, "read", item, "items")) choices.push({ reference, label: `${item.name} — world item` });
  }
  for (const actor of world.actors) {
    if (!can(user, "read", actor, "actors")) continue;
    for (const item of actor.items) {
      const reference = macroItemReference(item._id, actor._id);
      if (reference && can(user, "read", item, "items", { parent: actor }))
        choices.push({ reference, label: `${item.name} — ${actor.name}` });
    }
  }
  return choices.sort((a, b) => a.label.localeCompare(b.label) || a.reference.localeCompare(b.reference));
}

/**
 * The most recently focused OPEN, non-minimized item window is the item selection.
 * Focusing a macro/chat surface does not replace it. A stale/unreadable top item
 * clears the selection, rather than guessing another item; closing/minimizing it
 * explicitly exposes the next open item window. Never infer an item from a token.
 */
export function selectedMacroItem(
  windows: readonly Pick<WindowSpec, "kind" | "data" | "z" | "minimized">[],
  world: MacroItemWorld, user: PermissionUser | null,
): string | null {
  let top: typeof windows[number] | null = null;
  for (const win of windows) {
    if (win.kind === "item" && !win.minimized && (!top || win.z > top.z)) top = win;
  }
  if (!top?.data?.actorId || !top.data.itemId) return null;
  const reference = macroItemReference(top.data.itemId, top.data.actorId);
  return reference && macroItemReadable(world, user, reference) ? reference : null;
}
