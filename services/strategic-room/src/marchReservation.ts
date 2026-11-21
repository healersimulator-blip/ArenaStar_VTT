import { SIM_POS_QUANTUM } from "../../../src/core/sim";
import { ModelStatus, type ModelPool } from "../../../src/core/strategic";
import type { UnitView } from "../../../src/core/rules";
import type { Bounds, Point } from "../../../src/core/strategicRoom/protocol";
import { pointInSpellHazard, routeAroundSpellHazards, spellHazardActive, type SpellHazard } from "../../../src/core/strategicRoom/hazardAvoidance";
import { PF1eCondition } from "../../../src/packages/pf1e/schema";
import {
  planPF1eStride,
  type PF1eStrideInput,
} from "../../../src/packages/pf1e/stride";
import { CELL_FEET, inBounds } from "../../../src/core/strategicRoom/scenario";

const cell = (v: number) => Math.floor(v / CELL_FEET);
const snap = (v: number) => Math.round(v * SIM_POS_QUANTUM) / SIM_POS_QUANTUM;

/** One ledger per frozen turn. Reserve starts and swept cells for the entire phase, in canonical
 * roster order (never packet order). A unit may reuse its own trail, not swap through a neighbour.
 * This is conservative grid movement, not time-of-arrival scheduling or automatic rerouting. */
export class MarchReservation {
  readonly blocked = new Set<string>();
  // The scenario caps either axis at 4096 ft and the roster at 5000 units. One
  // bounded grid (<1.4 MiB even at maximum map size); no per-model pair scans.
  private occupied?: Uint16Array;
  private readonly col0: number;
  private readonly row0: number;
  private readonly width: number;
  private readonly hazards: readonly SpellHazard[];
  constructor(private readonly bounds: Bounds, hazards: readonly SpellHazard[] = [], turn = 0) {
    this.hazards = hazards.filter((hazard) => spellHazardActive(hazard, turn));
    this.col0 = cell(bounds.minX);
    this.row0 = cell(bounds.minY);
    this.width = cell(bounds.maxX) - this.col0 + 1;
  }
  private key(c: number, r: number) {
    return (r - this.row0) * this.width + c - this.col0;
  }
  plan(input: PF1eStrideInput, pool: ModelPool, unit: UnitView) {
    const range = unit.modelRange;
    if (!range) return planPF1eStride(input);
    // Clearance includes every living file/rank offset, so the whole formation—not only
    // its lead model—routes outside the spell area.
    let clearance = CELL_FEET;
    for (let i = range[0]; i < range[1]; i++) {
      if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
      clearance = Math.max(clearance, Math.hypot(
        (pool.x[i] ?? 0) - input.from.x,
        (pool.y[i] ?? 0) - input.from.y,
      ) + CELL_FEET);
    }
    const pfCondition = pool.sys.pfCondition;
    let entangled = false;
    for (let i = range[0]; i < range[1]; i++) {
      const condition = pfCondition?.[i] ?? 0;
      if ((condition & PF1eCondition.HAZARD_GRAPPLED) !== 0)
        return { ...planPF1eStride(input), to: { ...input.from }, traveled: 0,
          refusal: "Black Tentacles still grapple the formation; it must escape before fleeing" };
      entangled ||= (condition & PF1eCondition.ENTANGLED) !== 0;
    }
    const difficult = new Set(input.difficult ?? []);
    for (const hazard of this.hazards) {
      const minC = cell(hazard.at.x - hazard.radius), maxC = cell(hazard.at.x + hazard.radius);
      const minR = cell(hazard.at.y - hazard.radius), maxR = cell(hazard.at.y + hazard.radius);
      for (let c = minC; c <= maxC; c++) for (let r = minR; r <= maxR; r++)
        if (pointInSpellHazard(hazard, { x: (c + 0.5) * CELL_FEET, y: (r + 0.5) * CELL_FEET }))
          difficult.add(`${c},${r}`);
    }
    const path: Point[] = [];
    let cursor = input.from;
    for (const requested of input.path) {
      const routed = routeAroundSpellHazards(cursor, requested, this.hazards, clearance);
      path.push(...routed);
      cursor = routed.at(-1) ?? cursor;
    }
    const routedInput = { ...input, path: path.slice(0, 12), difficult,
      movePoints: entangled ? input.movePoints / 2 : input.movePoints };
    const legs: { x: number; y: number }[] = [];
    const stride = planPF1eStride(routedInput, (x, y) => legs.push({ x, y }));
    if (stride.refusal || !legs.length) return stride;
    if (!this.occupied) {
      this.occupied = new Uint16Array(
        this.width * (cell(this.bounds.maxY) - this.row0 + 1),
      );
      for (let i = 0; i < pool.count; i++) {
        if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
        this.occupied[
          this.key(cell(pool.x[i] as number), cell(pool.y[i] as number))
        ] = (pool.unitIdx[i] as number) + 1;
      }
    }
    const owner = (pool.unitIdx[range[0]] as number) + 1,
      pending: number[] = [];
    let prior = input.from,
      dx = 0,
      dy = 0,
      traveled = 0;
    for (const end of legs) {
      const length = Math.hypot(end.x - prior.x, end.y - prior.y);
      // At most 20 feet of input per hosted march. Check the swept rectangle of each model in
      // each <=1-ft interval, not just its endpoint; includes diagonals and waypoint bends.
      const steps = Math.ceil(length);
      for (let step = 1; step <= steps; step++) {
        // Quantize the translation, not each final model separately, to preserve rigid offsets.
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
          const ax = cell(x + dx),
            bx = cell(x + nx),
            ay = cell(y + dy),
            by = cell(y + ny);
          for (let c = Math.min(ax, bx); clear && c <= Math.max(ax, bx); c++)
            for (let r = Math.min(ay, by); r <= Math.max(ay, by); r++) {
              const k = this.key(c, r),
                held = this.occupied[k];
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
        for (const k of pending) this.occupied[k] = owner;
        dx = nx;
        dy = ny;
        traveled += length / steps;
      }
      prior = end;
    }
    return { ...stride, to: { x: input.from.x + dx, y: input.from.y + dy } };
  }
}
