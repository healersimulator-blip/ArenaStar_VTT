/** Checked repeatable legacy/core baseline. Uses production rules/frames; does not start a network listener. */
import "fake-indexeddb/auto";
import { argv, memoryUsage, version } from "node:process";
import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";
import type {
  AssetManifest,
  SceneDocument,
  UserDocument,
} from "../../src/core/documents";
import { createEventBus } from "../../src/core/events";
import { MsgKind } from "../../src/core/messages";
import type {
  ChannelName,
  Transport,
  TransportMessageHandler,
} from "../../src/core/net";
import { OpLog } from "../../src/core/oplog";
import type { Op } from "../../src/core/ops";
import type { RulesContext, RulesModule, UnitView } from "../../src/core/rules";
import { SIM_POS_QUANTUM } from "../../src/core/sim";
import { DocumentStore } from "../../src/core/store";
import type {
  ArmyDocument,
  FactionDocument,
  Order,
  OrderQueue,
  UnitDocument,
} from "../../src/core/strategic";
import { UndoStack } from "../../src/core/undo";
import { SimBridge } from "../../src/host/simBridge";
import { HostSync, type HostEvents } from "../../src/host/sync";
import { TurnChannel } from "../../src/host/turnChannel";
import { deframeMessage, frameMessage } from "../../src/net/frame";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { decodeSimSnapshot, poolFromSnapshot } from "../../src/sim/codec";
import { deploySnapshot } from "../../src/sim/deploy";
import { SimRunnerCore, type SimResolveResult } from "../../src/sim/runner";
import { openVttDb } from "../../src/storage/idb";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";

const SCENE = "battle";
const SEED = 4242;
const FACTIONS = ["blue", "red"] as const;
const SCENARIOS = [
  "idle",
  "hold",
  "contact",
  "mixed",
  "march",
  "dense",
  "doctrine",
] as const;
type Scenario = (typeof SCENARIOS)[number];
const playerId = (p: number) => `p${String(p).padStart(3, "0")}`;
const now = () => performance.now();
const round = (n: number) => Math.round(n * 10) / 10;
const ms = (start: number) => round(now() - start);
const log = (record: Record<string, unknown>) =>
  console.log(JSON.stringify(record));

function fixture(players: number, unitsPerPlayer: number, scenario: Scenario) {
  const factions: FactionDocument[] = FACTIONS.map((_id) => ({
    _id,
    name: _id,
    type: "faction",
    ownership: { default: 1 },
    flags: {},
    system: {},
    allies: [],
    color: _id === "blue" ? "#0000ff" : "#ff0000",
  }));
  const users: UserDocument[] = [];
  const armies: ArmyDocument[] = [];
  const unitViews: UnitView[] = [];
  const orders: Array<[string, OrderQueue]> = [];
  const size = 100 / unitsPerPlayer;
  const across = Math.ceil(Math.sqrt((players / 2) * unitsPerPlayer));
  const pitchX = scenario === "dense" ? 30 : 75;
  const pitchY = scenario === "dense" ? 50 : 75;
  const origin = -Math.floor(across / 2) * 75;
  for (let p = 0; p < players; p++) {
    const userId = playerId(p);
    const armyId = `army-${userId}`;
    const side = p % 2;
    const factionId = side === 0 ? "blue" : "red";
    users.push({
      _id: userId,
      name: userId,
      type: "user",
      ownership: { default: 0 },
      flags: {},
      system: {},
      role: "PLAYER",
      character: null,
      color: "#aaaabb",
    });
    const units: UnitDocument[] = [];
    for (let u = 0; u < unitsPerPlayer; u++) {
      const _id = `${armyId}-u${u}`;
      const tile = Math.floor(p / 2) * unitsPerPlayer + u;
      const work =
        scenario === "mixed"
          ? ((["contact", "contact", "shot", "march"] as const)[tile % 10] ??
            "hold")
          : scenario;
      // Each opposing pair gets a 75-ft block. Center the battlefield in the i16/16
      // coordinate range and start with exactly one model per square, even at 50k.
      const separation =
        work === "contact" || work === "dense" || work === "doctrine"
          ? 5 * Math.ceil(size / 10)
          : 40;
      const x = origin + (tile % across) * pitchX + 10 + side * separation;
      const firstY = origin + Math.floor(tile / across) * pitchY + 10;
      const y = firstY + 22.5; // line formation files are centered on the anchor
      const profile = { anchor: { x, y } };
      const stats: UnitDocument["stats"] = {
        strength: size,
        morale: 10,
        supply: 5,
        fatigue: 0,
        bab: 6,
        strMod: 3,
        ac: 16,
        touchAc: 11,
        hp: 10,
        fort: 5,
        ref: 4,
        will: 3,
        damageDiceCount: 1,
        damageDiceSides: 8,
        damageMod: 3,
      };
      if (work === "shot")
        Object.assign(stats, {
          weaponIsRanged: 1,
          weaponRangeIncrement: 60,
          weaponMaxIncrements: 10,
        });
      const type = work === "shot" ? "archer" : "infantry";
      let pending: Order[] = [];
      if (work === "march")
        pending = [
          { kind: "move", path: [{ x: x + 10, y: firstY }], pace: "march" },
        ];
      else if (work === "contact" || work === "dense" || work === "shot")
        pending = [
          {
            kind: "attack",
            targetUnitId: `army-${playerId(p ^ 1)}-u${u}`,
            mode: work === "shot" ? "shot" : "melee",
          },
        ];
      else if (work === "hold") pending = [{ kind: "hold", stance: "hold" }];
      const queue: OrderQueue = { pending, issuedBy: userId, issuedTurn: 1 };
      if (pending.length) orders.push([_id, queue]);
      units.push({
        _id,
        type,
        name: _id,
        ownership: { default: 0 },
        flags: {},
        system: {},
        profile,
        stats,
        orders: queue,
        formation: "line",
        sceneId: SCENE,
        modelRange: null,
      });
      unitViews.push({
        id: _id,
        armyId,
        factionId,
        type,
        name: _id,
        profile,
        stats,
        orders: queue,
        formation: "line",
        sceneId: SCENE,
        modelRange: null,
        leaderTokenId: null,
      });
    }
    armies.push({
      _id: armyId,
      type: "army",
      name: armyId,
      ownership: { default: 0, [userId]: 3 },
      flags: {},
      system: {},
      factionId,
      commander: [userId],
      supply: { level: 5 },
      units,
    });
  }
  return { factions, armies, users, unitViews, orders };
}

