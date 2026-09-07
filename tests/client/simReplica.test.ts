import { describe, expect, test } from "vitest";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus } from "../../src/core/events";
import { channelFor, deframeMessage, frameMessage } from "../../src/net/frame";
import type { StoreMeta } from "../../src/core";
import { allocModel, createModelPool } from "../../src/sim/pool";
import type { ModelPool } from "../../src/core/strategic";
import type { SimDelta } from "../../src/core/sim";
import {
  applySimDelta,
  diffPools,
  encodeSimDelta,
  encodeSimSnapshot,
  poolFromSnapshot,
  snapshotFromPool,
} from "../../src/sim/codec";
import { MASS_BATTLE_SCHEMA_COLUMNS } from "../../src/packages/massBattleBasic";

const meta: StoreMeta = {
  worldId: "wc",
  name: "C",
  system: "mass-battle-basic",
  systemVersion: "1",
};
const SYS = MASS_BATTLE_SCHEMA_COLUMNS;
const SCENE = "sc-9";

function poolAt(n: number, x: number, ammo = 3): ModelPool {
  const pool = createModelPool(n, SYS);
  for (let i = 0; i < n; i++) {
    allocModel(pool, { id: i + 1, unitIdx: 0, x: x + i, y: 0, hp: 1, hpMax: 1, sys: { ammo } });
  }
  return pool;
}

function deltaOf(from: ModelPool, to: ModelPool, fromVersion: number, toVersion: number): SimDelta {
  return { ...diffPools(from, to, SCENE, SYS), fromVersion, toVersion };
}

function hostSend(host: ReturnType<typeof createTransportPair>["a"], msg: unknown): void {
  const kind = (msg as { kind: string }).kind;
  host.send(channelFor(kind as never), frameMessage(msg as never));
}

function makeClient(): {
  client: ClientSync;
  host: ReturnType<typeof createTransportPair>["a"];
  hostGot: unknown[];
  events: string[];
} {
  const pair = createTransportPair();
  const bus = createEventBus<ClientEvents>();
  const client = new ClientSync({ transport: pair.b, bus, meta, simSys: SYS, simSceneId: SCENE });
  const hostGot: unknown[] = [];
  const events: string[] = [];
  pair.a.onMessage = (_channel, bytes) => {
    const r = deframeMessage(bytes);
    if (r.ok) hostGot.push(r.value);
  };
  bus.on("sim", (e) => events.push(`${e.kind}:${e.version}`));
  return { client, host: pair.a, hostGot, events };
}

describe("ClientSync sim replica (§8A/§5A)", () => {
  test("gap queues the delta and requests one snapshot; snapshot + replay land", async () => {
    const { client, host, hostGot, events } = makeClient();
    const v0 = poolAt(4, 0);
    const v1 = poolAt(4, 10);
    const d1 = deltaOf(v0, v1, 0, 1);

    // first sim frame with no replica = gap
    hostSend(host, {
      kind: "sim.delta",
      sceneId: SCENE,
      from: 0,
      to: 1,
      bytes: encodeSimDelta(d1, 1),
    });
    await flushMicrotasks();
    expect(client.simReplica).toBeNull();
    expect(client.simReplicaVersion).toBe(-1);
    // exactly one snapshot.get went out
    const gets = hostGot.filter((m) => (m as { kind: string }).kind === "sim.snapshot.get");
    expect(gets).toHaveLength(1);

    // a second gapped delta queues WITHOUT re-requesting
    const v2 = poolAt(4, 20);
    hostSend(host, {
      kind: "sim.delta",
      sceneId: SCENE,
      from: 1,
      to: 2,
      bytes: encodeSimDelta(deltaOf(v1, v2, 1, 2), 1),
    });
    await flushMicrotasks();
    expect(hostGot.filter((m) => (m as { kind: string }).kind === "sim.snapshot.get")).toHaveLength(
      1,
    );

    // snapshot at version 0 arrives → replica installs, both deltas replay in order
    hostSend(host, {
      kind: "sim.snapshot",
      sceneId: SCENE,
      version: 0,
      bytes: encodeSimSnapshot(snapshotFromPool(v0, SCENE, 0, SYS), 1),
    });
    await flushMicrotasks();
    expect(client.simReplicaVersion).toBe(2);
    expect(client.simReplica?.x[0] ?? 0).toBeGreaterThanOrEqual(20 - 1 / 16);
    expect(events).toEqual(["snapshot:0", "delta:1", "delta:2"]);
  });

  test("stale delta after a snapshot resync (undo) is dropped", async () => {
    const { client, host } = makeClient();
    const v0 = poolAt(4, 0);
    const v1 = poolAt(4, 5);
    const d1 = deltaOf(v0, v1, 0, 1);

    hostSend(host, {
      kind: "sim.snapshot",
      sceneId: SCENE,
      version: 0,
      bytes: encodeSimSnapshot(snapshotFromPool(v0, SCENE, 0, SYS), 1),
    });
    await flushMicrotasks();
    hostSend(host, {
      kind: "sim.delta",
      sceneId: SCENE,
      from: 0,
      to: 1,
      bytes: encodeSimDelta(d1, 1),
    });
    await flushMicrotasks();
    expect(client.simReplicaVersion).toBe(1);

    // host undoes the turn: snapshot resync to version 0, then a stale delta(1→2) races in
    hostSend(host, {
      kind: "sim.snapshot",
      sceneId: SCENE,
      version: 0,
      bytes: encodeSimSnapshot(snapshotFromPool(v0, SCENE, 0, SYS), 1),
    });
    await flushMicrotasks();
    hostSend(host, {
      kind: "sim.delta",
      sceneId: SCENE,
      from: 1,
      to: 2,
      bytes: encodeSimDelta(deltaOf(v1, v0, 1, 2), 1),
    });
    await flushMicrotasks();
    expect(client.simReplicaVersion).toBe(0);
    expect(client.simReplica?.x[0] ?? -1).toBeLessThan(1); // original position, not the stale replay
  });

  test("replica matches a direct codec apply of the same frames", async () => {
    const { client, host } = makeClient();
    const v0 = poolAt(8, 0, 3);
    const v1 = poolAt(8, 3, 1);
    const d1 = deltaOf(v0, v1, 0, 1);

    hostSend(host, {
      kind: "sim.snapshot",
      sceneId: SCENE,
      version: 0,
      bytes: encodeSimSnapshot(snapshotFromPool(v0, SCENE, 0, SYS), 1),
    });
    await flushMicrotasks();
    hostSend(host, {
      kind: "sim.delta",
      sceneId: SCENE,
      from: 0,
      to: 1,
      bytes: encodeSimDelta(d1, 1),
    });
    await flushMicrotasks();

    const reference = poolFromSnapshot(snapshotFromPool(v0, SCENE, 0, SYS), 1, SYS);
    applySimDelta(reference, d1, 1, SYS);
    for (let i = 0; i < 8; i++) {
      expect(client.simReplica?.x[i] ?? -99).toBeCloseTo(reference.x[i] ?? -99, 4);
      expect(client.simReplica?.sys.ammo?.[i] ?? -1).toBe(reference.sys.ammo?.[i] ?? -1);
    }
    expect(client.simReplicaVersion).toBe(1);
  });
});
