/**
 * §5A TurnEngine state machine (host, main thread) — drives phases; the
 * SimWorker executes resolution. Pure reducer: every side effect is returned
 * as an explicit effect the host (HostSync ⇄ SimWorker bridge) interprets.
 */
import type { DocId } from "../core/ids";
import type { RealtimeClockConfig, TurnEngineInput, TurnEngineState } from "../core/sim";
import { DEFAULT_REALTIME_CONFIG } from "../core/sim";

/** Effects the host must perform when a transition fires (§5A steps 2–5). */
export type TurnEngineEffect =
  /** Freeze orders (further order Ops rejected "phase_locked") + write Checkpoint N. */
  | { type: "checkpoint"; turnId: DocId; turnNumber: number }
  /** Post {checkpoint, orders, seed, rulesVersion} to the SimWorker. */
  | { type: "resolve"; turnId: DocId; turnNumber: number; seed: number }
  /** Create the next Turn document, phase "orders". */
  | { type: "newTurn"; turnNumber: number; seed: number }
  /** Turn-level undo: restore Checkpoint N, re-open "orders", orders intact. */
  | { type: "restoreCheckpoint"; turnNumber: number }
  /** Realtime: checkpoint on pause / scene change (§5A). */
  | { type: "realtimeCheckpoint"; turnNumber: number; tick: number }
  /** Input rejected; reasons are protocol strings (e.g. "phase_locked"). */
  | { type: "reject"; input: TurnEngineInput["type"]; reason: string };

export interface TurnEngineStep {
  state: TurnEngineState;
  effects: TurnEngineEffect[];
}

const reject = (
  state: TurnEngineState,
  input: TurnEngineInput["type"],
  reason: string,
): TurnEngineStep => ({
  state,
  effects: [{ type: "reject", input, reason }],
});

/** Deterministic per-turn seed from the campaign seed (§5A: seeded per turn). */
export function turnSeed(initialSeed: number, turnNumber: number): number {
  return (initialSeed + Math.imul(turnNumber, 0x9e3779b9)) >>> 0;
}

/** Deterministic per-tick seed inside a realtime turn (§5A: replayable). */
export function tickSeed(initialSeed: number, turnNumber: number, tick: number): number {
  return (turnSeed(initialSeed, turnNumber) + Math.imul(tick + 1, 0x632be59b)) >>> 0;
}

/** Order Ops are accepted only in phase "orders" (§5A step 2). */
export function canAcceptOrderOps(state: TurnEngineState): boolean {
  return state.phase === "orders";
}

/** Current turn number for UI surfaces; 0 when idle. */
export function currentTurnNumber(state: TurnEngineState): number {
  return state.phase === "idle" ? 0 : state.turnNumber;
}

let turnIdCounter = 0;
function newTurnId(sceneId: DocId | null, turnNumber: number): DocId {
  turnIdCounter += 1;
  return `turn_${sceneId ?? "all"}_${turnNumber}_${turnIdCounter}`;
}

function isRealtime(state: TurnEngineState): boolean {
  if (state.phase === "paused") return true;
  if (state.phase === "idle") return false;
  return state.mode === "realtime";
}

function configOf(state: TurnEngineState): RealtimeClockConfig {
  if (state.phase === "paused") return state.config;
  if (state.phase === "orders" && state.mode === "realtime") {
    return state.realtime ?? DEFAULT_REALTIME_CONFIG;
  }
  return DEFAULT_REALTIME_CONFIG;
}

/**
 * Advance the state machine. `now` (ms epoch) stamps transitions; `tick` is
 * the current realtime tick index for pause/scene checkpoints.
 */