type Fixture = ReturnType<typeof fixture>;
const grid: SceneDocument["grid"] = {
  type: "square",
  size: 100,
  distance: 5,
  units: "ft",
  diagonals: "555",
  hexLayout: "evenQ",
};

function deploy({ unitViews, factions, armies, users }: Fixture) {
  const deployed = deploySnapshot(unitViews, factions, PF1E_MODEL_SCHEMA, {
    spacing: grid.distance,
  });
  const ranges = new Map(deployed.ranges);
  for (const view of unitViews) view.modelRange = ranges.get(view.id) ?? null;
  for (const army of armies)
    for (const unit of army.units)
      unit.modelRange = ranges.get(unit._id) ?? null;
  const pool = poolFromSnapshot(
    decodeSimSnapshot(deployed.bytes).snapshot,
    deployed.maxHpMax,
    PF1E_MODEL_SCHEMA,
  );
  const seen = new Set<string>();
  const lo = -32768 / SIM_POS_QUANTUM + 20;
  const hi = 32767 / SIM_POS_QUANTUM - 20;
  for (let i = 0; i < pool.count; i++) {
    const x = pool.x[i];
    const y = pool.y[i];
    if (
      x === undefined ||
      y === undefined ||
      x < lo ||
      x > hi ||
      y < lo ||
      y > hi
    )
      throw new Error("fixture geometry too close to codec limits");
    seen.add(
      `${Math.floor(x / grid.distance)},${Math.floor(y / grid.distance)}`,
    );
  }
  if (pool.count !== users.length * 100 || seen.size !== pool.count)
    throw new Error("invalid deployment occupancy");
  return deployed;
}

function instrumentRules() {
  let rulesMs = 0;
  let forecastMs = 0;
  const rules = createMassBattlePf1e();
  const forecast = rules.forecast;
  if (!forecast) throw new Error("expected a PF1e forecast hook");
  const timed: RulesModule = {
    ...rules,
    resolveTurn(...args) {
      const start = now();
      rules.resolveTurn(...args);
      rulesMs = now() - start;
      log({ stage: "rulesDone", rulesMs: round(rulesMs) });
    },
    forecast(...args) {
      const start = now();
      const result = forecast(...args);
      forecastMs += now() - start;
      return result;
    },
  };
  return {
    timed,
    rulesMs: () => round(rulesMs),
    forecastMs: () => round(forecastMs),
  };
}

