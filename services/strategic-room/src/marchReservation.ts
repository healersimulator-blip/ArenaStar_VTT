import { SIM_POS_QUANTUM } from "../../../src/core/sim";
import { ModelStatus, type ModelPool } from "../../../src/core/strategic";
import type { UnitView } from "../../../src/core/rules";
import type { Bounds, Point } from "../../../src/core/strategicRoom/protocol";
import {
  pointInSpellHazard,
  routeAroundSpellHazards,
  spellHazardActive,
  type SpellHazard,
} from "../../../src/core/strategicRoom/hazardAvoidance";
import {
  applyFormationReform,
  applyPerimeterEnvelopment,
  type PerimeterEnvelopResult,
} from "../../../src/packages/pf1e/formationSlots";
import {
  planUnitModelMoves,
  type ExecuteFormationMoveInput,
  type ExecutedFormationMove,
  type Vec2,
} from "../../../src/packages/pf1e/formationMovement";
import {
  applyUnitConditionsToStride,
  planPF1eStride,
  type PF1eStrideInput,
} from "../../../src/packages/pf1e/stride";
import { CELL_FEET, inBounds } from "../../../src/core/strategicRoom/scenario";

const cell = (v: number) => Math.floor(v / CELL_FEET);
const snap = (v: number) => Math.round(v * SIM_POS_QUANTUM) / SIM_POS_QUANTUM;

/**
 * One ledger per frozen turn. Reserves swept cells and settled squares in canonical
 * roster order (never packet order).
 *
 * Under the two-tier `combat_resolver_5` formation movement architecture:
 * - A soldier may step through squares initially held or swept by **friendly models of its
 *   own unit** (`held === owner`), letting rear ranks close up and wheel smoothly behind
 *   front ranks;
 * - No soldier may cross a square held/swept by **another unit** (`held !== 0 && held !== owner`);
 * - Every living model must settle in a **distinct 5-ft square** at the end of its move
 *   (`settledCells`), rolling back along its walked trail (or dressing to an open adjacent
 *   slot on sharp wheels) if its target square was already claimed.
 */
export class MarchReservation {
  readonly blocked = new Set<string>();
  // Bounded grid (or sparse map on multi-mile 25k-ft theaters): stores `unitIdx + 1`
  // of any unit that started in or swept across each 5-ft square (`Uint32Array` supports 50,000+ units).
  private occupied?: Uint32Array | Map<number, number>;
  // Tracks exact 5-ft squares currently holding a settled/stationary living model so no
  // two models ever finish the phase in the same 5-ft square.
  private modelCells?: Set<number>;
  private readonly col0: number;
  private readonly row0: number;
  private readonly width: number;
  private readonly totalCells: number;
  private readonly hazards: readonly SpellHazard[];

  constructor(
    private readonly bounds: Bounds,
    hazards: readonly SpellHazard[] = [],
    turn = 0,
  ) {
    this.hazards = hazards.filter((hazard) => spellHazardActive(hazard, turn));
    this.col0 = cell(bounds.minX);
    this.row0 = cell(bounds.minY);
    this.width = cell(bounds.maxX) - this.col0 + 1;
    this.totalCells = this.width * (cell(bounds.maxY) - this.row0 + 1);
  }

  private key(c: number, r: number) {
    return (r - this.row0) * this.width + c - this.col0;
  }

  private getOcc(occ: Uint32Array | Map<number, number>, k: number): number {
    return occ instanceof Uint32Array ? (occ[k] ?? 0) : (occ.get(k) ?? 0);
  }

  private setOcc(occ: Uint32Array | Map<number, number>, k: number, val: number): void {
    if (occ instanceof Uint32Array) occ[k] = val;
    else occ.set(k, val);
  }

  private ensureInitialized(pool: ModelPool): {
    occupied: Uint32Array | Map<number, number>;
    modelCells: Set<number>;
  } {
    if (!this.occupied) {
      this.occupied =
        this.totalCells <= 4_194_304
          ? new Uint32Array(this.totalCells)
          : new Map<number, number>();
      for (let i = 0; i < pool.count; i++) {
        if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
        this.setOcc(
          this.occupied,
          this.key(cell(pool.x[i] ?? 0), cell(pool.y[i] ?? 0)),
          (pool.unitIdx[i] ?? 0) + 1,
        );
      }
    }
    if (!this.modelCells) {
      this.modelCells = new Set<number>();
      for (let i = 0; i < pool.count; i++) {
        if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
        this.modelCells.add(
          this.key(cell(pool.x[i] ?? 0), cell(pool.y[i] ?? 0)),
        );
      }
    }
    return { occupied: this.occupied, modelCells: this.modelCells };
  }

