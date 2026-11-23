/**
 * Large-unit formation slot, local-file reform, front saturation, wheeling, and
 * perimeter envelopment rules (ported from `Examples/combat_resolver_5.html`
 * I1–I5, C2, C3, C6, C10–C13, C17, C18, C20).
 *
 * Pure and deterministic: operates directly on `ModelPool` typed arrays and
 * quantized 1/16-ft world coordinates so local Strategic Mode (`TurnChannel`)
 * and the Hosted Strategic Room (`resolveFrozen` + `MarchReservation`) execute
 * identical formation behavior without a second rules implementation.
 */
import { ModelStatus, type ModelPool, type Vec2 } from "../../core/strategic";

const snap = (v: number): number => Math.round(v * 16) / 16;

export interface FormationBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const inBounds = (b: FormationBounds, x: number, y: number): boolean =>
  x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;

/** Normalize angle to `(-π, π]`. */
export function normalizeAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  return ((((rad + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

/**
 * `combat_resolver_5` I5: smoothly wheel `current` toward `target` by at most
 * `maxStep` radians per round so rear ranks do not teleport across the map.
 */
export function rotateToward(
  current: number,
  target: number,
  maxStep = 0.5,
): number {
  const diff = normalizeAngle(target - current);
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

/**
 * `combat_resolver_5` `slotPos`: world position of `(file, rank)` relative to
 * `anchor` and `facing` (`0` = `+x`, ranks trailing along `-cos(facing), -sin(facing)`).
 */
export function slotWorldPos(
  anchor: Vec2,
  file: number,
  rank: number,
  filesPerRank: number,
  spacing: number,
  facing = 0,
): Vec2 {
  const depth = -rank * spacing;
  const front = (file - (filesPerRank - 1) / 2) * spacing;
  const c = Math.cos(facing);
  const s = Math.sin(facing);
  return {
    x: snap(anchor.x + depth * c - front * s),
    y: snap(anchor.y + depth * s + front * c),
  };
}

export interface FilePromotion {
  modelIdx: number;
  file: number;
  currentRank: number;
  targetRank: number;
}

/**
 * `combat_resolver_5` I2 (`effectiveSlot`): local file gap-filling.
 *
 * Each living soldier keeps its original `file` and counts only casualties
 * ahead of it in that SAME file (`targetRank = 0, 1, ...` within `file`).
 * Soldiers never swap across files or collapse sideways.
 */
export function effectiveFilePromotions(
  pool: ModelPool,
  range: readonly [number, number],
  cellFeet = 5,
): FilePromotion[] {
  const living: number[] = [];
  for (let i = range[0]; i < range[1] && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) living.push(i);
  }
  if (living.length === 0) return [];

  const hasExplicitSlots = living.some(
    (i) => (pool.rank[i] ?? 0) !== 0 || (pool.file[i] ?? 0) !== 0,
  );

  const byFile = new Map<number, Array<{ idx: number; rank: number; id: number }>>();
  if (hasExplicitSlots) {
    for (const idx of living) {
      const file = pool.file[idx] ?? 0;
      const rank = pool.rank[idx] ?? 0;
      let col = byFile.get(file);
      if (!col) byFile.set(file, (col = []));
      col.push({ idx, rank, id: pool.id[idx] ?? idx });
    }
  } else {
    const facing = pool.rot[living[0] ?? 0] ?? 0;
    const c = Math.cos(facing);
    const s = Math.sin(facing);
    let maxFwd = -Infinity;
    let minLat = Infinity;
    const proj = living.map((idx) => {
      const x = pool.x[idx] ?? 0;
      const y = pool.y[idx] ?? 0;
      const fwd = x * c + y * s;
      const lat = -x * s + y * c;
      if (fwd > maxFwd) maxFwd = fwd;
      if (lat < minLat) minLat = lat;
      return { idx, fwd, lat };
    });
    for (const p of proj) {
      const file = Math.max(0, Math.round((p.lat - minLat) / cellFeet));
      const rank = Math.max(0, Math.round((maxFwd - p.fwd) / cellFeet));
      let col = byFile.get(file);
      if (!col) byFile.set(file, (col = []));
      col.push({ idx: p.idx, rank, id: pool.id[p.idx] ?? p.idx });
    }
  }

  const out: FilePromotion[] = [];
  const files = [...byFile.keys()].sort((a, b) => a - b);
  for (const file of files) {
    const col = byFile.get(file);
    if (!col) continue;
    col.sort((a, b) => a.rank - b.rank || a.id - b.id);
    for (let targetRank = 0; targetRank < col.length; targetRank++) {
      const entry = col[targetRank];
      if (!entry) continue;
      out.push({
        modelIdx: entry.idx,
        file,
        currentRank: entry.rank,
        targetRank,
      });
    }
  }
  return out;
}

/**
 * `combat_resolver_5` I3 (`unitFrontSaturation`): fraction of EFFECTIVE
 * front-rank (`targetRank === 0`) living soldiers currently within `reachFt`
 * of any living enemy model.
 */
export function unitFrontSaturation(
  pool: ModelPool,
  range: readonly [number, number],
  enemyModelIndices: readonly number[],
  reachFt: number,
  cellFeet = 5,
): number {
  if (enemyModelIndices.length === 0) return 0;
  const promotions = effectiveFilePromotions(pool, range, cellFeet);
  const reach2 = reachFt * reachFt;
  let frontCount = 0;
  let engagedCount = 0;
  for (const p of promotions) {
    if (p.targetRank !== 0) continue;
    frontCount++;
    const sx = pool.x[p.modelIdx] ?? 0;
    const sy = pool.y[p.modelIdx] ?? 0;
    for (const e of enemyModelIndices) {
      if (((pool.status[e] ?? 0) & ModelStatus.dead) !== 0) continue;
      const dx = (pool.x[e] ?? 0) - sx;
      const dy = (pool.y[e] ?? 0) - sy;
      if (dx * dx + dy * dy <= reach2) {
        engagedCount++;
        break;
      }
    }
  }
  return frontCount > 0 ? engagedCount / frontCount : 0;
}

export interface ReformOptions {
  pool: ModelPool;
  range: readonly [number, number];
  cellFeet: number;
  /** Per-model movement surplus available for closing vacated front slots (feet). */
  stepBudgetFeet: number;
  /** Optional explicit forward facing (radians); defaults to lead model rotation. */
  facing?: number;
  bounds?: FormationBounds;
  blockAt?: (fromX: number, fromY: number, toX: number, toY: number) => number | null;
  /**
   * Optional 5-ft grid reservation hook (used by hosted `MarchReservation`).
   * Returning `false` rejects moving `modelIdx` from `(fromX, fromY)` to `(toX, toY)`.
   */
  reserveMove?: (modelIdx: number, fromX: number, fromY: number, toX: number, toY: number) => boolean;
}

/**
 * `combat_resolver_5` C3 (`Reform front`): promote rear-rank survivors along
 * their own file into vacated front slots up to `stepBudgetFeet`.
 *
 * Processed in ascending `targetRank` order (`0, 1, 2, ...`) so when rank 1
 * advances into dead rank 0's cell, rank 1's vacated cell immediately opens
 * for rank 2 behind it in the same turn.
 */
export function applyFormationReform(opts: ReformOptions): {
  reformedModels: number;
  ranksClosed: number;
} {
  const { pool, range, cellFeet, stepBudgetFeet, bounds, blockAt, reserveMove } = opts;
  if (!(stepBudgetFeet > 0)) return { reformedModels: 0, ranksClosed: 0 };

  const promotions = effectiveFilePromotions(pool, range, cellFeet);
  const candidates = promotions
    .filter((p) => p.targetRank < p.currentRank)
    .sort((a, b) => a.targetRank - b.targetRank || a.file - b.file);
  if (candidates.length === 0) return { reformedModels: 0, ranksClosed: 0 };

  let firstLiving = -1;
  for (let i = range[0]; i < range[1] && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) {
      firstLiving = i;
      break;
    }
  }
  if (firstLiving < 0) return { reformedModels: 0, ranksClosed: 0 };

  const angle = opts.facing ?? (pool.rot[firstLiving] ?? 0);
  let fx = Math.cos(angle);
  let fy = Math.sin(angle);

  // Verify forward sign against any same-file front/rear pair when present so
  // formations deployed with reversed rank offsets still close toward rank 0.
  const frontByFile = new Map<number, FilePromotion>();
  for (const p of promotions) {
    const prev = frontByFile.get(p.file);
    if (!prev || p.currentRank < prev.currentRank) frontByFile.set(p.file, p);
  }
  for (const p of promotions) {
    const front = frontByFile.get(p.file);
    if (front && p.currentRank > front.currentRank) {
      const dx = (pool.x[front.modelIdx] ?? 0) - (pool.x[p.modelIdx] ?? 0);
      const dy = (pool.y[front.modelIdx] ?? 0) - (pool.y[p.modelIdx] ?? 0);
      const len = Math.hypot(dx, dy);
      if (len > 0.5) {
        fx = dx / len;
        fy = dy / len;
        break;
      }
    }
  }

  const maxSlots = Math.max(1, Math.floor((stepBudgetFeet + 1e-6) / cellFeet));
  let reformedModels = 0;
  let ranksClosed = 0;

  for (const c of candidates) {
    const gapSlots = c.currentRank - c.targetRank;
    const wantSlots = Math.min(gapSlots, maxSlots);
    if (wantSlots <= 0) continue;

    const fromX = pool.x[c.modelIdx] ?? 0;
    const fromY = pool.y[c.modelIdx] ?? 0;

    let chosenSlots = 0;
    let toX = fromX;
    let toY = fromY;

    for (let slots = wantSlots; slots >= 1; slots--) {
      const dist = Math.min(stepBudgetFeet, slots * cellFeet);
      const nx = snap(fromX + fx * dist);
      const ny = snap(fromY + fy * dist);
      if (bounds && !inBounds(bounds, nx, ny)) continue;
      if (blockAt && blockAt(fromX, fromY, nx, ny) !== null) continue;
      if (reserveMove && !reserveMove(c.modelIdx, fromX, fromY, nx, ny)) continue;
      chosenSlots = slots;
      toX = nx;
      toY = ny;
      break;
    }

    if (chosenSlots > 0) {
      pool.x[c.modelIdx] = toX;
      pool.y[c.modelIdx] = toY;
      pool.rank[c.modelIdx] = Math.max(0, c.currentRank - chosenSlots);
      reformedModels++;
      ranksClosed += chosenSlots;
    }
  }

  return { reformedModels, ranksClosed };
}

export interface PerimeterEnvelopInput {
  pool: ModelPool;
  attackerRange: readonly [number, number];
  defenderRange: readonly [number, number];
  attackerAnchor: Vec2;
  defenderAnchor: Vec2;
  reachFt: number;
  cellFeet: number;
  /**
   * Optional per-round movement budget (feet) capping how far any wrapping model
   * may step toward its flank/rear station in a single round (`combat_resolver_5` I1).
   */
  maxMoveFeet?: number;
  /** Quantize output coordinates to 1/16-ft codec grid when true. */
  quantize?: boolean;
  bounds?: FormationBounds;
  blockAt?: (fromX: number, fromY: number, toX: number, toY: number) => number | null;
  /**
   * Optional 5-ft grid occupancy gate. When supplied, stations that collide with
   * an occupied cell advance to the next perimeter station instead of stacking.
   */
  tryClaimStation?: (modelIdx: number, toX: number, toY: number) => boolean;
}

export interface PerimeterEnvelopResult {
  wrapped: number;
  distance: number;
}

/**
 * `combat_resolver_5` C2 / C6 / C10–C13 / C17 / C18:
 * Total War-style hinge-rotation flank wrap + rear-perimeter fold.
 *
 * - C6: gated on actual melee contact (`dMin <= reachFt + cellFeet`); approach
 *   marches hold full frontage.
 * - C13: excess files wrap strictly on their own side (`+1` / `-1`) and never
 *   cross the formation centreline.
 * - C17: anchored on the defender's outermost forward living corner model.
 * - C18: stations `0..flankCap` press down the defender's flank; deeper overhang
 *   from large 40–120-model companies folds around the rear corner along the
 *   defender's rear edge (and outer rear rings) to surround the target cleanly.
 */
export function applyPerimeterEnvelopment(
  input: PerimeterEnvelopInput,
): PerimeterEnvelopResult {
  const {
    pool,
    attackerRange,
    defenderRange,
    attackerAnchor,
    defenderAnchor,
    reachFt,
    cellFeet,
    maxMoveFeet,
    quantize = false,
    bounds,
    blockAt,
    tryClaimStation,
  } = input;

  const dirLen = Math.hypot(
    defenderAnchor.x - attackerAnchor.x,
    defenderAnchor.y - attackerAnchor.y,
  );
  if (dirLen === 0) return { wrapped: 0, distance: Infinity };

  const ux = (defenderAnchor.x - attackerAnchor.x) / dirLen;
  const uy = (defenderAnchor.y - attackerAnchor.y) / dirLen;
  const px = -uy;
  const py = ux;
  const latOf = (i: number): number =>
    (pool.x[i] ?? 0) * px + (pool.y[i] ?? 0) * py;
  const depthOf = (i: number): number =>
    (pool.x[i] ?? 0) * ux + (pool.y[i] ?? 0) * uy;

  const ownLiving: number[] = [];
  for (let i = attackerRange[0]; i < attackerRange[1] && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) ownLiving.push(i);
  }
  const foeLiving: number[] = [];
  for (let i = defenderRange[0]; i < defenderRange[1] && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) foeLiving.push(i);
  }
  if (ownLiving.length === 0 || foeLiving.length === 0) {
    return { wrapped: 0, distance: Infinity };
  }

  let engaged = false;
  let dMinPair2 = Infinity;
  const engageBandFt = reachFt + cellFeet;
  const engageBand2 = engageBandFt * engageBandFt;
  for (const a of ownLiving) {
    const ax = pool.x[a] ?? 0;
    const ay = pool.y[a] ?? 0;
    for (const b of foeLiving) {
      const dx = (pool.x[b] ?? 0) - ax;
      const dy = (pool.y[b] ?? 0) - ay;
      const d2 = dx * dx + dy * dy;
      if (d2 < dMinPair2) dMinPair2 = d2;
      if (d2 <= engageBand2) {
        engaged = true;
        break;
      }
    }
    if (engaged) break;
  }
  const dMinPair = Number.isFinite(dMinPair2) ? Math.sqrt(dMinPair2) : Infinity;
  if (!engaged) return { wrapped: 0, distance: dMinPair };

  let foeMin = Infinity;
  let foeMax = -Infinity;
  let foeMinDepth = Infinity;
  let foeMaxDepth = -Infinity;
  for (const b of foeLiving) {
    const l = latOf(b);
    const d = depthOf(b);
    if (l < foeMin) foeMin = l;
    if (l > foeMax) foeMax = l;
    if (d < foeMinDepth) foeMinDepth = d;
    if (d > foeMaxDepth) foeMaxDepth = d;
  }

  let ownMin = Infinity;
  let ownMax = -Infinity;
  for (const a of ownLiving) {
    const l = latOf(a);
    if (l < ownMin) ownMin = l;
    if (l > ownMax) ownMax = l;
  }
  if (!(ownMax - ownMin > foeMax - foeMin + cellFeet)) {
    return { wrapped: 0, distance: dMinPair };
  }

  // Flank leg accommodates at least 4 stations (preserving exact small-unit wrap
  // stations 0..3) and scales to the defender's full living depth before C18 folds
  // remaining excess around the rear corner.
  const foeDepthSteps = Math.max(
    3,
    Math.ceil(Math.max(0, foeMaxDepth - foeMinDepth) / cellFeet),
  );
  const foeHalfSpanSteps = Math.max(
    1,
    Math.ceil(((foeMax - foeMin) * 0.5 + reachFt) / cellFeet),
  );
  const fmt = quantize ? snap : (v: number) => v;

  let wrapped = 0;
  for (const side of [1, -1] as const) {
    let cornerIdx = -1;
    let cornerLat = -Infinity;
    let cornerDepth = Infinity;
    for (const b of foeLiving) {
      const l = latOf(b) * side;
      const depth = depthOf(b);
      if (l > cornerLat || (l === cornerLat && depth < cornerDepth)) {
        cornerLat = l;
        cornerDepth = depth;
        cornerIdx = b;
      }
    }
    if (cornerIdx < 0) continue;

    const foeEdge = side === 1 ? foeMax : foeMin;
    const excess = ownLiving
      .filter((a) => side * (latOf(a) - foeEdge) > cellFeet * 0.5)
      .sort((a, b) => side * (latOf(a) - latOf(b)) || a - b);
    if (excess.length === 0) continue;

    const cx = pool.x[cornerIdx] ?? 0;
    const cy = pool.y[cornerIdx] ?? 0;

    const stationCoords = (stationIdx: number): Vec2 => {
      if (stationIdx <= foeDepthSteps) {
        const down = stationIdx * cellFeet;
        return {
          x: fmt(cx + px * side * reachFt + ux * down),
          y: fmt(cy + py * side * reachFt + uy * down),
        };
      }
      // C18 rear-perimeter fold: turn inward behind the defender's rear rank,
      // stacking into outer rear rings once the rear half-width is filled.
      const rearOrdinal = stationIdx - foeDepthSteps - 1;
      const ring = Math.floor(rearOrdinal / foeHalfSpanSteps);
      const stepInward = (rearOrdinal % foeHalfSpanSteps) * cellFeet;
      const rearDown = (foeDepthSteps + 1 + ring) * cellFeet;
      const lateralOut = reachFt - stepInward;
      return {
        x: fmt(cx + px * side * lateralOut + ux * rearDown),
        y: fmt(cy + py * side * lateralOut + uy * rearDown),
      };
    };

    let nextStation = 0;
    const maxSearchStations = excess.length + 32;
    for (const m of excess) {
      const fromX = pool.x[m] ?? 0;
      const fromY = pool.y[m] ?? 0;
      while (nextStation < maxSearchStations) {
        const station = stationCoords(nextStation++);
        if (bounds && !inBounds(bounds, station.x, station.y)) continue;
        const dx = station.x - fromX;
        const dy = station.y - fromY;
        const dist = Math.hypot(dx, dy);
        if (dist <= 1e-4) break;
        const stepRatio =
          maxMoveFeet !== undefined && maxMoveFeet > 0 && dist > maxMoveFeet
            ? maxMoveFeet / dist
            : 1;
        const targetX = stepRatio < 1 ? fmt(fromX + dx * stepRatio) : station.x;
        const targetY = stepRatio < 1 ? fmt(fromY + dy * stepRatio) : station.y;
        if (bounds && !inBounds(bounds, targetX, targetY)) continue;
        if (blockAt && blockAt(fromX, fromY, targetX, targetY) !== null) {
          continue;
        }
        if (tryClaimStation && !tryClaimStation(m, targetX, targetY)) {
          continue;
        }
        pool.x[m] = targetX;
        pool.y[m] = targetY;
        pool.rot[m] = rotateToward(pool.rot[m] ?? 0, Math.atan2(dy, dx), 0.75);
        wrapped++;
        break;
      }
    }
  }

  return {
    wrapped,
    distance: Math.round(dMinPair * 100) / 100,
  };
}
