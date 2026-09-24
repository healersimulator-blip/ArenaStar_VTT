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
import { describe, expect, test } from "vitest";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import type { ScriptRunner } from "../../src/host/scriptWorker";
import { scriptApprovalHash, type ScriptPolicy } from "../../src/core/scriptMacros";
import { worldSettingsDoc } from "../../src/core/worldSettings";
import type { AutomationDefinition } from "../../src/core/automation";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import { summarizeSkips } from "../../src/core/fxDelivery";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import type { HelloMsg } from "../../src/core/messages";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type {
  ActorDocument,
  AssetManifest,
  AutomationDocument,
  PrefabDocument,
  TileDocument,
  Json,
  MessageDocument,
  NoteDocument,
  SceneDocument,
  TokenDocument,
  WallDocument,
  UserDocument,
  WorldCollections,
  MacroDocument,
} from "../../src/core/documents";
import { frameMessage, channelFor } from "../../src/net/frame";

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

describe("Active-zone host evaluation and graph secrecy", () => {
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

  test("published Game Time click creates an undoable replicated clock and stages later time checks", async () => {
    const h = await setup(); await seedZone(h);
    const definition: AutomationDefinition = { ...zoneDoc().definition, methods: ["click"],
      gates: { playerRunnable: true }, steps: [
        { id: "advance", kind: "gameTime", minutes: 90 },
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
      { id: "advance", kind: "gameTime", minutes: 90 },
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
    await flushMicrotasks();
    expect(rejected.at(-1)?.reason).toBe("forbidden");
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

  test("player-fired Hurt / Heal spends temporary HP; GM Revert atomically restores actor, history and chat", async () => {
    const h = await setup(); await readyTrap(h);
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
