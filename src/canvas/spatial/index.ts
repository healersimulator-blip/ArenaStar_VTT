/**
 * §9A SpatialHash over Models — hit-testing, box-select, hover and
 * DetectionGrid seeding; rebuilt incrementally from SimDeltas.
 *
 * Pure module (no Pixi / no DOM): the same instance runs client-side over the
 * local ModelPool replica and can seed the host DetectionGrid. Cell size
 * defaults to 5 world units to match DetectionGrid (§5A).
 */
import type { ModelPool } from "../../core/strategic";
import { ModelStatus } from "../../core/strategic";
import type { SimDelta } from "../../core/sim";
import type { WorldRect } from "../tokens";

export type { WorldRect };

/** World is partitioned into [cellSize] buckets; key packs (cx, cy). */
const CELL_SPAN = 1 << 12; // ±4096 cells per axis (±20,480 world units at cell 5)

/** A unit's model occupancy on this scene (§4A army.units[].modelRange). */
export interface UnitRange {
  id: string;
  modelRange: readonly [number, number] | null;
}

export interface CellEntry {
  cx: number;
  cy: number;
  /** Model indices currently in this cell (unsorted). */
  indices: readonly number[];
}

export class ModelSpatialHash {
  readonly cellSize: number;
  /** Bumped on every mutation; cheap external invalidation. */
  version = 0;
  private readonly cells = new Map<number, number[]>();
  /** Mirrored positions so applyDelta can remove a model from its OLD cell. */
  private mx: Float32Array;
  private my: Float32Array;
  private count = 0;

  constructor(cellSize = 5) {
    this.cellSize = cellSize;
    this.mx = new Float32Array(1024).fill(Number.NaN);
    this.my = new Float32Array(1024).fill(Number.NaN);
  }

  private key(cx: number, cy: number): number {
    return (cx + CELL_SPAN) * (CELL_SPAN * 2) + (cy + CELL_SPAN);
  }

  private cellOf(x: number, y: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return this.key(cx, cy);
  }

  private grow(minCapacity: number): void {
    if (minCapacity <= this.mx.length) return;
    let cap = this.mx.length;
    while (cap < minCapacity) cap *= 2;
    const nx = new Float32Array(cap).fill(Number.NaN);
    const ny = new Float32Array(cap).fill(Number.NaN);
    nx.set(this.mx);
    ny.set(this.my);
    this.mx = nx;
    this.my = ny;
  }

  private insert(idx: number, x: number, y: number): void {
    const k = this.cellOf(x, y);
    let list = this.cells.get(k);
    if (!list) {
      list = [];
      this.cells.set(k, list);
    }
    list.push(idx);
    if (idx < this.mx.length) {
      this.mx[idx] = x;
      this.my[idx] = y;
    }
  }

  private remove(idx: number): void {
    const ox = this.mx[idx];
    const oy = this.my[idx];
    if (ox === undefined || oy === undefined || Number.isNaN(ox) || Number.isNaN(oy)) return;
    const k = this.cellOf(ox, oy);
    const list = this.cells.get(k);
    if (!list) return;
    const at = list.indexOf(idx);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.cells.delete(k);
    this.mx[idx] = Number.NaN;
    this.my[idx] = Number.NaN;
  }

  /** Full rebuild from a pool (snapshot install, scene load, undo resync). */
  rebuild(pool: ModelPool): void {
    this.cells.clear();
    this.grow(pool.count);
    this.mx.fill(Number.NaN);
    this.my.fill(Number.NaN);
    this.count = pool.count;
    for (let i = 0; i < pool.count; i++) {
      this.insert(i, pool.x[i] ?? 0, pool.y[i] ?? 0);
    }
    this.version++;
  }

  /**
   * Incremental update from an applied SimDelta (§9A: "rebuilt incrementally
   * from SimDeltas"). Only the union of changed x/y indices is touched.
   * Falls back to a full rebuild when the delta cannot be applied
   * incrementally: pool count changed (spawn / end-of-turn compaction shifts
   * indices) or any column is a full resend.
   */
  applyDelta(pool: ModelPool, delta: SimDelta): void {
    if (pool.count !== this.count || delta.columns.some((c) => c.fullResend)) {
      this.rebuild(pool);
      return;
    }
    this.grow(pool.count);
    for (const col of delta.columns) {
      if (col.column !== "x" && col.column !== "y") continue;
      for (const [start, len] of col.runs) {
        for (let i = start; i < start + len && i < pool.count; i++) {
          this.remove(i);
          this.insert(i, pool.x[i] ?? 0, pool.y[i] ?? 0);
        }
      }
    }
    this.version++;
  }