function describeResult(out: SimResolveResult) {
  const eventTypes: Record<string, number> = {};
  let attacks = 0;
  let hits = 0;
  for (const event of out.report.events) {
    eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
    if (typeof event.data?.["totalAttacks"] === "number")
      attacks += event.data["totalAttacks"];
    if (typeof event.data?.["hits"] === "number") hits += event.data["hits"];
  }
  const encoding = now();
  const reportFrameBytes = frameMessage({
    kind: "turn.report",
    turnId: `turn:${SCENE}:1`,
    report: out.report,
  }).byteLength;
  return {
    events: out.report.events.length,
    eventTypes,
    attacks,
    hits,
    deltaBytes: out.deltaBytes.byteLength,
    checkpointBytes: out.checkpointBytes.byteLength,
    reportFrameBytes,
    reportFrameMs: ms(encoding),
    rssMiB: Math.round(memoryUsage().rss / 1024 ** 2),
    hash: out.poolHash,
  };
}

function simulate(players: number, unitsPerPlayer: number, scenario: Scenario) {
  const data = fixture(players, unitsPerPlayer, scenario);
  const { factions, armies, unitViews, orders } = data;
  const ctx: RulesContext = {
    sceneId: SCENE,
    grid,
    walls: {
      x1: new Float32Array(),
      x2: new Float32Array(),
      y1: new Float32Array(),
      y2: new Float32Array(),
      restriction: new Uint8Array(),
    },
    factions,
    armies,
    leaderActors: {},
    turnMode: "simultaneous",
    worldSettings: scenario === "doctrine" ? { strategicDoctrine: true } : {},
  };
  const setup = now();
  const deployed = deploy(data);
  const rules = instrumentRules();
  const runner = new SimRunnerCore(
    {
      sceneId: SCENE,
      sys: PF1E_MODEL_SCHEMA,
      ctx,
      units: unitViews,
      snapshot: {
        bytes: deployed.bytes,
        maxHpMax: deployed.maxHpMax,
        version: 0,
      },
    },
    rules.timed,
  );
  log({
    stage: "simStart",
    node: version,
    players,
    units: unitViews.length,
    models: players * 100,
    orderCount: orders.length,
    scenario,
    setupMs: ms(setup),
    deployBytes: deployed.bytes.byteLength,
  });
  const resolving = now();
  const out = runner.resolve({ orders, seed: SEED, turnNumber: 1 });
  log({
    stage: "simDone",
    resolveMs: ms(resolving),
    rulesMs: rules.rulesMs(),
    forecastMs: rules.forecastMs(),
    ...describeResult(out),
  });
}

class CountWire implements Transport {
  onMessage: TransportMessageHandler | null = null;
  readonly stats = {
    connected: true,
    channels: {
      ops: { sentBytes: 0, sentMessages: 0, bufferedAmount: 0 },
      ephemeral: { sentBytes: 0, sentMessages: 0, bufferedAmount: 0 },
      assets: { sentBytes: 0, sentMessages: 0, bufferedAmount: 0 },
      sim: { sentBytes: 0, sentMessages: 0, bufferedAmount: 0 },
    },
  };
  readonly counts = new Map<number, { frames: number; bytes: number }>();
  phase: string | undefined;
  send(channel: ChannelName, bytes: Uint8Array) {
    this.stats.channels[channel].sentBytes += bytes.byteLength;
    this.stats.channels[channel].sentMessages++;
    const kind = bytes[0];
    if (kind === undefined) throw new Error("empty host frame");
    const s = this.counts.get(kind) ?? { frames: 0, bytes: 0 };
    s.frames++;
    s.bytes += bytes.byteLength;
    this.counts.set(kind, s);
    if (kind === MsgKind["turn.phase"]) {
      const decoded = deframeMessage(bytes);
      if (decoded.ok && decoded.value.kind === "turn.phase")
        this.phase = decoded.value.phase;
    }
  }
  close() {
    this.onMessage = null;
  }
}

function total(wires: readonly CountWire[], kind: number) {
  return wires.reduce(
    (sum, wire) => {
      const entry = wire.counts.get(kind);
      sum.frames += entry?.frames ?? 0;
      sum.bytes += entry?.bytes ?? 0;
      return sum;
    },
    { frames: 0, bytes: 0 },
  );
}

