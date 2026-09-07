/**
 * §4A ModelPool implementation: struct-of-arrays allocation, free-list,
 * turn-end compaction, cloning, byte-budget accounting and the §5A
 * determinism hash. Owned by the SimWorker; never mutated elsewhere.
 */
import type { ModelColumnType, ModelPool } from "../core/strategic";
import { ModelStatus } from "../core/strategic";

/** sys column element type → pool storage array (§4A sys union: f32 | i32 | u8). */
const COLUMN_CTORS: Record<
  ModelColumnType,
  Float32ArrayConstructor | Int32ArrayConstructor | Uint8ArrayConstructor
> = {
  f32: Float32Array,
  f64: Float32Array, // stored single-precision in the pool (codec packs on the wire)
  i32: Int32Array,
  u32: Int32Array, // widened in-pool; wire codec packs to declared width
  i16: Int32Array,
  u16: Int32Array,
  i8: Int32Array,
  u8: Uint8Array,
};

export interface SysSchema {
  readonly [name: string]: ModelColumnType;
}

/** Create an empty pool with the §4A base columns + RulesModule sys columns. */
export function createModelPool(capacity: number, sys: SysSchema = {}): ModelPool {
  const pool: ModelPool = {
    capacity,
    count: 0,
    id: new Uint32Array(capacity),
    unitIdx: new Uint32Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    rot: new Float32Array(capacity),
    hp: new Float32Array(capacity),
    hpMax: new Float32Array(capacity),
    status: new Uint32Array(capacity),
    facing: new Uint8Array(capacity),
    rank: new Uint8Array(capacity),
    file: new Uint8Array(capacity),
    sys: {},
    free: new Uint32Array(capacity),
    freeTop: 0,
  };
  for (const [name, type] of Object.entries(sys)) {
    pool.sys[name] = new COLUMN_CTORS[type](capacity);
  }
  return pool;
}

export interface AllocModelInit {
  id: number;
  unitIdx: number;
  x: number;
  y: number;
  rot?: number;
  hp?: number;
  hpMax?: number;
  status?: number;
  facing?: number;
  rank?: number;
  file?: number;
  sys?: Readonly<Record<string, number>>;
}

/**
 * Allocate a slot (reusing the free-list when possible). Returns the index.
 * Callers adjust the owning Unit's modelRange/scan afterwards.
 */
export function allocModel(pool: ModelPool, init: AllocModelInit): number {
  let idx: number;
  if (pool.freeTop > 0) {
    const recycled = pool.free[--pool.freeTop];
    if (recycled === undefined) throw new Error("ModelPool free-list corrupted");
    idx = recycled;
  } else {
    if (pool.count >= pool.capacity) {
      throw new Error(`ModelPool exhausted (capacity ${pool.capacity})`);
    }
    idx = pool.count++;
  }
  setModel(pool, idx, init);
  return idx;
}

/** Write every base field (and sys when given) for one model slot. */
export function setModel(pool: ModelPool, idx: number, init: AllocModelInit): void {
  pool.id[idx] = init.id;
  pool.unitIdx[idx] = init.unitIdx;
  pool.x[idx] = init.x;
  pool.y[idx] = init.y;
  pool.rot[idx] = init.rot ?? 0;
  pool.hp[idx] = init.hp ?? init.hpMax ?? 1;
  pool.hpMax[idx] = init.hpMax ?? init.hp ?? 1;
  pool.status[idx] = init.status ?? 0;
  pool.facing[idx] = init.facing ?? 0;
  pool.rank[idx] = init.rank ?? 0;
  pool.file[idx] = init.file ?? 0;
  if (init.sys) {
    for (const [name, value] of Object.entries(init.sys)) {
      const col = pool.sys[name];
      if (col) col[idx] = value;
    }
  }
}

/**
 * Mark a model dead and push its slot onto the free-list. The slot's columns
 * stay valid until the next compaction overwrites them (§4A).
 */
export function freeModel(pool: ModelPool, idx: number): void {
  if ((pool.status[idx] ?? 0) & ModelStatus.dead) return; // already freed
  const st = pool.status[idx] ?? 0;
  pool.status[idx] = st | ModelStatus.dead;
  pool.hp[idx] = 0;
  pool.free[pool.freeTop++] = idx;
}

/** Sentinel for "removed by compaction" in the remap table. */
export const REMOVED_INDEX = 0xffffffff;

/**
 * Turn-end compaction (§4A): drop dead slots, preserving relative order so
 * unit modelRanges stay contiguous when shifted. Returns old→new index map.
 */
