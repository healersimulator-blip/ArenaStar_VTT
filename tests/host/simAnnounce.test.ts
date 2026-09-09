import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "vitest";
import type { IDBPDatabase } from "idb";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import {
  DocumentStore,
  OpLog,
  UndoStack,
  type StoreMeta,
} from "../../src/core";
import { SimBridge } from "../../src/host/simBridge";
import { TurnChannel } from "../../src/host/turnChannel";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { MASS_BATTLE_SCHEMA_COLUMNS } from "../../src/packages/massBattleBasic";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { openVttDb } from "../../src/storage/idb";
import { frameMessage, deframeMessage } from "../../src/net/frame";
import type { Transport } from "../../src/core/net";
import { allocModel, createModelPool } from "../../src/sim/pool";
import {
  diffPools,
  encodeSimDelta,
  encodeSimSnapshot,
  snapshotFromPool,
} from "../../src/sim/codec";
import type {
  ArmyDocument,
  FactionDocument,
  UnitDocument,
} from "../../src/core/strategic";
import type { SceneDocument, UserDocument } from "../../src/core/documents";
import type { WelcomeMsg, WireMessage } from "../../src/core/messages";

/**
 * N01/N02 (PF1e_Unified_TODO §2) — the active sim schema and scene are
 * HOST-ANNOUNCED on the wire, not guessed by joiners:
 *
 *   • every welcome carries the battle (scene + package schema + version);
 *   • a joiner with no constructor guess adopts it before the first sim frame;
 *   • a wrong constructor guess (the old hardcoded mass-battle-basic joiner)
 *     is overridden and its mis-decoded replica discarded;
 *   • a CHANGED announcement (package switch) resets replicas and re-pulls a
 *     snapshot before any further delta is applied;
 *   • re-announcing the same info (reconnect) is a no-op;
 *   • a second peer receives PF1e state — signed i8 saves and the HP/AC/status/
 *     profile columns — across BOTH snapshots and deltas.
 */

let worldCounter = 0;
let joinCounter = 0;

const GM_ID = "gm-key";
const PLAYER_ID = "pl-key";
const SCENE_ID = "sc-pf1e";
const PKG = { packageId: "pf1e-mass-battles", version: "1.0.0" } as const;

const baseMeta: StoreMeta = {
  worldId: "w-announce",
  name: "Announce World",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};

const dbs: IDBPDatabase[] = [];
afterAll(() => {
  for (const d of dbs) d.close();
});

/**
 * PF1e-flavored unit: strength 1 → exactly one model; fort −2/+5 prove the
 * signed i8 column path end-to-end; typed AC 18/13/15 is authored input.
 */
function unit(id: string, fort: number): UnitDocument {
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
    modelRange: null,
    orders: { pending: [], issuedBy: GM_ID, issuedTurn: 0 },
    stats: {
      strength: 1,
      morale: 3,
      supply: 1,
      fatigue: 0,
      // PF1e profile inputs (rawProfileFromUnit → compilePF1eProfile)
      bab: 6,
      strMod: 3,
      dexMod: 0,
      conMod: 2,
      sizeMod: 0,
      fort,
      ref: 4,
      will: 2,
      hp: 10,
      sr: 0,
      ac: 18,
      touchAc: 13,
      flatFootedAc: 15,
    },
  } as UnitDocument;
}

function faction(
  id: string,
  name: string,
  playerOwned: boolean,
): FactionDocument {
  return {
    _id: id,
    type: "faction",
    name,
    ownership: { default: 0, ...(playerOwned ? { [PLAYER_ID]: 3 } : {}) },
    flags: {},
    system: {},
    color: "#f00",
    allies: [],
  };
}

function army(
  id: string,
  factionId: string,
  units: UnitDocument[],
): ArmyDocument {
  return {
    _id: id,
    type: "army",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    factionId,
    commander: [],
    supply: { level: 1 },
    units,
  };
}

