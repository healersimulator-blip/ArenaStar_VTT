import { describe, expect, test } from "vitest";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import type { HelloMsg } from "../../src/core/messages";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type {
  ActorDocument,
  MessageDocument,
  SceneDocument,
  TokenDocument,
  UserDocument,
} from "../../src/core/documents";

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

function userDoc(id: string, name: string, role: UserDocument["role"] = "PLAYER"): UserDocument {
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
  addPlayer(
    pubkey: string,
    name: string,
    opts?: { autoApprove?: boolean; lastSeq?: number },
  ): Promise<{ client: ClientSync; bus: EventBus<ClientEvents> }>;
}

async function setup(): Promise<Harness> {
  const hostStore = new DocumentStore({ meta });
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
    rng: () => 0.25, // deterministic host rolls: 1d20 → 6, 1d6 → 2
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
    return { client, bus };
  };

  return { host, hostStore, hostLog, hostBus, gm, gmBus, addPlayer };
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
    nova.connect({ kind: "hello", pubkey: "nova-key", displayName: "Nova", ts: 1, sig: "valid" });
    await flushMicrotasks();
    expect(nova.user).toBeNull(); // awaiting approval

    const requests: HostEvents["join:request"][] = [];
    h.hostBus.on("join:request", (req) => requests.push(req));
    // re-hello on the same session (still unauthenticated)
    nova.connect({ kind: "hello", pubkey: "nova-key", displayName: "Nova", ts: 2, sig: "valid" });
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
    const h = await setup();
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

  test("reconnect with lastSeq receives ops-since-seq instead of a snapshot (§5, D-031)", async () => {
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
    expect(snapshots).toBe(0); // caught up via ops-since-2, not a snapshot
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
      { kind: "update", ref: { coll: "actors", id: "a-secret" }, diff: { name: "Still Hidden" } },
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
