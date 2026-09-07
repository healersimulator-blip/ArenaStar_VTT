/**
 * Spatial Envelopment & Flanking Geometry Engine.
 */
import type { ModelPool } from "../../core/strategic";
import { ModelStatus } from "../../core/strategic";
import type { SpatialGrid } from "../../core/spatialGrid";

export interface PF1eEnvelopmentOptions {
  pool: ModelPool;
  grid: SpatialGrid;
  attackerUnitIdx: number;
  defenderUnitIdx: number;
  reach?: number;
}

export interface PF1eEnvelopmentResult {
  contactPairs: Array<[number, number]>;
  flankingModels: number[];
  envelopedDefenders: number[];
}

export const PF1E_STATUS_FLANKED = 1 << 2;

export function calculatePF1eEnvelopment(opts: PF1eEnvelopmentOptions): PF1eEnvelopmentResult {
  const { pool, grid, attackerUnitIdx, defenderUnitIdx, reach = 1.5 } = opts;

  const contactPairs: Array<[number, number]> = [];
  const flankingSet = new Set<number>();
  const defenderContactMap = new Map<number, number>(); // defenderIdx -> count of attackers engaging

  for (let i = 0; i < pool.count; i++) {
    if (pool.unitIdx[i] !== attackerUnitIdx) continue;
    const atkStatus = pool.status[i] ?? 0;
    if ((atkStatus & ModelStatus.dead) !== 0) continue;

    const ax = pool.x[i] ?? 0;
    const ay = pool.y[i] ?? 0;

    const neighbors = grid.queryPoint(ax, ay, reach, pool);
    let engagedInFront = false;

    for (const n of neighbors) {
      const targetIdx = n.index;
      if (pool.unitIdx[targetIdx] !== defenderUnitIdx) continue;
      const defStatus = pool.status[targetIdx] ?? 0;
      if ((defStatus & ModelStatus.dead) !== 0) continue;

      contactPairs.push([i, targetIdx]);
      engagedInFront = true;

      const prev = defenderContactMap.get(targetIdx) ?? 0;
      defenderContactMap.set(targetIdx, prev + 1);
    }

    if (!engagedInFront) {
      // Unengaged outer flank model
      flankingSet.add(i);
    }
  }

  // Defenders engaged by multiple attackers from different positions are flanked
  const envelopedDefenders: number[] = [];
  for (const [defIdx, count] of defenderContactMap.entries()) {
    if (count >= 2) {
      envelopedDefenders.push(defIdx);
      pool.status[defIdx] = (pool.status[defIdx] ?? 0) | PF1E_STATUS_FLANKED;
    }
  }

  return {
    contactPairs,
    flankingModels: Array.from(flankingSet),
    envelopedDefenders,
  };
}
