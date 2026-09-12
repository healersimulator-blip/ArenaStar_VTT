import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "vitest";
import type { IDBPDatabase } from "idb";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import { SimBridge } from "../../src/host/simBridge";
import { TurnChannel } from "../../src/host/turnChannel";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { MASS_BATTLE_SCHEMA_COLUMNS } from "../../src/packages/massBattleBasic";
import { openVttDb } from "../../src/storage/idb";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { encodeSimSnapshot, snapshotFromPool } from "../../src/sim/codec";
import type { ArmyDocument, FactionDocument, UnitDocument } from "../../src/core/strategic";
import type { SceneDocument, UserDocument } from "../../src/core/documents";
import type { TurnPhaseMsg, TurnReportMsg } from "../../src/core/messages";

// Unique world per setup(): §8A checkpoints live in the shared test IDB and a
// resumed checkpoint silently overrides any injected initial pool.
let worldCounter = 0;

const baseMeta: StoreMeta = {
  worldId: "w-sim",
  name: "Sim World",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};
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

function factionRed(): FactionDocument {
  return {
    _id: "f-red",
    type: "faction",
    name: "Red",
    ownership: { default: 0, [PLAYER_ID]: 3 },
    flags: {},
    system: {},
    color: "#f00",
    allies: [],
  };
}

function factionBlue(): FactionDocument {
  return {
    _id: "f-blue",
    type: "faction",
    name: "Blue",
    ownership: { default: 0 },
    flags: {},
    system: {},
    color: "#00f",
    allies: [],
  };
}

function unit(id: string, type: string, modelRange: [number, number]): UnitDocument {
  return {
    _id: id,
    type,
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    profile: {},
    formation: "line",
    sceneId: SCENE_ID,
    modelRange,
    orders: { pending: [], issuedBy: GM_ID, issuedTurn: 0 },
    stats: { strength: 10, morale: 3, supply: 1, fatigue: 0 },
  };
}

function armyRed(units: UnitDocument[]): ArmyDocument {
  return {
    _id: "army-red",
    type: "army",
    name: "Red Host",
    ownership: { default: 0, [PLAYER_ID]: 3 },
    flags: {},
    system: {},
    factionId: "f-red",
    commander: [],
    supply: { level: 1 },
    units,
  };
}

function armyBlue(units: UnitDocument[]): ArmyDocument {
  return {
    _id: "army-blue",
    type: "army",
    name: "Blue Host",
    ownership: { default: 0 },
    flags: {},
    system: {},
    factionId: "f-blue",
    commander: [],
    // supply 0 → guaranteed attrition casualty each turn (deterministic test)
    supply: { level: 0 },
    units,
  };
}

