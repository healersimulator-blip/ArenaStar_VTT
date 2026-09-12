/**
 * Player Hero Participation & Sync Bridge.
 */
import type { ModelPool } from "../../core/strategic";
import { ModelStatus } from "../../core/strategic";
import type { SpatialGrid } from "../../core/spatialGrid";

export interface LeadershipAuraOptions {
  pool: ModelPool;
  grid: SpatialGrid;
  heroModelIdx: number;
  radius?: number; // feet (SpatialGrid.queryPoint radii are in world/feet coordinates); default 30
  moraleBonus?: number;
}

export interface LeadershipAuraResult {
  buffedModels: number[];
}

export function applyHeroLeadershipAuras(opts: LeadershipAuraOptions): LeadershipAuraResult {
  const { pool, grid, heroModelIdx, radius = 30, moraleBonus = 2 } = opts;

  const hx = pool.x[heroModelIdx] ?? 0;
  const hy = pool.y[heroModelIdx] ?? 0;
  const heroUnitIdx = pool.unitIdx[heroModelIdx];

  // `radius` is already in feet — model coordinates are feet and `queryPoint` compares
  // against feet-squared, so it goes in unconverted. (D-172: the old `radius / 5`
  // assumed grid-cell units and shrank the documented 30-ft aura to 6 ft.)
  const neighbors = grid.queryPoint(hx, hy, radius, pool);
  const buffedModels: number[] = [];

  for (const n of neighbors) {
    const idx = n.index;
    if (idx === heroModelIdx) continue;
    if (pool.unitIdx[idx] !== heroUnitIdx) continue; // Only friendly models in unit

    const status = pool.status[idx] ?? 0;
    if ((status & ModelStatus.dead) !== 0) continue;

    // Apply morale bonus to fort, ref, will saves in sys array
    if (pool.sys["fort"]) pool.sys["fort"][idx] = (pool.sys["fort"][idx] ?? 0) + moraleBonus;
    if (pool.sys["will"]) pool.sys["will"][idx] = (pool.sys["will"][idx] ?? 0) + moraleBonus;

    buffedModels.push(idx);
  }

  return { buffedModels };
}
