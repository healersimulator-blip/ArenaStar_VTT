import type { UnitView } from "../../core/rules";
import { ModelStatus, type ModelPool } from "../../core/strategic";
import { packCellKey } from "./spatialIndex";
import type { PF1eCell } from "./targeting";

/**
 * Exact reverse index of the cells threatened by each model during the move phase.
 *
 * Uses flat typed-array linked lists (`bucketMap -> entryIdx -> entryNextInCell`) plus
 * per-model entry lists (`modelHead -> entryNextInModel`) with recycling free-list for
 * `refresh()`, avoiding hundreds of thousands of `Set<number>` / `number[]` heap allocations
 * on 50,000-model battlefields.
 */
export class StrategicThreatIndex {
  private readonly bucketMap = new Map<number, number>();
  private readonly unitByModel: Int32Array;
  private readonly modelHead: Int32Array;

  private entryModel: Int32Array;
  private entryKey: Float64Array;
  private entryNextInCell: Int32Array;
  private entryPrevInCell: Int32Array;
  private entryNextInModel: Int32Array;
  private entryLen = 0;
  private freeHead = -1;

  constructor(
    private readonly pool: ModelPool,
    private readonly units: readonly UnitView[],
    private readonly cellsForModel: (index: number) => readonly PF1eCell[],
    emitKeysForModel?: (index: number, onKey: (packedKey: number) => void) => void,
  ) {
    this.unitByModel = new Int32Array(pool.count).fill(-1);
    this.modelHead = new Int32Array(pool.count).fill(-1);

    const initCap = Math.max(64, pool.count * 8);
    this.entryModel = new Int32Array(initCap);
    this.entryKey = new Float64Array(initCap);
    this.entryNextInCell = new Int32Array(initCap).fill(-1);
    this.entryPrevInCell = new Int32Array(initCap).fill(-1);
    this.entryNextInModel = new Int32Array(initCap).fill(-1);
    this.emitKeys = emitKeysForModel;

    for (let uIdx = 0; uIdx < units.length; uIdx++) {
      const unit = units[uIdx];
      if (!unit) continue;
      const [start, end] = unit.modelRange ?? [0, 0];
      for (let i = start; i < end && i < pool.count; i++) {
        this.unitByModel[i] = uIdx;
        this.add(i);
      }
    }
  }

  private readonly emitKeys?: ((index: number, onKey: (packedKey: number) => void) => void) | undefined;

  private alive(i: number): boolean {
    return ((this.pool.status[i] ?? 0) & ModelStatus.dead) === 0;
  }

  private allocEntry(): number {
    if (this.freeHead >= 0) {
      const idx = this.freeHead;
      this.freeHead = this.entryNextInModel[idx] ?? -1;
      return idx;
    }
    const idx = this.entryLen++;
    if (idx >= this.entryModel.length) {
      const nextCap = Math.max(64, this.entryModel.length * 2);
      const nextModel = new Int32Array(nextCap);
      nextModel.set(this.entryModel);
      this.entryModel = nextModel;

      const nextKey = new Float64Array(nextCap);
      nextKey.set(this.entryKey);
      this.entryKey = nextKey;

      const nextInCell = new Int32Array(nextCap).fill(-1);
      nextInCell.set(this.entryNextInCell);
      this.entryNextInCell = nextInCell;

      const prevInCell = new Int32Array(nextCap).fill(-1);
      prevInCell.set(this.entryPrevInCell);
      this.entryPrevInCell = prevInCell;

      const nextInModel = new Int32Array(nextCap).fill(-1);
      nextInModel.set(this.entryNextInModel);
      this.entryNextInModel = nextInModel;
    }
    return idx;
  }

  private insertKeyForModel(modelIdx: number, k: number): void {
    const e = this.allocEntry();
    this.entryModel[e] = modelIdx;
    this.entryKey[e] = k;

    const oldCellHead = this.bucketMap.get(k) ?? -1;
    this.entryPrevInCell[e] = -1;
    this.entryNextInCell[e] = oldCellHead;
    if (oldCellHead >= 0) this.entryPrevInCell[oldCellHead] = e;
    this.bucketMap.set(k, e);

    this.entryNextInModel[e] = this.modelHead[modelIdx] ?? -1;
    this.modelHead[modelIdx] = e;
  }