function room(data: Fixture) {
  const assetManifest: AssetManifest = Object.fromEntries(
    Array.from({ length: 200 }, (_, i) => [
      i.toString(16).padStart(64, "0"),
      {
        name: `media-${i}`,
        mime: "image/webp",
        size: 1024,
        chunks: 1,
        visibility: i % 3 === 0 ? "world" : "referenced",
      },
    ]),
  );
  const scene: SceneDocument = {
    _id: SCENE,
    type: "scene",
    name: SCENE,
    ownership: { default: 1 },
    flags: { core: { scale: "strategic" } },
    system: {},
    img: null,
    active: true,
    darkness: 0,
    width: 80_000,
    height: 80_000,
    grid,
    tokens: [],
    walls: [],
    tiles: [],
    lights: [],
    regions: [],
    drawings: [],
    sounds: [],
    templates: [],
    notes: [],
  };
  const store = new DocumentStore({
    meta: {
      worldId: SCENE,
      name: "Scale probe",
      system: "pf1e-mass-battles",
      systemVersion: "1.0.0",
    },
  });
  store.hydrate(
    {
      users: data.users,
      armies: data.armies,
      factions: data.factions,
      scenes: [scene],
      assetManifest,
    },
    0,
  );
  let manifestLookups = 0;
  const host = new HostSync({
    store,
    log: new OpLog(),
    undo: new UndoStack(),
    bus: createEventBus<HostEvents>(),
    systemUserId: "gm",
    roomId: SCENE,
    manifest: () => {
      manifestLookups++;
      return store.world.assetManifest;
    },
  });
  const attach = (u: UserDocument) => {
    const wire = new CountWire();
    // Already authenticated and provisioned. No cryptography or network in these timings.
    host.addSession(u._id, wire, { id: u._id, name: u.name, role: "PLAYER" });
    return wire;
  };
  return {
    store,
    host,
    attach,
    manifestEntries: Object.keys(assetManifest).length,
    manifestLookups: () => manifestLookups,
  };
}

function fanout(players: number, unitsPerPlayer: number, batchLimit: number) {
  const data = fixture(players, unitsPerPlayer, "hold");
  const { store, host, attach, manifestEntries, manifestLookups } = room(data);
  const join = now();
  const wires = data.users.map(attach);
  const readyMs = ms(join);
  log({
    stage: "fanoutStart",
    players,
    units: players * unitsPerPlayer,
    readyMs,
  });
  const lookupsBefore = manifestLookups();
  const wall = now();
  const commits: number[] = [];
  let inboundBytes = 0;
  for (const [i, army] of data.armies.slice(0, batchLimit).entries()) {
    const wire = wires[i];
    if (!wire?.onMessage) throw new Error("missing connected army commander");
    const ops: Op[] = army.units.map((unit) => ({
      kind: "update",
      ref: {
        coll: "units",
        id: unit._id,
        parent: { coll: "armies", id: army._id },
      },
      diff: { "orders.pending": [{ kind: "hold", stance: "defend" }] },
    }));
    const bytes = frameMessage({ kind: "intent", txId: `orders-${i}`, ops });
    inboundBytes += bytes.byteLength;
    const begin = now();
    wire.onMessage("ops", bytes);
    commits.push(now() - begin);
    if (wire.counts.has(MsgKind.rejected) || store.seq !== i + 1)
      throw new Error("probe intent did not commit");
    if ((i + 1) % 50 === 0)
      log({ stage: "fanoutProgress", completed: i + 1, ordersMs: ms(wall) });
  }
  const ordersMs = ms(wall);
  const orderManifestLookups = manifestLookups() - lookupsBefore;
  commits.sort((a, b) => a - b);
  const percentile = (p: number) =>
    round(commits[Math.ceil(p * commits.length) - 1] ?? NaN);
  const reconnections = data.users.slice(0, 50);
  for (const u of reconnections) host.removeSession(u._id);
  const reconnect = now();
  const fresh = reconnections.map(attach);
  const reconnectMs = ms(reconnect);
  log({
    stage: "fanout",
    node: version,
    players,
    units: players * unitsPerPlayer,
    readyMs,
    manifestEntries,
    welcomeSnapshots: total(wires, MsgKind.snapshot),
    submittedBatches: commits.length,
    ordersMs,
    orderManifestLookups,
    commitP50: percentile(0.5),
    commitP95: percentile(0.95),
    inboundBytes,
    sentOps: total(wires, MsgKind.ops),
    manifestUpdates: total(wires, MsgKind["asset.manifest"]),
    reconnectMs,
    reconnectSnapshots: total(fresh, MsgKind.snapshot),
  });
}

