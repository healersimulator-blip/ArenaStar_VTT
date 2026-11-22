import { ModelStatus, type ModelPool } from "../../core/strategic";

const OFFSET = 1 << 19;
const SPAN = 1 << 20;

/** Pack integer grid coordinates `[-524_288 .. 524_287]` into a positive SMI. */
export function packCellKey(col: number, row: number): number {
  return (col + OFFSET) * SPAN + (row + OFFSET);
}

/**
 * Zero-allocation typed-array open-addressed cell hash mapping 2D grid cells to
 * singly-linked lists of living `ModelPool` indices (`O(N)` build, `O(1)` cell probe).
 */
export class ModelCellHash {
  private readonly tableKeys: Float64Array;
  private readonly tableHeads: Int32Array;
  private readonly nextModel: Int32Array;
  private readonly mask: number;

  constructor(pool: ModelPool, cellFeet: number) {
    const count = pool.count;
    let buckets = 16;
    while (buckets < count * 2) buckets <<= 1;
    this.mask = buckets - 1;
    this.tableKeys = new Float64Array(buckets).fill(-1);
    this.tableHeads = new Int32Array(buckets).fill(-1);
    this.nextModel = new Int32Array(count).fill(-1);

    const inv = 1 / cellFeet;
    const xs = pool.x;
    const ys = pool.y;
    const status = pool.status;
    const keys = this.tableKeys;
    const heads = this.tableHeads;
    const next = this.nextModel;
    const mask = this.mask;

    for (let i = count - 1; i >= 0; i--) {
      if (((status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
      const col = Math.floor((xs[i] ?? 0) * inv);
      const row = Math.floor((ys[i] ?? 0) * inv);
      const k = (col + OFFSET) * SPAN + (row + OFFSET);
      let slot = (Math.imul(col, 73856093) ^ Math.imul(row, 19349663)) & mask;
      while (keys[slot] !== -1 && keys[slot] !== k) {
        slot = (slot + 1) & mask;
      }
      keys[slot] = k;
      next[i] = heads[slot] ?? -1;
      heads[slot] = i;
    }
  }

  /** Head model index in `(col, row)`, or `-1` when empty. */
  headAt(col: number, row: number): number {
    const k = (col + OFFSET) * SPAN + (row + OFFSET);
    let slot = (Math.imul(col, 73856093) ^ Math.imul(row, 19349663)) & this.mask;
    const keys = this.tableKeys;
    while (true) {
      const sk = keys[slot] ?? -1;
      if (sk === k) return this.tableHeads[slot] ?? -1;
      if (sk === -1) return -1;
      slot = (slot + 1) & this.mask;
    }
  }

  /** Next living model index in the same cell after `modelIdx`, or `-1`. */
  nextAfter(modelIdx: number): number {
    return this.nextModel[modelIdx] ?? -1;
  }

  /** True when at least one living model (optionally excluding `ignoreIdx`) stands in `(col, row)`. */
  hasLivingAt(pool: ModelPool, col: number, row: number, ignoreIdx = -1): boolean {
    let cur = this.headAt(col, row);
    const status = pool.status;
    while (cur >= 0) {
      if (cur !== ignoreIdx && ((status[cur] ?? 0) & ModelStatus.dead) === 0) return true;
      cur = this.nextModel[cur] ?? -1;
    }
    return false;
  }

  /** Relocate an existing living model from `(oldCol, oldRow)` to `(newCol, newRow)` in `O(1)`. */
  moveModel(modelIdx: number, oldCol: number, oldRow: number, newCol: number, newRow: number): void {
    if (oldCol === newCol && oldRow === newRow) return;
    const oldK = (oldCol + OFFSET) * SPAN + (oldRow + OFFSET);
    let slot = (Math.imul(oldCol, 73856093) ^ Math.imul(oldRow, 19349663)) & this.mask;
    const keys = this.tableKeys;
    const heads = this.tableHeads;
    const next = this.nextModel;
    while (true) {
      const sk = keys[slot] ?? -1;
      if (sk === oldK) {
        let cur = heads[slot] ?? -1;
        let prev = -1;
        while (cur >= 0) {
          if (cur === modelIdx) {
            if (prev < 0) heads[slot] = next[cur] ?? -1;
            else next[prev] = next[cur] ?? -1;
            break;
          }
          prev = cur;
          cur = next[cur] ?? -1;
        }
        break;
      }
      if (sk === -1) break;
      slot = (slot + 1) & this.mask;
    }

    const newK = (newCol + OFFSET) * SPAN + (newRow + OFFSET);
    let nSlot = (Math.imul(newCol, 73856093) ^ Math.imul(newRow, 19349663)) & this.mask;
    while (keys[nSlot] !== -1 && keys[nSlot] !== newK) {
      nSlot = (nSlot + 1) & this.mask;
    }
    keys[nSlot] = newK;
    next[modelIdx] = heads[nSlot] ?? -1;
    heads[nSlot] = modelIdx;
  }

  /** Visit every living model inside `[minCol..maxCol] x [minRow..maxRow]`. */
  forEachInRect(
    pool: ModelPool,
    minCol: number,
    maxCol: number,
    minRow: number,
    maxRow: number,
    visit: (modelIdx: number) => void,
  ): void {
    const status = pool.status;
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        let cur = this.headAt(c, r);
        while (cur >= 0) {
          if (((status[cur] ?? 0) & ModelStatus.dead) === 0) {
            visit(cur);
          }
          cur = this.nextModel[cur] ?? -1;
        }
      }
    }
  }
}