  private add(i: number): void {
    if (!this.alive(i)) return;
    if (this.emitKeys) {
      this.emitKeys(i, (k) => this.insertKeyForModel(i, k));
      return;
    }
    const rawCells = this.cellsForModel(i);
    for (let cIdx = 0; cIdx < rawCells.length; cIdx++) {
      const c = rawCells[cIdx];
      if (!c) continue;
      this.insertKeyForModel(i, packCellKey(c.col, c.row));
    }
  }

  /** Move-phase ranges are stable until turn-end compaction. */
  refresh(unitIndex: number): void {
    const [start, end] = this.units[unitIndex]?.modelRange ?? [0, 0];
    for (let i = start; i < end && i < this.pool.count; i++) {
      let e = this.modelHead[i] ?? -1;
      while (e >= 0) {
        const nextM = this.entryNextInModel[e] ?? -1;
        const k = this.entryKey[e] ?? 0;
        const prevC = this.entryPrevInCell[e] ?? -1;
        const nextC = this.entryNextInCell[e] ?? -1;
        if (prevC >= 0) {
          this.entryNextInCell[prevC] = nextC;
        } else if (nextC >= 0) {
          this.bucketMap.set(k, nextC);
        } else {
          this.bucketMap.delete(k);
        }
        if (nextC >= 0) {
          this.entryPrevInCell[nextC] = prevC;
        }
        this.entryPrevInCell[e] = -1;
        this.entryNextInCell[e] = -1;
        this.entryNextInModel[e] = this.freeHead;
        this.freeHead = e;
        e = nextM;
      }
      this.modelHead[i] = -1;
      this.add(i);
    }
  }

  /** Fast O(#left) zero-allocation check for whether any living non-mover model threatens `left`. */
  hasAnyOtherThreat(left: readonly PF1eCell[], moverUnitIndex: number): boolean {
    for (let j = 0; j < left.length; j++) {
      const cell = left[j];
      if (!cell) continue;
      let e = this.bucketMap.get(packCellKey(cell.col, cell.row)) ?? -1;
      while (e >= 0) {
        const m = this.entryModel[e] ?? -1;
        if (m >= 0 && this.alive(m) && (this.unitByModel[m] ?? -1) !== moverUnitIndex) {
          return true;
        }
        e = this.entryNextInCell[e] ?? -1;
      }
    }
    return false;
  }

  /** Only actual walked-out cells, grouped by unit in the original resolver order. */
  candidates(left: readonly PF1eCell[]): Array<readonly [number, (cell: PF1eCell) => boolean]> {
    let byUnit: Map<number, Set<number>> | null = null;
    for (let j = 0; j < left.length; j++) {
      const cell = left[j];
      if (!cell) continue;
      const key = packCellKey(cell.col, cell.row);
      let e = this.bucketMap.get(key) ?? -1;
      while (e >= 0) {
        const i = this.entryModel[e] ?? -1;
        if (i >= 0 && this.alive(i)) {
          const unitIndex = this.unitByModel[i] ?? -1;
          if (unitIndex >= 0) {
            if (!byUnit) byUnit = new Map();
            let cells = byUnit.get(unitIndex);
            if (!cells) byUnit.set(unitIndex, (cells = new Set()));
            cells.add(key);
          }
        }
        e = this.entryNextInCell[e] ?? -1;
      }
    }
    if (!byUnit) return [];
    return [...byUnit.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, cells]) => [index, (cell) => cells.has(packCellKey(cell.col, cell.row))] as const);
  }

  /** Preserve the legacy formation reactor: first living model with non-empty reach. */
  firstReactor(unitIndex: number): number {
    const [start, end] = this.units[unitIndex]?.modelRange ?? [0, 0];
    for (let i = start; i < end && i < this.pool.count; i++) {
      if (this.alive(i) && (this.modelHead[i] ?? -1) >= 0) return i;
    }
    return -1;
  }
}
