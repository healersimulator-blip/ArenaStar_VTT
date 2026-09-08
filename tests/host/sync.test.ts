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
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import type { HelloMsg } from "../../src/core/messages";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type {
  ActorDocument,
  Json,
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
