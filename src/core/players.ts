/**
 * D-465 — the GM's player roster, as pure data and ops.
 *
 * Testers found no way to manage the people in a world: who is connected, what they may do,
 * which character and tokens are theirs. The "Players & permissions" window and the world
 * Settings both render the rows built here and submit the ops built here, so the rules
 * (what "controls a token" means, what assigning a character grants) live in one place and
 * are unit-tested without a browser.
 */
import {
  OWNERSHIP_LEVELS,
  type ActorDocument,
  type SceneDocument,
  type TokenDocument,
  type UserDocument,
} from "./documents";
import type { Op } from "./ops";
import { can } from "./permissions";
import type { PermissionUser } from "./ownership";

/**
 * How a player comes to control a token: an explicit OWNER entry of their own (`token`), the
 * token's linked actor being theirs (`actor`), the token being open to everyone through its
 * `default` level (`everyone`), or not at all.
 */
export type TokenControl = "token" | "actor" | "everyone" | null;

export interface PlayerTokenControl {
  tokenId: string;
  name: string;
  /** Direct OWNER on the token, or through the token's actor (which the checkbox cannot clear). */
  via: TokenControl;
}

export interface PlayerRow {
  id: string;
  name: string;
  color: string;
  role: UserDocument["role"];
  online: boolean;
  banned: boolean;
  characterId: string | null;
  characterName: string | null;
  canSaveMacros: boolean;
  /** Every token of the scene, with how (if at all) this player controls it. */
  tokens: PlayerTokenControl[];
}

/** A token the user controls: its own ownership or its actor's (the host's movement rule). */
export function controlsToken(
  user: PermissionUser,
  token: TokenDocument,
  scene: SceneDocument,
  actorOf: (id: string) => ActorDocument | undefined,
): TokenControl {
  if (user.role === "GM" || user.role === "ASSISTANT") return "token";
  const explicit = token.ownership[user.id];
  if (typeof explicit === "number" && explicit >= OWNERSHIP_LEVELS.OWNER) return "token";
  // No entry of their own but still allowed to update it: the token's `default` is OWNER, so
  // *everyone* may move it — a per-player grant would change nothing, the roster says so.
  if (can(user, "update", token, "tokens", { parent: scene })) return "everyone";
  const actor = token.actorId ? actorOf(token.actorId) : undefined;
  return actor && can(user, "update", actor, "actors") ? "actor" : null;
}

/** The roster rows, GM first then by name, with live presence folded in. */
export function playerRows(
  users: readonly UserDocument[],
  actors: readonly ActorDocument[],
  scene: SceneDocument | null,
  presence: { online: ReadonlySet<string>; banned?: ReadonlySet<string> },
): PlayerRow[] {
  const actorOf = (id: string) => actors.find((actor) => actor._id === id);
  const rank: Record<UserDocument["role"], number> = { GM: 0, ASSISTANT: 1, TRUSTED: 2, PLAYER: 3 };
  return [...users]
    .sort((a, b) => rank[a.role] - rank[b.role] || a.name.localeCompare(b.name))
    .map((user) => {
      const character = user.character ? actorOf(user.character) ?? null : null;
      const who: PermissionUser = { id: user._id, role: user.role };
      return {
        id: user._id,
        name: user.name,
        color: user.color,
        role: user.role,
        online: presence.online.has(user._id),
        banned: presence.banned?.has(user._id) ?? false,
        characterId: character?._id ?? null,
        characterName: character?.name ?? null,
        canSaveMacros: user.canSaveMacros === true || user.role === "GM" || user.role === "ASSISTANT",
        tokens: (scene?.tokens ?? []).map((token) => ({
          tokenId: token._id,
          name: token.name || actorOf(token.actorId ?? "")?.name || "Token",
          via: controlsToken(who, token, scene as SceneDocument, actorOf),
        })),
      };
    });
}

/** `ownership` with one user's entry set (level) or removed (null); `default` always kept. */
function withOwner(ownership: Record<string, number>, userId: string, level: number | null): Record<string, number> {
  const next: Record<string, number> = { default: ownership.default ?? OWNERSHIP_LEVELS.NONE };
  for (const [key, value] of Object.entries(ownership)) {
    if (key !== "default" && key !== userId && typeof value === "number") next[key] = value;
  }
  if (level !== null) next[userId] = level;
  return next;
}

/**
 * Assign (or clear) a player's character. Like Foundry, the character is theirs: the actor
 * gets OWNER for the player; the previous character keeps whatever the GM set unless
 * `revokePrevious` is on.
 */
export function assignCharacterOps(
  user: UserDocument,
  actor: ActorDocument | null,
  options: { previous?: ActorDocument | null; revokePrevious?: boolean } = {},
): Op[] {
  const ops: Op[] = [{ kind: "update", ref: { coll: "users", id: user._id }, diff: { character: actor?._id ?? null } }];
  if (actor && (actor.ownership[user._id] ?? OWNERSHIP_LEVELS.NONE) < OWNERSHIP_LEVELS.OWNER) {
    ops.push({
      kind: "update",
      ref: { coll: "actors", id: actor._id },
      diff: { ownership: withOwner(actor.ownership, user._id, OWNERSHIP_LEVELS.OWNER) },
    });
  }
  const previous = options.previous;
  if (options.revokePrevious && previous && previous._id !== actor?._id && previous.ownership[user._id] !== undefined) {
    ops.push({
      kind: "update",
      ref: { coll: "actors", id: previous._id },
      diff: { ownership: withOwner(previous.ownership, user._id, null) },
    });
  }
  return ops;
}

/** Give or take a player's direct control of one token on a scene (one update op). */
export function setTokenControlOps(scene: SceneDocument, token: TokenDocument, userId: string, control: boolean): Op[] {
  const current = token.ownership[userId];
  if (control && current === OWNERSHIP_LEVELS.OWNER) return [];
  if (!control && current === undefined) return [];
  return [
    {
      kind: "update",
      ref: { coll: "tokens", id: token._id, parent: { coll: "scenes", id: scene._id } },
      diff: { ownership: withOwner(token.ownership, userId, control ? OWNERSHIP_LEVELS.OWNER : null) },
    },
  ];
}

/** Player colour: a CSS hex colour, validated so a typo never breaks the presence strip. */
export function setPlayerColorOps(user: UserDocument, color: string): Op[] {
  if (!/^#[0-9a-f]{6}$/i.test(color) || user.color.toLowerCase() === color.toLowerCase()) return [];
  return [{ kind: "update", ref: { coll: "users", id: user._id }, diff: { color: color.toLowerCase() } }];
}

/** Remove an offline, non-GM user from the world (their documents keep their ownership entries). */
export function removeUserOps(user: UserDocument, online: boolean): Op[] {
  if (user.role === "GM" || online) return [];
  return [{ kind: "delete", ref: { coll: "users", id: user._id } }];
}
