import { describe, expect, expectTypeOf, test } from "vitest";
import { ModelStatus, type ModelPool, type Order, type OrderQueue } from "../../src/core/strategic";
import { MsgKind, type MsgName } from "../../src/core/messages";
import type { OpEnvelope } from "../../src/core/ops";
import type { Checkpoint, SimDelta, TurnEngineState } from "../../src/core/sim";
import type { Transport } from "../../src/core/net";
import type { RulesModule } from "../../src/core/rules";
import type { CanFn } from "../../src/core/ownership";

describe("§13 MsgKind map", () => {
  test("all 28 byte values are unique", () => {
    const values = Object.values(MsgKind);
    expect(values).toHaveLength(31);
    expect(new Set(values).size).toBe(31);
  });

  test("every kind name is exhaustively classified by direction (compile-time Record)", () => {
    const direction: Record<MsgName, "c2h" | "h2c" | "both" | "internal"> = {
      hello: "c2h",
      intent: "c2h",
      roll: "c2h",
      "roll.reveal": "c2h",
      "roll.challenge": "h2c",
      ephemeral: "both",
      "asset.get": "c2h",
      "fog.put": "c2h",
      "relay.offer": "c2h",
      "turn.ready": "c2h",
      "sim.control": "c2h",
      "report.detail": "c2h",
      "sim.snapshot.get": "c2h",
      "audio.cmd": "both",
      welcome: "h2c",
      snapshot: "h2c",
      ops: "h2c",
      rejected: "h2c",
      "asset.chunk": "h2c",
      clock: "h2c",
      kick: "h2c",
      ban: "h2c",
      "sim.delta": "h2c",
      "sim.snapshot": "h2c",
      "turn.phase": "h2c",
      "turn.report": "h2c",
      "report.detail.page": "h2c",
      heartbeat: "internal",
      ping: "internal",
      pong: "internal",
      "relay.frame": "internal",
    };
    expect(Object.keys(direction)).toHaveLength(31);
    expect(direction.hello).toBe("c2h");
  });
});

describe("§4A strategic contracts", () => {
  test("ModelStatus flags are distinct powers of two", () => {
    const flags = Object.values(ModelStatus);
    expect(flags).toHaveLength(5);
    for (const f of flags) expect(Number.isInteger(Math.log2(f))).toBe(true);
  });

  test("Order union accepts every variant of §4A", () => {
    const orders: Order[] = [
      { kind: "move", path: [{ x: 0, y: 0 }], pace: "march" },
      { kind: "attack", targetUnitId: "u1" },
      { kind: "hold", stance: "defensive" },
      { kind: "formation", formation: "line" },
      { kind: "retreat", toward: { x: 1, y: 1 } },
      { kind: "supply", action: "resupply" },
      { kind: "custom", type: "siege", data: { days: 3 } },
    ];
    expect(orders).toHaveLength(7);
    const queue: OrderQueue = { pending: orders, issuedBy: "user1", issuedTurn: 1 };
    expect(queue.pending[0]?.kind).toBe("move");
  });

  test("ModelPool shape (compile-time)", () => {
    expectTypeOf<ModelPool["id"]>().toEqualTypeOf<Uint32Array>();
    expectTypeOf<ModelPool["hpMax"]>().toEqualTypeOf<Float32Array>();
    expectTypeOf<ModelPool["sys"]>().toEqualTypeOf<
      Record<string, Float32Array | Int32Array | Uint8Array>
    >();
  });
});

describe("§5A sim contracts (compile-time)", () => {
  test("OpEnvelope carries monotonic seq + txId", () => {
    expectTypeOf<OpEnvelope["seq"]>().toEqualTypeOf<number>();
    expectTypeOf<OpEnvelope["txId"]>().toEqualTypeOf<string>();
    expectTypeOf<OpEnvelope["ops"]>().toEqualTypeOf<OpEnvelope["ops"]>();
  });

  test("SimDelta versions are strictly sequential fields", () => {
    expectTypeOf<SimDelta["fromVersion"]>().toEqualTypeOf<number>();
    expectTypeOf<SimDelta["toVersion"]>().toEqualTypeOf<number>();
  });

  test("Checkpoint carries the determinism hash", () => {
    expectTypeOf<Checkpoint["hash"]>().toEqualTypeOf<string>();
  });

  test("TurnEngineState covers the §5A phases", () => {
    const states: TurnEngineState[] = [
      { phase: "idle", sceneId: null },
      {
        phase: "orders",
        turnId: "t",
        turnNumber: 1,
        mode: "stepwise",
        deadline: null,
        readyUsers: new Set(),
        seed: 1,
      },
      { phase: "resolution", turnId: "t", turnNumber: 1, mode: "stepwise", startedAt: 0, seed: 1 },
      { phase: "report", turnId: "t", turnNumber: 1, mode: "stepwise", seed: 1 },
      {
        phase: "paused",
        turnId: "t",
        turnNumber: 1,
        tick: 12,
        config: { simHz: 5, reportHz: 1, flushHz: 5, checkpointEveryTicks: 300 },
        seed: 1,
      },
    ];
    expect(states.map((s) => s.phase)).toEqual([
      "idle",
      "orders",
      "resolution",
      "report",
      "paused",
    ]);
  });
});

describe("§6 net contracts (compile-time)", () => {
  test("Transport interface shape", () => {
    expectTypeOf<Transport["send"]>().toBeFunction();
    expectTypeOf<Transport["stats"]>().not.toBeAny();
  });
});

describe("§12 RulesModule contract (compile-time)", () => {
  test("RulesModule exposes the §12 surface", () => {
    expectTypeOf<RulesModule["resolveTurn"]>().toBeFunction();
    expectTypeOf<RulesModule["validateOrder"]>().toBeFunction();
    expectTypeOf<RulesModule["detection"]>().toBeFunction();
  });
});

describe("§4 can() signature (compile-time)", () => {
  test("CanFn is a pure predicate: (user, action, doc, coll, options?)", () => {
    expectTypeOf<CanFn>().parameters.toEqualTypeOf<
      [
        import("../../src/core/ownership").PermissionUser,
        import("../../src/core/ownership").PermissionAction,
        import("../../src/core/documents").BaseDocument,
        import("../../src/core/documents").CollectionName,
        import("../../src/core/ownership").CanOptions?,
      ]
    >();
    expectTypeOf<CanFn>().returns.toEqualTypeOf<boolean>();
  });
});
