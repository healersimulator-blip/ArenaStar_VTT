/**
 * §5A SimDelta / SimSnapshot binary codec.
 *
 * Wire form (payload after the [u8] MsgKind channel byte, §6.1):
 *   fflate(deflate) ∘ msgpack(header object) where each column's packed
 *   values ride as msgpack `bin`. Quantization per §5A: positions int16 in
 *   grid units / 16 (SIM_POS_QUANTUM), hp uint16 permille of hpMax
 *   (SIM_HP_PERMILLE), rot uint16 turn fractions of 2π. A column whose
 *   changed fraction exceeds SIM_FULL_RESEND_THRESHOLD is sent whole
 * (fullResend). sys columns pack per their declared ModelColumnType.
 */
import { compressSync, decompressSync } from "fflate";
import { decode, encode } from "@msgpack/msgpack";
import { ModelStatus, type ModelPool } from "../core/strategic";
import {
  SIM_FULL_RESEND_THRESHOLD,
  SIM_HP_PERMILLE,
  SIM_POS_QUANTUM,
  type SimDelta,
  type SimSnapshot,
  type SimColumnDelta,
} from "../core/sim";
import type { SysSchema } from "./pool";
import { columnNames, hashPool } from "./pool";

const TAU = Math.PI * 2;

type ColKind = "u32" | "i32" | "u16" | "i16" | "u8" | "f32";

/** Per-column wire element kind. Base columns fixed (§5A); sys by schema. */
function colKind(name: string, sys: SysSchema): ColKind | null {
  switch (name) {
    case "id":
    case "unitIdx":
    case "status":
      return "u32";
    case "x":
    case "y":
      return "i16"; // grid units × SIM_POS_QUANTUM
    case "rot":
      return "u16"; // turn = u16 / 65536 × 2π
    case "hp":
    case "hpMax":
      return "u16"; // permille (hp of hpMax; hpMax of pool.maxHpMax)
    case "facing":
    case "rank":
    case "file":
      return "u8";
    default: {
      const t = sys[name];
      if (!t) return null;
      return t === "f32" || t === "f64" ? "f32" : (t as ColKind);
    }
  }
}

const KIND_BYTES: Record<ColKind, number> = { u32: 4, i32: 4, u16: 2, i16: 2, u8: 1, f32: 4 };

/** Quantized code for one element of a column (deterministic rounding). */
function quantize(name: string, value: number, ctx: QuantCtx): number {
  switch (name) {
    case "x":
    case "y":
      return clampInt(Math.round(value * SIM_POS_QUANTUM), -0x8000, 0x7fff);
    case "rot":
      return ((Math.round((value / TAU) * 0x10000) % 0x10000) + 0x10000) % 0x10000;
    case "hp":
      return clampInt(Math.round((value / (ctx.hpMaxRef || 1)) * SIM_HP_PERMILLE), 0, 0xffff);
    case "hpMax":
      return clampInt(Math.round((value / (ctx.maxHpMax || 1)) * SIM_HP_PERMILLE), 0, 0xffff);
    default:
      return Math.round(value); // u8 columns clamp naturally at pack time
  }
}

/** Inverse of quantize (loses the name-specific scale — callers pass it back). */
function dequantize(name: string, code: number, ctx: QuantCtx): number {
  switch (name) {
    case "x":
    case "y":
      return code / SIM_POS_QUANTUM;
    case "rot":
      return (code / 0x10000) * TAU;
    case "hp":
      return (code / SIM_HP_PERMILLE) * (ctx.hpMaxRef || 1);
    case "hpMax":
      return (code / SIM_HP_PERMILLE) * (ctx.maxHpMax || 1);
    default:
      return code; // ints stay integral; f32 codes are bit patterns (writeCode unpacks)
  }
}

interface QuantCtx {
  /** Pool-wide max hpMax (hpMax codes are permille of this). */
  maxHpMax: number;
  /** Per-model reference for hp codes (encode: hpMax[i]; decode: decoded hpMax[i]). */
  hpMaxRef: number;
}