export function compactPool(pool: ModelPool): Uint32Array {
  const remap = new Uint32Array(pool.capacity).fill(REMOVED_INDEX);
  const columns: Array<Float32Array | Int32Array | Uint32Array | Uint8Array | Uint32Array> = [
    pool.id,
    pool.unitIdx,
    pool.x,
    pool.y,
    pool.rot,
    pool.hp,
    pool.hpMax,
    pool.status,
    pool.facing,
    pool.rank,
    pool.file,
    ...Object.values(pool.sys),
  ];
  let dst = 0;
  for (let src = 0; src < pool.count; src++) {
    if ((pool.status[src] ?? 0) & ModelStatus.dead) continue;
    remap[src] = dst;
    if (dst !== src) {
      for (const col of columns) col[dst] = col[src] ?? 0;
    }
    dst++;
  }
  pool.count = dst;
  pool.freeTop = 0;
  return remap;
}

/** Deep copy (columns sliced to capacity) — e.g. checkpoint staging. */
export function clonePool(pool: ModelPool): ModelPool {
  const clone: ModelPool = {
    capacity: pool.capacity,
    count: pool.count,
    id: pool.id.slice(),
    unitIdx: pool.unitIdx.slice(),
    x: pool.x.slice(),
    y: pool.y.slice(),
    rot: pool.rot.slice(),
    hp: pool.hp.slice(),
    hpMax: pool.hpMax.slice(),
    status: pool.status.slice(),
    facing: pool.facing.slice(),
    rank: pool.rank.slice(),
    file: pool.file.slice(),
    sys: {},
    free: pool.free.slice(),
    freeTop: pool.freeTop,
  };
  for (const [name, col] of Object.entries(pool.sys)) clone.sys[name] = col.slice();
  return clone;
}

/** Deterministic column order for hashing/serialization: base order, then sys sorted. */
export function columnNames(pool: ModelPool): string[] {
  return [
    "id",
    "unitIdx",
    "x",
    "y",
    "rot",
    "hp",
    "hpMax",
    "status",
    "facing",
    "rank",
    "file",
    ...Object.keys(pool.sys).sort(),
  ];
}

function columnForName(
  pool: ModelPool,
  name: string,
): Float32Array | Int32Array | Uint32Array | Uint8Array | undefined {
  switch (name) {
    case "id":
      return pool.id;
    case "unitIdx":
      return pool.unitIdx;
    case "x":
      return pool.x;
    case "y":
      return pool.y;
    case "rot":
      return pool.rot;
    case "hp":
      return pool.hp;
    case "hpMax":
      return pool.hpMax;
    case "status":
      return pool.status;
    case "facing":
      return pool.facing;
    case "rank":
      return pool.rank;
    case "file":
      return pool.file;
    default:
      return pool.sys[name];
  }
}

/** Total bytes per model across all columns (≤ 200 B budget, §19 CI benchmark). */
export function bytesPerModel(pool: ModelPool): number {
  let bytes = 0;
  for (const name of columnNames(pool)) {
    const col = columnForName(pool, name);
    bytes += col ? col.BYTES_PER_ELEMENT : 0;
  }
  return bytes;
}

/**
 * §5A determinism hash: 4-lane FNV-1a over the live prefix of every column
 * (sk / free-list bookkeeping excluded — dead slots past `count` are not
 * logical state). 128-bit hex digest.
 */
export function hashPool(pool: ModelPool): string {
  const H = new Int32Array([0x811c9dc5, 0x01000193, 0x9dc5811c, 0x1930100]);
  const mix = (byte: number, i: number): void => {
    const lane = i & 3;
    H[lane] = Math.imul((H[lane] ?? 0) ^ byte, 0x01000193) >>> 0;
  };
  // header: count (LE32)
  let i = 0;
  for (let b = 0; b < 4; b++) mix((pool.count >>> (b * 8)) & 0xff, i++);
  for (const name of columnNames(pool)) {
    const col = columnForName(pool, name);
    if (!col) continue;
    const bytes = new Uint8Array(col.buffer, col.byteOffset, col.byteLength);
    for (let k = 0; k < pool.count * col.BYTES_PER_ELEMENT; k++) {
      mix(bytes[k] ?? 0, i++);
    }
  }
  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, "0");
  return `${hex(H[0] ?? 0)}${hex(H[1] ?? 0)}${hex(H[2] ?? 0)}${hex(H[3] ?? 0)}`;
}