async function until(
  done: () => boolean,
  error: () => string | null = () => null,
) {
  const end = now() + 110_000;
  while (!done()) {
    const why = error();
    if (why) throw new Error(why);
    if (now() >= end) throw new Error("projection probe did not finish");
    await wait(5);
  }
}

async function turn(
  players: number,
  unitsPerPlayer: number,
  scenario: Scenario,
) {
  const data = fixture(players, unitsPerPlayer, scenario);
  const deployed = deploy(data);
  const { host, store, attach } = room(data);
  const db = await openVttDb();
  try {
    const rules = instrumentRules();
    const runner = new InlineSimRunner(rules.timed);
    const bridge = new SimBridge(SCENE, {
      db,
      worldId: SCENE,
      runner,
      sys: PF1E_MODEL_SCHEMA,
    });
    let workerReturnMs: number | undefined;
    let coreResult: SimResolveResult | undefined;
    const resolve = runner.resolve.bind(runner);
    runner.resolve = async (...args) => {
      const result = await resolve(...args);
      workerReturnMs = now(); // no real worker; this marks completion of the inline core
      coreResult = result;
      return result;
    };
    const channel = new TurnChannel({
      host,
      store,
      bridge,
      sceneId: SCENE,
      seed: SEED,
      sys: PF1E_MODEL_SCHEMA,
    });
    const wires = data.users.map(attach);
    const gm = new CountWire();
    host.addSession("gm", gm, { id: "gm", name: "GM", role: "GM" });
    // Pre-deployed fixture avoids timing a full 500-user snapshot broadcast. Time the
    // real sim snapshot path for a smaller reconnect sample before producing a turn.
    await channel.start("simultaneous", deployed);
    const snapshotGet = frameMessage({
      kind: "sim.snapshot.get",
      sceneId: SCENE,
    });
    const reconnectUsers = data.users.slice(0, 10);
    const rejoined: CountWire[] = [];
    const snapshotStart = now();
    for (const [i, u] of reconnectUsers.entries()) {
      host.removeSession(u._id);
      const wire = attach(u);
      wires[i] = wire;
      rejoined.push(wire);
      wire.onMessage?.("sim", snapshotGet);
      await until(() => wire.counts.has(MsgKind["sim.snapshot"]));
    }
    log({
      stage: "simReconnects",
      count: rejoined.length,
      elapsedMs: ms(snapshotStart),
      docs: total(rejoined, MsgKind.snapshot),
      sim: total(rejoined, MsgKind["sim.snapshot"]),
    });
    const begin = now();
    gm.onMessage?.(
      "sim",
      frameMessage({ kind: "sim.control", action: "advance" }),
    );
    await until(
      () => gm.phase === "report",
      () => channel.lastError,
    );
    const sentReports = total(wires, MsgKind["turn.report"]);
    const sentDeltas = total(wires, MsgKind["sim.delta"]);
    if (
      sentReports.frames !== players ||
      sentDeltas.frames !== players ||
      workerReturnMs === undefined
    ) {
      throw new Error("turn was not delivered to every synthetic session");
    }
    const totalMs = ms(begin);
    const afterCoreMs = ms(workerReturnMs);
    log({
      stage: "turnDone",
      players,
      units: players * unitsPerPlayer,
      scenario,
      totalMs,
      afterCoreMs,
      forecastMs: rules.forecastMs(),
      sentReports,
      sentDeltas,
      ...(coreResult && describeResult(coreResult)),
    });
  } finally {
    db.close();
  }
}

const [, , mode, rawPlayers, rawUnits, rawScenario] = argv;
const players = Number(rawPlayers ?? 500);
const units = Number(rawUnits ?? 10);
const scenario = SCENARIOS.find((value) => value === rawScenario);
if (
  !Number.isInteger(players) ||
  players < 2 ||
  players > 500 ||
  players % 2 !== 0 ||
  (units !== 5 && units !== 10)
) {
  throw new Error("pass an even player count 2–500 and 5 or 10 units/player");
}
if (mode === "sim" && scenario) simulate(players, units, scenario);
else if (mode === "turn" && scenario && scenario !== "doctrine")
  await turn(players, units, scenario);
else if (mode === "fanout") {
  const limit = Number(rawScenario ?? players);
  if (!Number.isInteger(limit) || limit < 1 || limit > players)
    throw new Error("invalid order batch limit");
  fanout(players, units, limit);
} else
  throw new Error(
    "usage: strategic500Probe.js <sim|turn> <players> <units/player> <scenario> | fanout <players> <units/player> [batchLimit]",
  );