/** Encode one element: f32 columns as IEEE bits, others quantized. */
function encodeCode(name: string, kind: ColKind, value: number, ctx: QuantCtx): number {
  if (kind === "f32") return numberToF32Bits(value);
  return quantize(name, value, ctx);
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function columnValues(
  pool: ModelPool,
  name: string,
): Float32Array | Int32Array | Uint32Array | Uint8Array | undefined {
  if (name === "hp" || name === "hpMax" || name === "x" || name === "y" || name === "rot") {
    return (pool as unknown as Record<string, Float32Array>)[name];
  }
  switch (name) {
    case "id":
      return pool.id;
    case "unitIdx":
      return pool.unitIdx;
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

// ─── packing primitives ───────────────────────────────────────────────────────

function packCodes(codes: number[], kind: ColKind): Uint8Array {
  const size = codes.length * KIND_BYTES[kind];
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  let o = 0;
  for (const c of codes) {
    switch (kind) {
      case "u32":
        view.setUint32(o, c >>> 0, true);
        break;
      case "i32":
        view.setInt32(o, c | 0, true);
        break;
      case "u16":
        view.setUint16(o, c & 0xffff, true);
        break;
      case "i16":
        view.setInt16(o, c | 0, true);
        break;
      case "u8":
        view.setUint8(o, c & 0xff);
        break;
      case "f32":
        view.setFloat32(o, f32BitsToNumber(c), true);
        break;
    }
    o += KIND_BYTES[kind];
  }
  return new Uint8Array(buf);
}

function unpackCodes(bytes: Uint8Array, kind: ColKind): number[] {
  const n = bytes.byteLength / KIND_BYTES[kind];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<number>(n);
  let o = 0;
  for (let i = 0; i < n; i++) {
    switch (kind) {
      case "u32":
        out[i] = view.getUint32(o, true);
        break;
      case "i32":
        out[i] = view.getInt32(o, true);
        break;
      case "u16":
        out[i] = view.getUint16(o, true);
        break;
      case "i16":
        out[i] = view.getInt16(o, true);
        break;
      case "u8":
        out[i] = view.getUint8(o);
        break;
      case "f32":
        out[i] = numberToF32Bits(view.getFloat32(o, true));
        break;
    }
    o += KIND_BYTES[kind];
  }
  return out;
}

/** f32 codes travel as their IEEE-754 bit pattern reinterpreted as int32. */
function numberToF32Bits(v: number): number {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = v;
  return new Int32Array(buf)[0] ?? 0;
}

function f32BitsToNumber(bits: number): number {
  const buf = new ArrayBuffer(4);
  new Int32Array(buf)[0] = bits;
  return new Float32Array(buf)[0] ?? 0;
}

// ─── diff / encode ────────────────────────────────────────────────────────────

/** maxHpMax over the live prefix — hp/hpMax permille reference (§5A). */
function poolMaxHpMax(pool: ModelPool): number {
  let m = 0;
  for (let i = 0; i < pool.count; i++) {
    const v = pool.hpMax[i] ?? 0;
    if (v > m) m = v;
  }
  return m || 1;
}

/**
 * Diff two pool states → decoded SimDelta (uncompressed domain model).
 * Compares in the *quantized* domain: sub-quantum drift produces no delta.
 */
export function diffPools(
  prev: ModelPool,
  next: ModelPool,
  sceneId: string,
  sys: SysSchema,
): SimDelta {
  const maxHpMax = poolMaxHpMax(next);
  const columns: SimColumnDelta[] = [];
  for (const name of columnNames(next)) {
    const kind = colKind(name, sys);
    const src = columnValues(next, name);
    if (!kind || !src) continue;
    const prevCol = columnValues(prev, name);
    const changed: number[] = [];
    for (let i = 0; i < next.count; i++) {
      const ref = name === "hp" ? (next.hpMax[i] ?? 0) || 1 : 1;
      const code = encodeCode(name, kind, src[i] ?? 0, { maxHpMax, hpMaxRef: ref });
      const prevRef = name === "hp" && prevCol && i < prev.count ? (prev.hpMax[i] ?? 0) || 1 : ref;
      const prevCode =
        prevCol && i < prev.count
          ? encodeCode(name, kind, prevCol[i] ?? 0, { maxHpMax, hpMaxRef: prevRef })
          : encodeCode(name, kind, 0, { maxHpMax, hpMaxRef: prevRef });
      if (code !== prevCode) changed.push(i);
    }
    const full = changed.length > next.count * SIM_FULL_RESEND_THRESHOLD;
    const indices = full ? Array.from({ length: next.count }, (_, i) => i) : changed;
    if (!full && indices.length === 0) continue; // unchanged column — omit
    const codes = indices.map((i) => {
      const ref = name === "hp" ? (next.hpMax[i] ?? 0) || 1 : 1;
      return encodeCode(name, kind, src[i] ?? 0, { maxHpMax, hpMaxRef: ref });
    });
    // RLE of consecutive indices
    const runs: Array<readonly [number, number]> = [];
    for (const idx of indices) {
      const last = runs[runs.length - 1];
      if (last && last[0] + last[1] === idx) {
        runs[runs.length - 1] = [last[0], last[1] + 1] as readonly [number, number];
      } else {
        runs.push([idx, 1] as readonly [number, number]);
      }
    }
    columns.push({
      column: name,
      runs: full ? [] : runs,
      values: packCodes(codes, kind),
      fullResend: full,
    });
  }
  return { sceneId, fromVersion: 0, toVersion: 0, count: next.count, columns };
}

interface WireColumn {
  n: string;
  fr?: boolean | undefined;
  r?: number[][] | undefined;
  b: Uint8Array;
}

interface WireDelta {
  t: 1;
  s: string;
  f: number;
  v: number;
  c: number;
  m: number;
  cols: WireColumn[];
}

interface WireSnapshot {
  t: 2;
  s: string;
  v: number;
  c: number;
  m: number;
  cols: WireColumn[];
}

/**
 * §5A realtime: merge strictly sequential SimDeltas (v0→v1, v1→v2, …) into
 * one coalesced frame (v0→vN). Column values are absolute, so the merge is a
 * per-column union of covered indices with the LATEST code winning. Returns
 * null for an empty list.
 */
export function mergeSimDeltas(deltas: SimDelta[], sys: SysSchema): SimDelta | null {
  const first = deltas[0];
  const last = deltas[deltas.length - 1];
  if (!first || !last) return null;
  const count = last.count;
  const columns: SimColumnDelta[] = [];
  const names: string[] = [];
  for (const d of deltas) {
    for (const col of d.columns) {
      if (!names.includes(col.column)) names.push(col.column);
    }
  }
  for (const name of names) {
    const kind = colKind(name, sys);
    if (!kind) continue;
    const latest = new Map<number, number>();
    for (const d of deltas) {
      const col = d.columns.find((c) => c.column === name);
      if (!col) continue;
      if (col.fullResend) {
        const codes = unpackCodes(col.values, kind);
        for (let i = 0; i < codes.length; i++) latest.set(i, codes[i] as number);
        continue;
      }
      const codes = unpackCodes(col.values, kind);
      let k = 0;
      for (const [start, len] of col.runs) {
        for (let i = start; i < start + len && i < count; i++) {
          latest.set(i, codes[k++] as number);
        }
      }
    }
    if (latest.size === 0) continue;
    const indices = [...latest.keys()].sort((a, b) => a - b);
    const full = indices.length > count * SIM_FULL_RESEND_THRESHOLD;
    const runs: Array<readonly [number, number]> = [];
    for (const idx of indices) {
      const prevRun = runs[runs.length - 1];
      if (prevRun && prevRun[0] + prevRun[1] === idx) {
        runs[runs.length - 1] = [prevRun[0], prevRun[1] + 1];
      } else {
        runs.push([idx, 1]);
      }
    }
    const codes = indices.map((i) => latest.get(i) as number);
    columns.push({
      column: name,
      runs: full ? [] : runs,
      values: packCodes(codes, kind),
      fullResend: full,
    });
  }
  return {
    sceneId: last.sceneId,
    fromVersion: first.fromVersion,
    toVersion: last.toVersion,
    count,
    columns,
  };
}

/** Compress a SimDelta to its wire payload (fflate ∘ msgpack). */
export function encodeSimDelta(delta: SimDelta, maxHpMax: number): Uint8Array {
  const wire: WireDelta = {
    t: 1,
    s: delta.sceneId,
    f: delta.fromVersion,
    v: delta.toVersion,
    c: delta.count,
    m: maxHpMax,
    cols: delta.columns.map((c) => ({
      n: c.column,
      fr: c.fullResend || undefined,
      r: c.fullResend ? undefined : c.runs.map((r) => [r[0], r[1]] as number[]),
      b: c.values,
    })),
  };
  return compressSync(encode(wire));
}

/** Decompress + parse a delta payload. */
export function decodeSimDelta(bytes: Uint8Array): { delta: SimDelta; maxHpMax: number } {
  const wire = decode(decompressSync(bytes)) as unknown as WireDelta;
  return {
    delta: {
      sceneId: wire.s,
      fromVersion: wire.f,
      toVersion: wire.v,
      count: wire.c,
      columns: wire.cols.map((c) => ({
        column: c.n,
        runs: (c.r ?? []).map((r) => [r[0], r[1]] as readonly [number, number]),
        values: c.b,
        fullResend: c.fr === true,
      })),
    },
    maxHpMax: wire.m,
  };
}

/** Full-state frame: every column packed whole (§5A SimSnapshot). */
export function snapshotFromPool(
  pool: ModelPool,
  sceneId: string,
  version: number,
  sys: SysSchema,
): SimSnapshot {
  const maxHpMax = poolMaxHpMax(pool);
  const columns: Array<{ column: string; values: Uint8Array }> = [];
  for (const name of columnNames(pool)) {
    const kind = colKind(name, sys);
    const src = columnValues(pool, name);
    if (!kind || !src) continue;
    const codes = new Array<number>(pool.count);
    for (let i = 0; i < pool.count; i++) {
      const ref = name === "hp" ? (pool.hpMax[i] ?? 0) || 1 : 1;
      codes[i] = encodeCode(name, kind, src[i] ?? 0, { maxHpMax, hpMaxRef: ref });
    }
    columns.push({ column: name, values: packCodes(codes, kind) });
  }
  return { sceneId, version, count: pool.count, columns };
}

export function encodeSimSnapshot(snap: SimSnapshot, maxHpMax: number): Uint8Array {
  const wire: WireSnapshot = {
    t: 2,
    s: snap.sceneId,
    v: snap.version,
    c: snap.count,
    m: maxHpMax,
    cols: snap.columns.map((c) => ({ n: c.column, b: c.values })),
  };
  return compressSync(encode(wire));
}

export function decodeSimSnapshot(bytes: Uint8Array): { snapshot: SimSnapshot; maxHpMax: number } {
  const wire = decode(decompressSync(bytes)) as unknown as WireSnapshot;
  return {
    snapshot: {
      sceneId: wire.s,
      version: wire.v,
      count: wire.c,
      columns: wire.cols.map((c) => ({ column: c.n, values: c.b })),
    },
    maxHpMax: wire.m,
  };
}

// ─── apply (client replica) ──────────────────────────────────────────────────

function writeCode(
  pool: ModelPool,
  name: string,
  kind: ColKind,
  idx: number,
  code: number,
  ctx: QuantCtx,
): void {
  const value = dequantize(name, code, ctx);
  const col = columnValues(pool, name) as
    Float32Array | Int32Array | Uint32Array | Uint8Array | undefined;
  if (!col) return;
  if (kind === "f32") {
    (col as Float32Array | Int32Array)[idx] = f32BitsToNumber(code);
    return;
  }
  // Uint8Array columns clamp naturally; others fit their ranges by construction.
  (col as Float32Array | Int32Array | Uint32Array)[idx] = value;
}

/** Apply a decoded delta to a pool replica, strictly sequentially (§5A). */
export function applySimDelta(
  pool: ModelPool,
  delta: SimDelta,
  maxHpMax: number,
  sys: SysSchema,
): void {
  const ctx: QuantCtx = { maxHpMax, hpMaxRef: 1 };
  // hp permille references hpMax[i]; apply hpMax first so an empty replica
  // decodes hp against the *new* hpMax, not a zero-filled column.
  const ordered = [...delta.columns].sort((a, b) =>
    a.column === "hpMax" ? -1 : b.column === "hpMax" ? 1 : 0,
  );
  for (const col of ordered) {
    const kind = colKind(col.column, sys);
    if (!kind) continue;
    const codes = unpackCodes(col.values, kind);
    if (col.fullResend) {
      for (let i = 0; i < Math.min(codes.length, pool.capacity); i++) {
        ctx.hpMaxRef = col.column === "hp" ? (pool.hpMax[i] ?? 0) || 1 : 1;
        writeCode(pool, col.column, kind, i, codes[i] ?? 0, ctx);
      }
      continue;
    }
    let k = 0;
    for (const [start, len] of col.runs) {
      for (let i = start; i < start + len; i++) {
        ctx.hpMaxRef = col.column === "hp" ? (pool.hpMax[i] ?? 0) || 1 : 1;
        writeCode(pool, col.column, kind, i, codes[k++] ?? 0, ctx);
      }
    }
  }
  pool.count = delta.count;
}

/** Build a fresh replica from a snapshot. */
export function poolFromSnapshot(
  snap: SimSnapshot,
  maxHpMax: number,
  sys: SysSchema,
  capacity = Math.max(snap.count, 1),
): ModelPool {
  const pool: ModelPool = {
    capacity,
    count: snap.count,
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
    // §4A sys union: f32 | i32 | u8 storage; other widths widen (codec packs on the wire)
    const ctor: Float32ArrayConstructor | Int32ArrayConstructor | Uint8ArrayConstructor =
      type === "f32" || type === "f64" ? Float32Array : type === "u8" ? Uint8Array : Int32Array;
    pool.sys[name] = new ctor(capacity);
  }
  applySimDelta(
    pool,
    {
      sceneId: snap.sceneId,
      fromVersion: -1,
      toVersion: snap.version,
      count: snap.count,
      columns: snap.columns.map((c) => ({
        column: c.column,
        runs: [],
        values: c.values,
        fullResend: true,
      })),
    },
    maxHpMax,
    sys,
  );
  pool.count = snap.count;
  return pool;
}

// ─── faction projection (§5A) ─────────────────────────────────────────────────

/**
 * Filter a decoded delta to the models a faction may see (index-based,
 * computed once per faction per delta, not per user — §5A). Count is kept:
 * clients simply never receive updates for hidden indices.
 */
export function projectSimDelta(
  delta: SimDelta,
  keep: (idx: number) => boolean,
  sys: SysSchema,
): SimDelta {
  const columns: SimColumnDelta[] = [];
  for (const col of delta.columns) {
    const kind = colKind(col.column, sys);
    if (!kind) continue;
    const codes = unpackCodes(col.values, kind);
    const srcIdx: number[] = [];
    if (col.fullResend) {
      for (let i = 0; i < codes.length; i++) srcIdx.push(i);
    } else {
      for (const [start, len] of col.runs) {
        for (let i = start; i < start + len; i++) srcIdx.push(i);
      }
    }
    const keptIdx: number[] = [];
    const keptCodes: number[] = [];
    for (let k = 0; k < srcIdx.length; k++) {
      const idx = srcIdx[k] ?? -1;
      if (idx >= 0 && keep(idx)) {
        keptIdx.push(idx);
        keptCodes.push(codes[k] ?? 0);
      }
    }
    if (keptIdx.length === 0) continue;
    const runs: Array<readonly [number, number]> = [];
    for (const idx of keptIdx) {
      const last = runs[runs.length - 1];
      if (last && last[0] + last[1] === idx) {
        runs[runs.length - 1] = [last[0], last[1] + 1] as readonly [number, number];
      } else {
        runs.push([idx, 1] as readonly [number, number]);
      }
    }
    columns.push({
      column: col.column,
      runs,
      values: packCodes(keptCodes, kind),
      fullResend: false,
    });
  }
  return { ...delta, columns };
}

// ─── canonical hashing ────────────────────────────────────────────────────────

/**
 * §5A determinism hash over the CANONICAL (wire-quantized) pool state: the
 * live pool may hold sub-quantum float noise; identical logical states must
 * hash identically regardless. Round-trips through the snapshot codec first.
 */
export function canonicalPoolHash(pool: ModelPool, sys: SysSchema): string {
  const snap = snapshotFromPool(pool, "", 0, sys);
  const canonical = poolFromSnapshot(snap, 1, sys);
  return hashPool(canonical);
}

// ─── snapshot projection (§5A) ────────────────────────────────────────────────

/**
 * Filter a SimSnapshot to visible models while PRESERVING host indices
 * (unit modelRanges reference them). Hidden slots keep their index but carry
 * status |= ModelStatus.hidden and zeroed position/hp — nothing about an
 * undetected unit leaks. Later deltas overwrite those slots when the unit
 * becomes visible (§5A hidden-until-detected generates no enemy traffic).
 */
export function projectSimSnapshot(
  snapshot: SimSnapshot,
  keep: (idx: number) => boolean,
  sys: SysSchema,
): SimSnapshot {
  const columns: Array<{ column: string; values: Uint8Array }> = [];
  for (const col of snapshot.columns) {
    const kind = colKind(col.column, sys);
    if (!kind) continue;
    const codes = unpackCodes(col.values, kind);
    const out = new Array<number>(codes.length);
    for (let i = 0; i < codes.length; i++) {
      const visible = keep(i);
      if (visible) {
        out[i] = codes[i] ?? 0;
      } else if (col.column === "status") {
        out[i] = (codes[i] ?? 0) | ModelStatus.hidden;
      } else {
        out[i] = 0; // zeroed position/hp/etc for hidden slots
      }
    }
    columns.push({ column: col.column, values: packCodes(out, kind) });
  }
  return { ...snapshot, columns };
}
