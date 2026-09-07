/**
 * §9 wall restriction semantics — shared by the vision pipeline (which
 * segments block sight for a polygon), the Walls(GM) overlay colors, and
 * future sound/move checks.
 *
 * Restriction codes (§0 / D-009): 0 = blocks, 1 = conditional (door state
 * applies), 2 = permits. Door states: 0 = closed, 1 = open, 2 = locked.
 * Conditional walls block while the door is closed or locked and permit
 * while open (spec leaves the pairing implicit — logged as D-075).
 */
import type { WallDocument } from "../../core/documents";
import type { Segment } from "./polygon";

export type DoorState = 0 | 1 | 2; // closed | open | locked

/** Effective blocked? for one restriction axis of one wall. */
export function axisBlocks(restriction: 0 | 1 | 2, door: DoorState): boolean {
  if (restriction === 2) return false;
  if (restriction === 0) return true;
  return door !== 1; // conditional: blocked unless the door is open
}

export function sightBlocked(wall: WallDocument): boolean {
  return axisBlocks(wall.sight, wall.door);
}

/**
 * Sight-blocking segments (polygon input): opaque walls only. One-way walls
 * are directional for movement/vision THROUGH them; for polygon purposes a
 * one-way sight wall blocks (the vision worker computes from the viewer
 * side; per-viewer one-way sight refinement is a system concern, D-075).
 */
export function sightSegments(walls: readonly WallDocument[]): Segment[] {
  const out: Segment[] = [];
  for (const w of walls) {
    if (!sightBlocked(w)) continue;
    const c = w.c;
    out.push({ x1: c[0] ?? 0, y1: c[1] ?? 0, x2: c[2] ?? 0, y2: c[3] ?? 0 });
  }
  return out;
}

// ─── Walls(GM) overlay palette (restriction → stroke color) ──────────────────

export const WALL_COLORS = {
  sight: 0xff4455,
  move: 0x44ff99,
  sound: 0x8899ff,
  light: 0xffd244,
  oneWay: 0xffffff,
  doorClosed: 0x9aa0a8,
  doorOpen: 0x44cc66,
  doorLocked: 0xcc4444,
} as const;

/** Dominant stroke color for a wall in the GM overlay. */
export function wallStroke(w: WallDocument): number {
  if (w.sight !== 2) return WALL_COLORS.sight;
  if (w.move !== 2) return WALL_COLORS.move;
  if (w.light !== 2) return WALL_COLORS.light;
  if (w.sound !== 2) return WALL_COLORS.sound;
  return WALL_COLORS.doorClosed;
}