function sceneDoc(): SceneDocument {
  return {
    _id: SCENE_ID,
    type: "scene",
    name: "PF1e Field",
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

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await flushMicrotasks();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await flushMicrotasks();
};

/** Chain a wire tap onto an existing transport handler (frames TO that side). */
function tap(transport: Transport, out: WireMessage[]): void {
  const prev = transport.onMessage;
  transport.onMessage = (channel, bytes) => {
    const r = deframeMessage(bytes);
    if (r.ok) out.push(r.value);
    prev?.(channel, bytes);
  };
}

const kind = (m: unknown): string => (m as { kind: string }).kind;
const snapshotGets = (frames: WireMessage[]): string[] =>
  frames
    .filter((m) => kind(m) === "sim.snapshot.get")
    .map((m) => (m as { sceneId: string }).sceneId);
const welcomes = (frames: WireMessage[]): WelcomeMsg[] =>
  frames.filter((m) => kind(m) === "welcome") as WelcomeMsg[];

interface Joiner {
  player: ClientSync;
  playerBus: EventBus<ClientEvents>;
  hostGot: WireMessage[];
  playerGot: WireMessage[];
}

interface Rig {
  host: HostSync;
  channel: TurnChannel;
  meta: StoreMeta;
  gm: ClientSync;
  /** The joiner path: NO constructor sim guess (the old code hardcoded one). */
  joins(): Promise<Joiner>;
  /** The legacy joiner: hardcoded mass-battle-basic + wrong scene guess. */
  joinLegacy(): Promise<Joiner>;
}

async function rig(
  unitsRed: UnitDocument[],
  unitsBlue: UnitDocument[],
): Promise<Rig> {
  const db = await openVttDb();
  dbs.push(db);
  const meta = { ...baseMeta, worldId: `w-announce-${++worldCounter}` };
  const store = new DocumentStore({ meta });
  const host = new HostSync({
    store,
    log: new OpLog(),
    undo: new UndoStack(),
    bus: createEventBus<HostEvents>(),
    systemUserId: GM_ID,
    roomId: "room-announce",
    verifyHelloSig: async (hello) => hello.sig === "valid",
    rng: () => 0.25,
  });

  host.commitSystem([
    { kind: "create", coll: "scenes", data: sceneDoc() },
    {
      kind: "create",
      coll: "factions",
      data: faction("f-blue", "Blue", false),
    },
    { kind: "create", coll: "factions", data: faction("f-red", "Red", true) },
    {
      kind: "create",
      coll: "armies",
      data: army("army-blue", "f-blue", unitsBlue),
    },
    {
      kind: "create",
      coll: "armies",
      data: army("army-red", "f-red", unitsRed),
    },
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

  // GM loopback: NO constructor sim guess — it rides the announcement (the
  // re-announce path below is what delivers it, since the session pre-dates
  // setSimInfo; production hostBoot orders setSimInfo BEFORE addSession).
  const gmPair = createTransportPair();
  host.addSession("gm-peer", gmPair.b, gmSessionUser(GM_ID));
  const gmBus = createEventBus<ClientEvents>();
  const gm = new ClientSync({ transport: gmPair.a, bus: gmBus, meta });
  await flush();

  const bridge = new SimBridge(SCENE_ID, {
    db,
    worldId: meta.worldId,
    runner: new InlineSimRunner(createMassBattlePf1e()),
    sys: PF1E_MODEL_SCHEMA,
  });
  const channel = new TurnChannel({
    host,
    store,
    bridge,
    sceneId: SCENE_ID,
    sys: PF1E_MODEL_SCHEMA,
    seed: 97531,
  });

  const joinWith = async (simOpts: {
    simSys?: typeof MASS_BATTLE_SCHEMA_COLUMNS;
    simSceneId?: string;
  }): Promise<Joiner> => {
    const pair = createTransportPair();
    const playerBus = createEventBus<ClientEvents>();
    const player = new ClientSync({
      transport: pair.a,
      bus: playerBus,
      meta,
      ...simOpts,
    });
    const hostGot: WireMessage[] = [];
    const playerGot: WireMessage[] = [];
    host.addSession(`pl-${worldCounter}-${++joinCounter}`, pair.b);
    tap(pair.b, hostGot); // frames the player sends
    tap(pair.a, playerGot); // frames the host sends
    pair.a.send(
      "ops",
      frameMessage({
        kind: "hello",
        pubkey: PLAYER_ID,
        displayName: "Red Player",
        ts: 1,
        sig: "valid",
      }),
    );
    await flush();
    return { player, playerBus, hostGot, playerGot };
  };

  return {
    host,
    channel,
    meta,
    gm,
    joins: () => joinWith({}),
    joinLegacy: () =>
      joinWith({ simSys: MASS_BATTLE_SCHEMA_COLUMNS, simSceneId: "scene-1" }),
  };
}

describe("N01 — host-announced sim schema/scene (welcome carries the battle)", () => {
  test("joiner with no guess adopts the announced battle and requests its scene", async () => {
    const { host, joins } = await rig([unit("u-red", -2)], [unit("u-blue", 5)]);
    host.setSimInfo({ sceneId: SCENE_ID, schema: PF1E_MODEL_SCHEMA, ...PKG });
    const { player, hostGot, playerGot } = await joins();

    // welcome carried the battle, verbatim
    const ws = welcomes(playerGot);
    expect(ws).toHaveLength(1);
    expect(ws[0]?.sim).toMatchObject({ sceneId: SCENE_ID, ...PKG });
    expect(ws[0]?.sim?.schema).toEqual(PF1E_MODEL_SCHEMA);

    // adopted BEFORE any sim frame: exactly one snapshot.get for the scene
    expect(player.simInfo).toMatchObject({ sceneId: SCENE_ID, ...PKG });
    expect(snapshotGets(hostGot)).toEqual([SCENE_ID]);

    // pre-start: the host served nothing (no crash, no reply), replica stays empty
    expect(player.simReplica).toBeNull();
    expect(player.simReplicaVersion).toBe(-1);
    expect(
      playerGot.filter(
        (m) => kind(m) === "sim.snapshot" || kind(m) === "sim.delta",
      ),
    ).toEqual([]);
  });

  test("a wrong constructor guess is overridden and its mis-decoded replica discarded", async () => {
    const { host, channel, joinLegacy } = await rig(
      [unit("u-red", -2)],
      [unit("u-blue", 5)],
    );
    host.setSimInfo({ sceneId: SCENE_ID, schema: PF1E_MODEL_SCHEMA, ...PKG });
    const { player, hostGot } = await joinLegacy();

    // the announcement replaced the hardcoded guess
    expect(player.simInfo).toMatchObject({ sceneId: SCENE_ID, ...PKG });
    expect(player.simReplica).toBeNull();
    expect(snapshotGets(hostGot)).toEqual([SCENE_ID]);

    // the campaign still reaches the corrected joiner
    await channel.start("stepwise");
    await flush();
    expect(player.simReplica?.count).toBe(2);
  });

  test("re-announcing the same info is a no-op; a changed schema resets and re-pulls", async () => {
    const { host, channel, gm, joins } = await rig(
      [unit("u-red", -2)],
      [unit("u-blue", 5)],
    );
    host.setSimInfo({ sceneId: SCENE_ID, schema: PF1E_MODEL_SCHEMA, ...PKG });
    const { player, hostGot, playerGot, playerBus } = await joins();
    const simEvents: Array<{ version: number; kind: string }> = [];
    playerBus.on("sim", (e) => simEvents.push(e));

    await channel.start("stepwise"); // snapshot broadcast → replica v0
    gm.simControl("advance"); // resolved turn → delta → replica v1 (PF1e seeding ran)
    await flush();
    expect(player.simReplica?.count).toBe(2);
    expect(player.simReplicaVersion).toBe(1);
    const getsBefore = snapshotGets(hostGot).length;

    // same info again → no extra welcome, no reset, replica untouched
    host.setSimInfo({ sceneId: SCENE_ID, schema: PF1E_MODEL_SCHEMA, ...PKG });
    await flush();
    expect(welcomes(playerGot)).toHaveLength(1);
    expect(player.simReplicaVersion).toBe(1);
    expect(snapshotGets(hostGot)).toHaveLength(getsBefore);

    // changed schema (package switch) → re-announce resets the replica and
    // re-pulls a snapshot; the replica is REBUILT (last event = snapshot),
    // never incrementally continued under the old shape.
    host.setSimInfo({
      sceneId: SCENE_ID,
      schema: MASS_BATTLE_SCHEMA_COLUMNS,
      packageId: null,
      version: "1.0.0",
    });
    await flush();
    const ws = welcomes(playerGot);
    expect(ws).toHaveLength(2);
    expect(ws[1]?.sim).toMatchObject({ packageId: null });
    expect(player.simInfo).toMatchObject({ packageId: null });
    expect(snapshotGets(hostGot).length).toBe(getsBefore + 1);
    expect(simEvents.length).toBeGreaterThan(0);
    expect(simEvents[simEvents.length - 1]?.kind).toBe("snapshot");
  });

  test("wire-level: adoption orders delta → queue → snapshot → replay (join order is safe)", async () => {
    // Frame-level ordering proof, mirroring tests/client/simReplica.test.ts but
    // entering through the welcome announcement instead of constructor options.
    const pair = createTransportPair();
    const bus = createEventBus<ClientEvents>();
    const client = new ClientSync({ transport: pair.a, bus, meta: baseMeta });
    const hostGot: WireMessage[] = [];
    const simEvents: string[] = [];
    bus.on("sim", (e) => simEvents.push(`${e.kind}:${e.version}`));
    tap(pair.b, hostGot);
    const hostSend = (msg: WireMessage): void =>
      pair.b.send("ops", frameMessage(msg as never));

    // 1. welcome announces the PF1e battle → client adopts + requests the scene
    hostSend({
      kind: "welcome",
      user: { id: PLAYER_ID, role: "PLAYER", name: "Red Player" },
      world: { id: "w", name: "W", system: "pf1e", version: "1.0.0" },
      snapshotSeq: 0,
      sim: { sceneId: SCENE_ID, schema: PF1E_MODEL_SCHEMA, ...PKG },
    });
    await flushMicrotasks();
    expect(client.simInfo).toMatchObject({ sceneId: SCENE_ID });
    expect(snapshotGets(hostGot)).toEqual([SCENE_ID]);

    // 2. a delta for the announced scene arrives BEFORE the snapshot → queued
    const v0 = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(v0, {
      id: 1,
      unitIdx: 0,
      x: 10,
      y: 10,
      hp: 10,
      hpMax: 10,
      sys: { ac: 18, fort: -2 },
    });
    const v1 = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(v1, {
      id: 1,
      unitIdx: 0,
      x: 20,
      y: 10,
      hp: 7,
      hpMax: 10,
      sys: { ac: 18, fort: -2 },
    });
    const delta = {
      ...diffPools(v0, v1, SCENE_ID, PF1E_MODEL_SCHEMA),
      fromVersion: 0,
      toVersion: 1,
    };
    hostSend({
      kind: "sim.delta",
      sceneId: SCENE_ID,
      from: 0,
      to: 1,
      bytes: encodeSimDelta(delta, 10),
    });
    await flushMicrotasks();
    expect(client.simReplica).toBeNull(); // queued, not applied
    expect(snapshotGets(hostGot)).toEqual([SCENE_ID]); // no second request

    // 3. the snapshot lands → replica installs, the queued delta replays in order
    hostSend({
      kind: "sim.snapshot",
      sceneId: SCENE_ID,
      version: 0,
      bytes: encodeSimSnapshot(
        snapshotFromPool(v0, SCENE_ID, 0, PF1E_MODEL_SCHEMA),
        10,
      ),
    });
    await flushMicrotasks();
    expect(client.simReplicaVersion).toBe(1);
    expect(simEvents).toEqual(["snapshot:0", "delta:1"]);
    // signed i8 survived the wire + replay
    const fort = client.simReplica?.sys["fort"] as Int8Array | undefined;
    expect(fort?.[0]).toBe(-2);
  });
});

describe("N02 — a second peer receives PF1e state (snapshots AND deltas)", () => {
  test("mid-battle joiner: signed saves + AC/profile columns over the snapshot path, then deltas", async () => {
    const { host, channel, gm, joins } = await rig(
      [unit("u-red", -2)],
      [unit("u-blue", 5)],
    );
    host.setSimInfo({ sceneId: SCENE_ID, schema: PF1E_MODEL_SCHEMA, ...PKG });

    // GM starts the campaign; the GM loopback itself rode the announcement.
    await channel.start("stepwise");
    await flush();
    expect(gm.simInfo).toMatchObject({ ...PKG });
    expect(gm.simReplica?.count).toBe(2);

    // one resolved turn seeds the PF1e pool columns (resolveTurn → seedPF1ePool)
    gm.simControl("advance");
    await flush();
    expect(gm.simReplicaVersion).toBeGreaterThan(0);

    // mid-battle joiner: adopts, requests, receives the CURRENT pool snapshot.
    // Armies sort by _id (army-blue first) → blue model = index 0, red = 1;
    // the Red Player owns f-red, so red is VISIBLE (blue stays hidden §5A).
    const { player } = await joins();
    expect(player.simInfo).not.toBeNull();
    const pool = player.simReplica;
    expect(pool).not.toBeNull();
    expect(pool?.count).toBe(2); // hidden slots keep indices (§5A)

    const RED = 1;
    const ac = pool?.sys["ac"] as Uint8Array | undefined;
    const fort = pool?.sys["fort"] as Int8Array | undefined;
    const profileIdx = pool?.sys["profileIdx"] as Uint16Array | undefined;
    expect(ac).toBeDefined();
    expect(fort).toBeDefined();
    expect(profileIdx).toBeDefined();
    expect(ac?.[RED]).toBe(18); // authored AC 18 (u8 column)
    expect(fort?.[RED]).toBe(-2); // signed i8 save crossed the wire intact
    expect(profileIdx?.[RED]).not.toBe(0); // interned profile id arrived

    // …and the delta path: the next turn (next → advance) applies on top
    // without a reset — same PF1e columns, incremental version.
    const before = player.simReplicaVersion;
    gm.simControl("next"); // report → orders (Turn 2)
    await flush();
    gm.simControl("advance"); // orders → resolution → report
    await flush();
    expect(player.simReplicaVersion).toBeGreaterThan(before);
    expect(player.simReplica?.count).toBe(2);
    const acAfter = player.simReplica?.sys["ac"] as Uint8Array | undefined;
    expect(acAfter?.[RED]).toBe(18); // reseeded defense, still decoding as PF1e
  });
});
