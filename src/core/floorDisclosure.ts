/**
 * G-33 (D-451): what a player's replica holds of a scene in isolated floor play.
 *
 * Isolated floor play used to hide other floors only in the renderer: every token, wall, light and
 * tile still reached each player's replica (D-442). Now the projection withholds what the player's
 * floors cannot show. A player's floors are the floors their own tokens stand on, and each of those
 * floors reaches:
 *  - **its own documents**, all kinds;
 *  - **the floors it sees below** (`visibleLevelIds`, G-19): their tokens (G-20 draws the ones the
 *    player's tokens see) and their floor art;
 *  - **the floor directly above, when that floor sees it** (G-22): its walls and lights, whose light
 *    falls through its openings.
 * Unassigned and every-floor documents are disclosed as before. GM and assistant sessions, scenes
 * outside isolated floor play and scenes without floors are unaffected. Hidden/ownership rules
 * (`docVisibleTo`) still apply on top; this module only ever withholds more.
 */
import type { ActorDocument, BaseDocument, LevelScope, SceneDocument, TokenDocument } from "./documents";
import { floorAbove, visibleFloorsBelow } from "./levelPlay";
import type { PermissionUser } from "./ownership";
import { can } from "./permissions";

/** The scene parts the floor boundary applies to. */
export const FLOOR_DISCLOSED_PARTS = ["tokens", "walls", "lights", "tiles", "regions", "drawings", "templates", "notes"] as const;
export type FloorDisclosedPart = (typeof FLOOR_DISCLOSED_PARTS)[number];

export interface FloorDisclosure {
  /** Floors the user's own tokens stand on: every kind of document on them. */
  floors: ReadonlySet<string>;
  /** Those floors and the floors they see below: tokens and floor art. */
  seen: ReadonlySet<string>;
  /** `seen` plus the floor above each (when it sees down onto it): walls and lights. */
  lit: ReadonlySet<string>;
  /** Tile id → the floors whose art lists it (tiles in no floor's art are unassigned). */
  art: ReadonlyMap<string, readonly string[]>;
  /** The user's own tokens: always disclosed to them. */
  owned: ReadonlySet<string>;
}

export const isFloorDisclosedPart = (coll: string): coll is FloorDisclosedPart => (FLOOR_DISCLOSED_PARTS as readonly string[]).includes(coll);
const isPart = isFloorDisclosedPart;

/** A token the user controls: its own ownership or its actor's (the floor-focus rule, D-434). */
function ownsToken(user: PermissionUser, token: TokenDocument, scene: SceneDocument, actorOf: (id: string) => ActorDocument | undefined): boolean {
  if (can(user, "update", token, "tokens", { parent: scene })) return true;
  const actor = token.actorId ? actorOf(token.actorId) : undefined;
  return !!actor && can(user, "update", actor, "actors");
}

/** The user's floor boundary on this scene, or null when none applies. */
export function floorDisclosure(scene: SceneDocument, user: PermissionUser, actorOf: (id: string) => ActorDocument | undefined): FloorDisclosure | null {
  if (user.role === "GM" || user.role === "ASSISTANT") return null;
  const levels = scene.levels ?? [];
  if (scene.levelMode !== "isolated" || !levels.length) return null;
  const owned = new Set<string>(), floors = new Set<string>();
  for (const token of scene.tokens) {
    if (!ownsToken(user, token, scene, actorOf)) continue;
    owned.add(token._id);
    if (!token.hidden && token.levelId && levels.some((l) => l._id === token.levelId)) floors.add(token.levelId);
  }
  const seen = new Set(floors), lit = new Set(floors);
  for (const id of floors) {
    const level = levels.find((l) => l._id === id);
    if (!level) continue;
    for (const { level: below } of visibleFloorsBelow(scene, level)) { seen.add(below._id); lit.add(below._id); }
    const up = floorAbove(scene, id);
    if (up && up.floorZ > level.floorZ && up.visibleLevelIds.includes(id)) lit.add(up._id);
  }
  const art = new Map<string, string[]>();
  for (const level of levels) for (const tileId of level.tileIds ?? []) art.set(tileId, [...(art.get(tileId) ?? []), level._id]);
  return { floors, seen, lit, art, owned };
}

const scopeMeets = (scope: LevelScope | undefined, floors: ReadonlySet<string>) =>
  !scope || scope.mode === "all" || scope.ids.some((id) => floors.has(id));

/** Whether a scene document lies inside the boundary (null boundary: everything does). */
export function floorReadable(disclosure: FloorDisclosure | null, coll: string, doc: BaseDocument): boolean {
  if (!disclosure || !isPart(coll)) return true;
  switch (coll) {
    case "tokens": {
      const token = doc as TokenDocument;
      return disclosure.owned.has(token._id) || token.levelId === undefined || disclosure.seen.has(token.levelId);
    }
    case "tiles": {
      const floors = disclosure.art.get(doc._id);
      return !floors || floors.some((id) => disclosure.seen.has(id));
    }
    case "walls":
    case "lights":
      return scopeMeets((doc as { levelScope?: LevelScope }).levelScope, disclosure.lit);
    default:
      return scopeMeets((doc as { levelScope?: LevelScope }).levelScope, disclosure.floors);
  }
}

/** `part:id` keys of the scene documents inside the boundary (the host's per-session ledger). */
export function floorDisclosedKeys(scene: SceneDocument, disclosure: FloorDisclosure | null): Set<string> {
  const keys = new Set<string>();
  for (const part of FLOOR_DISCLOSED_PARTS) {
    for (const doc of (scene[part] ?? []) as readonly BaseDocument[]) if (floorReadable(disclosure, part, doc)) keys.add(`${part}:${doc._id}`);
  }
  return keys;
}
