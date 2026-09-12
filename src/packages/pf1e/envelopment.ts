/**
 * Strategic flanking — the mass battle's FLANKED bit, decided by AoN 183.
 *
 * The old module was an invented rule: "≥2 attackers in contact ⇒ flanked"
 * (Gap List §5 calls it out; R03/D-130 rejected the +4/flat-footed house rule it
 * came from). It is replaced here by the same rule the tactical scale uses —
 * `flanking.ts`'s `resolveFlanking`, AoN 183's centre-to-centre line test with
 * the threatening-ally requirement and the 0-ft-reach exclusion — applied to
 * the strategic layer's own geometry:
 *
 *   model position (feet) → `geometry.cellAt` with the **scene's** cell feet
 *   (P01) → one occupied square per model → `threatenedCells` per unit reach
 *   (Table 8-4, from the unit's bound leader actor, D-180) → `resolveFlanking`.
 *
 * A single pass per turn replaces the per-engagement heuristic: every living
 * model's FLANKED bit is cleared and recomputed from the current layout (M04's
 * "clear/recompute stale FLANKED bits each turn"), so the bit can no longer
 * linger, and a defender flanked by attackers from two different units is
 * flanked regardless of which engagement resolves first.
 *
 * **The prerequisite this landed with (P01):** the line test only means what
 * the rule says when models are one per square. `deploy.ts` used to space
 * formations 4 ft apart while the sim hashed on 5-ft cells, so several models
 * shared a square and a "flanker" could sit inside the space it flanks — the
 * degenerate collinear case `flanking.ts` documents. Deployment now rides the
 * scene's grid distance (one model per square) and the sim's spatial hash is
 * built at that same scale, which is what the Gap List §5 named as the
 * prerequisite for wiring this rule in.
 *
 * Enemy relation: two models are enemies when their units belong to different
 * factions — the strategic layer's own model of hostility. A caller with a
 * different relation (allies inside one faction, scripted truces) passes
 * `isEnemy`, exactly as the tactical seam takes it from its scene.
 *
 * Cost: one spatial query per living model plus an O(k²) pair test over the
 * models that actually threaten it (k is a handful — a creature's threat set is
 * its own square's neighbourhood), and each threat set is computed once per
 * pass. Positions are read, never written: only status bits change.
 */
import type { ModelPool } from "../../core/strategic";
import { ModelStatus } from "../../core/strategic";
import type { SpatialGrid } from "../../core/spatialGrid";
import type { PF1eCell } from "./targeting";
import { canFlank, resolveFlanking, type PF1eFlankingParticipant } from "./flanking";
import { cellAt, threatenedCells } from "./geometry";

/**
 * `1 << 2` deliberately: the PF1e module borrows core's `ModelStatus.pinned`
 * slot for FLANKED. That collision is the documented §2.13 bit-allocation debt
 * (M03 owns the separate column); this module does not silently allocate a new
 * one, and it clears only this bit.
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

/** A model that can threaten, with its threat set computed once. */
interface Threatening {
  index: number;
  unitIdx: number;
  cells: PF1eCell[];
  threatened: PF1eCell[];
  participant: PF1eFlankingParticipant;
}

/**
 * Clear and recompute every living model's FLANKED bit from the current layout.
 * Dead models never flank and are never flanked (their bit is cleared too, so a
 * model killed while flanked cannot report a stale state).
 */
