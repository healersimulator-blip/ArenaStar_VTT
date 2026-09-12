/**
 * §5A DetectionGrid — host-maintained coarse grid (cell = configurable,
 * default 5 grid squares). Each Unit contributes a detection radius (from
 * RulesModule.detection); a Model is visible to a faction when its cell is
 * detected by that faction or an ally (shared vision). LOS against walls is
 * evaluated per cell pair, cached, and invalidated when walls change.
 *
 * Faction bitmasks: ≤ 31 factions per scene (index assigned on reseed).
 */
import type { RulesWallsContext } from "../core/rules";
import type { ModelPool } from "../core/strategic";
import type { DocId } from "../core/ids";
import type { Vec2 } from "../core/strategic";

/** Sight restriction bit (§0 RulesWallsContext convention). */
export const WALL_SIGHT_BIT = 1 << 1;

/** Movement restriction bit (§0 RulesWallsContext convention: move|sight|sound|light). */
export const WALL_MOVE_BIT = 1 << 0;

export interface DetectionSource {
  anchor: Vec2;
  factionId: DocId;
  /** Radius in grid units (RulesModule.detection). */
  radius: number;
}

export interface DetectionBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Live-model bounds of a pool — the default seeding bounds. */
export function poolBounds(pool: ModelPool): DetectionBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pool.count; i++) {
    const x = pool.x[i] ?? 0;
    const y = pool.y[i] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Segment/segment intersection — wall LOS test (§9 math, host side). */
function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * True when no sight-blocking wall crosses the segment a→b. This is the §0 wall contract
 * (bit 1 of `restriction` = sight) reused by the spell layers: CRB p.214's line of effect
 * is "like line of sight … except that it's not blocked by fog, darkness, and other
 * factors that limit normal sight", and the sim authors such factors as non-sight walls.
 */
export function hasLineOfEffect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  walls: RulesWallsContext,
): boolean {
  for (let i = 0; i < walls.x1.length; i++) {
    if (((walls.restriction[i] ?? 0) & WALL_SIGHT_BIT) === 0) continue;
    if (segmentsIntersect(ax, ay, bx, by, walls.x1[i] ?? 0, walls.y1[i] ?? 0, walls.x2[i] ?? 0, walls.y2[i] ?? 0)) {
      return false;
    }
  }
  return true;
}

/**
 * The earliest crossing of the segment a→b with any movement-blocking wall (bit 0 of
 * `restriction`, the §0 wall contract), as a fraction t ∈ (0,1) along a→b — or null when
 * the path is clear. Uses the same strict-crossing convention as the LOS test above
 * (grazing a wall endpoint does not block). Movement resolution stops the mover at the
 * returned fraction; it never routes around the wall (pathfinding is out of scope).
 */
