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
  radius?: number; // default 30ft (6 grid units)
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

  const neighbors = grid.queryPoint(hx, hy, radius / 5, pool);
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

export interface CleaveOverkillOptions {
  pool: ModelPool;
  grid: SpatialGrid;
  targetModelIdx: number;
  damageDealt: number;
  enemyUnitIdx: number;
}

export interface CleaveOverkillResult {
  modelsSlain: number[];
  cleavedDamage: number;
}

export function applyHeroCleaveOverkill(opts: CleaveOverkillOptions): CleaveOverkillResult {
  const { pool, grid, targetModelIdx, damageDealt, enemyUnitIdx } = opts;

  const tx = pool.x[targetModelIdx] ?? 0;
  const ty = pool.y[targetModelIdx] ?? 0;

  const targetHp = pool.hp[targetModelIdx] ?? 0;
  const modelsSlain: number[] = [];

  let excessDamage = damageDealt - targetHp;

  // First target takes full damage up to its HP
  pool.hp[targetModelIdx] = 0;
  pool.status[targetModelIdx] = (pool.status[targetModelIdx] ?? 0) | ModelStatus.dead;
  modelsSlain.push(targetModelIdx);

  if (excessDamage <= 0) {
    return { modelsSlain, cleavedDamage: 0 };
  }

  const initialCleavedDamage = excessDamage;

  // Query adjacent models within 5ft reach
  const neighbors = grid.queryPoint(tx, ty, 1.5, pool);

  for (const n of neighbors) {
    if (excessDamage <= 0) break;
    const adjacentIdx = n.index;
    if (adjacentIdx === targetModelIdx) continue;
    if (pool.unitIdx[adjacentIdx] !== enemyUnitIdx) continue;

    const status = pool.status[adjacentIdx] ?? 0;
    if ((status & ModelStatus.dead) !== 0) continue;

    const adjHp = pool.hp[adjacentIdx] ?? 0;
    if (excessDamage >= adjHp) {
      excessDamage -= adjHp;
      pool.hp[adjacentIdx] = 0;
      pool.status[adjacentIdx] = (pool.status[adjacentIdx] ?? 0) | ModelStatus.dead;
      modelsSlain.push(adjacentIdx);
    } else {
      pool.hp[adjacentIdx] = adjHp - excessDamage;
      excessDamage = 0;
    }
  }

  return { modelsSlain, cleavedDamage: initialCleavedDamage - excessDamage };
}
