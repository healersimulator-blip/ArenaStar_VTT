/**
 * §9A LOD + culling (pure): three levels by zoom & density —
 *   0 = individual models with facing, 1 = unit block (formation shape +
 *   strength bar + banner), 2 = army marker.
 * Selection is per Unit; hysteresis keeps a unit on its current level while
 * zoom oscillates inside the boundary band (no flicker). Density demotion
 * pushes the largest LOD0 units to LOD1 when the per-frame model budget is
 * exceeded (zoom far out + 10k models on screen).
 *
 * No Pixi imports — unit-testable, and the ModelLayer adapter consumes it.
 */
import type { ModelPool } from "../../../core/strategic";
import { ModelStatus } from "../../../core/strategic";
import type { WorldRect } from "../../spatial";

export type LodLevel = 0 | 1 | 2;

export interface LodThresholds {
  /** Zoom below this ⇒ LOD1 (zooming out). */
  lod1Zoom: number;
  /** Zoom below this ⇒ LOD2. */
  lod2Zoom: number;
  /** Fractional band around each boundary a unit must fully exit to switch. */
  hysteresis: number;
  /** Max LOD0 models per sync before density demotion kicks in. */
  modelBudget: number;
}

export const DEFAULT_LOD_THRESHOLDS: LodThresholds = {
  lod1Zoom: 0.6,
  lod2Zoom: 0.22,
  hysteresis: 0.15,
  modelBudget: 12_000,
};

export interface LodUnit {
  id: string;
  modelRange: readonly [number, number] | null;
}

/**
 * Per-unit LOD memory across frames. Stores only the zoom-driven level;
 * density demotion is a pure per-frame overlay on top (stable for stable
 * input — no extra state to oscillate).
 */
export class UnitLodState {
  readonly levels = new Map<string, LodLevel>();
}

/** Zoom-only desired level, before hysteresis. */
export function desiredLod(zoom: number, t = DEFAULT_LOD_THRESHOLDS): LodLevel {
  if (zoom < t.lod2Zoom) return 2;
  if (zoom < t.lod1Zoom) return 1;
  return 0;
}

function hysteresisAdjust(
  prev: LodLevel,
  desired: LodLevel,
  zoom: number,
  t: LodThresholds,
): LodLevel {
  if (prev === desired) return desired;
  const boundary = Math.min(prev, desired) === 0 ? t.lod1Zoom : t.lod2Zoom;
  // Switch only once zoom exits the band [b(1-h), b(1+h)] around the boundary.
  if (desired > prev) return zoom < boundary * (1 - t.hysteresis) ? desired : prev;
  return zoom > boundary * (1 + t.hysteresis) ? desired : prev;
}

/**
 * Per-unit LOD for this frame. Writes the zoom-driven level back into
 * `state` (hysteresis memory) and applies density demotion on the result.
 * With a pool, LOD0 candidates over `modelBudget` models are demoted to
 * LOD1, largest unit first (deterministic tie-break by id).
 */
export function chooseUnitLods(
  units: readonly LodUnit[],
  zoom: number,
  state: UnitLodState,
  thresholds: LodThresholds = DEFAULT_LOD_THRESHOLDS,
  pool?: ModelPool,
): Map<string, LodLevel> {
  const out = new Map<string, LodLevel>();
  let lod0Models = 0;
  const lod0Candidates: Array<{ unit: LodUnit; models: number }> = [];
  for (const unit of units) {
    const range = unit.modelRange;
    if (!range) {
      out.set(unit.id, 1); // no models on scene → nothing to draw at LOD0 anyway
      continue;
    }
    const desired = desiredLod(zoom, thresholds);
    const prev = state.levels.get(unit.id) ?? desired;
    const applied = hysteresisAdjust(prev, desired, zoom, thresholds);
    state.levels.set(unit.id, applied);
    out.set(unit.id, applied);
    if (applied === 0 && pool) {
      // drawable models only — dead/hidden cost nothing at LOD0
      const end = Math.min(range[1], pool.count);
      let models = 0;
      for (let i = range[0]; i < end; i++) {
        const status = pool.status[i] ?? 0;
        if ((status & (ModelStatus.dead | ModelStatus.hidden)) !== 0) continue;
        models++;
      }
      lod0Models += models;
      lod0Candidates.push({ unit, models });
    }
  }
  if (pool && lod0Models > thresholds.modelBudget && lod0Candidates.length > 0) {
    lod0Candidates.sort((a, b) => b.models - a.models || (a.unit.id < b.unit.id ? -1 : 1));
    for (const cand of lod0Candidates) {
      if (lod0Models <= thresholds.modelBudget) break;
      out.set(cand.unit.id, 1);
      lod0Models -= cand.models;
    }
  }
  return out;
}

// ─── Culling (§9A: viewport culling per Unit bbox, then per model) ───────────

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bboxIntersects(a: BBox, rect: WorldRect): boolean {
  return (
    a.minX <= rect.x + rect.width &&
    a.maxX >= rect.x &&
    a.minY <= rect.y + rect.height &&
    a.maxY >= rect.y
  );
}

/**
 * Bounding box of a unit's drawable models. Dead and hidden models are
 * excluded: hidden slots of a projected player replica carry zeroed
 * positions and would stretch the box to the origin.
 */
export function unitBBox(pool: ModelPool, range: readonly [number, number] | null): BBox | null {
  if (!range) return null;
  const end = Math.min(range[1], pool.count);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = range[0]; i < end; i++) {
    const status = pool.status[i] ?? 0;
    if ((status & (ModelStatus.dead | ModelStatus.hidden)) !== 0) continue;
    const x = pool.x[i] ?? 0;
    const y = pool.y[i] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
}

/** Alive fraction of a unit's models (drives the LOD1 strength bar). */
export function strengthFraction(pool: ModelPool, range: readonly [number, number] | null): number {
  if (!range || range[1] <= range[0]) return 0;
  const end = Math.min(range[1], pool.count);
  let alive = 0;
  for (let i = range[0]; i < end; i++) {
    const status = pool.status[i] ?? 0;
    if ((status & (ModelStatus.dead | ModelStatus.hidden)) !== 0) continue;
    if ((pool.hp[i] ?? 0) > 0) alive++;
  }
  return alive / (range[1] - range[0]);
}

/**
 * Drawable (alive, visible) model indices of a unit, optionally culled to a
 * world rect. Appends to `out`; returns the number appended.
 */
export function drawableModelIndices(
  pool: ModelPool,
  range: readonly [number, number] | null,
  rect: WorldRect | null,
  out: number[],
): number {
  if (!range) return 0;
  const end = Math.min(range[1], pool.count);
  const added0 = out.length;
  for (let i = range[0]; i < end; i++) {
    const status = pool.status[i] ?? 0;
    if ((status & (ModelStatus.dead | ModelStatus.hidden)) !== 0) continue;
    if (rect) {
      const x = pool.x[i] ?? 0;
      const y = pool.y[i] ?? 0;
      if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) continue;
    }
    out.push(i);
  }
  return out.length - added0;
}