export function firstMoveBlock(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  walls: RulesWallsContext,
): number | null {
  const rx = bx - ax;
  const ry = by - ay;
  let best: number | null = null;
  for (let i = 0; i < walls.x1.length; i++) {
    if (((walls.restriction[i] ?? 0) & WALL_MOVE_BIT) === 0) continue;
    const cx = walls.x1[i] ?? 0;
    const cy = walls.y1[i] ?? 0;
    const dx = walls.x2[i] ?? 0;
    const dy = walls.y2[i] ?? 0;
    const wx = dx - cx;
    const wy = dy - cy;
    const denom = rx * wy - ry * wx;
    if (denom === 0) continue; // parallel — never crosses
    const t = ((cx - ax) * wy - (cy - ay) * wx) / denom;
    const s = ((cx - ax) * ry - (cy - ay) * rx) / denom;
    if (t <= 0 || t >= 1 || s <= 0 || s >= 1) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

export class DetectionGrid {
  private readonly cellSize: number;
  private cols = 0;
  private rows = 0;
  private originX = 0;
  private originY = 0;
  /** Per-cell faction bitmask (bit = faction index from the last reseed). */
  private cells: Int32Array = new Int32Array(0);
  private factionBits = new Map<DocId, number>();
  private losCache = new Map<number, boolean>();
  private wallsVersionSeen = -1;

  constructor(cellSize = 5) {
    this.cellSize = Math.max(1, cellSize);
  }

  /** Cell index for a world point; -1 outside the grid. */
  private cellOf(x: number, y: number): number {
    const cx = Math.floor((x - this.originX) / this.cellSize);
    const cy = Math.floor((y - this.originY) / this.cellSize);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return -1;
    return cy * this.cols + cx;
  }

  private centerOf(cell: number): Vec2 {
    const cx = cell % this.cols;
    const cy = Math.floor(cell / this.cols);
    return {
      x: this.originX + (cx + 0.5) * this.cellSize,
      y: this.originY + (cy + 0.5) * this.cellSize,
    };
  }

  /**
   * Rebuild from detection sources. `walls` blocks sight between the source
   * cell and target cell (per-cell-pair cache); `wallsVersion` invalidates
   * the cache when walls change (§5A).
   */
  reseed(
    sources: readonly DetectionSource[],
    bounds: DetectionBounds,
    walls: RulesWallsContext | null = null,
    wallsVersion = 0,
  ): void {
    if (wallsVersion !== this.wallsVersionSeen) {
      this.losCache.clear();
      this.wallsVersionSeen = wallsVersion;
    }
    const pad = this.cellSize * 2;
    this.originX = bounds.minX - pad;
    this.originY = bounds.minY - pad;
    this.cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX + pad * 2) / this.cellSize));
    this.rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY + pad * 2) / this.cellSize));
    this.cells = new Int32Array(this.cols * this.rows);
    this.factionBits.clear();

    // assign faction bits
    const bitFor = (factionId: DocId): number => {
      let bit = this.factionBits.get(factionId);
      if (bit === undefined) {
        bit = 1 << this.factionBits.size;
        if (this.factionBits.size >= 31) throw new Error("DetectionGrid: >31 factions");
        this.factionBits.set(factionId, bit);
      }
      return bit;
    };

    for (const src of sources) {
      const bit = bitFor(src.factionId);
      const srcCell = this.cellOf(src.anchor.x, src.anchor.y);
      if (srcCell < 0) continue;
      const r = Math.max(0, src.radius);
      const srcCenter = this.centerOf(srcCell);
      // cells whose center lies within radius of the source cell center
      const span = Math.ceil(r / this.cellSize) + 1;
      const scx = srcCell % this.cols;
      const scy = Math.floor(srcCell / this.cols);
      for (let dy = -span; dy <= span; dy++) {
        for (let dx = -span; dx <= span; dx++) {
          const cx = scx + dx;
          const cy = scy + dy;
          if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) continue;
          const c = cy * this.cols + cx;
          const center = this.centerOf(c);
          const dist = Math.hypot(center.x - srcCenter.x, center.y - srcCenter.y);
          if (dist > r + this.cellSize * 0.5) continue;
          if (walls && !this.los(srcCenter, center, walls)) continue;
          this.cells[c] = (this.cells[c] ?? 0) | bit;
        }
      }
    }
  }

  /** Cached LOS between two points against sight-restricted walls. */
  private los(a: Vec2, b: Vec2, walls: RulesWallsContext): boolean {
    const key = this.losKey(a, b);
    const cached = this.losCache.get(key);
    if (cached !== undefined) return cached;
    let clear = true;
    for (let i = 0; i < walls.x1.length; i++) {
      if (((walls.restriction[i] ?? 0) & WALL_SIGHT_BIT) === 0) continue;
      if (
        segmentsIntersect(
          a.x,
          a.y,
          b.x,
          b.y,
          walls.x1[i] ?? 0,
          walls.y1[i] ?? 0,
          walls.x2[i] ?? 0,
          walls.y2[i] ?? 0,
        )
      ) {
        clear = false;
        break;
      }
    }
    this.losCache.set(key, clear);
    return clear;
  }

  private losKey(a: Vec2, b: Vec2): number {
    // order-independent quantized pair key (cell resolution)
    const ka =
      ((Math.floor(a.x / this.cellSize) & 0xffff) << 16) |
      (Math.floor(a.y / this.cellSize) & 0xffff);
    const kb =
      ((Math.floor(b.x / this.cellSize) & 0xffff) << 16) |
      (Math.floor(b.y / this.cellSize) & 0xffff);
    const lo = Math.min(ka, kb);
    const hi = Math.max(ka, kb);
    return lo * 0x100000000 + hi;
  }

  /** Is a world point detected by any of `factionIds`? */
  detectedAt(x: number, y: number, factionIds: readonly DocId[]): boolean {
    const cell = this.cellOf(x, y);
    if (cell < 0) return false;
    const mask = this.cells[cell] ?? 0;
    return factionIds.some((f) => (mask & (this.factionBits.get(f) ?? 0)) !== 0);
  }

  /**
   * Visible-model bitmap over the pool for one faction (+ allies with shared
   * vision, §5A). Index-based; computed once per faction per delta.
   */
  visibleModels(pool: ModelPool, factionId: DocId, allies: readonly DocId[] = []): Uint8Array {
    const who = [factionId, ...allies];
    const out = new Uint8Array(pool.count);
    for (let i = 0; i < pool.count; i++) {
      out[i] = this.detectedAt(pool.x[i] ?? 0, pool.y[i] ?? 0, who) ? 1 : 0;
    }
    return out;
  }

  /** World rects of cells detected by the faction or its allies (fog clear-list, §9A). */
  factionCellRects(
    factionId: DocId,
    allies: readonly DocId[] = [],
  ): Array<{ x: number; y: number; width: number; height: number }> {
    const mask = this.factionMask(factionId, allies);
    const out: Array<{ x: number; y: number; width: number; height: number }> = [];
    if (mask === 0) return out;
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        if ((this.cells[cy * this.cols + cx] ?? 0) & mask) {
          out.push({
            x: this.originX + cx * this.cellSize,
            y: this.originY + cy * this.cellSize,
            width: this.cellSize,
            height: this.cellSize,
          });
        }
      }
    }
    return out;
  }

  /**
   * Undetected cell rects intersecting a world rect — the §9A strategic fog
   * cover list (drawn dark; GM god view skips the layer entirely).
   */
  undetectedRectsInView(
    view: { x: number; y: number; width: number; height: number },
    factionId: DocId,
    allies: readonly DocId[] = [],
  ): Array<{ x: number; y: number; width: number; height: number }> {
    const mask = this.factionMask(factionId, allies);
    const out: Array<{ x: number; y: number; width: number; height: number }> = [];
    const cx0 = Math.max(0, Math.floor((view.x - this.originX) / this.cellSize));
    const cy0 = Math.max(0, Math.floor((view.y - this.originY) / this.cellSize));
    const cx1 = Math.min(
      this.cols - 1,
      Math.floor((view.x + view.width - this.originX) / this.cellSize),
    );
    const cy1 = Math.min(
      this.rows - 1,
      Math.floor((view.y + view.height - this.originY) / this.cellSize),
    );
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        if (((this.cells[cy * this.cols + cx] ?? 0) & mask) === 0) {
          out.push({
            x: this.originX + cx * this.cellSize,
            y: this.originY + cy * this.cellSize,
            width: this.cellSize,
            height: this.cellSize,
          });
        }
      }
    }
    return out;
  }

  private factionMask(factionId: DocId, allies: readonly DocId[]): number {
    let mask = this.factionBits.get(factionId) ?? 0;
    for (const a of allies) mask |= this.factionBits.get(a) ?? 0;
    return mask;
  }

  /** Cache stats (tests / diagnostics). */
  get losCacheSize(): number {
    return this.losCache.size;
  }
}
