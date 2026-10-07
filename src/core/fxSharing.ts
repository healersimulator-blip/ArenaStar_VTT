/**
 * GM-controlled publication for saved FX timelines.
 *
 * Visibility and invocation are separate controls: ownership decides who receives the saved
 * definition, while `flags.core.playerCallable` decides whether that reader may request it from
 * an action/cast binding. The host checks both again for every run. These helpers only build the
 * ordinary document fields; they do not grant actor ownership, asset rights, or mechanics.
 */
import { OWNERSHIP_LEVELS, type MacroDocument, type Ownership, type UserDocument } from "./documents";

export type FxShareScope = "gm" | "all" | "selected";

export interface FxShareDraft {
  scope: FxShareScope;
  userIds: string[];
}

export const FX_SHARE_USERS_MAX = 64;

/** Roles which should be offered as named player recipients (GMs/assistants already see all). */
export function fxShareableUsers(users: readonly UserDocument[]): UserDocument[] {
  return users
    .filter((user) => user.role !== "GM" && user.role !== "ASSISTANT")
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a._id.localeCompare(b._id));
}

/** Infer the publication scope from a saved macro's ownership map. */
export function fxShareDraftOf(macro: MacroDocument, users: readonly UserDocument[]): FxShareDraft {
  const shareable = new Set(fxShareableUsers(users).map((user) => user._id));
  const named = Object.entries(macro.ownership ?? {})
    .filter(([id, level]) => id !== "default" && shareable.has(id) &&
      typeof level === "number" && level >= OWNERSHIP_LEVELS.LIMITED)
    .map(([id]) => id)
    .sort();
  if ((macro.ownership?.default ?? OWNERSHIP_LEVELS.NONE) >= OWNERSHIP_LEVELS.LIMITED)
    return { scope: "all", userIds: [] };
  if (named.length > 0) return { scope: "selected", userIds: named };
  return { scope: "gm", userIds: [] };
}

/** A named-player grant must refer to actual non-GM users, with at least one recipient. */
export function fxShareError(draft: FxShareDraft, users: readonly UserDocument[]): string | null {
  if (draft.scope !== "gm" && draft.scope !== "all" && draft.scope !== "selected")
    return "Choose GM-only, all players, or selected players for this FX timeline";
  if (draft.scope !== "selected") return null;
  if (!Array.isArray(draft.userIds)) return "Selected-player sharing needs a player list";
  const unique = [...new Set(draft.userIds)];
  if (unique.length === 0) return "Choose at least one player, or switch sharing to all players / GM only";
  if (unique.length > FX_SHARE_USERS_MAX)
    return `An FX timeline can be shared with at most ${FX_SHARE_USERS_MAX} selected players`;
  const available = new Set(fxShareableUsers(users).map((user) => user._id));
  const invalid = unique.find((id) => typeof id !== "string" || !available.has(id));
  return invalid === undefined ? null : "Selected FX recipients must be current non-GM users in this world";
}

/** Build the ownership map used by world snapshots and the host's visibility-crossing rewrite. */
export function fxShareOwnership(draft: FxShareDraft): Ownership {
  if (draft.scope === "all") return { default: OWNERSHIP_LEVELS.OBSERVER };
  if (draft.scope === "selected") {
    const ownership: Ownership = { default: OWNERSHIP_LEVELS.NONE };
    for (const userId of new Set(draft.userIds)) ownership[userId] = OWNERSHIP_LEVELS.OBSERVER;
    return ownership;
  }
  return { default: OWNERSHIP_LEVELS.NONE };
}
