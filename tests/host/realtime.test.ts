import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "vitest";
import type { IDBPDatabase } from "idb";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import { SimBridge } from "../../src/host/simBridge";
import { TurnChannel, type RealtimeDriver } from "../../src/host/turnChannel";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { MASS_BATTLE_SCHEMA_COLUMNS } from "../../src/packages/massBattleBasic";
import { openVttDb } from "../../src/storage/idb";
import { listCheckpoints } from "../../src/storage/strategicStore";
import { applySimDelta, mergeSimDeltas } from "../../src/sim/codec";
import { createModelPool, allocModel } from "../../src/sim/pool";
import type { ArmyDocument, FactionDocument, UnitDocument } from "../../src/core/strategic";
import type { SceneDocument, UserDocument } from "../../src/core/documents";
import type { SimDeltaMsg, TurnPhaseMsg, TurnReportMsg } from "../../src/core/messages";
import type { SimEvent } from "../../src/core/sim";
import type { Op } from "../../src/core/ops";

// Unique world per setup(): §8A checkpoints live in the shared test IDB.
let worldCounter = 0;

const GM_ID = "gm-key";
const PLAYER_ID = "pl-key";
const SCENE_ID = "sc-1";

const dbs: IDBPDatabase[] = [];
afterAll(() => {
  for (const d of dbs) d.close();
});

