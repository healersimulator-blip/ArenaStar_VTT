// Checklist: V04 — player ownership and replication for the 2-PCs-vs-3-goblins encounter.
/**
 * V04's second half. `tests/packages/pf1eEncounterFlow.test.ts` proves the
 * encounter's rules; this file proves the same encounter is *multiplayer*:
 * each player controls their own PC and nobody else's, the three goblins are
 * GM-only, and the round state the GM authors reaches every peer — including
 * one who joins after the surprise round has started.
 *
 * The distinction that matters is the one §5 draws between a replica and an
 * echo. A forbidden edit must not merely fail to land; the optimistic echo has
 * to roll back, so the offending player's own screen returns to the truth
 * rather than keeping a move the table never agreed to.
 */
import { describe, expect, test } from "vitest";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import type { HelloMsg } from "../../src/core/messages";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type {
  CombatDocument,
  Json,
  SceneDocument,
  TokenDocument,
  UserDocument,
} from "../../src/core/documents";

const meta: StoreMeta = {
  worldId: "w-enc",
  name: "Goblin ambush",
  system: "pf1e",
  systemVersion: "1.0.0",
};

const GM_ID = "gm-key";
const REX_OWNER = "rex-key";
const IVY_OWNER = "ivy-key";

const REX = "t-rex";
const IVY = "t-ivy";
const GOBLINS = ["t-gob-1", "t-gob-2", "t-gob-3"] as const;

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

function sceneDoc(id: string, tokens: TokenDocument[]): SceneDocument {
  return {
    _id: id,
    type: "scene",
    name: "Ambush site",
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
    tokens,
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
  };
}

function tokenDoc(id: string, owner: string | null, x: number): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: id,
    // default 0 ⇒ GM-only; the goblins have no player owner at all.
    ownership: owner === null ? { default: 0 } : { default: 0, [owner]: 3 },
    flags: {},
    system: {},
    x,
    y: 0,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: owner === null ? "hostile" : "friendly",
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  };
}

/** The surprise round the GM authors mid-encounter, as PF1e round-state flags. */
function combatDoc(round: number, surprised: string[]): CombatDocument {
  return {
    _id: "combat-ambush",
    type: "combat",
    name: "Goblin ambush",
    round,
    turn: 0,
    combatants: [],
    ownership: { default: 2 },
    flags: {
      pf1e: {
        phase: "surprise",
        surprised,
        surpriseOrder: [REX, GOBLINS[0], GOBLINS[1], GOBLINS[2]],
        surpriseTurn: 0,
      },
    } as CombatDocument["flags"],
    system: {},
  };
}

const tokenRef = (id: string) => ({
  coll: "tokens" as const,
  id,
  parent: { coll: "scenes" as const, id: "s1" },
});

interface Harness {
  host: HostSync;
  hostStore: DocumentStore;
  hostBus: EventBus<HostEvents>;
  gm: ClientSync;
  addPlayer: (
    pubkey: string,
    name: string,
  ) => Promise<{ client: ClientSync; bus: EventBus<ClientEvents> }>;
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
    roomId: "room-enc",
    verifyHelloSig: async (hello) => hello.sig === "valid",
    rng: () => 0.25,
  });

  const envelope = (seq: number, ops: Op[], txId: string): OpEnvelope => ({
    seq,
    ts: 0,
    by: GM_ID,
    ops,
    txId,
  });
  const tokens = [
    tokenDoc(REX, REX_OWNER, 0),
    tokenDoc(IVY, IVY_OWNER, 100),
    ...GOBLINS.map((id, i) => tokenDoc(id, null, 400 + i * 100)),
  ];
  const seeds: OpEnvelope[] = [
    envelope(
      1,
      [
        { kind: "create", coll: "users", data: userDoc(GM_ID, "GM", "GM") },
        { kind: "create", coll: "users", data: userDoc(REX_OWNER, "Rex") },
        { kind: "create", coll: "users", data: userDoc(IVY_OWNER, "Ivy") },
        { kind: "create", coll: "scenes", data: sceneDoc("s1", tokens) },
      ],
      "seed-enc",
    ),
  ];
  for (const env of seeds) {
    const applied = hostStore.applyEnvelope(env);
    if (!applied.ok) throw new Error(applied.error);
    const appended = hostLog.append(env, applied.value.inverses);
    if (!appended.ok) throw new Error(appended.error);
    undo.push(env, applied.value.inverses);
  }

  const gmPair = createTransportPair();
  host.addSession("gm", gmPair.a, gmSessionUser(GM_ID));
  const gmBus = createEventBus<ClientEvents>();
  const gm = new ClientSync({ transport: gmPair.b, bus: gmBus, meta });
  await flushMicrotasks();

  const addPlayer = async (pubkey: string, name: string) => {
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
    };
    hostBus.on("join:request", ({ approve }) => approve());
    client.connect(hello);
    await flushMicrotasks();
    return { client, bus };
  };

  return { host, hostStore, hostBus, gm, addPlayer };
}

const xOf = (store: DocumentStore, id: string): number | undefined =>
  ((store.resolve(tokenRef(id)) as TokenDocument | undefined)?.x) ?? undefined;

