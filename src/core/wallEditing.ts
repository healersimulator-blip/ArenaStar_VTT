import { wallTopologyKey } from "./levelMembership";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isDoorWall, type WallDocument } from "./documents";
import type { Op } from "./ops";
import type { Result } from "./result";
import { err, okVal } from "./result";

export interface WallPoint { x: number; y: number }
export type WallEndpoint = { wallId: string; end: 0 | 1; point: WallPoint };
export interface WallEditGuard { sceneId: string; wallsHash: string }
export interface WallEditPlan { ops: Op[]; guard: WallEditGuard; preview: WallDocument[] }
export const WALL_EDIT_PICK_PX = 8;
export const MIN_WALL_LENGTH = 0.01;
export const MAX_WALL_EDIT_OPS = 256;
const JOINT_EPS = 1e-7;

/** Canonical preimage hash: only wall edits invalidate a gesture, not unrelated world traffic.
 * All scene walls participate so a newly attached joint cannot be silently left behind.
 * The guard rides the intent only; private preimages never enter envelopes or archives.
 */
export function wallSceneHash(walls: readonly WallDocument[]): string {
  const json = JSON.stringify([...walls].sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0), (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    return value;
  });
  return bytesToHex(sha256(new TextEncoder().encode(json)));
}
export function wallEditGuard(sceneId: string, walls: readonly WallDocument[]): WallEditGuard {
  return { sceneId, wallsHash: wallSceneHash(walls) };
}
export function wallEditLocked(wall: WallDocument): boolean {
  // Attached members have reference/transform semantics this editor must not clone or detach.
  return wall.flags.prefab !== undefined || wall.flags.core?.wallLocked === true;
}
export function wallCoordinatesError(c: unknown): string | null {
  if (!Array.isArray(c) || c.length !== 4 || !c.every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1_000_000))
    return "Wall coordinates must be four finite values within ±1,000,000.";
  return Math.hypot(c[2] - c[0], c[3] - c[1]) < MIN_WALL_LENGTH ? "The edit would collapse a wall." : null;
}
function endpoint(wall: WallDocument, end: 0 | 1): WallEndpoint {
  return { wallId: wall._id, end, point: { x: wall.c[end * 2] as number, y: wall.c[end * 2 + 1] as number } };
}
export function nearestWallEndpoint(walls: readonly WallDocument[], point: WallPoint, cameraScale: number,
  exclude: readonly Pick<WallEndpoint, "wallId" | "end">[] = []): WallEndpoint | null {
  if (!Number.isFinite(cameraScale) || cameraScale <= 0 || ![point.x, point.y].every(Number.isFinite)) return null;
  const tolerance = WALL_EDIT_PICK_PX / cameraScale;
  let best: WallEndpoint | null = null, distance = Infinity;
  for (const wall of [...walls].sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0)) {
    if (wallCoordinatesError(wall.c) || wallEditLocked(wall)) continue;
    for (const end of [0, 1] as const) {
      if (exclude.some((e) => e.wallId === wall._id && e.end === end)) continue;
      const candidate = endpoint(wall, end);
      const d = Math.hypot(candidate.point.x - point.x, candidate.point.y - point.y);
      if (d <= tolerance && d < distance) { best = candidate; distance = d; }
    }
  }
  return best;
}
/** Exact shared vertices only: no transitive radius clustering or accidental gap repair. */
export function joinedWallEndpoints(walls: readonly WallDocument[], selected: WallEndpoint, joined: boolean): Result<WallEndpoint[]> {
  const source = walls.find((wall) => wall._id === selected.wallId);
  if (!source || ![0, 1].includes(selected.end)) return err("Wall endpoint no longer exists.");
  const origin = endpoint(source, selected.end).point;
  if (Math.hypot(origin.x - selected.point.x, origin.y - selected.point.y) > JOINT_EPS) return err("Wall endpoint changed.");
  const matches: WallEndpoint[] = [];
  for (const wall of walls) for (const end of [0, 1] as const) {
    const e = endpoint(wall, end);
    const chosen = wall._id === selected.wallId && end === selected.end;
    if (!chosen && (!joined || wallTopologyKey(wall) !== wallTopologyKey(source) || Math.hypot(e.point.x - selected.point.x, e.point.y - selected.point.y) > JOINT_EPS)) continue;
    if (wallEditLocked(wall)) return err("A connected wall is locked or belongs to a prefab; the joint was not moved.");
    if (wallCoordinatesError(wall.c)) return err("Repair invalid wall coordinates before moving this joint.");
    matches.push(e);
  }
  if (!matches.length) return err("Wall endpoint no longer exists.");
  if (matches.length > MAX_WALL_EDIT_OPS) return err("This joint exceeds the 256-endpoint edit limit.");
  return okVal(matches);
}
export function planWallCorner(sceneId: string, walls: readonly WallDocument[], endpoints: readonly WallEndpoint[], to: WallPoint, guard: WallEditGuard = wallEditGuard(sceneId, walls)): Result<WallEditPlan> {
  if (!endpoints.length || endpoints.length > MAX_WALL_EDIT_OPS) return err("Select a bounded wall joint.");
  const changed = new Map<string, WallDocument>();
  for (const e of endpoints) {
    const original = walls.find((wall) => wall._id === e.wallId);
    if (!original || wallEditLocked(original)) return err("A wall was removed, locked or attached to a prefab.");
    const copy = changed.get(e.wallId) ?? structuredClone(original);
    copy.c[e.end * 2] = to.x;
    copy.c[e.end * 2 + 1] = to.y;
    changed.set(e.wallId, copy);
  }
  const ops: Op[] = [], preview: WallDocument[] = [];
  for (const wall of changed.values()) {
    const error = wallCoordinatesError(wall.c);
    if (error) return err(error);
    preview.push(wall);
    const original = walls.find((w) => w._id === wall._id);
    if (JSON.stringify(original?.c) === JSON.stringify(wall.c)) continue;
    ops.push({ kind: "update", ref: { coll: "walls", id: wall._id, parent: { coll: "scenes", id: sceneId } }, diff: { c: wall.c } });
  }
  return okVal({ ops, preview, guard });
}
export function nearestWallSegment(walls: readonly WallDocument[], point: WallPoint, scale: number): { wall: WallDocument; point: WallPoint; t: number } | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  let best: ReturnType<typeof nearestWallSegment> = null, distance = WALL_EDIT_PICK_PX / scale;
  for (const wall of [...walls].sort((a, b) => a._id < b._id ? -1 : a._id > b._id ? 1 : 0)) {
    if (wallCoordinatesError(wall.c)) continue;
    const [x, y, u, v] = wall.c, dx = u - x, dy = v - y;
    const t = Math.max(0, Math.min(1, ((point.x - x) * dx + (point.y - y) * dy) / (dx * dx + dy * dy)));
    const at = { x: x + dx * t, y: y + dy * t }, d = Math.hypot(at.x - point.x, at.y - point.y);
    if (d <= distance && (!best || d < distance)) { best = { wall, point: at, t }; distance = d; }
  }
  return best;
}
export function planWallSplit(sceneId: string, walls: readonly WallDocument[], wallId: string, point: WallPoint, newId: string, scale: number): Result<WallEditPlan> {
  const wall = walls.find((w) => w._id === wallId);
  if (!wall || wallCoordinatesError(wall.c)) return err("Wall no longer exists or has invalid coordinates.");
  // Keep portal/window identity intact. General portal subdivision needs explicit reference migration.
  if (isDoorWall(wall) || wall.door !== 0 || (wall.sight === 2 && wall.light === 2 && wall.move === 0) || wall.flags.core?.portal !== undefined)
    return err("Doors, windows and portals cannot be split. Draw separate wall segments around them.");
  if (wallEditLocked(wall)) return err("Locked and prefab walls cannot be split.");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(newId) || walls.some((w) => w._id === newId)) return err("A fresh wall ID is required.");
  const pick = nearestWallSegment([wall], point, scale);
  if (!pick) return err("Click on the wall segment to split it.");
  const [x, y, u, v] = wall.c;
  const length = Math.hypot(u - x, v - y), min = Math.max(MIN_WALL_LENGTH, 2 / scale);
  if (length * pick.t < min || length * (1 - pick.t) < min) return err("Split farther from the endpoints (at least 2 screen pixels).");
  const first = structuredClone(wall), second = structuredClone(wall);
  first.c = [x, y, pick.point.x, pick.point.y];
  second._id = newId;
  second.c = [pick.point.x, pick.point.y, u, v];
  return okVal({ guard: wallEditGuard(sceneId, walls), preview: [first, second], ops: [
    { kind: "update", ref: { coll: "walls", id: wallId, parent: { coll: "scenes", id: sceneId } }, diff: { c: first.c } },
    { kind: "create", coll: "walls", parent: { coll: "scenes", id: sceneId }, data: second },
  ] });
}

