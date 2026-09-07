import { describe, expect, it } from "vitest";
import { ReplayEngine } from "../../src/sim/replay";
import type { CheckpointRecord } from "../../src/storage/strategicStore";
import { encodeSimSnapshot } from "../../src/sim/codec";

describe("After-Action Replay (§8A)", () => {
  it("loads checkpoints, steps through turns, and decodes ModelPool frames", () => {
    // Construct fake snapshot pool bytes
    const snap = {
      sceneId: "scene-1",
      version: 1,
      count: 2,
      columns: [
        { column: "x", values: new Uint8Array([10, 0, 20, 0]) },
        { column: "y", values: new Uint8Array([10, 0, 20, 0]) },
        { column: "hp", values: new Uint8Array([232, 3, 232, 3]) },
        { column: "status", values: new Uint8Array([0, 0, 0, 0]) },
      ],
    };
    const poolBytes = encodeSimSnapshot(snap, 10);

    const cp1: CheckpointRecord = {
      worldId: "w1",
      sceneId: "scene-1",
      slot: 1,
      turnNumber: 1,
      tick: null,
      pool: poolBytes,
      maxHpMax: 10,
      version: 1,
      unitStats: {},
      seed: 100,
      rulesVersion: "1.0.0",
      hash: "hash1",
    };

    const cp2: CheckpointRecord = {
      worldId: "w1",
      sceneId: "scene-1",
      slot: 2,
      turnNumber: 2,
      tick: null,
      pool: poolBytes,
      maxHpMax: 10,
      version: 2,
      unitStats: {},
      seed: 100,
      rulesVersion: "1.0.0",
      hash: "hash2",
    };

    const engine = new ReplayEngine({});
    engine.load([cp1, cp2]);

    expect(engine.count).toBe(2);

    const f1 = engine.getState().frame;
    expect(f1?.turnNumber).toBe(1);
    expect(f1?.pool.count).toBe(2);

    engine.stepForward();
    const f2 = engine.getState().frame;
    expect(f2?.turnNumber).toBe(2);
    expect(f2?.hash).toBe("hash2");

    engine.seek(0);
    expect(engine.getState().index).toBe(0);
  });
});