  /**
   * Two-tier per-model formation planning & reservation for `createMassBattlePf1e`.
   */
  planFormation(
    input: ExecuteFormationMoveInput,
  ):
    | { ok: true; plan: ExecutedFormationMove }
    | { ok: false; refusal: string; leadAt: Vec2 } {
    const { pool, unit } = input;
    const range = unit.modelRange;
    if (!range || range[1] <= range[0]) {
      return planUnitModelMoves({
        ...input,
        bounds: this.bounds,
        quantize: true,
        hazards: this.hazards,
      });
    }

    const { occupied, modelCells } = this.ensureInitialized(pool);
    const owner = (pool.unitIdx[range[0]] ?? 0) + 1;

    // Temporarily vacate this unit's starting squares from `modelCells` so rear-rank
    // soldiers can advance into squares vacated by front-rank soldiers of the SAME unit
    // (evaluated in ascending `targetRank` order inside `planUnitModelMoves`), while
    // `occupied` keeps `owner` on those starting squares so other units still treat the
    // swept corridor as reserved.
    const ownStartKeys: Array<{ idx: number; key: number }> = [];
    for (let i = range[0]; i < range[1] && i < pool.count; i++) {
      if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
      const k = this.key(cell(pool.x[i] ?? 0), cell(pool.y[i] ?? 0));
      ownStartKeys.push({ idx: i, key: k });
      modelCells.delete(k);
    }

    const sweptByThisUnit: number[] = [];
    const settledByModel = new Map<number, number>();

    const res = planUnitModelMoves({
      ...input,
      bounds: this.bounds,
      quantize: true,
      hazards: this.hazards,
      callbacks: {
        isBlockedAt: (_modelIdx, fromX, fromY, px, py) => {
          if (!inBounds(this.bounds, px, py)) return true;
          const ax = cell(fromX);
          const bx = cell(px);
          const ay = cell(fromY);
          const by = cell(py);
          for (let c = Math.min(ax, bx); c <= Math.max(ax, bx); c++) {
            for (let r = Math.min(ay, by); r <= Math.max(ay, by); r++) {
              const k = this.key(c, r);
              const held = this.getOcc(occupied, k);
              if (held !== 0 && held !== owner) return true;
            }
          }
          return false;
        },
        commitPosition: (modelIdx, _startX, _startY, finalX, finalY) => {
          if (!inBounds(this.bounds, finalX, finalY)) return false;
          const k = this.key(cell(finalX), cell(finalY));
          const held = this.getOcc(occupied, k);
          if (held !== 0 && held !== owner) return false;
          if (modelCells.has(k)) return false;
          modelCells.add(k);
          settledByModel.set(modelIdx, k);
          return true;
        },
      },
    });

    if (!res.ok) {
      // Restore starting squares on refusal so a refused charge/march leaves state untouched
      for (const k of settledByModel.values()) modelCells.delete(k);
      for (const s of ownStartKeys) modelCells.add(s.key);
      return res;
    }

    // Ensure every living model in the unit claimed a settled square (restore start square if skipped)
    for (const s of ownStartKeys) {
      if (!settledByModel.has(s.idx)) {
        modelCells.add(s.key);
      }
    }

    // Reserve every square swept along each model's walked `trail` in `occupied` so later
    // units in roster order cannot cross through this unit's march corridor.
    for (const o of res.plan.outcomes) {
      for (let t = 1; t < o.trail.length; t++) {
        const a = o.trail[t - 1];
        const b = o.trail[t];
        if (!a || !b) continue;
        const ax = cell(a.x);
        const bx = cell(b.x);
        const ay = cell(a.y);
        const by = cell(b.y);
        for (let c = Math.min(ax, bx); c <= Math.max(ax, bx); c++) {
          for (let r = Math.min(ay, by); r <= Math.max(ay, by); r++) {
            const k = this.key(c, r);
            if (this.getOcc(occupied, k) === 0) {
              this.setOcc(occupied, k, owner);
              sweptByThisUnit.push(k);
            }
          }
        }
      }
    }

    if (res.plan.blockedByOccupancy) {
      this.blocked.add(unit.id);
    }

    return res;
  }

