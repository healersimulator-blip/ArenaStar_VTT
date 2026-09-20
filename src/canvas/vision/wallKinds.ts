/**
 * Wall/door/window kinds — D-257 (Gap G-43/G-27).
 *
 * D-256's rail could place a "wall" or a "door", but both were written with the same
 * restriction set and a door was written `door: 1` — i.e. *open*. The pair was therefore
 * cosmetic: `axisBlocks()` saw a conditional axis on a wall that was already permitting, and
 * nothing in the app ever changed a door's state after creation (G-43). This module is the
 * single place where a kind becomes an honest document, plus the geometry the UI needs to pick
 * a wall on the map and toggle it.
 *
 * Restriction codes are D-009's: `0` blocks, `1` is conditional on the door state, `2` permits.
 * Door states are D-075's: `0` closed, `1` open, `2` locked (`wallSight.axisBlocks` treats
 * locked as blocking). A *window* needs no new document field: sight and light pass, movement
 * and sound are blocked by ordinary codes.
 */
import type { WallDocument } from "../../core/documents";
import type { DoorState } from "./wallSight";

export type WallKind = "wall" | "door" | "window";

export const WALL_KINDS: readonly WallKind[] = ["wall", "door", "window"];

export interface WallAxes {
  sight: 0 | 1 | 2;
  move: 0 | 1 | 2;
  sound: 0 | 1 | 2;
  light: 0 | 1 | 2;
}

/**
 * The axes a kind writes.
 *
 * - **wall** — blocks everything, unconditionally (`0`): a door state must never open a wall.
 * - **door** — conditional (`1`) on every axis, so `door: 1` (open) permits sight, light,
 *   movement and sound while closed/locked block them. Placed **closed** (`door: 0`).
 * - **window** — sight and light permit (`2`), movement and sound block (`0`).
 */
export function wallAxesFor(kind: WallKind): WallAxes {
  switch (kind) {
    case "wall":
      return { sight: 0, move: 0, sound: 0, light: 0 };
    case "door":
      return { sight: 1, move: 1, sound: 1, light: 1 };
    case "window":
      return { sight: 2, move: 0, sound: 2, light: 2 };
  }
}

/** Display name for a kind (the document's `name` is authored, never derived again). */
export function wallKindName(kind: WallKind): string {
  switch (kind) {
    case "wall":
      return "Wall";
    case "door":
      return "Door";
    case "window":
      return "Window";
  }
}

/**
 * Recover the kind of a wall that already exists. Used by the GM overlay (colour + door dot)
 * and by the picker, so a wall loaded from a world file is classified without a new field:
 * conditional axes mean a door, permitting sight with blocked movement means a window, and
 * anything else is a plain wall.
 */
export function wallKindOf(w: Pick<WallDocument, "sight" | "move" | "sound" | "light" | "door">): WallKind {
  if (w.sight === 1 || w.move === 1 || w.sound === 1 || w.light === 1) return "door";
  if (w.sight === 2 && w.move === 0 && w.light === 2) return "window";
  return "wall";
}

/** The kind-shaped fields of a new wall (the caller owns `_id`, `name` and the parent ref). */
export function wallFieldsFor(
  kind: WallKind,
  c: readonly [number, number, number, number],
  door: DoorState = 0,
): Pick<WallDocument, "c" | "door" | "oneWay" | "move" | "sight" | "sound" | "light"> {
  return {
    c: [c[0], c[1], c[2], c[3]],
    door: kind === "door" ? door : 0,
    oneWay: false,
    ...wallAxesFor(kind),
  };
}

/**
 * The door-state update a click on a door produces: closed ⇄ open. A locked door ignores the
 * click (unlocking is a placement-time choice in the rail, not a one-click accident), and a
 * wall/window has no state to toggle — a plain wall must never answer a click with `door: 1`
 * even though its `door` field is `0`.
 */
export function doorToggleDiff(
  w: Pick<WallDocument, "door" | "sight" | "move" | "sound" | "light">,
): { door: DoorState } | null {
  if (wallKindOf(w) !== "door") return null;
  if (w.door === 0) return { door: 1 };
  if (w.door === 1) return { door: 0 };
  return null;
}

/** Perpendicular distance from `p` to segment `a`–`b` (world units). */
export function distanceToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface WallPick<T extends Pick<WallDocument, "c"> = WallDocument> {
  wall: T;
  /** Distance from the click to the segment, in world units. */
  distance: number;
  at: { x: number; y: number };
}

/**
 * The wall under a click: the nearest segment within `tolerance` world units. Ties break on
 * distance, then on insertion order, so the same click always picks the same wall.
 */
export function wallPickAt<T extends Pick<WallDocument, "c">>(
  walls: readonly T[],
  p: { x: number; y: number },
  tolerance: number,
): WallPick<T> | null {
  let best: WallPick<T> | null = null;
  for (const wall of walls) {
    const [x1, y1, x2, y2] = wall.c;
    const a = { x: x1 ?? 0, y: y1 ?? 0 };
    const b = { x: x2 ?? 0, y: y2 ?? 0 };
    const distance = distanceToSegment(p, a, b);
    if (distance > tolerance) continue;
    if (best && distance >= best.distance) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    best = { wall, distance, at: { x: a.x + t * dx, y: a.y + t * dy } };
  }
  return best;
}
