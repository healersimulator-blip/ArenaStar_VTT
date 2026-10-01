import type { TileDocument } from "./documents";

export const TILE_ALPHA_MASK_SIZE = 64;
export type TileTriggerAlphaRun = [start: number, endExclusive: number];
export interface TileTriggerAlphaMask {
  kind: "alpha";
  width: 64;
  height: 64;
  /** Content hash of the image whose alpha was sampled when this mask was authored. */
  imageHash: string;
  /** Row-major, ordered opaque-pixel runs; end coordinates are exclusive. */
  rows: TileTriggerAlphaRun[][];
}
export interface TileTriggerPolygon {
  kind: "polygon";
  /** Convex polygon in clockwise or counter-clockwise tile-local normalized coordinates. */
  points: Array<[number, number]>;
}
export type TileTriggerZone = TileTriggerPolygon | TileTriggerAlphaMask;

/** Canonical 32-vertex convex approximation used for authored circular zones. */
export function tileTriggerCirclePolygon(): TileTriggerPolygon {
  return { kind: "polygon", points: Array.from({ length: 32 }, (_unused, index) => {
    const angle = index * Math.PI * 2 / 32;
    return [0.5 + Math.cos(angle) * 0.5, 0.5 + Math.sin(angle) * 0.5];
  }) };
}

export interface TileTriggerPoint { x: number; y: number }
export interface TileTriggerElevationRange { min: number; max: number }

/** Inclusive vertical band in scene grid units. */
export function tileTriggerElevationError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "trigger elevation must be a bounded min/max range";
  const range = value as Record<string, unknown>;
  if (Object.keys(range).some((key) => key !== "min" && key !== "max") ||
      !Number.isFinite(range.min) || !Number.isFinite(range.max) ||
      (range.min as number) < -1_000_000 || (range.max as number) > 1_000_000 ||
      (range.min as number) > (range.max as number))
    return "trigger elevation must be an ordered finite range within ±1,000,000 scene units";
  return null;
}

/** Encode downsampled RGBA pixels as a bounded canonical run-length alpha mask. */
export function tileAlphaMaskFromRgba(rgba: ArrayLike<number>, width: number, height: number,
  imageHash: string, threshold = 1): TileTriggerAlphaMask | null {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 ||
      rgba.length !== width * height * 4 || !/^[0-9a-f]{64}$/i.test(imageHash) ||
      !Number.isInteger(threshold) || threshold < 1 || threshold > 255) return null;
  const rows: TileTriggerAlphaRun[][] = [];
  let runCount = 0;
  const opaque = (index: number) => {
    const alpha = Number(rgba[index]);
    return Number.isFinite(alpha) && alpha >= threshold;
  };
  for (let y = 0; y < height; y++) {
    const row: TileTriggerAlphaRun[] = [];
    for (let x = 0; x < width;) {
      while (x < width && !opaque((y * width + x) * 4 + 3)) x++;
      if (x === width) break;
      const start = x;
      while (x < width && opaque((y * width + x) * 4 + 3)) x++;
      row.push([start, x]);
      if (++runCount > 1024) return null;
    }
    rows.push(row);
  }
  if (width !== TILE_ALPHA_MASK_SIZE || height !== TILE_ALPHA_MASK_SIZE || runCount === 0) return null;
  return { kind: "alpha", width: TILE_ALPHA_MASK_SIZE, height: TILE_ALPHA_MASK_SIZE, imageHash, rows };
}

/** Validate polygon geometry or the bounded canonical alpha-run representation. */
export function tileTriggerZoneError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "triggerZone must be a polygon or alpha mask";
  const zone = value as Record<string, unknown>;
  if (zone.kind === "alpha") {
    if (zone.width !== TILE_ALPHA_MASK_SIZE || zone.height !== TILE_ALPHA_MASK_SIZE ||
        typeof zone.imageHash !== "string" || !/^[0-9a-f]{64}$/i.test(zone.imageHash) ||
        !Array.isArray(zone.rows) || zone.rows.length !== TILE_ALPHA_MASK_SIZE ||
        Object.keys(zone).some((key) => !["kind", "width", "height", "imageHash", "rows"].includes(key)))
      return "alpha trigger mask needs a 64×64 row-run mask and source image hash";
    let total = 0;
    for (const row of zone.rows) {
      if (!Array.isArray(row) || row.length > 128) return "alpha trigger mask row is invalid";
      let previousEnd = -1;
      for (const run of row) {
        if (!Array.isArray(run) || run.length !== 2 ||
            ![run[0], run[1]].every((n) => Number.isInteger(n) && n >= 0 && n <= TILE_ALPHA_MASK_SIZE))
          return "alpha trigger runs must be integer coordinate pairs";
        const [start, end] = run as TileTriggerAlphaRun;
        if (start >= end || start <= previousEnd) return "alpha trigger runs must be ordered, disjoint and non-adjacent";
        previousEnd = end;
        if (++total > 1024) return "alpha trigger mask exceeds 1,024 runs";
      }
    }
    return total > 0 ? null : "alpha trigger mask has no opaque pixels";
  }
  if (zone.kind !== "polygon" || !Array.isArray(zone.points) || zone.points.length < 3 || zone.points.length > 32 ||
      Object.keys(zone).some((key) => !["kind", "points"].includes(key)))
    return "triggerZone needs a convex polygon with 3–32 points";
  const points: TileTriggerPoint[] = [];
  for (const raw of zone.points) {
    if (!Array.isArray(raw) || raw.length !== 2 ||
        ![raw[0], raw[1]].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1))
      return "triggerZone points must be normalized finite coordinate pairs";
    const [x, y] = raw as [number, number];
    if (points.some((point) => Math.abs(point.x - x) < 1e-8 && Math.abs(point.y - y) < 1e-8))
      return "triggerZone points must be unique";
    points.push({ x, y });
  }
  let orientation = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as TileTriggerPoint;
    const b = points[(i + 1) % points.length] as TileTriggerPoint;
    const c = points[(i + 2) % points.length] as TileTriggerPoint;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-8) return "triggerZone polygon must be strictly convex";
    const sign = Math.sign(cross);
    if (orientation !== 0 && sign !== orientation) return "triggerZone polygon must be convex and ordered";
    orientation = sign;
  }
  return null;
}

