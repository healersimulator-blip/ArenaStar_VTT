/**
 * §9 ephemera pure logic — pings, ruler state, tile occlusion (D-083).
 * Pixi-free so Node tests cover the behaviour; layers stay thin drawers.
 */
import type { TileDocument } from "../core/documents";

// ─── Pings ────────────────────────────────────────────────────────────────────

/** Ping lifetime (ms): expanding ring + fade. */
export const PING_TTL_MS = 1400;

export interface PingPhase {
  alive: boolean;
  /** 0 → 1 across the lifetime (ease-out quad). */
  t: number;
}

export function pingPhase(ageMs: number, ttl = PING_TTL_MS): PingPhase {
  if (ageMs < 0 || ageMs >= ttl) return { alive: false, t: 1 };
  const linear = ageMs / ttl;
  return { alive: true, t: 1 - (1 - linear) * (1 - linear) };
}

// ─── Ruler ────────────────────────────────────────────────────────────────────

/** Ruler lingers this long after its last update, then fades out (ms). */
export const RULER_LINGER_MS = 2500;

/** Append a snapped waypoint (max 12, §4A); same ref when unchanged. */
export function rulerAppend(
  points: ReadonlyArray<{ x: number; y: number }>,
  point: { x: number; y: number },
  max = 12,
): { x: number; y: number }[] {
  if (points.length >= max) return points as { x: number; y: number }[];
  return [...points, { x: point.x, y: point.y }];
}

/** Ruler total label in grid units (e.g. "35 ft"); distance units from grid. */
export function rulerLabel(total: number, units: string): string {
  return `${Math.round(total)} ${units}`;
}

// ─── Tile occlusion (§9 roof/fade) ────────────────────────────────────────────

export interface TileRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectsOverlap(a: TileRect, b: TileRect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Occlusion alpha for a tile (§9):
 *   below              → always opaque (1)
 *   above + fade       → always occlusion.alpha
 *   above + roof       → occlusion.alpha while an occupied rect (a token with
 *                        vision) is beneath, else opaque (1)
 */
export function tileAlpha(
  tile: Pick<TileDocument, "above" | "occlusion">,
  occupiedUnder: boolean,
): number {
  if (!tile.above) return 1;
  if (tile.occlusion.mode === "fade") return tile.occlusion.alpha;
  return occupiedUnder ? tile.occlusion.alpha : 1;
}

/** Deterministic placeholder tint for an imageless tile (hash → hue). */
export function tileTint(img: string): number {
  let h = 2166136261;
  for (let i = 0; i < img.length; i++) {
    h ^= img.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  const sector = Math.floor(hue / 60) % 6;
  const f = (hue % 60) / 60;
  const up = Math.round(120 + 60 * f);
  const down = Math.round(180 - 60 * f);
  const rgb: [number, number, number] =
    sector === 0
      ? [down, up, 130]
      : sector === 1
        ? [130, down, up]
        : sector === 2
          ? [130, up, down]
          : sector === 3
            ? [up, 130, down]
            : sector === 4
              ? [down, 130, up]
              : [up, down, 130];
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}