  /**
   * Legacy single-stride planner retained for direct unit tests / callers of `MarchReservation.plan`.
   */
  plan(input: PF1eStrideInput, pool: ModelPool, unit: UnitView) {
    const range = unit.modelRange;
    if (!range) return planPF1eStride(input);
    let clearance = CELL_FEET;
    for (let i = range[0]; i < range[1]; i++) {
      if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
      clearance = Math.max(
        clearance,
        Math.hypot(
          (pool.x[i] ?? 0) - input.from.x,
          (pool.y[i] ?? 0) - input.from.y,
        ) + CELL_FEET,
      );
    }

    const cond = applyUnitConditionsToStride(input, pool, unit);
    if (cond.refusal !== null) {
      return {
        ...planPF1eStride(input),
        to: { ...input.from },
        traveled: 0,
        refusal: cond.refusal,
      };
    }

    const difficult = new Set(cond.input.difficult ?? []);
    for (const hazard of this.hazards) {
      const minC = cell(hazard.at.x - hazard.radius),
        maxC = cell(hazard.at.x + hazard.radius);
      const minR = cell(hazard.at.y - hazard.radius),
        maxR = cell(hazard.at.y + hazard.radius);
      for (let c = minC; c <= maxC; c++)
        for (let r = minR; r <= maxR; r++)
          if (
            pointInSpellHazard(hazard, {
              x: (c + 0.5) * CELL_FEET,
              y: (r + 0.5) * CELL_FEET,
            })
          )
            difficult.add(`${c},${r}`);
    }

    let path: readonly Point[] = cond.input.path;
    if (cond.input.pace === "march" || cond.input.pace === "withdraw") {
      const routedPath: Point[] = [];
      let cursor = cond.input.from;
      for (const requested of cond.input.path) {
        const routed = routeAroundSpellHazards(
          cursor,
          requested,
          this.hazards,
          clearance,
        );
        routedPath.push(...routed);
        cursor = routed.at(-1) ?? cursor;
      }
      path = routedPath.slice(0, 12);
    }

    const routedInput = { ...cond.input, path: [...path], difficult };
    const legs: { x: number; y: number }[] = [];
    const stride = planPF1eStride(routedInput, (x, y) => legs.push({ x, y }));
    if (stride.refusal || !legs.length) return stride;

    const { occupied } = this.ensureInitialized(pool);
    const owner = (pool.unitIdx[range[0]] as number) + 1,
      pending: number[] = [];
    let prior = input.from,
      dx = 0,
      dy = 0,
      traveled = 0;
    for (const end of legs) {
      const length = Math.hypot(end.x - prior.x, end.y - prior.y);
      const steps = Math.ceil(length);
      for (let step = 1; step <= steps; step++) {
        const nx = snap(
          prior.x + ((end.x - prior.x) * step) / steps - input.from.x,
        );
        const ny = snap(
          prior.y + ((end.y - prior.y) * step) / steps - input.from.y,
        );
        pending.length = 0;
        let clear = true;
        for (let i = range[0]; clear && i < range[1]; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
          const x = pool.x[i] as number,
            y = pool.y[i] as number;
          if (!inBounds(this.bounds, x + nx, y + ny)) {
            clear = false;
            break;
          }
          if (
            input.blockAt &&
            input.blockAt(x + dx, y + dy, x + nx, y + ny) !== null
          ) {
            clear = false;
            break;
          }
          const ax = cell(x + dx),
            bx = cell(x + nx),
            ay = cell(y + dy),
            by = cell(y + ny);
          for (let c = Math.min(ax, bx); clear && c <= Math.max(ax, bx); c++)
            for (let r = Math.min(ay, by); r <= Math.max(ay, by); r++) {
              const k = this.key(c, r),
                held = this.getOcc(occupied, k);
              if (held !== 0 && held !== owner) {
                clear = false;
                break;
              }
              if (held === 0) pending.push(k);
            }
        }
        if (!clear) {
          this.blocked.add(unit.id);
          return {
            ...stride,
            to: { x: input.from.x + dx, y: input.from.y + dy },
            traveled,
          };
        }
        for (const k of pending) this.setOcc(occupied, k, owner);
        dx = nx;
        dy = ny;
        traveled += length / steps;
      }
      prior = end;
    }
    return { ...stride, to: { x: input.from.x + dx, y: input.from.y + dy } };
  }