export function markPF1eFlanking(opts: PF1eFlankingPassOptions): PF1eFlankingPassResult {
  const { pool, grid, cellFeet } = opts;
  const isEnemy =
    opts.isEnemy ??
    ((a: number, b: number) =>
      (opts.factionByUnitIdx[a] ?? null) !== (opts.factionByUnitIdx[b] ?? null));
  const reachOf = (unitIdx: number): number => {
    const reach = opts.reachSquaresByUnitIdx[unitIdx] ?? 1;
    return Number.isFinite(reach) && reach > 0 ? Math.floor(reach) : 0;
  };

  // The largest threat radius on the field, in feet: one query per model finds
  // every candidate that could possibly threaten it, whichever unit it is from.
  //
  // The radius is measured in *squares* by the rules, and AoN 102's threatened
  // squares include the diagonals — so the Euclidean bound has to cover a
  // diagonal stride of `reach`, i.e. `reach × √2` cells. (A 1-square reach
  // threatens the four diagonal neighbours at 7.07 ft, half again the 5 ft a
  // bounds-equal-to-reach query would return; that is how the first version of
  // this pass missed every corner flank.) `Math.ceil` keeps the bound integral
  // and generous; the exact test is still the threatened set, not the query.
  let widestReachSquares = 0;
  for (const reach of opts.reachSquaresByUnitIdx) {
    if (Number.isFinite(reach) && reach > widestReachSquares) {
      widestReachSquares = Math.floor(reach);
    }
  }
  const queryFeet = Math.ceil(widestReachSquares * Math.SQRT2) * cellFeet;

  const living = (index: number): boolean =>
    ((pool.status[index] ?? 0) & ModelStatus.dead) === 0;

  const threatCache = new Map<number, Threatening | null>();
  const threatening = (index: number): Threatening | null => {
    const cached = threatCache.get(index);
    if (cached !== undefined) return cached;
    const unitIdx = pool.unitIdx[index] ?? 0;
    const reachSquares = reachOf(unitIdx);
    let entry: Threatening | null = null;
    if (living(index) && reachSquares > 0) {
      // `?? null` keeps `exactOptionalPropertyTypes` happy: an absent table row and an
      // authored "no size" both mean "no exclusion to apply" to `canFlank`.
      const size = opts.sizeByUnitIdx?.[unitIdx] ?? null;
      if (canFlank({ reachSquares, size })) {
        const cells = [cellAt(pool.x[index] ?? 0, pool.y[index] ?? 0, cellFeet)];
        const threatened = threatenedCells({ footprint: cells, reachSquares });
        entry = {
          index,
          unitIdx,
          cells,
          threatened,
          participant: {
            id: String(pool.id[index] ?? index),
            cells,
            reachSquares,
            size,
            threatened,
          },
        };
      }
    }
    threatCache.set(index, entry);
    return entry;
  };

  const flankedDefenders: number[] = [];
  const pairs: PF1eFlankingPair[] = [];

  for (let d = 0; d < pool.count; d++) {
    const status = pool.status[d] ?? 0;
    if ((status & PF1E_STATUS_FLANKED) !== 0) pool.status[d] = status & ~PF1E_STATUS_FLANKED;
    if (!living(d)) continue;
    const defenderUnitIdx = pool.unitIdx[d] ?? 0;
    const defenderCell = cellAt(pool.x[d] ?? 0, pool.y[d] ?? 0, cellFeet);
    const defenderKey = `${defenderCell.col},${defenderCell.row}`;

    // Candidates: living enemies whose threatened set covers the defender's square.
    const candidates: Threatening[] = [];
    for (const hit of grid.queryPoint(pool.x[d] ?? 0, pool.y[d] ?? 0, queryFeet, pool)) {
      const a = hit.index;
      if (a === d || !living(a)) continue;
      if (!isEnemy(pool.unitIdx[a] ?? 0, defenderUnitIdx)) continue;
      const attacker = threatening(a);
      if (attacker === null) continue;
      if (!attacker.threatened.some((c) => `${c.col},${c.row}` === defenderKey)) continue;
      candidates.push(attacker);
    }
    if (candidates.length < 2) continue;

    // AoN 183's pair test, through the shared rule — never a second copy of it.
    let decided: PF1eFlankingPair | null = null;
    for (let i = 0; i < candidates.length && decided === null; i++) {
      const attacker = candidates[i];
      if (attacker === undefined) continue;
      const allies = candidates.filter((_, j) => j !== i).map((c) => c.participant);
      const result = resolveFlanking({
        defender: { id: String(d), cells: [defenderCell] },
        attacker: attacker.participant,
        allies,
      });
      if (!result.flanked) continue;
      const flankerId = result.flankerIds[0];
      const partner = candidates.find((c) => c.participant.id === flankerId);
      if (partner === undefined) continue;
      decided = { defender: d, flankers: [attacker.index, partner.index] };
    }
    if (decided === null) continue;

    flankedDefenders.push(d);
    pairs.push(decided);
    pool.status[d] = (pool.status[d] ?? 0) | PF1E_STATUS_FLANKED;
  }

  return { flankedDefenders, pairs };
}
