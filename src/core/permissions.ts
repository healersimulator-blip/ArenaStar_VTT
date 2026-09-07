/**
 * §4 Permissions: the pure `can(user, action, doc, coll)` shared by host
 * (enforcement) and client (UI gating), implementing Foundry's default rules:
 *
 *   GM / ASSISTANT (D-013): everything.
 *   create:  messages → any authenticated role (host stamps author = caller,
 *            "own chat messages" §4); tokens/drawings/templates → TRUSTED+;
 *            everything else → GM/ASSISTANT only.
 *   read:    effective ownership ≥ LIMITED (LIMITED = partial content; the
 *            projection layer decides what "partial" means per field).
 *   update / delete: effective ownership ≥ OWNER.
 *   order (§4A): units only; effective ownership (with Army→Unit cascade) ≥ OWNER.
 *
 * Effective ownership of embedded documents cascades through their parent
 * (D-014) — a token is as visible as its scene; a unit as ownable as its army.
 */
import {
  OWNERSHIP_LEVELS,
  type BaseDocument,
  type CollectionName,
  type OwnershipLevel,
} from "./documents";
import type { CanOptions, PermissionAction, PermissionUser } from "./ownership";

export function getEffectiveOwnership(
  user: PermissionUser,
  doc: BaseDocument,
  parent?: BaseDocument,
): OwnershipLevel {
  if (user.role === "GM" || user.role === "ASSISTANT") return OWNERSHIP_LEVELS.OWNER;
  let level: number = doc.ownership.default;
  const own = doc.ownership[user.id];
  if (own !== undefined && own > level) level = own;
  if (parent !== undefined) {
    const fromParent = getEffectiveOwnership(user, parent);
    if (fromParent > level) level = fromParent;
  }
  return level as OwnershipLevel;
}

export function can(
  user: PermissionUser,
  action: PermissionAction,
  doc: BaseDocument,
  coll: CollectionName | (string & {}),
  options: CanOptions = {},
): boolean {
  if (user.role === "GM" || user.role === "ASSISTANT") return true;

  switch (action) {
    case "create":
      if (coll === "messages") return true; // own chat message; host stamps author (§4)
      if (coll === "tokens" || coll === "drawings" || coll === "templates") {
        return user.role === "TRUSTED";
      }
      return false;

    case "read":
      return getEffectiveOwnership(user, doc, options.parent) >= OWNERSHIP_LEVELS.LIMITED;

    case "update":
    case "delete":
      return getEffectiveOwnership(user, doc, options.parent) >= OWNERSHIP_LEVELS.OWNER;

    case "order":
      if (coll !== "units") return false;
      return getEffectiveOwnership(user, doc, options.parent) >= OWNERSHIP_LEVELS.OWNER;
  }
}
