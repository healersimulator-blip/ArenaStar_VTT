/**
 * G-23 (D-448): standing, falling and flying between floors.
 *
 * A walking token stands on its floor. Where that floor is open (a D-444 opening) there is
 * nothing to stand on, except inside a stairwell, where the stairs carry it. A token above its
 * floor (feet over the floor's height) is airborne and crosses openings freely. Untraced floors
 * are solid everywhere, so nothing changes until a floor is traced.
 *
 * - Players cannot walk out over an opening: the host refuses the move with a reason.
 * - The GM can; the token menu and the floor-play check then offer the fall to the solid floor
 *   beneath (the kernel's `supportBelow`).
 * - Raising or lowering a token's height onto another floor is a flight: the way is open when its
 *   whole footprint passes through the openings of every floor plane it crosses (a kernel body sweep).
 */
import type { LevelDocument, SceneDocument, TokenDocument } from "./documents";
import type { Op } from "./ops";
import { applyDiff } from "./diff";
import { floorSolidAt, floorSurfaces } from "./floorSurface";
import { inStairwell } from "./levelPlay";
import { SpatialKernel } from "./spatial/kernel";

/** Feet this far above the floor count as standing on it. */
const STANDING = 0.01;

export interface Footing {
  /** False when the token stands over an opening of its floor. */
  supported: boolean;
  /** When unsupported: the nearest solid floor beneath the token's centre (null: nothing below). */
  landing: { levelId: string; name: string; z: number } | null;
}
const SUPPORTED: Footing = { supported: true, landing: null };

type Standing = Pick<TokenDocument, "levelId" | "elevation" | "x" | "y">;

/**
 * Footing by the floors' structure alone, whether or not floor play is on (the floor-play check
 * runs before it is enabled). Tokens without a floor, airborne tokens, untraced floors, solid
 * spots and stairwells are supported.
 */
export function floorFooting(scene: Pick<SceneDocument, "levels" | "regions" | "width" | "height">, token: Standing, at: { x: number; y: number } = token): Footing {
  const level = token.levelId === undefined ? undefined : scene.levels?.find((l) => l._id === token.levelId);
  if (!level?.surface || (token.elevation ?? 0) > level.floorZ + STANDING) return SUPPORTED;
  if (floorSolidAt(level, at) || inStairwell(scene, level._id, at)) return SUPPORTED;
  return { supported: false, landing: landingBelow(scene, level, at) };
}

/** In floor play only (what play enforces). */
export function tokenFooting(scene: SceneDocument, token: Standing, at: { x: number; y: number } = token): Footing {
  return scene.levelMode === "isolated" ? floorFooting(scene, token, at) : SUPPORTED;
}

function landingBelow(scene: Pick<SceneDocument, "levels" | "width" | "height">, level: LevelDocument, at: { x: number; y: number }): Footing["landing"] {
  try {
    const hit = new SpatialKernel([], floorSurfaces(scene)).supportBelow({ x: at.x, y: at.y, z: level.floorZ - 1e-6 });
    const below = hit ? scene.levels?.find((l) => `floor:${l._id}` === hit.id) : undefined;
    return below ? { levelId: below._id, name: below.name, z: below.floorZ } : null;
  } catch {
    return null;
  }
}

export interface Passage {
  clear: boolean;
  /** The first floor in the way, when it is not clear. */
  blockedBy: { levelId: string; name: string } | null;
}

/**
 * Can this token fly straight from its height to `z`? Its body (size in cells × grid distance
 * tall, as for sight) must pass through every floor plane between, never touching solid floor.
 * The floor it stands on does not stop it rising; one above its head does not stop it sinking.
 */
export function flightPassage(scene: Pick<SceneDocument, "levels" | "width" | "height" | "grid">, token: Pick<TokenDocument, "x" | "y" | "elevation" | "width" | "height" | "rotation">, z: number): Passage {
  const from = token.elevation ?? 0;
  if (!scene.levels?.length || !Number.isFinite(z) || z === from) return { clear: true, blockedBy: null };
  const size = scene.grid.size > 0 ? scene.grid.size : 100, distance = scene.grid.distance > 0 ? scene.grid.distance : 5;
  const bodyHeight = Math.max(0.5, Math.max(token.width, token.height) / size) * distance;
  try {
    const hits = new SpatialKernel([], floorSurfaces(scene)).sweep({
      from: { x: token.x, y: token.y, z: from }, to: { x: token.x, y: token.y, z },
      width: Math.max(1, token.width), depth: Math.max(1, token.height), bodyHeight, rotation: token.rotation ?? 0,
    });
    const up = z > from;
    for (const hit of hits) {
      const level = scene.levels.find((l) => `floor:${l._id}` === hit.id);
      if (!level) continue;
      if (up ? level.floorZ <= from + STANDING : level.floorZ >= from + bodyHeight - STANDING) continue;
      return { clear: false, blockedBy: { levelId: level._id, name: level.name } };
    }
    return { clear: true, blockedBy: null };
  } catch {
    return { clear: false, blockedBy: null };
  }
}

/**
 * The host's check on a player's walk: tokens that would end standing over an opening of their
 * floor, outside a stairwell. Explicit floor or height changes (the stairs make those too) and
 * prefab parts riding their parent are not walks.
 */
export function unsupportedWalks(ops: readonly Op[], sceneById: (id: string) => SceneDocument | undefined): Array<{ tokenId: string; name: string; floor: string }> {
  const rows = new Map<string, { scene: SceneDocument; after: TokenDocument; explicit: boolean; walked: boolean }>();
  for (const op of ops) {
    if (op.kind !== "update" || op.ref.coll !== "tokens" || op.ref.parent?.coll !== "scenes") continue;
    const scene = sceneById(op.ref.parent.id);
    if (!scene || scene.levelMode !== "isolated") continue;
    const key = `${scene._id}\u0000${op.ref.id}`;
    const start = scene.tokens.find((t) => t._id === op.ref.id);
    if (!start) continue;
    const row = rows.get(key) ?? { scene, after: start, explicit: false, walked: false };
    const next = applyDiff(row.after, op.diff);
    if (!next.ok) continue;
    row.after = next.value;
    const keys = Object.keys(op.diff);
    row.explicit ||= keys.some((k) => /^(?:-=)?(?:elevation|levelId)(?:\.|$)/.test(k));
    row.walked ||= keys.some((k) => k === "x" || k === "y");
    rows.set(key, row);
  }
  const out: Array<{ tokenId: string; name: string; floor: string }> = [];
  for (const { scene, after, explicit, walked } of rows.values()) {
    if (explicit || !walked || typeof (after.flags?.prefab as { parentId?: unknown } | undefined)?.parentId === "string") continue;
    if (tokenFooting(scene, after).supported) continue;
    out.push({ tokenId: after._id, name: after.name, floor: scene.levels?.find((l) => l._id === after.levelId)?.name ?? "this floor" });
  }
  return out;
}