/** Host-side guard validation, before normalization/commit. No new authorization is granted. */
export function guardedWallEditError(guard: WallEditGuard, scene: { _id: string; walls: WallDocument[] } | undefined, ops: readonly Op[]): string | null {
  if (!guard || typeof guard.sceneId !== "string" || !/^[a-f0-9]{64}$/.test(guard.wallsHash) || !scene || scene._id !== guard.sceneId)
    return "Invalid wall-edit guard or missing scene.";
  if (wallSceneHash(scene.walls) !== guard.wallsHash) return "Walls changed during the gesture. Nothing was edited; try again.";
  if (!ops.length || ops.length > MAX_WALL_EDIT_OPS) return "Wall edit needs 1–256 operations.";
  for (const op of ops) {
    if (!op || typeof op !== "object" || !["create", "update", "delete"].includes(op.kind)) return "Invalid wall edit operation.";
    if (op.kind === "update" && (!op.ref || typeof op.ref !== "object" || !op.diff || typeof op.diff !== "object" || Array.isArray(op.diff))) return "Invalid wall update.";
    if (op.kind === "create" && (!op.data || typeof op.data !== "object")) return "Invalid wall create.";
    if (op.kind === "delete") return "Guarded wall edits do not delete existing identities.";
    const coll = op.kind === "create" ? op.coll : op.ref.coll;
    const parent = op.kind === "create" ? op.parent : op.ref.parent;
    if (coll !== "walls" || parent?.coll !== "scenes" || parent.id !== guard.sceneId || parent.parent)
      return "Wall edit cannot affect a different scene or collection.";
    if (op.kind === "update") {
      const wall = scene.walls.find((w) => w._id === op.ref.id);
      if (!wall || wallEditLocked(wall)) return "Wall is missing, locked or attached to a prefab.";
      if (Object.keys(op.diff).length !== 1 || !Object.hasOwn(op.diff, "c")) return "Wall edit may only update coordinates.";
      const error = wallCoordinatesError(op.diff.c); if (error) return error;
    } else {
      const wall = op.data as WallDocument;
      const error = wallCoordinatesError(wall.c); if (error) return error;
      if (wall.type !== "wall" || wallEditLocked(wall)) return "Invalid new wall in edit.";
    }
  }
  return null;
}