/** 10 red models at (10,10), 10 blue at (60,60) — far apart (no detection). */
function initialPoolBytes(): { bytes: Uint8Array; maxHpMax: number } {
  const pool = createModelPool(32, MASS_BATTLE_SCHEMA_COLUMNS);
  for (let i = 0; i < 10; i++) {
    // unitViews() order: armies sorted by _id → army-blue first → blue = unitIdx 0
    allocModel(pool, {
      id: i + 1,
      unitIdx: 0,
      x: 60 + i * 0.2,
      y: 60,
      hp: 1,
      hpMax: 1,
      sys: { ammo: 6 },
    });
  }
  for (let i = 0; i < 10; i++) {
    allocModel(pool, {
      id: 101 + i,
      unitIdx: 1,
      x: 10 + i * 0.2,
      y: 10,
      hp: 1,
      hpMax: 1,
      sys: { ammo: 6 },
    });
  }
  return {
    bytes: encodeSimSnapshot(snapshotFromPool(pool, SCENE_ID, 0, MASS_BATTLE_SCHEMA_COLUMNS), 1),
    maxHpMax: 1,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await flushMicrotasks();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await flushMicrotasks();
};

async function setup(gridDistance = 5): Promise<{
  host: HostSync;
  channel: TurnChannel;
  gm: ClientSync;
  gmBus: EventBus<ClientEvents>;
  player: ClientSync;
  playerBus: EventBus<ClientEvents>;
  playerPhases: TurnPhaseMsg[];
  playerReports: TurnReportMsg[];
  gmPhases: TurnPhaseMsg[];
}> {
  const db = await openVttDb();
  dbs.push(db);
  const meta = { ...baseMeta, worldId: `w-sim-${++worldCounter}` };
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  const undo = new UndoStack();
  const hostBus = createEventBus<HostEvents>();
  const host = new HostSync({
    store,
    log,
    undo,
    bus: hostBus,
    systemUserId: GM_ID,
    roomId: "room-sim",
    verifyHelloSig: async (hello) => hello.sig === "valid",
    rng: () => 0.25,
  });

  // GM loopback session
  const gmPair = createTransportPair();
  const gmT = gmPair.a;
  const gmHostT = gmPair.b;
  const gmBus = createEventBus<ClientEvents>();
  const gm = new ClientSync({
    transport: gmT,
    bus: gmBus,
    meta,
    simSys: MASS_BATTLE_SCHEMA_COLUMNS,
    simSceneId: SCENE_ID,
  });
  host.addSession("gm-peer", gmHostT, gmSessionUser(GM_ID));

  // world documents (scene, factions, armies) BEFORE players join
  const scene = sceneDoc();
  // The scene is the single source of the feet-per-square scale (P01): a world whose
  // grid distance is not the 5-ft default must deploy and sim at *its* scale.
  if (scene.grid) scene.grid.distance = gridDistance;
  host.commitSystem([
    { kind: "create", coll: "scenes", data: scene },
    { kind: "create", coll: "factions", data: factionRed() },
    { kind: "create", coll: "factions", data: factionBlue() },
    { kind: "create", coll: "armies", data: armyRed([unit("u-red", "infantry", [10, 20])]) },
    { kind: "create", coll: "armies", data: armyBlue([unit("u-blue", "infantry", [0, 10])]) },
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

  // player session (known pubkey → auto-approved)
  const plPair = createTransportPair();
  const plT = plPair.a;
  const plHostT = plPair.b;
  const playerBus = createEventBus<ClientEvents>();
  const player = new ClientSync({
    transport: plT,
    bus: playerBus,
    meta,
    simSys: MASS_BATTLE_SCHEMA_COLUMNS,
    simSceneId: SCENE_ID,
  });
  host.addSession("pl-peer", plHostT);
  plT.send(
    "ops",
    (await import("../../src/net/frame")).frameMessage({
      kind: "hello",
      pubkey: PLAYER_ID,
      displayName: "Red Player",
      ts: 1,
      sig: "valid",
    }),
  );
  await flush();

  const bridge = new SimBridge(SCENE_ID, {
    db,
    worldId: meta.worldId,
    runner: new InlineSimRunner(),
    sys: MASS_BATTLE_SCHEMA_COLUMNS,
  });
  const channel = new TurnChannel({
    host,
    store,
    bridge,
    sceneId: SCENE_ID,
    sys: MASS_BATTLE_SCHEMA_COLUMNS,
    seed: 4242,
  });

  const playerPhases: TurnPhaseMsg[] = [];
  playerBus.on("turnPhase", (m) => playerPhases.push(m));
  const playerReports: TurnReportMsg[] = [];
  playerBus.on("turnReport", (m) => playerReports.push(m));
  const gmPhases: TurnPhaseMsg[] = [];
  gmBus.on("turnPhase", (m) => gmPhases.push(m));

  return { host, channel, gm, gmBus, player, playerBus, playerPhases, playerReports, gmPhases };
}

describe("turn channel (§5A steps 1–5, host⇄client e2e in Node)", () => {
  test("campaign start announces orders phase and creates the Turn document", async () => {
    const { channel, player, gm } = await setup();
    const resumed = await channel.start("stepwise", initialPoolBytes());
    expect(resumed).toBe(0);
    await flush();
    expect(channel.phase).toBe("orders");
    const turnDoc = gm.store.get("turns", "turn:sc-1:1");
    expect(turnDoc?.phase).toBe("orders");
    expect(turnDoc?.mode).toBe("stepwise");
    expect(player.store.get("turns", "turn:sc-1:1")?.phase).toBe("orders");
  });

  test("start without an initial snapshot auto-deploys unit strength (§8A D-081)", async () => {
    const { channel, gm, player, gmBus } = await setup();
    const gmReports: TurnReportMsg[] = [];
    gmBus.on("turnReport", (m) => gmReports.push(m));
    const resumed = await channel.start("stepwise"); // no initial → §8A deploy
    expect(resumed).toBe(0);
    await flush();
    expect(channel.phase).toBe("orders");

    // modelRange ops committed (armies sort by _id: army-blue deploys first)
    expect(gm.store.get("armies", "army-blue")?.units[0]?.modelRange?.[0]).toBe(0);
    expect(gm.store.get("armies", "army-blue")?.units[0]?.modelRange?.[1]).toBe(10);
    expect(gm.store.get("armies", "army-red")?.units[0]?.modelRange?.[0]).toBe(10);
    expect(gm.store.get("armies", "army-red")?.units[0]?.modelRange?.[1]).toBe(20);
    expect(player.store.get("armies", "army-red")?.units[0]?.modelRange?.[1]).toBe(20);

    // both clients received the deployed pool snapshot at start
    expect(gm.simReplica?.count).toBe(20);
    expect(player.simReplica?.count).toBe(20); // hidden slots keep indices (§5A)
    // deterministic faction lanes: f-blue sorts first → x ≈ 150, f-red → ≈ 450
    const gmPool = gm.simReplica;
    expect(gmPool).not.toBeNull();
    if (gmPool) {
      expect(gmPool.x[0] ?? 0).toBeGreaterThan(100);
      expect(gmPool.x[0] ?? 0).toBeLessThan(200);
      expect(gmPool.x[10] ?? 0).toBeGreaterThan(400);
      expect(gmPool.x[10] ?? 0).toBeLessThan(500);
    }

    // the deployed campaign resolves: blue supply 0 → attrition casualty (20→19)
    gm.simControl("advance");
    await expect.poll(() => channel.phase, { timeout: 5000 }).toBe("report");
    await flush();
    expect(player.simReplicaVersion).toBe(1);
    expect(gm.simReplica?.count).toBe(19);

    // §11: the report carries aggregated distributions (not just counts)
    const report = gmReports[gmReports.length - 1]?.report;
    expect(report).toBeTruthy();
    const dist = (
      report as unknown as {
        summary: {
          distributions?: { byType?: Record<string, number>; totals?: Record<string, number> };
        };
      }
    ).summary.distributions;
    expect(dist?.byType?.attrition).toBe(1); // blue supply 0 → one attrition event
    expect(dist?.totals?.attrition).toBe(1);
  });

  test("deployment and the §12 rules grid ride the scene's grid distance (P01)", async () => {
    // Gap List §2.15: the deployer spaced formations 4 ft apart while the grid is 5 ft,
    // so several models shared one square — and the rules that read squares (threat,
    // AoN 183 flanking) then described geometry the layout never had. The channel now
    // hands `deploySnapshot` the scene's own distance, and the same derivation fills
    // `ctx.grid.distance`, so one square means one thing on both sides of the sim
    // boundary. A 10-ft scene proves the number is the scene's, not a constant.
    const { channel, gm } = await setup(10);
    expect(await channel.start("stepwise")).toBe(0); // no initial → §8A deploy
    await flush();
    expect(channel.rulesCtx().grid.distance).toBe(10);

    const pool = gm.simReplica;
    expect(pool).not.toBeNull();
    if (pool) {
      // army-blue deploys first (armies sort by _id) as a line of 10: consecutive files
      // are one square apart — 10 ft on this scene, not 4 ft.
      expect(Math.abs((pool.y[1] ?? 0) - (pool.y[0] ?? 0))).toBe(10);
      // ...and nothing shares a square: every file lands on a distinct multiple of 10.
      expect(((pool.y[1] ?? 0) - (pool.y[0] ?? 0)) % 10).toBe(0);
      const squares = new Set<number>();
      for (let i = 0; i < 10; i++) {
        squares.add((pool.x[i] ?? 0) * 1000 + (pool.y[i] ?? 0));
      }
      expect(squares.size).toBe(10);
    }
  });

  test("sim.control start (GM) boots an idle channel with deployment", async () => {
    const { channel, gm } = await setup();
    gm.simControl("start", { mode: "stepwise" });
    await expect.poll(() => channel.phase, { timeout: 5000 }).toBe("orders");
    await flush();
    expect(gm.simReplica?.count).toBe(20);
    // a second start while active is rejected by the engine (turn_active)
    gm.simControl("start", { mode: "stepwise" });
    await flush();
    expect(gm.store.getAll("turns").length).toBe(1);
  });

  test("turn.ready toggles propagate to every client", async () => {
    const { channel, player, playerPhases, gmPhases } = await setup();
    await channel.start("stepwise", initialPoolBytes());
    await flush();
    player.setTurnReady("turn:sc-1:1", true);
    await flush();
    expect(channel.phase).toBe("orders");
    const last = playerPhases[playerPhases.length - 1];
    expect(last?.readyUsers).toContain(PLAYER_ID);
    expect(gmPhases[gmPhases.length - 1]?.readyUsers).toContain(PLAYER_ID);
  });

  test("non-GM sim.control is dropped (phase unchanged)", async () => {
    const { channel, player } = await setup();
    await channel.start("stepwise", initialPoolBytes());
    await flush();
    player.simControl("advance");
    await flush();
    expect(channel.phase).toBe("orders");
  });

  test("GM advance: resolve → one ops envelope + per-faction delta/report + phases", async () => {
    const ctx = await setup();
    const { channel, gm, player, playerPhases, playerReports } = ctx;
    await channel.start("stepwise", initialPoolBytes());
    await flush();

    gm.simControl("advance");
    await expect.poll(() => channel.phase, { timeout: 5000 }).toBe("report");
    await flush();

    // phases seen by the player: orders → resolution → report
    const phases = playerPhases.map((p) => p.phase);
    expect(phases).toEqual(["orders", "resolution", "report"]);

    // ── ops envelope: blue suffered attrition (strength 10→9), turn doc → report
    const gmArmy = gm.store.get("armies", "army-blue");
    expect(gmArmy?.units[0]?.stats.strength).toBe(9);
    expect(gm.store.get("turns", "turn:sc-1:1")?.phase).toBe("report");
    // stat + range updates landed as ONE envelope (seq increment: turn doc update)
    // ── GM sim replica got the unfiltered delta (compaction shrank the pool)
    expect(gm.simReplicaVersion).toBe(1);
    expect(gm.simReplica?.count).toBe(19);
    expect(gm.simReplica?.sys.ammo?.[0]).toBe(6);

    // ── player (red faction) received the projected delta: red slots intact
    expect(player.simReplicaVersion).toBe(1);
    expect(player.simReplica?.count).toBe(19);
    for (let i = 10; i < 19; i++) {
      // red models (unitIdx 1, pool [10,20)) untouched by blue's attrition
      expect(player.simReplica?.x[i] ?? 0).toBeGreaterThan(9);
    }

    // ── report projection: red player sees a stub for blue's attrition event
    expect(playerReports.length).toBe(1);
    const ev = playerReports[0]?.report.events.find((e) => e.subPhase === "supply");
    expect(ev?.type).toBe("unknown");
    expect(ev?.text).toBe("unknown enemy activity");
  });

  test("undoTurn: stats restored, snapshot resync, phase back to orders", async () => {
    const { channel, gm, player, playerPhases } = await setup();
    await channel.start("stepwise", initialPoolBytes());
    await flush();
    gm.simControl("advance");
    await expect.poll(() => channel.phase, { timeout: 5000 }).toBe("report");
    await flush();
    expect(player.simReplicaVersion).toBe(1);

    gm.simControl("undoTurn");
    await expect.poll(() => channel.phase, { timeout: 5000 }).toBe("orders");
    await flush();

    // unit stats restored to pre-turn values
    expect(gm.store.get("armies", "army-blue")?.units[0]?.stats.strength).toBe(10);
    expect(gm.store.get("armies", "army-blue")?.units[0]?.modelRange?.[1]).toBe(10);
    // clients resynced to the restored (pre-turn) pool state
    expect(player.simReplicaVersion).toBe(0);
    expect(gm.simReplicaVersion).toBe(0);
    expect(player.simReplica?.count).toBe(20);
    const last = playerPhases[playerPhases.length - 1];
    expect(last?.phase).toBe("orders");
  });

  test("turn.next opens Turn 2 (orders)", async () => {
    const { channel, gm, player } = await setup();
    await channel.start("stepwise", initialPoolBytes());
    await flush();
    gm.simControl("advance");
    await expect.poll(() => channel.phase, { timeout: 5000 }).toBe("report");
    await flush();
    gm.simControl("next");
    await flush();
    expect(channel.phase).toBe("orders");
    expect(gm.store.get("turns", "turn:sc-1:2")?.number).toBe(2);
    expect(player.store.get("turns", "turn:sc-1:2")?.phase).toBe("orders");
  });

  test("sim.snapshot.get answers with a full snapshot (per-faction projected)", async () => {
    const { channel, gm, player } = await setup();
    await channel.start("stepwise", initialPoolBytes());
    await flush();
    expect(gm.simReplica).toBeNull(); // no delta yet
    player.requestSimSnapshot();
    await expect.poll(() => player.simReplicaVersion, { timeout: 3000 }).toBe(0);
    expect(player.simReplica?.count).toBe(20);
    // red slots live at (10,10); blue slots are hidden → status bit set, no position leak
    expect(player.simReplica?.x[10] ?? 0).toBeGreaterThan(9);
    const { ModelStatus } = await import("../../src/core/strategic");
    expect((player.simReplica?.status[5] ?? 0) & ModelStatus.hidden).toBe(ModelStatus.hidden);
    expect(player.simReplica?.x[5] ?? -1).toBe(0);
    expect(player.simReplica?.y[5] ?? -1).toBe(0);
  });
});