  /** Occupancy- and bounds-safe per-file front gap closing (`combat_resolver_5` C3). */
  reformUnit(
    pool: ModelPool,
    unit: UnitView,
    stepBudgetFeet: number,
    blockAt?: (fromX: number, fromY: number, toX: number, toY: number) => number | null,
  ): { reformedModels: number; ranksClosed: number } {
    const range = unit.modelRange;
    if (!range) return { reformedModels: 0, ranksClosed: 0 };
    const { modelCells: cells } = this.ensureInitialized(pool);
    return applyFormationReform({
      pool,
      range,
      cellFeet: CELL_FEET,
      stepBudgetFeet,
      bounds: this.bounds,
      ...(blockAt ? { blockAt } : {}),
      reserveMove: (_idx, fromX, fromY, toX, toY) => {
        if (!inBounds(this.bounds, toX, toY)) return false;
        const fromK = this.key(cell(fromX), cell(fromY));
        const toK = this.key(cell(toX), cell(toY));
        if (toK !== fromK && cells.has(toK)) return false;
        cells.delete(fromK);
        cells.add(toK);
        return true;
      },
    });
  }

  /** Occupancy- and bounds-safe flank & rear perimeter envelopment (`combat_resolver_5` C2/C18). */
  envelopUnit(
    input: {
      pool: ModelPool;
      attacker: UnitView;
      defender: UnitView;
      attackerAnchor: Point;
      defenderAnchor: Point;
      reachFt: number;
      cellFeet: number;
      maxMoveFeet?: number;
    },
    blockAt?: (fromX: number, fromY: number, toX: number, toY: number) => number | null,
  ): PerimeterEnvelopResult {
    const { modelCells: cells } = this.ensureInitialized(input.pool);
    return applyPerimeterEnvelopment({
      pool: input.pool,
      attackerRange: input.attacker.modelRange ?? [0, 0],
      defenderRange: input.defender.modelRange ?? [0, 0],
      attackerAnchor: input.attackerAnchor,
      defenderAnchor: input.defenderAnchor,
      reachFt: input.reachFt,
      cellFeet: input.cellFeet,
      ...(input.maxMoveFeet !== undefined ? { maxMoveFeet: input.maxMoveFeet } : {}),
      quantize: true,
      bounds: this.bounds,
      ...(blockAt ? { blockAt } : {}),
      tryClaimStation: (idx, toX, toY) => {
        if (!inBounds(this.bounds, toX, toY)) return false;
        const fromX = input.pool.x[idx] ?? 0;
        const fromY = input.pool.y[idx] ?? 0;
        const fromK = this.key(cell(fromX), cell(fromY));
        const toK = this.key(cell(toX), cell(toY));
        if (toK !== fromK && cells.has(toK)) return false;
        cells.delete(fromK);
        cells.add(toK);
        return true;
      },
    });
  }

  /** Occupancy- and bounds-safe PF1e 5-ft step into an unoccupied adjacent square (`combat_resolver_5` C1/C19). */
  stepModel5Ft(
    pool: ModelPool,
    idx: number,
    toX: number,
    toY: number,
  ): boolean {
    if (!inBounds(this.bounds, toX, toY)) return false;
    const { occupied, modelCells: cells } = this.ensureInitialized(pool);
    const fromX = pool.x[idx] ?? 0;
    const fromY = pool.y[idx] ?? 0;
    const fromK = this.key(cell(fromX), cell(fromY));
    const toK = this.key(cell(toX), cell(toY));
    if (toK === fromK) return true;
    if (cells.has(toK)) return false;
    cells.delete(fromK);
    cells.add(toK);
    const owner = (pool.unitIdx[idx] ?? 0) + 1;
    if (this.getOcc(occupied, toK) === 0) this.setOcc(occupied, toK, owner);
    return true;
  }
}
