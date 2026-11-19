import type { UnitView } from "../../core/rules";
import { ModelStatus, type ModelPool } from "../../core/strategic";
import type { PF1eCell } from "./targeting";

const keyFor = (cell: PF1eCell): string => `${cell.col},${cell.row}`;

/**
 * Exact reverse index of the cells threatened by each model during the move phase.
 * Simultaneous moves all query the same starting positions. Stepwise translations
 * replace only the translated unit's contributions. Death is checked at query time
 * (a previous interrupt can kill a model without translating it).
 */
export class StrategicThreatIndex {
  private readonly byCell = new Map<string, Set<number>>();
  private readonly cellsByModel: Array<string[] | undefined>;
  private readonly unitByModel: Int32Array;

  constructor(
    private readonly pool: ModelPool,
    private readonly units: readonly UnitView[],
    private readonly cellsForModel: (index: number) => readonly PF1eCell[],
  ) {
    this.cellsByModel = new Array(pool.count);
    this.unitByModel = new Int32Array(pool.count).fill(-1);
    for (const [index, unit] of units.entries()) {
      const [start, end] = unit.modelRange ?? [0, 0];
      for (let i = start; i < end && i < pool.count; i++) {
        this.unitByModel[i] = index;
        this.add(i);
      }
    }
  }

  private alive(i: number): boolean {
    return ((this.pool.status[i] ?? 0) & ModelStatus.dead) === 0;
  }

  private add(i: number): void {
    if (!this.alive(i)) return;
    const keys = this.cellsForModel(i).map(keyFor);
    this.cellsByModel[i] = keys;
    for (const key of keys) {
      let models = this.byCell.get(key);
      if (!models) this.byCell.set(key, models = new Set());
      models.add(i);
    }
  }

  /** Move-phase ranges are stable until turn-end compaction. */
  refresh(unitIndex: number): void {
    const [start, end] = this.units[unitIndex]?.modelRange ?? [0, 0];
    for (let i = start; i < end && i < this.pool.count; i++) {
      for (const key of this.cellsByModel[i] ?? []) {
        const models = this.byCell.get(key);
        models?.delete(i);
        if (models?.size === 0) this.byCell.delete(key);
      }
      this.cellsByModel[i] = undefined;
      this.add(i);
    }
  }

  /** Only actual walked-out cells, grouped by unit in the original resolver order. */
  candidates(left: readonly PF1eCell[]): Array<readonly [number, (cell: PF1eCell) => boolean]> {
    const byUnit = new Map<number, Set<string>>();
    for (const cell of left) {
      const key = keyFor(cell);
      for (const i of this.byCell.get(key) ?? []) {
        if (!this.alive(i)) continue;
        const unitIndex = this.unitByModel[i] ?? -1;
        if (unitIndex < 0) continue;
        let cells = byUnit.get(unitIndex);
        if (!cells) byUnit.set(unitIndex, cells = new Set());
        cells.add(key);
      }
    }
    return [...byUnit.entries()].sort(([a], [b]) => a - b)
      .map(([index, cells]) => [index, (cell) => cells.has(keyFor(cell))] as const);
  }

  /** Preserve the legacy formation reactor: first living model with non-empty reach. */
  firstReactor(unitIndex: number): number {
    const [start, end] = this.units[unitIndex]?.modelRange ?? [0, 0];
    for (let i = start; i < end && i < this.pool.count; i++) {
      if (this.alive(i) && (this.cellsByModel[i]?.length ?? 0) > 0) return i;
    }
    return -1;
  }
}
