/**
 * §5A Simulation & turn model: PRNG, SimEvent/TurnReport/Checkpoint, the
 * SimDelta / SimSnapshot frame types (decoded form; wire framing is msgpack +
 * fflate, §5A), quantization constants and the TurnEngine state machine.
 */
import type { DocId, UserId } from "./ids";
import type { TurnMode } from "./strategic";
import type { Json } from "./documents";
import type { Vec2 } from "./strategic";

/** xoshiro128** interface; own implementation lands in src/sim (M2). Sub-streams fork per unit id (§5A). */
export interface PRNG {
  /** Next raw 32-bit unsigned integer. */
  nextU32(): number;
  /** Next float in [0, 1). */
  nextFloat(): number;
  /** Deterministic sub-stream (e.g. per unit id) so processing order cannot alter unit outcomes (§5A). */
  fork(substream: number): PRNG;
}

/** An event emitted during resolution; TurnReport is the ordered event list (§5A). */
export interface SimEvent {
  /** RulesModule sub-phase ("move" | "shoot" | "melee" | "morale" | "supply" | …). */
  subPhase: string;
  /** Event type, e.g. "attack", "casualty", "rout", "arrive". */
  type: string;
  unitId: DocId;
  targetUnitId?: DocId;
  /** Indices into the ModelPool; projected out per faction before broadcast. */
  modelIndices?: number[];
  at?: Vec2;
  /** Human-readable line (already player-safe after projection). */
  text: string;
  data?: Record<string, Json>;
}

/** Ordered turn result (§5A step 3): sub-phase ordered events + summaries. */
export interface TurnReport {
  turn: number;
  sceneId: DocId | null;
  /** Sub-phases in execution order (RulesModule-defined). */
  subPhases: string[];
  events: SimEvent[];
  /** e.g. { attacks: 342, hits: 121, savesFailed: 37 } (§11). */
  summary: Record<string, Json>;
  rulesVersion: string;
}

/** §8A checkpoint store entry; pool bytes are compressed ModelPool columns. */
export interface Checkpoint {
  sceneId: DocId;
  turnNumber: number;
  /** null in stepwise mode. */
  tick: number | null;
  pool: Uint8Array;
  unitStats: Record<string, Json>;
  seed: number;
  rulesVersion: string;
  /** Hex digest over raw ModelPool bytes — determinism proof (§5A replay test). */
  hash: string;
}

// ─── SimDelta / SimSnapshot (§5A) ─────────────────────────────────────────────

/** Quantization: positions int16 in grid units / 16. */
export const SIM_POS_QUANTUM = 16;
/** Quantization: hp uint16 in permille of hpMax. */
export const SIM_HP_PERMILLE = 1000;
/** Full column resend threshold (§5A). */
export const SIM_FULL_RESEND_THRESHOLD = 0.6;

/** One changed column: RLE of changed model indices + packed quantized values. */
export interface SimColumnDelta {
  /** Base ("x","hp","status",…) or "sys.<name>". */
  column: string;
  /** [start, len) runs; empty when fullResend. */
  runs: Array<readonly [number, number]>;
  values: Uint8Array;
  fullResend: boolean;
}

/** Decoded incremental frame; clients apply strictly sequentially, requesting sim.snapshot on a gap (§5A). */
export interface SimDelta {
  sceneId: DocId;
  fromVersion: number;
  toVersion: number;
  /** Pool count after applying. */
  count: number;
  columns: SimColumnDelta[];
}

/** Decoded full-state frame: all columns (§5A). */
export interface SimSnapshot {
  sceneId: DocId;
  version: number;
  count: number;
  columns: Array<{ column: string; values: Uint8Array }>;
}

// ─── TurnEngine state machine (§5A) ───────────────────────────────────────────

export type TurnEngineState =
  | { phase: "idle"; sceneId: DocId | null }
  | {
      phase: "orders";
      turnId: DocId;
      turnNumber: number;
      mode: TurnMode;
      deadline: number | null;
      readyUsers: ReadonlySet<UserId>;
      /** Campaign seed (advance derives the per-turn seed). Additive (D-068). */
      seed: number;
      /** Realtime clock config while running (paused carries its own). */
      realtime?: RealtimeClockConfig | undefined;
    }
  | {
      phase: "resolution";
      turnId: DocId;
      turnNumber: number;
      mode: TurnMode;
      startedAt: number;
      /** Campaign seed (additive, D-068). */
      seed: number;
    }
  | {
      phase: "report";
      turnId: DocId;
      turnNumber: number;
      mode: TurnMode;
      /** Campaign seed (additive, D-068). */
      seed: number;
    }
  /** Realtime mode only (§5A pause). */
  | {
      phase: "paused";
      turnId: DocId;
      turnNumber: number;
      tick: number;
      config: RealtimeClockConfig;
      /** Campaign seed carried across pause (additive, D-068). */
      seed: number;
    };

export type TurnEngineInput =
  | { type: "turn.start"; sceneId: DocId | null; mode: TurnMode; seed: number }
  | { type: "turn.ready"; user: UserId; ready: boolean }
  | { type: "turn.advance" }
  | { type: "sim.resolved" }
  | { type: "turn.next" }
  | { type: "turn.undo" }
  | { type: "deadline.set"; deadline: number | null }
  | { type: "sim.pause" }
  | { type: "sim.resume" }
  | { type: "sim.rate"; hz: number }
  | { type: "scene.change"; sceneId: DocId | null };

/** Host tick loop rates (§5A pseudo-realtime; defaults shown). */
export interface RealtimeClockConfig {
  simHz: number;
  reportHz: number;
  /** Network flush rate; deltas coalesced per flush. */
  flushHz: number;
  checkpointEveryTicks: number;
}

export const DEFAULT_REALTIME_CONFIG: RealtimeClockConfig = {
  simHz: 5,
  reportHz: 1,
  flushHz: 5,
  checkpointEveryTicks: 300,
};