function sceneDoc(): SceneDocument {
  return {
    _id: SCENE_ID,
    type: "scene",
    name: "Field",
    ownership: { default: 2 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 2000,
    height: 2000,
    darkness: 0,
    grid: {
      type: "square",
      size: 100,
      distance: 5,
      units: "ft",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
  };
}

function unit(id: string, modelRange: [number, number]): UnitDocument {
  return {
    _id: id,
    type: "infantry",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    profile: {},
    formation: "line",
    sceneId: SCENE_ID,
    modelRange,
    orders: {
      pending: [{ kind: "move", path: [{ x: 800, y: 800 }], pace: "march" }],
      issuedBy: GM_ID,
      issuedTurn: 0,
    },
    stats: { strength: 10, morale: 3, supply: 1, fatigue: 0 },
  };
}

function armiesDocs(): Array<FactionDocument | ArmyDocument> {
  return [
    {
      _id: "f-red",
      type: "faction",
      name: "Red",
      ownership: { default: 0, [PLAYER_ID]: 3 },
      flags: {},
      system: {},
      color: "#f00",
      allies: [],
    } as FactionDocument,
    {
      _id: "f-blue",
      type: "faction",
      name: "Blue",
      ownership: { default: 0 },
      flags: {},
      system: {},
      color: "#00f",
      allies: [],
    } as FactionDocument,
    {
      _id: "army-red",
      type: "army",
      name: "Red Host",
      ownership: { default: 0, [PLAYER_ID]: 3 },
      flags: {},
      system: {},
      factionId: "f-red",
      commander: [],
      supply: { level: 1 },
      units: [unit("u-red", [10, 20])],
    } as ArmyDocument,
    {
      _id: "army-blue",
      type: "army",
      name: "Blue Host",
      ownership: { default: 0 },
      flags: {},
      system: {},
      factionId: "f-blue",
      commander: [],
      supply: { level: 1 },
      units: [unit("u-blue", [0, 10])],
    } as ArmyDocument,
  ];
}

/** Manual driver: tests pump the realtime clock explicitly. */
const manualDriver: RealtimeDriver = {
  every: () => null,
  stop: () => {},
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await flushMicrotasks();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await flushMicrotasks();
};

async function setup(): Promise<{
  host: HostSync;
  channel: TurnChannel;
  gmBus: EventBus<ClientEvents>;
  worldId: string;
  deltas: SimDeltaMsg[];
  phases: TurnPhaseMsg[];
  reports: TurnReportMsg[];
}> {
  const db = await openVttDb();
  dbs.push(db);
  const worldId = `w-rt-${++worldCounter}`;
  const meta: StoreMeta = {
    worldId,
    name: "RT World",
    system: "mass-battle-basic",
    systemVersion: "1.0.0",
  };
  const store = new DocumentStore({ meta });
  const hostBus = createEventBus<HostEvents>();
  const host = new HostSync({
    store,
    log: new OpLog(),
    undo: new UndoStack(),
    bus: hostBus,
    systemUserId: GM_ID,
    roomId: "room-rt",
    verifyHelloSig: async (hello) => hello.sig === "valid",
    rng: () => 0.25,
  });

  const pair = createTransportPair();
  const gmBus = createEventBus<ClientEvents>();
  const gm = new ClientSync({
    transport: pair.a,
    bus: gmBus,
    meta,
    simSys: MASS_BATTLE_SCHEMA_COLUMNS,
    simSceneId: SCENE_ID,
  });
  host.addSession("gm-peer", pair.b, gmSessionUser(GM_ID));
  void gm;

  const docs = armiesDocs();
  const createOps: Op[] = docs.map((d) =>
    d.type === "faction"
      ? { kind: "create" as const, coll: "factions" as const, data: d }
      : { kind: "create" as const, coll: "armies" as const, data: d },
  );
  host.commitSystem([
    { kind: "create", coll: "scenes", data: sceneDoc() },
    ...createOps,
    {
      kind: "create",
      coll: "users",
      data: {
        _id: PLAYER_ID,
        type: "user",
        name: "Red Player",
        ownership: { default: 0 },
        flags: {},
        system: {},
        role: "PLAYER",
        character: null,
        color: "#fff",
      } as UserDocument,
    },
  ]);

  const bridge = new SimBridge(SCENE_ID, {
    db,
    worldId,
    runner: new InlineSimRunner(),
    sys: MASS_BATTLE_SCHEMA_COLUMNS,
  });
  let t = 1_000_000;
  const channel = new TurnChannel({
    host,
    store,
    bridge,
    sceneId: SCENE_ID,
    sys: MASS_BATTLE_SCHEMA_COLUMNS,
    seed: 4242,
    now: () => t,
    rtDriver: manualDriver,
  });
  (channel as unknown as { __tick: (v: number) => void }).__tick = (v: number) => {
    t = v;
  };

  const deltas: SimDeltaMsg[] = [];
  gmBus.on("sim", () => {
    /* generic; deltas captured below */
  });
  const phases: TurnPhaseMsg[] = [];
  gmBus.on("turnPhase", (m) => phases.push(m));
  const reports: TurnReportMsg[] = [];
  gmBus.on("turnReport", (m) => reports.push(m));
  // capture raw sim.delta frames off the transport: hook broadcastSim via bus?
  // GM client emits no dedicated event for deltas — intercept at the frame
  // level through the client's replica version + the host's stats instead.

  return { host, channel, gmBus, worldId, deltas, phases, reports };
}

/** Advance the fake clock and pump; returns the new time. */
async function elapse(
  channel: TurnChannel,
  tick: (v: number) => void,
  from: number,
  ms: number,
  stepMs: number,
): Promise<number> {
  for (let t = from; t < from + ms; t += stepMs) {
    tick(t);
    await channel.pumpRealtime(t);
  }
  return from + ms;
}

describe("realtime mode (§5A: 5 Hz tick / coalesced flush / 1 Hz report / checkpoints)", () => {
  test("start(realtime) ticks, flushes coalesced deltas, reports at 1 Hz", async () => {
    const s = await setup();
    const tick = (s.channel as unknown as { __tick: (v: number) => void }).__tick;
    await s.channel.start("realtime");
    await flush();
    expect(s.channel.phase).toBe("orders");
    expect(s.channel.realtimeStats().running).toBe(true);

    // 2 s of fake time at the 5 Hz default, pumped every 50 ms
    const t0 = 1_000_000;
    await elapse(s.channel, tick, t0, 2_000, 50);
    await flush();

    const stats = s.channel.realtimeStats();
    // ~10 ticks due in 2 s (accumulator; ±catch-up cap slack)
    expect(stats.ticksTotal).toBeGreaterThanOrEqual(8);
    expect(stats.ticksTotal).toBeLessThanOrEqual(12);
    // flush at 5 Hz → one frame per ~200 ms, each spanning 1 tick
    expect(stats.deltaFrames).toBeGreaterThanOrEqual(5);
    expect(stats.version).toBeGreaterThanOrEqual(stats.ticksTotal);
    // 1 Hz report
    expect(stats.reports).toBeGreaterThanOrEqual(1);
    const rtReports = s.reports.filter((r) => r.report.rulesVersion === "realtime");
    expect(rtReports.length).toBeGreaterThanOrEqual(1);
    // GM phase frames carry the realtime clock state
    const last = s.phases[s.phases.length - 1];
    expect(last?.mode).toBe("realtime");
    expect(last?.paused).toBe(false);
    expect(last?.simHz).toBe(5);
  });

  test("rate 10 Hz with flush 5 Hz coalesces ≥2 ticks per frame", async () => {
    const s = await setup();
    const tick = (s.channel as unknown as { __tick: (v: number) => void }).__tick;
    await s.channel.start("realtime");
    await flush();
    s.channel.handleSimControl(gmSessionUser(GM_ID), {
      kind: "sim.control",
      action: "rate",
      rateHz: 10,
    });
    await flush();
    expect(s.channel.realtimeStats().simHz).toBe(10);

    const t0 = 1_000_000;
    await elapse(s.channel, tick, t0, 2_000, 50);
    await flush();

    const stats = s.channel.realtimeStats();
    expect(stats.ticksTotal).toBeGreaterThanOrEqual(15); // ~20 due
    expect(stats.deltaFrames).toBeGreaterThanOrEqual(5); // flush stayed 5 Hz
    expect(stats.coalescedMax).toBeGreaterThanOrEqual(2); // ≥2 ticks/frame
  });

  test("pause freezes the clock, checkpoints, and broadcasts paused phase; resume continues", async () => {
    const s = await setup();
    const tick = (s.channel as unknown as { __tick: (v: number) => void }).__tick;
    await s.channel.start("realtime");
    const t0 = 1_000_000;
    await elapse(s.channel, tick, t0, 600, 50);
    await flush();
    const before = s.channel.realtimeStats();
    expect(before.ticksTotal).toBeGreaterThanOrEqual(2);

    s.channel.handleSimControl(gmSessionUser(GM_ID), { kind: "sim.control", action: "pause" });
    await flush();
    let stats = s.channel.realtimeStats();
    expect(stats.running).toBe(false);
    expect(stats.checkpoints).toBe(1); // pause writes a tick checkpoint (§5A)
    const pausedAt = stats.ticksTotal;

    // pumping while paused must not tick
    await elapse(s.channel, tick, t0 + 600, 1_000, 50);
    stats = s.channel.realtimeStats();
    expect(stats.ticksTotal).toBe(pausedAt);
    const lastPhase = s.phases[s.phases.length - 1];
    expect(lastPhase?.paused).toBe(true);
    expect(lastPhase?.mode).toBe("realtime");

    // tick checkpoint landed with tick !== null (distinct from freezes)
    const cps = await listCheckpoints(
      (s.channel as unknown as { bridge: { db: IDBPDatabase; worldId: string } }).bridge.db,
      (s.channel as unknown as { bridge: { db: IDBPDatabase; worldId: string } }).bridge.worldId,
      SCENE_ID,
    );
    expect(cps.some((c) => c.tick !== null)).toBe(true);

    s.channel.handleSimControl(gmSessionUser(GM_ID), { kind: "sim.control", action: "resume" });
    await flush();
    await elapse(s.channel, tick, t0 + 1_600, 400, 50);
    await flush();
    stats = s.channel.realtimeStats();
    expect(stats.running).toBe(true);
    expect(stats.ticksTotal).toBeGreaterThan(pausedAt);
  });

  test("K-tick interval checkpoints (K = 300) land during a long run", async () => {
    const s = await setup();
    const tick = (s.channel as unknown as { __tick: (v: number) => void }).__tick;
    await s.channel.start("realtime");
    await flush();
    // 8 ticks per pump (catch-up cap): 300 ticks ≈ 38 pumps of 1.6 s fake time
    let t = 1_000_000;
    for (let i = 0; i < 40; i++) {
      t += 1_600;
      tick(t);
      await s.channel.pumpRealtime(t);
    }
    await flush();
    const stats = s.channel.realtimeStats();
    expect(stats.ticksTotal).toBeGreaterThanOrEqual(300);
    expect(stats.checkpoints).toBeGreaterThanOrEqual(1); // the K-tick checkpoint
    expect(stats.running).toBe(true);
  });

  test("mergeSimDeltas: merged frame ≡ sequential application", async () => {
    // two ticks over a small pool, decoded and merged
    const pool = createModelPool(8, MASS_BATTLE_SCHEMA_COLUMNS);
    for (let i = 0; i < 4; i++) {
      allocModel(pool, {
        id: i + 1,
        unitIdx: 0,
        x: 10 + i,
        y: 20,
        hp: 2,
        hpMax: 2,
        sys: { ammo: 6 },
      });
    }
    const { diffPools } = await import("../../src/sim/codec");
    const { clonePool } = await import("../../src/sim/pool");
    const before = clonePool(pool);
    for (const i of [0, 1]) pool.x[i] = (pool.x[i] ?? 0) + 3;
    const mid = clonePool(pool);
    for (const i of [1, 2]) pool.x[i] = (pool.x[i] ?? 0) + 5;
    const d1 = diffPools(before, mid, "", MASS_BATTLE_SCHEMA_COLUMNS);
    d1.fromVersion = 0;
    d1.toVersion = 1;
    const d2 = diffPools(mid, clonePool(pool), "", MASS_BATTLE_SCHEMA_COLUMNS);
    d2.fromVersion = 1;
    d2.toVersion = 2;
    d1.sceneId = "";
    d2.sceneId = "";

    const merged = mergeSimDeltas([d1, d2], MASS_BATTLE_SCHEMA_COLUMNS);
    expect(merged).not.toBeNull();
    expect(merged?.fromVersion).toBe(0);
    expect(merged?.toVersion).toBe(2);

    const seqPool = clonePool(before);
    applySimDelta(seqPool, d1, 2, MASS_BATTLE_SCHEMA_COLUMNS);
    applySimDelta(seqPool, d2, 2, MASS_BATTLE_SCHEMA_COLUMNS);
    const mrgPool = clonePool(before);
    applySimDelta(mrgPool, merged ?? d1, 2, MASS_BATTLE_SCHEMA_COLUMNS);
    for (let i = 0; i < 4; i++) {
      expect(mrgPool.x[i]).toBeCloseTo(seqPool.x[i] ?? 0, 5);
    }
  });

  test("realtime reports carry tick events (bounded)", async () => {
    const s = await setup();
    const tick = (s.channel as unknown as { __tick: (v: number) => void }).__tick;
    await s.channel.start("realtime");
    const t0 = 1_000_000;
    await elapse(s.channel, tick, t0, 1_200, 50);
    await flush();
    const rt = s.reports.find((r) => r.report.rulesVersion === "realtime");
    expect(rt).toBeTruthy();
    if (rt) {
      expect(rt.report.summary.realtime).toBe(1);
      expect(typeof rt.report.summary.tick).toBe("number");
      const events: SimEvent[] = rt.report.events;
      expect(events.length).toBeLessThanOrEqual(100);
    }
  });
});