export function turnEngineReduce(
  state: TurnEngineState,
  input: TurnEngineInput,
  now = 0,
  tick = 0,
): TurnEngineStep {
  switch (input.type) {
    case "turn.start": {
      if (state.phase !== "idle") return reject(state, input.type, "turn_active");
      const turnNumber = 1;
      const seed = turnSeed(input.seed, turnNumber);
      return {
        state: {
          phase: "orders",
          turnId: newTurnId(input.sceneId, turnNumber),
          turnNumber,
          mode: input.mode,
          deadline: null,
          readyUsers: new Set(),
          seed: input.seed,
          ...(input.mode === "realtime" ? { realtime: DEFAULT_REALTIME_CONFIG } : {}),
        },
        effects: [{ type: "newTurn", turnNumber, seed }],
      };
    }

    case "turn.advance": {
      if (state.phase === "resolution") return reject(state, input.type, "phase_locked");
      if (state.phase !== "orders") return reject(state, input.type, "not_in_orders");
      return {
        state: {
          phase: "resolution",
          turnId: state.turnId,
          turnNumber: state.turnNumber,
          mode: state.mode,
          startedAt: now,
          seed: state.seed,
        },
        effects: [
          { type: "checkpoint", turnId: state.turnId, turnNumber: state.turnNumber },
          {
            type: "resolve",
            turnId: state.turnId,
            turnNumber: state.turnNumber,
            seed: turnSeed(state.seed, state.turnNumber),
          },
        ],
      };
    }

    case "sim.resolved": {
      if (state.phase !== "resolution") return reject(state, input.type, "not_in_resolution");
      return {
        state: {
          phase: "report",
          turnId: state.turnId,
          turnNumber: state.turnNumber,
          mode: state.mode,
          seed: state.seed,
        },
        effects: [],
      };
    }

    case "turn.next": {
      if (state.phase !== "report") return reject(state, input.type, "not_in_report");
      const turnNumber = state.turnNumber + 1;
      const seed = turnSeed(state.seed, turnNumber);
      return {
        state: {
          phase: "orders",
          turnId: newTurnId(null, turnNumber),
          turnNumber,
          mode: state.mode,
          deadline: null,
          readyUsers: new Set(),
          seed: state.seed,
          ...(state.mode === "realtime" ? { realtime: DEFAULT_REALTIME_CONFIG } : {}),
        },
        effects: [{ type: "newTurn", turnNumber, seed }],
      };
    }

    case "turn.undo": {
      if (state.phase === "idle") return reject(state, input.type, "idle");
      if (state.phase === "resolution") return reject(state, input.type, "phase_locked");
      // §5A: restore Checkpoint N, re-open "orders" with previous orders intact
      // (orders live in Unit documents and were never touched by resolution).
      if (state.phase === "paused") {
        return {
          state: {
            phase: "orders",
            turnId: state.turnId,
            turnNumber: state.turnNumber,
            mode: "realtime",
            deadline: null,
            readyUsers: new Set(),
            seed: state.seed,
            realtime: state.config,
          },
          effects: [{ type: "restoreCheckpoint", turnNumber: state.turnNumber }],
        };
      }
      return {
        state: {
          phase: "orders",
          turnId: state.turnId,
          turnNumber: state.turnNumber,
          mode: state.mode,
          deadline: null,
          readyUsers: new Set(),
          seed: state.seed,
        },
        effects: [{ type: "restoreCheckpoint", turnNumber: state.turnNumber }],
      };
    }

    case "turn.ready": {
      if (state.phase !== "orders") return reject(state, input.type, "not_in_orders");
      const readyUsers = new Set(state.readyUsers);
      if (input.ready) readyUsers.add(input.user);
      else readyUsers.delete(input.user);
      return { state: { ...state, readyUsers }, effects: [] };
    }

    case "deadline.set": {
      if (state.phase !== "orders") return reject(state, input.type, "not_in_orders");
      return { state: { ...state, deadline: input.deadline }, effects: [] };
    }

    case "sim.pause": {
      if (state.phase !== "orders" || state.mode !== "realtime") {
        return reject(state, input.type, "not_realtime");
      }
      return {
        state: {
          phase: "paused",
          turnId: state.turnId,
          turnNumber: state.turnNumber,
          tick,
          config: configOf(state),
          seed: state.seed,
        },
        effects: [{ type: "realtimeCheckpoint", turnNumber: state.turnNumber, tick }],
      };
    }

    case "sim.resume": {
      if (state.phase !== "paused") return reject(state, input.type, "not_paused");
      return {
        state: {
          phase: "orders",
          turnId: state.turnId,
          turnNumber: state.turnNumber,
          mode: "realtime",
          deadline: null,
          readyUsers: new Set(),
          seed: state.seed,
          realtime: state.config,
        },
        effects: [],
      };
    }

    case "sim.rate": {
      if (state.phase === "paused") {
        const config: RealtimeClockConfig = {
          ...state.config,
          simHz: input.hz,
          flushHz: Math.min(input.hz, state.config.flushHz),
        };
        return { state: { ...state, config }, effects: [] };
      }
      if (state.phase === "orders" && state.mode === "realtime") {
        return {
          state: {
            ...state,
            realtime: { ...(state.realtime ?? DEFAULT_REALTIME_CONFIG), simHz: input.hz },
          },
          effects: [],
        };
      }
      return reject(state, input.type, "not_realtime");
    }

    case "scene.change": {
      if (state.phase === "idle") return { state, effects: [] };
      const effects: TurnEngineEffect[] = isRealtime(state)
        ? [{ type: "realtimeCheckpoint", turnNumber: currentTurnNumber(state), tick }]
        : [];
      return { state: { phase: "idle", sceneId: input.sceneId }, effects };
    }
  }
}
