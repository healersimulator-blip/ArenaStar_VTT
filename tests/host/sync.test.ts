import { environmentPlaceables } from "../fixtures/automationPlaceables";
// Checklist: S03 — host/GM/two-player replication of a sheet edit and host rejection of a forged non-owner update.
import { editSelectedRoster, selectedTokens } from "../../src/ui/combat/tokenSelection";
import {
  rollEncounterInitiative,
  rollSelectedInitiative,
} from "../../src/ui/combat/initiative";
import {
  activateEncounter,
  newEncounter,
  selectedEncounter,
} from "../../src/ui/combat/encounters";
import { acRevision, previewAcConversion } from "../../src/ui/sheets/pf1eAcConversion";
import { pf1eAttackEdit, pf1eAttackEditorView } from "../../src/ui/sheets/pf1eAttackEditor";
import { observePF1eSheetActor } from "../../src/ui/sheets/pf1eSheetWindow";
import { pf1eSheetEdit, pf1eSheetView } from "../../src/ui/sheets/pf1eSheetModel";
import { describe, expect, test, vi } from "vitest";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import type { ScriptRunner } from "../../src/host/scriptWorker";
import { scriptApprovalHash, type ScriptPolicy } from "../../src/core/scriptMacros";
import { worldSettingsDoc, worldSettingsOps } from "../../src/core/worldSettings";
import type { AutomationDefinition } from "../../src/core/automation";
import { COMBAT_TRIGGER_METHODS } from "../../src/core/combat";
import { readWorldClock } from "../../src/packages/pf1e/worldClock";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import { summarizeSkips } from "../../src/core/fxDelivery";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import type { FxStartMsg, HelloMsg } from "../../src/core/messages";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type {
  ActorDocument,
  AssetManifest,
  AutomationDocument,
  CombatantDocument,
  CombatDocument,
  DrawingDocument,
  ItemDocument,
  Json,
  JournalDocument,
  MacroDocument,
  MessageDocument,
  NoteDocument,
  PrefabDocument,
  RegionDocument,
  RollTableDocument,
  SceneDocument,
  TileDocument,
  TokenDocument,
  UserDocument,
  WallDocument,
  WorldCollections,
} from "../../src/core/documents";
import { frameMessage, channelFor } from "../../src/net/frame";
import { tagEditOps } from "../../src/core/tags";
import { planDuplicateSceneOps } from "../../src/core/sceneCopy";

const meta: StoreMeta = {
  worldId: "w1",
  name: "World",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};
const GM_ID = "gm-key";
const PLAYER_ID = "pl-key";
const OTHER_ID = "ot-key";

function sceneDoc(id: string): SceneDocument {
  return {
    _id: id,
    type: "scene",
    name: `Scene ${id}`,
    ownership: { default: 2 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 1000,
    height: 1000,
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

function tokenDoc(id: string, over: Partial<TokenDocument> = {}): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: `Token ${id}`,
    ownership: { default: 0 },
    flags: {},
    system: {},
    x: 0,
    y: 0,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: "neutral",
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
    ...over,
  };
}

function userDoc(
  id: string,
  name: string,
  role: UserDocument["role"] = "PLAYER",
): UserDocument {
  return {
    _id: id,
    type: "user",
    name,
    ownership: { default: 0 },
    flags: {},
    system: {},
    role,
    character: null,
    color: "#fff",
  };
}

const tokenRef = {
  coll: "tokens" as const,
  id: "t-pl",
  parent: { coll: "scenes" as const, id: "s1" },
};

interface Harness {
  host: HostSync;
  hostStore: DocumentStore;
  hostLog: OpLog;
  hostBus: EventBus<HostEvents>;
  gm: ClientSync;
  gmBus: EventBus<ClientEvents>;
  gmPair: ReturnType<typeof createTransportPair>;
  addPlayer(
    pubkey: string,
    name: string,
    opts?: { autoApprove?: boolean; lastSeq?: number },
  ): Promise<{ client: ClientSync; bus: EventBus<ClientEvents>; pair: ReturnType<typeof createTransportPair> }>;
}

async function setup(manifest: AssetManifest = {}, scriptRunner?: ScriptRunner, rng?: () => number,
  now?: () => number): Promise<Harness> {
  const hostStore = new DocumentStore({ meta });
  (hostStore.world as WorldCollections).assetManifest = manifest;
  const hostLog = new OpLog();
  const undo = new UndoStack();
  const hostBus = createEventBus<HostEvents>();
  const host = new HostSync({
    store: hostStore,
    log: hostLog,
    undo,
    bus: hostBus,
    systemUserId: GM_ID,
    roomId: "room-7",
    verifyHelloSig: async (hello) => hello.sig === "valid",
    ...(scriptRunner ? { scriptRunner } : {}),
    rng: rng ?? (() => 0.25), // deterministic host rolls: 1d20 → 6, 1d6 → 2
    ...(now ? { now } : {}),
  });

  const seedEnvelope = (seq: number, ops: Op[], txId: string): OpEnvelope => ({
    seq,
    ts: 0,
    by: GM_ID,
    ops,
    txId,
  });
  const seeds: OpEnvelope[] = [
    seedEnvelope(
      1,
      [
        { kind: "create", coll: "users", data: userDoc(GM_ID, "GM", "GM") },
        { kind: "create", coll: "users", data: userDoc(PLAYER_ID, "Rex") },
        { kind: "create", coll: "users", data: userDoc(OTHER_ID, "Ivy") },
        { kind: "create", coll: "scenes", data: sceneDoc("s1") },
      ],
      "seed-1",
    ),
    seedEnvelope(
      2,
      [
        {
          kind: "create",
          coll: "tokens",
          parent: { coll: "scenes", id: "s1" },
          data: tokenDoc("t-pl", { ownership: { default: 0, [PLAYER_ID]: 3 } }),
        },
        {
          kind: "create",
          coll: "tokens",
          parent: { coll: "scenes", id: "s1" },
          data: tokenDoc("t-ivy", { ownership: { default: 0, [OTHER_ID]: 3 } }),
        },
      ],
      "seed-2",
    ),
  ];
  for (const env of seeds) {
    const applied = hostStore.applyEnvelope(env);
    if (!applied.ok) throw new Error(applied.error);
    const appended = hostLog.append(env, applied.value.inverses);
    if (!appended.ok) throw new Error(appended.error);
    undo.push(env, applied.value.inverses);
  }

  // GM loopback (§2: the GM tab runs Host + Client cores over InMemoryTransport)
  const gmPair = createTransportPair();
  host.addSession("gm", gmPair.a, gmSessionUser(GM_ID));
  const gmBus = createEventBus<ClientEvents>();
  const gm = new ClientSync({ transport: gmPair.b, bus: gmBus, meta });
  await flushMicrotasks();

  const addPlayer = async (
    pubkey: string,
    name: string,
    opts: { autoApprove?: boolean; lastSeq?: number } = {},
  ) => {
    const pair = createTransportPair();
    host.addSession(`peer-${pubkey}`, pair.a);
    const bus = createEventBus<ClientEvents>();
    const client = new ClientSync({ transport: pair.b, bus, meta });
    const hello: HelloMsg = {
      kind: "hello",
      pubkey,
      displayName: name,
      ts: 1,
      sig: "valid",
      ...(opts.lastSeq !== undefined ? { lastSeq: opts.lastSeq } : {}),
    };
    if (opts.autoApprove !== false) {
      hostBus.on("join:request", ({ approve }) => approve());
    }
    client.connect(hello);
    await flushMicrotasks();
    return { client, bus, pair };
  };

  return { host, hostStore, hostLog, hostBus, gm, gmBus, gmPair, addPlayer };
}

describe("HostSync ⇄ ClientSync over InMemoryTransport (§2, §5, §6.4)", () => {
  test("player walk uses the linked PF1e speed; GM movement bypasses the allowance", async () => {
    const h = await setup();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const actor: ActorDocument = {
      _id: "slow-walker", type: "actor", name: "Slow Walker",
      ownership: { default: 0, [PLAYER_ID]: 3 }, flags: {},
      system: { pf1e: { landSpeedFt: 20, size: "Medium", abilities: { str: 10, dex: 10, con: 10 } } },
      items: [], effects: [],
    };
    h.gm.submit([
      { kind: "create", coll: "actors", data: actor },
      { kind: "update", ref: tokenRef, diff: { actorId: actor._id, x: 50, y: 250 } },
      { kind: "update", ref: { ...tokenRef, id: "t-ivy" }, diff: { x: 900, y: 900 } },
    ]);
    await flushMicrotasks();
    const refused: ClientEvents["rejected"][] = [];
    bus.on("rejected", (event) => refused.push(event));
    player.submit([{ kind: "update", ref: tokenRef, diff: { actorId: null, x: 550, y: 250 } }]);
    await flushMicrotasks();
    expect(refused.at(-1)?.detail).toMatch(/only GMs link tokens to actors/i);
    expect(h.hostStore.resolve(tokenRef)).toMatchObject({ actorId: actor._id, x: 50, y: 250 });
    const beforeRejected = h.hostStore.seq;
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 550, y: 250 } }]); // 25 ft > linked actor's 20 ft speed
    await flushMicrotasks();
    expect(refused.at(-1)?.detail).toMatch(/walk costs 25 ft/i);
    expect(h.hostStore.seq).toBe(beforeRejected);
    expect(h.hostStore.resolve(tokenRef)).toMatchObject({ x: 50, y: 250 });

    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 450, y: 250 } }]); // exactly the derived 20 ft
    await flushMicrotasks();
    expect(h.hostStore.resolve(tokenRef)).toMatchObject({ x: 450, y: 250 });

    h.gm.submit([{ kind: "update", ref: tokenRef, diff: { x: 950, y: 250 } }]); // 25 ft: GM override
    await flushMicrotasks();
    expect(h.hostStore.resolve(tokenRef)).toMatchObject({ x: 950, y: 250 });
  });

  test("join flow: hello → approval → welcome + projected snapshot", async () => {
    const h = await setup();
    const { client } = await h.addPlayer(PLAYER_ID, "Rex");
    expect(client.user).toEqual({ id: PLAYER_ID, role: "PLAYER", name: "Rex" });
    expect(client.world?.name).toBe("World");
    expect(client.store.get("scenes", "s1")).toBeDefined();
    expect(client.store.seq).toBe(2);
    // GM user + own user docs are in the snapshot (users always projected, D-021)
    expect(client.store.get("users", GM_ID)?.role).toBe("GM");
  });

  test("unknown pubkeys wait for GM approval (join:request)", async () => {
    const h = await setup();
    const pair = createTransportPair();
    h.host.addSession("peer-nova", pair.a);
    const bus = createEventBus<ClientEvents>();
    const nova = new ClientSync({ transport: pair.b, bus, meta });
    nova.connect({
      kind: "hello",
      pubkey: "nova-key",
      displayName: "Nova",
      ts: 1,
      sig: "valid",
    });
    await flushMicrotasks();
    expect(nova.user).toBeNull(); // awaiting approval

    const requests: HostEvents["join:request"][] = [];
    h.hostBus.on("join:request", (req) => requests.push(req));
    // re-hello on the same session (still unauthenticated)
    nova.connect({
      kind: "hello",
      pubkey: "nova-key",
      displayName: "Nova",
      ts: 2,
      sig: "valid",
    });
    await flushMicrotasks();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.hello.displayName).toBe("Nova");

    requests[0]?.approve();
    await flushMicrotasks();
    expect(nova.user).toEqual({ id: "nova-key", role: "PLAYER", name: "Nova" });
    expect(h.hostStore.get("users", "nova-key")?.name).toBe("Nova");
  });

  test("invalid hello signatures are disconnected", async () => {
    const h = await setup();
    const pair = createTransportPair();
    h.host.addSession("peer-bad", pair.a);
    const bus = createEventBus<ClientEvents>();
    const client = new ClientSync({ transport: pair.b, bus, meta });
    client.connect({
      kind: "hello",
      pubkey: "bad-key",
      displayName: "Mallory",
      ts: 1,
      sig: "WRONG",
    });
    await flushMicrotasks();
    expect(client.user).toBeNull();
    expect(h.host.sessionCount).toBe(1); // only GM remains
  });

  test("player token move: optimistic echo → commit reconciles; GM sees the move (§14)", async () => {
    const h = await setup();
    const { client } = await h.addPlayer(PLAYER_ID, "Rex");

    client.submit([{ kind: "update", ref: tokenRef, diff: { x: 512 } }]);
    expect((client.echo.resolve(tokenRef) as TokenDocument | undefined)?.x).toBe(512); // optimistic
    expect((client.store.resolve(tokenRef) as TokenDocument | undefined)?.x).toBe(0); // replica untouched

    await flushMicrotasks();
    expect((client.store.resolve(tokenRef) as TokenDocument | undefined)?.x).toBe(512);
    expect((client.echo.resolve(tokenRef) as TokenDocument | undefined)?.x).toBe(512);
    expect(client.lastSeq).toBe(3);
    expect((h.gm.store.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(512);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(512);
    expect(h.hostLog.lastSeq).toBe(3);
  });

  test("forbidden move: rejected → optimistic rollback (§5)", async () => {
    const h = await setup();
    const { client, bus } = await h.addPlayer(OTHER_ID, "Ivy");
    const rejections: Array<{ txId: string; reason: string }> = [];
    bus.on("rejected", (r) => rejections.push({ txId: r.txId, reason: r.reason }));

    client.submit([{ kind: "update", ref: tokenRef, diff: { x: 999 } }]);
    expect((client.echo.resolve(tokenRef) as TokenDocument | undefined)?.x).toBe(999);
    await flushMicrotasks();

    expect(rejections).toEqual([{ txId: rejections[0]?.txId ?? "", reason: "forbidden" }]);
    expect(h.hostStore.seq).toBe(2); // nothing applied
    expect((client.echo.resolve(tokenRef) as TokenDocument | undefined)?.x).toBe(0); // rolled back
    expect((client.store.resolve(tokenRef) as TokenDocument | undefined)?.x).toBe(0);
  });

  test("rate limit: intent floods beyond the bucket are rejected (§16, D-025)", async () => {
    // Freeze the host limiter clock: concurrently running checks otherwise allow
    // a refill mid-burst and make the expected rejection count timing-dependent.
    const h = await setup({}, undefined, undefined, () => 100_000);
    const { client, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejections: string[] = [];
    bus.on("rejected", (r) => rejections.push(r.reason));

    for (let i = 0; i < 40; i++) {
      client.submit([{ kind: "update", ref: tokenRef, diff: { x: i } }]);
    }
    await flushMicrotasks();
    // bucket = burst 30 @ 30/s (clock frozen within the test tick): 30 apply, 10 rejected
    expect(rejections.filter((r) => r === "rate_limited")).toHaveLength(10);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(29);
    expect(h.hostStore.seq).toBe(2 + 30);
  });

  test("chat: message authors are host-stamped, not client-trusted (§4)", async () => {
    const h = await setup();
    const { client } = await h.addPlayer(PLAYER_ID, "Rex");
    const forged: MessageDocument = {
      _id: "m1",
      type: "message",
      name: "m1",
      ownership: { default: 2 },
      flags: {},
      system: {},
      author: "forged-attacker",
      content: "hello",
      whisper: [],
      roll: null,
      flavor: "",
    };
    client.submit([{ kind: "create", coll: "messages", data: forged }]);
    await flushMicrotasks();
    expect((h.gm.store.get("messages", "m1") as MessageDocument).author).toBe(PLAYER_ID);
  });

  test("rolls resolve on the host; gmroll result hidden from other players (§11, §5)", async () => {
    const h = await setup();
    const { client } = await h.addPlayer(PLAYER_ID, "Rex");
    const { client: other } = await h.addPlayer(OTHER_ID, "Ivy");

    client.roll("1d20+5"); // rng 0.25 → die 6 → total 11
    await flushMicrotasks();
    const rollMsg = h.gm.store.getAll("messages")[0] as MessageDocument;
    expect(rollMsg.roll?.total).toBe(11);
    expect(rollMsg.author).toBe(PLAYER_ID);
    expect((client.store.get("messages", rollMsg._id) as MessageDocument).roll?.total).toBe(11);

    client.roll("1d6", "gmroll");
    await flushMicrotasks();
    const gmroll = h.gm.store.getAll("messages")[1] as MessageDocument;
    expect((h.gm.store.get("messages", gmroll._id) as MessageDocument).roll).not.toBeNull();
    expect((client.store.get("messages", gmroll._id) as MessageDocument).roll).not.toBeNull(); // roller
    expect((other.store.get("messages", gmroll._id) as MessageDocument).roll).toBeNull(); // redacted
  });

  test("roll flavor rides the wire and lands on the roll card (§11, A06)", async () => {
    const h = await setup();
    const { client } = await h.addPlayer(PLAYER_ID, "Rex");

    client.roll(
      "1d20 + 9",
      "roll",
      undefined,
      "Longsword +9 = BAB 6 + Str +3, size +0",
    );
    await flushMicrotasks();
    const card = h.gm.store.getAll("messages")[0] as MessageDocument;
    expect(card.roll?.total).toBe(15); // rng 0.25 → die 6
    expect(card.flavor).toBe("Longsword +9 = BAB 6 + Str +3, size +0");

    // A missing flavor stays an empty string, and an oversized one is capped.
    client.roll("1d6");
    await flushMicrotasks();
    const plain = h.gm.store.getAll("messages")[1] as MessageDocument;
    expect(plain.flavor).toBe("");
    client.roll("1d6", "roll", undefined, "x".repeat(400));
    await flushMicrotasks();
    const capped = h.gm.store.getAll("messages")[2] as MessageDocument;
    expect(capped.flavor.length).toBe(300);
  });

  test("ephemeral relays player→player and never touches store or OpLog (§5)", async () => {
    const h = await setup();
    const { client } = await h.addPlayer(PLAYER_ID, "Rex");
    const { bus } = await h.addPlayer(OTHER_ID, "Ivy");
    const seen: Array<{ from: string; t: string }> = [];
    bus.on("ephemeral", (m) => seen.push({ from: m.from, t: m.t }));

    const seqBefore = h.hostStore.seq;
    const logBefore = h.hostLog.lastSeq;
    client.sendEphemeral("cursor", { x: 10, y: 20 });
    await flushMicrotasks();

    expect(seen).toEqual([{ from: PLAYER_ID, t: "cursor" }]);
    expect(h.hostStore.seq).toBe(seqBefore); // invariant: no store contact
    expect(h.hostLog.lastSeq).toBe(logBefore); // invariant: no OpLog contact
  });

  test("late joiner receives the current snapshot including prior moves (§14)", async () => {
    const h = await setup();
    const { client } = await h.addPlayer(PLAYER_ID, "Rex");
    client.submit([{ kind: "update", ref: tokenRef, diff: { x: 321 } }]);
    await flushMicrotasks();

    const { client: late } = await h.addPlayer("late-key", "Late");
    // seq 3 = Late's user doc (join), seq 4 = the move; snapshot carries it all
    expect(late.store.seq).toBe(4);
    expect((late.store.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(321);
  });

  test("non-GM reconnect uses a projected snapshot, not unprojected historical ops", async () => {
    const h = await setup();
    const { client, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    client.submit([{ kind: "update", ref: tokenRef, diff: { x: 100 } }]);
    await flushMicrotasks();
    expect(client.lastSeq).toBe(3);

    // realistic reconnect: the SAME stateful client re-attaches to a fresh
    // transport; its hello carries lastSeq (D-031)
    let snapshots = 0;
    bus.on("snapshot", () => {
      snapshots += 1;
    });
    h.host.removeSession(`peer-${PLAYER_ID}`);
    const pair2 = createTransportPair();
    h.host.addSession(`peer-${PLAYER_ID}`, pair2.a);
    client.reattach(pair2.b);
    await flushMicrotasks();

    expect(client.store.seq).toBe(3);
    expect((client.store.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(100);
    expect(snapshots).toBe(1); // never send historical raw envelopes to a player
  });

  test("reconnect never reveals a secret actor created while a player was offline", async () => {
    const h = await setup();
    const { client, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    h.host.removeSession(`peer-${PLAYER_ID}`);
    const hidden: ActorDocument = {
      _id: "secret-reconnect", type: "actor", name: "Hidden Guardian",
      ownership: { default: 0 }, flags: {}, system: {}, items: [], effects: [],
    };
    h.gm.submit([{ kind: "create", coll: "actors", data: hidden }]);
    await flushMicrotasks();

    const pair = createTransportPair();
    h.host.addSession(`peer-${PLAYER_ID}`, pair.a);
    let snapshots = 0;
    let ops = 0;
    bus.on("snapshot", () => snapshots++);
    bus.on("ops", () => ops++);
    client.reattach(pair.b);
    await flushMicrotasks();

    expect(snapshots).toBe(1);
    expect(ops).toBe(0);
    expect(client.store.get("actors", "secret-reconnect")).toBeUndefined();
    expect(client.lastSeq).toBe(h.hostStore.seq);
  });

  test("GM reconnect retains the ops-since-seq fast path", async () => {
    const h = await setup();
    const saved = h.gm.store.serialize();
    h.host.removeSession("gm");
    const player = await h.addPlayer(PLAYER_ID, "Rex");
    player.client.submit([{ kind: "update", ref: tokenRef, diff: { x: 123 } }]);
    await flushMicrotasks();
    const pair = createTransportPair();
    h.host.addSession("gm-rejoin", pair.a);
    const bus = createEventBus<ClientEvents>();
    const gm = new ClientSync({ transport: pair.b, bus, meta });
    gm.store.hydrate(saved.collections, saved.seq);
    let snapshots = 0;
    bus.on("snapshot", () => snapshots++);
    gm.connect({ kind: "hello", pubkey: GM_ID, displayName: "GM", ts: 1, sig: "valid" });
    await flushMicrotasks();
    expect(gm.store.get("scenes", "s1")?.tokens[0]?.x).toBe(123);
    expect(snapshots).toBe(0);
  });

  test("kick removes the session; ban blocks future joins (§6.4)", async () => {
    const h = await setup();
    const { client, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const kicks: string[] = [];
    bus.on("kick", (k) => kicks.push(k.reason));
    expect(h.host.sessionCount).toBe(2);

    h.host.kick(`peer-${PLAYER_ID}`, "testing");
    await flushMicrotasks();
    expect(kicks).toEqual(["testing"]);
    expect(h.host.sessionCount).toBe(1);

    h.host.ban("banned-key", "griefing");
    const pair = createTransportPair();
    h.host.addSession("peer-banned", pair.a);
    const bannedBus = createEventBus<ClientEvents>();
    const banned = new ClientSync({ transport: pair.b, bus: bannedBus, meta });
    banned.connect({
      kind: "hello",
      pubkey: "banned-key",
      displayName: "Griefer",
      ts: 1,
      sig: "valid",
    });
    await flushMicrotasks();
    expect(banned.user).toBeNull();
    expect(h.host.sessionCount).toBe(1);
    void client;
  });

  test("undo applies inverse ops as a fresh envelope broadcast to all (§8)", async () => {
    const h = await setup();
    const { client } = await h.addPlayer(PLAYER_ID, "Rex");
    client.submit([{ kind: "update", ref: tokenRef, diff: { x: 777 } }]);
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(777);

    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(0);
    expect((h.gm.store.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(0);
    expect((client.store.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(0);
    expect(h.hostStore.seq).toBe(4);

    expect(h.host.redo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(777);
    expect(h.hostStore.seq).toBe(5);
  });

  test("ownership gate: GM-created secret actor never reaches player snapshots (§5)", async () => {
    const h = await setup();
    const secret: ActorDocument = {
      _id: "a-secret",
      type: "actor",
      name: "Hidden One",
      ownership: { default: 0 },
      flags: {},
      system: {},
      items: [],
      effects: [],
    };
    const open: ActorDocument = {
      _id: "a-open",
      type: "actor",
      name: "Tavern Keeper",
      ownership: { default: 2 },
      flags: {},
      system: {},
      items: [],
      effects: [],
    };
    h.gm.submit([
      { kind: "create", coll: "actors", data: secret },
      { kind: "create", coll: "actors", data: open },
    ]);
    await flushMicrotasks();
    const { client } = await h.addPlayer(PLAYER_ID, "Rex");
    expect(client.store.get("actors", "a-secret")).toBeUndefined();
    expect(client.store.get("actors", "a-open")?.name).toBe("Tavern Keeper");
    // live broadcasts respect it too
    h.gm.submit([
      {
        kind: "update",
        ref: { coll: "actors", id: "a-secret" },
        diff: { name: "Still Hidden" },
      },
    ]);
    await flushMicrotasks();
    expect(client.store.get("actors", "a-secret")).toBeUndefined();
  });

  test("seq stays monotonic across mixed concurrent traffic", async () => {
    const h = await setup();
    const ivyRef = {
      coll: "tokens" as const,
      id: "t-ivy",
      parent: { coll: "scenes" as const, id: "s1" },
    };
    const { client: a } = await h.addPlayer(PLAYER_ID, "Rex");
    const { client: b } = await h.addPlayer(OTHER_ID, "Ivy");
    for (let i = 0; i < 5; i++) {
      a.submit([{ kind: "update", ref: tokenRef, diff: { x: i } }]);
      b.submit([{ kind: "update", ref: ivyRef, diff: { y: i } }]);
      b.roll("1d6");
    }
    await flushMicrotasks();
    // 10 accepted intents + 5 rolls = 15 envelopes on top of seq 2 (both users known)
    expect(h.hostStore.seq).toBe(2 + 15);
    expect(a.store.seq).toBe(h.hostStore.seq);
    expect(b.store.seq).toBe(h.hostStore.seq);
  });
});

test("Tagger actor and embedded-item sheet edits replicate, authorize owners, validate and undo", async () => {
  const h = await setup();
  const { client: owner, bus: ownerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const other = await h.addPlayer(OTHER_ID, "Ivy");
  const blade: ItemDocument = { _id: "tag-blade", type: "item", name: "Blade", ownership: { default: 0 },
    flags: {}, system: {}, effects: [], taggerTags: ["weapon"] };
  const actor: ActorDocument = { _id: "tag-hero", type: "actor", name: "Tagged hero",
    ownership: { default: 2, [PLAYER_ID]: 3 }, flags: {}, system: {}, items: [blade], effects: [],
    taggerTags: ["party"] };
  h.gm.submit([{ kind: "create", coll: "actors", data: actor }]);
  await flushMicrotasks();

  const actorRef = { coll: "actors" as const, id: actor._id };
  const itemRef = { coll: "items" as const, id: blade._id, parent: actorRef };
  const actorDoc = owner.store.get("actors", actor._id) as ActorDocument;
  const itemDoc = owner.store.resolve(itemRef) as ItemDocument;
  const seqBefore = h.hostStore.seq;
  owner.submit([
    ...tagEditOps([{ ref: actorRef, doc: actorDoc }], "add", ["quest giver"]),
    ...tagEditOps([{ ref: itemRef, doc: itemDoc }], "replace", ["silver", "heirloom"]),
  ]);
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(seqBefore + 1);
  for (const store of [h.hostStore, h.gm.store, owner.store, other.client.store]) {
    expect((store.resolve(actorRef) as ActorDocument).taggerTags).toEqual(["party", "quest giver"]);
    expect((store.resolve(itemRef) as ItemDocument).taggerTags).toEqual(["silver", "heirloom"]);
  }

  expect(h.host.undo().ok).toBe(true);
  await flushMicrotasks();
  expect((h.hostStore.resolve(actorRef) as ActorDocument).taggerTags).toEqual(["party"]);
  expect((h.hostStore.resolve(itemRef) as ItemDocument).taggerTags).toEqual(["weapon"]);

  const denied: string[] = [];
  other.bus.on("rejected", ({ reason }) => denied.push(reason));
  other.client.submit([{ kind: "update", ref: itemRef, diff: { taggerTags: ["forged"] } }]);
  await flushMicrotasks();
  expect(denied).toEqual(["forbidden"]);
  expect((h.hostStore.resolve(itemRef) as ItemDocument).taggerTags).toEqual(["weapon"]);

  const invalid: string[] = [];
  ownerBus.on("rejected", ({ reason }) => invalid.push(reason));
  owner.submit([{ kind: "update", ref: itemRef, diff: { taggerTags: ["duplicate", "duplicate"] } }]);
  await flushMicrotasks();
  expect(invalid).toEqual(["invalid_schema"]);
  expect((h.hostStore.resolve(itemRef) as ItemDocument).taggerTags).toEqual(["weapon"]);

  const gmRejected: string[] = [];
  h.gmBus.on("rejected", ({ reason }) => gmRejected.push(reason));
  h.gm.submit([{ kind: "create", coll: "actors", data: { ...actor, _id: "bad-tag-create",
    items: [{ ...blade, taggerTags: [" padded "] }] } as ActorDocument }]);
  await flushMicrotasks();
  expect(gmRejected).toEqual(["invalid_schema"]);
  expect(h.hostStore.get("actors", "bad-tag-create")).toBeUndefined();
});

test("PF1e sheet Ops replicate through host authorization; forged non-owner edit is rejected", async () => {
  const h = await setup();
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const other = await h.addPlayer(OTHER_ID, "Ivy");
  h.gm.submit([
    {
      kind: "create",
      coll: "actors",
      data: {
        _id: "pf-fighter",
        type: "actor",
        name: "PF Fighter",
        ownership: { default: 2, [PLAYER_ID]: 3 },
        flags: {},
        system: {
          pf1e: {
            hp: 12,
            hpMax: 20,
            abilities: { str: 16, dex: 16 },
            armorClass: { armor: 5 },
          },
        },
        items: [],
        effects: [],
      } as ActorDocument,
    },
  ]);
  await flushMicrotasks();
  let windowActor: ActorDocument | null = null;
  const stopWindow = observePF1eSheetActor(player, playerBus, "pf-fighter", (actor) => {
    windowActor = actor;
  });
  const windowHp = () => (windowActor ? pf1eSheetView(windowActor).derived.hp : null);
  expect(windowHp()).toBe(12);
  const owned = player.store.get("actors", "pf-fighter") as ActorDocument;
  expect(pf1eSheetView(owned).derived.ac).toEqual({
    normal: 18,
    touch: 13,
    flatFooted: 15,
  });
  const proposal = pf1eSheetEdit(owned, player.user, "hp", "7");
  expect(proposal.error).toBeNull();
  player.submit(proposal.ops);
  await flushMicrotasks();
  for (const store of [h.hostStore, h.gm.store, player.store, other.client.store]) {
    expect(pf1eSheetView(store.get("actors", "pf-fighter") as ActorDocument).derived.hp).toBe(
      7,
    );
  }
  const rejected: string[] = [];
  other.bus.on("rejected", (e) => rejected.push(e.reason));
  other.client.submit([
    {
      kind: "update",
      ref: { coll: "actors", id: "pf-fighter" },
      diff: { "system.pf1e.hp": 99 },
    },
  ]);
  await flushMicrotasks();
  expect(rejected).toHaveLength(1);
  expect(
    pf1eSheetView(h.hostStore.get("actors", "pf-fighter") as ActorDocument).derived.hp,
  ).toBe(7);
  expect(
    pf1eSheetView(other.client.store.get("actors", "pf-fighter") as ActorDocument).derived.hp,
  ).toBe(7);
  expect(windowHp()).toBe(7);
  h.gm.submit([
    {
      kind: "update",
      ref: { coll: "actors", id: "pf-fighter" },
      diff: { ownership: { default: 0 } },
    },
  ]);
  await flushMicrotasks();
  expect(player.store.get("actors", "pf-fighter")).toBeUndefined();
  expect(windowHp()).toBeNull(); // revocation projection deletes the open window's data
  h.gm.submit([
    {
      kind: "update",
      ref: { coll: "actors", id: "pf-fighter" },
      diff: { ownership: { default: 2 } },
    },
  ]);
  await flushMicrotasks();
  expect(windowHp()).toBe(7); // regrant materializes the current document, not stale state
  h.gm.submit([{ kind: "delete", ref: { coll: "actors", id: "pf-fighter" } }]);
  await flushMicrotasks();
  expect(windowHp()).toBeNull();
  stopWindow();
});

test("PF1e attack authoring add/edit/remove replicates as authorized Ops", async () => {
  const h = await setup();
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  h.gm.submit([
    {
      kind: "create",
      coll: "actors",
      data: {
        _id: "armed",
        type: "actor",
        name: "Armed hero",
        ownership: { default: 0, [PLAYER_ID]: 3 },
        flags: {},
        system: { pf1e: { abilities: { str: 16 }, attacks: [] } },
        items: [],
        effects: [],
      } as ActorDocument,
    },
  ]);
  await flushMicrotasks();
  const current = () => player.store.get("actors", "armed") as ActorDocument;
  const added = pf1eAttackEdit(current(), player.user, { kind: "add", expected: [] });
  expect(added.error).toBeNull();
  player.submit(added.ops);
  await flushMicrotasks();
  const changed = pf1eAttackEdit(current(), player.user, {
    kind: "set",
    index: 0,
    field: "damageDice",
    value: "1d8",
    expected: pf1eAttackEditorView(current()).rows,
  });
  expect(changed.error).toBeNull();
  player.submit(changed.ops);
  await flushMicrotasks();
  for (const store of [h.hostStore, h.gm.store, player.store]) {
    expect(
      pf1eSheetView(store.get("actors", "armed") as ActorDocument).derived.attacks[0]
        ?.damageDice,
    ).toBe("1d8");
  }
  const removed = pf1eAttackEdit(current(), player.user, {
    kind: "remove",
    index: 0,
    expected: pf1eAttackEditorView(current()).rows,
  });
  expect(removed.error).toBeNull();
  player.submit(removed.ops);
  await flushMicrotasks();
  for (const store of [h.hostStore, h.gm.store, player.store]) {
    expect(pf1eAttackEditorView(store.get("actors", "armed") as ActorDocument).rows).toEqual(
      [],
    );
  }
});

test("PF1e manual health and reversible AC source Ops replicate through host authorization", async () => {
  const h = await setup();
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  h.gm.submit([
    {
      kind: "create",
      coll: "actors",
      data: {
        _id: "published",
        type: "actor",
        name: "Published hero",
        ownership: { default: 0, [PLAYER_ID]: 3 },
        flags: {},
        system: {
          pf1e: {
            abilities: { dex: 16 },
            hp: 7,
            hpMax: 20,
            ac: 22,
            touchAc: 16,
            flatFootedAc: 17,
          },
        },
        items: [],
        effects: [],
      } as ActorDocument,
    },
  ]);
  await flushMicrotasks();
  const current = () => player.store.get("actors", "published") as ActorDocument;
  for (const [field, value] of [
    ["tempHp", "8"],
    ["energyResistance.fire", "10"],
  ] as const) {
    const edit = pf1eSheetEdit(current(), player.user, field, value);
    expect(edit.error).toBeNull();
    player.submit(edit.ops);
    await flushMicrotasks();
  }
  for (const mode of ["components", "published"] as const) {
    const preview = previewAcConversion(current(), player.user, {
      mode,
      expected: acRevision(current()),
      draft: { armor: "5", shield: "0", natural: "0", dodge: "0", misc: "0", maxDex: "" },
    });
    expect(preview.error).toBeNull();
    player.submit(preview.ops);
    await flushMicrotasks();
    for (const store of [h.hostStore, h.gm.store, player.store]) {
      const a = store.get("actors", "published") as ActorDocument;
      expect(pf1eSheetView(a).derived).toMatchObject({
        hp: 7,
        hpMax: 20,
        tempHp: 8,
        energyResistance: { fire: 10 },
        ac: preview.after,
        acFromTotals: mode === "published",
      });
      expect(a.system.pf1e).toMatchObject({ ac: 22, touchAc: 16, flatFootedAc: 17 });
    }
  }
});

test("sparse private compendium create cannot block a public linked token broadcast", async () => {
  const h = await setup();
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  const { client: other } = await h.addPlayer(OTHER_ID, "Other");
  const raw = {
    _id: "sparse",
    type: "actor",
    name: "Private infantry",
    system: { pf1e: { ac: 16 } },
    items: [],
    effects: [],
  };
  h.gm.submit([
    // D-019 runtime input deliberately omits the optional common fields.
    { kind: "create", coll: "actors", data: raw as unknown as ActorDocument },
    {
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: "s1" },
      data: tokenDoc("linked", { actorId: "sparse", ownership: { default: 3 } }),
    },
  ]);
  await flushMicrotasks();
  expect(raw).not.toHaveProperty("ownership");
  expect(h.hostStore.get("actors", "sparse")?.ownership).toEqual({ default: 0 });
  for (const client of [player, other]) {
    expect(client.store.seq).toBe(h.hostStore.seq);
    expect(client.store.get("actors", "sparse")).toBeUndefined();
    expect(client.store.get("scenes", "s1")?.tokens.some((t) => t._id === "linked")).toBe(true);
  }
  h.gm.submit([
    {
      kind: "update",
      ref: { coll: "actors", id: "sparse" },
      diff: { ownership: { default: 0, [PLAYER_ID]: 3 } },
    },
  ]);
  await flushMicrotasks();
  expect(
    pf1eSheetView(player.store.get("actors", "sparse") as ActorDocument).derived.ac.normal,
  ).toBe(16);
  expect(other.store.get("actors", "sparse")).toBeUndefined();
});

test("encounter activation replicates its scene pointer without resetting inactive rounds", async () => {
  const h = await setup();
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  const scene = h.gm.store.get("scenes", "s1") as SceneDocument;
  let id = 0;
  const first = {
    ...newEncounter(scene, "fight-a", "A", () => `member-${id++}`),
    round: 3,
    turn: 0,
  };
  const second = newEncounter(scene, "fight-b", "B", () => `member-${id++}`);
  const initial = activateEncounter(scene, first, h.gm.user, "s1");
  h.gm.submit([
    { kind: "create", coll: "combats", data: first },
    { kind: "create", coll: "combats", data: second },
    ...initial.ops,
  ]);
  await flushMicrotasks();
  const currentScene = h.gm.store.get("scenes", "s1") as SceneDocument;
  const selection = activateEncounter(currentScene, second, h.gm.user, "s1");
  expect(selection.error).toBeNull();
  h.gm.submit(selection.ops);
  await flushMicrotasks();
  for (const store of [h.hostStore, h.gm.store, player.store]) {
    const selected = selectedEncounter(
      store.getAll("combats"),
      store.get("scenes", "s1") as SceneDocument,
      "s1",
    );
    expect(selected?._id).toBe("fight-b");
    expect(store.get("combats", "fight-a")?.round).toBe(3);
  }
});

test("public actor initiative totals and roll records replicate through authorized combat updates", async () => {
  const h = await setup();
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  const scene = h.gm.store.get("scenes", "s1") as SceneDocument;
  let id = 0;
  const fight = newEncounter(scene, "initiative-fight", "Fight", () => `init-${id++}`);
  fight.combatants = fight.combatants.map((c) => ({ ...c, actorId: "init-actor" }));
  const actor: ActorDocument = {
    _id: "init-actor",
    type: "actor",
    name: "Actor",
    ownership: { default: 0 },
    flags: {},
    system: { pf1e: { abilities: { dex: 16 }, initiative: 4 } },
    items: [],
    effects: [],
  };
  h.gm.submit([
    { kind: "create", coll: "actors", data: actor },
    { kind: "create", coll: "combats", data: fight },
  ]);
  await flushMicrotasks();
  const dice = [10, 10, 1, 20];
  const result = rollEncounterInitiative(
    fight,
    scene,
    [actor],
    h.gm.user,
    () => dice.shift() ?? NaN,
  );
  expect(result.error).toBeNull();
  if (!result.transition) throw new Error("Expected roll transition");
  h.gm.submit([
    {
      kind: "update",
      ref: { coll: "combats", id: fight._id },
      diff: { combatants: result.transition.combat.combatants as unknown as Json },
    },
  ]);
  await flushMicrotasks();
  for (const store of [h.hostStore, h.gm.store, player.store]) {
    const members = store.get("combats", fight._id)?.combatants ?? [];
    expect(members).toHaveLength(2);
    expect(members.map((c) => c._id)).toEqual(["init-1", "init-0"]);
    expect(members[0]?.flags.core?.initiativeRoll).toMatchObject({
      tiePolicy: "pf1e",
      tieRolls: [20],
    });
    for (const member of members) {
      expect(member.initiative).toBe(17);
      expect(member.flags.core?.initiativeRoll).toMatchObject({
        die: 10,
        modifier: 7,
        total: 17,
      });
    }
  }
  expect(player.store.get("actors", actor._id)).toBeUndefined();
});

test("selected roster edits and partial initiative replicate without modifying unselected combatants", async () => {
  const h = await setup();
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  const scene = h.gm.store.get("scenes", "s1") as SceneDocument;
  const selection = { sceneId: "s1", ids: ["t-pl"] };
  const chosen = selectedTokens(scene, selection, true);
  const initial = newEncounter(
    { ...scene, tokens: chosen.tokens },
    "selected-fight",
    "Selected",
    () => "member-a",
  );
  initial.round = 1;
  initial.combatants = initial.combatants.map((c) => ({ ...c, initiative: 10 }));
  h.gm.submit([{ kind: "create", coll: "combats", data: initial }]);
  await flushMicrotasks();
  const extra = { sceneId: "s1", ids: ["t-ivy"] };
  expect(
    editSelectedRoster(initial, scene, extra, player.user, "add", () => "blocked").transition,
  ).toBeNull();
  const added = editSelectedRoster(initial, scene, extra, h.gm.user, "add", () => "member-b");
  if (!added.transition) throw new Error(added.error ?? "Missing transition");
  h.gm.submit([
    {
      kind: "update",
      ref: { coll: "combats", id: initial._id },
      diff: {
        combatants: added.transition.combat.combatants as unknown as Json,
        turn: added.transition.combat.turn,
      },
    },
  ]);
  await flushMicrotasks();
  const current = h.gm.store.get("combats", initial._id);
  if (!current) throw new Error("Missing combat");
  const rolled = rollSelectedInitiative(current, scene, [], h.gm.user, () => 7, extra);
  if (!rolled.transition) throw new Error(rolled.error ?? "Missing roll");
  h.gm.submit([
    {
      kind: "update",
      ref: { coll: "combats", id: initial._id },
      diff: {
        combatants: rolled.transition.combat.combatants as unknown as Json,
        turn: rolled.transition.combat.turn,
      },
    },
  ]);
  await flushMicrotasks();
  for (const store of [h.hostStore, h.gm.store, player.store]) {
    const c = store.get("combats", initial._id);
    expect(c?.combatants[0]).toEqual(initial.combatants[0]);
    expect(c?.combatants[1]?.initiative).toBe(7);
    expect(c?.turn).toBe(0);
  }
  const removed = editSelectedRoster(
    rolled.transition.combat,
    scene,
    extra,
    h.gm.user,
    "remove",
    () => "unused",
  );
  if (!removed.transition) throw new Error(removed.error ?? "Missing removal");
  h.gm.submit([
    {
      kind: "update",
      ref: { coll: "combats", id: initial._id },
      diff: {
        combatants: removed.transition.combat.combatants as unknown as Json,
        turn: removed.transition.combat.turn,
      },
    },
  ]);
  await flushMicrotasks();
  expect(player.store.get("combats", initial._id)?.combatants).toEqual(initial.combatants);
  // The GM may also remove the last (active) member without ending the encounter.
  const empty = editSelectedRoster(
    removed.transition.combat,
    scene,
    selection,
    h.gm.user,
    "remove",
    () => "unused",
  );
  if (!empty.transition) throw new Error(empty.error ?? "Missing active removal");
  h.gm.submit([
    {
      kind: "update",
      ref: { coll: "combats", id: initial._id },
      diff: {
        combatants: empty.transition.combat.combatants as unknown as Json,
        turn: empty.transition.combat.turn,
      },
    },
  ]);
  await flushMicrotasks();
  for (const store of [h.hostStore, h.gm.store, player.store])
    expect(store.get("combats", initial._id)).toMatchObject({
      round: 1,
      turn: 0,
      combatants: [],
    });
});

/**
 * D-256 map pins: a note lives *inside* a scene, and the scene is readable by every player, so
 * the gate cannot be ownership arithmetic — it is the pin's own `visible` flag. The host has to
 * rewrite the envelope per session either way: a hidden pin's create is projected away, so when
 * the GM later reveals it the player must receive a full create (an update would target a
 * document their replica never held), and hiding it again must retract the entry.
 */
test("D-256 pins: revealing a pin materializes it in the player's replica, hiding retracts it", async () => {
  const h = await setup();
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  const sceneRef = { coll: "scenes" as const, id: "s1" };
  const noteRef = { coll: "notes" as const, id: "pin-1", parent: sceneRef };
  const pin = (over: Partial<NoteDocument> = {}): NoteDocument => ({
    _id: "pin-1",
    type: "note",
    name: "Pin 1",
    ownership: { default: 0 },
    flags: {},
    system: {},
    x: 200,
    y: 300,
    text: "Cultists ambush the party",
    playerText: "Gate is open",
    icon: "pin",
    visible: false,
    ...over,
  });
  const playerNotes = (): NoteDocument[] =>
    (player.store.get("scenes", "s1") as SceneDocument | undefined)?.notes ?? [];

  h.gm.submit([{ kind: "create", coll: "notes", parent: sceneRef, data: pin() }]);
  await flushMicrotasks();
  expect(playerNotes()).toHaveLength(0); // hidden pin: projected away, not merely hidden in the UI

  h.gm.submit([
    {
      kind: "update",
      ref: noteRef,
      diff: { visible: true, ownership: { default: 1 } },
    },
  ]);
  await flushMicrotasks();
  expect(playerNotes()).toHaveLength(1);
  expect(playerNotes()[0]?.playerText).toBe("Gate is open");

  h.gm.submit([
    {
      kind: "update",
      ref: noteRef,
      diff: { visible: false, ownership: { default: 0 } },
    },
  ]);
  await flushMicrotasks();
  expect(playerNotes()).toHaveLength(0); // no stale pin left in the replica
});

/**
 * §2.2 item 3 (G-20, D-261) — applying a roll card's total is the host's decision, not the sender's.
 *
 * The intent (`roll.apply`) carries no number: the host re-reads `roll.total` from the card **it**
 * evaluated, checks `can(user, "update", actor, "actors")`, applies the PF1e rules (temporary hit
 * points absorb first, healing caps at the maximum and removes nonlethal) and commits one op
 * envelope it can undo as a unit. These tests pin the three things that decision rests on: the
 * number is the host's, the permission is the host's, and a card cannot be counted twice.
 */
test("roll.apply spends temporary hit points, writes only authorized hit points, and refuses a replay", async () => {
  const h = await setup();
  const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
  const rejections: Array<{ reason: string; detail: string }> = [];
  bus.on("rejected", (r) => rejections.push({ reason: r.reason, detail: r.detail }));
  // `players` is the actor Rex owns; `sealed` is one he can see but not update.
  h.gm.submit([
    {
      kind: "create",
      coll: "actors",
      data: {
        _id: "players",
        type: "actor",
        name: "Rex the Bold",
        ownership: { default: 0, [PLAYER_ID]: 3 },
        flags: {},
        system: { pf1e: { hp: 20, hpMax: 20, tempHp: 8, nonlethalDamage: 6 } },
        items: [],
        effects: [],
      } as ActorDocument,
    },
    {
      kind: "create",
      coll: "actors",
      data: {
        _id: "sealed",
        type: "actor",
        name: "Sealed vault",
        ownership: { default: 1 },
        flags: {},
        system: { pf1e: { hp: 30, hpMax: 30 } },
        items: [],
        effects: [],
      } as ActorDocument,
    },
  ]);
  await flushMicrotasks();
  const actor = () => h.hostStore.get("actors", "players") as ActorDocument;

  // The card: the host evaluates it (rng 0.25 → 1d6 = 2), so `total` is the host's own number.
  player.roll("1d6+2");
  await flushMicrotasks();
  const card = (h.hostStore.getAll("messages") as MessageDocument[]).find(
    (m) => m.roll !== null && m.roll.formula === "1d6+2",
  );
  expect(card?.roll?.total).toBe(4);

  // Damage: 4 through an 8-point pool — absorbed whole, so hit points do not move at all.
  player.rollApply(card?._id ?? "", "players", "damage");
  await flushMicrotasks();
  expect(pf1eSheetView(actor()).derived).toMatchObject({
    hp: 20,
    hpMax: 20,
    tempHp: 4,
    nonlethalDamage: 6,
  });
  const appliedCard = h.hostStore.get("messages", card?._id ?? "") as MessageDocument;
  expect(
    (appliedCard.flags as { pf1e?: { applied?: unknown } }).pf1e?.applied,
  ).toEqual({ players: { damage: 4 } });
  // The audit line names the applied amount and the actor, and is authored by the applier.
  const note = (h.hostStore.getAll("messages") as MessageDocument[]).find(
    (m) => m.name === "Damage applied",
  );
  expect(note?.content).toContain("Rex the Bold");
  expect(note?.author).toBe(PLAYER_ID);

  // Replay: the same card cannot be counted twice against the same actor.
  const before = h.hostStore.seq;
  player.rollApply(card?._id ?? "", "players", "damage");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(before);
  expect(pf1eSheetView(actor()).derived).toMatchObject({ hp: 20, tempHp: 4 });
  expect(rejections.at(-1)?.reason).toBe("invalid_schema");
  expect(rejections.at(-1)?.detail).toContain("already applied");

  // Healing is a separate verb on the same card: it caps at the maximum and removes an equal
  // amount of nonlethal damage (CRB p.191) — and it never touches the pool damage left behind.
  player.rollApply(card?._id ?? "", "players", "healing");
  await flushMicrotasks();
  expect(pf1eSheetView(actor()).derived).toMatchObject({
    hp: 20,
    tempHp: 4,
    nonlethalDamage: 2,
  });

  // Authorization: a card Rex can read is not a licence to write an actor he does not own.
  const deniedBefore = h.hostStore.seq;
  player.rollApply(card?._id ?? "", "sealed", "damage");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(deniedBefore);
  expect(pf1eSheetView(h.hostStore.get("actors", "sealed") as ActorDocument).derived.hp).toBe(30);
  expect(rejections.at(-1)?.reason).toBe("forbidden");
  expect(rejections.at(-1)?.detail).toContain("Sealed vault");
});

test("roll.apply refuses a card that never carried a total, and an actor that is not there", async () => {
  const h = await setup();
  const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
  const rejections: string[] = [];
  bus.on("rejected", (r) => rejections.push(r.detail));
  h.gm.submit([
    {
      kind: "create",
      coll: "actors",
      data: {
        _id: "players",
        type: "actor",
        name: "Rex the Bold",
        ownership: { default: 0, [PLAYER_ID]: 3 },
        flags: {},
        system: { pf1e: { hp: 20, hpMax: 20 } },
        items: [],
        effects: [],
      } as ActorDocument,
    },
  ]);
  await flushMicrotasks();
  h.gm.submit([
    {
      kind: "create",
      coll: "messages",
      data: {
        _id: "prose",
        type: "message",
        name: "prose",
        ownership: { default: 1 },
        flags: {},
        system: {},
        author: GM_ID,
        content: "just talking",
        whisper: [],
        roll: null,
        flavor: "",
      } as MessageDocument,
    },
  ]);
  await flushMicrotasks();

  const seq = h.hostStore.seq;
  player.rollApply("prose", "players", "damage");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(seq);
  expect(rejections.at(-1)).toContain("no rolled total");

  player.rollApply("prose", "ghost", "damage");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(seq);
  expect(pf1eSheetView(h.hostStore.get("actors", "players") as ActorDocument).derived.hp).toBe(20);
});

describe("Macros / FX host authority and audience", () => {
  const imageHash = "a".repeat(64);
  const soundHash = "5".repeat(64);
  const fxMacro = (id: string, at: "point" | "source" = "point"): MacroDocument => ({
    _id: id, type: "macro", name: id, ownership: { default: 1 },
    flags: { core: { playerCallable: true } }, system: {}, kind: "sequence", command: "",
    sequence: { version: 1, audience: "scene", sections: [
      { kind: "text", id: "a", text: "Flash!", startMs: 0, durationMs: 800,
        at: at === "point" ? { kind: "point", x: 150, y: 150 } : { kind: "source" } },
      { kind: "image", id: "b", assetId: imageHash, startMs: 300, durationMs: 900,
        at: at === "point" ? { kind: "point", x: 150, y: 150 } : { kind: "source" } },
    ] },
  });

  test("a drawn region is host-validated as a shape and resolves through the scene's metric (D-315)", async () => {
    const h = await setup({ [imageHash]: { name: "owned.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    const withMask = (id: string, mask: unknown): MacroDocument => ({
      _id: id, type: "macro", name: id, ownership: { default: 1 },
      flags: { core: { playerCallable: true } }, system: {}, kind: "sequence", command: "",
      sequence: { version: 1, audience: "scene", sections: [{ kind: "image", id: "a",
        assetId: imageHash, startMs: 0, durationMs: 1000, at: { kind: "point", x: 100, y: 100 },
        mask } as never] },
    }) as unknown as MacroDocument;
    const refused: string[] = [];
    h.gmBus.on("rejected", (event) => refused.push(event.detail));
    const square = [{ x: -8, y: -8 }, { x: 8, y: -8 }, { x: 8, y: 8 }, { x: -8, y: 8 }];

    // A drawn region reaches the cue as offsets in the scene's own metric: 8 units is
    // 100 px/5 units × 8 = 160 px, and the growth travels as the ratio the author wrote.
    h.gm.submit([{ kind: "create", coll: "macros", data: withMask("room", { kind: "polygon",
      points: square, scaleTo: 2, invert: true }) }]);
    await flushMicrotasks();
    const cues: ClientEvents["fx"][] = [];
    h.gmBus.on("fx", (m) => cues.push(m));
    h.gm.requestSequence("room", "s1");
    await flushMicrotasks();
    const started = cues.find((m) => m.kind === "fx.start");
    expect(started).toBeDefined();
    if (started?.kind === "fx.start") {
      const mask = (started.sections[0] as { mask?: { area?: unknown; invert?: boolean;
        animate?: unknown } }).mask;
      expect(mask?.area).toEqual([{ x: -160, y: -160 }, { x: 160, y: -160 },
        { x: 160, y: 160 }, { x: -160, y: 160 }]);
      expect(mask?.invert).toBe(true);
      expect(mask?.animate).toEqual({ scale: 2 });
    }

    // Forged regions never reach the store: too few points, too many, a line with no area, a
    // bow-tie that crosses itself, a point with a field that is not x/y, an out-of-scene
    // offset, and a wall bound on a region a ray can cross twice.
    const u = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: 6, y: 10 },
      { x: 6, y: -6 }, { x: -6, y: -6 }, { x: -6, y: 10 }, { x: -10, y: 10 }];
    for (const [name, mask] of [
      ["two-points", { kind: "polygon", points: [square[0], square[1]] }],
      ["many", { kind: "polygon", points: Array.from({ length: 65 }, (_v, i) => ({
        x: Math.cos((i / 65) * Math.PI * 2) * 10, y: Math.sin((i / 65) * Math.PI * 2) * 10 })) }],
      ["line", { kind: "polygon", points: [{ x: -8, y: 0 }, { x: 0, y: 0 }, { x: 8, y: 0 }] }],
      ["bow-tie", { kind: "polygon", points: [{ x: -8, y: -8 }, { x: 8, y: 8 },
        { x: 8, y: -8 }, { x: -8, y: 8 }] }],
      ["stray-field", { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 8, y: 0, z: 1 },
        { x: 0, y: 8 }] }],
      ["far-off", { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 9_000, y: 0 },
        { x: 0, y: 8 }] }],
      ["walled-u", { kind: "polygon", points: u, walls: true }],
      ["polygon-length", { kind: "polygon", points: square, length: 10 }],
    ] as const) {
      h.gm.submit([{ kind: "create", coll: "macros", data: withMask(`bad-${name}`, mask) }]);
      await flushMicrotasks();
      expect(h.hostStore.get("macros", `bad-${name}`), name).toBeUndefined();
    }
    expect(refused.length).toBeGreaterThanOrEqual(8);
    // …and the concave region it refused to wall-bound is perfectly acceptable unwalled.
    h.gm.submit([{ kind: "create", coll: "macros", data: withMask("u-open", { kind: "polygon", points: u }) }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "u-open")).toBeDefined();
  });

  test("a mask's cross axis survives the host as a ratio, and a shape without one is refused (D-314)", async () => {
    const h = await setup({ [imageHash]: { name: "owned.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    const withMask = (id: string, mask: unknown): MacroDocument => ({
      _id: id, type: "macro", name: id, ownership: { default: 1 },
      flags: { core: { playerCallable: true } }, system: {}, kind: "sequence", command: "",
      sequence: { version: 1, audience: "scene", sections: [{ kind: "image", id: "a",
        assetId: imageHash, startMs: 0, durationMs: 1000, at: { kind: "point", x: 100, y: 100 },
        mask } as never] },
    }) as unknown as MacroDocument;
    const refused: string[] = [];
    h.gmBus.on("rejected", (event) => refused.push(event.detail));

    // A beam that thickens: the host resolves the *ratio* and the frame it lives in, so the
    // recipient learns the shape and never the scene's metric.
    h.gm.submit([{ kind: "create", coll: "macros", data: withMask("beam", { kind: "rect",
      length: 20, width: 10, lengthTo: 60, widthTo: 40, angle: 30 }) }]);
    await flushMicrotasks();
    const cues: ClientEvents["fx"][] = [];
    h.gmBus.on("fx", (m) => cues.push(m));
    h.gm.requestSequence("beam", "s1");
    await flushMicrotasks();
    const started = cues.find((m) => m.kind === "fx.start");
    expect(started).toBeDefined();
    if (started?.kind === "fx.start") {
      const mask = (started.sections[0] as { mask?: { animate?: unknown } }).mask;
      expect(mask?.animate).toEqual({ scale: 3, cross: { ratio: 4, axisDeg: 30 } });
    }

    // Forged cross axes never reach the store: a shape that has no such axis, a value past
    // its own bound, and the two axes the wall trim bakes away.
    for (const [name, mask] of [
      ["circle-width", { kind: "circle", length: 10, widthTo: 20 }],
      ["ray-spread", { kind: "ray", length: 20, width: 4, spreadTo: 180 }],
      ["cone-width", { kind: "cone", length: 20, spreadTo: 90, widthTo: 10 }],
      ["past-range", { kind: "cone", length: 20, spreadTo: 400 }],
      ["walled", { kind: "rect", length: 20, width: 10, widthTo: 40, walls: true }],
    ] as const) {
      h.gm.submit([{ kind: "create", coll: "macros", data: withMask(`bad-${name}`, mask) }]);
      await flushMicrotasks();
      expect(h.hostStore.get("macros", `bad-${name}`), name).toBeUndefined();
    }
    expect(refused.length).toBeGreaterThanOrEqual(5);
  });

  test("a filter chain is host-accepted, resolved intact, and refused when forged (D-313)", async () => {
    const h = await setup({ [imageHash]: { name: "owned.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    const chain = (id: string, filters: unknown): MacroDocument => ({
      _id: id, type: "macro", name: id, ownership: { default: 1 },
      flags: { core: { playerCallable: true } }, system: {}, kind: "sequence", command: "",
      sequence: { version: 1, audience: "scene", sections: [{ kind: "image", id: "a",
        assetId: imageHash, startMs: 0, durationMs: 800, at: { kind: "point", x: 120, y: 120 },
        filters } as never] },
    }) as unknown as MacroDocument;
    const refused: string[] = [];
    h.gmBus.on("rejected", (event) => refused.push(event.detail));

    // A real look: desaturated, blurred, dimmed — three entries in the author's order, each
    // with its own strength and the middle one animating.
    h.gm.submit([{ kind: "create", coll: "macros", data: chain("ghost", [
      { kind: "saturate", strength: 0.2 }, { kind: "blur", strength: 3, to: 9 },
      { kind: "brightness", strength: 1.1 }]) }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "ghost")).toBeDefined();

    // …and the run resolves the chain into the cue intact: the entries, their order and the
    // animation's end all survive to the recipient (the plan is the client's, the document is
    // the host's, and neither may quietly drop an entry).
    const cues: ClientEvents["fx"][] = [];
    h.gmBus.on("fx", (m) => cues.push(m));
    h.gm.requestSequence("ghost", "s1");
    await flushMicrotasks();
    const started = cues.find((m) => m.kind === "fx.start");
    expect(started).toBeDefined();
    if (started?.kind === "fx.start")
      expect((started.sections[0] as { filters?: unknown }).filters).toEqual([
        { kind: "saturate", strength: 0.2 }, { kind: "blur", strength: 3, to: 9 },
        { kind: "brightness", strength: 1.1 }]);

    // A forged chain never reaches the store: one entry is not a chain, five is over budget,
    // both spellings at once is an ambiguity, and a blur's end is not a grayscale's bound.
    for (const [name, filters] of [
      ["one", [{ kind: "blur" }]],
      ["five", [{ kind: "blur" }, { kind: "blur" }, { kind: "blur" }, { kind: "blur" }, { kind: "blur" }]],
      ["empty", []],
      ["odd", [{ kind: "blur" }, { kind: "sepia" }]],
      ["range", [{ kind: "grayscale", to: 9 }, { kind: "blur" }]],
      ["stray", [{ kind: "blur" }, { kind: "blur", opacity: 0.5 }]],
    ] as const) {
      h.gm.submit([{ kind: "create", coll: "macros", data: chain(`bad-${name}`, filters) }]);
      await flushMicrotasks();
      expect(h.hostStore.get("macros", `bad-${name}`), name).toBeUndefined();
    }
    expect(refused.filter((entry) => entry.includes("filter")).length).toBeGreaterThanOrEqual(5);
    // An update is checked by the same rule, not only a create.
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "ghost" },
      diff: { "sequence.sections": [{ kind: "image", id: "a", assetId: imageHash, startMs: 0,
        durationMs: 800, at: { kind: "point", x: 120, y: 120 },
        filter: { kind: "blur", strength: 4 }, filters: [{ kind: "blur" }, { kind: "blur" }] }] } }]);
    await flushMicrotasks();
    const stored = h.hostStore.get("macros", "ghost") as MacroDocument | undefined;
    expect((stored?.sequence?.sections[0] as { filters?: unknown } | undefined)?.filters)
      .toEqual([{ kind: "saturate", strength: 0.2 }, { kind: "blur", strength: 3, to: 9 },
        { kind: "brightness", strength: 1.1 }]);
  });

  test("multi-step timeline reaches entitled peers exactly once; forge is ignored", async () => {
    const h = await setup({ [imageHash]: { name: "owned.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    h.gm.submit([{ kind: "create", coll: "macros", data: fxMacro("pulse") }]);
    await flushMicrotasks();
    const first = await h.addPlayer(PLAYER_ID, "Rex");
    const other = await h.addPlayer(OTHER_ID, "Ivy");
    expect(first.client.store.world.assetManifest[imageHash]?.name).toBe("owned.png");
    const a: ClientEvents["fx"][] = [];
    const b: ClientEvents["fx"][] = [];
    const g: ClientEvents["fx"][] = [];
    first.bus.on("fx", (m) => a.push(m));
    other.bus.on("fx", (m) => b.push(m));
    h.gmBus.on("fx", (m) => g.push(m));
    const seq = h.hostStore.seq;
    first.client.requestSequence("pulse", "s1", "t-pl", "t-ivy");
    await flushMicrotasks();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(g).toHaveLength(1);
    expect(a[0]?.sections.map((s) => s.kind)).toEqual(["text", "image"]);
    expect(a[0]?.sections[1]).toMatchObject({ kind: "image", mime: "image/png", x: 150, y: 150, startMs: 300 });
    expect(a[0]?.atHostTime).toBeGreaterThan(Date.now() - 1000);
    expect(h.hostStore.seq).toBe(seq); // audiovisual cues never run mechanical ops

    const duplicate = { kind: "fx.request" as const, requestId: "replay", macroId: "pulse", sceneId: "s1" };
    first.pair.b.send(channelFor(duplicate.kind), frameMessage(duplicate));
    first.pair.b.send(channelFor(duplicate.kind), frameMessage(duplicate));
    await flushMicrotasks();
    expect(a).toHaveLength(2);
    const observed = a[0];
    if (!observed) throw new Error("missing fixture FX cue");
    first.pair.b.send("ops", frameMessage({ ...observed, runId: "forged" }));
    await flushMicrotasks();
    expect(b).toHaveLength(2); // no forged rebroadcast
  });

  /** Run the fixture's `pulse` as the GM and hand back the cue its own session received:
   * the run id the acks have to name. */
  async function runPulse(h: Harness): Promise<FxStartMsg> {
    const cues: FxStartMsg[] = [];
    const off = h.gmBus.on("fx", (msg) => cues.push(msg));
    try {
      h.gm.requestSequence("pulse", "s1");
      await flushMicrotasks();
    } finally {
      off();
    }
    const cue = cues.at(-1);
    if (!cue) throw new Error("no cue reached the GM session");
    return cue;
  }

  test("the table's answers become one line for the requester, and a failure is urgent", async () => {
    const h = await setup({ [imageHash]: { name: "owned.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    h.gm.submit([{ kind: "create", coll: "macros", data: fxMacro("pulse") }]);
    await flushMicrotasks();
    const player = await h.addPlayer(PLAYER_ID, "Rex");
    const reports: ClientEvents["fxDelivery"][] = [];
    h.gmBus.on("fxDelivery", (msg) => reports.push(msg));
    const seen = await runPulse(h);

    // One viewer answers for the run's only asset; the GM's own session never says
    // anything. The answer is not complete without another voice, so nothing is sent yet…
    const ack = (pair: ReturnType<typeof createTransportPair>, msg: Record<string, unknown>) =>
      pair.b.send("ops", frameMessage({ kind: "fx.media", ...msg } as never));
    ack(player.pair, { runId: seen.runId, assetId: imageHash, state: "ready", ms: 120 });
    await flushMicrotasks();
    expect(reports.filter((msg) => msg.media !== undefined)).toHaveLength(0);
    // …and when the viewer says it could not decode the media, the requester hears at
    // once: the cue is still playing, and the GM can still stop it.
    ack(player.pair, { runId: seen.runId, assetId: imageHash, state: "unsupported" });
    await flushMicrotasks();
    const first = reports.filter((msg) => msg.media !== undefined);
    expect(first).toHaveLength(1);
    expect(first[0]?.media?.viewers).toBe(2); // the GM's own session got the cue too
    expect(first[0]?.media?.assets[0]).toMatchObject({ index: 1, kind: "image", mime: "image/png",
      unsupported: 1, silent: 1 });
    expect(first[0]?.media?.complete).toBe(false);
    // A repeat changes nothing; a recovery is the *second and last* line for this run.
    ack(player.pair, { runId: seen.runId, assetId: imageHash, state: "unsupported" });
    await flushMicrotasks();
    expect(reports.filter((msg) => msg.media !== undefined)).toHaveLength(1);
    ack(player.pair, { runId: seen.runId, assetId: imageHash, state: "ready" });
    await flushMicrotasks();
    const lines = reports.filter((msg) => msg.media !== undefined);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.media?.corrected).toBe(true);
    expect(lines[1]?.media?.assets[0]).toMatchObject({ ready: 1, unsupported: 0 });
    // A third answer cannot produce a third line, however often it flips.
    ack(player.pair, { runId: seen.runId, assetId: imageHash, state: "failed", reason: "fetch" });
    await flushMicrotasks();
    expect(reports.filter((msg) => msg.media !== undefined)).toHaveLength(2);
  });

  test("a forged media answer teaches the sender nothing and changes nothing", async () => {
    const h = await setup({ [imageHash]: { name: "owned.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    h.gm.submit([{ kind: "create", coll: "macros", data: fxMacro("pulse") }]);
    await flushMicrotasks();
    const reports: ClientEvents["fxDelivery"][] = [];
    h.gmBus.on("fxDelivery", (msg) => reports.push(msg));
    // The run goes out to the GM's own session and to nobody else, and only *then* does a
    // player join: expectations are fixed when the cue is fanned out, so a session that
    // never received it has no standing to answer for it.
    const seen = await runPulse(h);
    const player = await h.addPlayer(PLAYER_ID, "Rex");
    const mediaLines = () => reports.filter((msg) => msg.media !== undefined).length;
    const forge = (msg: Record<string, unknown>) =>
      player.pair.b.send("ops", frameMessage({ kind: "fx.media", ...msg } as never));
    forge({ runId: seen.runId, assetId: imageHash, state: "unsupported" }); // not a recipient
    forge({ runId: seen.runId, assetId: "f".repeat(64), state: "unsupported" }); // not its media
    forge({ runId: "no-such-run", assetId: imageHash, state: "unsupported" }); // no such run
    forge({ runId: seen.runId, assetId: imageHash, state: "maybe" }); // not one of the four
    forge({ runId: "bad run id", assetId: imageHash, state: "failed",
      ms: Number.POSITIVE_INFINITY }); // shape the host never agreed to
    await flushMicrotasks();
    expect(mediaLines()).toBe(0);

    // The session that really holds the cue answers from its own transport: one line, and
    // it counts only the sessions that were actually sent the run.
    h.gmPair.b.send("ops", frameMessage({ kind: "fx.media", runId: seen.runId,
      assetId: imageHash, state: "failed", reason: "decode" } as never));
    await flushMicrotasks();
    expect(mediaLines()).toBe(1);
    const line = reports.find((msg) => msg.media !== undefined);
    expect(line?.media?.viewers).toBe(1);
    expect(line?.media?.assets[0]).toMatchObject({ failed: 1, silent: 0 });
    // Nothing about a viewer, an asset or a document leaves the host in that message.
    expect(JSON.stringify(line?.media)).not.toContain(imageHash);
    expect(JSON.stringify(line?.media)).not.toContain(PLAYER_ID);
    expect(line?.skipped).toEqual({ audience: 0, rights: 0, anchor: 0, media: 0 });
  });

  test("a player-initiated request gets no media report about other sessions", async () => {
    const h = await setup({ [imageHash]: { name: "owned.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    h.gm.submit([{ kind: "create", coll: "macros", data: fxMacro("pulse") }]);
    await flushMicrotasks();
    const player = await h.addPlayer(PLAYER_ID, "Rex");
    const reports: ClientEvents["fxDelivery"][] = [];
    player.bus.on("fxDelivery", (msg) => reports.push(msg));
    player.client.requestSequence("pulse", "s1");
    await flushMicrotasks();
    const seen = await runPulse(h);
    player.pair.b.send("ops", frameMessage({ kind: "fx.media", runId: seen.runId,
      assetId: imageHash, state: "unsupported" } as never));
    await flushMicrotasks();
    expect(reports).toEqual([]);
  });

  test("a viewer that never answers is reported as such when the window closes", async () => {
    let clock = 1_000_000;
    const h = await setup({ [imageHash]: { name: "owned.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } }, undefined, undefined, () => clock);
    h.gm.submit([{ kind: "create", coll: "macros", data: fxMacro("pulse") }]);
    await flushMicrotasks();
    await h.addPlayer(PLAYER_ID, "Rex");
    const reports: ClientEvents["fxDelivery"][] = [];
    h.gmBus.on("fxDelivery", (msg) => reports.push(msg));
    // Freeze *before* the request: the host arms its window timer as the cue goes out, and
    // the transport's own flush is a `setTimeout` too, so fake timers advance both.
    vi.useFakeTimers();
    try {
      h.gm.requestSequence("pulse", "s1");
      await vi.advanceTimersByTimeAsync(0);
      expect(reports.filter((msg) => msg.media !== undefined)).toHaveLength(0);
      // The window is the run's own media span plus a lead, never less than four seconds.
      clock += 4_500;
      await vi.advanceTimersByTimeAsync(4_500);
      const lines = reports.filter((msg) => msg.media !== undefined);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.media?.complete).toBe(false);
      expect(lines[0]?.media?.spoke).toBe(0);
      expect(lines[0]?.media?.assets[0]).toMatchObject({ silent: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a bound item cue is validated at authoring time and pruned with its item (D-311)", async () => {
    /** The most recent player-side rejection says the timeline was not published for them. */
    const playerRejectedTail = (entries: string[]): boolean =>
      entries.some((entry) => entry.includes("not published for this caller"));
    const h = await setup();
    const sections = [{ kind: "text", id: "s", text: "sparks", startMs: 0, durationMs: 600,
      at: { kind: "point", x: 120, y: 120 }, color: "#ffffff", scale: 1 }];
    const look = (id: string, name: string, patch: Record<string, unknown> = {}): MacroDocument =>
      ({ _id: id, type: "macro", name, command: "", kind: "sequence", ownership: { default: 1 },
        flags: {}, system: {}, sequence: { version: 1, audience: "scene", persistent: false,
          sections }, fxItem: { actorId: "a-hero", itemId: "wand" }, ...patch }) as unknown as MacroDocument;
    const wand: ItemDocument = { _id: "wand", type: "item", name: "Wand of Sparks",
      ownership: { default: 0 }, flags: {}, system: {}, effects: [] };
    const hero: ActorDocument = { _id: "a-hero", type: "actor", name: "Hero",
      ownership: { default: 2 }, flags: {}, system: {}, items: [wand], effects: [] };
    h.gm.submit([{ kind: "create", coll: "actors", data: hero }]);
    await flushMicrotasks();
    expect(h.hostStore.get("actors", "a-hero")).toBeDefined();

    const refused: string[] = [];
    h.gmBus.on("rejected", (event) => refused.push(event.detail));
    // A binding is authored on the timeline; the item has to exist.
    h.gm.submit([{ kind: "create", coll: "macros",
      data: look("fx-hit", "Sparks", { fxItem: { actorId: "a-hero", itemId: "gone" } }) }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-hit")).toBeUndefined();
    expect(refused.join(" | ")).toContain("an item that exists");

    // A failure cue must be a *timeline*: a preset is refused by name, exactly as the D-310
    // mixed-document rule refuses the same mistake from the other side.
    h.gm.submit([{ kind: "create", coll: "macros", data: { _id: "look", type: "macro",
      name: "Fireball look", command: "", kind: "fxPreset", ownership: { default: 1 },
      flags: {}, system: {}, preset: { version: 1, sections } } as unknown as MacroDocument }]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "create", coll: "macros",
      data: look("fx-miss", "Fizzle", { fxItem: { actorId: "a-hero", itemId: "wand",
        onFailureId: "look" } }) }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-miss")).toBeUndefined();
    expect(refused.join(" | ")).toContain("not a timeline");

    // The good one lands, and a *second* timeline on the same item is refused: one item, one
    // bound cue, so the use path is never a coin toss.
    h.gm.submit([{ kind: "create", coll: "macros", data: look("fx-hit", "Sparks") }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-hit")).toBeDefined();
    h.gm.submit([{ kind: "create", coll: "macros", data: look("fx-other", "Other") }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-other")).toBeUndefined();
    expect(refused.join(" | ")).toContain("already bound to that item");

    // A re-save of the bound timeline is ordinary — the one-binding rule must not trip over
    // the binding's own document — and it is how an author adds the failure branch or disables
    // the binding without touching the item.
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "fx-hit" },
      diff: { fxItem: { actorId: "a-hero", itemId: "wand", onFailureId: "fx-hit", enabled: false } } }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-hit")?.fxItem?.enabled).toBe(false);

    // A player cannot author a timeline at all, so they cannot bind one either.
    const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
    const playerRefused: string[] = [];
    playerBus.on("rejected", (event) => playerRefused.push(`${event.reason}: ${event.detail}`));
    player.submit([{ kind: "create", coll: "macros", data: look("fx-mine", "Mine") }]);
    player.submit([{ kind: "update", ref: { coll: "macros", id: "fx-hit" },
      diff: { fxItem: { actorId: "a-hero", itemId: "wand" } } }]);
    await flushMicrotasks();
    expect(playerRefused.filter((entry) => entry.startsWith("forbidden"))).toHaveLength(2);

    // …and the binding grants nothing: a player asking for the bound timeline by hand is
    // refused by the ordinary published-timeline rule, not admitted through the item.
    player.requestSequence("fx-hit", "s1");
    await flushMicrotasks();
    expect(playerRejectedTail(playerRefused)).toBe(true);

    // Deleting the item clears the binding in the same undoable envelope (D-311's pruning):
    // a pointer to something gone can neither linger nor revive on a re-used id.
    const before = h.hostStore.seq;
    h.gm.submit([{ kind: "delete", ref: { coll: "items", id: "wand",
      parent: { coll: "actors", id: "a-hero" } } }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBeGreaterThan(before);
    expect(h.hostStore.get("actors", "a-hero")?.items).toEqual([]);
    expect(h.hostStore.get("macros", "fx-hit")?.fxItem).toBeUndefined();
    h.host.undo();
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-hit")?.fxItem?.enabled).toBe(false);
    expect(h.hostStore.get("actors", "a-hero")?.items.map((entry) => entry._id)).toEqual(["wand"]);
  });

  test("phase binding: one cue per committed moment, and a swing does not answer a charge burn (D-312)", async () => {
    const h = await setup();
    const sections = [{ kind: "text", id: "s", text: "sparks", startMs: 0, durationMs: 600,
      at: { kind: "point", x: 120, y: 120 }, color: "#ffffff", scale: 1 }];
    const bound = (id: string, events?: string[]): MacroDocument =>
      ({ _id: id, type: "macro", name: id, command: "", kind: "sequence", ownership: { default: 1 },
        flags: {}, system: {}, sequence: { version: 1, audience: "scene", persistent: false,
          sections }, fxItem: { actorId: "a-hero", itemId: "axe",
          ...(events === undefined ? {} : { events }) } }) as unknown as MacroDocument;
    const axe: ItemDocument = { _id: "axe", type: "item", name: "Greataxe",
      ownership: { default: 0 }, flags: {}, system: {}, effects: [] };
    const hero: ActorDocument = { _id: "a-hero", type: "actor", name: "Hero",
      ownership: { default: 2 }, flags: {}, system: {}, items: [axe], effects: [] };
    h.gm.submit([{ kind: "create", coll: "actors", data: hero }]);
    await flushMicrotasks();

    const refused: string[] = [];
    h.gmBus.on("rejected", (event) => refused.push(event.detail));

    // The charge-burn cue lands (no events field = the use event).
    h.gm.submit([{ kind: "create", coll: "macros", data: bound("fx-burn") }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-burn")).toBeDefined();
    // The swing cue shares the item legitimately — a different moment.
    h.gm.submit([{ kind: "create", coll: "macros", data: bound("fx-swing", ["attack"]) }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-swing")).toBeDefined();
    // …but a second *use* cue on the same item is refused, and so is a both-moments cue that
    // overlaps both existing ones. The refusal names the moment.
    h.gm.submit([{ kind: "create", coll: "macros", data: bound("fx-second", ["use"]) }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-second")).toBeUndefined();
    expect(refused.join(" | ")).toContain("already bound to that item's use event");
    h.gm.submit([{ kind: "create", coll: "macros", data: bound("fx-both", ["use", "attack"]) }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-both")).toBeUndefined();
    // A forged event name never reaches the store: the shape is validated before the conflict
    // rule, so a hand-crafted op cannot smuggle an event nothing would ever fire on.
    h.gm.submit([{ kind: "create", coll: "macros", data: bound("fx-forged", ["cast"]) }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-forged")).toBeUndefined();
    expect(refused.join(" | ")).toContain("not \"cast\"");

    // Re-saving the swing cue keeps its own moment (the update path must not trip on itself).
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "fx-swing" },
      diff: { "fxItem.events": ["attack"] } }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-swing")?.fxItem?.events).toEqual(["attack"]);

    // Deleting the weapon clears *both* bound timelines in the same envelope.
    h.gm.submit([{ kind: "delete", ref: { coll: "items", id: "axe",
      parent: { coll: "actors", id: "a-hero" } } }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-burn")?.fxItem).toBeUndefined();
    expect(h.hostStore.get("macros", "fx-swing")?.fxItem).toBeUndefined();
    h.host.undo();
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "fx-swing")?.fxItem?.events).toEqual(["attack"]);
  });

  test("an FX preset is GM-authored, GM-visible and never runnable (D-310)", async () => {
    const h = await setup({ [soundHash]: { name: "hum.wav", mime: "audio/wav", size: 4,
      chunks: 1, visibility: "referenced" } });
    const look = (id: string, name: string, sections: unknown[]): MacroDocument =>
      ({ _id: id, type: "macro", name, command: "", kind: "fxPreset", ownership: { default: 0 },
        flags: {}, system: {}, preset: { version: 1, sections } as never });
    const sections = [{ kind: "sound", id: "s", assetId: soundHash, startMs: 0, durationMs: 900, volume: 0.6 },
      { kind: "text", id: "t", text: "boom", startMs: 0, durationMs: 900,
        at: { kind: "point", x: 100, y: 100 }, color: "#ffffff", scale: 1 }];
    h.gm.submit([{ kind: "create", coll: "macros", data: look("p-fire", "Fireball look", sections) }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "p-fire")).toBeDefined();
    // A preset is not a timeline: nothing about it is runnable, so an FX request naming
    // it is refused exactly like any other unknown macro.
    const denied: string[] = [];
    h.gmBus.on("rejected", (event) => denied.push(event.detail));
    h.gm.requestSequence("p-fire", "s1");
    await flushMicrotasks();
    expect(denied).toContain("sequence macro or scene missing");
    // Rename (edit) survives, and so does replacing the bundle with another one.
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "p-fire" }, diff: { name: "Big fireball" } }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "p-fire")?.name).toBe("Big fireball");
    // A crafted document that is a preset *and* a timeline is refused by name: the FX
    // path would run the sequence, and the file would keep the preset.
    const forged: string[] = [];
    h.gmBus.on("rejected", (event) => forged.push(event.detail));
    const smuggler = { ...look("p-bad", "Smuggler", sections),
      sequence: { version: 1, sections } } as unknown as MacroDocument;
    h.gm.submit([{ kind: "create", coll: "macros", data: smuggler }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "p-bad")).toBeUndefined();
    expect(forged.join(" | ")).toContain("not sequence");
    // A preset with a section the sequence validator refuses never reaches the store.
    h.gm.submit([{ kind: "create", coll: "macros", data: look("p-empty", "Nothing", []) }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "p-empty")).toBeUndefined();
    expect(forged.join(" | ")).toContain("1–8 sections");

    // A player cannot author, edit or delete one, and never sees it in their replica.
    const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
    expect(player.store.getAll("macros")).toEqual([]);
    const playerRejected: string[] = [];
    playerBus.on("rejected", (event) => playerRejected.push(`${event.reason}: ${event.detail}`));
    player.submit([{ kind: "create", coll: "macros", data: look("p-mine", "Mine", sections) }]);
    player.submit([{ kind: "update", ref: { coll: "macros", id: "p-fire" }, diff: { name: "Stolen" } }]);
    player.submit([{ kind: "delete", ref: { coll: "macros", id: "p-fire" } }]);
    await flushMicrotasks();
    expect(playerRejected.filter((entry) => entry.startsWith("forbidden"))).toHaveLength(3);
    expect(h.hostStore.get("macros", "p-mine")).toBeUndefined();
    expect(h.hostStore.get("macros", "p-fire")?.name).toBe("Big fireball");
    expect(player.store.getAll("macros")).toEqual([]);
    // The GM's own delete is an ordinary undoable document op.
    h.gm.submit([{ kind: "delete", ref: { coll: "macros", id: "p-fire" } }]);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "p-fire")).toBeUndefined();
  });

  test("a wall between the source and a viewer dulls the sound for that viewer alone", async () => {
    const h = await setup({ [soundHash]: { name: "hum.wav", mime: "audio/wav", size: 4,
      chunks: 1, visibility: "referenced" } });
    // The two players' own tokens, far apart: `t-pl` west of the sound, `t-ivy` east of it.
    h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: "t-pl", parent: { coll: "scenes", id: "s1" } },
      diff: { x: 150, y: 500 } }]);
    await flushMicrotasks();
    const positioned = fxMacro("hum", "point");
    if (!positioned.sequence) throw new Error("FX fixture missing sequence");
    // A sound at the scene's centre with a 30-unit (600 px) reach, dulled by walls.
    positioned.sequence.sections = [{ kind: "sound", id: "s", assetId: soundHash, startMs: 0,
      durationMs: 4_000, volume: 1, at: { kind: "point", x: 500, y: 500 }, radius: 30,
      muffle: true }];
    positioned.sequence.persistent = false;
    h.gm.submit([{ kind: "create", coll: "macros", data: positioned }]);
    await flushMicrotasks();
    const player = await h.addPlayer(PLAYER_ID, "Rex");
    // A door between the sound and Ivy only (x = 900 spans her side), placed closed.
    const door: WallDocument = { _id: "door-1", type: "wall", name: "Door", ownership: { default: 0 },
      flags: {}, system: {}, c: [900, 100, 900, 900], move: 1, sight: 1, sound: 1, light: 1,
      door: 0, oneWay: false };
    h.gm.submit([{ kind: "create", coll: "walls", parent: { coll: "scenes", id: "s1" }, data: door }]);
    await flushMicrotasks();

    const cues: Record<string, ClientEvents["fx"][]> = { gm: [], rex: [], ivy: [] };
    h.gmBus.on("fx", (msg) => cues.gm?.push(msg));
    player.bus.on("fx", (msg) => cues.rex?.push(msg));
    const ivy = await h.addPlayer(OTHER_ID, "Ivy");
    ivy.bus.on("fx", (msg) => cues.ivy?.push(msg));
    // Ivy's own token has to exist before the cue is fanned out for her to be occluded.
    h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: "t-ivy", parent: { coll: "scenes", id: "s1" } },
      diff: { x: 950, y: 500 } }]);
    await flushMicrotasks();

    const before = cues.rex?.length ?? 0;
    h.gm.requestSequence("hum", "s1");
    await flushMicrotasks();
    const rexCue = cues.rex?.[before];
    const ivyCue = cues.ivy?.at(-1);
    const gmCue = cues.gm?.at(-1);
    const soundOf = (cue: ClientEvents["fx"] | undefined) =>
      cue?.sections.find((section) => section.kind === "sound") as
        { x?: number; y?: number; radiusPx?: number; muffle?: boolean; occluded?: boolean } | undefined;
    // Both viewers get the same *authored* cue — the geometry, the radius in the host's
    // own pixels, the request to muffle — and only one of them is told a wall is in the way.
    expect(soundOf(rexCue)).toMatchObject({ x: 500, y: 500, radiusPx: 600, muffle: true });
    expect(soundOf(rexCue)?.occluded).toBeUndefined();
    expect(soundOf(ivyCue)).toMatchObject({ x: 500, y: 500, radiusPx: 600, occluded: true });
    // The GM's own session holds no token of its own on this scene, so the host cannot
    // honestly name a listening point: no answer, not a guessed one.
    expect(soundOf(gmCue)?.occluded).toBeUndefined();
    // Nothing in the payload says *where* the listening point was, only whether it was blocked.
    expect(JSON.stringify(soundOf(ivyCue))).not.toContain("950");

    // Opening the door lets the sound through, exactly as it lets sight through.
    h.gm.submit([{ kind: "update", ref: { coll: "walls", id: "door-1", parent: { coll: "scenes", id: "s1" } },
      diff: { door: 1 } }]);
    await flushMicrotasks();
    h.gm.requestSequence("hum", "s1");
    await flushMicrotasks();
    expect((cues.ivy?.at(-1)?.sections[0] as { occluded?: boolean }).occluded).toBeUndefined();
    // A standard window lets sight/light through but blocks sound, so only this
    // listener's cue is muffled despite the visual opening.
    h.gm.submit([{ kind: "update", ref: { coll: "walls", id: "door-1", parent: { coll: "scenes", id: "s1" } },
      diff: { door: 0, sight: 2, light: 2, move: 0, sound: 0 } }]);
    await flushMicrotasks();
    h.gm.requestSequence("hum", "s1");
    await flushMicrotasks();
    expect((cues.ivy?.at(-1)?.sections[0] as { occluded?: boolean }).occluded).toBe(true);
    // Axes remain independently editable: an explicitly sound-porous window
    // passes sound without changing its sight/light/movement classification.
    h.gm.submit([{ kind: "update", ref: { coll: "walls", id: "door-1", parent: { coll: "scenes", id: "s1" } },
      diff: { sound: 2 } }]);
    await flushMicrotasks();
    h.gm.requestSequence("hum", "s1");
    await flushMicrotasks();
    expect((cues.ivy?.at(-1)?.sections[0] as { occluded?: boolean }).occluded).toBeUndefined();
    // An opaque wall blocks regardless of the door state, and reaches the same viewer.
    h.gm.submit([{ kind: "update", ref: { coll: "walls", id: "door-1", parent: { coll: "scenes", id: "s1" } },
      diff: { sight: 0, light: 0, sound: 0, move: 0, door: 1 } }]);
    await flushMicrotasks();
    h.gm.requestSequence("hum", "s1");
    await flushMicrotasks();
    expect((cues.ivy?.at(-1)?.sections[0] as { occluded?: boolean }).occluded).toBe(true);
  });

  test("a stored loop is muffled per recipient too, recomputed on reconnect", async () => {
    const h = await setup({ [soundHash]: { name: "hum.wav", mime: "audio/wav", size: 4,
      chunks: 1, visibility: "referenced" } });
    h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: "t-pl", parent: { coll: "scenes", id: "s1" } },
      diff: { x: 150, y: 500 } }]);
    await flushMicrotasks();
    const loop = fxMacro("aura", "point");
    if (!loop.sequence) throw new Error("FX fixture missing sequence");
    loop.sequence.persistent = true;
    loop.sequence.sections = [{ kind: "sound", id: "s", assetId: soundHash, startMs: 0,
      durationMs: 4_000, at: { kind: "point", x: 500, y: 500 }, radius: 30, muffle: true }];
    h.gm.submit([{ kind: "create", coll: "macros", data: loop }]);
    await flushMicrotasks();
    const player = await h.addPlayer(PLAYER_ID, "Rex");
    const wall: WallDocument = { _id: "wall-1", type: "wall", name: "Wall", ownership: { default: 0 },
      flags: {}, system: {}, c: [800, 100, 800, 900], move: 0, sight: 0, sound: 0, light: 0,
      door: 0, oneWay: false };
    h.gm.submit([{ kind: "create", coll: "walls", parent: { coll: "scenes", id: "s1" }, data: wall }]);
    await flushMicrotasks();
    const cues: ClientEvents["fx"][] = [];
    player.bus.on("fx", (msg) => cues.push(msg));
    h.gm.requestSequence("aura", "s1");
    await flushMicrotasks();
    expect((cues.at(-1)?.sections[0] as { occluded?: boolean }).occluded).toBeUndefined();
    // The durable record itself carries no per-recipient answer: it is resolved for each
    // viewer at emit, so the same instance can be dulled for one and clear for another.
    const stored = h.hostStore.getAll("fxInstances")[0];
    expect(JSON.stringify(stored)).not.toContain("occluded");
    // A reconnect asks for the live state, and the answer is recomputed for *that* viewer.
    h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: "t-pl", parent: { coll: "scenes", id: "s1" } },
      diff: { x: 900, y: 500 } }]);
    await flushMicrotasks();
player.client.requestFxSync("s1");
    await flushMicrotasks();
    expect((cues.at(-1)?.sections[0] as { occluded?: boolean }).occluded).toBe(true);
  });

  test("published repeated FX resolves clock-aligned per-section plays for entitled viewers without world ops", async () => {
    const h = await setup({ [imageHash]: { name: "owned.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    const macro = fxMacro("repeated");
    if (!macro.sequence) throw new Error("FX fixture missing sequence");
    macro.sequence.sections = [
      { kind: "text", id: "pulse", text: "Pulse", at: { kind: "point", x: 150, y: 150 },
        startMs: 0, durationMs: 250, repeatCount: 3, repeatDelayMs: 350 },
      { kind: "image", id: "spark", assetId: imageHash, at: { kind: "point", x: 150, y: 150 },
        startMs: 100, durationMs: 300, repeatCount: 2, repeatDelayMs: 200 },
    ];
    h.gm.submit([{ kind: "create", coll: "macros", data: macro }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const cues: ClientEvents["fx"][] = [];
    bus.on("fx", (cue) => cues.push(cue));
    const before = h.hostStore.seq;
    player.requestSequence(macro._id, "s1");
    await flushMicrotasks();
    expect(cues).toHaveLength(1);
    expect(cues[0]?.sections.map((section) => [section.id, section.startMs])).toEqual([
      ["pulse", 0], ["pulse@2", 600], ["pulse@3", 1200], ["spark", 100], ["spark@2", 600],
    ]);
    expect(cues[0]?.sections.filter((section) => section.kind === "image"))
      .toMatchObject([{ mime: "image/png" }, { mime: "image/png" }]);
    expect(cues[0]?.sections.every((section) => !Object.hasOwn(section, "repeatCount"))).toBe(true);
    expect(h.hostStore.seq).toBe(before);
  });

  test("a cue that cannot reach everyone reports counts to the requesting GM, with no user or document names", async () => {
    const h = await setup({ [imageHash]: { name: "vfx.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    h.gm.submit([{ kind: "create", coll: "macros", data: fxMacro("counsel") }]);
    await flushMicrotasks();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    void player;
    await h.addPlayer(OTHER_ID, "Ivy");
    const reports: ClientEvents["fxDelivery"][] = [];
    h.gmBus.on("fxDelivery", (msg) => reports.push(msg));
    const playerReports: ClientEvents["fxDelivery"][] = [];
    // A scene-audience cue reaches everyone, so there is nothing to explain.
    h.gm.requestSequence("counsel", "s1");
    await flushMicrotasks();
    expect(reports).toHaveLength(0);

    // Narrow the same cue to the GM's own audience: the two players are outside it.
    const macro = fxMacro("counsel");
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "counsel" },
      diff: { sequence: { ...macro.sequence, audience: "gm" } as unknown as Json } }]);
    await flushMicrotasks();
    h.gm.requestSequence("counsel", "s1");
    await flushMicrotasks();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.recipients).toBe(1); // the GM's own loopback session
    expect(reports[0]?.skipped).toEqual({ audience: 2, rights: 0, anchor: 0, media: 0 });
    expect(reports[0]?.macroId).toBe("counsel");
    const summary = summarizeSkips(reports[0]?.skipped ?? { audience: 0, rights: 0, anchor: 0, media: 0 },
      reports[0]?.recipients ?? 0, "Counsel");
    expect(summary).toContain("Counsel: reached 1 viewer(s)");
    expect(summary).toContain("2 outside its audience");
    expect(JSON.stringify(reports[0])).not.toContain(PLAYER_ID); // counts, never identities
    expect(playerReports).toHaveLength(0);
  });

  test("a chosen-players audience reaches exactly the users it names (D-316)", async () => {
    const h = await setup({ [imageHash]: { name: "owned.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    const { bus: rexBus, client: rex } = await h.addPlayer(PLAYER_ID, "Rex");
    const { bus: ivyBus, client: ivy } = await h.addPlayer(OTHER_ID, "Ivy");
    const rexCues: ClientEvents["fx"][] = [];
    const ivyCues: ClientEvents["fx"][] = [];
    const gmCues: ClientEvents["fx"][] = [];
    rexBus.on("fx", (msg) => rexCues.push(msg));
    ivyBus.on("fx", (msg) => ivyCues.push(msg));
    h.gmBus.on("fx", (msg) => gmCues.push(msg));
    const reports: ClientEvents["fxDelivery"][] = [];
    h.gmBus.on("fxDelivery", (msg) => reports.push(msg));
    void rex; void ivy;

    // One timeline whose run is for Rex, and whose camera is for Ivy.
    h.gm.submit([{ kind: "create", coll: "macros", data: { _id: "chosen", type: "macro",
      name: "chosen", ownership: { default: 1 }, flags: { core: { playerCallable: true } },
      system: {}, kind: "sequence", command: "", sequence: { version: 1,
        audience: { players: [PLAYER_ID] }, sections: [
          { kind: "text", id: "a", text: "Psst", startMs: 0, durationMs: 400,
            at: { kind: "point", x: 120, y: 120 } },
          { kind: "camera", id: "b", mode: "pan", to: { kind: "point", x: 300, y: 300 },
            audience: { players: [OTHER_ID] }, startMs: 0, durationMs: 400 }] } } as never }]);
    await flushMicrotasks();
    h.gm.requestSequence("chosen", "s1");
    await flushMicrotasks();

    // Rex is the only recipient: the GM who asked is not in the list either, and that is
    // the point of a chosen audience — it is a list of people, not a floor of privilege.
    expect(rexCues.filter((msg) => msg.kind === "fx.start")).toHaveLength(1);
    expect(ivyCues).toHaveLength(0);
    expect(gmCues.filter((msg) => msg.kind === "fx.start")).toHaveLength(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.recipients).toBe(1);
    expect(reports[0]?.skipped).toEqual({ audience: 2, rights: 0, anchor: 0, media: 0 });
    // The report counts, and the payload does not name: neither Ivy nor the audience list
    // itself travels to Rex, who is the one client that *did* receive this cue.
    expect(JSON.stringify(reports[0])).not.toContain(OTHER_ID);
    const rexStart = rexCues.find((msg) => msg.kind === "fx.start");
    const rexSections = rexStart?.kind === "fx.start" ? rexStart.sections : [];
    expect(rexSections.map((step) => step.kind)).toEqual(["text"]);
    expect(JSON.stringify(rexStart)).not.toContain(OTHER_ID);
    expect(JSON.stringify(rexStart)).not.toContain(PLAYER_ID);

    // Publishing a cue is not a licence to fire it at other people: Ivy, who is not in
    // the list, is refused — while Rex, who is, may run it for himself.
    const ivyRefused: string[] = [];
    const rexRefused: string[] = [];
    ivyBus.on("rejected", (event) => ivyRefused.push(event.detail));
    rexBus.on("rejected", (event) => rexRefused.push(event.detail));
    const rexCueCount = () => rexCues.filter((msg) => msg.kind === "fx.start").length;
    const before = rexCueCount();
    ivy.requestSequence("chosen", "s1");
    await flushMicrotasks();
    expect(ivyRefused).toHaveLength(1);
    expect(rexCueCount()).toBe(before);
    rex.requestSequence("chosen", "s1");
    await flushMicrotasks();
    expect(rexRefused).toHaveLength(0);
    expect(rexCueCount()).toBe(before + 1);
  });

  test("a chosen-players camera section is filtered per viewer and its list never ships (D-316)", async () => {
    const h = await setup({});
    const { bus: rexBus } = await h.addPlayer(PLAYER_ID, "Rex");
    const { bus: ivyBus } = await h.addPlayer(OTHER_ID, "Ivy");
    const rexCues: ClientEvents["fx"][] = [];
    const ivyCues: ClientEvents["fx"][] = [];
    const gmCues: ClientEvents["fx"][] = [];
    rexBus.on("fx", (msg) => rexCues.push(msg));
    ivyBus.on("fx", (msg) => ivyCues.push(msg));
    h.gmBus.on("fx", (msg) => gmCues.push(msg));
    const reports: ClientEvents["fxDelivery"][] = [];
    h.gmBus.on("fxDelivery", (msg) => reports.push(msg));

    h.gm.submit([{ kind: "create", coll: "macros", data: { _id: "look", type: "macro",
      name: "look", ownership: { default: 1 }, flags: { core: { playerCallable: true } },
      system: {}, kind: "sequence", command: "", sequence: { version: 1, audience: "scene",
        sections: [
          { kind: "text", id: "a", text: "Look", startMs: 0, durationMs: 400,
            at: { kind: "point", x: 120, y: 120 } },
          { kind: "camera", id: "b", mode: "pan", to: { kind: "point", x: 300, y: 300 },
            audience: { players: [PLAYER_ID] }, startMs: 0, durationMs: 400 }] } } as never }]);
    await flushMicrotasks();
    h.gm.requestSequence("look", "s1");
    await flushMicrotasks();

    const starts = (cues: ClientEvents["fx"][]) =>
      cues.filter((msg) => msg.kind === "fx.start").map((msg) =>
        msg.kind === "fx.start" ? msg.sections.map((step) => step.kind) : []);
    // Everyone entitled to the run gets it; only the named user gets the camera — and its
    // delivered copy says nothing about who else the author addressed.
    expect(starts(rexCues)).toEqual([["text", "camera"]]);
    expect(starts(ivyCues)).toEqual([["text"]]);
    expect(starts(gmCues)).toEqual([["text"]]);
    const rexStart = rexCues.find((msg) => msg.kind === "fx.start");
    if (rexStart?.kind === "fx.start")
      expect(Object.keys(rexStart.sections[1] ?? {})).not.toContain("audience");
    // Two viewers were entitled to the run and saw it without the camera: not a skip, and
    // the report says so without naming them.
    expect(reports[0]?.recipients).toBe(3);
    expect(reports[0]?.skipped).toEqual({ audience: 0, rights: 0, anchor: 0, media: 0 });
    expect(JSON.stringify(reports[0])).not.toContain(OTHER_ID);
  });

  // D-303: targeted sections are not skips, and the GM has to hear about them — both
  // because "my targeting worked" is worth knowing and because a player who sees nothing
  // at all will ask why.
  test("the GM hears how many viewers got the run without a targeted section, and who got none", async () => {
    const h = await setup();
    const mixed = fxMacro("sightline");
    if (!mixed.sequence) throw new Error("Missing FX fixture sequence");
    mixed.sequence = { ...mixed.sequence, sections: [
      { kind: "text", id: "everyone", text: "Look", at: { kind: "point", x: 100, y: 100 },
        startMs: 0, durationMs: 400 },
      { kind: "camera", id: "gm-only", mode: "pan", to: { kind: "point", x: 400, y: 400 },
        audience: "gm", startMs: 0, durationMs: 500 },
    ] };
    const onlyTargeted = fxMacro("vista");
    if (!onlyTargeted.sequence) throw new Error("Missing FX fixture sequence");
    onlyTargeted.sequence = { ...onlyTargeted.sequence, sections: [
      { kind: "camera", id: "gm-only", mode: "pan", to: { kind: "point", x: 400, y: 400 },
        audience: "gm", startMs: 0, durationMs: 500 },
    ] };
    h.gm.submit([{ kind: "create", coll: "macros", data: mixed },
      { kind: "create", coll: "macros", data: onlyTargeted }]);
    await flushMicrotasks();
    await h.addPlayer(PLAYER_ID, "Rex");
    await h.addPlayer(OTHER_ID, "Ivy");
    const reports: ClientEvents["fxDelivery"][] = [];
    h.gmBus.on("fxDelivery", (msg) => reports.push(msg));

    h.gm.requestSequence("sightline", "s1");
    await flushMicrotasks();
    // Both players are entitled and both receive the run — with one section withheld.
    // Nobody was *skipped*, so the notice comes from the targeting counts alone.
    expect(reports).toHaveLength(1);
    expect(reports[0]?.recipients).toBe(3); // two players and the GM's own session
    expect(reports[0]?.skipped).toEqual({ audience: 0, rights: 0, anchor: 0, media: 0 });
    expect(reports[0]?.targeted).toBe(2);
    expect(reports[0]?.empty).toBeUndefined();
    expect(summarizeSkips(reports[0]?.skipped ?? { audience: 0, rights: 0, anchor: 0, media: 0 },
      reports[0]?.recipients ?? 0, "Sightline", { targeted: reports[0]?.targeted ?? 0 }))
      .toBe("Sightline: reached 3 viewer(s) — 2 saw it without its targeted sections");
    expect(JSON.stringify(reports[0])).not.toContain(PLAYER_ID); // counts, never identities

    // A timeline that is *entirely* GM-targeted: the players receive nothing, and the
    // notice says so rather than reporting a run that reached everyone.
    h.gm.requestSequence("vista", "s1");
    await flushMicrotasks();
    expect(reports).toHaveLength(2);
    expect(reports[1]?.recipients).toBe(1); // the GM alone
    expect(reports[1]?.targeted).toBeUndefined();
    expect(reports[1]?.empty).toBe(2);
  });

  test("a player's own request never receives the host's audience aggregate", async () => {
    const h = await setup();
    const aura = fxMacro("open-aura");
    aura.flags = { core: { playerCallable: true } };
    aura.sequence = { version: 1, audience: "scene", sections: [{ kind: "text", id: "a", text: "Aura",
      at: { kind: "point", x: 150, y: 150 }, startMs: 0, durationMs: 400 }] };
    h.gm.submit([{ kind: "create", coll: "macros", data: aura }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    await h.addPlayer(OTHER_ID, "Ivy");
    const seen: ClientEvents["fxDelivery"][] = [];
    bus.on("fxDelivery", (msg) => seen.push(msg));
    // The caller-scoped part of the audience is invisible to the other player, but a
    // request from a player must not turn into a viewer census for that player.
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "open-aura" }, diff: {
      sequence: { version: 1, audience: "caller", sections: [{ kind: "text", id: "a", text: "Aura",
        at: { kind: "point", x: 150, y: 150 }, startMs: 0, durationMs: 400 }] } as unknown as Json } }]);
    await flushMicrotasks();
    player.requestSequence("open-aura", "s1");
    await flushMicrotasks();
    expect(seen).toHaveLength(0);
  });

  test("a targeted camera section reaches only its audience, and the others never see it", async () => {
    const h = await setup({ [imageHash]: { name: "vfx.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    // One timeline: a text cue everyone gets, a GM-only pan, a scene pan, and a pan only
    // the requesting session gets. SQ-15's "local or recipient-targeted" camera.
    const macro = fxMacro("sightlines");
    if (!macro.sequence) throw new Error("Missing FX fixture sequence");
    macro.sequence = { ...macro.sequence, sections: [
      { kind: "text", id: "t", text: "Look", at: { kind: "point", x: 100, y: 100 }, startMs: 0, durationMs: 400 },
      { kind: "camera", id: "gm-look", mode: "pan", to: { kind: "point", x: 900, y: 90 },
        audience: "gm", startMs: 0, durationMs: 500 },
      { kind: "camera", id: "all-look", mode: "pan", to: { kind: "point", x: 500, y: 500 },
        startMs: 0, durationMs: 500 },
      { kind: "camera", id: "mine", mode: "pan", to: { kind: "point", x: 700, y: 700 },
        audience: "caller", startMs: 0, durationMs: 500 },
    ] };
    h.gm.submit([{ kind: "create", coll: "macros", data: macro }]);
    await flushMicrotasks();
    const first = await h.addPlayer(PLAYER_ID, "Rex");
    const second = await h.addPlayer(OTHER_ID, "Ivy");
    const gmCues: ClientEvents["fx"][] = [];
    const firstCues: ClientEvents["fx"][] = [];
    const secondCues: ClientEvents["fx"][] = [];
    h.gmBus.on("fx", (cue) => gmCues.push(cue));
    first.bus.on("fx", (cue) => firstCues.push(cue));
    second.bus.on("fx", (cue) => secondCues.push(cue));

    // The GM runs it: the GM sees all three cameras (they are the caller *and* a GM),
    // each player sees only the scene pan…
    h.gm.requestSequence("sightlines", "s1");
    await flushMicrotasks();
    const kinds = (cue: ClientEvents["fx"] | undefined) => cue?.sections.map((step) => step.id) ?? [];
    expect(kinds(gmCues[0])).toEqual(["t", "gm-look", "all-look", "mine"]);
    expect(kinds(firstCues[0])).toEqual(["t", "all-look"]);
    expect(kinds(secondCues[0])).toEqual(["t", "all-look"]);
    // …and the destination of the GM-only pan is not merely unrendered, it is absent:
    // their payload carries no trace of where someone else's view went.
    // Inspect camera payloads, not a substring that can also occur in the host timestamp/UUID.
    expect(firstCues[0]?.sections.filter((section) => section.kind === "camera")).toEqual([
      { kind: "camera", id: "all-look", mode: "pan", startMs: 0, durationMs: 500, toX: 500, toY: 500 },
    ]);

    // A player runs it: now the caller-targeted pan follows *them*, and the GM-only pan
    // still does not, while the other player still sees only the scene pan.
    first.client.requestSequence("sightlines", "s1");
    await flushMicrotasks();
    // The GM still gets the GM-only panic and never gets "mine": the caller moved.
    expect(kinds(gmCues[1])).toEqual(["t", "gm-look", "all-look"]);
    expect(kinds(firstCues[1])).toEqual(["t", "all-look", "mine"]);
    expect(kinds(secondCues[1])).toEqual(["t", "all-look"]);
    // Same run, two payloads: targeting filters a cue per recipient, it does not fork
    // the run — and the requester's own run is a new one, not a replay of the GM's.
    expect(firstCues[1]?.runId).toBe(gmCues[1]?.runId);
    expect(firstCues[1]?.runId).not.toBe(firstCues[0]?.runId);
  });

  test("a run whose every section is out of a viewer's audience is not delivered to them at all", async () => {
    const h = await setup();
    const macro = fxMacro("gm-vista");
    if (!macro.sequence) throw new Error("Missing FX fixture sequence");
    macro.sequence = { ...macro.sequence, sections: [
      { kind: "camera", id: "gm-only", mode: "pan", to: { kind: "point", x: 300, y: 300 },
        audience: "gm", startMs: 0, durationMs: 500 },
    ] };
    h.gm.submit([{ kind: "create", coll: "macros", data: macro }]);
    await flushMicrotasks();
    const player = await h.addPlayer(PLAYER_ID, "Rex");
    const gmCues: ClientEvents["fx"][] = [];
    const playerCues: ClientEvents["fx"][] = [];
    h.gmBus.on("fx", (cue) => gmCues.push(cue));
    player.bus.on("fx", (cue) => playerCues.push(cue));

    h.gm.requestSequence("gm-vista", "s1");
    await flushMicrotasks();
    expect(gmCues).toHaveLength(1);
    // An empty cue is not the same as no cue: the player is not sent a shell of a run
    // they cannot see any part of.
    expect(playerCues).toHaveLength(0);
  });

  test("hidden source and unpublished macros never broadcast to other players", async () => {
    const h = await setup({ [imageHash]: { name: "vfx.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    h.gm.submit([{ kind: "create", coll: "macros", data: fxMacro("secret-source", "source") },
      { kind: "create", coll: "macros", data: { ...fxMacro("gm-only"), flags: { core: { playerCallable: false } } } },
      { kind: "create", coll: "tokens", parent: { coll: "scenes", id: "s1" },
        data: tokenDoc("hidden-source", { hidden: true, ownership: { default: 0 } }) },
    ]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const { bus: otherBus } = await h.addPlayer(OTHER_ID, "Ivy");
    const fx: ClientEvents["fx"][] = [];
    const gmFx: ClientEvents["fx"][] = [];
    const rejections: string[] = [];
    bus.on("fx", (m) => fx.push(m));
    otherBus.on("fx", (m) => fx.push(m));
    bus.on("rejected", (m) => rejections.push(m.reason));
    h.gmBus.on("fx", (m) => gmFx.push(m));

    player.requestSequence("secret-source", "s1", "hidden-source");
    player.requestSequence("gm-only", "s1");
    await flushMicrotasks();
    expect(rejections).toEqual(["forbidden", "forbidden"]);
    expect(fx).toHaveLength(0);
    h.gm.requestSequence("secret-source", "s1", "hidden-source");
    await flushMicrotasks();
    expect(gmFx).toHaveLength(1);
    expect(gmFx[0]?.sections[0]).toMatchObject({ x: 0, y: 0 });
    expect(fx).toHaveLength(0);
  });

  test("host persists a private named instance; sync resumes phase without replaying mechanics; owner stops it", async () => {
    const h = await setup({ [imageHash]: { name: "aura.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    const macro = fxMacro("aura", "source");
    if (!macro.sequence) throw new Error("Missing FX fixture sequence");
    macro.sequence = { ...macro.sequence, persistent: true,
      sections: macro.sequence.sections.map((step) => step.kind === "image" || step.kind === "text"
        ? { ...step, follow: true } : step) };
    h.gm.submit([{ kind: "create", coll: "macros", data: macro }]);
    await flushMicrotasks();
    const first = await h.addPlayer(PLAYER_ID, "Rex");
    const second = await h.addPlayer(OTHER_ID, "Ivy");
    const received: ClientEvents["fx"][] = [];
    const ended: ClientEvents["fxEnd"][] = [];
    const otherFx: ClientEvents["fx"][] = [];
    const otherEnd: ClientEvents["fxEnd"][] = [];
    const rejected: string[] = [];
    first.bus.on("fx", (cue) => received.push(cue));
    first.bus.on("fxEnd", (end) => ended.push(end));
    second.bus.on("fx", (cue) => otherFx.push(cue));
    second.bus.on("fxEnd", (end) => otherEnd.push(end));
    second.bus.on("rejected", (event) => rejected.push(event.detail));
    first.client.requestSequence("aura", "s1", "t-pl");
    await flushMicrotasks();
    const instance = h.hostStore.getAll("fxInstances")[0];
    if (!instance) throw new Error("Host did not persist the instance");
    expect(instance).toMatchObject({ _id: received[0]?.runId, ownerId: PLAYER_ID, macroId: "aura",
      sourceTokenId: "t-pl", audience: "scene", sections: [
        { kind: "text", x: 0, y: 0, followTokenId: "t-pl" },
        { kind: "image", mime: "image/png", x: 0, y: 0, followTokenId: "t-pl" },
      ] });
    expect(received[0]?.persistent).toBe(true);
    expect(otherFx[0]?.runId).toBe(instance._id);
    expect(first.client.store.getAll("fxInstances")).toEqual([]);
    expect(second.client.store.getAll("fxInstances")).toEqual([]);
    expect(h.gm.store.getAll("fxInstances")).toHaveLength(1);
    h.gm.submit([{ kind: "update", ref: tokenRef, diff: { x: 340, y: 220 } }]);
    await flushMicrotasks();
    expect((first.client.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-pl"))
      .toMatchObject({ x: 340, y: 220 });
    expect(received).toHaveLength(1); // follow samples projected token locally; no per-frame network cues
    expect(h.hostStore.get("fxInstances", instance._id)?.sections[0]).toMatchObject({ x: 0, y: 0 });
    const committed = h.hostStore.seq;
    second.client.requestFxStop(instance._id);
    await flushMicrotasks();
    expect(rejected).toContain("FX instance unavailable");
    second.client.submit([{ kind: "delete", ref: { coll: "fxInstances", id: instance._id } }]);
    h.gm.submit([{ kind: "create", coll: "fxInstances", data: instance }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(committed);
    expect(h.hostStore.getAll("fxInstances")).toHaveLength(1);
    first.client.requestFxSync("s1");
    await flushMicrotasks();
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ runId: instance._id, atHostTime: instance.atHostTime });
    expect(h.hostStore.seq).toBe(committed);
    h.host.removeSession(`peer-${PLAYER_ID}`);
    const pair = createTransportPair();
    h.host.addSession(`peer-${PLAYER_ID}`, pair.a);
    first.client.reattach(pair.b);
    await flushMicrotasks();
    expect(first.client.store.getAll("fxInstances")).toEqual([]);
    first.client.requestFxSync("s1");
    await flushMicrotasks();
    expect(received.at(-1)?.runId).toBe(instance._id);
    expect(received.at(-1)?.atHostTime).toBe(instance.atHostTime); // host-clock restoration, not restart
    expect(h.hostStore.seq).toBe(committed);
    first.client.requestFxStop(instance._id);
    await flushMicrotasks();
    expect(h.hostStore.getAll("fxInstances")).toHaveLength(0);
    expect(h.gm.store.getAll("fxInstances")).toHaveLength(0);
    expect(ended.at(-1)?.runId).toBe(instance._id);
    expect(otherEnd.at(-1)?.runId).toBe(instance._id);
    first.client.requestFxSync("s1");
    await flushMicrotasks();
    expect(received.at(-1)?.runId).toBe(instance._id);
    expect(received.filter((cue) => cue.runId === instance._id)).toHaveLength(3);
  });

  test("hidden sources revoke live FX per viewer; reveal, source deletion and undo restore it", async () => {
    const h = await setup();
    const macro = fxMacro("ward", "source");
    macro.sequence = { version: 1, persistent: true, audience: "scene", sections: [{
      kind: "text", id: "a", text: "Ward", at: { kind: "source" }, startMs: 0, durationMs: 900,
    }] };
    const wardRef = { coll: "tokens" as const, id: "t-ward",
      parent: { coll: "scenes" as const, id: "s1" } };
    h.gm.submit([{ kind: "create", coll: "macros", data: macro },
      { kind: "create", coll: "tokens", parent: wardRef.parent,
        data: tokenDoc("t-ward", { ownership: { default: 0 } }) }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const { bus: otherBus } = await h.addPlayer(OTHER_ID, "Ivy");
    const start: ClientEvents["fx"][] = [], end: ClientEvents["fxEnd"][] = [];
    const otherStart: ClientEvents["fx"][] = [], otherEnd: ClientEvents["fxEnd"][] = [];
    bus.on("fx", (cue) => start.push(cue));
    bus.on("fxEnd", (cue) => end.push(cue));
    otherBus.on("fx", (cue) => otherStart.push(cue));
    otherBus.on("fxEnd", (cue) => otherEnd.push(cue));
    h.gm.requestSequence("ward", "s1", "t-ward");
    await flushMicrotasks();
    const id = h.hostStore.getAll("fxInstances")[0]?._id;
    expect(id).toBeTruthy();
    expect(start).toHaveLength(1);
    expect(otherStart).toHaveLength(1);
    h.gm.submit([{ kind: "update", ref: wardRef, diff: { hidden: true } }]);
    await flushMicrotasks();
    expect(end.at(-1)?.runId).toBe(id);
    expect(otherEnd.at(-1)?.runId).toBe(id);
    expect(h.hostStore.getAll("fxInstances")).toHaveLength(1); // GM may still see it
    player.requestFxSync("s1");
    await flushMicrotasks();
    expect(start).toHaveLength(1);
    h.gm.submit([{ kind: "update", ref: wardRef, diff: { hidden: false } }]);
    await flushMicrotasks();
    expect(start.at(-1)?.runId).toBe(id);
    expect(otherStart.at(-1)?.runId).toBe(id);
    expect(start).toHaveLength(2);
    const before = h.hostStore.seq;
    h.gm.submit([{ kind: "delete", ref: wardRef }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1); // token + bound instance in one transaction
    expect(h.hostLog.at(before + 1)?.env.ops.map((op) => op.kind === "create" ? op.coll : op.ref.coll))
      .toEqual(["tokens", "fxInstances"]);
    expect(h.hostStore.getAll("fxInstances")).toEqual([]);
    expect(end.at(-1)?.runId).toBe(id);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(h.hostStore.getAll("fxInstances")).toHaveLength(1);
    expect(start.at(-1)?.runId).toBe(id);
    expect(start).toHaveLength(3);
  });

  test("FX import rights revoke active playback on metadata-only changes, then restore the same run", async () => {
    const h = await setup({ [imageHash]: { name: "aura.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced", exportRights: "restricted" } });
    const macro = fxMacro("rights-aura");
    if (!macro.sequence) throw new Error("Missing FX fixture sequence");
    macro.sequence = { ...macro.sequence, persistent: true };
    h.gm.submit([{ kind: "create", coll: "macros", data: macro }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const cues: ClientEvents["fx"][] = [], ended: ClientEvents["fxEnd"][] = [];
    bus.on("fx", (cue) => cues.push(cue));
    bus.on("fxEnd", (end) => ended.push(end));
    h.gm.requestSequence("rights-aura", "s1");
    await flushMicrotasks();
    const runId = cues[0]?.runId;
    expect(runId).toBeTruthy();
    expect(player.store.world.assetManifest[imageHash]?.exportRights).toBe("restricted");
    const seq = h.hostStore.seq;
    h.hostStore.replaceAssetManifest({ [imageHash]: { name: "aura.png", mime: "image/png",
      size: 4, chunks: 1, visibility: "gm", exportRights: "restricted" } });
    h.host.broadcastAssetManifests();
    await flushMicrotasks();
    expect(player.store.world.assetManifest[imageHash]).toBeUndefined();
    expect(ended.map((end) => end.runId)).toEqual([runId]);
    player.requestFxSync("s1");
    await flushMicrotasks();
    expect(cues).toHaveLength(1);
    h.hostStore.replaceAssetManifest({ [imageHash]: { name: "aura.png", mime: "image/png",
      size: 4, chunks: 1, visibility: "referenced", exportRights: "restricted" } });
    h.host.broadcastAssetManifests();
    await flushMicrotasks();
    expect(player.store.world.assetManifest[imageHash]?.name).toBe("aura.png");
    expect(cues.map((cue) => cue.runId)).toEqual([runId, runId]);
    expect(h.hostStore.seq).toBe(seq); // no duplicate mechanic or durable record
  });

  test("a changed asset entitlement ends live FX, and an unauthorized listener sees no instance", async () => {
    const h = await setup({ [imageHash]: { name: "aura.png", mime: "image/png", size: 4,
      chunks: 1, visibility: "referenced" } });
    const macro = fxMacro("private-aura");
    if (!macro.sequence) throw new Error("Missing FX fixture sequence");
    macro.sequence = { ...macro.sequence, persistent: true, audience: "gm" };
    h.gm.submit([{ kind: "create", coll: "macros", data: macro }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const fx: ClientEvents["fx"][] = [], ends: ClientEvents["fxEnd"][] = [];
    bus.on("fx", (cue) => fx.push(cue));
    bus.on("fxEnd", (cue) => ends.push(cue));
    h.gm.requestSequence("private-aura", "s1");
    await flushMicrotasks();
    expect(fx).toHaveLength(0);
    expect(player.store.get("macros", "private-aura")).toBeUndefined();
    expect(player.store.world.assetManifest[imageHash]).toBeUndefined();
    expect(player.store.getAll("fxInstances")).toEqual([]);
    player.requestFxSync("s1");
    await flushMicrotasks();
    expect(fx).toHaveLength(0);
    expect(ends).toHaveLength(0); // cannot even infer a run ID by asking
    const id = h.hostStore.getAll("fxInstances")[0]?._id ?? "";
    const privateMacro = h.hostStore.get("macros", "private-aura") as MacroDocument;
    if (!privateMacro.sequence) throw new Error("Missing private sequence");
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "private-aura" }, diff: {
      sequence: { ...privateMacro.sequence, audience: "scene" } as unknown as Json,
    } }]);
    await flushMicrotasks();
    expect(player.store.get("macros", "private-aura")).toBeDefined();
    expect(player.store.world.assetManifest[imageHash]?.name).toBe("aura.png");
    expect(fx).toHaveLength(0); // later widening never widens an existing GM-only instance
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "private-aura" }, diff: {
      sequence: { ...privateMacro.sequence, audience: "gm" } as unknown as Json,
    } }]);
    await flushMicrotasks();
    expect(player.store.get("macros", "private-aura")).toBeUndefined();
    expect(player.store.world.assetManifest[imageHash]).toBeUndefined();
    h.gm.requestFxStop(id);
    await flushMicrotasks();
    expect(ends).toHaveLength(0); // no end notification to a never-entitled viewer

    const open = fxMacro("public-aura");
    if (!open.sequence) throw new Error("Missing FX fixture sequence");
    open.sequence = { ...open.sequence, persistent: true };
    h.gm.submit([{ kind: "create", coll: "macros", data: open }]);
    await flushMicrotasks();
    player.requestSequence("public-aura", "s1");
    await flushMicrotasks();
    expect(fx).toHaveLength(1);
    expect(player.store.world.assetManifest[imageHash]?.name).toBe("aura.png");
    const publicRun = fx[0]?.runId;
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "public-aura" }, diff: {
      sequence: { ...open.sequence, audience: "gm" } as unknown as Json,
    } }]);
    await flushMicrotasks();
    expect(player.store.get("macros", "public-aura")).toBeUndefined();
    expect(player.store.world.assetManifest[imageHash]).toBeUndefined();
    expect(ends.at(-1)?.runId).toBe(publicRun);
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "public-aura" }, diff: {
      sequence: { ...open.sequence, audience: "scene" } as unknown as Json,
    } }]);
    await flushMicrotasks();
    expect(player.store.get("macros", "public-aura")).toBeDefined();
    expect(player.store.world.assetManifest[imageHash]?.name).toBe("aura.png");
    expect(fx.at(-1)?.runId).toBe(publicRun);
    const seq = h.hostStore.seq;
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "public-aura" }, diff: {
      sequence: { version: 1, persistent: true, audience: "scene", sections: [
        { kind: "text", id: "a", text: "New", at: { kind: "point", x: 150, y: 150 },
          startMs: 0, durationMs: 800 },
      ] },
    } }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq + 1);
    expect(ends.at(-1)?.runId).toBe(publicRun);
    // Remove the other macro's last media reference: the stream and manifest are revoked too.
    h.gm.submit([{ kind: "delete", ref: { coll: "macros", id: "private-aura" } }]);
    await flushMicrotasks();
    expect(player.store.world.assetManifest[imageHash]).toBeUndefined();
    player.requestFxSync("s1");
    await flushMicrotasks();
    expect(fx).toHaveLength(2);
  });

  test("GM-authored sequence schema is checked on create/update, and player cannot edit it", async () => {
    const h = await setup();
    const bad = { ...fxMacro("invalid"), sequence: { version: 1, sections: [{ kind: "image", id: "a", assetId: "https://bad", at: { kind: "point", x: 2, y: 2 }, startMs: 0, durationMs: 100 }] } } as unknown as MacroDocument;
    const refused: string[] = [];
    h.gmBus.on("rejected", (m) => refused.push(m.reason));
    h.gm.submit([{ kind: "create", coll: "macros", data: bad }]);
    await flushMicrotasks();
    expect(refused).toEqual(["invalid_schema"]);
    expect(h.hostStore.get("macros", "invalid")).toBeUndefined();
    h.gm.submit([{ kind: "create", coll: "macros", data: fxMacro("published") }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    bus.on("rejected", (m) => refused.push(m.reason));
    player.submit([{ kind: "update", ref: { coll: "macros", id: "published" }, diff: {
      kind: "chat", command: "forged", ownership: { default: 3 },
    } }]);
    await flushMicrotasks();
    expect(refused.at(-1)).toBe("forbidden");
    expect(h.hostStore.get("macros", "published")?.kind).toBe("sequence");
  });
});

test("connected recipients receive replacement manifests as media references appear and are revoked", async () => {
  const hash = "c".repeat(64);
  const h = await setup({ [hash]: { name: "sfx.ogg", mime: "audio/ogg", size: 5,
    chunks: 1, visibility: "referenced" } });
  const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
  const manifests: AssetManifest[] = [];
  bus.on("assetManifest", (manifest) => manifests.push(manifest));
  expect(player.store.world.assetManifest[hash]).toBeUndefined();
  const macro: MacroDocument = { _id: "sfx", type: "macro", name: "Sound",
    system: {}, flags: { core: { playerCallable: true } }, ownership: { default: 1 },
    kind: "sequence", command: "", sequence: { version: 1, sections: [{
      kind: "sound", id: "s", assetId: hash, startMs: 0, durationMs: 700,
    }] } };
  h.gm.submit([{ kind: "create", coll: "macros", data: macro }]);
  await flushMicrotasks();
  expect(player.store.world.assetManifest[hash]?.name).toBe("sfx.ogg");
  expect(manifests.at(-1)?.[hash]?.name).toBe("sfx.ogg");
  h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "sfx" }, diff: {
    sequence: { version: 1, sections: [{ kind: "wait", id: "w", startMs: 0, durationMs: 700 }] },
  } }]);
  await flushMicrotasks();
  expect(player.store.world.assetManifest[hash]).toBeUndefined();
  expect(Object.keys(manifests.at(-1) ?? {})).not.toContain(hash);
  // A metadata-only import (or deletion) also updates joined sessions without a document op.
  h.hostStore.replaceAssetManifest({ [hash]: { name: "published.ogg", mime: "audio/ogg", size: 5,
    chunks: 1, visibility: "world" } });
  h.host.broadcastAssetManifests();
  await flushMicrotasks();
  expect(player.store.world.assetManifest[hash]?.name).toBe("published.ogg");
});

const zoneTile = (): TileDocument => ({
  _id: "zone", type: "tile", name: "Pressure plate", ownership: { default: 0 }, flags: {}, system: {},
  x: 100, y: 100, width: 200, height: 200, img: "", above: false,
  occlusion: { mode: "roof", alpha: 0.5 },
});
test("host stores only bounded convex first-class scene regions and reserves authoring to the GM", async () => {
  const h = await setup();
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const playerRejected: ClientEvents["rejected"][] = [];
  const gmRejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => playerRejected.push(event));
  h.gmBus.on("rejected", (event) => gmRejected.push(event));
  const base: RegionDocument = {
    _id: "courtyard", type: "region", name: "Courtyard", ownership: { default: 0 }, flags: {}, system: {},
    x: 100, y: 100, width: 200, height: 120,
    shape: { kind: "polygon", points: [[0.5, 0], [1, 1], [0, 1]] },
  };
  player.submit([{ kind: "create", coll: "regions", parent: { coll: "scenes", id: "s1" }, data: base }]);
  await flushMicrotasks();
  expect(playerRejected.at(-1)?.reason).toBe("forbidden");
  expect(h.hostStore.get("scenes", "s1")?.regions).toBeUndefined();

  h.gm.submit([{ kind: "create", coll: "regions", parent: { coll: "scenes", id: "s1" },
    data: { ...base, shape: { kind: "polygon", points: [[0, 0], [1, 1], [1, 0], [0, 1]] } } as unknown as RegionDocument }]);
  await flushMicrotasks();
  expect(gmRejected.at(-1)?.reason).toBe("invalid_schema");
  h.gm.submit([{ kind: "create", coll: "regions", parent: { coll: "scenes", id: "s1" }, data: base }]);
  await flushMicrotasks();
  expect(h.hostStore.get("scenes", "s1")?.regions?.[0]).toEqual(base);
  h.gm.submit([{ kind: "update", ref: { coll: "regions", id: base._id, parent: { coll: "scenes", id: "s1" } },
    diff: { width: -10 } }]);
  await flushMicrotasks();
  expect(gmRejected.at(-1)?.reason).toBe("invalid_schema");
  expect(h.hostStore.get("scenes", "s1")?.regions?.[0]?.width).toBe(200);
});

test("HostSync dispatches swept enter/exit through a region-anchored active-zone graph", async () => {
  const h = await setup();
  const region: RegionDocument = { _id: "crossing-region", type: "region", name: "Crossing region",
    ownership: { default: 0 }, flags: {}, system: {}, x: 100, y: 100, width: 200, height: 200,
    shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] } };
  h.gm.submit([{ kind: "create", coll: "regions", parent: { coll: "scenes", id: "s1" }, data: region }]);
  await flushMicrotasks();
  const graph: AutomationDocument = { ...zoneDoc(), _id: "region-graph", name: "Region crossing",
    definition: { ...zoneDoc().definition, sourceKind: "region", tileId: region._id, methods: ["enter", "exit"], gates: {},
      steps: [{ id: "announce", kind: "chat", audience: "gm", content: "region {{method}}" }] } };
  h.gm.submit([{ kind: "create", coll: "automations", data: graph }]);
  await flushMicrotasks();
  expect(h.hostStore.get("automations", graph._id)?.definition.sourceKind).toBe("region");
  h.gm.submit([{ kind: "update", ref: tokenRef, diff: { x: 400, y: 200 } }]);
  await flushMicrotasks();
  expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual(["region enter", "region exit"]);
  expect(h.hostStore.get("automations", graph._id)?.state?.count).toBe(2);
});

test("region Stop Token Movement clips the host path before commit at the swept boundary", async () => {
  const h = await setup();
  const region: RegionDocument = { _id: "stop-region", type: "region", name: "Stop region",
    ownership: { default: 0 }, flags: {}, system: {}, x: 100, y: 100, width: 200, height: 200,
    shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] } };
  h.gm.submit([{ kind: "create", coll: "regions", parent: { coll: "scenes", id: "s1" }, data: region }]);
  await flushMicrotasks();
  const graph: AutomationDocument = { ...zoneDoc(), _id: "region-stop-graph", name: "Region stop",
    definition: { ...zoneDoc().definition, sourceKind: "region", tileId: region._id,
      methods: ["enter"], gates: {}, steps: [{ id: "stop", kind: "stopMovement", snapToGrid: false }] } };
  h.gm.submit([{ kind: "create", coll: "automations", data: graph }]);
  await flushMicrotasks();
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  const start = h.hostStore.seq;
  player.submit([{ kind: "update", ref: tokenRef, diff: { x: 400, y: 200 } }]);
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(start + 2);
  expect(h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl"))
    .toMatchObject({ x: 100, y: 50 });
  expect(h.hostStore.get("automations", graph._id)?.state?.count).toBe(1);
});

test("host rejects invalid authored tile trigger polygons on create and direct update", async () => {
  const h = await setup();
  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (event) => rejected.push(event));
  const invalid = { ...zoneTile(), triggerZone: { kind: "polygon", points: [[0, 0], [1, 1], [1, 0], [0, 1]] } } as unknown as TileDocument;
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: invalid }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");
  expect(h.hostStore.get("scenes", "s1")?.tiles).toHaveLength(0);

  const valid = { ...zoneTile(), triggerZone: { kind: "polygon" as const, points: [[0.5, 0], [1, 1], [0, 1]] as Array<[number, number]> } };
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: valid }]);
  await flushMicrotasks();
  expect(h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone")?.triggerZone).toEqual(valid.triggerZone);
  h.gm.submit([{ kind: "update", ref: { coll: "tiles", id: "zone", parent: { coll: "scenes", id: "s1" } },
    diff: { triggerZone: { kind: "polygon", points: [[0, 0], [1.1, 0], [0, 1]] } as unknown as Json } }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");
  expect(h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone")?.triggerZone).toEqual(valid.triggerZone);

  const alphaHash = "c".repeat(64);
  const alpha = { ...zoneTile(), _id: "alpha-zone", img: alphaHash, triggerZone: { kind: "alpha" as const, width: 64 as const,
    height: 64 as const, imageHash: alphaHash, rows: Array.from({ length: 64 }, (_row, index) => index === 0 ? [[0, 1] as [number, number]] : []) } };
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: alpha }]);
  await flushMicrotasks();
  expect(h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "alpha-zone")?.triggerZone).toEqual(alpha.triggerZone);
  h.gm.submit([{ kind: "update", ref: { coll: "tiles", id: "alpha-zone", parent: { coll: "scenes", id: "s1" } },
    diff: { triggerZone: { kind: "alpha", width: 64, height: 64, rows: Array.from({ length: 64 }, () => []) } as unknown as Json } }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");
  expect(h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "alpha-zone")?.triggerZone).toEqual(alpha.triggerZone);

  const elevationZone = { ...zoneTile(), _id: "elevation-zone", triggerElevation: { min: 5, max: 10 } };
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: elevationZone }]);
  await flushMicrotasks();
  expect(h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "elevation-zone")?.triggerElevation)
    .toEqual({ min: 5, max: 10 });
  h.gm.submit([{ kind: "update", ref: { coll: "tiles", id: "elevation-zone", parent: { coll: "scenes", id: "s1" } },
    diff: { triggerElevation: { min: 20, max: 10 } as unknown as Json } }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");
  expect(h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "elevation-zone")?.triggerElevation)
    .toEqual({ min: 5, max: 10 });
});

const zoneMacro = (): MacroDocument => ({
  _id: "fx-plate", type: "macro", name: "Spark", ownership: { default: 2 }, flags: {}, system: {},
  kind: "sequence", command: "", sequence: { version: 1, audience: "scene", sections: [{
    kind: "text", id: "spark", text: "Spark", at: { kind: "source" }, startMs: 0, durationMs: 700,
  }] },
});
function zoneDoc(): AutomationDocument {
  return { _id: "zone-graph", type: "automation", name: "Pressure trap", ownership: { default: 3 },
    flags: {}, system: {}, definition: { version: 1, sceneId: "s1", tileId: "zone",
      methods: ["enter", "stop", "click", "manual"],
      gates: { oncePerToken: true, playerRunnable: true },
      steps: [
        { id: "selectdoor", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
        { id: "opendoor", kind: "tags", edit: "add", tags: ["activated"] },
        { id: "showfx", kind: "sequence", macroId: "fx-plate", audience: "gm" },
        { id: "message", kind: "chat", audience: "gm", content: "Plate triggered by {{user}}" },
      ] },
  };
}
async function seedZone(h: Harness): Promise<void> {
  h.gm.submit([
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() },
    { kind: "create", coll: "macros", data: zoneMacro() },
    { kind: "update", ref: { coll: "tokens", id: "t-ivy", parent: { coll: "scenes", id: "s1" } },
      diff: { taggerTags: ["door-1"] } },
  ]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations", data: zoneDoc() }]);
  await flushMicrotasks();
}

test("HostSync dispatches sceneChange only on a real switch into its destination scene and undo never replays it", async () => {
  const h = await setup();
  const destination: SceneDocument = { ...sceneDoc("scene-destination"), active: false };
  h.gm.submit([{ kind: "create", coll: "scenes", data: destination }]);
  await flushMicrotasks();
  const tile: TileDocument = { ...zoneTile(), _id: "scene-change-tile", name: "Arrival plate" };
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: destination._id }, data: tile }]);
  await flushMicrotasks();
  const graph: AutomationDocument = { ...zoneDoc(), _id: "scene-change-graph", name: "Arrival message",
    definition: { ...zoneDoc().definition, sceneId: destination._id, tileId: tile._id,
      methods: ["sceneChange"], gates: {},
      steps: [{ id: "arrival", kind: "chat", audience: "gm", content: "{{method}} by {{user}}" }] } };
  h.gm.submit([{ kind: "create", coll: "automations", data: graph }]);
  await flushMicrotasks();
  expect(h.hostStore.get("scenes", destination._id)?.active).toBe(false);
  expect(h.hostStore.get("automations", graph._id)?.state?.count ?? 0).toBe(0);
  expect(h.hostStore.getAll("messages")).toEqual([]);

  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (event) => rejected.push(event));
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const playerRejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => playerRejected.push(event));
  expect(player.store.getAll("automations")).toEqual([]);
  const beforeSpoof = h.hostStore.seq;
  h.gm.requestAutomation(graph._id, destination._id, "sceneChange");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(beforeSpoof);
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");
  player.requestAutomation(graph._id, destination._id, "sceneChange");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(beforeSpoof);
  expect(playerRejected.at(-1)?.reason).toBe("invalid_schema");
  expect(h.hostStore.get("automations", graph._id)?.state?.count ?? 0).toBe(0);

  const beforeSwitch = h.hostStore.seq;
  h.gm.submit([
    { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { active: false } },
    { kind: "update", ref: { coll: "scenes", id: destination._id }, diff: { active: true } },
  ]);
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(beforeSwitch + 2);
  expect(h.hostStore.get("scenes", "s1")?.active).toBe(false);
  expect(h.hostStore.get("scenes", destination._id)?.active).toBe(true);
  expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual(["sceneChange by gm-key"]);
  expect(player.store.getAll("messages")).toEqual([]);
  expect(player.store.getAll("automations")).toEqual([]);
  expect(h.hostStore.get("automations", graph._id)?.state?.recent?.map((entry) => entry.method)).toEqual(["sceneChange"]);
  expect(h.hostStore.get("automations", graph._id)?.state?.count).toBe(1);

  const beforeSameSceneUpdate = h.hostStore.seq;
  h.gm.submit([{ kind: "update", ref: { coll: "scenes", id: destination._id }, diff: { active: true } }]);
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(beforeSameSceneUpdate + 1);
  expect(h.hostStore.get("automations", graph._id)?.state?.count).toBe(1);
  expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual(["sceneChange by gm-key"]);

  expect(h.host.undo().ok).toBe(true);
  await flushMicrotasks();
  expect(h.hostStore.get("scenes", destination._id)?.active).toBe(true);
  expect(h.hostStore.get("automations", graph._id)?.state?.count).toBe(1);
  expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual(["sceneChange by gm-key"]);
  expect(h.host.undo().ok).toBe(true);
  await flushMicrotasks();
  expect(h.hostStore.get("scenes", destination._id)?.active).toBe(true);
  expect(h.hostStore.get("automations", graph._id)?.state?.count ?? 0).toBe(0);
  expect(h.hostStore.getAll("messages")).toEqual([]);
  expect(h.host.undo().ok).toBe(true);
  await flushMicrotasks();
  expect(h.hostStore.get("scenes", "s1")?.active).toBe(true);
  expect(h.hostStore.get("scenes", destination._id)?.active).toBe(false);
  expect(h.hostStore.get("automations", graph._id)?.state?.count ?? 0).toBe(0);
  expect(h.hostStore.getAll("messages")).toEqual([]);
});

test("HostSync dispatches the four door changes to graphs over the door and restore never replays them", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() }]);
  await flushMicrotasks();
  // The door's midpoint (200, 250) lies inside the zone tile, which owns the event.
  const door: WallDocument = { _id: "gate", type: "wall", name: "Gate", ownership: { default: 0 },
    flags: {}, system: {}, taggerTags: ["door-1"], c: [150, 250, 250, 250],
    move: 1, sight: 1, sound: 1, light: 1, door: 0, oneWay: false };
  h.gm.submit([{ kind: "create", coll: "walls", parent: { coll: "scenes", id: "s1" }, data: door }]);
  await flushMicrotasks();
  const openClose: AutomationDocument = { ...zoneDoc(), _id: "door-events", name: "Door events",
    definition: { ...zoneDoc().definition, tileId: "zone",
      methods: ["doorOpen", "doorClose", "doorLock", "doorUnlock"],
      gates: {}, steps: [{ id: "notice", kind: "chat", audience: "gm", content: "{{method}} by {{user}}" }] } };
  const closeOnly: AutomationDocument = { ...zoneDoc(), _id: "close-only", name: "Close only",
    definition: { ...zoneDoc().definition, tileId: "zone", methods: ["doorClose"],
      gates: {}, steps: [{ id: "notice", kind: "chat", audience: "gm", content: "closed by {{user}}" }] } };
  h.gm.submit([{ kind: "create", coll: "automations", data: openClose },
    { kind: "create", coll: "automations", data: closeOnly }]);
  await flushMicrotasks();
  const doorOf = () => (h.hostStore.get("scenes", "s1") as SceneDocument).walls.find((w) => w._id === "gate")?.door;
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);
  const setDoor = async (state: 0 | 1 | 2) => {
    h.gm.submit([{ kind: "update", ref: { coll: "walls", id: "gate", parent: { coll: "scenes", id: "s1" } },
      diff: { door: state } }]);
    await flushMicrotasks();
  };

  await setDoor(1);
  expect(doorOf()).toBe(1);
  expect(messages()).toEqual(["doorOpen by gm-key"]);
  expect(h.hostStore.get("automations", "door-events")?.state?.recent?.map((entry) => entry.method))
    .toEqual(["doorOpen"]);
  expect(h.hostStore.get("automations", "close-only")?.state?.count ?? 0).toBe(0);

  // The same value and non-door edits are not events.
  await setDoor(1);
  h.gm.submit([{ kind: "update", ref: { coll: "walls", id: "gate", parent: { coll: "scenes", id: "s1" } },
    diff: { oneWay: true } }]);
  await flushMicrotasks();
  expect(messages()).toEqual(["doorOpen by gm-key"]);

  // Neither GM nor player can ask for a door event directly.
  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (event) => rejected.push(event));
  const beforeSpoof = h.hostStore.seq;
  h.gm.requestAutomation("door-events", "s1", "doorOpen");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(beforeSpoof);
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");

  await setDoor(2);
  await setDoor(0);
  expect(messages().slice(1)).toEqual(["doorLock by gm-key", "doorUnlock by gm-key"]);

  await setDoor(1);
  const messagesBeforeClose = messages();
  await setDoor(0);
  // Both published graphs fire once on the close, in deterministic anchor order.
  expect(messages().slice(4)).toEqual(["closed by gm-key", "doorClose by gm-key"]);
  const counts = { events: h.hostStore.get("automations", "door-events")?.state?.count ?? 0,
    close: h.hostStore.get("automations", "close-only")?.state?.count ?? 0 };
  let guard = 0;
  while (doorOf() === 0 && guard++ < 5) {
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
  }
  expect(doorOf()).toBe(1); // the close was undone; the restore reopened it…
  expect(messages()).toEqual(messagesBeforeClose); // …without firing doorOpen again
  expect(h.hostStore.get("automations", "door-events")?.state?.count ?? 0).toBeLessThan(counts.events);
  expect(h.hostStore.get("automations", "close-only")?.state?.count ?? 0).toBeLessThan(counts.close);

  // A published player plate can operate the door. The plate's plan commits as authoritative
  // host work (the system identity), so the door change is a world event that fires published
  // rules exactly like a host-driven movement; the player still receives neither the door
  // graph, its history nor the GM-only message.
  const plate: AutomationDocument = { ...zoneDoc(), _id: "door-plate", name: "Door plate",
    definition: { ...zoneDoc().definition, tileId: "zone", methods: ["click"],
      gates: { playerRunnable: true }, steps: [
        { id: "find", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["walls"] } },
        { id: "toggle", kind: "door", mode: "toggle" }] } };
  h.gm.submit([{ kind: "create", coll: "automations", data: plate }]);
  await flushMicrotasks();
  await setDoor(0);
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const playerRejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => playerRejected.push(event));
  expect(player.store.getAll("automations")).toEqual([]);
  const countBeforePlayer = h.hostStore.get("automations", "door-events")?.state?.count ?? 0;
  player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
  await flushMicrotasks();
  expect(doorOf()).toBe(1); // the published plate operated the door…
  expect(h.hostStore.get("automations", "door-events")?.state?.count).toBe(countBeforePlayer + 1); // …and the door graph ran
  expect(messages().at(-1)).toMatch(/^doorOpen by /);
  expect(player.store.getAll("messages")).toEqual([]);
  expect(playerRejected).toEqual([]);

  player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
  await flushMicrotasks();
  expect(doorOf()).toBe(0); // toggle closed it again
  expect(h.hostStore.get("automations", "door-events")?.state?.recent?.at(-1)?.method).toBe("doorClose");
  expect(messages().at(-1)).toMatch(/^doorClose by /);
  expect(player.store.getAll("messages")).toEqual([]);
});

test("HostSync dispatches host-observed elevation changes through active-zone methods", async () => {
  const h = await setup();
  const tile = { ...zoneTile(), triggerElevation: { min: 5, max: 10 } };
  h.gm.submit([
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: tile },
    { kind: "update", ref: { coll: "tokens", id: "t-pl", parent: { coll: "scenes", id: "s1" } }, diff: { x: 150, y: 150 } },
  ]);
  await flushMicrotasks();
  const graph: AutomationDocument = { ...zoneDoc(), definition: {
    ...zoneDoc().definition, methods: ["elevation"], gates: {},
    steps: [{ id: "elevation-message", kind: "chat", audience: "gm", content: "entered vertical band" }],
  } };
  h.gm.submit([{ kind: "create", coll: "automations", data: graph }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: "t-pl", parent: { coll: "scenes", id: "s1" } },
    diff: { elevation: 6 } }]);
  await flushMicrotasks();
  expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual(["entered vertical band"]);
  expect(h.hostStore.get("automations", graph._id)?.state?.count).toBe(1);
});

async function seedRotatedZonePair(
  h: Harness,
  firstSteps: AutomationDefinition["steps"],
): Promise<void> {
  // Put the token at the left edge before any zone graph exists; initial fixture placement must
  // not consume once-per-token history or masquerade as one of the swept crossings.
  h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: "t-pl", parent: { coll: "scenes", id: "s1" } },
    diff: { x: 0, y: 250 } }]);
  await flushMicrotasks();
  await seedZone(h);
  const secondTile: TileDocument = {
    ...zoneTile(), _id: "zone-later", name: "Later rotated plate",
    x: 550, y: 200, width: 200, height: 100, rotation: 135,
  };
  const secondGraph: AutomationDocument = {
    ...zoneDoc(), _id: "zone-later-graph", name: "Later rotated trigger",
    definition: { ...zoneDoc().definition, tileId: secondTile._id, methods: ["enter"], gates: {},
      steps: [{ id: "later-chat", kind: "chat", audience: "gm", content: "later rotated zone" }] },
  };
  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (message) => rejected.push(message));
  h.gm.submit([
    { kind: "update", ref: { coll: "tiles", id: "zone", parent: { coll: "scenes", id: "s1" } },
      diff: { x: 200, y: 200, width: 200, height: 100, rotation: 45 } },
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: secondTile },
  ]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: {
      ...zoneDoc().definition, methods: ["enter"], gates: {}, steps: firstSteps,
    } as unknown as Json } },
    { kind: "create", coll: "automations", data: secondGraph },
  ]);
  await flushMicrotasks();
  expect(rejected).toEqual([]);
  expect(h.hostStore.get("automations", "zone-graph")?.definition.steps).toEqual(firstSteps);
  expect(h.hostStore.get("automations", "zone-later-graph")?.definition.tileId).toBe("zone-later");
}

describe("Active-zone host evaluation and graph secrecy", () => {
  test.each([undefined, 1500])("published appearance actions stage lighting (%s ms) and art atomically; privacy, catch-up and undo hold", async (durationMs) => {
    const hash = "a".repeat(64);
    const h = await setup({ [hash]: { name: "private-until-used.png", mime: "image/png", size: 8, chunks: 1 } });
    await seedZone(h);
    const def: AutomationDefinition = { ...zoneDoc().definition, methods: ["click", "manual"], gates: { playerRunnable: true }, steps: [
      { id: "light", kind: "sceneLighting", mode: "set", darkness: 0.75, ...(durationMs === undefined ? {} : {durationMs}) },
      { id: "check", kind: "checkValue", source: "darkness", compare: "eq", value: 0.75 },
      { id: "bg", kind: "sceneBackground", image: hash },
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "art", kind: "tileImage", image: hash },
      { id: "chat", kind: "chat", audience: "scene", content: "Night falls" },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const received: ClientEvents["ops"][] = [], rejected: ClientEvents["rejected"][] = [];
    bus.on("ops", (msg) => received.push(msg)); bus.on("rejected", (msg) => rejected.push(msg));
    expect(player.store.world.assetManifest[hash]).toBeUndefined();
    const before = h.hostStore.seq;
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl", true);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);
    expect(h.hostStore.get("scenes", "s1")?.darkness).toBe(0);
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect(h.hostStore.get("scenes", "s1")).toMatchObject({ darkness: 0.75, img: hash });
    expect(h.hostStore.get("scenes", "s1")?.tiles.find((t) => t._id === "zone")?.img).toBe(hash);
    expect(player.store.get("scenes", "s1")).toMatchObject({ darkness: 0.75, img: hash });
    expect(player.store.get("scenes", "s1")?.flags.arenaDarkness).toEqual(durationMs === undefined ? undefined : {darkness:0.75,durationMs});
    expect(player.store.world.assetManifest[hash]?.name).toBe("private-until-used.png");
    expect(player.store.getAll("automations")).toEqual([]);
    expect(JSON.stringify(received)).not.toMatch(/zone-graph|sceneLighting|sceneBackground|tileImage/);
    player.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    const { client: rejoined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(rejoined.store.get("scenes", "s1")).toMatchObject({ darkness: 0.75, img: hash });
    expect(rejoined.store.getAll("automations")).toEqual([]);
    expect(rejoined.store.world.assetManifest[hash]).toBeDefined();
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(h.hostStore.get("scenes", "s1")).toMatchObject({ darkness: 0, img: null });
    expect(h.hostStore.get("scenes", "s1")?.tiles.find((t) => t._id === "zone")?.img).toBe("");
    expect(h.hostStore.get("automations", "zone-graph")?.state).toBeUndefined();
    expect(rejoined.store.world.assetManifest[hash]).toBeUndefined();
    expect(rejoined.store.getAll("messages")).toHaveLength(0);
  });

  test("pinned entity publication/execution is exact, private and undoable for a player trigger",async()=>{
    const h=await setup();await seedZone(h);
    const secret:TileDocument={...zoneTile(),_id:"private-pin",hidden:true};
    h.gm.submit([{kind:"create",coll:"tiles",parent:{coll:"scenes",id:"s1"},data:secret}]);await flushMicrotasks();
    const refs=[{coll:"tiles" as const,id:"missing",parent:{coll:"scenes" as const,id:"s1"}},
      {coll:"tokens" as const,id:"t-pl",parent:{coll:"scenes" as const,id:"s1"}}];
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["click","manual"],gates:{playerRunnable:true},steps:[
      {id:"pin",kind:"select",selector:{kind:"ids",refs}},
      {id:"turn",kind:"rotate",mode:"add",angle:90,targets:"current"},
    ]};
    const prior=h.hostStore.seq;
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(prior);
    const first=refs[0];if(!first)throw new Error("missing pin");first.id="private-pin";
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(prior+1);
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex");const received:ClientEvents["ops"][]=[];bus.on("ops",(msg)=>received.push(msg));
    const before=h.hostStore.seq;player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before+1);expect(h.hostStore.get("scenes","s1")?.tiles.find((t)=>t._id==="private-pin")?.rotation).toBe(90);
    expect(player.store.get("scenes","s1")?.tokens.find((t)=>t._id==="t-pl")?.rotation).toBe(90);
    expect(player.store.get("scenes","s1")?.tiles.some((t)=>t._id==="private-pin")).toBe(false);
    expect(JSON.stringify(received)).not.toMatch(/private-pin|zone-graph/);expect(player.store.getAll("automations")).toEqual([]);
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();
    expect(player.store.get("scenes","s1")?.tokens.find((t)=>t._id==="t-pl")?.rotation).toBe(0);
    h.gm.submit([{kind:"delete",ref:{coll:"tiles",id:"private-pin",parent:{coll:"scenes",id:"s1"}}}]);await flushMicrotasks();
    const seq=h.hostStore.seq;h.gm.requestAutomation("zone-graph","s1","manual","t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq);expect(player.store.get("scenes","s1")?.tokens.find((t)=>t._id==="t-pl")?.rotation).toBe(0);
  });

  test("timed token rotation commits facing and dispatches rotate triggers immediately",async()=>{
    const h=await setup();await seedZone(h);
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["click"],gates:{playerRunnable:true},steps:[
      {id:"turn",kind:"rotate",mode:"add",angle:90,targets:"triggering",durationMs:60000},
    ]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}},
      {kind:"update",ref:{coll:"tokens",id:"t-pl",parent:{coll:"scenes",id:"s1"}},diff:{x:150,y:150}},
      {kind:"create",coll:"automations",data:{...zoneDoc(),_id:"rotation-observer",definition:{...zoneDoc().definition,methods:["rotate"],gates:{},steps:[
        {id:"message",kind:"chat",audience:"gm",content:"Rotation committed, not waiting for animation"},
      ]}} as AutomationDocument}]);await flushMicrotasks();
    const {client:player}=await h.addPlayer(PLAYER_ID,"Rex");
    player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();
    expect(h.hostStore.get("scenes","s1")?.tokens.find((token)=>token._id==="t-pl"))
      .toMatchObject({rotation:90,flags:{arenaRotation:{rotation:90,durationMs:60000}}});
    expect(player.store.get("scenes","s1")?.tokens.find((token)=>token._id==="t-pl")?.rotation).toBe(90);
    expect(h.hostStore.getAll("messages").some((m)=>m.content==="Rotation committed, not waiting for animation")).toBe(true);
    expect(player.store.getAll("messages")).toEqual([]);expect(player.store.getAll("automations")).toEqual([]);
  });

  test.each([{formula:false,animated:false},{formula:true,animated:false},{formula:false,animated:true},{formula:true,animated:true}])("player click rotates a tile relatively with Undo/catch-up (formula $formula, animated $animated)", async ({formula,animated}) => {
    const h = await setup(); await seedZone(h);
    const def: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true }, steps: [
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "turn", kind: "rotate", mode: "add", ...(formula ? { formula: "1d1 * 90" } : { angle: 90 }), targets: "current", ...(animated ? {durationMs:1000} : {}) },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const before = h.hostStore.seq;
    for (const angle of [90, 180]) {
      player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl"); await flushMicrotasks();
      expect(h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone")?.rotation).toBe(angle);
      expect(player.store.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone")?.rotation).toBe(angle);
      expect(player.store.getAll("automations")).toEqual([]);
      expect(player.store.get("scenes","s1")?.tiles.find((tile)=>tile._id==="zone")?.flags.arenaRotation)
        .toEqual(animated ? {rotation:angle,durationMs:1000} : undefined);
    }
    const { client: rejoined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(rejoined.store.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone")?.rotation).toBe(180);
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks();
    expect(rejoined.store.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone")?.rotation).toBe(90);
    expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBe(1);
  });

  test("player click moves its tile without stationary-token triggers, with private history, catch-up and Undo", async () => {
    const h = await setup(); await seedZone(h);
    const def: AutomationDefinition = { ...zoneDoc().definition, methods: ["click", "enter", "exit", "stop"], gates: { playerRunnable: true }, steps: [
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", mode: "add", x: 10, y: 20, targets: "current" },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const before = h.hostStore.seq;
    const initial = h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone");
    if (!initial) throw new Error("missing tile");
    for (const count of [1, 2]) {
      player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl"); await flushMicrotasks();
      expect(h.hostStore.seq).toBe(before + count);
      expect(player.store.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone"))
        .toMatchObject({ x: initial.x + 10 * count, y: initial.y + 20 * count });
      expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBe(count);
      expect(player.store.getAll("automations")).toEqual([]);
    }
    const { client: rejoined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(rejoined.store.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone"))
      .toMatchObject({ x: initial.x + 20, y: initial.y + 40 });
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks();
    expect(rejoined.store.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone"))
      .toMatchObject({ x: initial.x + 10, y: initial.y + 20 });
    expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBe(1);
  });

  test.each([false,true])("host snaps a player-triggered move and restores it on Undo (coordinate formulas %s)", async (formula) => {
    const h = await setup(); await seedZone(h);
    const def: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true }, steps: [
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "move", kind: "move", ...(formula ? {mode:"add" as const,xMode:"set" as const,yMode:"set" as const,xFormula:"1d1 * 276",yFormula:"162 * 2"} : {x:276,y:324}), targets: "current", snapToGrid: true, wallCollision: "block", durationMs: 1200 },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const original = structuredClone(h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone"));
    if (!original) throw new Error("missing tile");
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl"); await flushMicrotasks();
    expect(player.store.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone"))
      .toMatchObject({ x: 250 - original.width / 2, y: 350 - original.height / 2 });
    const moved = player.store.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone");
    expect(moved?.flags.arenaMove).toEqual({ x: 250 - original.width / 2, y: 350 - original.height / 2, durationMs: 1200 });
    expect(player.store.getAll("automations")).toEqual([]);
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks();
    expect(player.store.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone"))
      .toMatchObject({ x: original.x, y: original.y });
  });

  test("Undo and Redo restore crossing and graph envelopes without re-firing entry actions or RNG",async()=>{
    let draws=0;const h=await setup({},undefined,()=>{draws++;return 0;});await seedZone(h);
    for(const id of ["entry-a","entry-b"])h.gm.submit([{kind:"create",coll:"tiles",parent:{coll:"scenes",id:"s1"},
      data:{...zoneTile(),_id:id,x:400,y:400,width:200,height:100,rotation:90,taggerTags:["entry-target"]} as TileDocument}]);await flushMicrotasks();
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter"],gates:{},steps:[
      {id:"chat",kind:"chat",audience:"gm",content:"one crossing"},
      {id:"move",kind:"move",targets:"triggering",destinationTag:{kind:"tag",query:"entry-target",collections:["tiles"]},destinationChoice:"random",destinationPosition:"entry",x:0,y:0,triggerTiles:false},
    ]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player}=await h.addPlayer(PLAYER_ID,"Rex");player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]);await flushMicrotasks();
    const messages=structuredClone(h.hostStore.getAll("messages"));expect(messages).toHaveLength(1);expect(draws).toBe(1);
    const seq=h.hostStore.seq;
    for(const [action,x,y,count] of [["undo",400,200,0],["undo",0,0,0],["redo",400,200,0],["redo",550,350,1]] as const){
      expect(h.host[action]().ok).toBe(true);await flushMicrotasks();
      expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x,y});
      expect(h.hostStore.getAll("messages")).toHaveLength(count);expect(h.hostStore.get("automations","zone-graph")?.state?.count??0).toBe(count);expect(draws).toBe(1);
    }
    expect(h.hostStore.seq).toBe(seq+4);expect(h.hostStore.getAll("messages")).toEqual(messages);
  });

  test.each(["undo-","redo-","action-revert-"])("a client %s transaction name cannot suppress crossing automation",async(prefix)=>{
    const h=await setup();await seedZone(h);
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter"],gates:{},steps:[{id:"chat",kind:"chat",audience:"gm",content:"crossed"}]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const pair=createTransportPair();h.host.addSession("prefix-test",pair.a,{id:PLAYER_ID,role:"PLAYER",name:"Rex"});
    const seq=h.hostStore.seq;pair.b.send("ops",frameMessage({kind:"intent",txId:prefix+"forgery",ops:[{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]}));await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq+2);expect(h.hostStore.getAll("messages").map(m=>m.content)).toEqual(["crossed"]);h.host.removeSession("prefix-test");
  });

  test("Original Destination follows the host-observed token endpoint through a staged redirect and stays private/undoable",async()=>{
    const h=await setup();await seedZone(h);
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter","manual"],gates:{playerRunnable:true},steps:[
      {id:"notice",kind:"chat",audience:"gm",content:"original endpoint saved"},
      {id:"detour",kind:"move",targets:"triggering",x:800,y:800,triggerTiles:false},
      {id:"return",kind:"move",targets:"triggering",destinationOriginal:true,x:25,y:-25,triggerTiles:false},
    ]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex"),received:ClientEvents["ops"][]=[];bus.on("ops",msg=>received.push(msg));
    h.gm.requestAutomation("zone-graph","s1","manual","t-pl",true);await flushMicrotasks();
    expect(h.hostStore.getAll("messages")).toEqual([]);
    const start=h.hostStore.seq;
    // Host observes (0,0)->(400,200); the swept enter happens before that endpoint.
    player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(start+2);expect(h.hostStore.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:425,y:175});
    expect(h.hostStore.getAll("messages").map(m=>m.content)).toEqual(["original endpoint saved"]);
    expect(player.store.getAll("messages")).toEqual([]);expect(player.store.getAll("automations")).toEqual([]);
    expect(JSON.stringify(received)).not.toMatch(/movementOriginal|destinationOriginal|original endpoint saved|zone-graph/);
    expect(h.hostStore.get("automations","zone-graph")?.state?.count).toBe(1);
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:400,y:200});
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:0,y:0});
    expect(h.hostStore.getAll("messages")).toEqual([]);expect(h.hostStore.get("automations","zone-graph")?.state?.count??0).toBe(0);
  });

  test("a sole unconditional Stop Token Movement clips the submitted endpoint before its first commit",async()=>{
    const h=await setup();await seedZone(h);
    const laterTile={...zoneTile(),_id:"beyond-stop",x:300,y:130,width:100,height:100};
    const laterGraph:AutomationDocument={...zoneDoc(),_id:"beyond-stop-graph",definition:{...zoneDoc().definition,tileId:"beyond-stop",methods:["enter"],gates:{},steps:[
      {id:"later-chat",kind:"chat",audience:"gm",content:"must not trigger past the stop"},
    ]}};
    h.gm.submit([{kind:"create",coll:"tiles",parent:{coll:"scenes",id:"s1"},data:laterTile},
      {kind:"create",coll:"automations",data:laterGraph}]);await flushMicrotasks();
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter"],gates:{},steps:[
      {id:"stop",kind:"stopMovement",snapToGrid:true},
    ]};h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex"),observed:number[]=[];
    bus.on("ops",()=>observed.push(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")?.x??-1));
    const start=h.hostStore.seq;player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(start+2);expect(h.hostStore.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:150,y:50});
    // The first client-visible envelope is already at the swept-footprint boundary: x=400 was never committed alone.
    expect(observed[0]).toBe(150);expect(h.hostStore.get("automations","zone-graph")?.state?.count).toBe(1);
    expect(h.hostStore.getAll("messages")).toEqual([]);expect(h.hostStore.get("automations","beyond-stop-graph")?.state?.count??0).toBe(0);
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:150,y:50});
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:0,y:0});
  });

  test("pre-commit Stop Token Movement clips an Exit crossing from inside the trigger",async()=>{
    const h=await setup();await seedZone(h);
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["exit"],gates:{},steps:[{id:"stop",kind:"stopMovement",snapToGrid:true}]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex"),observed:number[]=[];
    bus.on("ops",()=>observed.push(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")?.x??-1));
    player.submit([{kind:"update",ref:tokenRef,diff:{x:200,y:200}}]);await flushMicrotasks();
    const start=h.hostStore.seq;player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:400}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(start+2);expect(h.hostStore.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:350,y:350});
    expect(observed).toContain(350);expect(h.hostStore.get("automations","zone-graph")?.state?.count).toBe(1);
  });

  test("a conditional Stop Token Movement branch that skips does not clip player movement",async()=>{
    const h=await setup();await seedZone(h);
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter"],gates:{},steps:[
      {id:"direction",kind:"checkValue",source:"direction.x",compare:"eq",value:"left",otherwise:"skip"},
      {id:"stop",kind:"stopMovement",snapToGrid:true},{id:"skip",kind:"landing",name:"skip"},
    ]};h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player}=await h.addPlayer(PLAYER_ID,"Rex"),start=h.hostStore.seq;
    player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(start+2);expect(h.hostStore.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:400,y:200});
    expect(h.hostStore.get("automations","zone-graph")?.state?.count).toBe(1);
  });

  test("a conditional Stop branch that runs clips from its cached plan without changing undo boundaries",async()=>{
    const h=await setup();await seedZone(h);
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter"],gates:{},steps:[
      {id:"direction",kind:"checkValue",source:"direction.x",compare:"eq",value:"right",otherwise:"skip"},
      {id:"stop",kind:"stopMovement",snapToGrid:true},{id:"skip",kind:"landing",name:"skip"},
    ]};h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex"),observed:number[]=[];
    bus.on("ops",()=>observed.push(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")?.x??-1));
    const start=h.hostStore.seq;player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(start+2);expect(observed[0]).toBe(150);
    expect(h.hostStore.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:150,y:50});
    expect(h.hostStore.get("automations","zone-graph")?.state?.count).toBe(1);
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:150,y:50});
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:0,y:0});
  });

  test("Stop with a root-graph variable effect keeps movement and graph commits separate",async()=>{
    const h=await setup();await seedZone(h);
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter"],gates:{},steps:[
      {id:"mark",kind:"set",scope:"tile",name:"visited",value:true},
      {id:"stop",kind:"stopMovement",snapToGrid:true},
    ]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex"),observed:number[]=[];
    bus.on("ops",()=>observed.push(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")?.x??-1));
    const start=h.hostStore.seq;player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(start+2);expect(observed[0]).toBe(400);
    expect(h.hostStore.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:150,y:50});
    expect(h.hostStore.get("automations","zone-graph")?.state?.variables).toMatchObject({visited:true});
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:400,y:200});
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:0,y:0});
  });

  test.each([{roll:0.25,stops:true},{roll:0.75,stops:false}])(
    "chance-gated Stop uses one planner roll ($roll; stops=$stops)",async({roll,stops})=>{
      let rolls=0;const h=await setup({},undefined,()=>{rolls++;return roll;});await seedZone(h);
      const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter"],gates:{chance:0.5},
        steps:[{id:"stop",kind:"stopMovement",snapToGrid:true}]};
      h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
      const player=(await h.addPlayer(PLAYER_ID,"Rex")).client,start=h.hostStore.seq,beforeRolls=rolls;
      player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]);await flushMicrotasks();
      expect(rolls-beforeRolls).toBe(1);
      expect(h.hostStore.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl"))
        .toMatchObject(stops?{x:150,y:50}:{x:400,y:200});
      expect(h.hostStore.seq).toBe(start+(stops?2:1));
    });

  test("conditional chance Stop preflights a moved group once per token and preserves graph Undo boundaries",async()=>{
    let rolls=0;const h=await setup({},undefined,()=>{rolls++;return 0.25;});await seedZone(h);
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter"],gates:{chance:0.5},steps:[
      {id:"direction",kind:"checkValue",source:"direction.x",compare:"eq",value:"right",otherwise:"skip"},
      {id:"stop",kind:"stopMovement",snapToGrid:true},{id:"skip",kind:"landing",name:"skip"},
    ]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const beforeRolls=rolls,start=h.hostStore.seq;
    h.gm.submit([
      {kind:"update",ref:{coll:"tokens",id:"t-ivy",parent:{coll:"scenes",id:"s1"}},diff:{x:400,y:200}},
      {kind:"update",ref:{coll:"tokens",id:"t-pl",parent:{coll:"scenes",id:"s1"}},diff:{x:400,y:200}},
    ]);await flushMicrotasks();
    expect(rolls-beforeRolls).toBe(2);expect(h.hostStore.seq).toBe(start+3);
    for(const tokenId of ["t-ivy","t-pl"])
      expect(h.hostStore.get("scenes","s1")?.tokens.find((token)=>token._id===tokenId)).toMatchObject({x:150,y:50});
    const state=h.hostStore.get("automations","zone-graph")?.state;
    expect(state?.count).toBe(2);expect(state?.byToken?.["t-ivy"]?.count).toBe(1);expect(state?.byToken?.["t-pl"]?.count).toBe(1);
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(h.hostStore.get("automations","zone-graph")?.state?.count).toBe(1);
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(h.hostStore.get("automations","zone-graph")?.state?.count??0).toBe(0);
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();
    for(const tokenId of ["t-ivy","t-pl"])
      expect(h.hostStore.get("scenes","s1")?.tokens.find((token)=>token._id===tokenId)).toMatchObject({x:0,y:0});
  });

  test("an earlier non-stop movement graph keeps the later Stop on the post-commit path",async()=>{
    const h=await setup();await seedZone(h);
    const earlierTile={...zoneTile(),_id:"earlier",x:100,y:0,width:50,height:50};
    const earlierGraph:AutomationDocument={...zoneDoc(),_id:"earlier-graph",definition:{...zoneDoc().definition,
      tileId:"earlier",methods:["enter"],gates:{},steps:[{id:"notice",kind:"chat",audience:"gm",content:"earlier trigger"}]}};
    const stopDefinition:AutomationDefinition={...zoneDoc().definition,methods:["enter"],gates:{},steps:[{id:"stop",kind:"stopMovement",snapToGrid:true}]};
    h.gm.submit([{kind:"create",coll:"tiles",parent:{coll:"scenes",id:"s1"},data:earlierTile}]);await flushMicrotasks();
    h.gm.submit([{kind:"create",coll:"automations",data:earlierGraph}]);await flushMicrotasks();
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:stopDefinition as unknown as Json}}]);await flushMicrotasks();
    expect(h.hostStore.get("automations","earlier-graph")).toBeDefined();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex"),observed:number[]=[];
    bus.on("ops",()=>observed.push(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")?.x??-1));
    const start=h.hostStore.seq;player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]);await flushMicrotasks();
    expect(observed[0]).toBe(400);expect(h.hostStore.seq).toBe(start+3);
    expect(h.hostStore.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:150,y:50});
    expect(h.hostStore.get("automations","earlier-graph")?.state?.count).toBe(1);
    expect(h.hostStore.get("automations","zone-graph")?.state?.count).toBe(1);
  });

  test("Stop Token Movement settles at the host enter boundary, suppresses its correction path and undoes cleanly",async()=>{
    const h=await setup();await seedZone(h);const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter","exit"],steps:[
      {id:"private",kind:"chat",audience:"gm",content:"movement stopped"},
      {id:"stop",kind:"stopMovement",snapToGrid:true},
    ]};h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player}=await h.addPlayer(PLAYER_ID,"Rex"),start=h.hostStore.seq;
    // The client requests (400,200); the 100x100 token's leading corner reaches the tile at center (100,50), square-snapping to (150,50).
    player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(start+2);expect(h.hostStore.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:150,y:50});
    expect(h.hostStore.getAll("messages").map(m=>m.content)).toEqual(["movement stopped"]);expect(player.store.getAll("messages")).toEqual([]);
    expect(h.hostStore.get("automations","zone-graph")?.state?.count).toBe(1);
    // The correction path crosses back over the source but is suppressed; no recursive trigger.
    expect(h.hostStore.seq).toBe(start+2);expect(h.hostStore.get("automations","zone-graph")?.state?.count).toBe(1);
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:400,y:200});
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:0,y:0});
    expect(h.hostStore.getAll("messages")).toEqual([]);expect(h.hostStore.get("automations","zone-graph")?.state?.count??0).toBe(0);
  });

  test("client-supplied movementOriginal cannot override the host-observed endpoint",async()=>{
    const h=await setup();await seedZone(h);const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter"],steps:[
      {id:"move",kind:"move",targets:"triggering",destinationOriginal:true,x:25,y:-25,triggerTiles:false},
    ]};h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const pair=createTransportPair();h.host.addSession("forged-original",pair.a,{id:PLAYER_ID,role:"PLAYER",name:"Rex"});
    const seq=h.hostStore.seq;pair.b.send("ops",frameMessage({kind:"intent",txId:"forged-original",ops:[{kind:"update",ref:tokenRef,diff:{x:400,y:200}}],
      movementOriginal:{tokenId:"t-pl",x:900,y:900}} as unknown as import("../../src/core/messages").IntentMsg));await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq+2);expect(h.hostStore.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:425,y:175});h.host.removeSession("forged-original");
  });

  test.each(["undo","revert"] as const)("entry-relative Move uses the host crossing, keeps context private and restores via %s",async(restore)=>{
    let draws=0;const h=await setup({},undefined,()=>{draws++;return 0;});await seedZone(h);
    h.gm.submit([{kind:"create",coll:"tiles",parent:{coll:"scenes",id:"s1"},data:{...zoneTile(),_id:"private-entry-destination",x:400,y:400,width:200,height:100,rotation:90,hidden:true} as TileDocument}]);await flushMicrotasks();
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["enter","click","manual"],gates:{playerRunnable:true},steps:[
      {id:"notice",kind:"chat",audience:"gm",content:"private crossing"},
      {id:"move",kind:"move",targets:"triggering",destination:{coll:"tiles",id:"private-entry-destination"},destinationPosition:"entry",x:0,y:0,durationMs:500,triggerTiles:false},
    ]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex"),received:ClientEvents["ops"][]=[];bus.on("ops",msg=>received.push(msg));
    // Click/run/dry-run cannot invent an entry from the token's current position.
    const before=h.hostStore.seq;player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");
    h.gm.requestAutomation("zone-graph","s1","manual","t-pl",true);await flushMicrotasks();expect(h.hostStore.seq).toBe(before);
    const pair=createTransportPair();h.host.addSession("forged-entry",pair.a,{id:PLAYER_ID,role:"PLAYER",name:"Rex"});
    pair.b.send("ops",frameMessage({kind:"automation.click",requestId:"forged-entry",sceneId:"s1",tileId:"zone",point:{x:150,y:150},tokenId:"t-pl",
      movementEntry:{tileId:"zone",tokenId:"t-pl",u:1,v:1}} as unknown as import("../../src/core/messages").AutomationClickMsg));
    await flushMicrotasks();expect(h.hostStore.seq).toBe(before);h.host.removeSession("forged-entry");
    // (0,0)->(400,200) passes right through the source. Contact is (200,100), not (400,200).
    player.submit([{kind:"update",ref:tokenRef,diff:{x:400,y:200}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before+2);expect(draws).toBe(0);
    expect(player.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:550,y:350,flags:{arenaMove:{x:550,y:350,durationMs:500}}});
    expect(player.store.getAll("automations")).toEqual([]);expect(player.store.getAll("messages")).toEqual([]);
    expect(JSON.stringify(received)).not.toMatch(/private-entry-destination|movementEntry|destinationPosition|private crossing|zone-graph/);
    const {client:late}=await h.addPlayer(PLAYER_ID,"Rex",{lastSeq:before});expect(late.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:550,y:350});
    if(restore==="undo")expect(h.host.undo().ok).toBe(true);
    else {const receipt=h.hostStore.getAll("actionReceipts").find(r=>r.status==="ready");if(!receipt)throw new Error("missing receipt");h.gm.actionRevert(receipt._id);}
    await flushMicrotasks();expect(late.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:400,y:200});
    expect(h.hostStore.getAll("messages")).toEqual([]);expect(h.hostStore.get("automations","zone-graph")?.state?.count??0).toBe(0);expect(draws).toBe(0);
    const seq=h.hostStore.seq;late.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();expect(h.hostStore.seq).toBe(seq);
    // A later failing entry graph does not roll back the preceding committed player drag.
    definition.steps.push({id:"dark",kind:"sceneLighting",mode:"set",darkness:1},{id:"fail",kind:"sceneLighting",mode:"add",darkness:1});
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const failureSeq=h.hostStore.seq;late.submit([{kind:"update",ref:tokenRef,diff:{x:0,y:0}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(failureSeq+1);expect(h.hostStore.get("scenes","s1")).toMatchObject({darkness:0});
    expect(h.hostStore.getAll("messages")).toEqual([]);expect(late.store.get("scenes","s1")?.tokens.find(t=>t._id==="t-pl")).toMatchObject({x:0,y:0});
  });

  test("player-triggered random Move uses host draws, keeps private destinations secret and restores the sampled endpoint",async()=>{
    let draws=0;const h=await setup({},undefined,()=>{draws++;return 0.75;});await seedZone(h);
    for(const [id,x] of [["private-a",400],["private-b",700]] as const)h.gm.submit([{kind:"create",coll:"tiles",parent:{coll:"scenes",id:"s1"},
      data:{...zoneTile(),_id:id,x,y:400,hidden:true,taggerTags:["secret-destinations"]} as TileDocument}]);await flushMicrotasks();
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["click","manual"],gates:{playerRunnable:true},steps:[
      {id:"light",kind:"sceneLighting",mode:"set",darkness:0.5},
      {id:"self",kind:"select",selector:{kind:"tile"}},
      {id:"move",kind:"move",destinationTag:{kind:"tag",query:"secret-destinations",collections:["tiles"]},
        destinationChoice:"random",destinationPosition:"random",x:0,y:0,targets:"current",durationMs:60000},
    ]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex");const received:ClientEvents["ops"][]=[];bus.on("ops",(msg)=>received.push(msg));
    draws=0;const before=h.hostStore.seq;player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();
    expect(draws).toBe(3);expect(h.hostStore.seq).toBe(before+1);
    // 0.75 picks b, then samples (850,550); the mover's native half-size is 100.
    const expected={x:750,y:450,flags:{arenaMove:{x:750,y:450,durationMs:60000}}};
    expect(player.store.get("scenes","s1")?.tiles.find((t)=>t._id==="zone")).toMatchObject(expected);
    expect(player.store.get("scenes","s1")?.tiles).toHaveLength(1);expect(player.store.getAll("automations")).toEqual([]);
    expect(JSON.stringify(received)).not.toMatch(/private-a|private-b|secret-destinations|destinationChoice|destinationPosition|zone-graph/);
    const {client:late}=await h.addPlayer(PLAYER_ID,"Rex",{lastSeq:before});
    expect(late.store.get("scenes","s1")?.tiles.find((t)=>t._id==="zone")).toMatchObject(expected);expect(draws).toBe(3);
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();expect(draws).toBe(3);
    expect(late.store.get("scenes","s1")?.tiles.find((t)=>t._id==="zone")?.x).toBe(100);
    definition.steps.push({id:"overflow",kind:"sceneLighting",mode:"add",darkness:1});
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const seq=h.hostStore.seq;player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq);expect(draws).toBe(6);expect(h.hostStore.get("scenes","s1")?.darkness).toBe(0);
    expect(h.hostStore.get("automations","zone-graph")?.state?.count??0).toBe(0);
  });

  test("Move live tag destinations are private, unique at execution, atomic and undoable from player clicks",async()=>{
    const h=await setup();await seedZone(h);
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["click","manual"],gates:{playerRunnable:true},steps:[
      {id:"light",kind:"sceneLighting",mode:"set",darkness:0.5},
      {id:"self",kind:"select",selector:{kind:"tile"}},
      {id:"move",kind:"move",destinationTag:{kind:"tag",query:"private-destination",collections:["tiles"]},x:25,y:-25,targets:"current",durationMs:500},
    ]};
    // Live queries can be published before their targets exist; execution cannot silently succeed.
    const published=h.hostStore.seq;
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(published+1);
    const {client:player}=await h.addPlayer(PLAYER_ID,"Rex");
    const rejected=async()=>{const seq=h.hostStore.seq;player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();
      expect(h.hostStore.seq).toBe(seq);expect(h.hostStore.get("scenes","s1")?.darkness).toBe(0);};
    await rejected();
    const destination:TileDocument={...zoneTile(),_id:"private-anchor",x:400,y:400,hidden:true,taggerTags:["private-destination"]};
    h.gm.submit([{kind:"create",coll:"tiles",parent:{coll:"scenes",id:"s1"},data:destination}]);await flushMicrotasks();
    const seq=h.hostStore.seq;
    player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq+1);
    expect(player.store.get("scenes","s1")?.tiles.find((tile)=>tile._id==="zone"))
      .toMatchObject({x:425,y:375,flags:{arenaMove:{x:425,y:375,durationMs:500}}});
    expect(player.store.getAll("automations")).toEqual([]);
    expect(player.store.get("scenes","s1")?.tiles.some((tile)=>tile._id===destination._id)).toBe(false);
    expect(JSON.stringify(player.store.world)).not.toContain("private-destination");
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();
    expect(player.store.get("scenes","s1")?.tiles.find((tile)=>tile._id==="zone")?.x).toBe(zoneTile().x);
    h.gm.submit([{kind:"create",coll:"tiles",parent:{coll:"scenes",id:"s1"},data:{...destination,_id:"duplicate-anchor"}}]);await flushMicrotasks();
    await rejected();
    h.gm.submit([{kind:"delete",ref:{coll:"tiles",id:"duplicate-anchor",parent:{coll:"scenes",id:"s1"}}},
      {kind:"update",ref:{coll:"tiles",id:"private-anchor",parent:{coll:"scenes",id:"s1"}},diff:{taggerTags:[]}}]);await flushMicrotasks();
    await rejected();
  });

  test("Move destination publication and runtime checks preserve private anchors and atomicity", async () => {
    const h=await setup();await seedZone(h);
    const destination:TileDocument={...zoneTile(),_id:"private-destination",x:400,y:400,hidden:true};
    h.gm.submit([{kind:"create",coll:"tiles",parent:{coll:"scenes",id:"s1"},data:destination}]);await flushMicrotasks();
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["click","manual"],gates:{playerRunnable:true},steps:[
      {id:"light",kind:"sceneLighting",mode:"set",darkness:0.5},
      {id:"sel",kind:"select",selector:{kind:"tile"}},
      {id:"move",kind:"move",destination:{coll:"tiles",id:"missing"},x:25,y:-25,targets:"current"},
    ]};
    const before=h.hostStore.seq;
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);
    const move=definition.steps[2];if(move?.kind!=="move"||!move.destination)throw new Error("missing move");move.destination.id=destination._id;
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player}=await h.addPlayer(PLAYER_ID,"Rex");
    player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before+2);
    expect(player.store.get("scenes","s1")?.tiles.find((t)=>t._id==="zone"))
      .toMatchObject({x:400+destination.width/2+25-zoneTile().width/2,y:400+destination.height/2-25-zoneTile().height/2});
    expect(player.store.get("scenes","s1")?.tiles.some((t)=>t._id===destination._id)).toBe(false);
    expect(player.store.getAll("automations")).toEqual([]);
    expect(h.host.undo().ok).toBe(true);await flushMicrotasks();
    expect(player.store.get("scenes","s1")?.tiles.find((t)=>t._id==="zone")?.x).toBe(zoneTile().x);
    h.gm.submit([{kind:"delete",ref:{coll:"tiles",id:destination._id,parent:{coll:"scenes",id:"s1"}}}]);await flushMicrotasks();
    const seq=h.hostStore.seq;
    h.gm.requestAutomation("zone-graph","s1","manual","t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq);expect(h.hostStore.get("scenes","s1")?.darkness).toBe(0);
  });

  test("published tile image lists cycle on host, grant only displayed art, and restore via undo/catch-up", async () => {
    const first = "a".repeat(64), second = "b".repeat(64);
    const h = await setup({
      [first]: { name: "first.png", mime: "image/png", size: 8, chunks: 1 },
      [second]: { name: "second.png", mime: "image/png", size: 8, chunks: 1 },
    });
    await seedZone(h);
    const def: AutomationDefinition = { ...zoneDoc().definition, methods: ["manual", "click"], gates: { playerRunnable: true }, steps: [
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "cycle", kind: "tileImage", images: [first, second], selection: "next" },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    expect(player.store.world.assetManifest[first]).toBeUndefined();
    expect(player.store.world.assetManifest[second]).toBeUndefined();
    const before = h.hostStore.seq;
    const image = () => h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone")?.img;
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl", true); await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before); expect(image()).toBe("");
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl"); await flushMicrotasks();
    expect(image()).toBe(first); expect(h.hostStore.seq).toBe(before + 1);
    expect(player.store.world.assetManifest[first]).toBeDefined(); expect(player.store.world.assetManifest[second]).toBeUndefined();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl"); await flushMicrotasks();
    expect(image()).toBe(second); expect(h.hostStore.seq).toBe(before + 2);
    expect(player.store.world.assetManifest[first]).toBeUndefined(); expect(player.store.world.assetManifest[second]).toBeDefined();
    const { client: rejoined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(rejoined.store.world.assetManifest[first]).toBeUndefined(); expect(rejoined.store.world.assetManifest[second]).toBeDefined();
    expect(rejoined.store.getAll("automations")).toEqual([]);
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks();
    expect(image()).toBe(first);
    expect(rejoined.store.world.assetManifest[first]).toBeDefined(); expect(rejoined.store.world.assetManifest[second]).toBeUndefined();
    expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBe(1);
  });

  test.each(["numbers", "formula"] as const)("host executes private %s image selectors and rejects invalid formula results atomically", async (selection) => {
    const first = "a".repeat(64), second = "b".repeat(64);
    const h = await setup({
      [first]: { name: "first.png", mime: "image/png", size: 8, chunks: 1 },
      [second]: { name: "second.png", mime: "image/png", size: 8, chunks: 1 },
    });
    await seedZone(h);
    const def: AutomationDefinition = { ...zoneDoc().definition, steps: [
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "image", kind: "tileImage", images: [first, second], selection,
        ...(selection === "numbers" ? { numbers: "[2]" } : { formula: "1d1 + 1" }) },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const before = h.hostStore.seq;
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl"); await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect(h.hostStore.get("scenes", "s1")?.tiles.find((tile) => tile._id === "zone")?.img).toBe(second);
    expect(player.store.world.assetManifest[first]).toBeUndefined(); expect(player.store.world.assetManifest[second]).toBeDefined();
    expect(player.store.getAll("automations")).toEqual([]);
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks();
    expect(player.store.world.assetManifest[second]).toBeUndefined();
    const invalid: AutomationDefinition = { ...def, steps: [
      { id: "light", kind: "sceneLighting", mode: "set", darkness: 0.9 },
      { id: "sel", kind: "select", selector: { kind: "tile" } }, { id: "bad", kind: "tileImage", images: [first, second], selection: "formula", formula: "1d1 + 2" },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: invalid as unknown as Json } }]);
    await flushMicrotasks();
    const seq = h.hostStore.seq, scene = structuredClone(h.hostStore.get("scenes", "s1"));
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl"); await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq); expect(h.hostStore.get("scenes", "s1")).toEqual(scene);
  });

  test("all image-list alternatives are revalidated at publication and execution, not only the chosen first image", async () => {
    const first = "a".repeat(64), second = "b".repeat(64);
    const assets: AssetManifest = {
      [first]: { name: "first.png", mime: "image/png", size: 8, chunks: 1 },
      [second]: { name: "second.png", mime: "image/png", size: 8, chunks: 1, visibility: "gm" },
    };
    const h = await setup(assets); await seedZone(h);
    const rejected: ClientEvents["rejected"][] = []; h.gmBus.on("rejected", (msg) => rejected.push(msg));
    const def: AutomationDefinition = { ...zoneDoc().definition, steps: [
      { id: "light", kind: "sceneLighting", mode: "set", darkness: 0.5 },
      { id: "sel", kind: "select", selector: { kind: "tile" } },
      { id: "cycle", kind: "tileImage", images: [first, second], selection: "first" },
    ] };
    const save = () => h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } }]);
    save(); await flushMicrotasks(); expect(rejected.at(-1)?.detail).toMatch(/GM-only/);
    const alternative = assets[second]; if (!alternative) throw new Error("fixture missing");
    alternative.visibility = "referenced"; save(); await flushMicrotasks();
    expect(h.hostStore.get("automations", "zone-graph")?.definition.steps).toEqual(def.steps);
    alternative.visibility = "gm";
    const before = h.hostStore.seq;
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl"); await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);
    expect(h.hostStore.get("scenes", "s1")?.darkness).toBe(0);
    expect(h.hostStore.get("automations", "zone-graph")?.state).toBeUndefined();
  });

  test("a published player trigger can change an authorized remote background without exposing the private scene or graph", async () => {
    const hash = "a".repeat(64);
    const h = await setup({ [hash]: { name: "private-map.png", mime: "image/png", size: 8, chunks: 1 } });
    await seedZone(h);
    const source = h.hostStore.get("scenes", "s1");
    if (!source) throw new Error("missing fixture scene");
    const remote = { ...structuredClone(source), _id: "remote", name: "Secret room",
      active: false, ownership: { default: 0 as const }, tokens: [], tiles: [] };
    h.gm.submit([{ kind: "create", coll: "scenes", data: remote }]); await flushMicrotasks();
    const def: AutomationDefinition = { ...zoneDoc().definition, methods: ["click", "manual"], gates: { playerRunnable: true }, steps: [
      { id: "light", kind: "sceneLighting", mode: "set", darkness: 0.5 },
      { id: "bg", kind: "sceneBackground", image: hash, targetSceneId: "remote" },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const received: ClientEvents["ops"][] = []; bus.on("ops", (msg) => received.push(msg));
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl"); await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect(h.hostStore.get("scenes", "remote")).toMatchObject({ img: hash, active: false });
    expect(h.hostStore.get("scenes", "s1")).toMatchObject({ img: null, darkness: 0.5 });
    expect(player.store.get("scenes", "remote")).toBeUndefined();
    expect(player.store.world.assetManifest[hash]).toBeUndefined();
    expect(JSON.stringify(received)).not.toMatch(/Secret room|targetSceneId|zone-graph|private-map/);
    const { client: rejoined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(rejoined.store.get("scenes", "remote")).toBeUndefined();
    expect(rejoined.store.world.assetManifest[hash]).toBeUndefined();
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks();
    expect(h.hostStore.get("scenes", "remote")?.img).toBeNull();
    expect(h.hostStore.get("scenes", "s1")?.darkness).toBe(0);
    expect(h.hostStore.get("automations", "zone-graph")?.state).toBeUndefined();
    h.gm.submit([{ kind: "delete", ref: { coll: "scenes", id: "remote" } }]); await flushMicrotasks();
    const afterDelete = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl"); await flushMicrotasks();
    expect(h.hostStore.seq).toBe(afterDelete); expect(h.hostStore.get("scenes", "s1")?.darkness).toBe(0);
    const rejected: ClientEvents["rejected"][] = []; h.gmBus.on("rejected", (msg) => rejected.push(msg));
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks(); expect(rejected.at(-1)?.detail).toMatch(/target scene is unavailable/);
  });

  test("appearance media is checked at publication and rechecked on nested execution before any writes", async () => {
    const hash = "a".repeat(64);
    const assets: AssetManifest = { [hash]: { name: "scene.png", mime: "image/png", size: 8, chunks: 1, visibility: "gm" } };
    const h = await setup(assets); await seedZone(h);
    const rejected: ClientEvents["rejected"][] = [], traces: ClientEvents["automationTrace"][] = [];
    h.gmBus.on("rejected", (msg) => rejected.push(msg)); h.gmBus.on("automationTrace", (msg) => traces.push(msg));
    const child: AutomationDocument = { ...zoneDoc(), _id: "appearance-child", definition: {
      ...zoneDoc().definition, tileId: "child", methods: ["manual"], gates: {},
      steps: [{ id: "image", kind: "sceneBackground", image: hash }],
    } };
    h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: { ...zoneTile(), _id: "child", hidden: true } as TileDocument }]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "create", coll: "automations", data: child }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.detail).toMatch(/GM-only/);
    expect(h.hostStore.get("automations", child._id)).toBeUndefined();
    const asset = assets[hash];
    if (!asset) throw new Error("missing image fixture");
    asset.visibility = "referenced";
    h.gm.submit([{ kind: "create", coll: "automations", data: child }]);
    await flushMicrotasks();
    expect(h.hostStore.get("automations", child._id)).toBeDefined();
    const parent: AutomationDefinition = { ...zoneDoc().definition, gates: {}, steps: [
      { id: "light", kind: "sceneLighting", mode: "set", darkness: 0.5 },
      { id: "chat", kind: "chat", audience: "scene", content: "No partial write" },
      { id: "child", kind: "triggerTile", target: { kind: "id", tileId: "child" }, tokens: "triggering" },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: parent as unknown as Json } }]);
    await flushMicrotasks();
    const before = h.hostStore.seq;
    asset.visibility = "gm";
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl"); await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);
    expect(traces.at(-1)).toMatchObject({ result: "rejected", detail: expect.stringMatching(/GM-only/) });
    expect(h.hostStore.get("scenes", "s1")).toMatchObject({ darkness: 0, img: null });
    expect(h.hostStore.getAll("messages")).toHaveLength(0);
    expect(h.hostStore.get("automations", "zone-graph")?.state).toBeUndefined();
    expect(h.hostStore.get("automations", child._id)?.state).toBeUndefined();
    Reflect.deleteProperty(assets, hash);
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl"); await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);
    expect(traces.at(-1)?.detail).toMatch(/missing/);
  });

  test("player click activates a concealed tagged tile graph and invokes it atomically, without projecting its gate", async () => {
    const h = await setup(); await seedZone(h);
    const relay: TileDocument = { ...zoneTile(), _id: "relay", name: "Hidden relay",
      x: 400, hidden: true, taggerTags: ["locked-relay"] };
    const child: AutomationDocument = { ...zoneDoc(), _id: "relay-graph", name: "Private relay",
      definition: { ...zoneDoc().definition, tileId: "relay", methods: ["manual"],
        gates: { paused: true }, steps: [
          { id: "private", kind: "chat", audience: "gm", content: "Only the GM can see this" },
        ] } };
    h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: relay }]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "create", coll: "automations", data: child },
      { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
        definition: { ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true }, steps: [
          { id: "wake", kind: "setActive", mode: "activate", target: { kind: "tag", query: "locked-relay" } },
          { id: "relay", kind: "triggerTile", target: { kind: "tag", query: "locked-relay" },
            tokens: "triggering" },
          { id: "public", kind: "chat", audience: "scene", content: "Gate unlocked" },
        ] } as unknown as Json,
      } },
    ]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const { client: spectator, bus: spectatorBus } = await h.addPlayer(OTHER_ID, "Ivy");
    const packets: ClientEvents["ops"][] = [];
    const spectatorOps: ClientEvents["ops"][] = [];
    const rejected: ClientEvents["rejected"][] = [];
    spectatorBus.on("ops", (msg) => spectatorOps.push(msg));
    bus.on("ops", (msg) => packets.push(msg));
    bus.on("rejected", (msg) => rejected.push(msg));
    expect(player.store.getAll("automations")).toEqual([]);
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.map((t) => t._id)).toEqual(["zone"]);
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    const ops = h.hostLog.at(h.hostStore.seq)?.env.ops ?? [];
    expect(ops.filter((op) => op.kind === "update" && op.ref.coll === "automations"))
      .toMatchObject([
        { ref: { id: "zone-graph" }, diff: { state: { count: 1 } } },
        { ref: { id: "relay-graph" }, diff: { definition: { gates: { paused: false } },
          state: { count: 1 } } },
      ]);
    expect((h.hostStore.get("automations", "relay-graph") as AutomationDocument).definition.gates?.paused)
      .toBe(false);
    expect(h.hostStore.getAll("messages").map((m) => m.content))
      .toEqual(["Only the GM can see this", "Gate unlocked"]);
    const privateMessageId = h.hostStore.getAll("messages")[0]?._id;
    expect(privateMessageId).toBeDefined();
    expect(player.store.getAll("messages").map((m) => m.content)).toEqual(["Gate unlocked"]);
    expect(spectator.store.getAll("messages").map((m) => m.content)).toEqual(["Gate unlocked"]);
    expect(JSON.stringify(packets)).not.toMatch(/relay-graph|locked-relay|paused|Only the GM/);
    player.submit([{ kind: "update", ref: { coll: "automations", id: "relay-graph" },
      diff: { definition: { ...child.definition, gates: { paused: true } } as unknown as Json } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    const { client: rejoined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(rejoined.store.getAll("automations")).toEqual([]);
    expect(JSON.stringify(rejoined.store.world)).not.toMatch(/relay-graph|locked-relay|Only the GM/);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "relay-graph") as AutomationDocument).definition.gates?.paused)
      .toBe(true);
    expect((h.hostStore.get("automations", "relay-graph") as AutomationDocument).state).toBeUndefined();
    expect(h.hostStore.getAll("messages")).toHaveLength(0);
    expect(spectator.store.getAll("messages")).toHaveLength(0);
    expect(rejoined.store.getAll("messages")).toHaveLength(0);
    expect(spectatorOps.at(-1)?.envelope.ops).toHaveLength(1); // only the public delete
    expect(JSON.stringify(spectatorOps)).not.toContain(privateMessageId);
    expect(JSON.stringify(packets)).not.toContain("Only the GM can see this");
  });

  test("a self-deactivating graph can still execute its reviewed post-commit script once", async () => {
    let runs = 0;
    const h = await setup({}, async (_source, _args, context) => {
      expect(context.callerId).toBe(PLAYER_ID);
      runs++;
      return { acknowledged: true };
    });
    await seedZone(h);
    const script = await reviewedScript({ inputs: [] });
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true }, steps: [
        { id: "pause", kind: "setActive", mode: "deactivate", target: { kind: "id", tileId: "zone" } },
        { id: "code", kind: "script", macroId: script._id },
      ] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("post-commit script timed out")); }, 3000);
      const off = h.gmBus.on("automationTrace", (msg) => {
        if (!msg.detail.includes("post-commit scripts completed")) return;
        clearTimeout(timer); off(); resolve();
      });
    });
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await finished;
    expect(runs).toBe(1);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).definition.gates?.paused)
      .toBe(true);
    const after = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(runs).toBe(1);
    expect(h.hostStore.seq).toBe(after);
  });

  test("a player-fired graph sets a concealed relay's variables via staged tags before invoking it in one undoable envelope", async () => {
    const h = await setup(); await seedZone(h);
    const relay: TileDocument = { ...zoneTile(), _id: "relay", x: 400, hidden: true, taggerTags: ["relay"] };
    const child: AutomationDocument = { ...zoneDoc(), _id: "relay-graph", name: "Private variable relay",
      definition: { ...zoneDoc().definition, tileId: "relay", methods: ["manual"], gates: {}, steps: [
        { id: "check", kind: "checkVariable", name: "charge", compare: "eq", value: 3 },
        { id: "notice", kind: "chat", audience: "gm", content: "Charged relay {{charge}}" },
      ] } };
    h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: relay }]);
    await flushMicrotasks();
    h.gm.submit([
      { kind: "create", coll: "automations", data: child },
      { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: {
        ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true }, steps: [
          { id: "find", kind: "select", selector: { kind: "tag", query: "relay", collections: ["tiles"] } },
          { id: "seed", kind: "set", scope: "tile", name: "charge", value: 1, target: { kind: "current" } },
          { id: "mark", kind: "tags", edit: "add", tags: ["awake"] },
          { id: "increment", kind: "set", scope: "tile", name: "charge", operation: "add", value: 2,
            target: { kind: "tag", query: "awake" } },
          { id: "check-relay", kind: "checkVariable", name: "charge", compare: "gte", value: 3,
            target: { kind: "tag", query: "awake" }, mode: "all" },
          { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "relay" }, tokens: "triggering" },
        ],
      } as unknown as Json } },
    ]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const traces: ClientEvents["automationTrace"][] = [], broadcasts: ClientEvents["ops"][] = [];
    bus.on("automationTrace", (message) => traces.push(message));
    bus.on("ops", (message) => broadcasts.push(message));
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.map((t) => t._id)).not.toContain("relay");
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect((h.hostStore.get("automations", "relay-graph") as AutomationDocument).state)
      .toMatchObject({ count: 1, variables: { charge: 3 } });
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles.find((t) => t._id === "relay")?.taggerTags)
      .toEqual(["relay", "awake"]);
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["Charged relay 3"]);
    expect(player.store.getAll("automations")).toEqual([]);
    expect(player.store.getAll("messages")).toEqual([]);
    expect(traces).toEqual([]);
    expect(JSON.stringify(broadcasts)).not.toContain("charge");
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    expect((h.hostStore.get("automations", "relay-graph") as AutomationDocument).state).toBeUndefined();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles.find((t) => t._id === "relay")?.taggerTags)
      .toEqual(["relay"]);
    expect(h.hostStore.getAll("messages")).toEqual([]);
  });

  test("Check Value uses committed darkness and host-observed movement, never a click's forged direction", async () => {
    const h = await setup(); await seedZone(h);
    const definition: AutomationDefinition = { ...zoneDoc().definition,
      methods: ["click", "enter"], gates: { playerRunnable: true }, steps: [
        { id: "dark", kind: "checkValue", source: "darkness", compare: "gte", value: 0.7,
          otherwise: "failed" },
        { id: "right", kind: "checkValue", source: "direction.x", compare: "eq", value: "right",
          otherwise: "failed" },
        { id: "pass", kind: "chat", audience: "gm", content: "entered from the left at night" },
        { id: "stop", kind: "stop" },
        { id: "failed", kind: "landing", name: "failed" },
        { id: "notice", kind: "chat", audience: "gm", content: "not a rightward night crossing" },
      ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: definition as unknown as Json } },
    { kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { darkness: 0.8 } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const hiddenTraces: ClientEvents["automationTrace"][] = [];
    bus.on("automationTrace", (msg) => hiddenTraces.push(msg));
    // A player cannot inject a direction into the click protocol. The host
    // refuses extra fields before planning a private graph.
    const pair = createTransportPair();
    h.host.addSession("forged-direction", pair.a, { id: PLAYER_ID, role: "PLAYER", name: "Rex" });
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("rejected", (msg) => rejected.push(msg));
    const seq = h.hostStore.seq;
    pair.b.send("ops", frameMessage({ kind: "automation.click", requestId: "direction-forgery",
      sceneId: "s1", tileId: "zone", point: { x: 150, y: 150 }, tokenId: "t-pl",
      direction: { x: "right" } } as unknown as import("../../src/core/messages").AutomationClickMsg));
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq);
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["not a rightward night crossing"]);
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 160, y: 160 } }]);
    await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual([
      "not a rightward night crossing", "entered from the left at night",
    ]);
    expect(player.store.getAll("messages")).toEqual([]);
    expect(hiddenTraces).toEqual([]);
    h.gm.submit([{ kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { darkness: 0.2 } }]);
    await flushMicrotasks();
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 0, y: 0 } }]);
    await flushMicrotasks();
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 160, y: 160 } }]);
    await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((m) => m.content).at(-1))
      .toBe("not a rightward night crossing");
    expect(rejected).toEqual([]);
    h.host.removeSession("forged-direction");
  });

  test("player and GM triggers filter selected tokens by each token's live private trigger count", async () => {
    const h = await setup(); await seedZone(h);
    const def: AutomationDefinition = { ...zoneDoc().definition, methods: ["click", "manual"],
      gates: { playerRunnable: true }, steps: [
        { id: "watch", kind: "select", selector: { kind: "tag", query: "watch", collections: ["tokens"] } },
        { id: "count", kind: "tokenTriggerCount", compare: "eq", count: 1 },
        { id: "mark", kind: "tags", edit: "add", tags: ["first-fired"] },
        { id: "note", kind: "chat", audience: "gm", content: "private token history" },
      ] };
    h.gm.submit([
      { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: def as unknown as Json } },
      { kind: "update", ref: tokenRef, diff: { taggerTags: ["watch"] } },
      { kind: "update", ref: { coll: "tokens", id: "t-ivy", parent: { coll: "scenes", id: "s1" } },
        diff: { taggerTags: ["watch"] } },
    ]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const playerTraces: ClientEvents["automationTrace"][] = [];
    const gmTraces: ClientEvents["automationTrace"][] = [];
    bus.on("automationTrace", (msg) => playerTraces.push(msg));
    h.gmBus.on("automationTrace", (msg) => gmTraces.push(msg));
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect((h.hostStore.resolve(tokenRef) as TokenDocument).taggerTags).toEqual(["watch", "first-fired"]);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["watch"]);
    expect(gmTraces.at(-1)?.trace).toContain("token trigger count filter: 1 matching token(s), including this fire");
    expect(player.store.getAll("automations")).toEqual([]);
    expect(playerTraces).toEqual([]);
    const afterPlayer = h.hostStore.seq;
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-ivy");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(afterPlayer + 1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["watch", "first-fired"]);
    expect(gmTraces.at(-1)?.trace).toContain("token trigger count filter: 2 matching token(s), including this fire");
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["watch"]);
    expect((player.store.resolve(tokenRef) as TokenDocument).taggerTags).toEqual(["watch", "first-fired"]);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.byToken["t-ivy"]).toBeUndefined();
  });

  test("Check Data branches on the committed private tile, not the token collection or player click payload", async () => {
    const h = await setup(); await seedZone(h);
    const definition: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"],
      gates: { playerRunnable: true }, steps: [
        { id: "current", kind: "select", selector: { kind: "triggering" } },
        { id: "check", kind: "checkData", path: "width", compare: "gte", value: 200,
          otherwise: "small" },
        { id: "pass", kind: "chat", audience: "gm", content: "wide tile" },
        { id: "stop", kind: "stop" },
        { id: "small", kind: "landing", name: "small" },
        { id: "fail", kind: "chat", audience: "gm", content: "narrow tile" },
      ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: definition as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const hiddenTraces: ClientEvents["automationTrace"][] = [];
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("automationTrace", (msg) => hiddenTraces.push(msg));
    bus.on("rejected", (msg) => rejected.push(msg));
    const seq = h.hostStore.seq;
    // The public click protocol never accepts a tile attribute or steps.
    const pair = createTransportPair();
    h.host.addSession("forged-check-data", pair.a, { id: PLAYER_ID, role: "PLAYER", name: "Rex" });
    pair.b.send("ops", frameMessage({ kind: "automation.click", requestId: "forged-tile-width",
      sceneId: "s1", tileId: "zone", point: { x: 150, y: 150 }, tokenId: "t-pl", width: 300,
    } as unknown as import("../../src/core/messages").AutomationClickMsg));
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq);
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["wide tile"]);
    h.gm.submit([{ kind: "update", ref: { coll: "tiles", id: "zone", parent: { coll: "scenes", id: "s1" } },
      diff: { width: 150 } }]);
    await flushMicrotasks();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["wide tile", "narrow tile"]);
    expect(hiddenTraces).toEqual([]);
    expect(player.store.getAll("automations")).toEqual([]);
    expect(player.store.getAll("messages")).toEqual([]);
    expect(rejected).toEqual([]);
    h.host.removeSession("forged-check-data");
    expect(h.host.undo().ok).toBe(true); // one graph envelope, no partial branch
    await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["wide tile"]);
  });

  test.each([false, true])("published Game Time click creates an undoable replicated clock (formula %s) and stages later time checks", async (formula) => {
    const h = await setup(); await seedZone(h);
    const definition: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"],
      gates: { playerRunnable: true }, steps: [
        { id: "advance", kind: "gameTime", ...(formula ? { formula: "1d1 * 60 + 30" } : { minutes: 90 }) },
        { id: "clock", kind: "checkValue", source: "time", compare: "eq", value: 90 },
        { id: "gm", kind: "chat", audience: "gm", content: "Clock set by approved zone" },
      ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: definition as unknown as Json } }]);
    await flushMicrotasks();
    expect(h.hostStore.get("settings", "world-settings")).toBeUndefined();
    const beforePreview = h.hostStore.seq;
    h.gm.requestAutomation("zone-graph", "s1", "click", "t-pl", true);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(beforePreview);
    expect(h.hostStore.get("settings", "world-settings")).toBeUndefined();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const hiddenTraces: ClientEvents["automationTrace"][] = [];
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("automationTrace", (msg) => hiddenTraces.push(msg));
    bus.on("rejected", (msg) => rejected.push(msg));
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect(h.hostLog.since(before)[0]?.ops.filter((op) => op.kind === "create" && op.coll === "settings"))
      .toMatchObject([{ data: { system: { clockSeconds: 5400 } } }]);
    expect(h.hostStore.get("settings", "world-settings")?.system.clockSeconds).toBe(5400);
    expect(player.store.get("settings", "world-settings")?.system.clockSeconds).toBe(5400);
    expect(h.hostStore.getAll("messages").map((msg) => msg.content)).toEqual(["Clock set by approved zone"]);
    expect(player.store.getAll("messages")).toEqual([]);
    expect(player.store.getAll("automations")).toEqual([]);
    expect(hiddenTraces).toEqual([]);
    player.submit([{ kind: "update", ref: { coll: "settings", id: "world-settings" },
      diff: { "system.clockSeconds": 99_999 } }]);
    await flushMicrotasks();
    expect(rejected.some((msg) => msg.reason === "forbidden")).toBe(true);
    expect(h.hostStore.seq).toBe(before + 1);
    // Reconnecting the same user replaces their old in-memory peer session.
    const { client: late } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(late.store.get("settings", "world-settings")?.system.clockSeconds).toBe(5400);
    expect(late.store.getAll("automations")).toEqual([]);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(h.hostStore.get("settings", "world-settings")).toBeUndefined();
    expect(late.store.get("settings", "world-settings")).toBeUndefined();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count ?? 0).toBe(0);
    expect(h.hostStore.getAll("messages")).toEqual([]);

    const broken: AutomationDefinition = { ...definition, steps: [
      { id: "advance", kind: "gameTime", ...(formula ? { formula: "1d1 * 60 + 30" } : { minutes: 90 }) },
      { id: "select", kind: "select", selector: { kind: "tile" } },
      { id: "invalid", kind: "door", mode: "open" },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: broken as unknown as Json } }]);
    await flushMicrotasks();
    const prior = h.hostStore.seq;
    late.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(prior); // no partial clock/history on later failure
    expect(h.hostStore.get("settings", "world-settings")).toBeUndefined();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count ?? 0).toBe(0);
    expect(late.store.getAll("messages")).toEqual([]);
  });

  test("child tile checks and advances the same staged Game Time clock without leaking its graph", async () => {
    const h = await setup(); await seedZone(h);
    const relay: TileDocument = { ...zoneTile(), _id: "clock-relay", name: "Hidden clock relay",
      x: 360, hidden: true };
    const child: AutomationDocument = { ...zoneDoc(), _id: "clock-child", name: "Private clock hand",
      definition: { ...zoneDoc().definition, tileId: relay._id, methods: ["manual"], gates: {}, steps: [
        { id: "at-five", kind: "checkValue", source: "time", compare: "eq", value: 5 },
        { id: "advance-again", kind: "gameTime", minutes: 5 },
      ] } };
    const parent: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"],
      gates: { playerRunnable: true }, steps: [
        { id: "advance", kind: "gameTime", minutes: 5 },
        { id: "relay", kind: "triggerTile", target: { kind: "id", tileId: relay._id }, tokens: "triggering" },
        { id: "ten", kind: "checkValue", source: "time", compare: "eq", value: 10 },
        { id: "done", kind: "chat", audience: "gm", content: "Clock hand reached ten" },
      ] };
    h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: relay }]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "create", coll: "automations", data: child },
      { kind: "update", ref: { coll: "automations", id: "zone-graph" },
        diff: { definition: parent as unknown as Json } }]);
    await flushMicrotasks();
    expect(h.hostStore.get("automations", child._id)).toBeDefined();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect(h.hostLog.since(before)[0]?.ops.filter((op) => op.kind === "create" && op.coll === "settings"))
      .toMatchObject([{ data: { system: { clockSeconds: 600 } } }]);
    expect((h.hostStore.get("automations", child._id) as AutomationDocument).state?.count).toBe(1);
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["Clock hand reached ten"]);
    expect(player.store.get("settings", "world-settings")?.system.clockSeconds).toBe(600);
    expect(player.store.getAll("automations")).toEqual([]);
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.map((t) => t._id)).not.toContain(relay._id);
    expect(player.store.getAll("messages")).toEqual([]);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(h.hostStore.get("settings", "world-settings")).toBeUndefined();
    expect(player.store.get("settings", "world-settings")).toBeUndefined();
    expect((h.hostStore.get("automations", child._id) as AutomationDocument).state).toBeUndefined();
  });

  test("Check Value time reads the committed GM world clock, not a player's claimed clock", async () => {
    const h = await setup(); await seedZone(h);
    const definition: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"],
      gates: { playerRunnable: true }, steps: [
        { id: "clock", kind: "checkValue", source: "time", compare: "gte", value: 60,
          otherwise: "early" },
        { id: "pass", kind: "chat", audience: "gm", content: "after one" },
        { id: "stop", kind: "stop" },
        { id: "early", kind: "landing", name: "early" },
        { id: "fail", kind: "chat", audience: "gm", content: "before one" },
      ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: definition as unknown as Json } },
    { kind: "create", coll: "settings", data: worldSettingsDoc({ clockSeconds: 0 }) }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    const hiddenTraces: ClientEvents["automationTrace"][] = [];
    bus.on("rejected", (msg) => rejected.push(msg));
    bus.on("automationTrace", (msg) => hiddenTraces.push(msg));
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["before one"]);
    const afterClick = h.hostStore.seq;
    player.submit([{ kind: "update", ref: { coll: "settings", id: "world-settings" },
      diff: { "system.clockSeconds": 3600 } }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(afterClick);
    expect(rejected.some((msg) => msg.reason === "forbidden")).toBe(true);
    expect(h.hostStore.get("settings", "world-settings")?.system.clockSeconds).toBe(0);
    h.gm.submit([{ kind: "update", ref: { coll: "settings", id: "world-settings" },
      diff: { "system.clockSeconds": 3600 } }]);
    await flushMicrotasks();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["before one", "after one"]);
    expect(player.store.getAll("messages")).toEqual([]);
    expect(player.store.getAll("automations")).toEqual([]);
    expect(hiddenTraces).toEqual([]);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["before one"]);
    expect(h.hostStore.get("settings", "world-settings")?.system.clockSeconds).toBe(3600);
  });

  test("player-triggered variable deletion is private, atomic, undoable and absent on catch-up", async () => {
    const h = await setup(); await seedZone(h);
    const def: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true }, steps: [
      { id: "erase", kind: "set", name: "privateCharge", scope: "tile", operation: "delete" },
      { id: "check", kind: "checkVariable", name: "privateCharge", compare: "eq", value: null },
      { id: "notice", kind: "chat", audience: "scene", content: "Disarmed" },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: def as unknown as Json,
      state: { count: 4, lastAt: 0, byToken: {}, variables: { privateCharge: 9, keep: true } },
    } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const received: ClientEvents["ops"][] = [];
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("ops", (msg) => received.push(msg)); bus.on("rejected", (msg) => rejected.push(msg));
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    const state = () => (h.hostStore.get("automations", "zone-graph") as AutomationDocument).state;
    expect(h.hostStore.seq).toBe(before + 1);
    expect(state()?.variables).toEqual({ keep: true });
    expect(state()?.count).toBe(5);
    expect(player.store.getAll("messages").map((m) => m.content)).toEqual(["Disarmed"]);
    expect(player.store.getAll("automations")).toEqual([]);
    expect(JSON.stringify(received)).not.toMatch(/privateCharge|erase|variables/);
    player.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      "-=state.variables.keep": null,
    } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect(state()?.variables).toEqual({ keep: true });
    const { client: joined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(joined.store.getAll("automations")).toEqual([]);
    expect(joined.store.getAll("messages").map((m) => m.content)).toEqual(["Disarmed"]);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(state()?.variables).toEqual({ privateCharge: 9, keep: true });
    expect(state()?.count).toBe(4);
    expect(joined.store.getAll("messages")).toHaveLength(0);
  });

  test("player click updates private tile variables atomically, survives catch-up and undoes one fire", async () => {
    const h = await setup(); await seedZone(h);
    const def: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"],
      gates: { playerRunnable: true }, steps: [
        { id: "counter", kind: "set", scope: "tile", operation: "add", name: "privateCount", value: 1 },
        { id: "second", kind: "filter", test: { kind: "variable", name: "privateCount", equals: 2 } },
        { id: "done", kind: "chat", audience: "scene", content: "Door opens on click {{privateCount}}" },
      ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const received: ClientEvents["ops"][] = [];
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("ops", (msg) => received.push(msg));
    bus.on("rejected", (msg) => rejected.push(msg));
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state)
      .toMatchObject({ count: 1, variables: { privateCount: 1 } });
    expect(player.store.getAll("automations")).toEqual([]);
    expect(h.hostStore.getAll("messages")).toHaveLength(0);
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 2);
    expect(h.hostLog.since(before + 1)[0]?.ops.filter((op) =>
      (op.kind === "create" ? op.coll : op.ref.coll) !== "actionReceipts")).toMatchObject([
      { kind: "update", ref: { coll: "automations", id: "zone-graph" },
        diff: { state: { count: 2, variables: { privateCount: 2 } } } },
      { kind: "create", coll: "messages", data: { content: "Door opens on click 2" } },
    ]);
    expect(player.store.getAll("messages").map((m) => m.content)).toEqual(["Door opens on click 2"]);
    // Only the intentionally public chat text, never private state/graph source, crosses the wire.
    expect(JSON.stringify(received)).not.toContain("privateCount");
    expect(JSON.stringify(received)).not.toContain("counter");
    const { client: joined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(joined.store.getAll("automations")).toEqual([]);
    expect(joined.store.getAll("messages").map((m) => m.content)).toEqual(["Door opens on click 2"]);
    player.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { state: { count: 0, lastAt: 0, byToken: {}, variables: { privateCount: 99 } } } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.variables)
      .toEqual({ privateCount: 2 });
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state)
      .toMatchObject({ count: 1, variables: { privateCount: 1 } });
    expect(h.hostStore.getAll("messages")).toHaveLength(0);
    expect(joined.store.getAll("messages")).toHaveLength(0); // reconnected session receives undo
  });

  test("a published click plans a hidden child graph atomically, projects/undoes both histories and rechecks assets", async () => {
    const secretArt = "f".repeat(64);
    const h = await setup({ [secretArt]: { name: "GM-relay.png", mime: "image/png", size: 5,
      chunks: 1, visibility: "referenced" } });
    await seedZone(h);
    const relay: TileDocument = { ...zoneTile(), _id: "relay", name: "Hidden relay", x: 360,
      hidden: true, img: secretArt, taggerTags: ["relay"] };
    const child: AutomationDocument = { ...zoneDoc(), _id: "relay-graph", name: "Secret relay",
      definition: { ...zoneDoc().definition, tileId: "relay", methods: ["manual"], gates: {}, steps: [
        { id: "find", kind: "select", selector: { kind: "tag", query: "parent-mark", collections: ["tokens"] } },
        { id: "mark", kind: "tags", edit: "add", tags: ["child-mark"] },
        { id: "hide", kind: "visibility", mode: "hide" },
        { id: "gm", kind: "chat", audience: "gm", content: "secret {{method}}/{{originMethod}}" },
        { id: "spark", kind: "sequence", macroId: "fx-plate", audience: "gm" },
      ] },
    };
    const parent: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"],
      gates: { playerRunnable: true }, steps: [
        { id: "select", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
        { id: "tag", kind: "tags", edit: "add", tags: ["parent-mark"] },
        { id: "call", kind: "triggerTile", target: { kind: "tag", query: "relay" }, tokens: "triggering" },
        { id: "public", kind: "chat", audience: "scene", content: "Rang" },
      ] };
    h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: relay }]);
    await flushMicrotasks();
    h.gm.submit([
      { kind: "create", coll: "automations", data: child },
      { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: parent as unknown as Json } },
    ]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const playerTraces: ClientEvents["automationTrace"][] = [];
    const gmTraces: ClientEvents["automationTrace"][] = [];
    const playerFx: ClientEvents["fx"][] = [];
    bus.on("automationTrace", (v) => playerTraces.push(v));
    bus.on("fx", (v) => playerFx.push(v));
    h.gmBus.on("automationTrace", (v) => gmTraces.push(v));
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    const envelope = h.hostLog.since(before);
    expect(envelope).toHaveLength(1);
    expect(envelope[0]?.ops.filter((op) => op.kind === "update" && op.ref.coll === "automations"))
      .toMatchObject([{ ref: { id: "zone-graph" } }, { ref: { id: "relay-graph" } }]);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect((h.hostStore.get("automations", "relay-graph") as AutomationDocument).state?.count).toBe(1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy"))
      .toMatchObject({ taggerTags: ["door-1", "parent-mark", "child-mark"], hidden: true });
    expect(player.store.getAll("automations")).toEqual([]);
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.map((t) => t._id)).not.toContain("relay");
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.map((t) => t._id)).not.toContain("t-ivy");
    expect(player.store.world.assetManifest[secretArt]).toBeUndefined();
    expect(player.store.getAll("messages").map((m) => m.content)).toEqual(["Rang"]);
    expect(playerTraces).toEqual([]);
    expect(playerFx).toEqual([]);
    expect(gmTraces.at(-1)).toMatchObject({ result: "committed",
      trace: expect.arrayContaining(["tile relay -> graph relay-graph [t-pl]"]) });
    const { client: rejoined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(rejoined.store.getAll("automations")).toEqual([]);
    expect(rejoined.store.getAll("messages").map((m) => m.content)).toEqual(["Rang"]);
    expect((rejoined.store.get("scenes", "s1") as SceneDocument).tiles.map((t) => t._id)).not.toContain("relay");
    expect((rejoined.store.get("scenes", "s1") as SceneDocument).tokens.map((t) => t._id)).not.toContain("t-ivy");
    expect(rejoined.store.world.assetManifest[secretArt]).toBeUndefined();
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    expect((h.hostStore.get("automations", "relay-graph") as AutomationDocument).state).toBeUndefined();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy"))
      .toMatchObject({ taggerTags: ["door-1"], hidden: false });
  });

  test("a nested tag-then-reveal grants one final projected tile and its asset; undo retracts both", async () => {
    const art = "a".repeat(64);
    const h = await setup({ [art]: { name: "relay.png", mime: "image/png", size: 5,
      chunks: 1, visibility: "referenced" } });
    await seedZone(h);
    h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" },
      data: { ...zoneTile(), _id: "relay", hidden: true, img: art } as TileDocument }]);
    await flushMicrotasks();
    h.gm.submit([
      { kind: "create", coll: "automations", data: { ...zoneDoc(), _id: "relay-graph", definition: {
        ...zoneDoc().definition, tileId: "relay", methods: ["manual"], gates: {}, steps: [
          { id: "select", kind: "select", selector: { kind: "tile" } },
          { id: "tag", kind: "tags", edit: "add", tags: ["revealed"] },
          { id: "show", kind: "visibility", mode: "show" },
        ],
      } } as AutomationDocument },
      { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: {
        ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true }, steps: [
          { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "relay" }, tokens: "triggering" },
        ],
      } as unknown as Json } },
    ]);
    await flushMicrotasks();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.map((t) => t._id)).not.toContain("relay");
    expect(player.store.world.assetManifest[art]).toBeUndefined();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(player.lastSeq).toBe(h.hostStore.seq);
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.filter((t) => t._id === "relay"))
      .toMatchObject([{ taggerTags: ["revealed"], hidden: false }]);
    expect(player.store.world.assetManifest[art]?.name).toBe("relay.png");
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(player.lastSeq).toBe(h.hostStore.seq);
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.map((t) => t._id)).not.toContain("relay");
    expect(player.store.world.assetManifest[art]).toBeUndefined();
  });

  test("Run All Batch Actions executes ordered queues atomically without leaking a transient reveal or asset", async () => {
    const art = "b".repeat(64);
    const h = await setup({ [art]: { name: "sealed.png", mime: "image/png", size: 5,
      chunks: 1, visibility: "referenced" } });
    await seedZone(h);
    h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" },
      data: { ...zoneTile(), _id: "sealed", hidden: true, img: art,
        taggerTags: ["sealed-target"] } as TileDocument }]);
    await flushMicrotasks();
    const def: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"],
      gates: { playerRunnable: true }, steps: [
        { id: "find", kind: "select", selector: { kind: "tag", query: "sealed-target", collections: ["tiles"] } },
        { id: "reveal", kind: "visibility", mode: "show" },
        { id: "flushReveal", kind: "batchFlush" },
        { id: "mark", kind: "tags", edit: "add", tags: ["private-mark"] },
        { id: "flushMark", kind: "batchFlush" },
        { id: "conceal", kind: "visibility", mode: "hide" },
        { id: "flushConceal", kind: "batchFlush" },
        { id: "msg", kind: "chat", audience: "gm", content: "batched" },
      ] };
    // Deliberately fail AFTER three explicit flushes: no envelopes were ever
    // committed and not even the graph history is advanced.
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...def, steps: [...def.steps, { id: "invalid", kind: "door", mode: "open" }] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const received: ClientEvents["ops"][] = [];
    bus.on("ops", (msg) => received.push(msg));
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.map((t) => t._id)).not.toContain("sealed");
    expect(player.store.world.assetManifest[art]).toBeUndefined();
    let before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles.find((t) => t._id === "sealed"))
      .toMatchObject({ hidden: true, taggerTags: ["sealed-target"] });
    expect(received).toEqual([]);
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    const envelope = h.hostLog.since(before);
    expect(envelope).toHaveLength(1);
    expect(envelope[0]?.ops.filter((op) =>
      (op.kind === "create" ? op.coll : op.ref.coll) !== "actionReceipts")).toMatchObject([
      { kind: "update", ref: { coll: "automations", id: "zone-graph" } },
      { kind: "update", ref: { coll: "tiles", id: "sealed" }, diff: { hidden: false } },
      { kind: "update", ref: { coll: "tiles", id: "sealed" },
        diff: { taggerTags: ["sealed-target", "private-mark"] } },
      { kind: "update", ref: { coll: "tiles", id: "sealed" }, diff: { hidden: true } },
      { kind: "create", coll: "messages", data: { content: "batched" } },
    ]);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles.find((t) => t._id === "sealed"))
      .toMatchObject({ hidden: true, taggerTags: ["sealed-target", "private-mark"] });
    const wire = JSON.stringify(received.filter(({ envelope: e }) => e.seq === h.hostStore.seq));
    expect(wire).not.toContain("sealed-target");
    expect(wire).not.toContain("private-mark");
    expect(wire).not.toContain(art);
    expect(player.store.getAll("automations")).toEqual([]);
    expect(player.store.world.assetManifest[art]).toBeUndefined();
    const { client: joined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: before });
    expect(joined.store.world.assetManifest[art]).toBeUndefined();
    expect((joined.store.get("scenes", "s1") as SceneDocument).tiles.map((t) => t._id)).not.toContain("sealed");
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles.find((t) => t._id === "sealed"))
      .toMatchObject({ hidden: true, taggerTags: ["sealed-target"] });
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
  });

  test("child FX preflight failure rejects the whole parent graph before changing history/messages", async () => {
    const h = await setup(); await seedZone(h);
    h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" },
      data: { ...zoneTile(), _id: "relay", hidden: true } as TileDocument }]);
    await flushMicrotasks();
    h.gm.submit([
      { kind: "create", coll: "automations", data: { ...zoneDoc(), _id: "relay-graph", definition: {
        ...zoneDoc().definition, tileId: "relay", methods: ["manual"], gates: {},
        steps: [{ id: "fx", kind: "sequence", macroId: "fx-plate", audience: "gm" }],
      } } as AutomationDocument },
      { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: {
        ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true }, steps: [
          { id: "chat", kind: "chat", content: "never", audience: "gm" },
          { id: "call", kind: "triggerTile", target: { kind: "id", tileId: "relay" }, tokens: "triggering" },
        ],
      } as unknown as Json } },
    ]);
    await flushMicrotasks();
    // Publication required an existing, valid macro; media can become unavailable later.
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "fx-plate" }, diff: {
      sequence: { version: 1, audience: "scene", sections: [{ kind: "image", id: "missing",
        assetId: "e".repeat(64), at: { kind: "source" }, startMs: 0, durationMs: 300 }] },
    } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    const traces: ClientEvents["automationTrace"][] = [];
    bus.on("rejected", (m) => rejected.push(m));
    h.gmBus.on("automationTrace", (m) => traces.push(m));
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    expect((h.hostStore.get("automations", "relay-graph") as AutomationDocument).state).toBeUndefined();
    expect(h.hostStore.getAll("messages")).toEqual([]);
    expect(traces.at(-1)).toMatchObject({ result: "rejected", detail: expect.stringMatching(/FX preflight failed/) });
    expect(rejected).toEqual([]); // public clicks never reveal child graph or FX IDs
  });

  test("one swept player path dispatches two rotated-zone enters in crossing order; Undo/Redo restores them without re-firing", async () => {
    const h = await setup();
    await seedRotatedZonePair(h, [{ id: "early-chat", kind: "chat", audience: "gm", content: "early rotated zone" }]);
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const startSeq = h.hostStore.seq;
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 900, y: 250 } }]);
    await flushMicrotasks();

    expect(h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl"))
      .toMatchObject({ x: 900, y: 250 });
    const crossed = h.hostStore.getAll("messages") as MessageDocument[];
    expect(crossed.map((message) => message.content)).toEqual(["early rotated zone", "later rotated zone"]);
    expect(h.hostStore.seq).toBe(startSeq + 3); // movement, then each crossing's independent graph envelope
    expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBe(1);
    expect(h.hostStore.get("automations", "zone-later-graph")?.state?.count).toBe(1);

    // History replay restores the exact crossing envelopes; it is not a new movement intent.
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual(["early rotated zone"]);
    expect(h.hostStore.get("automations", "zone-later-graph")?.state?.count).toBeUndefined();
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks();
    expect(h.hostStore.getAll("messages")).toEqual([]);
    expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBeUndefined();
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks();
    expect(h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl"))
      .toMatchObject({ x: 0, y: 250 });

    expect(h.host.redo().ok).toBe(true); await flushMicrotasks();
    expect(h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl"))
      .toMatchObject({ x: 900, y: 250 });
    expect(h.hostStore.getAll("messages")).toEqual([]);
    expect(h.host.redo().ok).toBe(true); await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual(["early rotated zone"]);
    expect(h.host.redo().ok).toBe(true); await flushMicrotasks();
    expect(h.hostStore.getAll("messages").map((message) => message.content))
      .toEqual(["early rotated zone", "later rotated zone"]);
    expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBe(1);
    expect(h.hostStore.get("automations", "zone-later-graph")?.state?.count).toBe(1);
    expect(h.hostStore.seq).toBeGreaterThan(startSeq + 3); // undo/redo envelopes, but no new automation fire
  });

  test("Stop Additional Tiles Triggering suppresses a later rotated zone without clipping movement", async () => {
    const h = await setup();
    await seedRotatedZonePair(h, [
      { id: "suppress", kind: "stopOthers" },
      { id: "early-chat", kind: "chat", audience: "gm", content: "stop-others ran" },
    ]);
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 900, y: 250 } }]);
    await flushMicrotasks();

    // stopOthers affects only later tile events in this committed intent. Unlike Stop Movement,
    // it leaves the full host-observed destination in place.
    expect(h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl"))
      .toMatchObject({ x: 900, y: 250 });
    expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual(["stop-others ran"]);
    expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBe(1);
    expect(h.hostStore.get("automations", "zone-later-graph")?.state?.count).toBeUndefined();
  });

  test("Stop Movement clips at the first rotated zone and replay does not dispatch the later zone", async () => {
    const h = await setup();
    await seedRotatedZonePair(h, [{ id: "stop", kind: "stopMovement", snapToGrid: false }]);
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 900, y: 250 } }]);
    await flushMicrotasks();
    const stopped = h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl");
    if (!stopped) throw new Error("missing stopped token");
    expect(stopped.x).toBeGreaterThan(100);
    expect(stopped.x).toBeLessThan(200); // swept-footprint contact on the first rotated plate, not the later plate
    expect(stopped.y).toBe(250);
    expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBe(1);
    expect(h.hostStore.get("automations", "zone-later-graph")?.state?.count).toBeUndefined();
    expect(h.hostStore.getAll("messages")).toEqual([]);

    const stoppedX = stopped.x;
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks(); // Stop graph history
    expect(h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl")?.x).toBe(stoppedX);
    expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBeUndefined();
    expect(h.host.undo().ok).toBe(true); await flushMicrotasks(); // movement
    expect(h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl"))
      .toMatchObject({ x: 0, y: 250 });
    expect(h.host.redo().ok).toBe(true); await flushMicrotasks();
    expect(h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl")?.x).toBe(stoppedX);
    expect(h.hostStore.get("automations", "zone-later-graph")?.state?.count).toBeUndefined();
    expect(h.host.redo().ok).toBe(true); await flushMicrotasks();
    expect(h.hostStore.get("automations", "zone-graph")?.state?.count).toBe(1);
    expect(h.hostStore.get("automations", "zone-later-graph")?.state?.count).toBeUndefined();
    expect(h.hostStore.getAll("messages")).toEqual([]);
  });

  test("Stop Additional Tiles Triggering suppresses later movement tiles by fraction and tile sort, not other tokens", async () => {
    const h = await setup(); await seedZone(h);
    const parent: AutomationDefinition = { ...zoneDoc().definition, methods: ["enter"],
      gates: { oncePerToken: true }, steps: [{ id: "suppress", kind: "stopOthers" }] };
    const other: AutomationDocument = { ...zoneDoc(), _id: "other-graph", definition: {
      ...zoneDoc().definition, tileId: "alpha", methods: ["enter"], gates: {},
      steps: [{ id: "msg", kind: "chat", audience: "scene", content: "lower" }],
    } };
    h.gm.submit([
      { kind: "update", ref: { coll: "tiles", id: "zone", parent: { coll: "scenes", id: "s1" } },
        diff: { sort: 20 } },
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" },
        data: { ...zoneTile(), _id: "alpha", sort: 0, ownership: { default: 3 } } as TileDocument },
    ]);
    await flushMicrotasks();
    h.gm.submit([
      { kind: "update", ref: { coll: "automations", id: "zone-graph" },
        diff: { definition: parent as unknown as Json } },
      { kind: "create", coll: "automations", data: other },
    ]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("rejected", (msg) => rejected.push(msg));
    const before = h.hostStore.seq;
    // Even an owned tile cannot let a player elevate its trigger priority.
    player.submit([{ kind: "update", ref: { coll: "tiles", id: "alpha", parent: { coll: "scenes", id: "s1" } },
      diff: { sort: 50 } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles.find((t) => t._id === "alpha")?.sort).toBe(0);
    expect(h.hostStore.seq).toBe(before);
    // A scene owner cannot bypass the tile guard by replacing the embedded tile list.
    h.gm.submit([{ kind: "update", ref: { coll: "scenes", id: "s1" },
      diff: { ownership: { default: 2, [PLAYER_ID]: 3 } } }]);
    await flushMicrotasks();
    const afterGrant = h.hostStore.seq;
    player.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" },
      data: { ...zoneTile(), _id: "player-tile", sort: 50, ownership: { default: 3 } } as TileDocument }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect(h.hostStore.seq).toBe(afterGrant);
    player.submit([{ kind: "update", ref: { coll: "scenes", id: "s1" },
      diff: { tiles: (h.hostStore.get("scenes", "s1") as SceneDocument).tiles.map((t) =>
        t._id === "alpha" ? { ...t, sort: 50 } : t) as unknown as Json } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect(h.hostStore.seq).toBe(afterGrant);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles.find((t) => t._id === "alpha")?.sort).toBe(0);
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 160, y: 160 } }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(afterGrant + 2); // movement + higher sort graph only
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect((h.hostStore.get("automations", "other-graph") as AutomationDocument).state).toBeUndefined();
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 0, y: 0 } }]);
    await flushMicrotasks();
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 160, y: 160 } }]);
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1); // gated
    expect((h.hostStore.get("automations", "other-graph") as AutomationDocument).state?.count).toBe(1);
    expect(player.store.getAll("messages").map((m) => m.content)).toEqual(["lower"]);
  });

  test("player movement routes through a private multi-target loop in one envelope; GM results stay projected", async () => {
    const h = await setup();
    // A different player's hidden token starts inside the tile. Place it
    // before publishing the graph so the setup move is not itself a trigger.
    h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: "t-ivy",
      parent: { coll: "scenes", id: "s1" } }, diff: { x: 180, y: 160, hidden: true } }]);
    await flushMicrotasks();
    await seedZone(h);
    const definition: AutomationDefinition = { ...zoneDoc().definition, steps: [
      { id: "route", kind: "routeUser", gm: "staff", player: "players" },
      { id: "staff", kind: "landing", name: "staff" },
      { id: "staffNotice", kind: "chat", audience: "gm", content: "staff" },
      { id: "stop", kind: "stop" },
      { id: "players", kind: "landing", name: "players" },
      { id: "inside", kind: "select", selector: { kind: "inside" } },
      { id: "loop", kind: "forEach", endId: "endLoop" },
      { id: "tag", kind: "tags", edit: "add", tags: ["visited"] },
      { id: "private", kind: "chat", audience: "gm", content: "{{index}}:{{currentId}}" },
      { id: "endLoop", kind: "endEach", startId: "loop" },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: definition as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const playerTraces: ClientEvents["automationTrace"][] = [];
    const gmTraces: ClientEvents["automationTrace"][] = [];
    bus.on("automationTrace", (msg) => playerTraces.push(msg));
    h.gmBus.on("automationTrace", (msg) => gmTraces.push(msg));
    expect(player.store.getAll("automations")).toHaveLength(0);
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.map((t) => t._id)).not.toContain("t-ivy");
    const before = h.hostStore.seq;
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 160, y: 160 } }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 2); // movement + one history/messages/tag envelope
    const graph = h.hostStore.get("automations", "zone-graph") as AutomationDocument;
    expect(graph.state?.count).toBe(1);
    expect(h.hostLog.since(before + 1)).toHaveLength(1);
    const tokens = (h.hostStore.get("scenes", "s1") as SceneDocument).tokens;
    expect(tokens.map((token) => token.taggerTags)).toEqual([["visited"], ["door-1", "visited"]]);
    const messages = h.hostStore.getAll("messages") as MessageDocument[];
    expect(messages.map((m) => m.content)).toEqual(["1:t-pl", "2:t-ivy"]);
    expect(messages.every((m) => m.whisper.includes(GM_ID))).toBe(true);
    expect(player.store.getAll("messages")).toEqual([]);
    expect(playerTraces).toEqual([]);
    expect(gmTraces[0]?.trace).toContain("loop 2/2: t-ivy");
    const { client: rejoined } = await h.addPlayer(PLAYER_ID, "Rex");
    expect(rejoined.store.getAll("automations")).toEqual([]);
    expect(rejoined.store.getAll("messages")).toEqual([]);
    expect((rejoined.store.get("scenes", "s1") as SceneDocument).tokens.map((t) => t._id)).not.toContain("t-ivy");
  });

  test("malformed graph imported from a world fails closed without interrupting token movement", async () => {
    const h = await setup();
    await seedZone(h);
    // Simulate a pre-validation world import; ordinary client intents cannot write this definition.
    const corrupted = h.hostStore.get("automations", "zone-graph") as AutomationDocument;
    corrupted.definition.methods = null as unknown as AutomationDocument["definition"]["methods"];
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: string[] = [];
    bus.on("rejected", (m) => rejected.push(m.reason));
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(rejected).toEqual([]); // ordinary tile and malformed private graph are indistinguishable
    player.requestAutomation("zone-graph", "s1", "click", "t-pl");
    await flushMicrotasks();
    expect(rejected).toEqual(["forbidden"]); // legacy ID-bearing endpoint is GM-only
    const before = h.hostStore.seq;
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 160, y: 160 } }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-pl")?.x).toBe(160);
    expect(corrupted.state).toBeUndefined();
  });

  test("late join/reconnect with stale seq gets current projected state, never graph, trace or GM whisper", async () => {
    const h = await setup();
    await seedZone(h);
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const staleSeq = player.lastSeq;
    h.host.removeSession(`peer-${PLAYER_ID}`);
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl");
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    const { client: rejoined, bus } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: staleSeq });
    const traces: ClientEvents["automationTrace"][] = [];
    bus.on("automationTrace", (m) => traces.push(m));
    expect(rejoined.lastSeq).toBe(h.hostStore.seq);
    expect(rejoined.store.getAll("automations")).toEqual([]);
    expect(rejoined.store.getAll("messages")).toEqual([]);
    expect(traces).toEqual([]);
    expect(h.gm.store.get("automations", "zone-graph")?.state?.count).toBe(1);
  });

  test("only GM receives graph/trace; committed movement fires once, tags/messaging commit together, FX remains GM-only", async () => {
    const h = await setup();
    await seedZone(h);
    const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
    const playerFx: ClientEvents["fx"][] = [];
    const playerTraces: ClientEvents["automationTrace"][] = [];
    const gmFx: ClientEvents["fx"][] = [];
    const gmTraces: ClientEvents["automationTrace"][] = [];
    playerBus.on("fx", (v) => playerFx.push(v));
    playerBus.on("automationTrace", (v) => playerTraces.push(v));
    h.gmBus.on("fx", (v) => gmFx.push(v));
    h.gmBus.on("automationTrace", (v) => gmTraces.push(v));
    expect(player.store.getAll("automations")).toEqual([]);
    expect(h.gm.store.getAll("automations")).toHaveLength(1);

    const seq = h.hostStore.seq;
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 160, y: 160 } }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq + 2); // move envelope, then one atomic graph envelope
    const state = (h.hostStore.get("automations", "zone-graph") as AutomationDocument).state;
    expect(state).toMatchObject({ count: 1, byToken: { "t-pl": { count: 1 } } });
    const sc = h.hostStore.get("scenes", "s1") as SceneDocument;
    expect(sc.tokens.find((t) => t._id === "t-ivy")?.taggerTags).toEqual(["door-1", "activated"]);
    const message = h.hostStore.getAll("messages").at(-1) as MessageDocument;
    expect(message.content).toContain("Plate triggered by pl-key");
    expect(message.whisper).toEqual([GM_ID]);
    expect(player.store.get("messages", message._id)).toBeUndefined();
    expect(gmFx).toHaveLength(1);
    expect(gmFx[0]?.sections[0]).toMatchObject({ kind: "text", x: 160, y: 160 });
    expect(playerFx).toHaveLength(0);
    expect(playerTraces).toHaveLength(0);
    expect(gmTraces.map((m) => [m.method, m.result])).toEqual([["enter", "committed"], ["stop", "skipped"]]);
    expect(gmTraces[0]?.trace).toContain("selected 1 tag target(s)");
    // Replayed identical movement cannot fire because there is no crossing, and history survived the ops.
    player.submit([{ kind: "update", ref: tokenRef, diff: { x: 160, y: 160 } }]);
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
  });

  test("published attribute filters read live private actor data on the host without projecting the graph or its values", async () => {
    const h = await setup(); await seedZone(h);
    const secret: ActorDocument = { _id: "secret-hp", type: "actor", name: "private-signal-key",
      ownership: { default: 0 }, flags: {}, system: { attributes: { hp: { value: 3 } } },
      items: [], effects: [] };
    h.gm.submit([
      { kind: "create", coll: "actors", data: secret },
      { kind: "update", ref: { coll: "tokens", id: "t-ivy", parent: { coll: "scenes", id: "s1" } },
        diff: { actorId: secret._id } },
      { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { definition: {
        ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true }, steps: [
          { id: "find", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
          { id: "hp", kind: "attributes", path: "actor.system.attributes.hp.value", compare: "lte", value: 5 },
          { id: "check", kind: "filter", test: { kind: "count", min: 1 } },
          { id: "mark", kind: "tags", edit: "add", tags: ["injured"] },
          { id: "notice", kind: "chat", audience: "gm", content: "Private HP check" },
        ],
      } as unknown as Json } },
    ]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const broadcasts: ClientEvents["ops"][] = [], traces: ClientEvents["automationTrace"][] = [];
    bus.on("ops", (message) => broadcasts.push(message));
    bus.on("automationTrace", (message) => traces.push(message));
    expect(player.store.get("actors", secret._id)).toBeUndefined();
    expect(player.store.getAll("automations")).toEqual([]);
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1); // history, tag and private chat in one undo group
    expect(h.hostLog.since(before)[0]?.ops.filter((op) =>
      (op.kind === "create" ? op.coll : op.ref.coll) !== "actionReceipts")).toMatchObject([
      { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { state: { count: 1 } } },
      { kind: "create", coll: "messages", data: { content: "Private HP check" } },
      { kind: "update", ref: { coll: "tokens", id: "t-ivy" }, diff: { taggerTags: ["door-1", "injured"] } },
    ]);
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["door-1", "injured"]);
    expect(player.store.getAll("messages")).toEqual([]);
    expect(traces).toEqual([]);
    expect(JSON.stringify(broadcasts)).not.toMatch(/attributes\.hp|Private HP check|private-signal-key|actor\.system/);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["door-1"]);
    expect(h.hostStore.getAll("messages")).toEqual([]);

    h.gm.submit([{ kind: "update", ref: { coll: "actors", id: secret._id },
      diff: { system: { attributes: { hp: { value: 15 } } } } }]);
    await flushMicrotasks();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["door-1"]);
    expect(h.hostStore.getAll("messages")).toEqual([]);
    expect(player.store.get("actors", secret._id)).toBeUndefined();
  });

  test("player-published condition/inventory filters read private live actor data; projection, undo and reconnect remain safe", async () => {
    const h = await setup(); await seedZone(h);
    const secret: ActorDocument = { _id: "private-actor", type: "actor", name: "private-actor-name",
      ownership: { default: 0 }, flags: {}, system: { pf1e: { conditions: [] } },
      effects: [{ _id: "private-effect", type: "effect", name: "private-aura", disabled: false,
        ownership: { default: 0 }, flags: { pf1e: { condition: "Prone" } }, system: {}, changes: [] }],
      items: ["private-potion-a", "private-potion-b"].map((id) => ({
        _id: id, type: "item" as const, name: id, ownership: { default: 0 as const }, flags: {},
        system: { quantity: 99 }, effects: [],
      })) };
    const definition: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"],
      gates: { playerRunnable: true }, steps: [
        { id: "find", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
        { id: "condition", kind: "condition", effect: "Prone", mode: "has" },
        { id: "inventory", kind: "inventory", item: "*potion*", compare: "gte", count: 2 },
        { id: "one", kind: "filter", test: { kind: "count", min: 1 } },
        { id: "mark", kind: "tags", edit: "add", tags: ["verified"] },
        { id: "notice", kind: "chat", audience: "gm", content: "Private actor matched" },
      ] };
    h.gm.submit([
      { kind: "create", coll: "actors", data: secret },
      { kind: "update", ref: { coll: "tokens", id: "t-ivy", parent: { coll: "scenes", id: "s1" } },
        diff: { actorId: secret._id } },
      { kind: "update", ref: { coll: "automations", id: "zone-graph" },
        diff: { definition: definition as unknown as Json } },
    ]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const broadcasts: ClientEvents["ops"][] = [], traces: ClientEvents["automationTrace"][] = [];
    bus.on("ops", (message) => broadcasts.push(message));
    bus.on("automationTrace", (message) => traces.push(message));
    expect(player.store.get("actors", secret._id)).toBeUndefined();
    expect(player.store.getAll("automations")).toEqual([]);
    const first = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(first + 1);
    expect(h.hostLog.since(first)[0]?.ops.filter((op) =>
      (op.kind === "create" ? op.coll : op.ref.coll) !== "actionReceipts")).toMatchObject([
      { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: { state: { count: 1 } } },
      { kind: "create", coll: "messages", data: { content: "Private actor matched" } },
      { kind: "update", ref: { coll: "tokens", id: "t-ivy" }, diff: { taggerTags: ["door-1", "verified"] } },
    ]);
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["door-1", "verified"]);
    expect(player.store.getAll("messages")).toEqual([]);
    expect(traces).toEqual([]);
    expect(JSON.stringify(broadcasts)).not.toMatch(/private-actor-name|private-potion|private-aura|Prone|Private actor matched|inventory|condition/);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["door-1"]);
    expect(h.hostStore.getAll("messages")).toEqual([]);

    h.gm.submit([{ kind: "update", ref: { coll: "actors", id: secret._id }, diff: {
      effects: [{ ...secret.effects[0], disabled: true }], items: [],
    } }]);
    await flushMicrotasks();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["door-1"]);
    expect(h.hostStore.getAll("messages")).toEqual([]);

    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...definition, steps: [definition.steps[0],
        { id: "condition", kind: "condition", effect: "Prone", mode: "lacks" },
        { id: "inventory", kind: "inventory", item: "Potion*", compare: "eq", count: 0 },
        ...definition.steps.slice(3)] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const staleSeq = player.lastSeq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(2);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["door-1", "verified"]);
    h.host.removeSession(`peer-${PLAYER_ID}`);
    const { client: rejoined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: staleSeq });
    expect((rejoined.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["door-1", "verified"]);
    expect(rejoined.store.get("actors", secret._id)).toBeUndefined();
    expect(rejoined.store.getAll("automations")).toEqual([]);
    expect(rejoined.store.getAll("messages")).toEqual([]);
    expect(JSON.stringify(broadcasts)).not.toMatch(/private-potion|private-aura|Prone|Private actor matched/);
  });

  test("forged methods, alternate source, edits and action payloads cannot escalate; GM dry-run has no side effects", async () => {
    const h = await setup();
    await seedZone(h);
    const { client: player, bus, pair } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: string[] = [];
    const traces: ClientEvents["automationTrace"][] = [];
    bus.on("rejected", (m) => rejected.push(m.reason));
    h.gmBus.on("automationTrace", (m) => traces.push(m));
    player.requestAutomation("zone-graph", "s1", "manual");
    player.requestAutomation("zone-graph", "s1", "click", "t-ivy"); // not owned
    player.requestAutomation("unknown", "s1", "click", "t-pl");
    player.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, gates: { playerRunnable: true } } as unknown as Json,
    } }]);
    const forged = { kind: "automation.request" as const, requestId: "forge", automationId: "zone-graph",
      sceneId: "s1", method: "click" as const, ops: [{ kind: "delete", coll: "actors" }] };
    pair.b.send("ops", frameMessage(forged as unknown as Parameters<typeof frameMessage>[0]));
    await flushMicrotasks();
    expect(rejected).toEqual(["forbidden", "forbidden", "forbidden", "forbidden", "invalid_schema"]);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();

    const seq = h.hostStore.seq;
    h.gm.requestAutomation("zone-graph", "s1", "enter", "t-pl", true);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq);
    expect(traces.at(-1)?.result).toBe("skipped");
    expect(traces.at(-1)?.detail).toMatch(/dry-run/);
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq + 1);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    // Replay of the same requestId is ignored even if the caller changes the token argument.
    const again = { kind: "automation.request" as const, requestId: "same", automationId: "zone-graph",
      sceneId: "s1", method: "click" as const, tokenId: "t-ivy" };
    pair.b.send("ops", frameMessage(again));
    pair.b.send("ops", frameMessage(again));
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
  });

  test("dry-running a random-number graph is stable and does not consume the mechanical RNG", async () => {
    let rolled = 0;
    const h = await setup({}, undefined, () => { rolled++; return 0.75; });
    await seedZone(h);
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["manual"], steps: [
        { id: "random", kind: "random", name: "die", min: 1, max: 20 },
        { id: "message", kind: "chat", audience: "gm", content: "Result {{die}}" },
      ] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const traces: ClientEvents["automationTrace"][] = [];
    h.gmBus.on("automationTrace", (msg) => traces.push(msg));
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl", true);
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl", true);
    await flushMicrotasks();
    expect(rolled).toBe(0);
    expect(traces.at(-2)?.trace.find((line) => line.includes("host roll")))
      .toBe(traces.at(-1)?.trace.find((line) => line.includes("host roll")));
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl");
    await flushMicrotasks();
    expect(rolled).toBe(1);
    expect((h.hostStore.getAll("messages").at(-1) as MessageDocument)?.content).toBe("Result 16");
  });

  test("published graph can show/hide tagged tokens, retracting replicas and media entitlements without leaking the graph", async () => {
    const image = "e".repeat(64);
    const h = await setup({ [image]: { name: "guardian.png", mime: "image/png", size: 100, chunks: 1,
      visibility: "referenced" } });
    await seedZone(h);
    h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: "t-ivy", parent: { coll: "scenes", id: "s1" } },
      diff: { img: image } }]);
    const definition = { ...zoneDoc().definition, methods: ["click" as const, "enter" as const],
      gates: { playerRunnable: true }, steps: [
        { id: "find", kind: "select" as const, selector: { kind: "tag" as const,
          query: "door-*", pattern: "wildcard" as const, collections: ["tokens" as const] } },
        { id: "hide", kind: "visibility" as const, mode: "hide" as const },
      ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: definition as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const failures: ClientEvents["rejected"][] = [];
    bus.on("rejected", (m) => failures.push(m));
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.some((t) => t._id === "t-ivy")).toBe(true);
    expect(player.store.world.assetManifest[image]).toBeDefined();
    expect(player.store.getAll("automations")).toEqual([]);
    player.requestAutomation("zone-graph", "s1", "enter", "t-pl"); // cannot claim uncommitted movement
    await flushMicrotasks();
    expect(failures.at(-1)?.reason).toBe("forbidden");
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.hidden).toBe(false);

    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.hidden).toBe(true);
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.some((t) => t._id === "t-ivy")).toBe(false);
    expect(player.store.world.assetManifest[image]).toBeUndefined();

    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: { ...definition, steps: [definition.steps[0],
        { id: "show", kind: "visibility", mode: "show" }] } as unknown as Json } }]);
    await flushMicrotasks();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.some((t) => t._id === "t-ivy")).toBe(true);
    expect(player.store.world.assetManifest[image]).toBeDefined();
    player.submit([{ kind: "update", ref: { coll: "tokens", id: "t-ivy", parent: { coll: "scenes", id: "s1" } },
      diff: { hidden: true } }]);
    await flushMicrotasks();
    expect(failures.at(-1)?.reason).toBe("forbidden");
    expect(player.store.getAll("automations")).toEqual([]);
  });

  test("a player canvas click resolves the visible tile to private published graphs, with hit/ownership/replay checks", async () => {
    const h = await setup();
    await seedZone(h);
    const { client: player, bus, pair } = await h.addPlayer(PLAYER_ID, "Rex");
    const denied: ClientEvents["rejected"][] = [];
    const traces: ClientEvents["automationTrace"][] = [];
    bus.on("rejected", (msg) => denied.push(msg));
    h.gmBus.on("automationTrace", (msg) => traces.push(msg));
    const before = h.hostStore.seq;
    player.requestAutomation("zone-graph", "s1", "click", "t-pl");
    await flushMicrotasks();
    expect(denied.at(-1)).toMatchObject({ reason: "forbidden", detail: "not published for this caller" });
    expect(h.hostStore.seq).toBe(before); // guessed graph ID cannot bypass a canvas hit
    const requestId = player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect(traces.at(-1)).toMatchObject({ method: "click", result: "committed" });
    expect(player.store.getAll("automations")).toEqual([]);
    pair.b.send("ops", frameMessage({ kind: "automation.click", requestId, sceneId: "s1", tileId: "zone",
      point: { x: 150, y: 150 }, tokenId: "t-pl" }));
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    player.requestAutomationClick("s1", "zone", { x: 50, y: 50 }, "t-pl");
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-ivy"); // another player's token
    player.requestAutomationClick("s1", "unknown", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(denied.slice(-3).map((m) => m.reason)).toEqual(["forbidden", "forbidden", "forbidden"]);
    expect(denied.slice(-3).map((m) => m.detail)).toEqual(["tile unavailable", "tile unavailable", "tile unavailable"]);
    const tileRef = { coll: "tiles" as const, id: "zone", parent: { coll: "scenes" as const, id: "s1" } };
    h.gm.submit([{ kind: "update", ref: tileRef, diff: { hidden: true } }]);
    await flushMicrotasks();
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles).toEqual([]);
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(denied.at(-1)?.detail).toBe("tile unavailable");
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
  });

  test("published right-click is a distinct visible-tile event, host-revalidated and private", async () => {
    const h = await setup();
    await seedZone(h);
    const definition: AutomationDefinition = { ...zoneDoc().definition, methods: ["rightClick"],
      gates: { playerRunnable: true }, steps: [
        { id: "notice", kind: "chat", audience: "gm", content: "{{method}} by {{user}}" },
      ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: definition as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player, bus, pair } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    const traces: ClientEvents["automationTrace"][] = [];
    bus.on("rejected", (message) => rejected.push(message));
    h.gmBus.on("automationTrace", (message) => traces.push(message));
    const before = h.hostStore.seq;
    const requestId = player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, undefined, "rightClick");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect(h.hostStore.getAll("messages").map((message) => message.content)).toContain("rightClick by pl-key");
    expect(traces.at(-1)).toMatchObject({ method: "rightClick", result: "committed" });
    expect(player.store.getAll("messages")).toEqual([]);
    expect(player.store.getAll("automations")).toEqual([]);

    // Neither an ID-bearing method request nor a forged point can bypass the player click boundary.
    player.requestAutomation("zone-graph", "s1", "rightClick");
    player.requestAutomationClick("s1", "zone", { x: 50, y: 50 }, undefined, "rightClick");
    await flushMicrotasks();
    expect(rejected.map((message) => message.reason)).toEqual(["forbidden", "forbidden"]);
    expect(h.hostStore.seq).toBe(before + 1);

    // Replaying the same event is ignored; a left click does not match this right-click-only graph.
    pair.b.send("ops", frameMessage({ kind: "automation.click", requestId, sceneId: "s1", tileId: "zone",
      point: { x: 150, y: 150 }, method: "rightClick" }));
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 });
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
  });

  test("published double-click is a distinct visible-tile event with one overlapping ordinary click", async () => {
    const h = await setup();
    await seedZone(h);
    const definition: AutomationDefinition = { ...zoneDoc().definition, methods: ["click", "doubleClick"],
      gates: { playerRunnable: true }, steps: [
        { id: "notice", kind: "chat", audience: "gm", content: "{{method}} by {{user}}" },
      ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: definition as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player, bus, pair } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    const traces: ClientEvents["automationTrace"][] = [];
    bus.on("rejected", (message) => rejected.push(message));
    h.gmBus.on("automationTrace", (message) => traces.push(message));

    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 });
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual(["click by pl-key"]);

    // A native double-click has an ordinary first click, a suppressed second click, and one
    // completed doubleClick event. The first event remains intentionally observable.
    const doubleRequestId = player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, undefined, "doubleClick");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 2);
    expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual([
      "click by pl-key", "doubleClick by pl-key",
    ]);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(2);
    expect(traces.at(-1)).toMatchObject({ method: "doubleClick", result: "committed" });
    expect(player.store.getAll("messages")).toEqual([]);
    expect(player.store.getAll("automations")).toEqual([]);

    player.requestAutomation("zone-graph", "s1", "doubleClick");
    player.requestAutomationClick("s1", "zone", { x: 50, y: 50 }, undefined, "doubleClick");
    pair.b.send("ops", frameMessage({ kind: "automation.click", requestId: doubleRequestId,
      sceneId: "s1", tileId: "zone", point: { x: 150, y: 150 }, method: "doubleClick" }));
    await flushMicrotasks();
    expect(rejected.map((message) => message.reason)).toEqual(["forbidden", "forbidden"]);
    expect(h.hostStore.seq).toBe(before + 2);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(2);
  });

  test("published hover-in/out dispatch only from validated visible tiles with private graph state", async () => {
    const h = await setup();
    await seedZone(h);
    const definition: AutomationDefinition = { ...zoneDoc().definition, methods: ["hoverIn", "hoverOut"],
      gates: { playerRunnable: true }, steps: [
        { id: "notice", kind: "chat", audience: "gm", content: "{{method}} by {{user}}" },
      ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: definition as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player, bus, pair } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    const traces: ClientEvents["automationTrace"][] = [];
    bus.on("rejected", (message) => rejected.push(message));
    h.gmBus.on("automationTrace", (message) => traces.push(message));
    const before = h.hostStore.seq;
    const hoverInRequestId = player.requestAutomationTileTrigger("s1", "zone", { x: 150, y: 150 }, undefined, "hoverIn");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual(["hoverIn by pl-key"]);
    expect(traces.at(-1)).toMatchObject({ method: "hoverIn", result: "committed" });
    expect(player.store.getAll("messages")).toEqual([]);
    expect(player.store.getAll("automations")).toEqual([]);

    // A hover-out carries the last in-tile point; it does not send an outside pointer coordinate.
    player.requestAutomationTileTrigger("s1", "zone", { x: 150, y: 150 }, undefined, "hoverOut");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 2);
    expect(h.hostStore.getAll("messages").map((message) => message.content)).toEqual([
      "hoverIn by pl-key", "hoverOut by pl-key",
    ]);
    expect(traces.at(-1)).toMatchObject({ method: "hoverOut", result: "committed" });

    // IDs and forged points cannot invoke the private graph or skip the visible hit test.
    player.requestAutomation("zone-graph", "s1", "hoverIn");
    player.requestAutomationTileTrigger("s1", "zone", { x: 50, y: 50 }, undefined, "hoverIn");
    pair.b.send("ops", frameMessage({ kind: "automation.click", requestId: hoverInRequestId,
      sceneId: "s1", tileId: "zone", point: { x: 150, y: 150 }, method: "hoverIn" }));
    await flushMicrotasks();
    expect(rejected.map((message) => message.reason)).toEqual(["forbidden", "forbidden"]);
    expect(h.hostStore.seq).toBe(before + 2);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(2);
  });

  test("hidden trigger tiles are absent from player replicas/assets and cannot be invoked by guessed ID", async () => {
    const image = "d".repeat(64);
    const h = await setup({ [image]: { name: "hidden-plate.png", mime: "image/png", size: 10,
      chunks: 1, visibility: "referenced" } });
    await seedZone(h);
    const ref = { coll: "tiles" as const, id: "zone", parent: { coll: "scenes" as const, id: "s1" } };
    h.gm.submit([{ kind: "update", ref, diff: { img: image, hidden: true } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("rejected", (msg) => rejected.push(msg));
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles).toEqual([]);
    expect(player.store.world.assetManifest[image]).toBeUndefined();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    player.requestAutomationTileTrigger("s1", "zone", { x: 150, y: 150 }, undefined, "hoverIn");
    await flushMicrotasks();
    expect(rejected.map((message) => message.reason)).toEqual(["forbidden", "forbidden"]);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();

    h.gm.submit([{ kind: "update", ref, diff: { hidden: false } }]);
    await flushMicrotasks();
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.map((t) => t._id)).toEqual(["zone"]);
    expect(player.store.world.assetManifest[image]).toBeDefined();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    h.gm.submit([{ kind: "update", ref, diff: { hidden: true } }]);
    await flushMicrotasks();
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles).toEqual([]);
    expect(player.store.world.assetManifest[image]).toBeUndefined();
  });

  test("FX recipients are rechecked after the graph hides its target in the same committed envelope", async () => {
    const h = await setup();
    await seedZone(h);
    const def = { ...zoneDoc().definition, methods: ["click" as const], gates: { playerRunnable: true },
      steps: [
        { id: "find", kind: "select" as const, selector: { kind: "tag" as const,
          query: "door-1", collections: ["tokens" as const] } },
        { id: "hide", kind: "visibility" as const, mode: "hide" as const },
        { id: "flash", kind: "sequence" as const, macroId: "fx-plate", audience: "scene" as const },
      ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: def as unknown as Json } }]);
    await flushMicrotasks();
    const first = await h.addPlayer(PLAYER_ID, "Rex");
    const second = await h.addPlayer(OTHER_ID, "Ivy");
    const firstFx: ClientEvents["fx"][] = [], secondFx: ClientEvents["fx"][] = [], gmFx: ClientEvents["fx"][] = [];
    first.bus.on("fx", (cue) => firstFx.push(cue));
    second.bus.on("fx", (cue) => secondFx.push(cue));
    h.gmBus.on("fx", (cue) => gmFx.push(cue));
    first.client.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect((first.client.store.get("scenes", "s1") as SceneDocument).tokens.some((t) => t._id === "t-ivy")).toBe(false);
    expect((second.client.store.get("scenes", "s1") as SceneDocument).tokens.some((t) => t._id === "t-ivy")).toBe(true); // owner
    expect(firstFx).toHaveLength(0); // a cue about a newly hidden target must not escape
    expect(secondFx).toHaveLength(1);
    expect(gmFx).toHaveLength(1);
  });

  test("a published pressure-plate graph operates a tagged wall door, not an arbitrary wall or a forged player edit", async () => {
    const h = await setup();
    await seedZone(h);
    const door: WallDocument = { _id: "gate", type: "wall", name: "Gate", ownership: { default: 0 },
      flags: {}, system: {}, taggerTags: ["door-1"], c: [100, 100, 300, 100],
      move: 1, sight: 1, sound: 1, light: 1, door: 0, oneWay: false };
    const find = { id: "find", kind: "select" as const,
      selector: { kind: "tag" as const, query: "door-1", collections: ["walls" as const] } };
    const definition = { ...zoneDoc().definition, methods: ["click" as const],
      gates: { playerRunnable: true }, steps: [find, { id: "open", kind: "door" as const, mode: "open" as const }] };
    h.gm.submit([{ kind: "create", coll: "walls", parent: { coll: "scenes", id: "s1" }, data: door },
      { kind: "update", ref: { coll: "automations", id: "zone-graph" },
        diff: { definition: definition as unknown as Json } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("rejected", (msg) => rejected.push(msg));
    expect(player.store.getAll("automations")).toEqual([]);
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect((player.store.get("scenes", "s1") as SceneDocument).walls.find((w) => w._id === "gate")?.door).toBe(1);
    player.submit([{ kind: "update", ref: { coll: "walls", id: "gate", parent: { coll: "scenes", id: "s1" } },
      diff: { door: 0 } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).walls.find((w) => w._id === "gate")?.door).toBe(1);

    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: { ...definition,
        steps: [find, { id: "lock", kind: "door", mode: "lock" }] } as unknown as Json } }]);
    await flushMicrotasks();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect((player.store.get("scenes", "s1") as SceneDocument).walls.find((w) => w._id === "gate")?.door).toBe(2);

    const priorSeq = h.hostStore.seq;
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: { ...definition, steps: [find,
        { id: "toggle", kind: "door", mode: "toggle" }] } as unknown as Json } }]);
    await flushMicrotasks();
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect(h.hostStore.seq).toBe(priorSeq + 1); // graph publication only; no partial history/action
    expect((player.store.get("scenes", "s1") as SceneDocument).walls.find((w) => w._id === "gate")?.door).toBe(2);
  });

  test("FX preflight refuses missing media without committing a partial automation", async () => {
    const h = await setup();
    await seedZone(h);
    const missing = "d".repeat(64);
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "fx-plate" }, diff: {
      sequence: { version: 1, sections: [{ kind: "image", id: "flash", assetId: missing,
        at: { kind: "source" }, startMs: 0, durationMs: 1000 }] },
    } }]);
    await flushMicrotasks();
    const traces: ClientEvents["automationTrace"][] = [];
    h.gmBus.on("automationTrace", (m) => traces.push(m));
    const seq = h.hostStore.seq;
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl");
    await flushMicrotasks();
    expect(traces.at(-1)?.result).toBe("rejected");
    expect(traces.at(-1)?.detail).toMatch(/FX preflight failed/);
    expect(h.hostStore.seq).toBe(seq);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    expect(h.hostStore.getAll("messages")).toHaveLength(0);
  });

  test.each([true,false])("committed Move dispatch obeys private triggerTiles=%s and does not persist suppression", async (triggerTiles) => {
    const h = await setup();
    const trap2: TileDocument = { ...zoneTile(), _id: "trap2", name: "Destination",
      x: 400, y: 100, sort: 0 };
    const trap2Graph: AutomationDocument = { ...zoneDoc(), _id: "trap2-graph", name: "Destination",
      definition: { ...zoneDoc().definition, tileId: "trap2", methods: ["enter"], gates: {},
        steps: [{ id: "notice", kind: "chat", audience: "gm", content: "trap2 fired" }] } };
    const moveGraph: AutomationDocument = { ...zoneDoc(), name: "Mover",
      definition: { ...zoneDoc().definition, methods: ["manual"], gates: {},
        steps: [
          { id: "move", kind: "move", x: 450, y: 150, targets: "triggering", triggerTiles, speed: 2, wallCollision: "footprint" },
          { id: "notice", kind: "chat", audience: "gm", content: "moved" },
        ] } };
    h.gm.submit([
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() },
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: trap2 },
    ]);
    await flushMicrotasks();
    // Anchors are validated against the applied store: the graphs land after their tiles.
    h.gm.submit([
      { kind: "create", coll: "automations", data: moveGraph },
      { kind: "create", coll: "automations", data: trap2Graph },
    ]);
    await flushMicrotasks();
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl");
    await flushMicrotasks();
    const token = (h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-pl");
    expect(token && { x: token.x, y: token.y }).toEqual({ x: 450, y: 150 });
    expect((h.hostStore.get("automations", "trap2-graph") as AutomationDocument).state?.count).toBe(triggerTiles ? 1 : undefined);
    expect(h.hostStore.getAll("messages").some((m) => m.content === "trap2 fired")).toBe(triggerTiles);
    if (!triggerTiles) {
      h.gm.submit([{kind:"update",ref:tokenRef,diff:{x:100,y:100}}]); await flushMicrotasks();
      h.gm.submit([{kind:"update",ref:tokenRef,diff:{x:450,y:150}}]); await flushMicrotasks();
      expect((h.hostStore.get("automations","trap2-graph") as AutomationDocument).state?.count).toBe(1);
    }
  });

  test("Stop Additional Tiles Triggering suppresses the sibling tile for the movement that fired the graph", async () => {
    const h = await setup();
    const a: TileDocument = { ...zoneTile(), sort: 10 };
    const b: TileDocument = { ...zoneTile(), _id: "trap2", name: "Sibling", x: 400, y: 100, sort: 0 };
    const aGraph: AutomationDocument = { ...zoneDoc(), name: "Mover",
      definition: { ...zoneDoc().definition, methods: ["enter"], gates: {},
        steps: [
          { id: "move", kind: "move", x: 700, y: 700, targets: "triggering" },
          { id: "stop", kind: "stopOthers" },
          { id: "notice", kind: "chat", audience: "gm", content: "A fired" },
        ] } };
    const bGraph: AutomationDocument = { ...zoneDoc(), _id: "trap2-graph", name: "Sibling",
      definition: { ...zoneDoc().definition, tileId: "trap2", methods: ["enter"], gates: {},
        steps: [{ id: "notice", kind: "chat", audience: "gm", content: "B fired" }] } };
    h.gm.submit([
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: a },
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: b },
    ]);
    await flushMicrotasks();
    h.gm.submit([
      { kind: "create", coll: "automations", data: aGraph },
      { kind: "create", coll: "automations", data: bGraph },
    ]);
    await flushMicrotasks();
    // t-pl walks from (0,0) through A into B in one committed move.
    h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: "t-pl",
      parent: { coll: "scenes", id: "s1" } }, diff: { x: 450, y: 150 } }]);
    await flushMicrotasks();
    const token = (h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-pl");
    expect(token && { x: token.x, y: token.y }).toEqual({ x: 700, y: 700 }); // A's move won
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect((h.hostStore.get("automations", "trap2-graph") as AutomationDocument).state).toBeUndefined();
    expect(h.hostStore.getAll("messages").some((m) => m.content === "B fired")).toBe(false);
  });

  test("ping-pong Move graphs are bounded by the host movement-chain depth cap", async () => {
    const h = await setup();
    const a: TileDocument = { ...zoneTile(), sort: 10 };
    const b: TileDocument = { ...zoneTile(), _id: "trap2", name: "Echo", x: 400, y: 100, sort: 5 };
    const ping: AutomationDocument = { ...zoneDoc(), name: "Ping",
      definition: { ...zoneDoc().definition, methods: ["enter"], gates: {},
        steps: [
          { id: "move", kind: "move", x: 450, y: 150, targets: "triggering" },
          { id: "notice", kind: "chat", audience: "gm", content: "ping {{count}}" },
        ] } };
    const pong: AutomationDocument = { ...zoneDoc(), _id: "trap2-graph", name: "Pong",
      definition: { ...zoneDoc().definition, tileId: "trap2", methods: ["enter"], gates: {},
        steps: [
          { id: "move", kind: "move", x: 150, y: 150, targets: "triggering" },
          { id: "notice", kind: "chat", audience: "gm", content: "pong {{count}}" },
        ] } };
    h.gm.submit([
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: a },
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: b },
    ]);
    await flushMicrotasks();
    h.gm.submit([
      { kind: "create", coll: "automations", data: ping },
      { kind: "create", coll: "automations", data: pong },
    ]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: "t-pl",
      parent: { coll: "scenes", id: "s1" } }, diff: { x: 150, y: 150 } }]);
    await flushMicrotasks();
    // Dispatches run at depths 1..8: ping fires at 1/3/5/7, pong at 2/4/6/8.
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(4);
    expect((h.hostStore.get("automations", "trap2-graph") as AutomationDocument).state?.count).toBe(4);
    const token = (h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-pl");
    expect(token && { x: token.x, y: token.y }).toEqual({ x: 150, y: 150 });
    // The host is still healthy: an unrelated manual fire commits normally.
    const calm: AutomationDocument = { ...zoneDoc(), _id: "calm-graph", name: "Calm",
      definition: { ...zoneDoc().definition, methods: ["manual"], gates: {},
        steps: [{ id: "notice", kind: "chat", audience: "gm", content: "still alive" }] } };
    h.gm.submit([{ kind: "create", coll: "automations", data: calm }]);
    await flushMicrotasks();
    const before = h.hostStore.seq;
    h.gm.requestAutomation("calm-graph", "s1", "manual");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBeGreaterThan(before);
    expect(h.hostStore.getAll("messages").some((m) => m.content === "still alive")).toBe(true);
  });

  test("A27 intentional landing/jump cycle returns a bounded private diagnostic without committing world state", async () => {
    const h = await setup();
    await seedZone(h);
    const { bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
    const gmTraces: ClientEvents["automationTrace"][] = [];
    const playerTraces: ClientEvents["automationTrace"][] = [];
    h.gmBus.on("automationTrace", (message) => gmTraces.push(message));
    playerBus.on("automationTrace", (message) => playerTraces.push(message));

    const cycle: AutomationDefinition = { ...zoneDoc().definition, methods: ["manual"], gates: {}, steps: [
      { id: "cycle-start", kind: "landing", name: "again" },
      { id: "cycle-jump", kind: "jump", to: "again" },
    ] };
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: cycle as unknown as Json } }]);
    await flushMicrotasks();
    const beforeCycle = h.hostStore.seq;
    const originalToken = h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl");
    h.gm.requestAutomation("zone-graph", "s1", "manual", "t-pl");
    await flushMicrotasks();

    const diagnostic = gmTraces.at(-1);
    expect(diagnostic).toMatchObject({
      automationId: "zone-graph",
      method: "manual",
      result: "rejected",
      detail: "automation cycle/resource budget (10000 per graph, 25000 total steps)",
    });
    expect(diagnostic?.trace[0]).toBe("0: landing [cycle-start]");
    expect(diagnostic?.trace[1]).toBe("1: jump [cycle-jump]");
    expect(diagnostic?.trace).toHaveLength(128);
    expect(diagnostic?.trace.at(-1)).toBe("… 9873 more trace entries omitted (delivery limit)");
    expect(playerTraces).toHaveLength(0); // recursion details and graph structure are GM-only
    expect(h.hostStore.seq).toBe(beforeCycle); // no staged history, action or partial write
    expect(h.hostStore.get("automations", "zone-graph")?.state).toBeUndefined();
    expect(h.hostStore.getAll("messages")).toHaveLength(0);
    expect(h.hostStore.get("scenes", "s1")?.tokens.find((token) => token._id === "t-pl"))
      .toEqual(originalToken);

    const calm: AutomationDocument = { ...zoneDoc(), _id: "calm-graph", name: "After the cycle",
      definition: { ...zoneDoc().definition, methods: ["manual"], gates: {},
        steps: [{ id: "alive", kind: "chat", audience: "gm", content: "host still responsive" }] } };
    h.gm.submit([{ kind: "create", coll: "automations", data: calm }]);
    await flushMicrotasks();
    const beforeRecovery = h.hostStore.seq;
    h.gm.requestAutomation("calm-graph", "s1", "manual");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBeGreaterThan(beforeRecovery);
    expect(gmTraces.at(-1)).toMatchObject({ automationId: "calm-graph", result: "committed" });
    expect(h.hostStore.getAll("messages").some((message) => message.content === "host still responsive")).toBe(true);
  });

  test.each(["undo","revert"] as const)("player-triggered Move of environment placeables and drawing restores with %s",async(restore)=>{
    const audio="a".repeat(64),h=await setup({[audio]:{name:"fountain.wav",mime:"audio/wav",size:8,chunks:1}});await seedZone(h);
    const parts=environmentPlaceables(),drawing:DrawingDocument={_id:"moving-drawing",type:"drawing",name:"Path",ownership:{default:1},flags:{},system:{},
      taggerTags:["cleanup"],kind:"line",points:[100,100,200,100],box:null,stroke:"#ffffff",fill:"none",strokeWidth:2,text:null};
    for(const coll of ["lights","sounds","templates"] as const)for(const data of parts[coll])h.gm.submit([{kind:"create",coll,parent:{coll:"scenes",id:"s1"},data}]);
    h.gm.submit([{kind:"create",coll:"drawings",parent:{coll:"scenes",id:"s1"},data:drawing}]);await flushMicrotasks();
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["click","manual"],gates:{playerRunnable:true},steps:[
      {id:"select",kind:"select",selector:{kind:"tag",query:"cleanup",collections:["drawings","lights","sounds","templates"]}},
      {id:"move",kind:"move",mode:"add",x:150,y:-50,targets:"current",durationMs:60000},
      {id:"chat",kind:"chat",audience:"gm",content:"Private environmental move"},
    ]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex");const received:ClientEvents["ops"][]=[],rejected:ClientEvents["rejected"][]=[];
    bus.on("ops",(msg)=>received.push(msg));bus.on("rejected",(msg)=>rejected.push(msg));
    const before=h.hostStore.seq;
    player.submit([{kind:"update",ref:{coll:"sounds",id:"environment-sound",parent:{coll:"scenes",id:"s1"}},diff:{x:900}}]);await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");expect(h.hostStore.seq).toBe(before);
    h.gm.requestAutomation("zone-graph","s1","manual","t-pl",true);await flushMicrotasks();expect(h.hostStore.seq).toBe(before);
    player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before+1);
    for(const coll of ["lights","sounds","templates"] as const)expect(player.store.get("scenes","s1")?.[coll][0]).toMatchObject({x:450,y:250,flags:{}});
    expect(player.store.get("scenes","s1")?.drawings[0]?.points).toEqual([250,50,350,50]);
    expect(received.flatMap((msg)=>msg.envelope.ops).filter((op)=>op.kind==="update"&&op.ref.parent?.coll==="scenes")).toHaveLength(4);
    expect(JSON.stringify(received)).not.toMatch(/zone-graph|Private environmental move|arenaMove/);
    expect(player.store.getAll("automations")).toEqual([]);expect(player.store.getAll("messages")).toEqual([]);
    const {client:late}=await h.addPlayer(PLAYER_ID,"Rex",{lastSeq:before});
    expect(late.store.get("scenes","s1")?.drawings[0]?.points).toEqual([250,50,350,50]);
    if(restore==="undo")expect(h.host.undo().ok).toBe(true);
    else {const receipt=h.hostStore.getAll("actionReceipts").find((r)=>r.status==="ready");if(!receipt)throw new Error("missing receipt");h.gm.actionRevert(receipt._id);}
    await flushMicrotasks();
    for(const coll of ["lights","sounds","templates"] as const)expect(late.store.get("scenes","s1")?.[coll]).toEqual(parts[coll]);
    expect(late.store.get("scenes","s1")?.drawings).toEqual([drawing]);expect(h.hostStore.get("automations","zone-graph")?.state?.count??0).toBe(0);
    definition.steps.push({id:"max",kind:"sceneLighting",mode:"set",darkness:1},{id:"overflow",kind:"sceneLighting",mode:"add",darkness:1});
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const prior=h.hostStore.seq;h.gm.requestAutomation("zone-graph","s1","manual","t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(prior);expect(h.hostStore.get("scenes","s1")?.drawings).toEqual([drawing]);
    expect(h.hostStore.world.assetManifest[audio]?.name).toBe("fountain.wav");
  });

  test.each([{restore:"undo",flush:false},{restore:"undo",flush:true},{restore:"revert",flush:false},{restore:"revert",flush:true}] as const)("player-triggered environment deletion: $restore restores documents/history (flush $flush)", async ({restore,flush}) => {
    const audio="a".repeat(64);
    const h=await setup({[audio]:{name:"fountain.wav",mime:"audio/wav",size:8,chunks:1}});await seedZone(h);
    const parts=environmentPlaceables();
    for(const coll of ["lights","sounds","templates"] as const) for(const data of parts[coll])
      h.gm.submit([{kind:"create",coll,parent:{coll:"scenes",id:"s1"},data}]);
    await flushMicrotasks();
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["click","manual"],gates:{playerRunnable:true},steps:[
      {id:"sel",kind:"select",selector:{kind:"tag",query:"cleanup",collections:["lights","sounds","templates"]}},
      {id:"tag",kind:"tags",edit:"add",tags:["pending"]},...(flush?[{id:"flush",kind:"batchFlush"} as const]:[]),{id:"delete",kind:"delete"},
      {id:"empty",kind:"filter",test:{kind:"count",min:0,max:0}},
      {id:"chat",kind:"chat",audience:"gm",content:"private cleanup complete"},
    ]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex");
    const received:ClientEvents["ops"][]=[],rejected:ClientEvents["rejected"][]=[];
    bus.on("ops",(msg)=>received.push(msg));bus.on("rejected",(msg)=>rejected.push(msg));
    const before=h.hostStore.seq;
    player.submit([{kind:"delete",ref:{coll:"sounds",id:"environment-sound",parent:{coll:"scenes",id:"s1"}}}]);await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");expect(h.hostStore.seq).toBe(before);
    h.gm.requestAutomation("zone-graph","s1","manual","t-pl",true);await flushMicrotasks();expect(h.hostStore.seq).toBe(before);
    player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before+1);
    for(const coll of ["lights","sounds","templates"] as const) {
      expect(h.hostStore.get("scenes","s1")?.[coll]).toHaveLength(0);
      expect(player.store.get("scenes","s1")?.[coll]).toHaveLength(0);
    }
    expect(received.flatMap((msg)=>msg.envelope.ops).filter((op)=>op.kind==="delete")).toHaveLength(3);
    expect(JSON.stringify(received)).not.toMatch(/zone-graph|private cleanup/);
    if(!flush)expect(JSON.stringify(received)).not.toContain("pending");
    expect(player.store.getAll("automations")).toEqual([]);expect(player.store.getAll("actionReceipts")).toEqual([]);
    expect(h.hostStore.world.assetManifest[audio]?.name).toBe("fountain.wav");
    const {client:late}=await h.addPlayer(PLAYER_ID,"Rex",{lastSeq:before});
    for(const coll of ["lights","sounds","templates"] as const) expect(late.store.get("scenes","s1")?.[coll]).toHaveLength(0);
    if(restore==="undo") expect(h.host.undo().ok).toBe(true);
    else {
      const receipt=h.hostStore.getAll("actionReceipts").find((r)=>r.status==="ready");
      if(!receipt)throw new Error("missing deletion receipt");h.gm.actionRevert(receipt._id);
    }
    await flushMicrotasks();
    for(const coll of ["lights","sounds","templates"] as const) {
      expect(h.hostStore.get("scenes","s1")?.[coll]).toEqual(parts[coll]);
      expect(late.store.get("scenes","s1")?.[coll]).toEqual(parts[coll]);
    }
    expect(h.hostStore.get("automations","zone-graph")?.state?.count??0).toBe(0);
    expect(h.hostStore.getAll("messages")).toEqual([]);
    // A valid staged delete followed by failure must commit neither deletes nor tags.
    definition.steps.push({id:"bad",kind:"sceneLighting",mode:"add",darkness:1},{id:"overflow",kind:"sceneLighting",mode:"add",darkness:1});
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const prior=h.hostStore.seq;h.gm.requestAutomation("zone-graph","s1","manual","t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(prior);expect(h.hostStore.get("scenes","s1")?.sounds).toEqual(parts.sounds);
  });

  test("Delete Entities removes the placeable in the graph envelope and legacy Undo restores it", async () => {
    const h = await setup();
    const sweep: AutomationDocument = { ...zoneDoc(), name: "Sweeper",
      definition: { ...zoneDoc().definition, methods: ["manual"], gates: {},
        steps: [
          { id: "select", kind: "select", selector: { kind: "tag", query: "victim", collections: ["tokens"] } },
          { id: "delete", kind: "delete" },
          { id: "notice", kind: "chat", audience: "gm", content: "swept" },
        ] } };
    h.gm.submit([
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() },
      { kind: "update", ref: { coll: "tokens", id: "t-ivy", parent: { coll: "scenes", id: "s1" } },
        diff: { taggerTags: ["victim"] } },
    ]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "create", coll: "automations", data: sweep }]);
    await flushMicrotasks();
    h.gm.requestAutomation("zone-graph", "s1", "manual");
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")).toBeUndefined();
    expect(h.hostStore.getAll("messages").some((m) => m.content === "swept")).toBe(true);
    const undo = h.host.undo();
    await flushMicrotasks();
    expect(undo.ok).toBe(true);
    const restored = (h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy");
    expect(restored).toBeDefined();
    expect(restored?.taggerTags).toEqual(["victim"]);
  });

  test.each(["undo","revert"] as const)("private Roll Table coordinates move on player invocation and restore with %s",async(restore)=>{
    const h=await setup();await seedZone(h);
    const table:RollTableDocument={_id:"private-locations",type:"rollTable",name:"Secret destinations",ownership:{default:0},flags:{},system:{},formula:"1d2",
      results:[{range:[1,1],text:'{"x":600,"y":400}',documentRef:null},{range:[2,2],text:'{"x":800,"y":600}',documentRef:null}]};
    h.gm.submit([{kind:"create",coll:"rollTables",data:table}]);await flushMicrotasks();
    const definition:AutomationDefinition={...zoneDoc().definition,methods:["click","manual"],gates:{playerRunnable:true},steps:[
      {id:"self",kind:"select",selector:{kind:"tile"}},
      {id:"table",kind:"rollTable",tableId:table._id,audience:"gm"},
      {id:"move",kind:"move",destinationResult:"rollTable",xFormula:"-1d1 * 25",y:50,targets:"current",durationMs:60000},
      {id:"light",kind:"sceneLighting",mode:"set",darkness:0.5},
    ]};
    h.gm.submit([{kind:"update",ref:{coll:"automations",id:"zone-graph"},diff:{definition:definition as unknown as Json}}]);await flushMicrotasks();
    const {client:player,bus}=await h.addPlayer(PLAYER_ID,"Rex");const received:ClientEvents["ops"][]=[],rejected:ClientEvents["rejected"][]=[];
    bus.on("ops",(msg)=>received.push(msg));bus.on("rejected",(msg)=>rejected.push(msg));
    const before=h.hostStore.seq;
    player.submit([{kind:"update",ref:{coll:"rollTables",id:table._id},diff:{formula:"1d1"}}]);await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");expect(h.hostStore.seq).toBe(before);
    h.gm.requestAutomation("zone-graph","s1","manual","t-pl",true);await flushMicrotasks();expect(h.hostStore.seq).toBe(before);expect(h.hostStore.getAll("messages")).toEqual([]);
    player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();expect(h.hostStore.seq).toBe(before+1);
    expect(player.store.get("scenes","s1")?.tiles.find((t)=>t._id==="zone")).toMatchObject({x:475,y:350,flags:{arenaMove:{x:475,y:350,durationMs:60000}}});
    expect(h.hostStore.getAll("messages")).toHaveLength(1);expect(player.store.getAll("messages")).toEqual([]);expect(player.store.getAll("rollTables")).toEqual([]);
    expect(JSON.stringify(received)).not.toMatch(/private-locations|Secret destinations|destinationResult|zone-graph|&quot;/);
    const {client:late}=await h.addPlayer(PLAYER_ID,"Rex",{lastSeq:before});
    expect(late.store.get("scenes","s1")?.tiles.find((t)=>t._id==="zone")).toMatchObject({x:475,y:350});expect(late.store.getAll("rollTables")).toEqual([]);
    if(restore==="undo")expect(h.host.undo().ok).toBe(true);
    else {const receipt=h.hostStore.getAll("actionReceipts").find((r)=>r.status==="ready");if(!receipt)throw new Error("missing receipt");h.gm.actionRevert(receipt._id);}
    await flushMicrotasks();expect(late.store.get("scenes","s1")?.tiles.find((t)=>t._id==="zone")).toMatchObject({x:100,y:100});
    expect(h.hostStore.getAll("messages")).toEqual([]);expect(h.hostStore.get("automations","zone-graph")?.state?.count??0).toBe(0);
    // Live table edits, not a stale saved point, determine the next run.
    h.gm.submit([{kind:"update",ref:{coll:"rollTables",id:table._id},diff:{results:[{range:[1,2],text:'{"x":"bad","y":400}',documentRef:null}]}}]);await flushMicrotasks();
    const seq=h.hostStore.seq;player.requestAutomationClick("s1","zone",{x:150,y:150},"t-pl");await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq);expect(h.hostStore.getAll("messages")).toEqual([]);expect(h.hostStore.get("scenes","s1")?.darkness).toBe(0);
  });

  test("Roll Table rolls on the host RNG, posts a scene or GM-only message and stores the variable", async () => {
    const h = await setup();
    const table = { _id: "fate", type: "rollTable" as const, name: "Fate", ownership: { default: 1 as const },
      flags: {}, system: {}, formula: "1d20",
      results: [
        { range: [1, 10] as [number, number], text: "fortune", documentRef: null },
        { range: [11, 20] as [number, number], text: "calamity", documentRef: null },
      ] };
    const graph: AutomationDocument = { ...zoneDoc(), name: "Fortune",
      definition: { ...zoneDoc().definition, methods: ["manual"], gates: {},
        steps: [
          { id: "roll", kind: "rollTable", tableId: "fate", audience: "gm", variable: "fate" },
          { id: "notice", kind: "chat", audience: "gm", content: "fate: {{fate}}" },
        ] } };
    h.gm.submit([
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() },
      { kind: "create", coll: "rollTables", data: table },
    ]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "create", coll: "automations", data: graph }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const playerMessages: MessageDocument[] = [];
    bus.on("ops", (msg) => {
      for (const op of msg.envelope.ops) if (op.kind === "create" && op.coll === "messages")
        playerMessages.push(op.data as MessageDocument);
    });
    h.gm.requestAutomation("zone-graph", "s1", "manual");
    await flushMicrotasks();
    const messages = h.hostStore.getAll("messages") as MessageDocument[];
    // setup()'s deterministic rng: 0.25 → 1d20 = 6 → "fortune"
    expect(messages.find((m) => m.name === "Roll table: Fate"))
      .toMatchObject({ content: "fortune", whisper: [GM_ID], roll: { formula: "1d20", total: 6 } });
    expect(messages.some((m) => m.content === "fate: fortune")).toBe(true);
    const before = h.hostStore.seq;
    h.gm.requestAutomation("zone-graph", "s1", "manual");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1); // one envelope: table message + interpolated chat
    expect(player.store.getAll("messages")).toHaveLength(0); // GM-only audience never reaches the player
  });
});

describe("GM prefabs: atomic Tagger allocation, graph rebind, projection and undo", () => {
  test("two placements target only their own tagged door; a hidden child and private template never project", async () => {
    const secretArt = "e".repeat(64);
    const h = await setup({ [secretArt]: { name: "GM-only-token.webp", mime: "image/webp",
      size: 5, chunks: 1, visibility: "referenced" } });
    await seedZone(h);
    const sourceDoor: WallDocument = { _id: "source-door", type: "wall", name: "Linked door",
      ownership: { default: 3 }, flags: {}, system: {}, taggerTags: ["door-{#}"],
      c: [100, 100, 300, 100], move: 1, sight: 1, sound: 1, light: 1, door: 0, oneWay: false };
    const sourceChild = tokenDoc("shadow", { x: 150, y: 150, width: 30, height: 30,
      hidden: true, img: secretArt, taggerTags: ["shadow-{id}"] });
    h.gm.submit([{ kind: "create", coll: "walls", parent: { coll: "scenes", id: "s1" }, data: sourceDoor },
      { kind: "create", coll: "tokens", parent: { coll: "scenes", id: "s1" }, data: sourceChild }]);
    await flushMicrotasks();
    const definition = { ...zoneDoc().definition, methods: ["click" as const],
      gates: { playerRunnable: true }, steps: [
        { id: "target", kind: "select" as const, selector: { kind: "tag" as const,
          query: "door-{#}", collections: ["walls" as const],
          includeRefs: [{ coll: "walls" as const, id: "source-door",
            parent: { coll: "scenes" as const, id: "s1" } }] } },
        { id: "open", kind: "door" as const, mode: "open" as const },
      ] };
    const prefab: PrefabDocument = { _id: "trap-prefab", type: "prefab", name: "Private gate trap",
      ownership: { default: 3 }, flags: { core: { private: "GRAPH SOURCE SECRET" } }, system: {},
      definition: { version: 1, sourceSceneId: "s1", gridSize: 100, origin: { x: 100, y: 100 },
        parts: [
          { id: "zone", coll: "tiles", doc: { ...zoneTile(), taggerTags: ["trap-{#}"] } },
          { id: "source-door", coll: "walls", parentId: "zone", locked: true, doc: sourceDoor },
          { id: "shadow", coll: "tokens", parentId: "source-door", doc: sourceChild },
        ], graphs: [{ id: "zone-graph", doc: { ...zoneDoc(), definition } }] },
    };
    h.gm.submit([{ kind: "create", coll: "prefabs", data: prefab }]);
    await flushMicrotasks();
    expect(h.hostStore.getAll("prefabs")).toHaveLength(1);
    const { client: player, bus, pair } = await h.addPlayer(PLAYER_ID, "Rex");
    const gmResults: ClientEvents["prefabResult"][] = [], playerResults: ClientEvents["prefabResult"][] = [];
    const denied: ClientEvents["rejected"][] = [];
    h.gmBus.on("prefabResult", (v) => gmResults.push(v));
    bus.on("prefabResult", (v) => playerResults.push(v));
    bus.on("rejected", (v) => denied.push(v));
    expect(player.store.getAll("prefabs")).toEqual([]);
    expect(player.store.world.assetManifest[secretArt]).toBeUndefined();
    const before = h.hostStore.seq;
    pair.b.send("ops", frameMessage({ kind: "prefab.place", requestId: "guess", prefabId: prefab._id,
      sceneId: "s1", at: { x: 400, y: 400 } }));
    await flushMicrotasks();
    expect(denied.at(-1)).toMatchObject({ reason: "forbidden", detail: "prefab placement unavailable" });
    expect(h.hostStore.seq).toBe(before);
    h.gm.requestPrefabPlace(prefab._id, "s1", { x: 400, y: 400 });
    await flushMicrotasks();
    expect(gmResults.at(-1)).toMatchObject({ ok: true, seq: before + 1 });
    expect(h.hostStore.seq).toBe(before + 1); // tile, wall, hidden token and graph in ONE envelope
    h.gm.requestPrefabPlace(prefab._id, "s1", { x: 700, y: 400 });
    await flushMicrotasks();
    expect(gmResults.at(-1)).toMatchObject({ ok: true, seq: before + 2 });
    expect(playerResults).toEqual([]);
    const state = h.hostStore.get("scenes", "s1") as SceneDocument;
    const a = state.tiles.find((t) => t.taggerTags?.includes("trap-2"));
    const b = state.tiles.find((t) => t.taggerTags?.includes("trap-3"));
    const wa = state.walls.find((w) => w.taggerTags?.includes("door-2"));
    const wb = state.walls.find((w) => w.taggerTags?.includes("door-3"));
    expect(a && b && wa && wb).toBeTruthy();
    expect(state.tokens.filter((t) => t.name === "Token shadow" && t._id !== "shadow")).toHaveLength(2);
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.some((t) => t.name === "Token shadow")).toBe(false);
    expect(player.store.world.assetManifest[secretArt]).toBeUndefined();
    const playerScene = player.store.get("scenes", "s1") as SceneDocument;
    expect(playerScene.tiles.find((t) => t._id === a?._id)?.flags.prefab).toBeUndefined();
    expect(playerScene.walls.find((w) => w._id === wa?._id)?.flags.prefab).toBeUndefined();
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.some((t) => t._id === a?._id)).toBe(true);
    expect(player.store.getAll("automations")).toEqual([]);
    expect(JSON.stringify(player.store.world)).not.toContain("GRAPH SOURCE SECRET");
    const graphs = h.hostStore.getAll("automations").filter((g) => g.flags.prefab);
    expect(graphs).toHaveLength(2);
    expect(graphs.map((g) => g.definition.steps[0])).toEqual([
      expect.objectContaining({ selector: expect.objectContaining({ query: "door-2", includeRefs: [
        { coll: "walls", id: wa?._id, parent: { coll: "scenes", id: "s1" } },
      ] }) }),
      expect.objectContaining({ selector: expect.objectContaining({ query: "door-3", includeRefs: [
        { coll: "walls", id: wb?._id, parent: { coll: "scenes", id: "s1" } },
      ] }) }),
    ]);
    player.requestAutomationClick("s1", a?._id ?? "", { x: 450, y: 450 });
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).walls.find((w) => w._id === wa?._id)?.door).toBe(1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).walls.find((w) => w._id === wb?._id)?.door).toBe(0);
    player.requestAutomationClick("s1", b?._id ?? "", { x: 750, y: 450 });
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).walls.find((w) => w._id === wb?._id)?.door).toBe(1);
    expect(h.hostStore.getAll("automations").filter((g) => g.flags.prefab).map((g) => g.state?.count))
      .toEqual([1, 1]);
    const originalDoor = [...wa?.c ?? []];
    const instance = (a?.flags.prefab as { instanceId: string } | undefined)?.instanceId;
    const hidden = state.tokens.find((t) =>
      (t.flags.prefab as { instanceId?: string } | undefined)?.instanceId === instance);
    const originalHidden = { x: hidden?.x, y: hidden?.y };
    const forbidden: string[] = [];
    bus.on("rejected", (m) => forbidden.push(m.reason));
    player.submit([{ kind: "update", ref: { coll: "walls", id: wa?._id ?? "",
      parent: { coll: "scenes", id: "s1" } }, diff: { door: 0 } },
    ]);
    player.submit([{ kind: "update", ref: tokenRef, diff: {
      "flags.prefab": { instanceId: instance, rootId: a?._id } as Json,
    } }]);
    await flushMicrotasks();
    expect(forbidden).toEqual(["forbidden", "forbidden"]); // even if wall is public/owned
    const seqBeforeMove = h.hostStore.seq;
    h.gm.submit([{ kind: "update", ref: { coll: "tiles", id: a?._id ?? "",
      parent: { coll: "scenes", id: "s1" } }, diff: { x: 500, y: 500, rotation: 90 } }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seqBeforeMove + 1);
    expect(h.hostLog.at(h.hostStore.seq)?.env.ops).toHaveLength(3); // root + locked wall + hidden nested token
    const moved = h.hostStore.get("scenes", "s1") as SceneDocument;
    expect(moved.walls.find((w) => w._id === wa?._id)?.c).not.toEqual(originalDoor);
    expect(moved.tokens.find((t) => t._id === hidden?._id)).not.toMatchObject(originalHidden);
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.some((t) => t._id === hidden?._id)).toBe(false);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).walls.find((w) => w._id === wa?._id)?.c)
      .toEqual(originalDoor);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === hidden?._id))
      .toMatchObject(originalHidden);
    h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: hidden?._id ?? "",
      parent: { coll: "scenes", id: "s1" } }, diff: { hidden: false } }]);
    await flushMicrotasks();
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.some((t) => t._id === hidden?._id)).toBe(true);
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === hidden?._id)?.flags.prefab)
      .toBeUndefined();
    expect(player.store.world.assetManifest[secretArt]?.name).toBe("GM-only-token.webp");
    h.gm.submit([{ kind: "update", ref: { coll: "tokens", id: hidden?._id ?? "",
      parent: { coll: "scenes", id: "s1" } }, diff: { hidden: true } }]);
    await flushMicrotasks();
    expect(player.store.world.assetManifest[secretArt]).toBeUndefined();
    h.host.removeSession(`peer-${PLAYER_ID}`);
    const pair2 = createTransportPair();
    h.host.addSession(`peer-${PLAYER_ID}`, pair2.a);
    player.reattach(pair2.b);
    await flushMicrotasks();
    expect(player.store.getAll("prefabs")).toEqual([]);
    expect(player.store.getAll("automations")).toEqual([]);
    expect((player.store.get("scenes", "s1") as SceneDocument).tokens.some((t) => t._id === hidden?._id)).toBe(false);
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.find((t) => t._id === a?._id)?.flags.prefab)
      .toBeUndefined();
    expect((player.store.get("scenes", "s1") as SceneDocument).walls.find((w) => w._id === wa?._id)?.flags.prefab)
      .toBeUndefined();
    h.gm.submit([{ kind: "delete", ref: { coll: "tiles", id: b?._id ?? "",
      parent: { coll: "scenes", id: "s1" } } }]);
    await flushMicrotasks();
    expect(h.hostLog.at(h.hostStore.seq)?.env.ops).toHaveLength(4); // auto delete graph + wall + hidden child
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles.some((t) => t._id === b?._id)).toBe(false);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).walls.some((w) => w._id === wb?._id)).toBe(false);
    expect(h.hostStore.getAll("automations").filter((g) => g.flags.prefab)).toHaveLength(1);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(h.hostStore.getAll("automations").filter((g) => g.flags.prefab)).toHaveLength(2);
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.some((t) => t._id === b?._id)).toBe(true);
  });

  test("an owned wall root carries locked and hidden descendants atomically without leaking hidden IDs", async () => {
    const h = await setup();
    const root: WallDocument = { _id: "prefab-wall-root", type: "wall", name: "Public wall root",
      ownership: { default: 3 }, flags: {}, system: {}, c: [100, 100, 200, 100],
      door: 0, oneWay: false, move: 1, sight: 1, sound: 1, light: 1 };
    const childTile: TileDocument = { ...zoneTile(), _id: "locked-platform", name: "Locked platform",
      ownership: { default: 3 }, x: 200, y: 100, width: 100, height: 100 };
    const secretChild = tokenDoc("hidden-descendant", { x: 350, y: 120, width: 40, height: 40, hidden: true });
    const prefab: PrefabDocument = { _id: "wall-root-prefab", type: "prefab", name: "Wall root",
      ownership: { default: 0 }, flags: {}, system: {}, definition: {
        version: 1, sourceSceneId: "s1", gridSize: 100, origin: { x: 100, y: 100 },
        parts: [
          { id: root._id, coll: "walls", doc: root },
          { id: childTile._id, coll: "tiles", parentId: root._id, locked: true, doc: childTile },
          { id: secretChild._id, coll: "tokens", parentId: childTile._id, doc: secretChild },
        ], graphs: [],
      } };
    h.gm.submit([{ kind: "create", coll: "prefabs", data: prefab }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    const projected: OpEnvelope[] = [];
    bus.on("rejected", (event) => rejected.push(event));
    bus.on("ops", (event) => projected.push(event.envelope));
    const results: ClientEvents["prefabResult"][] = [];
    h.gmBus.on("prefabResult", (event) => results.push(event));
    h.gm.requestPrefabPlace(prefab._id, "s1", { x: 400, y: 400 });
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ ok: true });
    const placedScene = h.hostStore.get("scenes", "s1") as SceneDocument;
    const placedWall = placedScene.walls.find((doc) =>
      (doc.flags.prefab as { instanceId?: string } | undefined)?.instanceId === results.at(-1)?.instanceId);
    const instanceId = (placedWall?.flags.prefab as { instanceId?: string } | undefined)?.instanceId;
    const placedTile = placedScene.tiles.find((doc) =>
      (doc.flags.prefab as { instanceId?: string } | undefined)?.instanceId === instanceId);
    const placedToken = placedScene.tokens.find((doc) =>
      (doc.flags.prefab as { instanceId?: string } | undefined)?.instanceId === instanceId);
    if (!placedWall || !placedTile || !placedToken) throw new Error("prefab descendants were not placed");
    expect(placedWall.c).toEqual([400, 400, 500, 400]);
    expect(player.store.get("scenes", "s1")?.walls.some((doc) => doc._id === placedWall._id)).toBe(true);
    expect(player.store.get("scenes", "s1")?.tiles.some((doc) => doc._id === placedTile._id)).toBe(true);
    expect(player.store.get("scenes", "s1")?.tokens.some((doc) => doc._id === placedToken._id)).toBe(false);

    const beforeLockedEdit = h.hostStore.seq;
    player.submit([{ kind: "update", ref: { coll: "tiles", id: placedTile._id,
      parent: { coll: "scenes", id: "s1" } }, diff: { x: placedTile.x + 1 } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect(h.hostStore.seq).toBe(beforeLockedEdit);

    const beforeMove = h.hostStore.seq;
    player.submit([{ kind: "update", ref: { coll: "walls", id: placedWall._id,
      parent: { coll: "scenes", id: "s1" } }, diff: { c: [400, 400, 400, 600] } }]);
    await flushMicrotasks();
    expect(rejected).toHaveLength(1);
    expect(h.hostStore.seq).toBe(beforeMove + 1);
    expect(h.hostLog.at(h.hostStore.seq)?.env.ops).toHaveLength(3);
    const moved = h.hostStore.get("scenes", "s1") as SceneDocument;
    expect(moved.walls.find((doc) => doc._id === placedWall._id)?.c).toEqual([400, 400, 400, 600]);
    expect(moved.tiles.find((doc) => doc._id === placedTile._id))
      .toMatchObject({ x: 200, y: 600, width: 200, height: 200, rotation: 90 });
    expect(moved.tokens.find((doc) => doc._id === placedToken._id))
      .toMatchObject({ x: 280, y: 900, width: 80, height: 80, rotation: 90 });
    expect(player.store.get("scenes", "s1")?.tokens.some((doc) => doc._id === placedToken._id)).toBe(false);
    expect(JSON.stringify(projected)).not.toContain(placedToken._id);

    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    const restored = h.hostStore.get("scenes", "s1") as SceneDocument;
    expect(restored.walls.find((doc) => doc._id === placedWall._id)?.c).toEqual([400, 400, 500, 400]);
    expect(restored.tiles.find((doc) => doc._id === placedTile._id))
      .toMatchObject({ x: 500, y: 400, width: 100, height: 100, rotation: 0 });
    expect(restored.tokens.find((doc) => doc._id === placedToken._id))
      .toMatchObject({ x: 650, y: 420, width: 40, height: 40, rotation: 0 });
    expect(player.store.get("scenes", "s1")?.tokens.some((doc) => doc._id === placedToken._id)).toBe(false);

    const beforeRejectedMove = h.hostStore.seq;
    player.submit([{ kind: "update", ref: { coll: "walls", id: placedWall._id,
      parent: { coll: "scenes", id: "s1" } }, diff: { c: [720, 400, 820, 400] } }]);
    await flushMicrotasks();
    const refusal = rejected.at(-1);
    expect(refusal).toMatchObject({ reason: "invariant", detail: "attached child would lie outside scene bounds" });
    expect(refusal?.detail).not.toContain(placedToken._id);
    expect(h.hostStore.seq).toBe(beforeRejectedMove);
  });

  test("region prefab roots carry descendants in one undoable host commit and remain GM-authored", async () => {
    const h = await setup();
    const polygon = { kind: "polygon" as const, points: [[0, 0], [1, 0], [1, 1], [0, 1]] as Array<[number, number]> };
    const root: RegionDocument = { _id: "root-region", type: "region", name: "Public region root",
      ownership: { default: 3 }, flags: {}, system: {}, x: 200, y: 200, width: 100, height: 100,
      rotation: 0, shape: polygon };
    const childTile: TileDocument = { ...zoneTile(), _id: "child-tile", name: "Region child",
      ownership: { default: 3 }, x: 300, y: 200, width: 100, height: 100 };
    const secretChild = tokenDoc("hidden-region-child", { x: 320, y: 220, width: 40, height: 40, hidden: true });
    const regionGraph: AutomationDocument = { ...zoneDoc(), _id: "region-root-graph",
      definition: { ...zoneDoc().definition, sourceKind: "region", tileId: root._id,
        methods: ["manual"], steps: [{ id: "region-stop", kind: "stop" }] } };
    const prefab: PrefabDocument = { _id: "region-root-prefab", type: "prefab", name: "Region root",
      ownership: { default: 0 }, flags: {}, system: {}, definition: {
        version: 1, sourceSceneId: "s1", gridSize: 100, origin: { x: 250, y: 250 },
        parts: [
          { id: root._id, coll: "regions", doc: root },
          { id: childTile._id, coll: "tiles", parentId: root._id, doc: childTile },
          { id: secretChild._id, coll: "tokens", parentId: childTile._id, doc: secretChild },
        ], graphs: [{ id: regionGraph._id, doc: regionGraph }],
      } };
    h.gm.submit([{ kind: "create", coll: "prefabs", data: prefab }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("rejected", (event) => rejected.push(event));
    const results: ClientEvents["prefabResult"][] = [];
    h.gmBus.on("prefabResult", (event) => results.push(event));
    h.gm.requestPrefabPlace(prefab._id, "s1", { x: 500, y: 500 });
    await flushMicrotasks();
    const placedScene = h.hostStore.get("scenes", "s1") as SceneDocument;
    const instanceId = results.at(-1)?.instanceId;
    const placedRegion = placedScene.regions?.find((doc) =>
      (doc.flags.prefab as { instanceId?: string } | undefined)?.instanceId === instanceId);
    const placedTile = placedScene.tiles.find((doc) =>
      (doc.flags.prefab as { instanceId?: string } | undefined)?.instanceId === instanceId);
    const placedToken = placedScene.tokens.find((doc) =>
      (doc.flags.prefab as { instanceId?: string } | undefined)?.instanceId === instanceId);
    const placedGraph = h.hostStore.getAll("automations").find((doc) =>
      (doc.flags.prefab as { instanceId?: string } | undefined)?.instanceId === instanceId);
    if (!placedRegion || !placedTile || !placedToken || !placedGraph)
      throw new Error("region prefab descendants or bound graph were not placed");
    expect(placedGraph.definition).toMatchObject({ sourceKind: "region", tileId: placedRegion._id, sceneId: "s1" });
    expect(player.store.getAll("automations").some((doc) => doc._id === placedGraph._id)).toBe(false);
    expect(player.store.get("scenes", "s1")?.regions?.some((doc) => doc._id === placedRegion._id)).toBe(true);
    expect(player.store.get("scenes", "s1")?.regions?.find((doc) => doc._id === placedRegion._id)?.flags.prefab)
      .toBeUndefined();
    expect(player.store.get("scenes", "s1")?.tokens.some((doc) => doc._id === placedToken._id)).toBe(false);

    const beforeDenied = h.hostStore.seq;
    player.submit([{ kind: "update", ref: { coll: "regions", id: placedRegion._id,
      parent: { coll: "scenes", id: "s1" } }, diff: { x: 510 } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect(h.hostStore.seq).toBe(beforeDenied);

    const beforeMove = h.hostStore.seq;
    h.gm.submit([{ kind: "update", ref: { coll: "regions", id: placedRegion._id,
      parent: { coll: "scenes", id: "s1" } }, diff: { x: 600, y: 600, width: 200, height: 200, rotation: 90 } }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(beforeMove + 1);
    expect(h.hostLog.at(h.hostStore.seq)?.env.ops).toHaveLength(3);
    const moved = h.hostStore.get("scenes", "s1") as SceneDocument;
    expect(moved.regions?.find((doc) => doc._id === placedRegion._id))
      .toMatchObject({ x: 600, y: 600, width: 200, height: 200, rotation: 90, shape: polygon });
    expect(moved.tiles.find((doc) => doc._id === placedTile._id))
      .toMatchObject({ x: 600, y: 800, width: 200, height: 200, rotation: 90 });
    expect(moved.tokens.find((doc) => doc._id === placedToken._id))
      .toMatchObject({ x: 680, y: 840, width: 80, height: 80, rotation: 90 });
    expect(player.store.get("scenes", "s1")?.tokens.some((doc) => doc._id === placedToken._id)).toBe(false);

    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    const restored = h.hostStore.get("scenes", "s1") as SceneDocument;
    expect(restored.regions?.find((doc) => doc._id === placedRegion._id))
      .toMatchObject({ x: 450, y: 450, width: 100, height: 100, rotation: 0 });
    expect(restored.tiles.find((doc) => doc._id === placedTile._id))
      .toMatchObject({ x: 550, y: 450, width: 100, height: 100, rotation: 0 });
    expect(restored.tokens.find((doc) => doc._id === placedToken._id))
      .toMatchObject({ x: 570, y: 470, width: 40, height: 40, rotation: 0 });
    const beforeDespawn = h.hostStore.seq;
    h.gm.submit([{ kind: "delete", ref: { coll: "regions", id: placedRegion._id,
      parent: { coll: "scenes", id: "s1" } } }]);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(beforeDespawn + 1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).regions?.some((doc) => doc._id === placedRegion._id))
      .toBe(false);
    expect(h.hostStore.get("automations", placedGraph._id)).toBeUndefined();
  });

  test("failed template dependency/asset preflight preserves world; prefab placement is undoable", async () => {
    const h = await setup();
    await seedZone(h);
    const broken: PrefabDocument = { _id: "simple-prefab", type: "prefab", name: "Simple",
      ownership: { default: 0 }, flags: {}, system: {}, definition: {
        version: 1, sourceSceneId: "s1", gridSize: 100, origin: { x: 100, y: 100 },
        parts: [{ id: "zone", coll: "tiles", doc: { ...zoneTile(), taggerTags: ["copy-{#}"] } }],
        graphs: [{ id: "zone-graph", doc: { ...zoneDoc(), definition: { ...zoneDoc().definition,
          methods: ["click"], steps: [{ id: "missing", kind: "sequence", macroId: "missing-fx", audience: "scene" }] } } }],
      } };
    h.gm.submit([{ kind: "create", coll: "prefabs", data: broken }]);
    await flushMicrotasks();
    const results: ClientEvents["prefabResult"][] = [];
    h.gmBus.on("prefabResult", (m) => results.push(m));
    const start = h.hostStore.seq;
    h.gm.requestPrefabPlace(broken._id, "s1", { x: 400, y: 400 });
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ ok: false, detail: expect.stringMatching(/missing or unreviewed/) });
    expect(h.hostStore.seq).toBe(start);
    h.gm.submit([{ kind: "update", ref: { coll: "prefabs", id: broken._id }, diff: {
      definition: { ...broken.definition, graphs: [] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const before = h.hostStore.seq;
    h.gm.requestPrefabPlace(broken._id, "s1", { x: 400, y: 400 });
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ ok: true, seq: before + 1 });
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles).toHaveLength(2);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles).toHaveLength(1);
  });

  test("duplicate GM placement ID cannot clone twice, including after transport reattach", async () => {
    const h = await setup();
    await seedZone(h);
    const p: PrefabDocument = { _id: "one-tile", type: "prefab", name: "Copy tile",
      ownership: { default: 0 }, flags: {}, system: {}, definition: {
        version: 1, sourceSceneId: "s1", gridSize: 100, origin: { x: 100, y: 100 },
        parts: [{ id: "zone", coll: "tiles", doc: zoneTile() }], graphs: [],
      } };
    h.gm.submit([{ kind: "create", coll: "prefabs", data: p }]);
    await flushMicrotasks();
    const pair = createTransportPair();
    h.host.addSession("another-gm", pair.a, gmSessionUser(GM_ID));
    const request = { kind: "prefab.place" as const, requestId: "once", prefabId: p._id,
      sceneId: "s1", at: { x: 400, y: 400 } };
    const before = h.hostStore.seq;
    pair.b.send("ops", frameMessage(request));
    pair.b.send("ops", frameMessage(request));
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles).toHaveLength(2);
    h.host.removeSession("another-gm");
    const again = createTransportPair();
    h.host.addSession("another-gm", again.a, gmSessionUser(GM_ID));
    again.b.send("ops", frameMessage(request));
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
  });

  test("reviewed GM script may place allowlisted prefab, never a caller-supplied different one", async () => {
    const runner: ScriptRunner = async (_source, args, _ctx, action) => {
      await expect(action("prefabs.place", { prefabId: "gm-secret", at: { x: 600, y: 400 } }, () => true))
        .rejects.toThrow(/not approved/);
      // Even allowlisted elevated code must not reveal a hidden scene's tag
      // occupancy by returning a generated visible tag with a skipped ordinal.
      await expect(action("prefabs.place", { prefabId: "numbered-gate", at: { x: 600, y: 400 } }, () => true))
        .rejects.toThrow(/GM caller/);
      return action("prefabs.place", { prefabId: "public-gate", at: { x: args.x, y: args.y } }, () => true);
    };
    const h = await setup({}, runner);
    await seedZone(h);
    const authored = (id: string): PrefabDocument => ({ _id: id, type: "prefab", name: id,
      ownership: { default: 0 }, flags: { core: { internal: "GM-SOURCE-ONLY" } }, system: {},
      definition: { version: 1, sourceSceneId: "s1", gridSize: 100, origin: { x: 100, y: 100 },
        parts: [{ id: "zone", coll: "tiles", doc: zoneTile() }], graphs: [] } });
    const policy: Omit<ScriptPolicy, "approvedHash"> = { version: 1, sceneId: "s1", runAs: "gm",
      playerCallable: true, grants: ["prefabs.place"], prefabIds: ["public-gate", "numbered-gate"],
      inputs: [{ name: "x", type: "number", required: true }, { name: "y", type: "number", required: true }] };
    const source = "return await api.prefabs.place('public-gate', args.x, args.y);";
    const script: MacroDocument = { _id: "place-gate", type: "macro", kind: "script", name: "Place gate",
      flags: {}, system: {}, ownership: { default: 1 }, command: source,
      script: { ...policy, approvedHash: await scriptApprovalHash(source, policy) } };
    const numbered = authored("numbered-gate");
    numbered.definition.parts[0] = { id: "zone", coll: "tiles", doc: { ...zoneTile(),
      taggerTags: ["guard-{#}"] } };
    h.gm.submit([{ kind: "create", coll: "prefabs", data: authored("public-gate") },
      { kind: "create", coll: "prefabs", data: numbered },
      { kind: "create", coll: "prefabs", data: authored("gm-secret") },
      { kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    expect(player.store.getAll("prefabs")).toHaveLength(0);
    expect(JSON.stringify(player.store.get("macros", script._id))).not.toContain("public-gate");
    const before = h.hostStore.seq;
    const requestId = player.requestMacro(script._id, { x: 400, y: 400 });
    const result = await awaitMacroResult(bus, requestId);
    await flushMicrotasks();
    expect(result.ok).toBe(true);
    expect(h.hostStore.seq).toBe(before + 3); // invocation, prefab+receipt, finalized receipt
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles).toHaveLength(2);
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles).toHaveLength(2);
    expect(JSON.stringify(player.store.world)).not.toContain("GM-SOURCE-ONLY");
  });
});

describe("scene clone automation rebinding (A17)", () => {
  test("one host envelope publishes a copied graph that opens only its copied tagged door", async () => {
    const h = await setup();
    await seedZone(h);
    const sourceDoor: WallDocument = { _id: "clone-door", type: "wall", name: "Clone door",
      ownership: { default: 3 }, flags: {}, system: {}, c: [300, 100, 500, 100],
      taggerTags: ["door-{id}"], move: 1, sight: 1, sound: 1, light: 1, door: 0, oneWay: false };
    h.gm.submit([{ kind: "create", coll: "walls", parent: { coll: "scenes", id: "s1" }, data: sourceDoor }]);
    await flushMicrotasks();
    const graph: AutomationDocument = { ...zoneDoc(), _id: "clone-door-graph", name: "Open cloned door",
      definition: { version: 1, sceneId: "s1", tileId: "zone", methods: ["manual"], gates: {}, steps: [
        { id: "target", kind: "select", selector: { kind: "tag", query: "door-{id}",
          collections: ["walls"], includeRefs: [{ coll: "walls", id: sourceDoor._id,
            parent: { coll: "scenes", id: "s1" } }] } },
        { id: "open", kind: "door", mode: "open" },
      ] } };
    h.gm.submit([{ kind: "create", coll: "automations", data: graph }]);
    await flushMicrotasks();

    const source = h.hostStore.get("scenes", "s1") as SceneDocument;
    let n = 0;
    const planned = planDuplicateSceneOps({ scene: source, id: "scene-clone", name: "Copied trap",
      world: h.hostStore.world, nextId: (kind) => `${kind}-copy-${(n += 1)}` });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    const rejected: ClientEvents["rejected"][] = [];
    h.gmBus.on("rejected", (message) => rejected.push(message));
    const seqBeforeCopy = h.hostStore.seq;
    h.gm.submit(planned.ops);
    await flushMicrotasks();
    expect(rejected).toEqual([]);
    expect(h.hostStore.seq).toBe(seqBeforeCopy + 1);
    expect(h.hostLog.at(h.hostStore.seq)?.env.ops.filter((op) => op.kind === "create"))
      .toHaveLength(1 + h.hostStore.getAll("automations").filter((doc) => doc.definition.sceneId === "scene-clone").length);

    const copy = h.hostStore.get("scenes", "scene-clone") as SceneDocument;
    const copiedDoor = copy.walls.find((wall) => wall._id !== sourceDoor._id);
    const copiedGraph = h.hostStore.getAll("automations").find((candidate) =>
      candidate.name === "Open cloned door (copy)");
    if (!copiedDoor || !copiedGraph) throw new Error("scene clone omitted its graph or tagged door");
    expect(copiedDoor.taggerTags).toEqual([`door-${copiedDoor._id}`]);
    expect(copiedGraph.definition.sceneId).toBe(copy._id);
    expect(copiedGraph.definition.tileId).toBe(copy.tiles[0]?._id);
    expect(copiedGraph.definition.steps[0]).toMatchObject({ selector: { query: `door-${copiedDoor._id}`,
      includeRefs: [{ coll: "walls", id: copiedDoor._id, parent: { coll: "scenes", id: copy._id } }] } });
    expect(copiedGraph.state).toBeUndefined();

    h.gm.requestAutomation(copiedGraph._id, copy._id, "manual");
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", copy._id) as SceneDocument).walls
      .find((wall) => wall._id === copiedDoor._id)?.door).toBe(1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).walls
      .find((wall) => wall._id === sourceDoor._id)?.door).toBe(0);
  });
});

async function reviewedScript(
  policyChanges: Partial<Omit<ScriptPolicy, "approvedHash">> = {},
  docChanges: Partial<MacroDocument> = {},
): Promise<MacroDocument> {
  const source = "// GM ONLY: literal secret marker — must never be projected\nreturn await api.tags.find(args.target);";
  const policy: Omit<ScriptPolicy, "approvedHash"> = {
    version: 1, sceneId: "s1", runAs: "gm", playerCallable: true,
    grants: ["tags.read", "tags.write", "chat"],
    inputs: [{ name: "target", type: "token", required: true }], ...policyChanges,
  };
  return { _id: "script-reviewed", type: "macro", kind: "script", name: "Reviewed opener",
    ownership: { default: 1 }, flags: { core: { playerCallable: true } }, system: { private: "NO PROJECT" },
    command: source, script: { ...policy, approvedHash: await scriptApprovalHash(source, policy) },
    ...docChanges };
}

function awaitMacroResult(bus: EventBus<ClientEvents>, requestId: string): Promise<ClientEvents["macroResult"]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`macro result timed out: ${requestId}`)); }, 3000);
    const off = bus.on("macroResult", (msg) => {
      if (msg.requestId !== requestId) return;
      clearTimeout(timer);
      off();
      resolve(msg);
    });
  });
}

describe("GM-reviewed scripted macros: authority, projection, persistence", () => {
  test("Tagger cross-scene reads and elevated bulk writes are scoped and reprojected for the actual caller", async () => {
    const remoteRef = { coll: "tokens", id: "same", parent: { coll: "scenes", id: "s2" } };
    const hiddenRef = { coll: "tiles", id: "secret", parent: { coll: "scenes", id: "s2" } };
    const privateRef = { coll: "tokens", id: "priv", parent: { coll: "scenes", id: "s3" } };
    const h = await setup({}, async (_source, _args, context, action) => {
      expect(context.callerId).toBe(PLAYER_ID);
      const local = await action("tags.find", { query: "portal", options: {
        collections: ["tokens", "tiles"],
      } }, () => true) as Array<{ sceneId: string; ref: { id: string } }>;
      expect(local.map((entry) => entry.sceneId)).toEqual(["s1", "s1"]);
      const distant = await action("tags.find", { query: "portal", options: { sceneId: "s2",
        collections: ["tokens", "tiles"] } }, () => true) as Array<{ sceneId: string; ref: unknown }>;
      expect(distant).toMatchObject([{ sceneId: "s2", ref: remoteRef }]);
      expect(distant).toHaveLength(1); // private tile never enters player results
      const grouped = await action("tags.find", { query: "portal", options: {
        allScenes: true, groupByScene: true, collections: ["tokens", "tiles"],
      } }, () => true) as Record<string, Array<{ ref: unknown }>>;
      expect(Object.keys(grouped)).toEqual(["s1", "s2"]);
      expect(grouped.s2).toMatchObject([{ ref: remoteRef }]);
      const pinned = await action("tags.find", { query: "portal", options: {
        allScenes: true, includeRefs: [remoteRef],
      } }, () => true);
      expect(pinned).toMatchObject([{ sceneId: "s2", ref: remoteRef }]);
      expect(await action("tags.get", { ref: remoteRef }, () => true)).toEqual(["portal"]);
      await expect(action("tags.get", { ref: hiddenRef }, () => true)).rejects.toThrow(/unavailable/);
      await expect(action("tags.get", { ref: privateRef }, () => true)).rejects.toThrow(/unavailable/);
      await expect(action("tags.find", { query: "portal", options: { sceneId: "s3" } }, () => true))
        .rejects.toThrow(/unavailable/);
      await expect(action("tags.find", { query: "portal", options: {
        sceneId: "s2", allScenes: true,
      } }, () => true)).rejects.toThrow(/options/);
      await expect(action("tags.find", { query: "portal", options: {
        allScenes: true, includeRefs: [{ ...remoteRef, parent: { coll: "actors", id: "s2" } }],
      } }, () => true)).rejects.toThrow(/references/);
      const localRef = { coll: "tokens", id: "same", parent: { coll: "scenes", id: "s1" } };
      const beforeEdit = h.hostStore.seq;
      expect(await action("tags.edit", { refs: [localRef, remoteRef], edit: "add",
        tags: ["linked"] }, () => true)).toMatchObject({ changed: 2 });
      await flushMicrotasks();
      expect(h.hostStore.seq).toBe(beforeEdit + 1); // one atomic cross-scene envelope
      expect(await action("tags.get", { ref: remoteRef }, () => true)).toEqual(["portal", "linked"]);
      expect((player.store.get("scenes", "s2") as SceneDocument).tokens.find((t) => t._id === "same")?.taggerTags)
        .toEqual(["portal", "linked"]);
      await expect(action("tags.edit", { refs: [localRef, hiddenRef], edit: "add",
        tags: ["leak"] }, () => true)).rejects.toThrow(/Invisible/);
      await expect(action("tags.edit", { refs: [privateRef], edit: "add",
        tags: ["leak"] }, () => true)).rejects.toThrow(/unavailable/);
      await expect(action("tags.edit", { refs: [localRef, { ...remoteRef,
        parent: { coll: "scenes", id: "s2", unexpected: true } }], edit: "add",
        tags: ["leak"] }, () => true)).rejects.toThrow(/explicit-scene/);
      expect(h.hostStore.seq).toBe(beforeEdit + 1); // failed bulk cannot partially edit s1
      expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "same")?.taggerTags)
        .toEqual(["portal", "linked"]);
      expect(h.host.undo().ok).toBe(true);
      await flushMicrotasks();
      expect((player.store.get("scenes", "s2") as SceneDocument).tokens.find((t) => t._id === "same")?.taggerTags)
        .toEqual(["portal"]);
      expect((player.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "same")?.taggerTags)
        .toEqual(["portal"]);
      const sceneRef = { coll: "scenes", id: "s2" };
      expect(await action("tags.edit", { refs: [sceneRef], edit: "add",
        tags: ["destination"] }, () => true)).toMatchObject({ changed: 1 });
      expect(await action("tags.get", { ref: sceneRef }, () => true)).toEqual(["destination"]);
      expect(h.host.undo().ok).toBe(true);
      await flushMicrotasks();
      expect((player.store.get("scenes", "s2") as SceneDocument).taggerTags).toBeUndefined();
      // {#} would expose the occupancy of hidden scene tags by skipping a
      // number, even though explicit target refs and reads are visibility-gated.
      expect(await action("tags.edit", { refs: [localRef, remoteRef], edit: "replace",
        tags: ["portal-{#}", "ident-{id}"] }, () => true)).toMatchObject({ changed: 2 });
      const beforeRules = h.hostStore.seq;
      await expect(action("tags.rules", { refs: [localRef, hiddenRef] }, () => true))
        .rejects.toThrow(/Invisible/);
      await expect(action("tags.rules", { refs: [localRef, remoteRef] }, () => true))
        .rejects.toThrow(/GM caller/);
      expect(h.hostStore.seq).toBe(beforeRules);
      expect(await action("tags.edit", { refs: [localRef, remoteRef], edit: "replace",
        tags: ["ident-{id}"] }, () => true)).toMatchObject({ changed: 2 });
      const beforeIdRules = h.hostStore.seq;
      expect(await action("tags.rules", { refs: [localRef, remoteRef] }, () => true))
        .toMatchObject({ changed: 2, seq: beforeIdRules + 1 });
      await flushMicrotasks();
      expect((player.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "same")?.taggerTags)
        .toEqual(["ident-same"]);
      expect((player.store.get("scenes", "s2") as SceneDocument).tokens.find((t) => t._id === "same")?.taggerTags)
        .toEqual(["ident-same"]);
      expect(h.host.undo().ok).toBe(true);
      await flushMicrotasks();
      expect((player.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "same")?.taggerTags)
        .toEqual(["ident-{id}"]);
      expect(h.host.undo().ok).toBe(true);
      expect(h.host.undo().ok).toBe(true);
      await flushMicrotasks();
      expect(JSON.stringify(grouped)).not.toMatch(/secret|priv/);
      // A live scene ownership change during the same reviewed script revokes
      // *both* explicit-scene and all-scene reads. GM elevation cannot bypass it.
      h.gm.submit([{ kind: "update", ref: { coll: "scenes", id: "s2" },
        diff: { ownership: { default: 0 } } }]);
      await flushMicrotasks();
      await expect(action("tags.find", { query: "portal", options: { sceneId: "s2" } }, () => true))
        .rejects.toThrow(/unavailable/);
      await expect(action("tags.get", { ref: remoteRef }, () => true)).rejects.toThrow(/unavailable/);
      const remaining = await action("tags.find", { query: "portal", options: {
        allScenes: true, groupByScene: true,
      } }, () => true) as Record<string, unknown>;
      expect(Object.keys(remaining)).toEqual(["s1"]);
      return { completed: true };
    });
    await seedZone(h);
    const distant = sceneDoc("s2"); distant.active = false;
    distant.tokens.push(tokenDoc("same", { taggerTags: ["portal"], ownership: { default: 2 } }));
    distant.tiles.push({ ...zoneTile(), _id: "secret", name: "GM SECRET tile",
      hidden: true, taggerTags: ["portal"], ownership: { default: 0 } });
    const privateScene = sceneDoc("s3"); privateScene.active = false;
    privateScene.ownership = { default: 0 };
    privateScene.tokens.push(tokenDoc("priv", { taggerTags: ["portal"] }));
    h.gm.submit([{ kind: "create", coll: "scenes", data: distant },
      { kind: "create", coll: "scenes", data: privateScene },
      { kind: "create", coll: "tokens", parent: { coll: "scenes", id: "s1" },
        data: tokenDoc("same", { taggerTags: ["portal"], ownership: { default: 2 } }) },
      { kind: "update", ref: { coll: "tiles", id: "zone", parent: { coll: "scenes", id: "s1" } },
        diff: { taggerTags: ["portal"] } },
    ]);
    await flushMicrotasks();
    const script = await reviewedScript({ grants: ["tags.read", "tags.write"], inputs: [] });
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    expect(player.store.get("scenes", "s2")).toBeDefined();
    expect(player.store.get("scenes", "s3")).toBeUndefined();
    const requestId = player.requestMacro(script._id, {});
    expect((await awaitMacroResult(bus, requestId)).ok).toBe(true);
    await flushMicrotasks();
    expect(player.store.get("scenes", "s2")).toBeUndefined(); // revoked mid-run
    expect(JSON.stringify(player.store.world)).not.toMatch(/GM SECRET|s3|priv/);
  });

  test("actor prototype-token tag arrays are validated on host create and update", async () => {
    const h = await setup();
    const rejected: Array<{ reason: string; detail: string }> = [];
    h.gmBus.on("rejected", ({ reason, detail }) => rejected.push({ reason, detail }));
    const base: ActorDocument = { _id: "prototype-validation", type: "actor", name: "Sentinel",
      ownership: { default: 0 }, flags: {}, system: {}, items: [], effects: [],
      prototypeToken: { taggerTags: [" prototype "] } };
    const before = h.hostStore.seq;
    h.gm.submit([{ kind: "create", coll: "actors", data: base }]);
    await flushMicrotasks();
    expect(rejected.at(-1)).toMatchObject({ reason: "invalid_schema" });
    expect(rejected.at(-1)?.detail).toMatch(/unique, trimmed/);
    expect(h.hostStore.get("actors", base._id)).toBeUndefined();
    expect(h.hostStore.seq).toBe(before);

    const valid = { ...base, prototypeToken: { taggerTags: ["sentinel"] } };
    h.gm.submit([{ kind: "create", coll: "actors", data: valid }]);
    await flushMicrotasks();
    const afterCreate = h.hostStore.seq;
    h.gm.submit([{ kind: "update", ref: { coll: "actors", id: valid._id },
      diff: { "prototypeToken.taggerTags": ["invalid "] } }]);
    await flushMicrotasks();
    expect(rejected.at(-1)).toMatchObject({ reason: "invalid_schema" });
    expect(rejected.at(-1)?.detail).toMatch(/unique, trimmed/);
    expect(h.hostStore.seq).toBe(afterCreate);
    expect((h.hostStore.get("actors", valid._id) as ActorDocument).prototypeToken?.taggerTags)
      .toEqual(["sentinel"]);
  });

  test("Tagger script APIs read and edit projected world documents while world rule allocation stays GM-only", async () => {
    const blade: ItemDocument = { _id: "world-blade", type: "item", name: "Visible Blade",
      ownership: { default: 0 }, flags: {}, system: {}, effects: [], taggerTags: ["world-blade"] };
    const actor: ActorDocument = { _id: "world-hero", type: "actor", name: "Visible Hero",
      ownership: { default: 2, [PLAYER_ID]: 3 }, flags: {}, system: {}, items: [blade], effects: [],
      taggerTags: ["world-party"], prototypeToken: { taggerTags: ["world-prototype"] } };
    const hiddenActor: ActorDocument = { _id: "world-secret-actor", type: "actor", name: "Private Hero",
      ownership: { default: 0 }, flags: {}, system: {}, items: [], effects: [], taggerTags: ["world-secret"],
      prototypeToken: { taggerTags: ["world-secret-prototype"] } };
    const worldItem: ItemDocument = { _id: "world-map", type: "item", name: "Visible Map",
      ownership: { default: 2 }, flags: {}, system: {}, effects: [], taggerTags: ["world-map"] };
    const hiddenItem: ItemDocument = { _id: "world-secret-item", type: "item", name: "Private Map",
      ownership: { default: 0 }, flags: {}, system: {}, effects: [], taggerTags: ["world-secret-item"] };
    const actorRef = { coll: "actors" as const, id: actor._id };
    const prototypeRef = { coll: "actors" as const, id: actor._id, target: "prototypeToken" as const };
    const hiddenPrototypeRef = { coll: "actors" as const, id: hiddenActor._id, target: "prototypeToken" as const };
    const embeddedRef = { coll: "items" as const, id: blade._id, parent: actorRef };
    const itemRef = { coll: "items" as const, id: worldItem._id };
    const hiddenActorRef = { coll: "actors" as const, id: hiddenActor._id };
    const hiddenItemRef = { coll: "items" as const, id: hiddenItem._id };
    let playerInvocations = 0;
    const h = await setup({}, async (_source, _args, context, action) => {
      expect([PLAYER_ID, OTHER_ID]).toContain(context.callerId);
      if (context.callerId === PLAYER_ID && playerInvocations++ === 0) {
        const groups = await action("tags.find", { query: "world-*", options: {
          allScenes: true, includeWorldDocs: true, pattern: "wildcard", groupByScene: true,
        } }, () => true) as Record<string, Array<{ scope: string; sceneId: string; ref: unknown; name: string }>>;
        expect(Object.keys(groups)).toEqual([""]);
        expect(groups[""]?.map((row) => [row.scope, row.sceneId, row.name])).toEqual([
          ["world", "", "Visible Hero"], ["world", "", "Visible Hero (prototype token)"],
          ["world", "", "Visible Map"], ["world", "", "Visible Blade"],
        ]);
        expect(groups[""]?.map((row) => row.ref)).toEqual([actorRef, prototypeRef, itemRef, embeddedRef]);
        const actors = await action("tags.find", { query: "world-party", options: {
          allScenes: true, collections: ["actors"],
        } }, () => true) as Array<{ ref: unknown; scope: string }>;
        expect(actors).toEqual([{ scope: "world", sceneId: "", ref: actorRef,
          name: "Visible Hero", tags: ["world-party"] }]);
        const prototypes = await action("tags.find", { query: "world-prototype", options: {
          allScenes: true, collections: ["prototypeTokens"],
        } }, () => true);
        expect(prototypes).toEqual([{ scope: "world", sceneId: "", ref: prototypeRef,
          name: "Visible Hero (prototype token)", tags: ["world-prototype"] }]);
        const pinned = await action("tags.find", { query: "world-prototype", options: {
          allScenes: true, includeWorldDocs: true, includeRefs: [prototypeRef],
        } }, () => true);
        expect(pinned).toMatchObject([{ scope: "world", ref: prototypeRef }]);
        await expect(action("tags.find", { query: "world-party", options: {
          allScenes: true, includeRefs: [actorRef],
        } }, () => true)).rejects.toThrow(/references/);
        await expect(action("tags.find", { query: "world-party", options: {
          includeWorldDocs: true,
        } }, () => true)).rejects.toThrow(/all-scene/);
        expect(await action("tags.get", { ref: actorRef }, () => true)).toEqual(["world-party"]);
        expect(await action("tags.get", { ref: prototypeRef }, () => true)).toEqual(["world-prototype"]);
        expect(await action("tags.get", { ref: itemRef }, () => true)).toEqual(["world-map"]);
        expect(await action("tags.get", { ref: embeddedRef }, () => true)).toEqual(["world-blade"]);
        await expect(action("tags.get", { ref: hiddenActorRef }, () => true)).rejects.toThrow(/unavailable/);
        await expect(action("tags.get", { ref: hiddenPrototypeRef }, () => true)).rejects.toThrow(/unavailable/);
        await expect(action("tags.get", { ref: hiddenItemRef }, () => true)).rejects.toThrow(/unavailable/);
        const edit = await action("tags.edit", { refs: [actorRef, prototypeRef, itemRef, embeddedRef],
          edit: "add", tags: ["scripted"] }, () => true);
        expect(edit).toMatchObject({ changed: 4 });
        await expect(action("tags.rules", { refs: [actorRef] }, () => true))
          .rejects.toThrow(/World-document Tagger rule allocation requires a GM caller/);
        await expect(action("tags.rules", { refs: [prototypeRef] }, () => true))
          .rejects.toThrow(/World-document Tagger rule allocation requires a GM caller/);
        await expect(action("tags.edit", { refs: [actorRef, hiddenActorRef],
          edit: "add", tags: ["must-not-partially-write"] }, () => true))
          .rejects.toThrow(/Invisible/);
        expect(await action("tags.get", { ref: actorRef }, () => true)).toEqual(["world-party", "scripted"]);
        expect(await action("tags.get", { ref: prototypeRef }, () => true)).toEqual(["world-prototype", "scripted"]);
        return { worldRows: groups[""]?.length ?? 0, edited: edit };
      }
      if (context.callerId === PLAYER_ID) {
        const edit = await action("tags.edit", { refs: [actorRef, prototypeRef, embeddedRef],
          edit: "add", tags: ["owner-write"] }, () => true);
        expect(edit).toMatchObject({ changed: 3 });
        await expect(action("tags.edit", { refs: [itemRef], edit: "add", tags: ["denied"] }, () => true))
          .rejects.toThrow(/not authorized/);
        return edit;
      }
      await expect(action("tags.edit", { refs: [actorRef], edit: "add", tags: ["forged"] }, () => true))
        .rejects.toThrow(/not authorized/);
      return true;
    });
    const gmScript = await reviewedScript({ grants: ["tags.read", "tags.write"], inputs: [] },
      { _id: "world-tag-gm-script" });
    const callerScript = await reviewedScript({ runAs: "caller", grants: ["tags.read", "tags.write"], inputs: [] },
      { _id: "world-tag-caller-script" });
    h.gm.submit([
      { kind: "create", coll: "actors", data: actor },
      { kind: "create", coll: "actors", data: hiddenActor },
      { kind: "create", coll: "items", data: worldItem },
      { kind: "create", coll: "items", data: hiddenItem },
      { kind: "create", coll: "macros", data: gmScript },
      { kind: "create", coll: "macros", data: callerScript },
    ]);
    await flushMicrotasks();
    const { client: owner, bus: ownerBus } = await h.addPlayer(PLAYER_ID, "Rex");
    const { client: other, bus: otherBus } = await h.addPlayer(OTHER_ID, "Ivy");
    expect(owner.store.get("actors", hiddenActor._id)).toBeUndefined();
    expect(owner.store.get("items", hiddenItem._id)).toBeUndefined();
    expect(JSON.stringify(owner.store.world)).not.toMatch(/Private Hero|Private Map|world-secret-item/);

    const gmRequest = owner.requestMacro(gmScript._id, {});
    expect((await awaitMacroResult(ownerBus, gmRequest)).ok).toBe(true);
    const callerRequest = owner.requestMacro(callerScript._id, {});
    expect((await awaitMacroResult(ownerBus, callerRequest)).ok).toBe(true);
    const otherRequest = other.requestMacro(callerScript._id, {});
    expect((await awaitMacroResult(otherBus, otherRequest)).ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.resolve(actorRef) as ActorDocument).taggerTags)
      .toEqual(["world-party", "scripted", "owner-write"]);
    expect((h.hostStore.resolve(actorRef) as ActorDocument).prototypeToken?.taggerTags)
      .toEqual(["world-prototype", "scripted", "owner-write"]);
    expect((h.hostStore.resolve(hiddenActorRef) as ActorDocument).prototypeToken?.taggerTags)
      .toEqual(["world-secret-prototype"]);
    expect((h.hostStore.resolve(itemRef) as ItemDocument).taggerTags).toEqual(["world-map", "scripted"]);
    expect((h.hostStore.resolve(embeddedRef) as ItemDocument).taggerTags)
      .toEqual(["world-blade", "scripted", "owner-write"]);
    expect((h.hostStore.resolve(hiddenActorRef) as ActorDocument).taggerTags).toEqual(["world-secret"]);
    expect((h.hostStore.resolve(hiddenItemRef) as ItemDocument).taggerTags).toEqual(["world-secret-item"]);
  });

  test("reviewed GM scripts can apply world Tagger rules against the global namespace", async () => {
    const blocker: ActorDocument = { _id: "macro-rule-blocker", type: "actor", name: "Private blocker",
      ownership: { default: 0 }, flags: {}, system: {}, items: [], effects: [], taggerTags: ["macro-global-1"] };
    const actor: ActorDocument = { _id: "macro-rule-actor", type: "actor", name: "Rule actor",
      ownership: { default: 0 }, flags: {}, system: {}, items: [], effects: [],
      taggerTags: ["macro-global-{#}"], prototypeToken: { taggerTags: ["macro-prototype-{id}"] } };
    const item: ItemDocument = { _id: "macro-rule-item", type: "item", name: "Rule item",
      ownership: { default: 0 }, flags: {}, system: {}, effects: [], taggerTags: ["macro-global-{#}"] };
    const actorRef = { coll: "actors" as const, id: actor._id };
    const prototypeRef = { coll: "actors" as const, id: actor._id, target: "prototypeToken" as const };
    const itemRef = { coll: "items" as const, id: item._id };
    const h = await setup({}, async (_source, _args, context, action) => {
      expect(context.callerId).toBe(GM_ID);
      const before = h.hostStore.seq;
      const applied = await action("tags.rules", { refs: [actorRef, prototypeRef, itemRef] }, () => true);
      expect(applied).toMatchObject({ changed: 3, seq: before + 1 });
      return applied;
    });
    const script = await reviewedScript({ grants: ["tags.write"], inputs: [] },
      { _id: "world-rule-macro" });
    h.gm.submit([
      { kind: "create", coll: "actors", data: blocker },
      { kind: "create", coll: "actors", data: actor },
      { kind: "create", coll: "items", data: item },
      { kind: "create", coll: "macros", data: script },
    ]);
    await flushMicrotasks();
    const requestId = h.gm.requestMacro(script._id, {});
    expect((await awaitMacroResult(h.gmBus, requestId)).ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("actors", actor._id) as ActorDocument).taggerTags).toEqual(["macro-global-2"]);
    expect((h.hostStore.get("actors", actor._id) as ActorDocument).prototypeToken?.taggerTags)
      .toEqual(["macro-prototype-macro-rule-actor"]);
    expect((h.hostStore.get("items", item._id) as ItemDocument).taggerTags).toEqual(["macro-global-3"]);
  });

  test("GM Tagger explorer rules resolve live, hidden and remote-scene tags, replicate and undo atomically", async () => {
    const h = await setup();
    const distant = sceneDoc("s2"); distant.active = false;
    distant.tiles.push({ ...zoneTile(), _id: "far", taggerTags: ["portal-{#}"] });
    const near = { ...zoneTile(), _id: "near", taggerTags: ["portal-{#}", "self-{id}"] };
    h.gm.submit([
      { kind: "create", coll: "scenes", data: distant },
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" },
        data: { ...zoneTile(), _id: "hidden", hidden: true, taggerTags: ["portal-1"] } },
      { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: near },
      { kind: "update", ref: tokenRef, diff: { taggerTags: ["portal-{#}"] } },
    ]);
    await flushMicrotasks();
    const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
    const results: ClientEvents["taggerRulesResult"][] = [];
    const playerResults: ClientEvents["taggerRulesResult"][] = [];
    h.gmBus.on("taggerRulesResult", (msg) => results.push(msg));
    playerBus.on("taggerRulesResult", (msg) => playerResults.push(msg));
    const nearRef = { coll: "tiles" as const, id: "near", parent: { coll: "scenes" as const, id: "s1" } };
    const farRef = { coll: "tiles" as const, id: "far", parent: { coll: "scenes" as const, id: "s2" } };
    const refs = [tokenRef, nearRef, farRef];
    const before = h.hostStore.seq;
    const requestId = h.gm.requestTagRules(refs);
    await flushMicrotasks();
    expect(results).toEqual([{ kind: "tagger.rules.result", requestId, changed: 3, seq: before + 1 }]);
    expect(playerResults).toEqual([]);
    expect(h.hostLog.at(before + 1)?.env.ops.filter((op) =>
      (op.kind === "create" ? op.coll : op.ref.coll) !== "actionReceipts")).toHaveLength(3);
    expect((h.hostStore.resolve(tokenRef) as TokenDocument).taggerTags).toEqual(["portal-2"]);
    expect((h.hostStore.resolve(nearRef) as TileDocument).taggerTags).toEqual(["portal-3", "self-near"]);
    expect((h.hostStore.resolve(farRef) as TileDocument).taggerTags).toEqual(["portal-1"]);
    expect((player.store.resolve(tokenRef) as TokenDocument).taggerTags).toEqual(["portal-2"]);
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.some((t) => t._id === "hidden")).toBe(false);

    // A repeated wire request cannot allocate again, even if another GM edit
    // puts the same templates back before the retry arrives.
    h.gmPair.b.send("ops", frameMessage({ kind: "tagger.rules", requestId, refs }));
    await flushMicrotasks();
    expect(results).toHaveLength(2);
    expect(results[1]).toEqual(results[0]);
    expect(h.hostStore.seq).toBe(before + 1);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.resolve(tokenRef) as TokenDocument).taggerTags).toEqual(["portal-{#}"]);
    expect((h.hostStore.resolve(nearRef) as TileDocument).taggerTags).toEqual(["portal-{#}", "self-{id}"]);
    expect((h.hostStore.resolve(farRef) as TileDocument).taggerTags).toEqual(["portal-{#}"]);
    expect((player.store.resolve(tokenRef) as TokenDocument).taggerTags).toEqual(["portal-{#}"]);
  });

  test("Tagger rule request denies player, malformed/duplicate/stale GM batches without partial writes", async () => {
    const h = await setup();
    const { client: player, bus: playerBus, pair } = await h.addPlayer(PLAYER_ID, "Rex");
    h.gm.submit([{ kind: "update", ref: tokenRef, diff: { taggerTags: ["portal-{#}"] } }]);
    await flushMicrotasks();
    const playerRejected: ClientEvents["rejected"][] = [];
    const gmRejected: ClientEvents["rejected"][] = [];
    const gmResults: ClientEvents["taggerRulesResult"][] = [];
    playerBus.on("rejected", (msg) => playerRejected.push(msg));
    h.gmBus.on("rejected", (msg) => gmRejected.push(msg));
    h.gmBus.on("taggerRulesResult", (msg) => gmResults.push(msg));
    const before = h.hostStore.seq;
    const playerId = player.requestTagRules([tokenRef]);
    await flushMicrotasks();
    expect(playerRejected.at(-1)).toMatchObject({ txId: playerId, reason: "forbidden" });
    expect(h.hostStore.seq).toBe(before);
    expect(gmResults).toEqual([]);
    // GM replies never broadcast their success or private diagnostics to players.
    pair.b.send("ops", frameMessage({ kind: "tagger.rules.result", requestId: "fake", changed: 99, seq: 999 }));
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);

    h.gmPair.b.send("ops", frameMessage({ kind: "tagger.rules", requestId: "dup", refs: [tokenRef, tokenRef] }));
    h.gmPair.b.send("ops", frameMessage({ kind: "tagger.rules", requestId: "missing",
      refs: [tokenRef, { coll: "tokens", id: "does-not-exist", parent: { coll: "scenes", id: "s1" } }] }));
    h.gmPair.b.send("ops", frameMessage({ kind: "tagger.rules", requestId: "wrong-parent",
      refs: [{ coll: "tokens", id: "t-pl", parent: { coll: "scenes", id: "s2" } }] }));
    h.gmPair.b.send("ops", frameMessage({ kind: "tagger.rules", requestId: "too-many",
      refs: Array.from({ length: 33 }, () => tokenRef) }));
    h.gmPair.b.send("ops", frameMessage({ kind: "tagger.rules", requestId: "ops-forgery",
      refs: [tokenRef], ops: [{ kind: "delete", ref: tokenRef }] } as unknown as Parameters<typeof frameMessage>[0]));
    await flushMicrotasks();
    expect(gmRejected.map((r) => r.txId)).toEqual(["dup", "missing", "wrong-parent", "too-many", "ops-forgery"]);
    expect(gmRejected.every((r) => r.reason === "invalid_schema")).toBe(true);
    expect(h.hostStore.seq).toBe(before);
    expect((h.hostStore.resolve(tokenRef) as TokenDocument).taggerTags).toEqual(["portal-{#}"]);

    const id = h.gm.requestTagRules([tokenRef]);
    await flushMicrotasks();
    expect(gmResults).toEqual([{ kind: "tagger.rules.result", requestId: id,
      changed: 1, seq: before + 1 }]);
    const noop = h.gm.requestTagRules([tokenRef]);
    await flushMicrotasks();
    expect(gmResults.at(-1)).toMatchObject({ requestId: noop, changed: 0, seq: before + 1 });
    expect(h.hostStore.seq).toBe(before + 1);
  });

  test("GM Tagger rules allocate world actors, prototype tokens and items in one hidden-safe namespace", async () => {
    const h = await setup();
    const blocker: ActorDocument = { _id: "world-rule-blocker", type: "actor", name: "Private blocker",
      ownership: { default: 0 }, flags: {}, system: {}, items: [], effects: [], taggerTags: ["global-1"] };
    const embedded: ItemDocument = { _id: "world-rule-embedded", type: "item", name: "Embedded target",
      ownership: { default: 0 }, flags: {}, system: {}, effects: [], taggerTags: ["embedded-{id}"] };
    const actor: ActorDocument = { _id: "world-rule-actor", type: "actor", name: "Visible target",
      ownership: { default: 2 }, flags: {}, system: {}, items: [embedded], effects: [],
      taggerTags: ["global-{#}"], prototypeToken: { taggerTags: ["prototype-{id}"], sight: { enabled: true } } };
    const item: ItemDocument = { _id: "world-rule-item", type: "item", name: "Visible item",
      ownership: { default: 2 }, flags: {}, system: {}, effects: [], taggerTags: ["global-{#}"] };
    h.gm.submit([
      { kind: "create", coll: "actors", data: blocker },
      { kind: "create", coll: "actors", data: actor },
      { kind: "create", coll: "items", data: item },
    ]);
    await flushMicrotasks();
    const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
    const results: ClientEvents["taggerRulesResult"][] = [];
    const playerResults: ClientEvents["taggerRulesResult"][] = [];
    h.gmBus.on("taggerRulesResult", (msg) => results.push(msg));
    playerBus.on("taggerRulesResult", (msg) => playerResults.push(msg));
    expect(player.store.get("actors", blocker._id)).toBeUndefined();
    const actorRef = { coll: "actors" as const, id: actor._id };
    const prototypeRef = { coll: "actors" as const, id: actor._id, target: "prototypeToken" as const };
    const itemRef = { coll: "items" as const, id: item._id };
    const embeddedRef = { coll: "items" as const, id: embedded._id, parent: actorRef };
    const before = h.hostStore.seq;
    const requestId = h.gm.requestTagRules([actorRef, prototypeRef, itemRef, embeddedRef]);
    await flushMicrotasks();
    expect(results).toEqual([{ kind: "tagger.rules.result", requestId, changed: 4, seq: before + 1 }]);
    expect(playerResults).toEqual([]);
    expect((h.hostStore.get("actors", actor._id) as ActorDocument).taggerTags).toEqual(["global-2"]);
    expect((h.hostStore.get("actors", actor._id) as ActorDocument).prototypeToken)
      .toMatchObject({ taggerTags: ["prototype-world-rule-actor"], sight: { enabled: true } });
    expect((h.hostStore.get("items", item._id) as ItemDocument).taggerTags).toEqual(["global-3"]);
    expect((h.hostStore.resolve(embeddedRef) as ItemDocument).taggerTags)
      .toEqual(["embedded-world-rule-embedded"]);
    expect(player.store.get("actors", blocker._id)).toBeUndefined();
    expect(h.host.undo().ok).toBe(true);
    expect((h.hostStore.get("actors", actor._id) as ActorDocument).taggerTags).toEqual(["global-{#}"]);
    expect((h.hostStore.get("actors", actor._id) as ActorDocument).prototypeToken?.taggerTags)
      .toEqual(["prototype-{id}"]);
    expect((h.hostStore.get("items", item._id) as ItemDocument).taggerTags).toEqual(["global-{#}"]);
  });

  test("GM Tagger rule numbering includes hidden occupancy and stays undoable", async () => {
    const ref = { coll: "tokens", id: "t-pl", parent: { coll: "scenes", id: "s1" } };
    const h = await setup({}, async (_source, _args, context, action) => {
      expect(context.callerId).toBe(GM_ID);
      expect(await action("tags.edit", { refs: [ref], edit: "replace",
        tags: ["portal-{#}"] }, () => true)).toMatchObject({ changed: 1 });
      const before = h.hostStore.seq;
      expect(await action("tags.rules", { refs: [ref] }, () => true))
        .toMatchObject({ changed: 1, seq: before + 1 });
      return null;
    });
    const privateTile = { ...zoneTile(), _id: "private-tile", hidden: true, taggerTags: ["portal-1"] };
    const script = await reviewedScript({ grants: ["tags.write"], inputs: [] });
    h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: privateTile },
      { kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const requestId = h.gm.requestMacro(script._id, {});
    expect((await awaitMacroResult(h.gmBus, requestId)).ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-pl")?.taggerTags)
      .toEqual(["portal-2"]);
    expect(h.host.undo().ok).toBe(true);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-pl")?.taggerTags)
      .toEqual(["portal-{#}"]);
  });

  test("caller-run cross-scene Tagger edits require live per-target ownership and undo as one envelope", async () => {
    const localRef = { coll: "tokens", id: "t-pl", parent: { coll: "scenes", id: "s1" } };
    const remoteRef = { coll: "tokens", id: "owned", parent: { coll: "scenes", id: "s2" } } as const;
    const unownedRef = { coll: "tokens", id: "unowned", parent: { coll: "scenes", id: "s2" } };
    const h = await setup({}, async (_source, _args, context, action) => {
      expect(context.callerId).toBe(PLAYER_ID);
      const before = h.hostStore.seq;
      await expect(action("tags.edit", { refs: [localRef, unownedRef], edit: "add",
        tags: ["should-not-save"] }, () => true)).rejects.toThrow(/not authorized/);
      expect(h.hostStore.seq).toBe(before);
      expect(await action("tags.edit", { refs: [localRef, remoteRef], edit: "add",
        tags: ["owned"] }, () => true)).toMatchObject({ changed: 2 });
      expect(h.hostStore.seq).toBe(before + 1);
      await flushMicrotasks();
      expect(await action("tags.get", { ref: remoteRef }, () => true)).toEqual(["owned"]);
      expect((player.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-pl")?.taggerTags)
        .toEqual(["owned"]);
      expect((player.store.get("scenes", "s2") as SceneDocument).tokens.find((t) => t._id === "owned")?.taggerTags)
        .toEqual(["owned"]);
      expect(h.host.undo().ok).toBe(true);
      await flushMicrotasks();
      expect((player.store.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-pl")?.taggerTags)
        .toBeUndefined();
      expect((player.store.get("scenes", "s2") as SceneDocument).tokens.find((t) => t._id === "owned")?.taggerTags)
        .toBeUndefined();
      h.gm.submit([{ kind: "update", ref: remoteRef, diff: { ownership: { default: 2 } } }]);
      await flushMicrotasks();
      const revoked = h.hostStore.seq;
      await expect(action("tags.edit", { refs: [remoteRef], edit: "add", tags: ["denied"] }, () => true))
        .rejects.toThrow(/not authorized/);
      expect(h.hostStore.seq).toBe(revoked);
      return { guarded: true };
    });
    const distant = sceneDoc("s2"); distant.active = false;
    distant.tokens.push(tokenDoc("owned", { ownership: { default: 2, [PLAYER_ID]: 3 } }),
      tokenDoc("unowned", { ownership: { default: 2 } }));
    h.gm.submit([{ kind: "create", coll: "scenes", data: distant }]);
    const script = await reviewedScript({ runAs: "caller", grants: ["tags.read", "tags.write"], inputs: [] });
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const requestId = player.requestMacro(script._id, {});
    expect((await awaitMacroResult(bus, requestId)).ok).toBe(true);
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s2") as SceneDocument).tokens.find((t) => t._id === "owned")?.taggerTags)
      .toBeUndefined();
  });

  test("Tagger getTags reads untagged visible refs but GM-elevated player scripts cannot read hidden targets", async () => {
    const ref = { coll: "tiles", id: "zone", parent: { coll: "scenes", id: "s1" } };
    const hidden = { ...ref, id: "sealed" };
    const h = await setup({}, async (_source, _args, context, action) => {
      expect(context.callerId).toBe(PLAYER_ID);
      expect(await action("tags.get", { ref }, () => true)).toEqual([]);
      await expect(action("tags.get", { ref: hidden }, () => true)).rejects.toThrow(/unavailable/);
      await expect(action("tags.get", { ref: { ...hidden,
        parent: { coll: "scenes", id: "different" } } }, () => true)).rejects.toThrow(/unavailable/);
      expect(await action("tags.find", { query: "secret", options: {} }, () => true)).toEqual([]);
      expect(await action("tags.edit", { refs: [ref], edit: "replace", tags: ["visible"] }, () => true))
        .toMatchObject({ changed: 1 });
      expect(await action("tags.get", { ref }, () => true)).toEqual(["visible"]);
      return { updated: true, sealed: false };
    });
    await seedZone(h);
    const sealed = { ...zoneTile(), _id: "sealed", name: "Hidden target", hidden: true,
      taggerTags: ["secret"], ownership: { default: 0 as const } };
    h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: sealed }]);
    const script = await reviewedScript({ grants: ["tags.read", "tags.write"], inputs: [] });
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    expect((player.store.get("scenes", "s1") as SceneDocument).tiles.map((tile) => tile._id))
      .toEqual(["zone"]);
    const requestId = player.requestMacro(script._id, {});
    expect((await awaitMacroResult(bus, requestId)).ok).toBe(true);
    await flushMicrotasks();
    const all = (h.hostStore.get("scenes", "s1") as SceneDocument).tiles;
    expect(all.find((tile) => tile._id === "zone")?.taggerTags).toEqual(["visible"]);
    expect(all.find((tile) => tile._id === "sealed")?.taggerTags).toEqual(["secret"]);
    expect(JSON.stringify(player.store.world)).not.toContain("secret");
    expect(player.store.getAll("automations")).toEqual([]);
    expect(h.host.undo().ok).toBe(true); // last transaction: one atomic tag edit
    await flushMicrotasks();
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles.find((tile) => tile._id === "zone")?.taggerTags)
      .toBeUndefined();
  });

  test("host preflights awaitable Sequencer cues before emitting, returns a finite schedule to reviewed scripts", async () => {
    const h = await setup({}, async (_source, _args, context, action) => {
      expect(context.callerId).toBe(PLAYER_ID);
      const before = h.hostStore.seq;
      await expect(action("fx.play", { macroId: "long-fx", waitForEnd: true }, () => true))
        .rejects.toThrow(/finish within 7 seconds/);
      await expect(action("fx.play", { macroId: "loop-fx", waitForEnd: true }, () => true))
        .rejects.toThrow(/nonpersistent/);
      await expect(action("fx.play", { macroId: "short-fx", waitForEnd: false }, () => true))
        .rejects.toThrow(/Invalid FX call/);
      expect(h.hostStore.seq).toBe(before);
      const played = await action("fx.play", { macroId: "short-fx", waitForEnd: true }, () => true) as {
        runId: string; atHostTime: number; endsAtHostTime: number; persistent: boolean;
      };
      expect(played).toMatchObject({ persistent: false, runId: expect.any(String) });
      expect(played.endsAtHostTime - played.atHostTime).toBe(450); // latest end across overlapping sections
      return { played: true };
    });
    const sequence = (id: string, durationMs: number, persistent = false): MacroDocument => ({
      _id: id, type: "macro", name: id, kind: "sequence", command: "", flags: { core: { playerCallable: true } },
      ownership: { default: 1 }, system: {}, sequence: { version: 1, audience: "scene", persistent,
        sections: [{ kind: "text", id: "display", text: "visual", at: { kind: "point", x: 200, y: 200 },
          startMs: 100, durationMs }] },
    });
    h.gm.submit([{ kind: "create", coll: "macros", data: sequence("short-fx", 350) },
      { kind: "create", coll: "macros", data: sequence("long-fx", 8000) },
      { kind: "create", coll: "macros", data: sequence("loop-fx", 350, true) },
      { kind: "create", coll: "macros", data: await reviewedScript({ grants: ["fx"], inputs: [] }) }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const cues: ClientEvents["fx"][] = [];
    bus.on("fx", (cue) => cues.push(cue));
    const requestId = player.requestMacro("script-reviewed", {});
    expect((await awaitMacroResult(bus, requestId)).ok).toBe(true);
    await flushMicrotasks();
    expect(cues.map((cue) => cue.macroId)).toEqual(["short-fx"]);
    expect(h.hostStore.getAll("fxInstances")).toHaveLength(0);
  });

  test("GM-elevated script FX grants caller-audience playback and ownership to the invoking player", async () => {
    const h = await setup({}, async (_source, _args, context, action) => {
      expect(context.callerId).toBe(PLAYER_ID);
      return action("fx.play", { macroId: "caller-aura" }, () => true);
    });
    const aura: MacroDocument = { _id: "caller-aura", type: "macro", name: "Caller aura",
      ownership: { default: 1 }, flags: { core: { playerCallable: true } }, system: {},
      kind: "sequence", command: "", sequence: { version: 1, persistent: true,
        audience: "caller", sections: [{ kind: "text", id: "glow", text: "Caller!",
          at: { kind: "point", x: 150, y: 150 }, startMs: 0, durationMs: 800 }] } };
    const script = await reviewedScript({ grants: ["fx"], inputs: [] });
    h.gm.submit([{ kind: "create", coll: "macros", data: aura },
      { kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const cues: ClientEvents["fx"][] = [];
    const ends: ClientEvents["fxEnd"][] = [];
    bus.on("fx", (cue) => cues.push(cue));
    bus.on("fxEnd", (end) => ends.push(end));
    const requestId = player.requestMacro(script._id, {});
    expect((await awaitMacroResult(bus, requestId)).ok).toBe(true);
    await flushMicrotasks();
    const [instance] = h.hostStore.getAll("fxInstances");
    expect(instance).toMatchObject({ macroId: aura._id, ownerId: PLAYER_ID, audience: "caller" });
    expect(cues.map((cue) => cue.runId)).toEqual([instance?._id]);
    if (!instance) throw new Error("Script FX did not persist");
    player.requestFxStop(instance._id);
    await flushMicrotasks();
    expect(h.hostStore.getAll("fxInstances")).toEqual([]);
    expect(ends.map((end) => end.runId)).toEqual([instance._id]);
  });

  test("GM-reviewed FX filters list only entitled caller instances and stop matches in one undoable commit", async () => {
    const runner: ScriptRunner = async (_source, _args, context, action) => {
      expect(context.callerId).toBe(PLAYER_ID);
      const visible = await action("fx.list", { filter: { name: "ward*" } }, () => true) as Array<Record<string, Json>>;
      expect(visible).toHaveLength(1); // other player + GM instances are NOT enumerable
      expect(visible[0]).toMatchObject({ name: "Ward aura", macroId: "ward-aura", sceneId: "s1" });
      expect(JSON.stringify(visible)).not.toContain("GM private ward");
      await expect(action("fx.stopMatching", { filter: {} }, () => true)).rejects.toThrow(/filter/);
      await expect(action("fx.list", { filter: { sceneId: "s2" } }, () => true)).rejects.toThrow(/filter/);
      expect(await action("fx.stopMatching", { filter: { name: "GM*" } }, () => true))
        .toEqual({ stopped: 0 }); // no cross-owner existence disclosure
      const stopped = await action("fx.stopMatching", { filter: {
        name: "WARD*", macroId: "ward-aura",
      } }, () => true);
      expect(stopped).toMatchObject({ stopped: 1 });
      return { ownedBeforeStop: visible.length, stopped };
    };
    const h = await setup({}, runner);
    const ward: MacroDocument = { _id: "ward-aura", type: "macro", name: "Ward aura",
      ownership: { default: 1 }, flags: { core: { playerCallable: true } }, system: {},
      kind: "sequence", command: "", sequence: { version: 1, persistent: true,
        audience: "caller", sections: [{ kind: "text", id: "glow", text: "Safe",
          at: { kind: "point", x: 150, y: 150 }, startMs: 0, durationMs: 600 }] } };
    if (!ward.sequence) throw new Error("FX test requires sequence");
    const secret: MacroDocument = { ...structuredClone(ward), _id: "gm-only-ward", name: "GM private ward",
      ownership: { default: 0 }, flags: {}, sequence: { ...ward.sequence, audience: "gm" } };
    const script = await reviewedScript({ grants: ["fx"], inputs: [] });
    h.gm.submit([{ kind: "create", coll: "macros", data: ward },
      { kind: "create", coll: "macros", data: secret },
      { kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const { client: other } = await h.addPlayer(OTHER_ID, "Ivy");
    const endings: ClientEvents["fxEnd"][] = [];
    bus.on("fxEnd", (end) => endings.push(end));
    player.requestSequence(ward._id, "s1");
    other.requestSequence(ward._id, "s1");
    h.gm.requestSequence(secret._id, "s1");
    await flushMicrotasks();
    expect(h.hostStore.getAll("fxInstances").map((doc) => doc.ownerId).sort())
      .toEqual([GM_ID, OTHER_ID, PLAYER_ID].sort());
    expect(JSON.stringify(player.store.world)).not.toContain("GM private ward");
    expect(player.store.getAll("fxInstances")).toEqual([]);
    const seqBefore = h.hostStore.seq;
    const requestId = player.requestMacro(script._id, {});
    expect((await awaitMacroResult(bus, requestId)).ok).toBe(true);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seqBefore + 2); // invocation marker + ONE filtered-stop envelope
    expect(h.hostLog.at(h.hostStore.seq)?.env.ops).toHaveLength(1);
    expect(h.hostLog.at(h.hostStore.seq)?.env.ops[0]).toMatchObject({ kind: "delete",
      ref: { coll: "fxInstances" } });
    expect(h.hostStore.getAll("fxInstances").map((doc) => doc.ownerId).sort())
      .toEqual([GM_ID, OTHER_ID].sort());
    expect(endings).toHaveLength(1);
    expect(h.host.undo().ok).toBe(true); // restores only the caller's FX
    await flushMicrotasks();
    expect(h.hostStore.getAll("fxInstances")).toHaveLength(3);
    player.requestFxSync("s1");
    await flushMicrotasks();
    expect(JSON.stringify(player.store.world)).not.toContain("GM private ward");
  });

  test("GM FX filter caps a batch at 16 without partial deletion, then undoes the allowed batch", async () => {
    const h = await setup({}, async (_source, _args, context, action) => {
      expect(context.callerId).toBe(GM_ID);
      const all = await action("fx.list", { filter: {} }, () => true) as unknown[];
      expect(all).toHaveLength(17);
      await expect(action("fx.stopMatching", { filter: { name: "*" } }, () => true))
        .rejects.toThrow(/over 16/);
      expect(h.hostStore.getAll("fxInstances")).toHaveLength(17); // failed RPC writes nothing
      expect(await action("fx.stopMatching", { filter: { name: "Ward*" } }, () => true))
        .toMatchObject({ stopped: 16 });
      expect(await action("fx.list", { filter: {} }, () => true)).toHaveLength(1);
      return { stopped: 16 };
    });
    const sequence: MacroDocument = { _id: "ward-aura", type: "macro", name: "Ward aura",
      ownership: { default: 0 }, flags: {}, system: {}, kind: "sequence", command: "",
      sequence: { version: 1, persistent: true, audience: "gm", sections: [
        { kind: "text", id: "glow", text: "Safe", at: { kind: "point", x: 150, y: 150 },
          startMs: 0, durationMs: 600 },
      ] } };
    const script = await reviewedScript({ grants: ["fx"], inputs: [] });
    h.gm.submit([{ kind: "create", coll: "macros", data: sequence },
      { kind: "create", coll: "macros", data: { ...sequence,
        _id: "neutral-aura", name: "Neutral aura" } },
      { kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    for (let i = 0; i < 16; i++) h.gm.requestSequence(sequence._id, "s1");
    h.gm.requestSequence("neutral-aura", "s1");
    await flushMicrotasks();
    expect(h.hostStore.getAll("fxInstances")).toHaveLength(17);
    const before = h.hostStore.seq;
    const requestId = h.gm.requestMacro(script._id, {});
    expect((await awaitMacroResult(h.gmBus, requestId)).ok).toBe(true);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 2); // invocation marker + one 16-delete envelope
    expect(h.hostLog.at(h.hostStore.seq)?.env.ops).toHaveLength(16);
    expect(h.hostStore.getAll("fxInstances").map((doc) => doc.name)).toEqual(["Neutral aura"]);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(h.hostStore.getAll("fxInstances")).toHaveLength(17);
  });

  test("GM Live FX stop matching rechecks scene/role, caps the batch and undoes every recipient end", async () => {
    const h = await setup();
    const main: MacroDocument = { _id: "ward-aura", type: "macro", name: "Ward Aura",
      ownership: { default: 1 }, flags: {}, system: {}, kind: "sequence", command: "",
      sequence: { version: 1, audience: "scene", persistent: true, sections: [
        { kind: "text", id: "light", text: "Glow", at: { kind: "point", x: 150, y: 150 },
          startMs: 0, durationMs: 600 },
      ] } };
    const distant = sceneDoc("s2"); distant.active = false; distant.ownership = { default: 0 };
    if (!main.sequence) throw new Error("FX fixture must include a sequence");
    const gmOnly: MacroDocument = { ...main, _id: "gm-only", name: "Secret Aura",
      ownership: { default: 0 }, sequence: { ...main.sequence, audience: "gm" } };
    h.gm.submit([{ kind: "create", coll: "scenes", data: distant },
      { kind: "create", coll: "macros", data: main },
      { kind: "create", coll: "macros", data: { ...main, _id: "neutral", name: "Neutral Aura" } },
      { kind: "create", coll: "macros", data: gmOnly },
    ]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const begins: ClientEvents["fx"][] = [], ends: ClientEvents["fxEnd"][] = [];
    const errors: ClientEvents["rejected"][] = [];
    bus.on("fx", (cue) => begins.push(cue));
    bus.on("fxEnd", (cue) => ends.push(cue));
    bus.on("rejected", (rejection) => errors.push(rejection));
    const gmErrors: ClientEvents["rejected"][] = [];
    h.gmBus.on("rejected", (rejection) => gmErrors.push(rejection));
    for (let i = 0; i < 16; i++) h.gm.requestSequence(main._id, "s1");
    h.gm.requestSequence("neutral", "s1");
    h.gm.requestSequence(main._id, "s2");
    h.gm.requestSequence("gm-only", "s1");
    await flushMicrotasks();
    expect(h.hostStore.getAll("fxInstances")).toHaveLength(19);
    expect(player.store.getAll("fxInstances")).toEqual([]);
    expect(begins).toHaveLength(17); // s2 is private, GM-only never dispatched to player
    const privateRun = h.hostStore.getAll("fxInstances").find((doc) => doc.sceneId === "s2")?._id;
    expect(privateRun).toBeDefined();
    expect(player.store.get("scenes", "s2")).toBeUndefined();
    const before = h.hostStore.seq;
    player.requestFxStopMatching("s1", { name: "Ward*" });
    await flushMicrotasks();
    expect(errors.at(-1)).toMatchObject({ reason: "forbidden", detail: "FX manager unavailable" });
    expect(h.hostStore.seq).toBe(before);
    h.gm.requestFxStopMatching("s1", {});
    await flushMicrotasks();
    expect(gmErrors.at(-1)?.reason).toBe("invalid_schema");
    expect(h.hostStore.seq).toBe(before);
    h.gm.requestFxStopMatching("s1", { name: "*" });
    await flushMicrotasks();
    expect(gmErrors.at(-1)?.detail).toMatch(/over 16/);
    expect(h.hostStore.seq).toBe(before); // no partial ends
    expect(ends).toHaveLength(0);
    h.gm.requestFxStopMatching("s1", { name: "wArD*" });
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect(h.hostLog.at(h.hostStore.seq)?.env.ops).toHaveLength(16);
    expect(h.hostStore.getAll("fxInstances").map((doc) => doc.name).sort())
      .toEqual(["Neutral Aura", "Secret Aura", "Ward Aura"]);
    expect(ends).toHaveLength(16);
    expect(JSON.stringify(ends)).not.toContain(privateRun);
    expect(JSON.stringify(player.store.world)).not.toContain(privateRun);
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
    expect(h.hostStore.getAll("fxInstances")).toHaveLength(19);
    expect(begins).toHaveLength(33); // undo regrants only the 16 stopped runs
    player.requestFxSync("s1");
    await flushMicrotasks();
    expect(begins).toHaveLength(50); // all 17 entitled runs replay on explicit sync
    const firstTimes = new Map(begins.slice(0, 17).map((cue) => [cue.runId, cue.atHostTime]));
    expect(begins.slice(17).every((cue) => cue.atHostTime === firstTimes.get(cue.runId))).toBe(true);
  });

  test("a player-clicked active tile queues reviewed code after its atomic graph commit; only GM gets the audit", async () => {
    let runs = 0;
    const h = await setup({}, async (_source, args, ctx, action) => {
      runs++;
      expect(ctx.callerId).toBe(PLAYER_ID);
      expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
      expect(args).toEqual({ target: "t-ivy" });
      await action("tags.edit", { refs: [{ coll: "tokens", id: args.target,
        parent: { coll: "scenes", id: "s1" } }], edit: "add", tags: ["scripted"] }, () => true);
      return { confidential: "GM result" };
    });
    await seedZone(h);
    const script = await reviewedScript();
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], steps: [
        { id: "find", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
        { id: "reviewed", kind: "script", macroId: script._id, bindings: { target: "currentToken" } },
      ] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const { client: player, bus: playerBus, pair } = await h.addPlayer(PLAYER_ID, "Rex");
    const seen: ClientEvents["automationTrace"][] = [];
    const playerResults: ClientEvents["macroResult"][] = [];
    h.gmBus.on("automationTrace", (msg) => seen.push(msg));
    playerBus.on("macroResult", (msg) => playerResults.push(msg));
    expect(player.store.getAll("automations")).toEqual([]);
    const before = h.hostStore.seq;
    h.gm.requestAutomation("zone-graph", "s1", "click", "t-pl", true);
    await flushMicrotasks();
    expect(seen.at(-1)?.detail).toContain("scripts (not executed)");
    expect(runs).toBe(0);
    expect(h.hostStore.seq).toBe(before);

    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("post-commit script timed out")); }, 3000);
      const off = h.gmBus.on("automationTrace", (msg) => {
        if (!msg.detail.includes("post-commit scripts completed")) return;
        clearTimeout(timer); off(); resolve();
      });
    });
    const requestId = player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await finished;
    expect(runs).toBe(1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["door-1", "scripted"]);
    expect((h.hostStore.get("macros", script._id) as MacroDocument).scriptState?.recent?.[0]?.key)
      .toMatch(/^pl-key:zone-\d+-0$/);
    expect(seen.at(-1)?.trace?.some((entry) => entry.includes("tags.edit"))).toBe(true);
    expect(playerResults).toEqual([]);
    expect(JSON.stringify(player.store.world)).not.toMatch(/GM ONLY|GM result/);
    const seq = h.hostStore.seq;
    pair.b.send("ops", frameMessage({ kind: "automation.request", requestId, automationId: "zone-graph",
      sceneId: "s1", method: "click", tokenId: "t-pl" }));
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(seq);
    expect(runs).toBe(1);
  });

  test("post-commit scripts await return values, honor run-as narrowing, and continue after an opted-in failure", async () => {
    const runAs: string[] = [];
    let calls = 0;
    const runner: ScriptRunner = async (_source, _args, context) => {
      runAs.push(context.runAs ?? "missing");
      if (++calls === 1) throw new Error("FIRST SCRIPT FAILED");
      return { runAs: context.runAs ?? null, callerId: context.callerId };
    };
    const h = await setup({}, runner);
    await seedZone(h);
    const source = "return { runAs: context.runAs };";
    const policy: Omit<ScriptPolicy, "approvedHash"> = { version: 1, sceneId: "s1", runAs: "gm",
      playerCallable: true, grants: [], inputs: [] };
    const script: MacroDocument = { _id: "run-as-script", type: "macro", kind: "script", name: "Run-as test",
      ownership: { default: 1 }, flags: {}, system: {}, command: source,
      script: { ...policy, approvedHash: await scriptApprovalHash(source, policy) } };
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], steps: [
        { id: "narrowed", kind: "script", macroId: script._id, runAs: "caller", onError: "continue" },
        { id: "approved", kind: "script", macroId: script._id, runAs: "approved" },
      ] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const gmTraces: ClientEvents["automationTrace"][] = [];
    h.gmBus.on("automationTrace", (message) => gmTraces.push(message));
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("continued post-commit run timed out")); }, 3000);
      const off = h.gmBus.on("automationTrace", (message) => {
        if (message.result !== "post-commit-failed" ||
            !message.detail.includes("remaining authorized actions completed")) return;
        clearTimeout(timer); off(); resolve();
      });
    });
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await finished;
    expect(runAs).toEqual(["caller", "gm"]);
    expect(calls).toBe(2);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect((h.hostStore.get("macros", script._id) as MacroDocument).scriptState?.recent).toHaveLength(2);
    expect(gmTraces.at(-1)).toMatchObject({ result: "post-commit-failed",
      detail: "1 post-commit action(s) failed; remaining authorized actions completed" });
    expect(gmTraces.at(-1)?.trace.some((line) => line.includes("FIRST SCRIPT FAILED"))).toBe(true);
    expect(gmTraces.at(-1)?.trace.some((line) => line.includes('{"runAs":"gm","callerId":"pl-key"}'))).toBe(true);
  });

  test("an awaited reviewed-script result branches after commit, resumes the same collection and keeps one run history", async () => {
    const h = await setup({}, async () => ({ hit: true, detail: { score: 17 } }));
    await seedZone(h);
    const script = await reviewedScript({ runAs: "gm", grants: [], inputs: [] });
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], gates: { oncePerToken: true }, steps: [
        { id: "select", kind: "select", selector: { kind: "tag", query: "door-1", collections: ["tokens"] } },
        { id: "run", kind: "script", macroId: script._id, captureResult: true },
        { id: "check", kind: "checkScriptResult", scriptStepId: "run", path: "value.hit",
          compare: "eq", value: true, otherwise: "miss" },
        { id: "mark", kind: "tags", edit: "add", tags: ["result-hit"] },
        { id: "notice", kind: "chat", audience: "gm", content: "Result branch passed" },
        { id: "stop", kind: "stop" },
        { id: "miss", kind: "landing", name: "miss" },
        { id: "failed", kind: "chat", audience: "gm", content: "Result branch missed" },
      ] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const traces: ClientEvents["automationTrace"][] = [];
    h.gmBus.on("automationTrace", (message) => traces.push(message));
    const completed = new Promise<ClientEvents["automationTrace"]>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("result branch continuation timed out")); }, 3000);
      const off = h.gmBus.on("automationTrace", (message) => {
        if (!message.detail.includes("post-commit scripts completed") ||
            !message.trace.some((line) => line.includes("Check Script Result [run] value.hit"))) return;
        clearTimeout(timer); off(); resolve(message);
      });
    });
    h.gm.requestAutomation("zone-graph", "s1", "click", "t-pl");
    const finished = await completed;
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens
      .find((token) => token._id === "t-ivy")?.taggerTags).toContain("result-hit");
    expect(h.hostStore.getAll("messages").map((message) => message.content)).toContain("Result branch passed");
    expect(h.hostStore.getAll("messages").map((message) => message.content)).not.toContain("Result branch missed");
    expect(finished.trace).toContain("reviewed script [run] completed with {\"hit\":true,\"detail\":{\"score\":17}}");
    expect(finished.trace).toContain("Check Script Result [run] value.hit: true eq true -> pass");
    expect(traces.some((message) => message.detail.includes("1 ops, 0 cues, 1 post-commit actions queued"))).toBe(true);
  });

  test("a captured ordinary script failure can route to an error landing only when continuation is opted in", async () => {
    const h = await setup({}, async () => { throw new Error("SCRIPT SOURCE FAILURE"); });
    await seedZone(h);
    const script = await reviewedScript({ runAs: "gm", grants: [], inputs: [] });
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], gates: {}, steps: [
        { id: "run", kind: "script", macroId: script._id, captureResult: true, onError: "continue" },
        { id: "check", kind: "checkScriptResult", scriptStepId: "run", path: "ok",
          compare: "eq", value: true, otherwise: "failed" },
        { id: "success", kind: "chat", audience: "gm", content: "Unexpected script success" },
        { id: "stop", kind: "stop" },
        { id: "failed", kind: "landing", name: "failed" },
        { id: "notice", kind: "chat", audience: "gm", content: "Failure branch ran" },
      ] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const final = new Promise<ClientEvents["automationTrace"]>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("failed-result branch timed out")); }, 3000);
      const off = h.gmBus.on("automationTrace", (message) => {
        if (message.result !== "post-commit-failed" ||
            !message.detail.includes("remaining authorized actions completed") ||
            !message.trace.some((line) => line.includes("Check Script Result [run] ok"))) return;
        clearTimeout(timer); off(); resolve(message);
      });
    });
    h.gm.requestAutomation("zone-graph", "s1", "click", "t-pl");
    const trace = await final;
    expect(h.hostStore.getAll("messages").map((message) => message.content)).toContain("Failure branch ran");
    expect(h.hostStore.getAll("messages").map((message) => message.content)).not.toContain("Unexpected script success");
    expect(trace.trace).toContain("Check Script Result [run] ok: false eq true -> fail");
    expect(trace.trace.some((line) => line.includes("POST-COMMIT SCRIPT [run] FAILED: SCRIPT SOURCE FAILURE"))).toBe(true);
  });

  test("a zone cannot elevate a caller-only saved script and rejects before consuming graph history", async () => {
    let runs = 0;
    const h = await setup({}, async () => { runs++; return null; });
    await seedZone(h);
    const script = await reviewedScript({ runAs: "caller", grants: [], inputs: [] });
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], steps: [
        { id: "elevate", kind: "script", macroId: script._id, runAs: "gm" },
      ] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const gmTraces: ClientEvents["automationTrace"][] = [];
    h.gmBus.on("automationTrace", (message) => gmTraces.push(message));
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(runs).toBe(0);
    expect(h.hostStore.seq).toBe(before);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count ?? 0).toBe(0);
    expect(gmTraces.at(-1)).toMatchObject({ result: "rejected",
      detail: `Reviewed script ${script._id} does not approve GM run-as` });
  });

  test("a failed post-commit Worker cannot undo a committed zone or leak diagnostics to a player", async () => {
    let runs = 0;
    const h = await setup({}, async () => { runs++; throw new Error("SECRET WORKER FAILURE"); });
    await seedZone(h);
    const script = await reviewedScript();
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], steps: [
        { id: "script", kind: "script", macroId: script._id, bindings: { target: "triggerToken" } },
        { id: "later", kind: "script", macroId: script._id, bindings: { target: "triggerToken" } },
      ] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const playerTraces: ClientEvents["automationTrace"][] = [];
    const playerResults: ClientEvents["macroResult"][] = [];
    const gmTraces: ClientEvents["automationTrace"][] = [];
    bus.on("automationTrace", (msg) => playerTraces.push(msg));
    bus.on("macroResult", (msg) => playerResults.push(msg));
    h.gmBus.on("automationTrace", (msg) => gmTraces.push(msg));
    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("post-commit failure timed out")); }, 3000);
      const off = h.gmBus.on("automationTrace", (msg) => {
        if (msg.result !== "post-commit-failed") return;
        clearTimeout(timer); off(); resolve();
      });
    });
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await completed;
    expect(runs).toBe(1);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state?.count).toBe(1);
    expect(gmTraces.at(-1)).toMatchObject({ result: "post-commit-failed",
      detail: "Script failed after the graph committed; graph state was not rolled back" });
    expect(gmTraces.at(-1)?.trace.at(-1)).toContain("SECRET WORKER FAILURE");
    expect(playerTraces).toEqual([]);
    expect(playerResults).toEqual([]);
    expect(JSON.stringify(player.store.world)).not.toContain("SECRET WORKER FAILURE");
  });

  test("a modified reviewed script revision is rejected before consuming tile history or committing actions", async () => {
    let runs = 0;
    const h = await setup({}, async () => { runs++; return null; });
    await seedZone(h);
    const script = await reviewedScript();
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], steps: [
        { id: "script", kind: "script", macroId: script._id, bindings: { target: "triggerToken" } },
      ] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejections: ClientEvents["rejected"][] = [];
    const gmTraces: ClientEvents["automationTrace"][] = [];
    bus.on("rejected", (msg) => rejections.push(msg));
    h.gmBus.on("automationTrace", (msg) => gmTraces.push(msg));
    // Imported world/editor corruption retained a syntactically valid hash but
    // changed source. Validating only the hash's SHAPE would commit the trap first.
    const current = h.hostStore.get("macros", script._id) as MacroDocument;
    current.command += "\n// unsanctioned revision";
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);
    expect(runs).toBe(0);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    expect(rejections).toEqual([]); // published tile never reveals private graph validity to the player
    expect(gmTraces.at(-1)).toMatchObject({ result: "rejected",
      detail: `Reviewed script ${script._id} changed since GM approval` });
    expect(JSON.stringify(player.store.world)).not.toContain("unsanctioned revision");
  });

  test("an unpublished script in a public active tile fails before consuming history or executing code", async () => {
    let runs = 0;
    const h = await setup({}, async () => { runs++; return null; });
    await seedZone(h);
    const script = await reviewedScript({ playerCallable: false }, { ownership: { default: 0 } });
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], steps: [
        { id: "script", kind: "script", macroId: script._id, bindings: { target: "triggerToken" } },
      ] } as unknown as Json,
    } }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejections: ClientEvents["rejected"][] = [];
    const gmTraces: ClientEvents["automationTrace"][] = [];
    bus.on("rejected", (msg) => rejections.push(msg));
    h.gmBus.on("automationTrace", (msg) => gmTraces.push(msg));
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(rejections).toEqual([]); // graph presence/permission is not disclosed to the player
    expect(gmTraces.at(-1)?.result).toBe("rejected");
    expect(h.hostStore.seq).toBe(before);
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    expect(runs).toBe(0);
    expect(player.store.get("macros", script._id)).toBeUndefined();
  });

  test("player invokes approved GM script by typed arguments; world actions run once, logs/source stay private across reconnect", async () => {
    let runs = 0;
    const runner: ScriptRunner = async (source, args, ctx, action) => {
      runs++;
      expect(source).toContain("GM ONLY");
      expect(ctx).toMatchObject({ callerId: PLAYER_ID, sceneId: "s1" });
      const found = await action("tags.find", { query: "door-1", options: { collections: ["tokens"] } }, () => true);
      expect(found).toMatchObject([{ ref: { coll: "tokens", id: "t-ivy" } }]);
      const ref = { coll: "tokens", id: "t-ivy", parent: { coll: "scenes", id: "s1" } };
      const narrowed = await action("tags.find", { query: "door-1", options: {
        collections: ["tokens"], includeRefs: [ref], excludeRefs: [ref], contains: false,
      } }, () => true);
      expect(narrowed).toEqual([]);
      await action("tags.edit", { refs: [{ coll: "tokens", id: args.target,
        parent: { coll: "scenes", id: "s1" } }], edit: "add", tags: ["opened"] }, () => true);
      await action("chat.say", { content: "The door creaks open", audience: "gm" }, () => true);
      return { changed: true, privateResult: "GM-ONLY-RETURN" };
    };
    const h = await setup({}, runner);
    const { client: player, bus: playerBus, pair } = await h.addPlayer(PLAYER_ID, "Rex");
    const macro = await reviewedScript();
    h.gm.submit([{ kind: "create", coll: "macros", data: macro },
      { kind: "update", ref: { coll: "tokens", id: "t-ivy", parent: { coll: "scenes", id: "s1" } },
        diff: { taggerTags: ["door-1"] } }]);
    await flushMicrotasks();
    const published = player.store.get("macros", macro._id) as MacroDocument;
    expect(published?.name).toBe(macro.name);
    expect(published?.command).toBe("");
    expect(published?.script).toMatchObject({ approvedHash: "", sceneId: "", grants: [], inputs: macro.script?.inputs });
    expect(JSON.stringify(published)).not.toMatch(/GM ONLY|NO PROJECT|[0-9a-f]{64}/);
    const playerResults: ClientEvents["macroResult"][] = [];
    const gmResults: ClientEvents["macroResult"][] = [];
    playerBus.on("macroResult", (msg) => playerResults.push(msg));
    h.gmBus.on("macroResult", (msg) => gmResults.push(msg));

    const requestId = player.requestMacro(macro._id, { target: "t-ivy" });
    const finished = await awaitMacroResult(playerBus, requestId);
    await flushMicrotasks();
    expect(finished.ok).toBe(true);
    expect(runs).toBe(1);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags)
      .toEqual(["door-1", "opened"]);
    expect((h.hostStore.get("macros", macro._id) as MacroDocument).scriptState?.recent)
      .toMatchObject([{ key: `${PLAYER_ID}:${requestId}`, revision: macro.script?.approvedHash }]);
    expect(player.store.get("macros", macro._id)?.scriptState).toBeNull(); // redacted delta
    expect(player.store.getAll("messages")).toEqual([]);
    expect(playerResults.at(-1)).toMatchObject({ requestId, ok: true, detail: "Script completed" });
    expect(playerResults.at(-1)?.trace).toBeUndefined();
    expect(playerResults.at(-1)?.result).toBeUndefined();
    expect(gmResults.at(-1)?.trace?.some((line) => line.includes("tags.edit"))).toBe(true);
    expect(gmResults.at(-1)?.result).toEqual({ changed: true, privateResult: "GM-ONLY-RETURN" });

    // The same request ID cannot be replayed even if the player reconnects and resends.
    const seq = h.hostStore.seq;
    const replayResult = awaitMacroResult(playerBus, requestId);
    pair.b.send("ops", frameMessage({ kind: "macro.request", requestId, macroId: macro._id, args: { target: "t-ivy" } }));
    expect((await replayResult).ok).toBe(false);
    await flushMicrotasks();
    expect(runs).toBe(1);
    expect(h.hostStore.seq).toBe(seq);
    h.host.removeSession(`peer-${PLAYER_ID}`);
    const { client: rejoined } = await h.addPlayer(PLAYER_ID, "Rex", { lastSeq: seq - 2 });
    expect(rejoined.store.get("macros", macro._id)?.command).toBe("");
    expect(rejoined.store.get("macros", macro._id)?.scriptState).toBeUndefined();
    expect(rejoined.store.getAll("messages")).toEqual([]);
    expect(JSON.stringify(rejoined.store.get("macros", macro._id))).not.toContain("GM ONLY");
  });

  test("caller mode cannot elevate tag writes; forged input, history and unreviewed revisions cannot run", async () => {
    let runs = 0;
    const runner: ScriptRunner = async (_src, args, _ctx, action) => {
      runs++;
      await action("tags.edit", { refs: [{ coll: "tokens", id: args.target,
        parent: { coll: "scenes", id: "s1" } }], edit: "add", tags: ["stolen"] }, () => true);
      return null;
    };
    const h = await setup({}, runner);
    const macro = await reviewedScript({ runAs: "caller" });
    h.gm.submit([{ kind: "create", coll: "macros", data: macro }]);
    await flushMicrotasks();
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const results: ClientEvents["macroResult"][] = [];
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("macroResult", (msg) => results.push(msg));
    bus.on("rejected", (msg) => rejected.push(msg));
    h.gmBus.on("macroResult", (msg) => results.push(msg));
    const deniedId = player.requestMacro(macro._id, { target: "t-ivy" });
    expect((await awaitMacroResult(bus, deniedId)).ok).toBe(false);
    await flushMicrotasks();
    expect(runs).toBe(1);
    expect(results.at(-1)?.ok).toBe(false);
    expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === "t-ivy")?.taggerTags).toBeUndefined();
    const before = h.hostStore.seq;
    const invalidId = player.requestMacro(macro._id, { target: "t-pl", arbitraryGrant: "chat" });
    expect((await awaitMacroResult(bus, invalidId)).ok).toBe(false);
    await flushMicrotasks();
    expect(runs).toBe(1);
    expect(h.hostStore.seq).toBe(before);
    player.submit([{ kind: "update", ref: { coll: "macros", id: macro._id }, diff: { command: "return 123" } }]);
    player.submit([{ kind: "update", ref: { coll: "macros", id: macro._id }, diff: { scriptState: null } }]);
    await flushMicrotasks();
    expect(rejected.filter((r) => r.reason === "forbidden").length).toBeGreaterThanOrEqual(2);
    expect((h.hostStore.get("macros", macro._id) as MacroDocument).command).toBe(macro.command);
    // GM can draft a new source, but it cannot run with the previous approval hash.
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: macro._id }, diff: { command: "return 'changed';" } }]);
    await flushMicrotasks();
    const next = h.hostStore.seq;
    const gmRequestId = h.gm.requestMacro(macro._id, { target: "t-pl" });
    const gmFailure = await awaitMacroResult(h.gmBus, gmRequestId);
    expect(runs).toBe(1);
    expect(h.hostStore.seq).toBe(next); // no durable marker on unapproved revision
    expect(gmFailure.detail).toMatch(/approval/);
  });

  test("a visibility grant and subsequent edits never expose source, policy or history", async () => {
    const h = await setup();
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const macro = await reviewedScript({}, { ownership: { default: 0 } });
    h.gm.submit([{ kind: "create", coll: "macros", data: macro }]);
    await flushMicrotasks();
    expect(player.store.get("macros", macro._id)).toBeUndefined();
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: macro._id }, diff: { ownership: { default: 1 } } }]);
    await flushMicrotasks();
    expect(player.store.get("macros", macro._id)?.command).toBe("");
    expect(JSON.stringify(player.store.get("macros", macro._id))).not.toMatch(/GM ONLY|NO PROJECT|[0-9a-f]{64}/);
    h.gm.submit([{ kind: "update", ref: { coll: "macros", id: macro._id }, diff: {
      command: "// even newer GM secret\nreturn 42", system: { confidential: "DO NOT SHARE" },
    } }]);
    await flushMicrotasks();
    expect(player.store.get("macros", macro._id)?.command).toBe("");
    expect(JSON.stringify(player.store.get("macros", macro._id))).not.toMatch(/secret|CONFIDENTIAL|DO NOT SHARE/i);
  });
});

/** Named GM Revert is deliberately distinct from the newest global Undo. */
describe("durable GM Revert for world actions", () => {
  function trapActor(id = "trap-victim", system: Record<string, Json> =
    { pf1e: { hp: 12, hpMax: 20, tempHpSources: { ward: 4 }, nonlethalDamage: 3 } }): ActorDocument {
    return { _id: id, type: "actor", name: "Trap victim", ownership: { default: 0, [PLAYER_ID]: 3 },
      flags: {}, system, items: [], effects: [] };
  }

  async function readyTrap(h: Harness, steps: AutomationDefinition["steps"] = [
    { id: "hurt", kind: "hurtHeal", amount: -6, targets: "triggering" },
    { id: "notice", kind: "chat", audience: "gm", content: "A trap snapped" },
  ]): Promise<void> {
    await seedZone(h);
    h.gm.submit([{ kind: "create", coll: "actors", data: trapActor() },
      { kind: "update", ref: tokenRef, diff: { actorId: "trap-victim" } },
      { kind: "update", ref: { coll: "automations", id: "zone-graph" },
        diff: { definition: { ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true },
          steps } as unknown as Json } }]);
    await flushMicrotasks();
  }

  test.each([false, true])("player-fired Hurt / Heal spends temporary HP; GM Revert restores actor/history/chat (formula %s)", async (formula) => {
    const h = await setup(); await readyTrap(h, [
      { id: "hurt", kind: "hurtHeal", ...(formula ? { formula: "-(1d1 + 5)" } : { amount: -6 }), targets: "triggering" },
      { id: "notice", kind: "chat", audience: "gm", content: "A trap snapped" },
    ]);
    const { client: player, bus } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    bus.on("rejected", (r) => rejected.push(r));
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before + 1);
    expect((h.hostStore.get("actors", "trap-victim") as ActorDocument).system.pf1e)
      .toMatchObject({ hp: 10, nonlethalDamage: 3 });
    expect((h.hostStore.get("actors", "trap-victim") as ActorDocument).system.pf1e)
      .not.toHaveProperty("tempHpSources");
    expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["A trap snapped"]);
    const receipt = h.hostStore.getAll("actionReceipts")[0];
    if (!receipt) throw new Error("action receipt missing");
    expect(receipt).toMatchObject({ type: "actionReceipt", status: "ready", commits: 1 });
    expect(receipt?.inverses.some((op) => op.kind === "update" && op.ref.coll === "actors")).toBe(true);
    expect(h.gm.store.getAll("actionReceipts")).toHaveLength(1);
    expect(player.store.getAll("actionReceipts")).toEqual([]);
    expect(JSON.stringify(player.store.world)).not.toMatch(/"type":"actionReceipt"|A trap snapped/);
    player.actionRevert(receipt._id);
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
    expect((h.hostStore.get("actors", "trap-victim") as ActorDocument).system.pf1e)
      .toMatchObject({ hp: 10 });
    h.gm.actionRevert(receipt._id);
    await flushMicrotasks();
    expect(h.hostStore.getAll("actionReceipts")[0]?.status).toBe("reverted");
    expect((h.hostStore.get("actors", "trap-victim") as ActorDocument).system.pf1e)
      .toMatchObject({ hp: 12, tempHpSources: { ward: 4 }, nonlethalDamage: 3 });
    expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
    expect(h.hostStore.getAll("messages")).toHaveLength(0);
    const after = h.hostStore.seq;
    h.gm.actionRevert(receipt._id);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(after);
  });

  test("Revert refuses a later HP edit, never erases the new value, but accepts a different untouched actor", async () => {
    const h = await setup(); await readyTrap(h, [
      { id: "hurt", kind: "hurtHeal", amount: -6, targets: "triggering" },
    ]);
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const rejected: ClientEvents["rejected"][] = [];
    h.gmBus.on("rejected", (r) => rejected.push(r));
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    const receipt = h.hostStore.getAll("actionReceipts")[0];
    if (!receipt) throw new Error("action receipt missing");
    h.gm.submit([{ kind: "update", ref: { coll: "actors", id: "trap-victim" },
      diff: { "system.pf1e.hp": 7 } }]);
    await flushMicrotasks();
    const before = h.hostStore.seq;
    h.gm.actionRevert(receipt._id);
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);
    expect(rejected.at(-1)?.detail).toMatch(/stale.*actors\/trap-victim/);
    expect((h.hostStore.get("actors", "trap-victim") as ActorDocument).system.pf1e)
      .toMatchObject({ hp: 7 });
    expect(receipt?.status).toBe("ready");
  });

  test("bad HP, missing actor and a later failed step leave no damage or receipt", async () => {
    const h = await setup(); await readyTrap(h, [
      { id: "hurt", kind: "hurtHeal", amount: -6, targets: "triggering" },
      { id: "bad", kind: "door", mode: "open" },
    ]);
    const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
    const before = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(before);
    expect(h.hostStore.getAll("actionReceipts")).toHaveLength(0);
    expect((h.hostStore.get("actors", "trap-victim") as ActorDocument).system.pf1e)
      .toMatchObject({ hp: 12, tempHpSources: { ward: 4 } });
    h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "zone-graph" },
      diff: { definition: { ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true },
        steps: [{ id: "hurt", kind: "hurtHeal", amount: -6, targets: "triggering" }] } as unknown as Json } },
      { kind: "update", ref: { coll: "actors", id: "trap-victim" }, diff: { system: {} } }]);
    await flushMicrotasks();
    const invalid = h.hostStore.seq;
    player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
    await flushMicrotasks();
    expect(h.hostStore.seq).toBe(invalid);
    expect(h.hostStore.getAll("actionReceipts")).toHaveLength(0);
  });
});

describe("reviewed script action receipts", () => {
  const tileRef = { coll: "tiles" as const, id: "zone",
    parent: { coll: "scenes" as const, id: "s1" } };
  test("multi-RPC script with a later failure keeps one ready partial receipt and Revert restores ALL writes", async () => {
    const h = await setup({}, async (_source, _args, _context, action) => {
      await action("tags.edit", { refs: [tileRef], edit: "add", tags: ["first"] }, () => true);
      await action("tags.edit", { refs: [tileRef], edit: "add", tags: ["second"] }, () => true);
      throw new Error("third action failed after two commits");
    });
    await seedZone(h);
    const script = await reviewedScript({ inputs: [], grants: ["tags.write"] });
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const requestId = h.gm.requestMacro(script._id, {});
    expect((await awaitMacroResult(h.gmBus, requestId)).ok).toBe(false);
    await flushMicrotasks();
    const receipt = h.hostStore.getAll("actionReceipts")[0];
    if (!receipt) throw new Error("action receipt missing");
    expect(receipt).toMatchObject({ status: "ready", outcome: "partial", commits: 2 });
    expect((h.hostStore.resolve(tileRef) as TileDocument).taggerTags).toEqual(["first", "second"]);
    h.gm.actionRevert(receipt._id);
    await flushMicrotasks();
    expect(h.hostStore.getAll("actionReceipts")[0]?.status).toBe("reverted");
    expect((h.hostStore.resolve(tileRef) as TileDocument).taggerTags).toBeUndefined();
    // Retain at-most-once execution history: reverting effects is not permission to replay an old request.
    expect((h.hostStore.get("macros", script._id) as MacroDocument).scriptState?.recent).toHaveLength(1);
  });

  test("GM cannot Revert while the worker is live; a partial run can be reverted after it settles", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let committed: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => { committed = resolve; });
    const h = await setup({}, async (_source, _args, _context, action) => {
      await action("tags.edit", { refs: [tileRef], edit: "add", tags: ["pending"] }, () => true);
      committed?.();
      await gate;
      throw new Error("later worker failure");
    });
    await seedZone(h);
    const script = await reviewedScript({ inputs: [], grants: ["tags.write"] });
    h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
    await flushMicrotasks();
    const rejected: ClientEvents["rejected"][] = [];
    h.gmBus.on("rejected", (r) => rejected.push(r));
    const requestId = h.gm.requestMacro(script._id, {});
    const finished = awaitMacroResult(h.gmBus, requestId);
    await firstWrite;
    await flushMicrotasks();
    const receipt = h.hostStore.getAll("actionReceipts")[0];
    if (!receipt) throw new Error("action receipt missing");
    expect(receipt.status).toBe("pending");
    h.gm.actionRevert(receipt._id);
    await flushMicrotasks();
    expect(rejected.at(-1)?.detail).toMatch(/still running/);
    expect((h.hostStore.resolve(tileRef) as TileDocument).taggerTags).toEqual(["pending"]);
    release?.();
    expect((await finished).ok).toBe(false);
    await flushMicrotasks();
    expect(h.hostStore.getAll("actionReceipts")[0]).toMatchObject({ status: "ready", outcome: "partial" });
    h.gm.actionRevert(receipt._id);
    await flushMicrotasks();
    expect((h.hostStore.resolve(tileRef) as TileDocument).taggerTags).toBeUndefined();
  });
});

test("one GM Revert reverses a trap's HP and its later reviewed script writes, without undoing the script replay guard", async () => {
  const h = await setup({}, async (_source, _args, _context, action) => {
    await action("tags.edit", { refs: [tokenRef], edit: "add", tags: ["poisoned"] }, () => true);
    return { ok: true };
  });
  await seedZone(h);
  const script = await reviewedScript({ inputs: [], grants: ["tags.write"] });
  h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
  await flushMicrotasks();
  const victim: ActorDocument = { _id: "trap-target", type: "actor", name: "Target",
    ownership: { default: 0, [PLAYER_ID]: 3 }, flags: {},
    system: { pf1e: { hp: 18, hpMax: 20 } }, items: [], effects: [] };
  h.gm.submit([{ kind: "create", coll: "actors", data: victim },
    { kind: "update", ref: tokenRef, diff: { actorId: victim._id } },
    { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true },
        steps: [{ id: "hurt", kind: "hurtHeal", amount: -5, targets: "triggering" },
          { id: "script", kind: "script", macroId: script._id }] } as unknown as Json } }]);
  await flushMicrotasks();
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("script did not finish")); }, 3000);
    const off = h.gmBus.on("automationTrace", (msg) => {
      if (!msg.detail.includes("post-commit scripts completed")) return;
      clearTimeout(timer); off(); resolve();
    });
  });
  player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
  await finished;
  await flushMicrotasks();
  const receipt = h.hostStore.getAll("actionReceipts")[0];
  if (!receipt) throw new Error("action receipt missing");
  expect(receipt).toMatchObject({ status: "ready", outcome: "completed", commits: 2 });
  expect((h.hostStore.get("actors", victim._id) as ActorDocument).system.pf1e).toMatchObject({ hp: 13 });
  expect((h.hostStore.resolve(tokenRef) as TokenDocument).taggerTags).toEqual(["poisoned"]);
  expect(player.store.getAll("actionReceipts")).toEqual([]);
  h.gm.actionRevert(receipt._id);
  await flushMicrotasks();
  expect((h.hostStore.get("actors", victim._id) as ActorDocument).system.pf1e).toMatchObject({ hp: 18 });
  expect((h.hostStore.resolve(tokenRef) as TokenDocument).taggerTags).toBeUndefined();
  expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
  expect((h.hostStore.get("macros", script._id) as MacroDocument).scriptState?.recent).toHaveLength(1);
});

test("GM Revert deletes a prefab's linked tiles and graph, but refuses a later attached child", async () => {
  const h = await setup();
  const prefab: PrefabDocument = {
    _id: "revert-prefab", type: "prefab", name: "Linked tiles", ownership: { default: 0 },
    flags: {}, system: {}, definition: { version: 1, sourceSceneId: "s1", gridSize: 100,
      origin: { x: 100, y: 100 }, parts: [
        { id: "zone", coll: "tiles", doc: zoneTile() },
        { id: "child", coll: "tiles", parentId: "zone", doc: { ...zoneTile(), _id: "child",
          x: 125, y: 125, width: 50, height: 50 } },
      ], graphs: [{ id: "zone-graph", doc: { ...zoneDoc(), definition: {
        version: 1, sceneId: "s1", tileId: "child", methods: ["click"], steps: [
          { id: "note", kind: "chat", audience: "gm", content: "Linked" },
        ],
      } } }],
    },
  };
  h.gm.submit([{ kind: "create", coll: "prefabs", data: prefab }]);
  await flushMicrotasks();
  const placed: ClientEvents["prefabResult"][] = [];
  h.gmBus.on("prefabResult", (r) => placed.push(r));
  h.gm.requestPrefabPlace(prefab._id, "s1", { x: 400, y: 400 });
  await flushMicrotasks();
  expect(placed.at(-1)?.ok).toBe(true);
  const receipt = h.hostStore.getAll("actionReceipts")[0];
  if (!receipt) throw new Error("prefab receipt missing");
  expect(receipt.inverses.filter((op) => op.kind === "delete")).toHaveLength(3);
  const scene = h.hostStore.get("scenes", "s1") as SceneDocument;
  const root = scene.tiles.find((tile) => tile._id === placed.at(-1)?.rootId);
  if (!root) throw new Error("placed root missing");
  const marker = root.flags.prefab as { instanceId: string; rootId: string };
  const child = scene.tiles.find((tile) => tile._id !== root._id);
  const graph = h.hostStore.getAll("automations")[0];
  expect(child?.flags.prefab).toMatchObject({ parentId: root._id });
  expect(graph?.definition.tileId).toBe(child?._id);

  const added = { ...zoneTile(), _id: "later-attached-child", x: 650, y: 650,
    flags: { prefab: { ...marker, parentId: root._id, sourceScene: "s1", locked: false } } };
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: added }]);
  await flushMicrotasks();
  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (r) => rejected.push(r));
  const before = h.hostStore.seq;
  h.gm.actionRevert(receipt._id);
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(before);
  expect(rejected.at(-1)?.detail).toMatch(/new dependent/);
  expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles).toHaveLength(3);

  h.gm.submit([{ kind: "delete", ref: { coll: "tiles", id: added._id,
    parent: { coll: "scenes", id: "s1" } } }]);
  await flushMicrotasks();
  h.gm.actionRevert(receipt._id);
  await flushMicrotasks();
  expect(h.hostStore.getAll("actionReceipts")[0]?.status).toBe("reverted");
  expect((h.hostStore.get("scenes", "s1") as SceneDocument).tiles).toEqual([]);
  expect(h.hostStore.getAll("automations")).toEqual([]);
  expect(h.hostStore.get("prefabs", prefab._id)).toEqual(prefab);
});

test("an interleaved GM edit between reviewed script RPCs fails closed and never gets overwritten by Revert", async () => {
  const tileRef = { coll: "tiles" as const, id: "zone",
    parent: { coll: "scenes" as const, id: "s1" } };
  let unblock: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  let wrote: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => { wrote = resolve; });
  const h = await setup({}, async (_source, _args, _ctx, action) => {
    await action("tags.edit", { refs: [tileRef], edit: "add", tags: ["first"] }, () => true);
    wrote?.();
    await gate;
    return action("tags.edit", { refs: [tileRef], edit: "add", tags: ["second"] }, () => true);
  });
  await seedZone(h);
  const script = await reviewedScript({ inputs: [], grants: ["tags.write"] });
  h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
  await flushMicrotasks();
  const requestId = h.gm.requestMacro(script._id, {});
  const finished = awaitMacroResult(h.gmBus, requestId);
  await firstWrite;
  await flushMicrotasks();
  const receipt = h.hostStore.getAll("actionReceipts")[0];
  if (!receipt) throw new Error("first script write not audited");
  h.gm.submit([{ kind: "update", ref: tileRef, diff: { taggerTags: ["first", "GM-later"] } }]);
  await flushMicrotasks();
  unblock?.();
  expect((await finished).ok).toBe(false);
  await flushMicrotasks();
  expect(h.hostStore.getAll("actionReceipts")[0]).toMatchObject({ status: "ready", outcome: "partial", commits: 1 });
  expect((h.hostStore.resolve(tileRef) as TileDocument).taggerTags).toEqual(["first", "GM-later"]);
  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (r) => rejected.push(r));
  const before = h.hostStore.seq;
  h.gm.actionRevert(receipt._id);
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(before);
  expect(rejected.at(-1)?.detail).toMatch(/stale.*tiles\/zone/);
  expect((h.hostStore.resolve(tileRef) as TileDocument).taggerTags).toEqual(["first", "GM-later"]);
});

test("legacy Undo of an in-flight script RPC removes its provisional receipt; later surviving writes remain GM Revertable", async () => {
  const tileRef = { coll: "tiles" as const, id: "zone",
    parent: { coll: "scenes" as const, id: "s1" } };
  let unblock: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  let wrote: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => { wrote = resolve; });
  const h = await setup({}, async (_source, _args, _ctx, action) => {
    await action("tags.edit", { refs: [tileRef], edit: "add", tags: ["temporary"] }, () => true);
    wrote?.();
    await gate;
    return action("tags.edit", { refs: [tileRef], edit: "add", tags: ["survives"] }, () => true);
  });
  await seedZone(h);
  const script = await reviewedScript({ inputs: [], grants: ["tags.write"] });
  h.gm.submit([{ kind: "create", coll: "macros", data: script }]);
  await flushMicrotasks();
  const requestId = h.gm.requestMacro(script._id, {});
  const finished = awaitMacroResult(h.gmBus, requestId);
  await firstWrite;
  await flushMicrotasks();
  expect(h.hostStore.getAll("actionReceipts")[0]?.status).toBe("pending");
  expect(h.host.undo().ok).toBe(true);
  await flushMicrotasks();
  expect(h.hostStore.getAll("actionReceipts")).toEqual([]);
  expect((h.hostStore.resolve(tileRef) as TileDocument).taggerTags).toBeUndefined();
  unblock?.();
  expect((await finished).ok).toBe(true);
  await flushMicrotasks();
  const receipt = h.hostStore.getAll("actionReceipts")[0];
  if (!receipt) throw new Error("surviving script write not audited");
  expect(receipt).toMatchObject({ status: "ready", outcome: "completed", commits: 1 });
  expect((h.hostStore.resolve(tileRef) as TileDocument).taggerTags).toEqual(["survives"]);
  h.gm.actionRevert(receipt._id);
  await flushMicrotasks();
  expect((h.hostStore.resolve(tileRef) as TileDocument).taggerTags).toBeUndefined();
  expect((h.hostStore.get("macros", script._id) as MacroDocument).scriptState?.recent).toHaveLength(1);
});

test("chat retention evicts an old trap card without preventing GM Revert of its mechanical effects", async () => {
  const h = await setup();
  await seedZone(h);
  const victim: ActorDocument = { _id: "retained-target", type: "actor", name: "Target",
    ownership: { default: 0, [PLAYER_ID]: 3 }, flags: {},
    system: { pf1e: { hp: 16, hpMax: 20 } }, items: [], effects: [] };
  h.gm.submit([{ kind: "create", coll: "actors", data: victim },
    { kind: "update", ref: tokenRef, diff: { actorId: victim._id } },
    { kind: "update", ref: { coll: "automations", id: "zone-graph" }, diff: {
      definition: { ...zoneDoc().definition, methods: ["click"], gates: { playerRunnable: true },
        steps: [{ id: "hurt", kind: "hurtHeal", amount: -5, targets: "triggering" },
          { id: "card", kind: "chat", audience: "gm", content: "Trap card" }] } as unknown as Json } }]);
  await flushMicrotasks();
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  player.requestAutomationClick("s1", "zone", { x: 150, y: 150 }, "t-pl");
  await flushMicrotasks();
  const receipt = h.hostStore.getAll("actionReceipts")[0];
  if (!receipt) throw new Error("trap receipt missing");
  expect((h.hostStore.get("actors", victim._id) as ActorDocument).system.pf1e).toMatchObject({ hp: 11 });
  expect(h.hostStore.getAll("messages").map((m) => m.content)).toEqual(["Trap card"]);
  const later = Array.from({ length: 100 }, (_, i): Op => ({ kind: "create", coll: "messages", data: {
    _id: `later-chat-${i}`, type: "message", name: `Later ${i}`, author: GM_ID,
    ownership: { default: 1 }, flags: {}, system: {}, content: `Later chat ${i}`,
    whisper: [], roll: null, flavor: "",
  } as MessageDocument }));
  expect(h.host.commitSystem(later, false).ok).toBe(true);
  await flushMicrotasks();
  expect(h.hostStore.getAll("messages")).toHaveLength(100);
  expect(h.hostStore.getAll("messages")[0]?.content).toBe("Later chat 0");
  expect(h.hostStore.getAll("messages").some((m) => m.content === "Trap card")).toBe(false);
  h.gm.actionRevert(receipt._id);
  await flushMicrotasks();
  expect(h.hostStore.getAll("actionReceipts")[0]?.status).toBe("reverted");
  expect((h.hostStore.get("actors", victim._id) as ActorDocument).system.pf1e).toMatchObject({ hp: 16 });
  expect((h.hostStore.get("automations", "zone-graph") as AutomationDocument).state).toBeUndefined();
  expect(h.hostStore.getAll("messages")).toHaveLength(100);
  expect(h.hostStore.getAll("messages")[0]?.content).toBe("Later chat 0");
});

test("HostSync dispatches the five combat changes to the encounter scene's graphs and restore never replays them", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() }]);
  await flushMicrotasks();
  const combatant = (id: string, tokenId: string, initiative: number): CombatantDocument => ({
    _id: id, type: "combatant", name: id, ownership: { default: 3 }, flags: {}, system: {},
    tokenId, actorId: null, initiative, hidden: false, defeated: false });
  const fight: CombatDocument = { _id: "fight", type: "combat", name: "Fight", ownership: { default: 3 },
    flags: { core: { sceneId: "s1" } }, system: {}, round: 0, turn: 0,
    combatants: [combatant("c-a", "t-pl", 20), combatant("c-b", "t-ivy", 10)] };
  const chat = (content: string): AutomationDefinition["steps"] =>
    [{ id: "notice", kind: "chat", audience: "gm", content }];
  const tag = (name: string): AutomationDefinition["steps"] => [
    { id: "select", kind: "select", selector: { kind: "triggering" } },
    { id: "mark", kind: "tags", edit: "add", tags: [name] }];
  const events: AutomationDocument = { ...zoneDoc(), _id: "fight-events", name: "Fight events",
    definition: { ...zoneDoc().definition, tileId: "zone",
      methods: [...COMBAT_TRIGGER_METHODS], gates: {}, steps: chat("{{method}} by {{user}}") } };
  const endedGraph: AutomationDocument = { ...zoneDoc(), _id: "turn-end", name: "Turn end",
    definition: { ...zoneDoc().definition, tileId: "zone",
      methods: ["combatTurnEnd"], gates: {}, steps: tag("ended") } };
  const startedGraph: AutomationDocument = { ...zoneDoc(), _id: "turn-start", name: "Turn start",
    definition: { ...zoneDoc().definition, tileId: "zone",
      methods: ["combatTurnStart"], gates: {}, steps: tag("started") } };
  h.gm.submit([{ kind: "create", coll: "automations", data: events },
    { kind: "create", coll: "automations", data: endedGraph },
    { kind: "create", coll: "automations", data: startedGraph }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);
  const tagsOf = (tokenId: string) =>
    (h.hostStore.get("scenes", "s1") as SceneDocument).tokens.find((t) => t._id === tokenId)?.taggerTags ?? [];
  const setCombat = async (diff: Record<string, Json | null>) => {
    h.gm.submit([{ kind: "update", ref: { coll: "combats", id: "fight" }, diff }]);
    await flushMicrotasks();
  };

  // Creating an unstarted encounter (round 0) is not an event; the tracker's Start button
  // reaches round 1 with a real committed round/turn change.
  h.gm.submit([{ kind: "create", coll: "combats", data: fight }]);
  await flushMicrotasks();
  expect(messages()).toEqual([]);
  await setCombat({ round: 1, turn: 0, combatants: fight.combatants as unknown as Json });
  expect(messages()).toEqual(["combatStart by gm-key", "combatRound by gm-key", "combatTurnStart by gm-key"]);
  expect(tagsOf("t-pl")).toContain("started"); // the first current combatant's token

  // Advancing a turn ends the outgoing combatant and starts the incoming one, on the right tokens.
  await setCombat({ round: 1, turn: 1 });
  expect(messages().slice(3)).toEqual(["combatTurnEnd by gm-key", "combatTurnStart by gm-key"]);
  expect(tagsOf("t-pl")).toContain("ended");
  expect(tagsOf("t-ivy")).toContain("started");

  // Wrapping a round is the ordered trio; a combatant-only edit is not an event.
  const beforeWrap = messages().length;
  await setCombat({ round: 2, turn: 0 });
  expect(messages().slice(beforeWrap)).toEqual(["combatTurnEnd by gm-key", "combatRound by gm-key", "combatTurnStart by gm-key"]);
  const beforeRoster = messages().length;
  await setCombat({ combatants: [...fight.combatants, combatant("c-c", "t-pl", 5)] as unknown as Json });
  expect(messages().length).toBe(beforeRoster);
  expect(h.hostStore.get("automations", "fight-events")?.state?.recent?.map((entry) => entry.method))
    .toEqual(["combatStart", "combatRound", "combatTurnStart", "combatTurnEnd", "combatTurnStart",
      "combatTurnEnd", "combatRound", "combatTurnStart"]);

  // Neither GM nor player can manufacture a combat event through the request path.
  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (event) => rejected.push(event));
  const beforeSpoof = h.hostStore.seq;
  h.gm.requestAutomation("fight-events", "s1", "combatStart");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(beforeSpoof);
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const playerRejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => playerRejected.push(event));
  expect(player.store.getAll("automations")).toEqual([]);
  player.requestAutomation("fight-events", "s1", "combatRound");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(beforeSpoof);
  expect(playerRejected.at(-1)?.reason).toBe("invalid_schema");
  expect(player.store.getAll("messages")).toEqual([]);

  // Deleting a running encounter is MATT's combatend.
  const beforeDelete = messages().length;
  h.gm.submit([{ kind: "delete", ref: { coll: "combats", id: "fight" } }]);
  await flushMicrotasks();
  expect(messages().slice(beforeDelete)).toEqual(["combatEnd by gm-key"]);
  expect(h.hostStore.get("combats", "fight")).toBeUndefined();

  // Restoring the encounter must not replay any of it: undo back to "no encounter" and the
  // message log is exactly the snapshot taken before the re-created encounter existed.
  const snapshot = messages();
  const restarted: CombatDocument = { ...fight, round: 1, turn: 0 };
  h.gm.submit([{ kind: "create", coll: "combats", data: restarted }]);
  await flushMicrotasks();
  expect(messages().slice(snapshot.length))
    .toEqual(["combatStart by gm-key", "combatRound by gm-key", "combatTurnStart by gm-key"]);
  let guard = 0;
  while (h.hostStore.get("combats", "fight") && guard++ < 6) {
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
  }
  expect(h.hostStore.get("combats", "fight")).toBeUndefined();
  expect(messages()).toEqual(snapshot);
});

test("HostSync dispatches lightingChange for a committed darkness edit and timeChange for a committed clock write", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() }]);
  await flushMicrotasks();
  const chat = (content: string): AutomationDefinition["steps"] =>
    [{ id: "notice", kind: "chat", audience: "gm", content }];
  const environment: AutomationDocument = { ...zoneDoc(), _id: "environment", name: "Environment",
    definition: { ...zoneDoc().definition, tileId: "zone",
      methods: ["lightingChange", "timeChange"], gates: {}, steps: chat("{{method}} by {{user}}") } };
  const lightingOnly: AutomationDocument = { ...zoneDoc(), _id: "lighting-only", name: "Lighting only",
    definition: { ...zoneDoc().definition, tileId: "zone",
      methods: ["lightingChange"], gates: {}, steps: [{ id: "select", kind: "select", selector: { kind: "triggering" } },
        { id: "mark", kind: "tags", edit: "add", tags: ["lit"] }] } };
  h.gm.submit([{ kind: "create", coll: "automations", data: environment },
    { kind: "create", coll: "automations", data: lightingOnly }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);
  const darknessOf = (id: string) => (h.hostStore.get("scenes", id) as SceneDocument).darkness;
  const clock = () => readWorldClock(h.hostStore.getAll("settings"));

  // A committed ambient-darkness edit is MATT's On Lighting Change; a no-op write is not.
  h.gm.submit([{ kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { darkness: 0.4 } }]);
  await flushMicrotasks();
  expect(darknessOf("s1")).toBeCloseTo(0.4, 5);
  expect(messages()).toEqual(["lightingChange by gm-key"]);
  const beforeNoop = messages().length;
  h.gm.submit([{ kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { darkness: 0.4 } }]);
  await flushMicrotasks();
  expect(messages().length).toBe(beforeNoop);
  expect(h.hostStore.get("automations", "environment")?.state?.recent?.map((entry) => entry.method))
    .toEqual(["lightingChange"]);

  // A committed world-clock write is MATT's On Time Change — including the creating envelope
  // that installs a world-settings document for the first time.
  h.gm.submit(worldSettingsOps(h.hostStore.getAll("settings"), { clockSeconds: 3_600 }));
  await flushMicrotasks();
  expect(clock()).toBe(3_600);
  expect(messages().slice(beforeNoop)).toEqual(["timeChange by gm-key"]);
  expect(h.hostStore.get("automations", "environment")?.state?.recent?.map((entry) => entry.method))
    .toEqual(["lightingChange", "timeChange"]);
  // Updating only an unrelated setting does not touch the clock and fires nothing.
  const beforeUnrelated = messages().length;
  h.gm.submit(worldSettingsOps(h.hostStore.getAll("settings"), { detectionMultiplier: 2 }));
  await flushMicrotasks();
  expect(messages().length).toBe(beforeUnrelated);

  // Neither GM nor player can manufacture either event.
  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (event) => rejected.push(event));
  const beforeSpoof = h.hostStore.seq;
  h.gm.requestAutomation("environment", "s1", "lightingChange");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(beforeSpoof);
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const playerRejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => playerRejected.push(event));
  expect(player.store.getAll("automations")).toEqual([]);
  player.requestAutomation("environment", "s1", "timeChange");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(beforeSpoof);
  expect(playerRejected.at(-1)?.reason).toBe("invalid_schema");
  expect(player.store.getAll("messages")).toEqual([]);
  // A player cannot write the replicated clock either.
  player.submit([{ kind: "update", ref: { coll: "settings", id: "world-settings" },
    diff: { "system.clockSeconds": 900 } }]);
  await flushMicrotasks();
  expect(clock()).toBe(3_600);
  expect(playerRejected.at(-1)?.reason).toBe("forbidden");

  // A graph's own Scene Lighting action commits a real change: the destination graph fires, and
  // the reentry budget bounds a self-retriggering pair instead of growing the call stack.
  const lightingAction: AutomationDocument = { ...zoneDoc(), _id: "lighting-action", name: "Dimmer",
    definition: { ...zoneDoc().definition, tileId: "zone", methods: ["manual"], gates: {},
      steps: [{ id: "dim", kind: "sceneLighting", mode: "set", darkness: 0.8 }] } };
  h.gm.submit([{ kind: "create", coll: "automations", data: lightingAction }]);
  await flushMicrotasks();
  const beforeActionMessages = messages();
  h.gm.requestAutomation("lighting-action", "s1", "manual");
  await flushMicrotasks();
  expect(darknessOf("s1")).toBeCloseTo(0.8, 5);
  expect(messages().slice(beforeActionMessages.length)).toEqual(["lightingChange by gm-key"]);
  // No triggering token rides an environment event, so the token-tag graph has nothing to tag.
  expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens.filter((t) => t.taggerTags?.includes("lit")))
    .toHaveLength(0);
  expect(h.hostStore.get("automations", "lighting-only")?.state?.recent?.at(-1)?.tokenId).toBeUndefined();

  // Restore never replays: undoing the graph's own darkness change puts the scene back and
  // reverts the graph's chat row with it, without appending a new lightingChange.
  let guard = 0;
  while (darknessOf("s1") > 0.4 && guard++ < 6) {
    expect(h.host.undo().ok).toBe(true);
    await flushMicrotasks();
  }
  expect(darknessOf("s1")).toBeCloseTo(0.4, 5);
  expect(messages()).toEqual(beforeActionMessages);
});

test("HostSync fires sceneLoad for each viewer that loads the active scene, once per scene held", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() }]);
  await flushMicrotasks();
  const published: AutomationDocument = { ...zoneDoc(), _id: "arrival-plate", name: "Arrival plate",
    definition: { ...zoneDoc().definition, tileId: "zone", methods: ["sceneLoad"],
      gates: { playerRunnable: true }, steps: [{ id: "notice", kind: "chat", audience: "gm",
        content: "{{method}} by {{user}}" }] } };
  const privateGraph: AutomationDocument = { ...zoneDoc(), _id: "private-arrival", name: "Private arrival",
    definition: { ...zoneDoc().definition, tileId: "zone", methods: ["sceneLoad"],
      gates: {}, steps: [{ id: "notice", kind: "chat", audience: "gm", content: "private {{user}}" }] } };
  h.gm.submit([{ kind: "create", coll: "automations", data: published },
    { kind: "create", coll: "automations", data: privateGraph }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);
  const recent = (id: string) =>
    h.hostStore.get("automations", id)?.state?.recent?.map((entry) => ({ method: entry.method, userId: entry.userId }));

  // Neither GM nor player may ask for the event; it comes from a real session load.
  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (event) => rejected.push(event));
  const beforeSpoof = h.hostStore.seq;
  h.gm.requestAutomation("arrival-plate", "s1", "sceneLoad");
  await flushMicrotasks();
  expect(h.hostStore.seq).toBe(beforeSpoof);
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");

  // A player joining loads the active scene: the published graph hears it under that player,
  // the private one stays silent for them, and the player's replica keeps no messages.
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const playerRejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => playerRejected.push(event));
  expect(messages()).toEqual(["sceneLoad by " + PLAYER_ID]);
  expect(recent("arrival-plate")).toEqual([{ method: "sceneLoad", userId: PLAYER_ID }]);
  expect(recent("private-arrival")).toBeUndefined();
  expect(player.store.getAll("messages")).toEqual([]);
  expect(player.store.getAll("automations")).toEqual([]);

  // A second player loads the same scene under their own identity, and the unpublished graph
  // stays silent for players through every load.
  await h.addPlayer(OTHER_ID, "Ivy");
  expect(messages().slice(-1)).toEqual(["sceneLoad by " + OTHER_ID]);
  expect(recent("private-arrival")).toBeUndefined();

  // Reconnecting the same viewer to the same scene is not a new load. A viewer who was away
  // while the table moved does load the new active scene on return; one who was present for the
  // activation already follows it, so their reconnect is not a load.
  const before = messages().length;
  await h.addPlayer(PLAYER_ID, "Rex");
  expect(messages().length).toBe(before);
  const second: SceneDocument = { ...sceneDoc("scene-two"), active: false };
  h.gm.submit([{ kind: "create", coll: "scenes", data: second }]);
  await flushMicrotasks();
  const secondTile: TileDocument = { ...zoneTile(), _id: "zone-two", name: "Second plate" };
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: second._id }, data: secondTile }]);
  await flushMicrotasks();
  const secondGraph: AutomationDocument = { ...zoneDoc(), _id: "second-arrival", name: "Second arrival",
    definition: { ...zoneDoc().definition, sceneId: second._id, tileId: "zone-two",
      methods: ["sceneLoad"], gates: { playerRunnable: true },
      steps: [{ id: "notice", kind: "chat", audience: "gm", content: "{{method}} by {{user}}" }] } };
  h.gm.submit([{ kind: "create", coll: "automations", data: secondGraph }]);
  await flushMicrotasks();
  h.host.removeSession("peer-" + PLAYER_ID); // Rex leaves before the move
  const beforeSwitch = messages().length;
  h.gm.submit([{ kind: "update", ref: { coll: "scenes", id: "s1" }, diff: { active: false } },
    { kind: "update", ref: { coll: "scenes", id: second._id }, diff: { active: true } }]);
  await flushMicrotasks();
  expect(messages().length).toBe(beforeSwitch); // activation is sceneChange, not a load
  await h.addPlayer(PLAYER_ID, "Rex");
  expect(messages().slice(beforeSwitch)).toEqual(["sceneLoad by " + PLAYER_ID]);
  // The graph belongs to the new scene and heard it; the old scene's graph did not.
  expect(recent("second-arrival")).toEqual([{ method: "sceneLoad", userId: PLAYER_ID }]);
  expect(recent("arrival-plate")).toHaveLength(2); // Rex's first load, then Ivy's
  // Ivy stayed connected through the activation, so her session already holds the new scene.
  const beforeIvy = messages().length;
  await h.addPlayer(OTHER_ID, "Ivy");
  expect(messages().length).toBe(beforeIvy);

  // A world with no active scene has nothing to load.
  const beforeNone = messages().length;
  h.gm.submit([{ kind: "update", ref: { coll: "scenes", id: second._id }, diff: { active: false } }]);
  await flushMicrotasks();
  await h.addPlayer(OTHER_ID, "Ivy");
  expect(messages().length).toBe(beforeNone);
});

test("a GM loopback session loads the active scene on connect", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() }]);
  await flushMicrotasks();
  const graph: AutomationDocument = { ...zoneDoc(), _id: "gm-arrival", name: "GM arrival",
    definition: { ...zoneDoc().definition, tileId: "zone", methods: ["sceneLoad"], gates: {},
      steps: [{ id: "notice", kind: "chat", audience: "gm", content: "{{method}} by {{user}}" }] } };
  h.gm.submit([{ kind: "create", coll: "automations", data: graph }]);
  await flushMicrotasks();
  // The GM's own loopback session (addSession with a user) is a load too.
  const pair = createTransportPair();
  h.host.addSession("gm-two", pair.a, { id: OTHER_ID, role: "ASSISTANT", name: "Ivy" });
  await flushMicrotasks();
  expect(h.hostStore.getAll("messages").map((message) => message.content))
    .toEqual(["sceneLoad by " + OTHER_ID]);
});

// ─── TR-12/MC-01 (D-381): a saved macro runs a graph by reference ─────────────────

const automationMacro = (graphId: string, over: Partial<MacroDocument> = {}): MacroDocument => ({
  _id: "auto-macro", type: "macro", name: "Courtyard alert", ownership: { default: 1 },
  flags: {}, system: {}, kind: "automation", command: "", automation: { graphId }, ...over,
});

/** A graph whose only action posts a GM-audience line naming the invocation context. */
const macroGraph = (over: Partial<AutomationDocument> = {}): AutomationDocument => ({
  ...zoneDoc(), _id: "macro-graph", name: "Courtyard alert",
  definition: { ...zoneDoc().definition, tileId: "zone", methods: ["manual"], gates: { playerRunnable: true },
    steps: [{ id: "notice", kind: "chat", audience: "gm", content: "{{method}} by {{user}}" }] },
  ...over,
});

const visibleZoneTile = (): TileDocument => ({ ...zoneTile(), ownership: { default: 2 } });

test("a published automation macro runs its saved graph, under the invoker's identity, without leaking the graph", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: visibleZoneTile() }]);
  await flushMicrotasks();
  // A macro is a reference: the graph must already be committed when the macro is authored.
  h.gm.submit([{ kind: "create", coll: "automations", data: macroGraph() }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "macros", data: automationMacro("macro-graph") }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);
  const recent = () => h.hostStore.get("automations", "macro-graph")?.state?.recent
    ?.map((entry) => ({ method: entry.method, userId: entry.userId }));

  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  // The macro travels as a callable entry; the graph id, the graph name and the
  // automations collection do not.
  const delivered = player.store.get("macros", "auto-macro");
  expect(delivered?.name).toBe("Courtyard alert");
  expect(delivered?.kind).toBe("automation");
  // No declared inputs: the delivered entry carries no binding at all.
  expect(delivered?.automation).toBeUndefined();
  expect(player.store.getAll("automations")).toEqual([]);

  const playerResults: ClientEvents["macroResult"][] = [];
  playerBus.on("macroResult", (event) => playerResults.push(event));
  player.invokeMacro("auto-macro");
  await flushMicrotasks();
  expect(messages()).toEqual(["manual by " + PLAYER_ID]);
  expect(recent()).toEqual([{ method: "manual", userId: PLAYER_ID }]);
  expect(playerResults.at(-1)).toMatchObject({ ok: true, macroId: "auto-macro", callerId: PLAYER_ID });
  // Success and refusal read the same to a player: no graph name, no id, no reason.
  expect(playerResults.at(-1)?.detail).toBe("Automation fired");
  expect(player.store.getAll("messages")).toEqual([]);

  const gmResults: ClientEvents["macroResult"][] = [];
  h.gmBus.on("macroResult", (event) => gmResults.push(event));
  h.gm.invokeMacro("auto-macro");
  await flushMicrotasks();
  expect(messages()).toEqual(["manual by " + PLAYER_ID, "manual by " + GM_ID]);
  expect(gmResults.at(-1)?.detail).toBe("Fired Courtyard alert");

  // Undo belongs to the graph's own envelope: the macro adds no second transaction.
  expect(h.host.undo().ok).toBe(true);
  expect(messages()).toEqual(["manual by " + PLAYER_ID]);
});

test("an automation macro grants no authority: refusals follow the graph's live publication", async () => {
  const h = await setup();
  h.gm.submit([
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: visibleZoneTile() },
    { kind: "create", coll: "regions", parent: { coll: "scenes", id: "s1" },
      data: { _id: "courtyard", type: "region", name: "Courtyard", ownership: { default: 2 }, flags: {}, system: {},
        x: 100, y: 100, width: 200, height: 200,
        shape: { kind: "polygon", points: [[0.5, 0], [1, 1], [0, 1]] } } as RegionDocument },
  ]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "create", coll: "automations", data: macroGraph() },
    { kind: "create", coll: "automations", data: macroGraph({ _id: "private-graph", name: "Private graph",
      definition: { ...macroGraph().definition, gates: {} } }) },
    { kind: "create", coll: "automations", data: macroGraph({ _id: "click-graph", name: "Click graph",
      definition: { ...macroGraph().definition, methods: ["click"] } }) },
    { kind: "create", coll: "automations", data: macroGraph({ _id: "region-graph", name: "Region graph",
      definition: { ...macroGraph().definition, sourceKind: "region", tileId: "courtyard" } }) },
  ]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "create", coll: "macros", data: automationMacro("macro-graph") },
    { kind: "create", coll: "macros", data: automationMacro("private-graph", { _id: "private-macro", name: "Private" }) },
    { kind: "create", coll: "macros", data: automationMacro("region-graph", { _id: "region-macro", name: "Region" }) },
    // A macro the player may not read is never delivered — and never invocable.
    { kind: "create", coll: "macros", data: automationMacro("macro-graph", { _id: "hidden-macro", name: "Hidden", ownership: { default: 0 } }) },
  ]);
  await flushMicrotasks();
  const { client: player, bus: playerBus, pair: playerPair } = await h.addPlayer(PLAYER_ID, "Rex");
  const results: ClientEvents["macroResult"][] = [];
  playerBus.on("macroResult", (event) => results.push(event));
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);
  const fireCount = (id: string) => h.hostStore.get("automations", id)?.state?.count ?? 0;

  for (const macroId of ["private-macro", "region-macro", "hidden-macro", "missing-macro"]) {
    player.invokeMacro(macroId);
    await flushMicrotasks();
  }
  expect(results.map((event) => event.ok)).toEqual([false, false, false, false]);
  expect(results.map((event) => event.detail)).toEqual(Array(4).fill("automation macro unavailable"));
  expect(messages()).toEqual([]);
  expect(fireCount("private-graph")).toBe(0);

  // The authoring gate refuses a macro over a graph that never runs on `manual` …
  const refused: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (event) => refused.push(event));
  expect(h.hostStore.getAll("macros").map((doc) => doc._id).sort())
    .toEqual(["auto-macro", "hidden-macro", "private-macro", "region-macro"]);
  h.gm.submit([{ kind: "create", coll: "macros", data: automationMacro("click-graph", { _id: "click-macro" }) }]);
  await flushMicrotasks();
  expect(refused.at(-1)?.reason).toBe("invalid_schema");
  expect(refused.at(-1)?.detail).toContain("manual");
  expect(h.hostStore.get("macros", "click-macro")).toBeUndefined();

  // … and the run itself re-reads live state: dropping the method refuses, restoring it fires.
  const gmResults: ClientEvents["macroResult"][] = [];
  h.gmBus.on("macroResult", (event) => gmResults.push(event));
  const stored = h.hostStore.get("automations", "private-graph");
  if (!stored) throw new Error("expected the published graph to be committed");
  h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "private-graph" },
    diff: { definition: { ...stored.definition, methods: ["click"] } as unknown as Json } }]);
  await flushMicrotasks();
  h.gm.invokeMacro("private-macro");
  await flushMicrotasks();
  expect(gmResults.at(-1)?.ok).toBe(false);
  expect(gmResults.at(-1)?.detail).toContain("manual");
  h.gm.submit([{ kind: "update", ref: { coll: "automations", id: "private-graph" },
    diff: { definition: { ...stored.definition, methods: ["manual"] } as unknown as Json } }]);
  await flushMicrotasks();
  h.gm.invokeMacro("private-macro");
  await flushMicrotasks();
  expect(gmResults.at(-1)?.ok).toBe(true);
  expect(messages()).toEqual(["manual by " + GM_ID]);
  expect(fireCount("private-graph")).toBe(1);

  // A published graph in a scene this player is not looking at cannot be reached
  // through a macro either.
  h.gm.submit([{ kind: "create", coll: "scenes", data: { ...sceneDoc("s2"), active: false } as SceneDocument }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s2" },
    data: { ...visibleZoneTile(), _id: "zone-two" } }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations", data: macroGraph({ _id: "far-graph", name: "Far graph",
    definition: { ...macroGraph().definition, sceneId: "s2", tileId: "zone-two" } }) }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "macros", data: automationMacro("far-graph", { _id: "far-macro", name: "Far away" }) }]);
  await flushMicrotasks();
  player.invokeMacro("far-macro");
  await flushMicrotasks();
  expect(results.at(-1)).toMatchObject({ ok: false, detail: "automation macro unavailable" });
  expect(fireCount("far-graph")).toBe(0);

  // A forged request cannot smuggle a graph id, and a replayed request id is a retransmit.
  const rejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => rejected.push(event));
  const before = messages().length;
  playerPair.b.send("ops", frameMessage({ kind: "macros.invoke", requestId: "spoof-1",
    macroId: "auto-macro", graphId: "macro-graph" } as never));
  await flushMicrotasks();
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");
  expect(messages().length).toBe(before);
  playerPair.b.send("ops", frameMessage({ kind: "macros.invoke", requestId: "spoof-2", macroId: "auto-macro" }));
  await flushMicrotasks();
  const afterOne = messages().length;
  expect(afterOne).toBe(before + 1);
  playerPair.b.send("ops", frameMessage({ kind: "macros.invoke", requestId: "spoof-2", macroId: "auto-macro" }));
  await flushMicrotasks();
  expect(messages().length).toBe(afterOne);
});

test("only a GM may author an automation macro, and only over a real manual graph", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() }]);
  await flushMicrotasks();
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const rejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => rejected.push(event));
  h.gmBus.on("rejected", (event) => rejected.push(event));

  // A player can neither author one nor edit/remove one.
  player.submit([{ kind: "create", coll: "macros", data: automationMacro("macro-graph") }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.reason).toBe("forbidden");
  expect(h.hostStore.get("macros", "auto-macro")).toBeUndefined();

  // The referenced graph must exist, validate, run on `manual` and have a real tile.
  h.gm.submit([{ kind: "create", coll: "macros", data: automationMacro("missing-graph") }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");
  expect(rejected.at(-1)?.detail).toContain("saved graph");
  h.gm.submit([{ kind: "create", coll: "automations", data: macroGraph({ _id: "click-graph",
    definition: { ...macroGraph().definition, methods: ["click"] } }) }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "macros", data: automationMacro("click-graph", { _id: "click-macro" }) }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.detail).toContain("manual");

  // A binding may not ride on another kind, and the kind may not smuggle a command.
  h.gm.submit([{ kind: "create", coll: "macros", data: { ...automationMacro("macro-graph"),
    kind: "chat", command: "hello", _id: "chat-with-binding" } as MacroDocument }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.detail).toContain("automation binding");
  h.gm.submit([{ kind: "create", coll: "macros", data: { ...automationMacro("macro-graph"),
    _id: "chatty", command: "/me waves" } as MacroDocument }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.detail).toContain("chat command");

  // Deleting the graph leaves the macro in place; the next run refuses rather than fires.
  h.gm.submit([{ kind: "create", coll: "automations", data: macroGraph() }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "macros", data: automationMacro("macro-graph") }]);
  await flushMicrotasks();
  const results: ClientEvents["macroResult"][] = [];
  h.gmBus.on("macroResult", (event) => results.push(event));
  h.gm.invokeMacro("auto-macro");
  await flushMicrotasks();
  expect(results.at(-1)?.ok).toBe(true);
  h.gm.submit([{ kind: "delete", ref: { coll: "automations", id: "macro-graph" } }]);
  await flushMicrotasks();
  h.gm.invokeMacro("auto-macro");
  await flushMicrotasks();
  expect(results.at(-1)?.ok).toBe(false);
  expect(results.at(-1)?.detail).toBe("macro unavailable");
});
// ─── TR-12 (D-382): redirects — regions and door triggers fire a NAMED graph ──────

/** A tile the sweep never touches, so a child anchored here runs only by redirect. */
const farPlate = (): TileDocument => ({ ...zoneTile(), _id: "far-plate", name: "Far plate",
  x: 0, y: 400, width: 200, height: 200 });

/** Author a named graph from `zoneDoc()`'s shell, overriding only what the case needs. */
const auto = (id: string, over: Partial<AutomationDefinition>): AutomationDocument =>
  ({ ...zoneDoc(), _id: id, name: id, definition: { ...zoneDoc().definition, ...over } });

test("a region fires a named tile graph, which keeps the real method and the region as its origin", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: farPlate() },
    { kind: "create", coll: "regions", parent: { coll: "scenes", id: "s1" },
      data: { _id: "crossing", type: "region", name: "Crossing", ownership: { default: 0 }, flags: {}, system: {},
        x: 300, y: 100, width: 200, height: 200,
        shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] } } as RegionDocument }]);
  await flushMicrotasks();
  // The child is anchored on a plate the token never visits: the region reaches it by
  // name, and nothing here recreates the child's graph.
  h.gm.submit([{ kind: "create", coll: "automations", data: auto("tile-child", { tileId: "far-plate",
    methods: ["enter"], gates: {}, steps: [
      { id: "notice", kind: "chat", audience: "gm",
        content: "child {{method}} <- {{originMethod}}@{{originSource}} on {{originTile}}" }] }) }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations", data: auto("region-parent", { sourceKind: "region",
    tileId: "crossing", methods: ["enter"], gates: {}, steps: [
      { id: "own", kind: "chat", audience: "gm", content: "parent {{method}}" },
      { id: "go", kind: "redirect", automationId: "tile-child", method: "inherit", tokens: "triggering" }] }) }]);
  await flushMicrotasks();
  expect(h.hostStore.get("automations", "region-parent")?.definition.sourceKind).toBe("region");

  // The runner walks into the region; its path never touches far-plate.
  h.gm.submit([{ kind: "update", ref: tokenRef, diff: { x: 400, y: 200 } }]);
  await flushMicrotasks();
  expect(h.hostStore.getAll("messages").map((message) => message.content))
    .toEqual(["parent enter", "child enter <- enter@region on crossing"]);
  const child = h.hostStore.get("automations", "tile-child");
  expect(child?.state?.recent?.map((entry) => entry.method)).toEqual(["enter"]);
  expect(child?.state?.byToken?.["t-pl"]?.count).toBe(1);
  // The region graph and its child share one undo step, and undo removes both.
  expect(h.host.undo().ok).toBe(true);
  await flushMicrotasks();
  expect(h.hostStore.get("automations", "tile-child")?.state?.count ?? 0).toBe(0);
});

test("a door change fires a named automation that has no anchor over the door", async () => {
  const h = await setup();
  // `zone` carries the door; `far-plate` is where the named target lives, untouched.
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: zoneTile() },
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: farPlate() }]);
  await flushMicrotasks();
  const door: WallDocument = { _id: "gate", type: "wall", name: "Gate", ownership: { default: 0 },
    flags: {}, system: {}, taggerTags: ["door-1"], c: [150, 250, 250, 250],
    move: 1, sight: 1, sound: 1, light: 1, door: 0, oneWay: false };
  h.gm.submit([{ kind: "create", coll: "walls", parent: { coll: "scenes", id: "s1" }, data: door }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations", data: auto("door-child", { tileId: "far-plate",
    methods: ["doorOpen"], gates: {}, steps: [
      { id: "notice", kind: "chat", audience: "gm", content: "door child {{method}}/{{originMethod}}@{{originSource}}" }] }) }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations", data: auto("door-parent", { tileId: "zone",
    methods: ["doorOpen"], gates: {}, steps: [
      { id: "go", kind: "redirect", automationId: "door-child", tokens: "triggering", method: "inherit" }] }) }]);
  await flushMicrotasks();

  h.gm.submit([{ kind: "update", ref: { coll: "walls", id: "gate", parent: { coll: "scenes", id: "s1" } },
    diff: { door: 1 } }]);
  await flushMicrotasks();
  expect(h.hostStore.getAll("messages").map((message) => message.content))
    .toEqual(["door child doorOpen/doorOpen@tile"]);
  expect(h.hostStore.get("automations", "door-child")?.state?.recent?.map((entry) => entry.method))
    .toEqual(["doorOpen"]);
  // A second open (no committed change) fires nothing through the chain.
  h.gm.submit([{ kind: "update", ref: { coll: "walls", id: "gate", parent: { coll: "scenes", id: "s1" } },
    diff: { door: 1 } }]);
  await flushMicrotasks();
  expect(h.hostStore.getAll("messages")).toHaveLength(1);
});

test("a redirect is gated at authoring time and never widens a player's reach", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: farPlate() }]);
  await flushMicrotasks();
  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (event) => rejected.push(event));
  const redirectStep = (automationId: string,
    over: Partial<Omit<Extract<AutomationDefinition["steps"][number], { kind: "redirect" }>, "id" | "kind" | "automationId">> = {})
    : AutomationDefinition["steps"][number] => ({ id: "go", kind: "redirect", automationId, ...over });
  const withRedirect = (id: string, step: AutomationDefinition["steps"][number]): AutomationDocument =>
    auto(id, { tileId: "far-plate", methods: ["enter", "click", "manual"], gates: { playerRunnable: true },
      steps: [step] });

  // A redirect to nothing, to itself, to another scene, or to a manual step over a
  // non-manual graph is refused before it is ever saved.
  h.gm.submit([{ kind: "create", coll: "automations", data: withRedirect("bad-missing", redirectStep("nope")) }]);
  await flushMicrotasks();
  expect(rejected.at(-1)).toMatchObject({ reason: "invalid_schema" });
  expect(rejected.at(-1)?.detail).toContain("not a saved graph");
  h.gm.submit([{ kind: "create", coll: "automations",
    data: withRedirect("bad-self", redirectStep("bad-self")) }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.detail).toContain("cannot target its own graph");

  h.gm.submit([{ kind: "create", coll: "scenes", data: { ...sceneDoc("s2"), active: false } as SceneDocument }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s2" },
    data: { ...zoneTile(), _id: "zone-two" } }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations", data: auto("far-child", { sceneId: "s2",
    tileId: "zone-two", methods: ["enter"], gates: {}, steps: [
      { id: "notice", kind: "chat", audience: "gm", content: "unreachable" }] }) }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations", data: withRedirect("bad-scene", redirectStep("far-child")) }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.detail).toContain("in this scene only");

  h.gm.submit([{ kind: "create", coll: "automations", data: auto("enter-child", { tileId: "far-plate",
    methods: ["enter"], gates: {}, steps: [
      { id: "notice", kind: "chat", audience: "gm", content: "child {{method}}" }] }) }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations",
    data: withRedirect("bad-manual", redirectStep("enter-child", { method: "manual" })) }]);
  await flushMicrotasks();
  expect(rejected.at(-1)?.detail).toContain("does not accept the manual method");
  expect(h.hostStore.getAll("automations").map((doc) => doc._id)).toEqual(["far-child", "enter-child"]);

  // A player's click reaches a child the player could never invoke directly: the
  // child is not `playerRunnable` and its anchor is outside the player's reach.
  const clickPlate: TileDocument = { ...farPlate(), _id: "click-plate",
    ownership: { default: 0, [PLAYER_ID]: 3 } };
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: clickPlate }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations", data: auto("mobile-child", { tileId: "far-plate",
    methods: ["manual"], gates: {}, steps: [
      { id: "notice", kind: "chat", audience: "gm", content: "child {{method}} for {{user}}" }] }) }]);
  await flushMicrotasks();
  // A redirect only resolves a target that already exists, so the parent lands after its child
  // (a same-submit forward reference is refused — the authoring gate reads the live store).
  h.gm.submit([{ kind: "create", coll: "automations", data: auto("click-parent", { tileId: "click-plate",
    methods: ["click"], gates: { playerRunnable: true }, steps: [
      { id: "go", kind: "redirect", automationId: "mobile-child", method: "manual" }] }) }]);
  await flushMicrotasks();
  expect(rejected).toHaveLength(4);
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const playerRejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => playerRejected.push(event));
  // The child's own anchor is not clickable by a player, so the redirect is the only route.
  player.requestAutomationClick("s1", "far-plate", { x: 100, y: 450 });
  await flushMicrotasks();
  expect(h.hostStore.getAll("messages")).toEqual([]);
  player.requestAutomationClick("s1", "click-plate", { x: 100, y: 450 });
  await flushMicrotasks();
  expect(h.hostStore.getAll("messages").map((message) => message.content))
    .toEqual(["child manual for " + PLAYER_ID]);
  expect(h.hostStore.get("automations", "mobile-child")?.state?.count).toBe(1);
  expect(h.hostStore.get("automations", "click-parent")?.state?.count).toBe(1);
  // The player learns nothing: no GM-only line, no automations collection, no rejection.
  expect(player.store.getAll("messages")).toEqual([]);
  expect(player.store.getAll("automations")).toEqual([]);
  expect(playerRejected).toEqual([]);
});

// ─── TR-12 (D-383): journal handout links fire the graphs on their named anchor ────

/** A readable handout: ownership LIMITED, one page. */
const journalPage = (text: string, over: Partial<JournalDocument> = {}): JournalDocument => ({
  _id: "handout", type: "journal", name: "Handout", ownership: { default: 1 }, flags: {}, system: {},
  pages: [{ _id: "jp-1", type: "page", name: "Front", ownership: { default: 1 }, flags: {}, system: {},
    text, src: null }], ...over,
});

test("a journal link fires the graphs on its named anchor as a manual trigger with journal origin", async () => {
  const h = await setup();
  const rejected: ClientEvents["rejected"][] = [];
  h.gmBus.on("rejected", (event) => rejected.push(event));
  h.gm.submit([
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: { ...zoneTile(), _id: "gate-plate" } },
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: { ...farPlate(), _id: "vault-plate" } },
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: { ...farPlate(), _id: "quiet-plate" } },
  ]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "create", coll: "automations", data: auto("gate-graph", { tileId: "gate-plate",
      methods: ["manual"], gates: {}, steps: [{ id: "notice", kind: "chat", audience: "gm",
        content: "gate {{method}} from {{originSource}} by {{user}}" }] }) },
    { kind: "create", coll: "automations", data: auto("vault-graph", { tileId: "vault-plate",
      methods: ["manual"], gates: {}, steps: [
        { id: "first", kind: "chat", audience: "gm", content: "front door" },
        { id: "land", kind: "landing", name: "vault" },
        { id: "after", kind: "chat", audience: "gm", content: "vault door from {{originSource}}" }] }) },
    { kind: "create", coll: "automations", data: auto("paused-graph", { tileId: "quiet-plate",
      methods: ["manual"], gates: { paused: true }, steps: [
        { id: "notice", kind: "chat", audience: "gm", content: "should never run" }] }) },
  ]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "journals", data: journalPage([
    "Read this aloud, then @Tile[gate-plate]{open the gate}.",
    "",
    "Vault: @Tile[vault-plate landing:vault]{the vault door}.",
    "",
    "Quiet: @Tile[quiet-plate active:true]{the quiet plate}.",
    "",
    "Nothing: @Tile[no-such-anchor]{nothing here}.",
    "",
    "Broken: @Tile[Scene.s1.Tile.]{broken link}.",
  ].join("\n")) }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);

  h.gm.requestJournalTrigger("handout", "jp-1", 0);
  await flushMicrotasks();
  expect(messages()).toEqual(["gate manual from journal by " + GM_ID]);
  expect(h.hostStore.get("automations", "gate-graph")?.state?.recent?.map((entry) => entry.method))
    .toEqual(["manual"]);
  expect(h.hostStore.get("automations", "gate-graph")?.state?.byToken?.[`user:${GM_ID}`]?.count).toBe(1);

  // `landing:` starts the child at that landing: the step before it never runs.
  h.gm.requestJournalTrigger("handout", "jp-1", 1);
  await flushMicrotasks();
  expect(messages().slice(1)).toEqual(["vault door from journal"]);
  expect(h.hostStore.get("automations", "vault-graph")?.state?.count).toBe(1);

  // A paused graph stays paused whatever the link says: silent, like any skipped fire
  // (MATT's `active:true` is parsed for compatibility but cannot widen the host's gate).
  h.gm.requestJournalTrigger("handout", "jp-1", 2);
  await flushMicrotasks();
  expect(messages()).toHaveLength(2);
  expect(h.hostStore.get("automations", "paused-graph")?.state).toBeUndefined();
  expect(rejected).toEqual([]);

  // A link to an anchor that does not exist, and a malformed payload, are refused — the
  // author learns their handout is broken, and the detail names nothing private.
  h.gm.requestJournalTrigger("handout", "jp-1", 3);
  h.gm.requestJournalTrigger("handout", "jp-1", 4);
  await flushMicrotasks();
  expect(messages()).toHaveLength(2);
  expect(rejected.map((event) => event.detail)).toEqual(["journal link unavailable", "journal link unavailable"]);

  // An index the page does not have is refused, never answered with what does exist.
  h.gm.requestJournalTrigger("handout", "jp-1", 9);
  await flushMicrotasks();
  expect(rejected.at(-1)).toMatchObject({ reason: "forbidden", detail: "journal link unavailable" });
  expect(messages()).toHaveLength(2);

  // The fire is an ordinary undoable envelope like any other invocation.
  expect(h.host.undo().ok).toBe(true);
  await flushMicrotasks();
  expect(h.hostStore.get("automations", "vault-graph")?.state).toBeUndefined();
  expect(h.hostStore.get("automations", "gate-graph")?.state?.count).toBe(1);
});

test("a player fires a handout link without ever receiving the anchor, and only the links they can see", async () => {
  const h = await setup();
  h.gm.submit([
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" },
      data: { ...zoneTile(), _id: "secret-plate", hidden: true, ownership: { default: 0 } } },
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" },
      data: { ...farPlate(), _id: "public-plate", ownership: { default: 0 } } },
  ]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "create", coll: "automations", data: auto("secret-graph", { tileId: "secret-plate",
      methods: ["manual"], gates: {}, steps: [{ id: "notice", kind: "chat", audience: "gm",
        content: "secret door by {{user}} from {{originSource}}" }] }) },
    { kind: "create", coll: "automations", data: auto("public-graph", { tileId: "public-plate",
      methods: ["manual"], gates: {}, steps: [{ id: "notice", kind: "chat", audience: "gm",
        content: "public plate by {{user}}" }] }) },
  ]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "journals", data: journalPage(
    "Handout: @Tile[public-plate]{press the plate} and <secret>@Tile[secret-plate]{open the vault}</secret>.") }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);

  const { client: player, bus: playerBus, pair } = await h.addPlayer(PLAYER_ID, "Rex");
  const rejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => rejected.push(event));
  // The replica holds the page without any anchor id, without the secret, and without the tile.
  const delivered = (player.store.get("journals", "handout") as JournalDocument | undefined)?.pages[0]?.text;
  expect(delivered).toContain("@Tile[masked]{press the plate}");
  expect(delivered).not.toContain("public-plate");
  expect(delivered).not.toContain("secret-plate");
  expect(delivered).not.toContain("vault");
  expect((player.store.get("scenes", "s1") as SceneDocument | undefined)?.tiles.map((item) => item._id))
    .not.toContain("secret-plate");

  // The player's link #0 is the only link they can see, and it fires the graph the GM routed.
  // Neither tile is visible to them and neither graph is `playerRunnable`: the page is the
  // publication surface, and the host still resolves everything itself.
  player.requestJournalTrigger("handout", "jp-1", 0);
  await flushMicrotasks();
  expect(messages()).toEqual(["public plate by " + PLAYER_ID]);

  // The link inside the secret block is not part of that viewer's list: index 1 refuses and
  // the secret graph never fires.
  player.requestJournalTrigger("handout", "jp-1", 1);
  await flushMicrotasks();
  expect(messages()).toHaveLength(1);
  expect(rejected.map((event) => event.reason)).toEqual(["forbidden"]);
  expect(h.hostStore.get("automations", "secret-graph")?.state).toBeUndefined();

  // Nothing about the private side leaks back: no automations, no messages in the replica.
  expect(player.store.getAll("automations")).toEqual([]);
  expect(player.store.getAll("messages")).toEqual([]);

  // A forged field is a schema refusal, and a replayed request id is a retransmit.
  pair.b.send("ops", frameMessage({ kind: "journal.trigger", requestId: "spoof-1", journalId: "handout",
    pageId: "jp-1", index: 0, tileId: "public-plate" } as never));
  await flushMicrotasks();
  expect(rejected.at(-1)?.reason).toBe("invalid_schema");
  expect(messages()).toHaveLength(1);
  pair.b.send("ops", frameMessage({ kind: "journal.trigger", requestId: "spoof-2", journalId: "handout",
    pageId: "jp-1", index: 0 }));
  await flushMicrotasks();
  expect(messages()).toHaveLength(2);
  pair.b.send("ops", frameMessage({ kind: "journal.trigger", requestId: "spoof-2", journalId: "handout",
    pageId: "jp-1", index: 0 }));
  await flushMicrotasks();
  expect(messages()).toHaveLength(2);
});

test("a handout link cannot reach a scene the viewer is not in, and an unshared page is not a surface", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "scenes", data: { ...sceneDoc("s2"), active: false } as SceneDocument },
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: { ...zoneTile(), _id: "own-plate" } }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s2" },
    data: { ...farPlate(), _id: "far-plate-two" } }]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "create", coll: "automations", data: auto("far-graph", { sceneId: "s2", tileId: "far-plate-two",
      methods: ["manual"], gates: {}, steps: [{ id: "notice", kind: "chat", audience: "gm",
        content: "far scene by {{user}}" }] }) },
    { kind: "create", coll: "automations", data: auto("own-graph", { tileId: "own-plate",
      methods: ["manual"], gates: {}, steps: [{ id: "notice", kind: "chat", audience: "gm",
        content: "own scene by {{user}}" }] }) },
  ]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "journals", data: journalPage([
    "Local: @Tile[own-plate]{open locally}.",
    "",
    "Far: @Tile[Scene.s2.Tile.far-plate-two]{open in the other scene}.",
    "",
    "Private: @Tile[own-plate]{gm only}.",
  ].join("\n")) }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "journals", data: journalPage("GM notes: @Tile[own-plate]{secret handshake}.",
    { _id: "gm-notes", name: "GM notes", ownership: { default: 0 } }) }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);

  // The GM may address the other scene from a handout (authoring reach)…
  h.gm.requestJournalTrigger("handout", "jp-1", 1);
  await flushMicrotasks();
  expect(messages()).toEqual(["far scene by " + GM_ID]);

  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const rejected: ClientEvents["rejected"][] = [];
  playerBus.on("rejected", (event) => rejected.push(event));
  const before = messages().length;
  // …a player may not, and a journal they cannot read is never a surface, whatever the index.
  player.requestJournalTrigger("handout", "jp-1", 1);
  await flushMicrotasks();
  expect(rejected.at(-1)).toMatchObject({ reason: "forbidden", detail: "journal link unavailable" });
  player.requestJournalTrigger("gm-notes", "jp-1", 0);
  await flushMicrotasks();
  expect(rejected.at(-1)).toMatchObject({ reason: "forbidden", detail: "journal link unavailable" });
  expect(messages()).toHaveLength(before);
  expect(h.hostStore.get("automations", "own-graph")?.state).toBeUndefined();

  // The scene they are in still works, under their own identity.
  player.requestJournalTrigger("handout", "jp-1", 0);
  await flushMicrotasks();
  expect(messages().at(-1)).toBe("own scene by " + PLAYER_ID);
  expect(player.store.getAll("automations")).toEqual([]);
});

// ─── MC-01 (D-386): a composite macro runs several saved macros, in order ──────────

const compositeMacro = (macroIds: string[], over: Partial<MacroDocument> = {}): MacroDocument => ({
  _id: "combo-macro", type: "macro", name: "Opening script", ownership: { default: 1 },
  flags: {}, system: {}, kind: "composite", command: "", composite: { macroIds }, ...over,
});

test("a composite runs its children in order, under the invoker's identity, without leaking them", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: visibleZoneTile() }]);
  await flushMicrotasks();
  // Two published graphs on the same visible tile, plus their macros.
  h.gm.submit([
    { kind: "create", coll: "automations", data: macroGraph() },
    { kind: "create", coll: "automations", data: macroGraph({ _id: "second-graph", name: "Second bell",
      definition: { ...macroGraph().definition, steps: [{ id: "notice", kind: "chat", audience: "gm",
        content: "second {{method}} by {{user}}" }] } }) },
  ]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "create", coll: "macros", data: automationMacro("macro-graph") },
    { kind: "create", coll: "macros", data: automationMacro("second-graph", { _id: "second-macro", name: "Second bell" }) },
  ]);
  await flushMicrotasks();
  // A composite may only reference children that are already committed.
  h.gm.submit([{ kind: "create", coll: "macros", data: compositeMacro(["auto-macro", "second-macro"]) }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);

  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const delivered = player.store.get("macros", "combo-macro");
  expect(delivered?.kind).toBe("composite");
  expect(delivered?.composite).toBeUndefined();
  expect(player.store.getAll("automations")).toEqual([]);

  const results: ClientEvents["macroResult"][] = [];
  playerBus.on("macroResult", (event) => results.push(event));
  player.invokeMacro("combo-macro");
  await flushMicrotasks();
  // Both children fired, in the authored order, each as its own graph invocation.
  expect(messages()).toEqual(["manual by " + PLAYER_ID, "second manual by " + PLAYER_ID]);
  expect(h.hostStore.get("automations", "macro-graph")?.state?.recent?.map((e) => e.userId))
    .toEqual([PLAYER_ID]);
  expect(h.hostStore.get("automations", "second-graph")?.state?.recent?.map((e) => e.userId))
    .toEqual([PLAYER_ID]);
  expect(results.at(-1)).toMatchObject({ ok: true, macroId: "combo-macro", callerId: PLAYER_ID });
  // A player never learns which macros ran or what they were called.
  expect(results.at(-1)?.detail).toBe("Automation fired");
  expect(player.store.getAll("messages")).toEqual([]);

  // The GM reads the same run with the composite's own name.
  const gmResults: ClientEvents["macroResult"][] = [];
  h.gmBus.on("macroResult", (event) => gmResults.push(event));
  h.gm.invokeMacro("combo-macro");
  await flushMicrotasks();
  expect(gmResults.at(-1)?.detail).toBe("Fired Opening script (2 macro(s))");
  expect(messages()).toHaveLength(4);

  // Each child keeps its own envelope: two undos remove the two children's writes.
  expect(h.host.undo().ok).toBe(true);
  expect(h.host.undo().ok).toBe(true);
  expect(messages()).toEqual(["manual by " + PLAYER_ID, "second manual by " + PLAYER_ID]);
});

test("a composite pre-flights every child: one unreadable child fires nothing at all", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: visibleZoneTile() }]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "create", coll: "automations", data: macroGraph() },
    { kind: "create", coll: "automations", data: macroGraph({ _id: "private-graph", name: "Private graph",
      definition: { ...macroGraph().definition, gates: {} } }) },
  ]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "create", coll: "macros", data: automationMacro("macro-graph") },
    { kind: "create", coll: "macros", data: automationMacro("private-graph", { _id: "private-macro", name: "Private" }) },
  ]);
  await flushMicrotasks();
  // The player may read both macros, but only run the published one.
  h.gm.submit([{ kind: "create", coll: "macros", data: compositeMacro(["auto-macro", "private-macro"]) }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const results: ClientEvents["macroResult"][] = [];
  playerBus.on("macroResult", (event) => results.push(event));

  player.invokeMacro("combo-macro");
  await flushMicrotasks();
  // Nothing fired — not even the child the player could have run on its own.
  expect(messages()).toEqual([]);
  expect(h.hostStore.get("automations", "macro-graph")?.state).toBeUndefined();
  expect(results.at(-1)).toMatchObject({ ok: false, detail: "automation macro unavailable" });

  // The GM's second child is unpublished for a player, so the same composite is refused…
  expect(h.hostStore.get("automations", "private-graph")?.state?.count ?? 0).toBe(0);
  // …while the GM's own run of it succeeds (the unpublished graph is not a player restriction).
  h.gm.invokeMacro("combo-macro");
  await flushMicrotasks();
  expect(messages()).toEqual(["manual by " + GM_ID, "manual by " + GM_ID]);
});

test("composite authoring is gated: only real, runnable automation macros may be listed", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: visibleZoneTile() }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations", data: macroGraph() }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "macros", data: automationMacro("macro-graph") }]);
  await flushMicrotasks();
  // A chat macro can never be a composite child (its surface owns its own inputs).
  h.gm.submit([{ kind: "create", coll: "macros", data: { _id: "chat-macro", type: "macro", name: "Wave",
    ownership: { default: 1 }, flags: {}, system: {}, kind: "chat", command: "/me waves" } as MacroDocument }]);
  await flushMicrotasks();
  const refused = (data: MacroDocument): void => {
    h.gm.submit([{ kind: "create", coll: "macros", data }]);
  };
  // Each of these is refused, and the refusal leaves no composite behind.
  const attempts: Array<[string, MacroDocument]> = [
    ["a nested composite", compositeMacro(["auto-macro", "combo-macro"])],
    ["a missing child", compositeMacro(["auto-macro", "missing-macro"])],
    ["a duplicate child", compositeMacro(["auto-macro", "auto-macro"])],
    ["a single child", compositeMacro(["auto-macro"])],
    ["a chat child", compositeMacro(["auto-macro", "chat-macro"])],
    ["a self-reference", compositeMacro(["auto-macro", "combo-macro"], { _id: "combo-macro" })],
    ["a command on a composite", compositeMacro(["auto-macro", "chat-macro"], { command: "/say hi" })],
    ["a stray binding on a chat macro", { _id: "stray", type: "macro", name: "Stray", ownership: { default: 1 },
      flags: {}, system: {}, kind: "chat", command: "hi", composite: { macroIds: ["auto-macro", "chat-macro"] } } as MacroDocument],
  ];
  for (const [label, doc] of attempts) {
    refused(doc);
    await flushMicrotasks();
    expect(h.hostStore.get("macros", "combo-macro"), label).toBeUndefined();
  }
  // …and a player may not author one either.
  const { client: player } = await h.addPlayer(PLAYER_ID, "Rex");
  player.submit([{ kind: "create", coll: "macros", data: compositeMacro(["auto-macro", "chat-macro"]) }]);
  await flushMicrotasks();
  expect(h.hostStore.get("macros", "combo-macro")).toBeUndefined();

  // A second runnable child commits, and the valid pair finally does too.
  h.gm.submit([{ kind: "create", coll: "automations", data: macroGraph({ _id: "second-graph", name: "Second bell",
    definition: { ...macroGraph().definition, steps: [{ id: "notice", kind: "chat", audience: "gm",
      content: "second {{method}}" }] } }) }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "macros", data: automationMacro("second-graph",
    { _id: "second-macro", name: "Second bell" }) }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "macros", data: compositeMacro(["auto-macro", "second-macro"]) }]);
  await flushMicrotasks();
  expect(h.hostStore.get("macros", "combo-macro")?.kind).toBe("composite");
  h.gm.invokeMacro("combo-macro");
  await flushMicrotasks();
  expect(h.hostStore.getAll("messages").map((message) => message.content))
    .toEqual(["manual by " + GM_ID, "second manual"]);
});
// ─── MC-02 (D-387): a callable macro's declared, typed invocation arguments ────────

const macroGraphArgs = (over: Partial<AutomationDocument> = {}): AutomationDocument => ({
  ...zoneDoc(), _id: "args-graph", name: "Args bell",
  definition: { ...zoneDoc().definition, tileId: "zone", methods: ["manual"], gates: { playerRunnable: true },
    steps: [{ id: "notice", kind: "chat", audience: "gm",
      content: "rounds={{arg.rounds}} label={{arg.label}}" }] },
  ...over,
});

test("a macro's declared inputs are validated by the host and interpolate as {{arg.<name>}}", async () => {
  const h = await setup();
  h.gm.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: visibleZoneTile() }]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "automations", data: macroGraphArgs() }]);
  await flushMicrotasks();
  // The declared schema is callable metadata: the binding itself stays GM-only.
  h.gm.submit([{ kind: "create", coll: "macros", data: automationMacro("args-graph", {
    automation: { graphId: "args-graph",
      inputs: [{ name: "rounds", type: "number", required: true }, { name: "label", type: "string" }] },
  }) }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);

  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const delivered = player.store.get("macros", "auto-macro");
  // The declared schema is callable metadata and is delivered; the graph id is not.
  expect(delivered?.automation).toEqual({ inputs: [{ name: "rounds", type: "number", required: true },
    { name: "label", type: "string" }] });
  expect(JSON.stringify(delivered?.automation)).not.toContain("args-graph");
  const results: ClientEvents["macroResult"][] = [];
  playerBus.on("macroResult", (event) => results.push(event));

  // A declared argument reaches the graph's interpolation.
  player.invokeMacro("auto-macro", { rounds: 3, label: "open" });
  await flushMicrotasks();
  expect(messages()).toEqual(["rounds=3 label=open"]);
  expect(results.at(-1)).toMatchObject({ ok: true, callerId: PLAYER_ID });
  // An omitted optional input interpolates to the empty string.
  player.invokeMacro("auto-macro", { rounds: 1 });
  await flushMicrotasks();
  expect(messages().at(-1)).toBe("rounds=1 label=");

  const before = messages().length;
  // Undeclared, missing-required and wrongly-typed arguments are refused, and nothing fires.
  for (const args of [{ rounds: 1, extra: "x" }, {}, { rounds: "1" }, { rounds: 1, label: "x".repeat(257) }]) {
    player.invokeMacro("auto-macro", args as Record<string, Json>);
    await flushMicrotasks();
    expect(results.at(-1)).toMatchObject({ ok: false, detail: "automation macro unavailable" });
  }
  expect(messages()).toHaveLength(before);
  // The GM reads the reason; a player never does.
  const gmResults: ClientEvents["macroResult"][] = [];
  h.gmBus.on("macroResult", (event) => gmResults.push(event));
  h.gm.invokeMacro("auto-macro", { rounds: "1" });
  await flushMicrotasks();
  expect(gmResults.at(-1)?.detail).toContain("invalid rounds");
  h.gm.invokeMacro("auto-macro", {});
  await flushMicrotasks();
  expect(gmResults.at(-1)?.detail).toContain("missing rounds");
  expect(messages()).toHaveLength(before);

  // A later inputs edit reaches a live player through the update-diff path as well: the
  // private binding is stripped from the diff, the declared schema is re-attached.
  h.gm.submit([{ kind: "update", ref: { coll: "macros", id: "auto-macro" },
    diff: { automation: { graphId: "args-graph",
      inputs: [{ name: "rounds", type: "number", required: true }] } } }]);
  await flushMicrotasks();
  expect(player.store.get("macros", "auto-macro")?.automation)
    .toEqual({ inputs: [{ name: "rounds", type: "number", required: true }] });
  // The dropped input is no longer declared, so supplying it is refused and nothing fires.
  const afterEdit = messages().length;
  player.invokeMacro("auto-macro", { rounds: 1, label: "open" });
  await flushMicrotasks();
  expect(results.at(-1)).toMatchObject({ ok: false });
  expect(messages()).toHaveLength(afterEdit);
  player.invokeMacro("auto-macro", { rounds: 5 });
  await flushMicrotasks();
  expect(messages().at(-1)).toBe("rounds=5 label=");
});

test("a composite takes no arguments, and a declared token input must be visible to the caller", async () => {
  const h = await setup();
  h.gm.submit([
    { kind: "create", coll: "tiles", parent: { coll: "scenes", id: "s1" }, data: visibleZoneTile() },
    // A concealed token: the GM can name it in an argument, a player may not.
    { kind: "create", coll: "tokens", parent: { coll: "scenes", id: "s1" },
      data: { _id: "hidden-token", type: "token", name: "Shadow", ownership: { default: 0 }, flags: {}, system: {},
        actorId: null, img: "", x: 300, y: 300, width: 100, height: 100, rotation: 0, hidden: true, disposition: 0,
        elevation: 0, light: {}, vision: {} } as unknown as TokenDocument },
  ]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "create", coll: "automations", data: macroGraph({ _id: "macro-graph", name: "Args bell" }) },
    { kind: "create", coll: "automations", data: macroGraphArgs({ _id: "second-graph", name: "Second bell" }) },
  ]);
  await flushMicrotasks();
  h.gm.submit([
    { kind: "create", coll: "macros", data: automationMacro("second-graph", { _id: "token-macro", name: "Token bell",
      automation: { graphId: "second-graph", inputs: [{ name: "target", type: "token", required: true }] } }) },
    { kind: "create", coll: "macros", data: automationMacro("macro-graph") },
  ]);
  await flushMicrotasks();
  h.gm.submit([{ kind: "create", coll: "macros", data: { _id: "combo-macro", type: "macro", name: "Combo",
    ownership: { default: 1 }, flags: {}, system: {}, kind: "composite", command: "",
    composite: { macroIds: ["auto-macro", "token-macro"] } } as MacroDocument }]);
  await flushMicrotasks();
  const messages = () => h.hostStore.getAll("messages").map((message) => message.content);
  const { client: player, bus: playerBus } = await h.addPlayer(PLAYER_ID, "Rex");
  const results: ClientEvents["macroResult"][] = [];
  playerBus.on("macroResult", (event) => results.push(event));

  // A composite declares no schema, so it accepts none.
  player.invokeMacro("combo-macro", { rounds: 1 });
  await flushMicrotasks();
  expect(results.at(-1)).toMatchObject({ ok: false, detail: "automation macro unavailable" });
  expect(messages()).toEqual([]);

  // The player cannot see the concealed token, so it is not a valid argument for them…
  player.invokeMacro("token-macro", { target: "hidden-token" });
  await flushMicrotasks();
  expect(results.at(-1)).toMatchObject({ ok: false, detail: "automation macro unavailable" });
  expect(messages()).toEqual([]);
  // …the GM can.
  h.gm.invokeMacro("token-macro", { target: "hidden-token" });
  await flushMicrotasks();
  expect(messages()).toEqual(["rounds= label="]);
  // An unreadable macro never even answers.
  player.invokeMacro("missing-macro");
  await flushMicrotasks();
  expect(results.at(-1)).toMatchObject({ ok: false, macroId: "missing-macro" });
});
