/**
 * Strategic flanking — the mass battle's FLANKED bit, decided by AoN 183.
 *
 * Every living model's FLANKED bit is cleared and recomputed from the current layout
 * using `flanking.ts`'s exact AoN 183 line test (`segmentFlanks`) and `geometry.ts`'s
 * `squareDistance` reach test, backed by typed arrays (`Int32Array` / `Uint8Array`)
 * so 50,000-model turns run with zero per-model `Set` or object allocations.
 */
import type { ModelPool } from "../../core/strategic";
import { ModelStatus } from "../../core/strategic";
import type { SpatialGrid } from "../../core/spatialGrid";
import type { PF1eCell } from "./targeting";
import { canFlank, segmentFlanks } from "./flanking";
import { squareDistance } from "./geometry";

/**
 * M03 — FLANKED lives in `pfCondition` (u32), disjoint from `ModelStatus.pinned` in `pool.status`.
 */
export const PF1E_STATUS_FLANKED = 1 << 2;

export interface PF1eFlankingPassOptions {
  pool: ModelPool;
  grid: SpatialGrid;
  /** Feet per square — the scene's grid distance (`sceneCellFeet`). */
  cellFeet: number;
  /** Unit index → faction id (`units[i].factionId`). */
  factionByUnitIdx: readonly (string | null | undefined)[];
  /** Unit index → natural reach in squares (Table 8-4; D-180). */
  reachSquaresByUnitIdx: readonly number[];
  /**
   * Unit index → authored size, for Table 8-4's sub-square "can't flank"
   * exclusion. Absent sizes flank normally (the Medium default).
   */
  sizeByUnitIdx?: readonly (string | null | undefined)[];
  /** Override the enemy relation; defaults to "different faction". */
  isEnemy?: (aUnitIdx: number, bUnitIdx: number) => boolean;
}

export interface PF1eFlankingPair {
  /** The flanked defender's model index. */
  defender: number;
  /** Two enemy models that satisfy AoN 183 for it. */
  flankers: [number, number];
}

export interface PF1eFlankingPassResult {
  /** Defender model indices carrying the FLANKED bit after the pass. */
  flankedDefenders: number[];
  /** The pair that decided each flanked defender (first satisfying pair). */
  pairs: PF1eFlankingPair[];
}

/**
 * Clear and recompute every living model's FLANKED bit from the current layout.
 * Dead models never flank and are never flanked (their bit is cleared too).
 */
