import type { RulesWallsContext, UnitView } from "../../core/rules";
import { ModelStatus, type ModelPool } from "../../core/strategic";
import { hasLineOfEffect } from "../../core/detection";
import { resolveTargetAc } from "./combatEngine";
import type { PF1eProfileRegistry, PF1eUnitProfile } from "./schema";
import { ModelCellHash } from "./spatialIndex";
import { cellsAlongSegment } from "./geometry";

export interface SpatialMeleePrepInput {
  pool: ModelPool;
  cellHash: ModelCellHash;
  attackerUnit: UnitView;
  attackerUnitIdx: number;
  attackers: readonly number[];
  defenders: readonly number[];
  reachFt: number;
  minReachFt: number;
  cellFeet: number;
  speedFeet: number;
  movedThisTurn: boolean;
  walls: RulesWallsContext;
  stepModel5Ft?: (pool: ModelPool, idx: number, toX: number, toY: number) => boolean;
  blockAt?: (fx: number, fy: number, tx: number, ty: number) => number | null;
}

export interface StrideProvocation {
  modelIdx: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface SpatialMeleePrepResult {
  /** Per-attacker iterative cap (`1` for striding models, `undefined` for in-reach / 5-ft step). */
  capByModel: Map<number, number>;
  /** Strides that moved >5 ft and provoke movement AoOs before swings resolve. */
  strides: StrideProvocation[];
  /** Number of 5-ft steps taken. */
  stepped5Ft: number;
  /** Models relocated by a 5-ft step or melee stride (`modelIdx`, `oldX`, `oldY`, `newX`, `newY`). */
  relocated: Array<{
    modelIdx: number;
    oldX: number;
    oldY: number;
    newX: number;
    newY: number;
  }>;
  /** Per-swing target selector picking a living foe within reach (rotating across swings). */
  pickTarget: (atkIdx: number, swingIdx: number) => number;
}

const STEP_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

function chebyshevDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

function inReachBand(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  minReachFt: number,
  reachFt: number,
): boolean {
  const d = chebyshevDist(ax, ay, bx, by);
  return d <= reachFt + 1e-3 && (minReachFt <= 0 || d > minReachFt + 1e-3);
}

/**
 * `combat_resolver_5` C1/C19 per-model melee engagement planner:
 * - Models already in reach keep their full iterative routine.
 * - Unengaged models within 1 step of a foe take a free 5-ft step (no AoO) and full-attack.
 * - Unengaged models within `speedFeet` (`!movedThisTurn`) stride into reach, provoking movement AoOs,
 *   and are capped to a single standard melee attack (`maxIterativeAttacks: 1`).
 * - Blocked / out-of-reach models make 0 attacks.
 */
export function prepareSpatialMelee(input: SpatialMeleePrepInput): SpatialMeleePrepResult {
  const {
    pool,
    cellHash,
    attackers,
    defenders,
    reachFt,
    minReachFt,
    cellFeet,
    speedFeet,
    movedThisTurn,
    walls,
    stepModel5Ft,
    blockAt,
  } = input;

  const capByModel = new Map<number, number>();
  const strides: StrideProvocation[] = [];
  const relocated: Array<{ modelIdx: number; oldX: number; oldY: number; newX: number; newY: number }> = [];
  let stepped5Ft = 0;

  if (defenders.length === 0 || attackers.length === 0) {
    return {
      capByModel,
      strides,
      relocated,
      stepped5Ft: 0,
      pickTarget: () => -1,
    };
  }

  const defUnitSet = new Set<number>();
  for (const d of defenders) {
    defUnitSet.add(pool.unitIdx[d] ?? -1);
  }
  const reachCells = Math.max(1, Math.ceil(reachFt / cellFeet));
  const invCell = 1 / cellFeet;
  const claimedExtra = new Set<number>();
  const packClaim = (c: number, r: number): number => (c + 524288) * 1048576 + (r + 524288);

  const cellFree = (c: number, r: number, ignoreIdx: number): boolean => {
    const pk = packClaim(c, r);
    if (claimedExtra.has(pk)) return false;
    return !cellHash.hasLivingAt(pool, c, r, ignoreIdx);
  };

  const findTargetsAt = (ax: number, ay: number, out: number[]): void => {
    out.length = 0;
    const ac = Math.floor(ax * invCell);
    const ar = Math.floor(ay * invCell);
    cellHash.forEachInRect(
      pool,
      ac - reachCells - 1,
      ac + reachCells + 1,
      ar - reachCells - 1,
      ar + reachCells + 1,
      (mIdx) => {
        if (!defUnitSet.has(pool.unitIdx[mIdx] ?? -2)) return;
        const dx = pool.x[mIdx] ?? 0;
        const dy = pool.y[mIdx] ?? 0;
        if (
          inReachBand(ax, ay, dx, dy, minReachFt, reachFt) &&
          hasLineOfEffect(ax, ay, dx, dy, walls)
        ) {
          out.push(mIdx);
        }
      },
    );
  };

  const probeBuf: number[] = [];

  if (!movedThisTurn) {
    for (const atkIdx of attackers) {
      if (((pool.status[atkIdx] ?? 0) & ModelStatus.dead) !== 0) continue;
      const ax = pool.x[atkIdx] ?? 0;
      const ay = pool.y[atkIdx] ?? 0;
      findTargetsAt(ax, ay, probeBuf);
      if (probeBuf.length > 0) continue; // Already in melee reach -> full iterative routine

      const startCol = Math.floor(ax * invCell);
      const startRow = Math.floor(ay * invCell);
      const subX = ax - startCol * cellFeet;
      const subY = ay - startRow * cellFeet;

      // 1) Try a free 5-ft step into an adjacent unoccupied square that puts a defender in reach
      let bestStepX = 0;
      let bestStepY = 0;
      let bestStepFound = false;
      let bestStepDist2 = Infinity;

      for (const [dc, dr] of STEP_DIRS) {
        const nc = startCol + dc;
        const nr = startRow + dr;
        if (!cellFree(nc, nr, atkIdx)) continue;
        const nx = nc * cellFeet + subX;
        const ny = nr * cellFeet + subY;
        if (blockAt && blockAt(ax, ay, nx, ny) !== null) continue;
        if (!hasLineOfEffect(ax, ay, nx, ny, walls)) continue;
        findTargetsAt(nx, ny, probeBuf);
        if (probeBuf.length === 0) continue;
        const t0 = probeBuf[0] ?? 0;
        const d2 = ((pool.x[t0] ?? 0) - nx) ** 2 + ((pool.y[t0] ?? 0) - ny) ** 2;
        if (d2 < bestStepDist2) {
          bestStepDist2 = d2;
          bestStepX = nx;
          bestStepY = ny;
          bestStepFound = true;
        }
      }

      if (bestStepFound) {
        if (!stepModel5Ft || stepModel5Ft(pool, atkIdx, bestStepX, bestStepY)) {
          const newCol = Math.floor(bestStepX * invCell);
          const newRow = Math.floor(bestStepY * invCell);
          relocated.push({ modelIdx: atkIdx, oldX: ax, oldY: ay, newX: bestStepX, newY: bestStepY });
          pool.x[atkIdx] = bestStepX;
          pool.y[atkIdx] = bestStepY;
          cellHash.moveModel(atkIdx, startCol, startRow, newCol, newRow);
          claimedExtra.add(packClaim(newCol, newRow));
          stepped5Ft++;
          continue;
        }
      }

      // 2) Try a move action (`speedFeet`) into an open cell adjacent/in-reach of nearest defender
      if (speedFeet <= cellFeet) {
        capByModel.set(atkIdx, 0);
        continue;
      }
      let nearestDef = -1;
      let nearestDist2 = Infinity;
      const maxSearchFt = speedFeet + reachFt + cellFeet;
      const maxSearch2 = maxSearchFt * maxSearchFt;
      for (const dIdx of defenders) {
        if (((pool.status[dIdx] ?? 0) & ModelStatus.dead) !== 0) continue;
        const dx = (pool.x[dIdx] ?? 0) - ax;
        const dy = (pool.y[dIdx] ?? 0) - ay;
        const d2 = dx * dx + dy * dy;
        if (d2 <= maxSearch2 && d2 < nearestDist2) {
          nearestDist2 = d2;
          nearestDef = dIdx;
        }
      }
      if (nearestDef < 0) {
        capByModel.set(atkIdx, 0);
        continue;
      }

      const tx = pool.x[nearestDef] ?? 0;
      const ty = pool.y[nearestDef] ?? 0;
      const tc = Math.floor(tx * invCell);
      const tr = Math.floor(ty * invCell);
      let strideX = 0;
      let strideY = 0;
      let strideFound = false;
      let bestWalk2 = Infinity;

      for (let dr = -reachCells; dr <= reachCells; dr++) {
        for (let dc = -reachCells; dc <= reachCells; dc++) {
          if (dc === 0 && dr === 0) continue;
          const nc = tc + dc;
          const nr = tr + dr;
          if (!cellFree(nc, nr, atkIdx)) continue;
          const nx = (nc + 0.5) * cellFeet;
          const ny = (nr + 0.5) * cellFeet;
          if (!inReachBand(nx, ny, tx, ty, minReachFt, reachFt)) continue;
          const walkDist = Math.hypot(nx - ax, ny - ay);
          if (walkDist > speedFeet + 1e-3) continue;
          if (blockAt && blockAt(ax, ay, nx, ny) !== null) continue;
          if (!hasLineOfEffect(ax, ay, nx, ny, walls)) continue;
          const w2 = (nx - ax) ** 2 + (ny - ay) ** 2;
          if (w2 < bestWalk2) {
            bestWalk2 = w2;
            strideX = nx;
            strideY = ny;
            strideFound = true;
          }
        }
      }

      if (strideFound && (!stepModel5Ft || stepModel5Ft(pool, atkIdx, strideX, strideY))) {
        strides.push({ modelIdx: atkIdx, from: { x: ax, y: ay }, to: { x: strideX, y: strideY } });
        pool.x[atkIdx] = strideX;
        pool.y[atkIdx] = strideY;
        claimedExtra.add(
          packClaim(Math.floor(strideX * invCell), Math.floor(strideY * invCell)),
        );
        capByModel.set(atkIdx, 1); // Move + Standard Attack = 1 swing
      } else {
        capByModel.set(atkIdx, 0);
      }
    }
  }

  // Pre-build per-attacker target lists on the settled melee positions so iterative swings
  // distribute cleanly across adjacent living defenders.
  const targetsByAtk = new Map<number, number[]>();
  const rotCursor = new Map<number, number>();
  for (const atkIdx of attackers) {
    if (((pool.status[atkIdx] ?? 0) & ModelStatus.dead) !== 0) continue;
    if (capByModel.get(atkIdx) === 0) continue;
    const list: number[] = [];
    findTargetsAt(pool.x[atkIdx] ?? 0, pool.y[atkIdx] ?? 0, list);
    if (list.length > 0) {
      // Sort nearest-first, breaking ties by model index for determinism
      const ax = pool.x[atkIdx] ?? 0;
      const ay = pool.y[atkIdx] ?? 0;
      list.sort((a, b) => {
        const da = ((pool.x[a] ?? 0) - ax) ** 2 + ((pool.y[a] ?? 0) - ay) ** 2;
        const db = ((pool.x[b] ?? 0) - ax) ** 2 + ((pool.y[b] ?? 0) - ay) ** 2;
        return da - db || a - b;
      });
      targetsByAtk.set(atkIdx, list);
    }
  }

  return {
    capByModel,
    strides,
    relocated,
    stepped5Ft,
    pickTarget: (atkIdx: number): number => {
      const list = targetsByAtk.get(atkIdx);
      if (!list || list.length === 0) return -1;
      const startCur = rotCursor.get(atkIdx) ?? 0;
      for (let k = 0; k < list.length; k++) {
        const idx = list[(startCur + k) % list.length] ?? -1;
        if (idx >= 0 && ((pool.status[idx] ?? 0) & ModelStatus.dead) === 0) {
          rotCursor.set(atkIdx, (startCur + k + 1) % list.length);
          return idx;
        }
      }
      return -1;
    },
  };
}

export interface SpatialVolleyInput {
  pool: ModelPool;
  cellHash: ModelCellHash;
  registry: PF1eProfileRegistry;
  shooterUnit: UnitView;
  shooterUnitIdx: number;
  shooterProfile: PF1eUnitProfile;
  attackers: readonly number[];
  defenders: readonly number[];
  factionByUnitIdx: readonly (string | null | undefined)[];
  reachFeetByUnitIdx: readonly number[];
  cellFeet: number;
  preciseShot: boolean;
  holdFire1st: boolean;
  walls: RulesWallsContext;
}

export interface SpatialVolleyPlan {
  pickTarget: (atkIdx: number, swingIdx: number) => number;
  extraAttackMod: (atkIdx: number, targetIdx: number) => number;
  extraTargetAc: (atkIdx: number, targetIdx: number) => number;
}

/**
 * `combat_resolver_5` G2b / R3 / T2fix ranged volley planner:
 * - Distributes shooters across living foes within max range (or 1st increment when `holdFire1st`),
 *   scoring by hit probability + claim saturation so the entire volley does not overkill `defenders[0]`.
 * - Evaluates PF1e firing into melee (`-4` unless `preciseShot`) when a friendly/other model engages
 *   the target in melee (`e !== target && e !== shooter`).
 * - Evaluates PF1e soft cover (`+4 AC`) along the shot segment, ignoring the shooter's own unit's
 *   first 4 intervening ranks (`combat_resolver_5` `softCoverAC`).
 */
export function prepareSpatialVolley(input: SpatialVolleyInput): SpatialVolleyPlan {
  const {
    pool,
    cellHash,
    registry,
    shooterUnitIdx,
    shooterProfile,
    attackers,
    defenders,
    factionByUnitIdx,
    reachFeetByUnitIdx,
    cellFeet,
    preciseShot,
    holdFire1st,
    walls,
  } = input;

  const inc = shooterProfile.rangeIncrement > 0 ? shooterProfile.rangeIncrement : 60;
  const rawMaxInc = shooterProfile.maxIncrements > 0 ? shooterProfile.maxIncrements : 10;
  const maxInc = holdFire1st ? 1 : rawMaxInc;
  const maxRangeFt = inc * maxInc;
  const maxRange2 = maxRangeFt * maxRangeFt;
  const invCell = 1 / cellFeet;

  // Precompute which defenders are currently engaged in melee with any living foe of theirs
  // (excluding the shooter itself at shot time) for T2fix `-4` firing-into-melee.
  let widestReachCells = 1;
  for (const rFt of reachFeetByUnitIdx) {
    const rc = Math.ceil(rFt / cellFeet);
    if (rc > widestReachCells) widestReachCells = rc;
  }

  const engagedByByTarget = new Map<number, number[]>();
  const liveDefenders: number[] = [];
  for (const dIdx of defenders) {
    if (((pool.status[dIdx] ?? 0) & ModelStatus.dead) !== 0) continue;
    liveDefenders.push(dIdx);
    const dUnit = pool.unitIdx[dIdx] ?? 0;
    const dFac = factionByUnitIdx[dUnit] ?? null;
    const dx = pool.x[dIdx] ?? 0;
    const dy = pool.y[dIdx] ?? 0;
    const dc = Math.floor(dx * invCell);
    const dr = Math.floor(dy * invCell);
    const engagers: number[] = [];
    cellHash.forEachInRect(
      pool,
      dc - widestReachCells,
      dc + widestReachCells,
      dr - widestReachCells,
      dr + widestReachCells,
      (eIdx) => {
        if (eIdx === dIdx) return;
        const eUnit = pool.unitIdx[eIdx] ?? 0;
        if ((factionByUnitIdx[eUnit] ?? null) === dFac) return;
        const eReach = reachFeetByUnitIdx[eUnit] ?? cellFeet;
        if (chebyshevDist(dx, dy, pool.x[eIdx] ?? 0, pool.y[eIdx] ?? 0) <= eReach + 1e-3) {
          engagers.push(eIdx);
        }
      },
    );
    if (engagers.length > 0) engagedByByTarget.set(dIdx, engagers);
  }

  const isIntoMelee = (atkIdx: number, targetIdx: number): boolean => {
    if (preciseShot) return false;
    const eng = engagedByByTarget.get(targetIdx);
    if (!eng) return false;
    for (const eIdx of eng) {
      if (eIdx !== atkIdx && ((pool.status[eIdx] ?? 0) & ModelStatus.dead) === 0) {
        return true;
      }
    }
    return false;
  };

  const softCoverCache = new Map<number, number>();
  const softCoverBonus = (atkIdx: number, targetIdx: number): number => {
    const cacheKey = atkIdx * 65536 + targetIdx;
    const cached = softCoverCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const ax = pool.x[atkIdx] ?? 0;
    const ay = pool.y[atkIdx] ?? 0;
    const tx = pool.x[targetIdx] ?? 0;
    const ty = pool.y[targetIdx] ?? 0;
    const ac = Math.floor(ax * invCell);
    const ar = Math.floor(ay * invCell);
    const tc = Math.floor(tx * invCell);
    const tr = Math.floor(ty * invCell);

    let bonus = 0;
    if (Math.abs(tc - ac) > 1 || Math.abs(tr - ar) > 1) {
      const cells = cellsAlongSegment({ x: ax, y: ay }, { x: tx, y: ty }, cellFeet);
      let ownBlockers = 0;
      for (let i = 1; i < cells.length - 1 && bonus === 0; i++) {
        const c = cells[i];
        if (!c) continue;
        if ((c.col === ac && c.row === ar) || (c.col === tc && c.row === tr)) continue;
        let cur = cellHash.headAt(c.col, c.row);
        while (cur >= 0) {
          if (
            cur !== atkIdx &&
            cur !== targetIdx &&
            ((pool.status[cur] ?? 0) & ModelStatus.dead) === 0
          ) {
            if ((pool.unitIdx[cur] ?? -1) === shooterUnitIdx) {
              ownBlockers++;
              if (ownBlockers > 4) {
                bonus = 4;
                break;
              }
            } else {
              bonus = 4;
              break;
            }
          }
          cur = cellHash.nextAfter(cur);
        }
      }
    }

    softCoverCache.set(cacheKey, bonus);
    return bonus;
  };

  // Assign each shooter a ranked target queue (`volleyPlanner` G2b)
  const claims = new Int32Array(pool.count);
  const avgDmg = Math.max(
    1,
    shooterProfile.damageDiceCount * ((shooterProfile.damageDiceSides + 1) * 0.5) +
      shooterProfile.damageMod +
      shooterProfile.enhancementBonus,
  );
  const baseAb = (shooterProfile.iteratives[0] ?? 0) + shooterProfile.enhancementBonus;

  // Sample candidate pool (cap per-shooter scan to 64 evenly-strided defenders for O(M) 50k scaling)
  const stride = liveDefenders.length > 64 ? Math.ceil(liveDefenders.length / 64) : 1;
  const assignedByAtk = new Map<number, number[]>();
  const cursorByAtk = new Map<number, number>();

  for (let sPos = 0; sPos < attackers.length; sPos++) {
    const atkIdx = attackers[sPos] ?? -1;
    if (atkIdx < 0 || ((pool.status[atkIdx] ?? 0) & ModelStatus.dead) !== 0) continue;
    const ax = pool.x[atkIdx] ?? 0;
    const ay = pool.y[atkIdx] ?? 0;

    let bestTarget = -1;
    let bestScore = -1e9;
    let secondTarget = -1;
    let secondScore = -1e9;
    const offset = stride > 1 ? sPos % stride : 0;

    for (let di = offset; di < liveDefenders.length; di += stride) {
      const dIdx = liveDefenders[di] ?? -1;
      if (dIdx < 0) continue;
      const dx = (pool.x[dIdx] ?? 0) - ax;
      const dy = (pool.y[dIdx] ?? 0) - ay;
      const d2 = dx * dx + dy * dy;
      if (d2 > maxRange2) continue;
      if (!hasLineOfEffect(ax, ay, pool.x[dIdx] ?? 0, pool.y[dIdx] ?? 0, walls)) continue;

      const dist = Math.sqrt(d2);
      const increments = dist > 0 ? Math.ceil(dist / inc) : 1;
      if (increments > maxInc) continue;

      const rangePen = Math.max(0, increments - 1) * 2;
      const meleePen = isIntoMelee(atkIdx, dIdx) ? 4 : 0;
      const coverAc = softCoverBonus(atkIdx, dIdx);
      const defProf = registry.get(pool.sys.profileIdx?.[dIdx] ?? 0);
      const acType =
        shooterProfile.isFirearm && increments <= (shooterProfile.isEarlyFirearm ? 1 : 5)
          ? "touchAc"
          : "ac";
      const targetAc = resolveTargetAc(pool, defProf, dIdx, acType) + coverAc;
      const hitChance = Math.max(
        0.05,
        Math.min(0.95, (21 - (targetAc - (baseAb - rangePen - meleePen))) / 20),
      );
      const hp = Math.max(1, pool.hp[dIdx] ?? 10);
      const expectedClaimedDmg = (claims[dIdx] ?? 0) * avgDmg * hitChance;
      const overkillPenalty = expectedClaimedDmg >= hp ? 2.0 + (claims[dIdx] ?? 0) * 0.25 : 0;
      const score = hitChance - dist * 0.0002 - (claims[dIdx] ?? 0) * 0.08 - overkillPenalty;

      if (score > bestScore) {
        secondScore = bestScore;
        secondTarget = bestTarget;
        bestScore = score;
        bestTarget = dIdx;
      } else if (score > secondScore) {
        secondScore = score;
        secondTarget = dIdx;
      }
    }

    if (bestTarget >= 0) {
      claims[bestTarget] = (claims[bestTarget] ?? 0) + 1;
      const q = secondTarget >= 0 ? [bestTarget, secondTarget] : [bestTarget];
      assignedByAtk.set(atkIdx, q);
    }
  }

  return {
    pickTarget: (atkIdx: number): number => {
      const q = assignedByAtk.get(atkIdx);
      if (q) {
        const cur = cursorByAtk.get(atkIdx) ?? 0;
        for (let k = 0; k < q.length; k++) {
          const cand = q[(cur + k) % q.length] ?? -1;
          if (cand >= 0 && ((pool.status[cand] ?? 0) & ModelStatus.dead) === 0) {
            cursorByAtk.set(atkIdx, (cur + k) % q.length);
            return cand;
          }
        }
      }
      // Fallback: pick nearest living defender in range with LoE
      const ax = pool.x[atkIdx] ?? 0;
      const ay = pool.y[atkIdx] ?? 0;
      let fallback = -1;
      let fallbackD2 = Infinity;
      for (let i = 0; i < liveDefenders.length; i += stride) {
        const dIdx = liveDefenders[i] ?? -1;
        if (dIdx < 0 || ((pool.status[dIdx] ?? 0) & ModelStatus.dead) !== 0) continue;
        const dx = (pool.x[dIdx] ?? 0) - ax;
        const dy = (pool.y[dIdx] ?? 0) - ay;
        const d2 = dx * dx + dy * dy;
        if (
          d2 <= maxRange2 &&
          d2 < fallbackD2 &&
          hasLineOfEffect(ax, ay, pool.x[dIdx] ?? 0, pool.y[dIdx] ?? 0, walls)
        ) {
          fallbackD2 = d2;
          fallback = dIdx;
        }
      }
      return fallback;
    },
    extraAttackMod: (atkIdx: number, targetIdx: number): number =>
      isIntoMelee(atkIdx, targetIdx) ? -4 : 0,
    extraTargetAc: (atkIdx: number, targetIdx: number): number =>
      softCoverBonus(atkIdx, targetIdx),
  };
}
