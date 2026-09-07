import { describe, expect, test } from "vitest";
import type { TurnEngineInput, TurnEngineState } from "../../src/core/sim";
import {
  canAcceptOrderOps,
  currentTurnNumber,
  turnEngineReduce,
  turnSeed,
} from "../../src/host/turnEngine";

const idle = (sceneId: string | null = null): TurnEngineState => ({ phase: "idle", sceneId });

const step = (state: TurnEngineState, input: TurnEngineInput): TurnEngineState => {
  const out = turnEngineReduce(state, input);
  // every input must be accepted or explicitly rejected — never both silent
  expect(out.state).toBeDefined();
  return out.state;
};

describe("TurnEngine state machine (§5A)", () => {
  test("full stepwise cycle: start → orders → advance → resolution → resolved → report → next", () => {
    let s = idle();
    s = step(s, { type: "turn.start", sceneId: "scene-1", mode: "stepwise", seed: 42 });
    expect(s.phase).toBe("orders");
    if (s.phase !== "orders") return;
    expect(s.turnNumber).toBe(1);
    expect(canAcceptOrderOps(s)).toBe(true);

    const adv = turnEngineReduce(s, { type: "turn.advance" });
    expect(adv.state.phase).toBe("resolution");
    expect(adv.effects).toEqual([
      { type: "checkpoint", turnId: s.turnId, turnNumber: 1 },
      { type: "resolve", turnId: s.turnId, turnNumber: 1, seed: turnSeed(42, 1) },
    ]);
    expect(canAcceptOrderOps(adv.state)).toBe(false);

    const res = turnEngineReduce(adv.state, { type: "sim.resolved" });
    expect(res.state.phase).toBe("report");

    const next = turnEngineReduce(res.state, { type: "turn.next" });
    expect(next.state.phase).toBe("orders");
    expect(next.state.phase === "orders" && next.state.turnNumber).toBe(2);
    expect(next.effects).toContainEqual({ type: "newTurn", turnNumber: 2, seed: turnSeed(42, 2) });
  });

  test("order ops are rejected with phase_locked during resolution", () => {
    let s = idle();
    s = step(s, { type: "turn.start", sceneId: null, mode: "stepwise", seed: 1 });
    s = step(s, { type: "turn.advance" });
    const out = turnEngineReduce(s, { type: "turn.advance" });
    expect(out.effects).toContainEqual({
      type: "reject",
      input: "turn.advance",
      reason: "phase_locked",
    });
    expect(canAcceptOrderOps(s)).toBe(false);
  });

  test("advance outside orders is rejected", () => {
    const out = turnEngineReduce(idle(), { type: "turn.advance" });
    expect(out.effects).toContainEqual({
      type: "reject",
      input: "turn.advance",
      reason: "not_in_orders",
    });
  });

  test("turn.start while active is rejected", () => {
    const s = step(idle(), { type: "turn.start", sceneId: null, mode: "stepwise", seed: 1 });
    const out = turnEngineReduce(s, {
      type: "turn.start",
      sceneId: null,
      mode: "stepwise",
      seed: 2,
    });
    expect(out.effects).toContainEqual({
      type: "reject",
      input: "turn.start",
      reason: "turn_active",
    });
  });

  test("ready toggles per user; deadline settable only in orders", () => {
    let s = step(idle(), { type: "turn.start", sceneId: null, mode: "stepwise", seed: 3 });
    s = step(s, { type: "turn.ready", user: "u1", ready: true });
    s = step(s, { type: "turn.ready", user: "u2", ready: true });
    s = step(s, { type: "turn.ready", user: "u1", ready: false });
    if (s.phase !== "orders") throw new Error("expected orders");
    expect([...s.readyUsers]).toEqual(["u2"]);
    s = step(s, { type: "deadline.set", deadline: 12345 });
    if (s.phase !== "orders") throw new Error("expected orders");
    expect(s.deadline).toBe(12345);
    const res = turnEngineReduce(s, { type: "deadline.set", deadline: 1 });
    void res; // accepted in orders
    const after = step(s, { type: "turn.advance" });
    const rej = turnEngineReduce(after, { type: "deadline.set", deadline: 1 });
    expect(rej.effects).toContainEqual({
      type: "reject",
      input: "deadline.set",
      reason: "not_in_orders",
    });
  });

  test("turn.undo from report restores checkpoint and reopens orders", () => {
    let s = idle();
    s = step(s, { type: "turn.start", sceneId: null, mode: "stepwise", seed: 9 });
    s = step(s, { type: "turn.advance" });
    s = step(s, { type: "sim.resolved" });
    const out = turnEngineReduce(s, { type: "turn.undo" });
    expect(out.state.phase).toBe("orders");
    expect(out.state.phase === "orders" && out.state.turnNumber).toBe(1);
    expect(out.effects).toContainEqual({ type: "restoreCheckpoint", turnNumber: 1 });
  });

  test("realtime: pause checkpoints and carries config+seed; resume restores", () => {
    const s = step(idle(), { type: "turn.start", sceneId: "sc", mode: "realtime", seed: 7 });
    const paused = turnEngineReduce(s, { type: "sim.pause" }, 1000, 55);
    expect(paused.state.phase).toBe("paused");
    expect(paused.effects).toContainEqual({ type: "realtimeCheckpoint", turnNumber: 1, tick: 55 });
    const rated = turnEngineReduce(paused.state, { type: "sim.rate", hz: 10 });
    if (rated.state.phase !== "paused") throw new Error("expected paused");
    expect(rated.state.config.simHz).toBe(10);
    const resumed = turnEngineReduce(rated.state, { type: "sim.resume" });
    expect(resumed.state.phase).toBe("orders");
    if (resumed.state.phase !== "orders" || resumed.state.mode !== "realtime")
      throw new Error("expected realtime orders");
    expect(resumed.state.realtime?.simHz).toBe(10);
    expect(resumed.state.seed).toBe(7);
  });

  test("pause in stepwise is rejected", () => {
    const s = step(idle(), { type: "turn.start", sceneId: null, mode: "stepwise", seed: 1 });
    const out = turnEngineReduce(s, { type: "sim.pause" });
    expect(out.effects).toContainEqual({
      type: "reject",
      input: "sim.pause",
      reason: "not_realtime",
    });
  });

  test("scene.change resets to idle (realtime checkpoints first)", () => {
    const s = step(idle(), { type: "turn.start", sceneId: "a", mode: "realtime", seed: 1 });
    const out = turnEngineReduce(s, { type: "scene.change", sceneId: "b" }, 0, 77);
    expect(out.state.phase).toBe("idle");
    expect(out.effects).toContainEqual({ type: "realtimeCheckpoint", turnNumber: 1, tick: 77 });
    expect(currentTurnNumber(out.state)).toBe(0);
  });

  test("per-turn seeds are deterministic and distinct", () => {
    expect(turnSeed(42, 1)).toBe(turnSeed(42, 1));
    expect(turnSeed(42, 1)).not.toBe(turnSeed(42, 2));
    expect(turnSeed(42, 3)).not.toBe(turnSeed(43, 3));
  });
});