export function markPF1eFlanking(opts: PF1eFlankingPassOptions): PF1eFlankingPassResult {
  const { pool, grid, cellFeet } = opts;
  const count = pool.count;
  const isEnemy =
    opts.isEnemy ??
    ((a: number, b: number) =>
      (opts.factionByUnitIdx[a] ?? null) !== (opts.factionByUnitIdx[b] ?? null));

  const numUnits = Math.max(
    opts.factionByUnitIdx.length,
    opts.reachSquaresByUnitIdx.length,
    opts.sizeByUnitIdx?.length ?? 0,
  );
  const unitReach = new Int32Array(Math.max(1, numUnits));
  const unitCanFlank = new Uint8Array(Math.max(1, numUnits));
  let widestReachSquares = 0;

  for (let u = 0; u < numUnits; u++) {
    const raw = opts.reachSquaresByUnitIdx[u] ?? 1;
    const r = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    unitReach[u] = r;
    if (r > widestReachSquares) widestReachSquares = r;
    if (r > 0 && canFlank({ reachSquares: r, size: opts.sizeByUnitIdx?.[u] ?? null })) {
      unitCanFlank[u] = 1;
    }
  }

  const pfCol = pool.sys.pfCondition as unknown as Uint32Array | Int32Array | undefined;
  const flankedDefenders: number[] = [];
  const pairs: PF1eFlankingPair[] = [];

  if (widestReachSquares <= 0 || count === 0) {
    if (pfCol) {
      for (let d = 0; d < count; d++) {
        const pf = pfCol[d] ?? 0;
        if ((pf & PF1E_STATUS_FLANKED) !== 0) pfCol[d] = pf & ~PF1E_STATUS_FLANKED;
      }
    }
    return { flankedDefenders, pairs };
  }

  const queryFeet = Math.ceil(widestReachSquares * Math.SQRT2) * cellFeet;
  const invCell = 1 / cellFeet;
  const modelCols = new Int32Array(count);
  const modelRows = new Int32Array(count);
  const xs = pool.x;
  const ys = pool.y;
  const status = pool.status;
  const unitIdxArr = pool.unitIdx;

  for (let i = 0; i < count; i++) {
    if (pfCol) {
      const pf = pfCol[i] ?? 0;
      if ((pf & PF1E_STATUS_FLANKED) !== 0) pfCol[i] = pf & ~PF1E_STATUS_FLANKED;
    }
    if (((status[i] ?? 0) & ModelStatus.dead) === 0) {
      modelCols[i] = Math.floor((xs[i] ?? 0) * invCell);
      modelRows[i] = Math.floor((ys[i] ?? 0) * invCell);
    }
  }

  const candBuf = new Int32Array(Math.min(count, 512));
  const defSpace: [PF1eCell] = [{ col: 0, row: 0 }];
  const cellA: PF1eCell = { col: 0, row: 0 };
  const cellB: PF1eCell = { col: 0, row: 0 };

  for (let d = 0; d < count; d++) {
    if (((status[d] ?? 0) & ModelStatus.dead) !== 0) continue;
    const defenderUnitIdx = unitIdxArr[d] ?? 0;
    const dCol = modelCols[d] ?? 0;
    const dRow = modelRows[d] ?? 0;
    defSpace[0].col = dCol;
    defSpace[0].row = dRow;

    let candLen = 0;
    let extraCands: number[] | null = null;

    grid.visitPoint(xs[d] ?? 0, ys[d] ?? 0, queryFeet, pool, (a) => {
      if (a === d) return;
      const aUnit = unitIdxArr[a] ?? 0;
      if (!isEnemy(aUnit, defenderUnitIdx)) return;
      if ((unitCanFlank[aUnit] ?? 0) === 0) return;
      const reach = unitReach[aUnit] ?? 0;
      cellA.col = modelCols[a] ?? 0;
      cellA.row = modelRows[a] ?? 0;
      const distSq = squareDistance(cellA, defSpace[0]);
      if (distSq <= 0 || distSq > reach) return;
      if (candLen < candBuf.length) {
        candBuf[candLen++] = a;
      } else {
        if (!extraCands) extraCands = Array.from(candBuf);
        extraCands.push(a);
        candLen++;
      }
    });

    if (candLen < 2) continue;

    let flanker0 = -1;
    let flanker1 = -1;
    for (let i = 0; i < candLen && flanker0 < 0; i++) {
      const aIdx = extraCands ? (extraCands[i] ?? 0) : (candBuf[i] ?? 0);
      cellA.col = modelCols[aIdx] ?? 0;
      cellA.row = modelRows[aIdx] ?? 0;
      for (let j = 0; j < candLen; j++) {
        if (i === j) continue;
        const bIdx = extraCands ? (extraCands[j] ?? 0) : (candBuf[j] ?? 0);
        cellB.col = modelCols[bIdx] ?? 0;
        cellB.row = modelRows[bIdx] ?? 0;
        if (segmentFlanks(defSpace, cellA, cellB)) {
          flanker0 = aIdx;
          flanker1 = bIdx;
          break;
        }
      }
    }

    if (flanker0 < 0) continue;

    flankedDefenders.push(d);
    pairs.push({ defender: d, flankers: [flanker0, flanker1] });
    if (pfCol) {
      pfCol[d] = (pfCol[d] ?? 0) | PF1E_STATUS_FLANKED;
    }
  }

  return { flankedDefenders, pairs };
}
