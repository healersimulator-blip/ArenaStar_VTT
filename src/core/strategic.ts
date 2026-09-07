/**
 * §4A Strategic data model: Factions, Armies, embedded Units, Orders, Turns and
 * the ModelPool. Model state is NEVER Documents or per-model Ops: it lives in
 * the ModelPool (columnar typed arrays), changes only through the SimWorker,
 * and travels only as SimDelta / SimSnapshot binary frames (§5A).
 */
import type { BaseDocument, DocRef, Json, Ownership } from "./documents";
import type { DocId, UserId } from "./ids";

export interface Vec2 {
  x: number;
  y: number;
}

/** A "side" (§4A): { name, color, allies, ownership } — name/ownership inherited from BaseDocument. */
export interface FactionDocument extends BaseDocument {
  type: "faction";
  color: string;
  allies: DocId[];
}

/** System-defined unit profile (shape declared by the RulesModule). */
export type UnitProfile = Record<string, Json>;

export interface UnitStats {
  strength: number;
  morale: number;
  supply: number;
  fatigue: number;
  [key: string]: number;
}

/** Order union (§4A) — verbatim from the spec. */
export type Order =
  | { kind: "move"; path: Vec2[]; pace: "march" | "run" | "charge"; facing?: number }
  | { kind: "attack"; targetUnitId: DocId; mode?: string }
  | { kind: "hold"; stance: string }
  | { kind: "formation"; formation: string }
  | { kind: "retreat"; toward: Vec2 }
  | { kind: "supply"; action: string; targetId?: DocRef }
  | { kind: "custom"; type: string; data: unknown };

/** OrderQueue is a field of Unit, updated via ordinary Ops (§4A). */
export interface OrderQueue {
  pending: Order[];
  active?: Order;
  issuedBy: UserId;
  issuedTurn: number;
}

/** Embedded in armies[] (§4A). `type` is the system-defined unit type. */
export interface UnitDocument extends BaseDocument {
  profile: UnitProfile;
  leaderTokenId?: DocId;
  formation: string;
  sceneId: DocId | null;
  /** [start, count) index range into the scene's ModelPool, or null. */
  modelRange: readonly [number, number] | null;
  orders: OrderQueue;
  stats: UnitStats;
}

/** Army document with embedded units (§4A); ownership cascades to Units. */
export interface ArmyDocument extends BaseDocument {
  type: "army";
  factionId: DocId;
  commander: UserId[];
  supply: Record<string, Json>;
  units: UnitDocument[];
  ownership: Ownership;
}

export type TurnPhase = "orders" | "resolution" | "report";
export type TurnMode = "stepwise" | "realtime";

/** turns[] document (§4A). */
export interface TurnDocument extends BaseDocument {
  type: "turn";
  /** null = theatre-wide (§4A). */
  sceneId: DocId | null;
  number: number;
  phase: TurnPhase;
  mode: TurnMode;
  seed: number;
  readyUsers: UserId[];
  startedAt: number;
  checkpointRef: string | null;
  reportRef: string | null;
}

/** Status bitflags on ModelPool.status (§4A: dead, routed, pinned, engaged, hidden, …). */
export const ModelStatus = {
  dead: 1 << 0,
  routed: 1 << 1,
  pinned: 1 << 2,
  engaged: 1 << 3,
  hidden: 1 << 4,
} as const;

/** RulesModule-declared `sys` column types (§12 modelColumns). */
export type ModelColumnType = "f32" | "f64" | "i32" | "u32" | "i16" | "u16" | "i8" | "u8";

/**
 * ModelPool (§4A, verbatim): one per scene, owned by the SimWorker,
 * struct-of-arrays layout mandatory. Dead models are compacted at turn end.
 */
export interface ModelPool {
  capacity: number;
  count: number;
  /** Stable model id. */
  id: Uint32Array;
  /** Index into the units table. */
  unitIdx: Uint32Array;
  x: Float32Array;
  y: Float32Array;
  rot: Float32Array;
  hp: Float32Array;
  hpMax: Float32Array;
  status: Uint32Array;
  facing: Uint8Array;
  rank: Uint8Array;
  file: Uint8Array;
  /** RulesModule-declared columns (schema.modelColumns). */
  sys: Record<string, Float32Array | Int32Array | Uint8Array>;
  /** Free-list for dead/removed models. */
  free: Uint32Array;
  /** Stack top of `free` (bookkeeping; the spec sketch omits it, D-067). */
  freeTop: number;
}