describe("V04 — ownership and replication across the encounter table", () => {
  test("a player moves their own PC and it reaches every other peer", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const ivy = await h.addPlayer(IVY_OWNER, "Ivy");

    // Rex steps one square east — the 5-foot step from the flow test.
    rex.client.submit([{ kind: "update", ref: tokenRef(REX), diff: { x: 100 } }]);
    // Optimistic on his own screen, not yet in his replica.
    expect(xOf(rex.client.echo, REX)).toBe(100);
    expect(xOf(rex.client.store, REX)).toBe(0);

    await flushMicrotasks();
    for (const [label, store] of [
      ["host", h.hostStore],
      ["gm", h.gm.store],
      ["rex", rex.client.store],
      ["ivy", ivy.client.store],
    ] as const) {
      expect(xOf(store, REX), `${label} did not receive Rex's step`).toBe(100);
    }
    // Ivy's own token did not move with it.
    expect(xOf(ivy.client.store, IVY)).toBe(100);
  });

  test("a forged move on another player's PC is rejected and the echo rolls back", async () => {
    const h = await setup();
    await h.addPlayer(REX_OWNER, "Rex");
    const ivy = await h.addPlayer(IVY_OWNER, "Ivy");
    const rejections: Array<{ txId: string; reason: string }> = [];
    ivy.bus.on("rejected", (r) => rejections.push({ txId: r.txId, reason: r.reason }));

    ivy.client.submit([{ kind: "update", ref: tokenRef(REX), diff: { x: 900 } }]);
    expect(xOf(ivy.client.echo, REX)).toBe(900); // optimistic before the verdict
    await flushMicrotasks();

    expect(rejections.map((r) => r.reason)).toEqual(["forbidden"]);
    // The offending peer's screen returns to the truth — no phantom move.
    expect(xOf(ivy.client.echo, REX)).toBe(0);
    expect(xOf(ivy.client.store, REX)).toBe(0);
    expect(xOf(h.hostStore, REX)).toBe(0);
  });

  test("no player can move a goblin — the monsters are GM-only", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const rejections: string[] = [];
    rex.bus.on("rejected", (r) => rejections.push(r.reason));

    for (const goblin of GOBLINS) {
      rex.client.submit([{ kind: "update", ref: tokenRef(goblin), diff: { x: 0 } }]);
    }
    await flushMicrotasks();

    expect(rejections).toEqual(["forbidden", "forbidden", "forbidden"]);
    expect(h.hostStore.seq).toBe(1); // nothing was applied at all

    // The GM moves the same three freely.
    h.gm.submit(GOBLINS.map((id) => ({ kind: "update" as const, ref: tokenRef(id), diff: { x: 700 } })));
    await flushMicrotasks();
    for (const goblin of GOBLINS) expect(xOf(rex.client.store, goblin)).toBe(700);
  });

  test("the GM's surprise-round state replicates to both players", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const ivy = await h.addPlayer(IVY_OWNER, "Ivy");

    h.gm.submit([{ kind: "create", coll: "combats", data: combatDoc(0, [IVY]) }]);
    await flushMicrotasks();

    for (const [label, store] of [
      ["host", h.hostStore],
      ["rex", rex.client.store],
      ["ivy", ivy.client.store],
    ] as const) {
      const combat = store.get("combats", "combat-ambush") as CombatDocument | undefined;
      expect(combat, `${label} never received the encounter`).toBeDefined();
      const flags = (combat?.flags ?? {}) as { pf1e?: { phase?: string; surprised?: string[] } };
      expect(flags.pf1e?.phase).toBe("surprise");
      // Only Ivy was caught unaware — both players see the same fact.
      expect(flags.pf1e?.surprised).toEqual([IVY]);
    }
  });

  test("a player cannot forge the round state; the GM's version is the table's", async () => {
    const h = await setup();
    await h.addPlayer(REX_OWNER, "Rex");
    const ivy = await h.addPlayer(IVY_OWNER, "Ivy");
    h.gm.submit([{ kind: "create", coll: "combats", data: combatDoc(0, [IVY]) }]);
    await flushMicrotasks();

    const rejections: string[] = [];
    ivy.bus.on("rejected", (r) => rejections.push(r.reason));
    // Ivy tries to write herself out of the surprise round.
    ivy.client.submit([
      {
        kind: "update",
        ref: { coll: "combats" as const, id: "combat-ambush" },
        diff: { flags: { pf1e: { phase: "rounds", surprised: [] } } as Json },
      },
    ]);
    await flushMicrotasks();

    expect(rejections).toEqual(["forbidden"]);
    const combat = ivy.client.store.get("combats", "combat-ambush") as CombatDocument;
    const flags = (combat.flags ?? {}) as { pf1e?: { phase?: string; surprised?: string[] } };
    expect(flags.pf1e?.phase).toBe("surprise");
    expect(flags.pf1e?.surprised).toEqual([IVY]);
  });

  test("a late joiner receives the encounter exactly as the table left it", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    rex.client.submit([{ kind: "update", ref: tokenRef(REX), diff: { x: 300 } }]);
    h.gm.submit([{ kind: "create", coll: "combats", data: combatDoc(2, [IVY]) }]);
    await flushMicrotasks();

    // Ivy connects after the move and the encounter already happened.
    const ivy = await h.addPlayer(IVY_OWNER, "Ivy");
    expect(xOf(ivy.client.store, REX)).toBe(300);
    const combat = ivy.client.store.get("combats", "combat-ambush") as CombatDocument | undefined;
    expect(combat?.round).toBe(2);
    const scene = ivy.client.store.get("scenes", "s1") as SceneDocument;
    // All five tokens — 2 PCs and 3 goblins — came across in the snapshot.
    expect(scene.tokens.map((t) => t._id).sort()).toEqual(
      [REX, IVY, ...GOBLINS].slice().sort(),
    );
  });
});
