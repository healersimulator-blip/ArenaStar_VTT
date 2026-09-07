/**
 * §4 Permissions: pure `can(user, action, doc)` shared by host (enforcement)
 * and client (UI gating). Implementation lands with the M1 core unit.
 */
import type { BaseDocument, CollectionName, OwnershipLevel, Role } from "./documents";
import type { UserId } from "./ids";

export type PermissionAction = "create" | "read" | "update" | "delete" | "order";

/** The user view permission checks operate on. */
export interface PermissionUser {
  id: UserId;
  role: Role;
}

/** User info delivered to clients (welcome message, player list). */
export interface UserView extends PermissionUser {
  name: string;
}

/**
 * Extra context for permission checks (D-014): the parent document of an
 * embedded target, enabling §4A's Army→Unit ownership cascade (and embedded
 * reads riding their parent's ownership).
 */
export interface CanOptions {
  parent?: BaseDocument;
}

/**
 * §4 Foundry-style defaults, implemented in src/core/permissions.ts:
 * - GM (and ASSISTANT, D-013): everything.
 * - TRUSTED: may create tokens / drawings / templates.
 * - OWNER level: may update / delete.
 * - OBSERVER: may read. LIMITED: partial read. NONE: nothing.
 * - Players may create their own chat messages.
 * §4A: `order` requires OWNER on the unit or its (cascading) army, or GM.
 */
export interface CanFn {
  (
    user: PermissionUser,
    action: PermissionAction,
    doc: BaseDocument,
    coll: CollectionName,
    options?: CanOptions,
  ): boolean;
}

/** Effective ownership level of `user` over `doc` (role-aware, cascades embedded parents). */
export interface GetEffectiveOwnershipFn {
  (user: PermissionUser, doc: BaseDocument, parent?: BaseDocument): OwnershipLevel;
}