  /** All model indices whose position lies inside the rect (unsorted). */
  queryRect(rect: WorldRect): number[] {
    const out: number[] = [];
    const minX = rect.x;
    const minY = rect.y;
    const maxX = rect.x + rect.width;
    const maxY = rect.y + rect.height;
    const cx0 = Math.floor(minX / this.cellSize);
    const cx1 = Math.floor(maxX / this.cellSize);
    const cy0 = Math.floor(minY / this.cellSize);
    const cy1 = Math.floor(maxY / this.cellSize);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells.get(this.key(cx, cy));
        if (!list) continue;
        for (const i of list) {
          const x = this.mx[i] ?? Number.NaN;
          const y = this.my[i] ?? Number.NaN;
          if (x >= minX && x <= maxX && y >= minY && y <= maxY) out.push(i);
        }
      }
    }
    return out;
  }

  /**
   * Model indices within `radius` of (x, y), nearest first.
   * When a pool is given, dead and hidden models are filtered (hidden slots
   * of a projected replica carry zeroed positions and must never hit-test).
   */
  queryPoint(
    x: number,
    y: number,
    radius = 0.5,
    pool?: ModelPool,
  ): Array<{ index: number; dist2: number }> {
    const hits: Array<{ index: number; dist2: number }> = [];
    const r = Math.max(radius, this.cellSize * 0.001);
    const cx0 = Math.floor((x - r) / this.cellSize);
    const cx1 = Math.floor((x + r) / this.cellSize);
    const cy0 = Math.floor((y - r) / this.cellSize);
    const cy1 = Math.floor((y + r) / this.cellSize);
    const r2 = r * r;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells.get(this.key(cx, cy));
        if (!list) continue;
        for (const i of list) {
          const dx = (this.mx[i] ?? Number.NaN) - x;
          const dy = (this.my[i] ?? Number.NaN) - y;
          const d2 = dx * dx + dy * dy;
          if (d2 > r2) continue;
          if (pool) {
            const status = pool.status[i] ?? 0;
            if ((status & ModelStatus.dead) !== 0 || (status & ModelStatus.hidden) !== 0) {
              continue;
            }
          }
          hits.push({ index: i, dist2: d2 });
        }
      }
    }
    hits.sort((a, b) => a.dist2 - b.dist2);
    return hits;
  }

  /** Owning unit id for a model index, or null (linear over ranges; few units). */
  static unitForModelIndex(units: readonly UnitRange[], index: number): string | null {
    for (const u of units) {
      if (u.modelRange && index >= u.modelRange[0] && index < u.modelRange[1]) return u.id;
    }
    return null;
  }

  /** Hit-test a point to a UNIT id (§9A: selection targets Units, not Models). */
  unitAtPoint(
    x: number,
    y: number,
    units: readonly UnitRange[],
    pool: ModelPool,
    radius = 0.75,
  ): string | null {
    for (const hit of this.queryPoint(x, y, radius, pool)) {
      const id = ModelSpatialHash.unitForModelIndex(units, hit.index);
      if (id !== null) return id;
    }
    return null;
  }

  /**
   * All units with at least one model inside the rect (box-select, §9A).
   * Dead/hidden models never select their unit via this path.
   */
  unitsInRect(rect: WorldRect, units: readonly UnitRange[], pool: ModelPool): Set<string> {
    const out = new Set<string>();
    for (const i of this.queryRect(rect)) {
      const status = pool.status[i] ?? 0;
      if ((status & ModelStatus.dead) !== 0 || (status & ModelStatus.hidden) !== 0) continue;
      const id = ModelSpatialHash.unitForModelIndex(units, i);
      if (id !== null) out.add(id);
    }
    return out;
  }

  /** Occupied cells (DetectionGrid seeding; iterate, don't retain). */
  cellEntries(): CellEntry[] {
    const span = CELL_SPAN * 2;
    const out: CellEntry[] = [];
    for (const [k, indices] of this.cells) {
      const cy = (k % span) - CELL_SPAN;
      const cx = Math.floor(k / span) - CELL_SPAN;
      out.push({ cx, cy, indices });
    }
    return out;
  }
}