/** Legacy rectangle or authored polygon in the tile's unrotated scene-local coordinates. */
export function tileTriggerLocalPolygon(tile: TileDocument): TileTriggerPoint[] | null {
  const { x, y, width, height } = tile;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const raw = tile.triggerZone;
  if (raw !== undefined && (tileTriggerZoneError(raw) !== null || raw.kind !== "polygon")) return null;
  const points = raw?.points ?? [[0, 0], [1, 0], [1, 1], [0, 1]] as Array<[number, number]>;
  return points.map(([u, v]) => ({ x: x + u * width, y: y + v * height }));
}

/** Legacy rectangle or authored polygon, transformed by the tile's center rotation. */
export function tileTriggerWorldPolygon(tile: TileDocument): TileTriggerPoint[] | null {
  const { x, y, width, height } = tile;
  if (![x, y, width, height, tile.rotation ?? 0].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const raw = tile.triggerZone;
  if (raw !== undefined && (tileTriggerZoneError(raw) !== null || raw.kind !== "polygon")) return null;
  const points = raw?.points ?? [[0, 0], [1, 0], [1, 1], [0, 1]] as Array<[number, number]>;
  const cx = x + width / 2, cy = y + height / 2;
  const radians = (tile.rotation ?? 0) * Math.PI / 180;
  const cos = Math.cos(radians), sin = Math.sin(radians);
  return points.map(([u, v]) => {
    const localX = x + u * width - cx, localY = y + v * height - cy;
    return { x: cx + localX * cos - localY * sin, y: cy + localX * sin + localY * cos };
  });
}

/** Transform a world point into the tile's unrotated normalized local frame. */
export function tileWorldToLocalNormalized(tile: TileDocument, point: TileTriggerPoint): TileTriggerPoint | null {
  if (![tile.x, tile.y, tile.width, tile.height, tile.rotation ?? 0, point.x, point.y].every(Number.isFinite) ||
      tile.width <= 0 || tile.height <= 0) return null;
  const cx = tile.x + tile.width / 2, cy = tile.y + tile.height / 2;
  const radians = -(tile.rotation ?? 0) * Math.PI / 180;
  const dx = point.x - cx, dy = point.y - cy;
  const x = cx + dx * Math.cos(radians) - dy * Math.sin(radians);
  const y = cy + dx * Math.sin(radians) + dy * Math.cos(radians);
  return { x: (x - tile.x) / tile.width, y: (y - tile.y) / tile.height };
}

/** Alpha-mask point query. Pixel boundaries belong to the opaque run on their right/bottom. */
export function tileTriggerAlphaContains(tile: TileDocument, point: TileTriggerPoint): boolean {
  const mask = tile.triggerZone;
  if (!mask || mask.kind !== "alpha" || tileTriggerZoneError(mask) !== null) return false;
  const local = tileWorldToLocalNormalized(tile, point);
  if (!local || local.x < 0 || local.x > 1 || local.y < 0 || local.y > 1) return false;
  const x = Math.min(mask.width - 1, Math.floor(local.x * mask.width));
  const y = Math.min(mask.height - 1, Math.floor(local.y * mask.height));
  return (mask.rows[y] ?? []).some(([start, end]) => x >= start && x < end);
}

/** Convex-polygon point test; boundaries are included for pointer picking. */
export function tileTriggerPolygonContains(polygon: readonly TileTriggerPoint[], point: TileTriggerPoint): boolean {
  if (polygon.length < 3 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as TileTriggerPoint;
    const b = polygon[(i + 1) % polygon.length] as TileTriggerPoint;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) <= 1e-8) continue;
    const next = Math.sign(cross);
    if (sign !== 0 && next !== sign) return false;
    sign = next;
  }
  return true;
}
