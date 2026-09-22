// MCP connector §3.1 + §8 Phase 3 — **the projection proof**.
//
// Phase 1's reads were the GM's replica and Phase 2's are the agent's own session, which means the
// host's projection is what an agent sees. That is the whole security-relevant claim of this
// feature, and "the host projects envelopes" is not a proof — it is a belief about code written by
// somebody else. So this file does what the player shell's own e2e does: it opens an agent session
// with a `PLAYER` role, then compares the replica it actually holds **field by field** against
// `projectWorld()` for that same user, and asserts the three things a player must never see are
// absent from the documents, not merely hidden by a UI.
import { describe, expect, test } from "vitest";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { createEventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { projectWorld } from "../../src/core/projection";
import { TOP_LEVEL_COLLECTIONS } from "../../src/core/documents";
import { buildChatMessage, parseChatCommand } from "../../src/core/chat";
import type {
  JournalDocument,
  MessageDocument,
  SceneDocument,
  TokenDocument,
  UserDocument,
} from "../../src/core/documents";
import type { Op } from "../../src/core/ops";
import { openAgentSession } from "../../src/app/agentSession";
import type { AgentGrant } from "../../src/core/agents/capabilities";
import { refusalFor } from "../../src/core/agents/capabilities";
import type { ToolContext } from "../../src/core/agents/types";
import type { AgentSession } from "../../src/app/agentSession";
import { createCellOps, enableHexcrawlOps } from "../../src/core/hexcrawl/scene";
import { readWorldClock } from "../../src/packages/pf1e/worldClock";
import {
  advanceWorldClockOps,
  pf1eClockSweepOps,
} from "../../src/packages/pf1e/worldClock";
import { buildEffectDoc } from "../../src/packages/pf1e/effectOps";
import type {
  ActorDocument,
  CellDocument,
  CombatDocument,
  EffectDocument,
} from "../../src/core/documents";
import { secondsPerRoundOf, worldSettingsFrom } from "../../src/core/worldSettings";
import { readRollApplications } from "../../src/packages/pf1e/rollApply";
import { agentRegistryFrom, agentRecordOf, grantOfRecord } from "../../src/core/agents/grants";
import { agentWorldView } from "../../src/app/agentBridge";
import { callTool } from "../../src/core/agents/tools";

const meta: StoreMeta = { worldId: "w1", name: "World One", system: "pf1e-core", systemVersion: "1.0.0" };
const GM_ID = "gm";
const PLAYER_ID = "player-1";

const userDoc = (id: string, name: string, role: UserDocument["role"]): UserDocument => ({
  _id: id,
  type: "user",
  name,
  ownership: { default: 0 },
  flags: {},
  system: {},
  role,
  character: null,
  color: "#88c0d0",
});

/** A 1000×1000 square scene: four tokens, one of them hidden. */
function sceneDoc(): SceneDocument {
  const token = (id: string, name: string, hidden: boolean): TokenDocument =>
    ({
      _id: id,
      type: "token",
      name,
      ownership: { default: 2 },
      flags: {},
      system: {},
      x: 150,
      y: 150,
      rotation: 0,
      width: 100,
      height: 100,
      img: null,
      hidden,
      disposition: "friendly",
      vision: false,
      light: { radius: 0, color: "#ffffff", intensity: 0.5 },
    }) as unknown as TokenDocument;
  return {
    _id: "s1",
    type: "scene",
    name: "Goblinwood",
    ownership: { default: 2 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 1000,
    height: 1000,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    darkness: 0,
    tokens: [
      token("t-party", "Vex", false),
      token("t-goblin", "Goblin", false),
      token("t-ambush", "Ambush", true), // the one a player must never see
    ],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
  } as unknown as SceneDocument;
}

function journalDoc(): JournalDocument {
  return {
    _id: "j1",
    type: "journal",
    name: "The Barrow",
    ownership: { default: 1 },
    flags: {},
    system: {},
    pages: [
      {
        _id: "p1",
        type: "page",
        name: "Page 1",
        ownership: { default: 1 },
        flags: {},
        system: {},
        text: "The door is locked. <secret>The key is under the third step.</secret>",
        src: null,
      },
    ],
  } as unknown as JournalDocument;
}

interface Booted {
  host: HostSync;
  store: DocumentStore;
  log: OpLog;
  gm: ClientSync;
}

async function bootWorld(): Promise<Booted> {
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  const undo = new UndoStack();
  const host = new HostSync({
    store,
    log,
    undo,
    bus: createEventBus<HostEvents>(),
    systemUserId: GM_ID,
    roomId: "room-projection",
    verifyHelloSig: async (hello) => hello.sig === "valid",
  });

  const whisper = buildChatMessage({
    author: GM_ID,
    parsed: parseChatCommand("/whisper Vex the door is trapped"),
    resolveUser: () => PLAYER_ID, // whispered to a human player, not to the agent
    rng: () => 0.5,
  });
  const gmRoll = buildChatMessage({
    author: GM_ID,
    parsed: parseChatCommand("/gmroll 1d20+5"),
    rng: () => 0.5,
  });
  const said = buildChatMessage({
    author: GM_ID,
    parsed: parseChatCommand("the door opens"),
    rng: () => 0.5,
  });

  const ops: Op[] = [
    { kind: "create", coll: "users", data: userDoc(GM_ID, "GM", "GM") },
    { kind: "create", coll: "users", data: userDoc(PLAYER_ID, "Vex", "PLAYER") },
    { kind: "create", coll: "scenes", data: sceneDoc() },
    { kind: "create", coll: "journals", data: journalDoc() },
    { kind: "create", coll: "messages", data: said.message },
    { kind: "create", coll: "messages", data: gmRoll.message },
    { kind: "create", coll: "messages", data: whisper.message },
  ];
  const applied = store.applyEnvelope({ seq: 1, ts: 0, by: GM_ID, ops, txId: "seed" });
  if (!applied.ok) throw new Error(applied.error);
  const appended = log.append({ seq: 1, ts: 0, by: GM_ID, ops, txId: "seed" }, applied.value.inverses);
  if (!appended.ok) throw new Error(appended.error);

  const pair = createTransportPair();
  host.addSession("gm", pair.a, gmSessionUser(GM_ID));
  const gm = new ClientSync({ transport: pair.b, bus: createEventBus<ClientEvents>(), meta });
  await flushMicrotasks();
  await flushMicrotasks();
  return { host, store, log, gm };
}

/** Open an agent session and let it catch up. */
async function openAgent(
  boot: Booted,
  preset: "player" | "gm",
  name = "Scribe",
) {
  const opened = openAgentSession({
    host: boot.host,
    meta,
    settings: boot.store.getAll("settings"),
    users: boot.store.getAll("users"),
    name,
    preset,
    client: "vitest",
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error(opened.error);
  await flushMicrotasks();
  await flushMicrotasks();
  const record = agentRecordOf(agentRegistryFrom(boot.store.getAll("settings")), opened.session.id);
  return { session: opened.session, grant: grantOfRecord(record), record };
}

/** A pack small enough to read at a glance, in the shape `systems/pf1e-core/packs` writes. */
const BESTIARY = {
  name: "bestiary",
  type: "actors",
  entries: [
    {
      id: "goblin",
      name: "Goblin",
      keywords: ["humanoid", "goblinoid"],
      data: {
        type: "actor",
        name: "Goblin",
        system: { pf1e: { size: "Small", bab: 1, ac: 16, hp: 6, hpMax: 6 } },
        items: [],
        effects: [],
      },
    },
  ],
};

/** A tool context over the real session: its own replica, the compendia above, and its writer. */
/** Bestiary 1's `Goblin Warrior`, as printed — the stat block the importer is tested against. */
const GOBLIN_STATBLOCK = `Goblin Warrior CR 1/3
XP 135
Goblin warrior 1
NE Small humanoid (goblinoid)
Init +6; Senses darkvision 60 ft.; Perception -1

DEFENSE

AC 16, touch 13, flat-footed 14 (+2 armor, +2 Dex, +1 shield, +1 size)
hp 6 (1d10+1)
Fort +3, Ref +4, Will -1

OFFENSE

Speed 30 ft.
Melee short sword +2 (1d4/19-20)

STATISTICS

Str 11, Dex 15, Con 12, Int 10, Wis 9, Cha 6
Base Atk +1; CMB +1; CMD 12
Feats Improved Initiative
Skills Ride +6, Stealth +10
Languages Goblin`;

/** A tool context over the real session: its own replica, the compendia above, and its writer. */
const ctxOf = (session: AgentSession, grant: AgentGrant): ToolContext => ({
  view: agentWorldView(session.client, { compendia: async () => [BESTIARY] }),
  grant,
  writer: session.writer,
});

/**
 * A hexcrawl world: three authored cells, one of them still under cover, and a committed route of
 * two steps. Seeded with the app's own builders (`enableHexcrawlOps`, `createCellOps`,
 * `setTravelRouteOps`) so what the test proves is the connector's reading of a real scene, not a
 * scene shaped to fit.
 */
async function bootHexcrawl(): Promise<Booted> {
  const boot = await bootWorld();
  const scene = boot.store.get("scenes", "s1") as unknown as SceneDocument;
  const cell = (key: string, name: string, text: string): Partial<CellDocument> => ({
    key,
    name,
    terrain: key === "1,0" ? "forest" : "plains",
    description: text,
    playerText: `the party can read: ${name}`,
    tables: [],
    features: [],
  });
  const ops = [
    ...enableHexcrawlOps(scene, {
      revealed: ["0,0"],
      partyTokenId: "t-party",
      // The route is set in the same breath: one envelope, one scene to read it back from.
      travel: { path: ["0,0", "1,0"], cursor: 0, progressSeconds: 0, speedPerDay: 24, pace: "normal" },
    }),
    ...createCellOps(scene, "c-1", cell("0,0", "Threshold", "the GM's notes on the threshold")),
    ...createCellOps(scene, "c-2", cell("1,0", "Treeline", "the GM's notes on the treeline")),
    ...createCellOps(scene, "c-3", cell("0,1", "Ford", "the GM's notes on the ford")),
  ];
  boot.gm.submit(ops);
  for (let i = 0; i < 6; i++) await flushMicrotasks();
  expect(boot.store.seq).toBe(2);
  return boot;
}

/**
 * A table in mid-fight: two PF1e actors, one of them carrying an hour-long spell, and an encounter
 * bound to the scene with its initiative already rolled. Seeded with the app's own builders
 * (`buildEffectDoc`) so the sweep the test asserts on is the sweep the Settings window runs.
 */
async function bootCombat(): Promise<Booted> {
  const boot = await bootWorld();
  const effects: EffectDocument[] = [];
  const mageArmor = buildEffectDoc({
    id: "fx-mage-armor",
    name: "Mage Armor",
    payload: {
      mods: [{ key: "ac", type: "armor", value: 4 }],
      // An hour, anchored at the world's zero: three days later it is long gone.
      ttl: { unit: "hour", value: 1 },
      source: { kind: "spell", level: 1 },
    },
    worldClockSeconds: 0,
  });
  if (mageArmor.ok) effects.push(mageArmor.value);
  const actor = (id: string, name: string, withEffects: boolean): ActorDocument =>
    ({
      _id: id,
      type: "actor",
      name,
      ownership: { default: 1 },
      flags: {},
      // `system.pf1e` is what makes it a PF1e actor (`isPF1eActor`), and that is what routes the
      // encounter through PF1e's round structure instead of the generic tracker's.
      system: {
        pf1e: {
          abilities: { str: 10, dex: 10, con: 10 },
          hp: id === "a-vex" ? 30 : 6,
          hpMax: id === "a-vex" ? 30 : 6,
        },
      },
      items: [],
      effects: withEffects ? effects : [],
    }) as unknown as ActorDocument;
  const combat: CombatDocument = {
    _id: "cb-1",
    type: "combat",
    name: "Goblinwood ambush",
    ownership: { default: 1 },
    flags: { core: { sceneId: "s1" } },
    system: {},
    round: 0,
    turn: 0,
    combatants: [
      {
        _id: "c-vex",
        type: "combatant",
        name: "Vex",
        ownership: { default: 1 },
        flags: {},
        system: {},
        tokenId: "t-party",
        actorId: "a-vex",
        initiative: 18,
        hidden: false,
        defeated: false,
      },
      {
        _id: "c-goblin",
        type: "combatant",
        name: "Goblin",
        ownership: { default: 1 },
        flags: {},
        system: {},
        tokenId: "t-goblin",
        actorId: "a-goblin",
        initiative: 12,
        hidden: false,
        defeated: false,
      },
    ],
  } as unknown as CombatDocument;
  boot.gm.submit([
    { kind: "create", coll: "actors", data: actor("a-vex", "Vex", true) },
    { kind: "create", coll: "actors", data: actor("a-goblin", "Goblin", false) },
    { kind: "create", coll: "combats", data: combat },
    {
      kind: "update",
      ref: { coll: "scenes", id: "s1" },
      diff: { "flags.core": { activeCombatId: "cb-1" } },
    },
  ]);
  for (let i = 0; i < 6; i++) await flushMicrotasks();
  return boot;
}

const hexCtxOf = (session: AgentSession, grant: AgentGrant): ToolContext => ({
  view: agentWorldView(session.client),
  grant,
  writer: session.writer,
});

describe("a PLAYER agent's replica is the projection, field by field (§3.1)", () => {
  test("it matches projectWorld() for the same user — nothing more, nothing less", async () => {
    const boot = await bootWorld();
    const { session, grant } = await openAgent(boot, "player");
    expect(grant.role).toBe("PLAYER");

    const agent = { id: session.user._id, role: session.user.role };
    const expected = projectWorld(boot.store.world, boot.store.seq, agent);
    const replica = session.client.store;

    // The seq first: a replica that is behind is not a counterexample, it is a missed flush.
    expect(replica.seq).toBe(boot.store.seq);

    for (const coll of TOP_LEVEL_COLLECTIONS) {
      const theirs = [...replica.getAll(coll)].map((d) => d._id).sort();
      const mine = [...(expected.collections[coll] ?? [])].map((d) => d._id).sort();
      expect(theirs, `collection ${coll}`).toEqual(mine);
      // And not just the ids: every field, so a projection that kept a document but forgot to strip
      // a field inside it fails here rather than in a player's hands.
      for (const doc of replica.getAll(coll)) {
        const truth = (expected.collections[coll] ?? []).find((d) => d._id === doc._id);
        expect(truth, `${coll}/${doc._id} should be in the projection`).toBeDefined();
        expect(JSON.parse(JSON.stringify(doc)), `${coll}/${doc._id}`).toEqual(
          JSON.parse(JSON.stringify(truth)),
        );
      }
    }
  });

  test("the three things a player must never see are absent from the documents", async () => {
    const boot = await bootWorld();
    const { session } = await openAgent(boot, "player");
    const replica = session.client.store;

    // 1. the hidden token — not a flag on a visible row, but no row at all.
    const scene = replica.get("scenes", "s1") as unknown as SceneDocument | undefined;
    expect(scene).toBeDefined();
    const ids = (scene?.tokens ?? []).map((t) => t._id);
    expect(ids).toContain("t-party");
    expect(ids).toContain("t-goblin");
    expect(ids).not.toContain("t-ambush");

    // 2. the whisper it was not in — the card is not in the replica at all.
    const messages = [...replica.getAll("messages")] as unknown as MessageDocument[];
    expect(messages.some((m) => (m.whisper ?? []).length > 0)).toBe(false);
    expect(messages.every((m) => m.content !== "the door is trapped")).toBe(true);

    // 3. the GM-only roll. `projectMessage` redacts a `gmroll` the agent did not roll by nulling
    // `roll` and leaving the card — so the proof is that the card is here and the dice are not,
    // in the document, not in a UI that chose not to render them.
    const rolled = messages.filter((m) => m.rollMode === "gmroll" || m.rollMode === "blindroll");
    expect(rolled.length).toBe(1);
    for (const card of rolled) {
      expect(card.roll).toBeNull();
      expect(JSON.stringify(card)).not.toContain('"total"');
    }
  });

  test("the withheld total is out of the tools' text too — the chip goes with it", async () => {
    // The half `projectMessage` does not cover: a redacted card keeps its content, and the content
    // carries the total a second time as an inline `[[16|1d20+5]]` chip. The player's chat renders
    // that chip; an agent reads the text, so the view drops the total and keeps the formula.
    const boot = await bootWorld();
    const { session, grant } = await openAgent(boot, "player");
    const view = agentWorldView(session.client);
    const answered = await callTool(
      { name: "chat.read", args: { limit: 50 } },
      { view, grant, ...(session.writer ? { writer: session.writer } : {}) },
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    const body = answered.result.content[0]?.text ?? "";
    expect(body).toContain("the door opens"); // the public card is intact
    expect(body).toContain("[rolled 1d20+5]"); // a roll happened, and on what
    expect(body).toContain("[result withheld from this grant]");
    expect(body).not.toContain("16"); // and never what it came to
  });

  test("the same world read by a GM agent matches the unprojected world", async () => {
    const boot = await bootWorld();
    const { session } = await openAgent(boot, "gm", "Vizier");
    const scene = session.client.store.get("scenes", "s1") as unknown as SceneDocument | undefined;
    // The hidden token is there for a GM grant, because the agent's session role says GM.
    expect((scene?.tokens ?? []).map((t) => t._id)).toContain("t-ambush");
    const messages = [...session.client.store.getAll("messages")] as unknown as MessageDocument[];
    expect(messages.some((m) => (m.whisper ?? []).length > 0)).toBe(true);
  });

  test("a secret journal block is stripped, and the visible text survives", async () => {
    const boot = await bootWorld();
    const { session } = await openAgent(boot, "player");
    const journal = session.client.store.get("journals", "j1") as unknown as JournalDocument | undefined;
    const text = journal?.pages?.[0]?.text ?? "";
    expect(text).toContain("The door is locked.");
    expect(text).not.toContain("key is under the third step");
  });

  test("the tools read the projection too — token.list and scene.describe see two tokens, not three", async () => {
    const boot = await bootWorld();
    const { session, grant } = await openAgent(boot, "player");
    const view = agentWorldView(session.client);
    const ctx = { view, grant, ...(session.writer ? { writer: session.writer } : {}) };

    const listed = await callTool({ name: "token.list", args: {} }, ctx);
    expect(listed.kind).toBe("result");
    if (listed.kind !== "result") return;
    const body = listed.result.content[0]?.text ?? "";
    expect(body).toContain("Vex");
    expect(body).toContain("Goblin");
    expect(body).not.toContain("Ambush");
    // 2 of 2: the hidden one is not "withheld" here, it was never in the replica.
    expect(body).toContain("2 tokens");

    const read = await callTool({ name: "scene.read", args: { sceneId: "s1" } }, ctx);
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    expect(read.result.content[0]?.text).toContain("2 tokens");
  });

  test("a write the projection would forbid is refused by the host, not by the replica", async () => {
    // The other half of the same claim: the agent cannot act on what it cannot see. The hidden
    // token is not in its replica, so `token.move` cannot find it — and even if the id were known,
    // the host is the one that refuses (Phase 2's two-layer proof).
    const boot = await bootWorld();
    const { session, grant } = await openAgent(boot, "player");
    const view = agentWorldView(session.client);
    const answered = await callTool(
      { name: "token.move", args: { tokenId: "t-ambush", col: 1, row: 1 } },
      { view, grant, ...(session.writer ? { writer: session.writer } : {}) },
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    expect(answered.result.content[0]?.text).toContain('no token "t-ambush"');
  });
});

describe("an agent's own tokens are the only ones it moves (§8 Phase 3)", () => {
  test("the party's token is not the agent's to move; its own is", async () => {
    const boot = await bootWorld();
    const { session, grant } = await openAgent(boot, "player");
    // The GM hands the agent one token of its own — ownership, not the mask, is what the app has
    // always drawn the line at, so this is the same move a player's client makes.
    boot.gm.submit([
      {
        kind: "update",
        ref: { coll: "tokens", id: "t-party", parent: { coll: "scenes", id: "s1" } },
        diff: { ownership: { default: 0, [session.user._id]: 3 } },
      },
    ]);
    for (let i = 0; i < 4; i++) await flushMicrotasks();
    expect(session.client.store.seq).toBe(boot.store.seq);

    const ctx: ToolContext = {
      view: agentWorldView(session.client),
      grant,
      writer: session.writer,
    };

    const theirs = await callTool(
      { name: "token.move", args: { tokenId: "t-goblin", col: 2, row: 2 } },
      ctx,
    );
    expect(theirs.kind).toBe("result");
    if (theirs.kind !== "result") return;
    expect(theirs.result.isError).toBe(true);
    expect(theirs.result.content[0]?.text).toContain('token "t-goblin" is not yours to move');

    const mine = await callTool(
      { name: "token.move", args: { tokenId: "t-party", col: 2, row: 2 } },
      ctx,
    );
    expect(mine.kind).toBe("result");
    if (mine.kind !== "result") return;
    expect(mine.result.isError).toBeUndefined();
    expect(mine.result.content[0]?.text).toContain("now stands at cell 2,2");
    // And the host let it through because the agent owns the token, not because it asked nicely:
    // the write is a PLAYER's write, validated exactly as a player's would be.
    const moved = (boot.store.get("scenes", "s1") as unknown as SceneDocument | undefined)?.tokens.find(
      (t) => t._id === "t-party",
    );
    expect(moved?.x).toBe(250);
    expect(moved?.y).toBe(250);
  });
});

describe("the library and the paste buffer, through a real host (§5.4)", () => {
  test("bestiary.search → actor.from_compendium → a token on the table, all as the agent", async () => {
    const boot = await bootWorld();
    const { session, grant } = await openAgent(boot, "gm", "Golem");
    const ctx = ctxOf(session, grant);

    const found = await callTool({ name: "bestiary.search", args: { query: "goblin" } }, ctx);
    expect(found.kind).toBe("result");
    if (found.kind !== "result") return;
    expect(found.result.content[0]?.text).toContain("Goblin [goblin]");

    const imported = await callTool(
      { name: "actor.from_compendium", args: { entryId: "goblin", col: 3, row: 2 } },
      ctx,
    );
    expect(imported.kind).toBe("result");
    if (imported.kind !== "result") return;
    expect(imported.result.isError, imported.result.content[0]?.text).toBeUndefined();

    // The world, not the answer, is the proof: an actor with the pack's numbers, and a token on
    // the scene linked to it — the same two documents a GM's two clicks would have made.
    const actor = boot.store
      .getAll("actors")
      .find((row) => row.name === "Goblin");
    expect(actor).toBeDefined();
    const system = (actor?.system ?? {}) as unknown as { pf1e?: { hpMax?: number } };
    expect(system.pf1e?.hpMax).toBe(6);
    const scene = boot.store.get("scenes", "s1") as unknown as SceneDocument | undefined;
    const token = (scene?.tokens ?? []).find((t) => t.actorId === actor?._id);
    expect(token).toBeDefined();
    // Col 3, row 2 on a 100 px grid, centred the way `token.move` centres.
    expect(token?.x).toBe(350);
    expect(token?.y).toBe(250);

    // Both documents arrived in the same envelope, and the envelope is the agent's.
    const envelope = boot.log.at(boot.store.seq);
    expect(envelope?.env.by).toBe(session.user._id);
    expect(envelope?.env.ops).toHaveLength(2);
  });

  test("a pasted stat block becomes a real actor, through the app's own importer", async () => {
    // The D-264/D-267 front door, driven by an agent: the same reader the Import dialog uses,
    // including its refusal to author a sheet that would open blank.
    const boot = await bootWorld();
    const { session, grant } = await openAgent(boot, "gm", "Scribe");
    const answered = await callTool(
      { name: "actor.from_statblock", args: { text: GOBLIN_STATBLOCK, col: 1, row: 1 } },
      ctxOf(session, grant),
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError, answered.result.content[0]?.text).toBeUndefined();
    const body = answered.result.content[0]?.text ?? "";
    expect(body).toContain("from a stat block");
    // The report is part of the answer: what the importer read, in the stat block's own terms.
    expect(body).toContain("Read:");

    const actor = boot.store.getAll("actors").find((row) => row.name === "Goblin Warrior");
    expect(actor).toBeDefined();
    const system = (actor?.system ?? {}) as unknown as { pf1e?: { hpMax?: number; abilities?: { dex?: number } } };
    expect(system.pf1e?.hpMax).toBe(6);
    expect(system.pf1e?.abilities?.dex).toBe(15);
    // Owned by the session that imported it, exactly as the app hands an import to the GM.
    expect(actor?.ownership[session.user._id]).toBe(3);
    const scene = boot.store.get("scenes", "s1") as unknown as SceneDocument | undefined;
    expect((scene?.tokens ?? []).some((t) => t.actorId === actor?._id)).toBe(true);
  });

  test("a stat block the importer cannot play is refused, and nothing is created", async () => {
    const boot = await bootWorld();
    const { session, grant } = await openAgent(boot, "gm", "Scribe");
    const answered = await callTool(
      { name: "actor.from_statblock", args: { text: "a bag of holding and 50 feet of rope" } },
      ctxOf(session, grant),
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    // The importer's own sentence, not a summary of it — it says what to paste next time.
    expect(answered.result.content[0]?.text).toContain("did not read as a character");
    expect(boot.store.getAll("actors")).toHaveLength(0);
  });

  test("a grant without doc.create cannot stock the bestiary, whatever it can read", async () => {
    const boot = await bootWorld();
    const { session, grant } = await openAgent(boot, "player");
    const answered = await callTool(
      { name: "actor.from_compendium", args: { entryId: "goblin" } },
      ctxOf(session, grant),
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    expect(answered.result.content[0]?.text).toBe(refusalFor("doc.create"));
    expect(boot.store.getAll("actors")).toHaveLength(0);
  });
});

describe("the hexcrawl, through a real host and a real projection (§5.6, F1)", () => {
  test("a closed cell is not on a player's replica at all — and the tools say which", async () => {
    const boot = await bootHexcrawl();
    const { session, grant } = await openAgent(boot, "player");
    const ctx = hexCtxOf(session, grant);

    const listed = await callTool({ name: "hexcrawl.cells", args: {} }, ctx);
    expect(listed.kind).toBe("result");
    if (listed.kind !== "result") return;
    const body = listed.result.content[0]?.text ?? "";
    // Two of the three cells are open (0,0 revealed by the GM, 0,1 open as a neighbour of the
    // party's ring is not — only what the profile revealed is open): whichever it is, the closed
    // one is not listed, and that is the whole claim.
    expect(body).not.toContain("1,0");
    expect(body).toContain("0,0");

    const closed = await callTool({ name: "hex.read", args: { key: "1,0" } }, ctx);
    expect(closed.kind).toBe("result");
    if (closed.kind !== "result") return;
    expect(closed.result.isError).toBe(true);
    expect(closed.result.content[0]?.text).toContain("no cell \"1,0\" on this replica");

    const open = await callTool({ name: "hex.read", args: { key: "0,0" } }, ctx);
    expect(open.kind).toBe("result");
    if (open.kind !== "result") return;
    expect(open.result.isError).toBeUndefined();
    const text = open.result.content[0]?.text ?? "";
    expect(text).toContain("Threshold");
    // The GM's own text is not on a player's replica; the table's is.
    expect(text).not.toContain("the GM's notes");
    expect(text).toContain("the party can read");

    const map = await callTool({ name: "hexmap.render", args: {} }, ctx);
    expect(map.kind).toBe("result");
    if (map.kind !== "result") return;
    expect(map.result.content[0]?.text).toContain("▓ unrevealed");
  });

  test("the same world read by a GM agent carries the closed cell and the GM's text", async () => {
    const boot = await bootHexcrawl();
    const { session, grant } = await openAgent(boot, "gm", "Warden");
    const ctx = hexCtxOf(session, grant);

    const listed = await callTool({ name: "hexcrawl.cells", args: {} }, ctx);
    expect(listed.kind).toBe("result");
    if (listed.kind !== "result") return;
    expect(listed.result.content[0]?.text).toContain("1,0");
    expect(listed.result.content[0]?.text).toContain("All 3 cells.");

    const read = await callTool({ name: "hex.read", args: { key: "1,0" } }, ctx);
    expect(read.kind).toBe("result");
    if (read.kind !== "result") return;
    expect(read.result.content[0]?.text).toContain("the GM's notes on the treeline");
  });

  test("a march is one envelope, by the agent, and it moves the clock and the party", async () => {
    const boot = await bootHexcrawl();
    const { session, grant } = await openAgent(boot, "gm", "Guide");
    const ctx = hexCtxOf(session, grant);
    const before = readWorldClock(boot.store.getAll("settings"));

    const marched = await callTool(
      { name: "travel.advance", args: { seconds: 3600 } },
      ctx,
    );
    expect(marched.kind).toBe("result");
    if (marched.kind !== "result") return;
    expect(marched.result.isError, marched.result.content[0]?.text).toBeUndefined();

    // The clock moved by exactly what the march cost, and the party moved with it.
    expect(readWorldClock(boot.store.getAll("settings"))).toBe(before + 3600);
    const envelope = boot.log.at(boot.store.seq);
    expect(envelope?.env.by).toBe(session.user._id);
    expect(envelope?.env.ops.length).toBeGreaterThan(1);
    const scene = boot.store.get("scenes", "s1") as unknown as SceneDocument | undefined;
    const party = (scene?.tokens ?? []).find((token) => token._id === "t-party");
    expect(party?.x).toBeGreaterThan(0);
    expect(marched.result.content[0]?.text).toContain("marched 1 h");
  });

  test("travel.plan and travel.advance need the capability, not just the route", async () => {
    const boot = await bootHexcrawl();
    const { session, grant } = await openAgent(boot, "player");
    const seqBefore = boot.store.seq;
    const answered = await callTool(
      { name: "travel.advance", args: { seconds: 3600 } },
      { view: agentWorldView(session.client), grant, writer: session.writer },
    );
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    expect(answered.result.content[0]?.text).toBe(refusalFor("hexcrawl.travel"));
    // Nothing moved, and no time passed.
    expect(boot.store.seq).toBe(seqBefore);
  });
});

describe("the clock and the turn tracker, through a real host (§5.5)", () => {
  test("a full round is one envelope per call, and the clock advances by exactly one round", async () => {
    const boot = await bootCombat();
    const { session, grant } = await openAgent(boot, "gm", "Warden");
    const ctx = hexCtxOf(session, grant);
    const settings = boot.store.getAll("settings");
    const spr = secondsPerRoundOf(worldSettingsFrom(settings));
    const before = readWorldClock(settings);

    const started = await callTool({ name: "combat.start", args: {} }, ctx);
    expect(started.kind).toBe("result");
    if (started.kind !== "result") return;
    expect(started.result.isError, started.result.content[0]?.text).toBeUndefined();
    expect(started.result.content[0]?.text).toContain("round 1");

    // Two combatants: the second `next` wraps the round, and a round is `secondsPerRound` here.
    const first = await callTool({ name: "combat.next", args: {} }, ctx);
    expect(first.kind).toBe("result");
    if (first.kind !== "result") return;
    expect(first.result.content[0]?.text).not.toContain("advanced the world clock");

    const seqBefore = boot.store.seq;
    const wrapped = await callTool({ name: "combat.next", args: {} }, ctx);
    expect(wrapped.kind).toBe("result");
    if (wrapped.kind !== "result") return;
    expect(wrapped.result.isError, wrapped.result.content[0]?.text).toBeUndefined();
    expect(wrapped.result.content[0]?.text).toContain(`advanced the world clock by ${spr} s`);

    // Exactly one round, not "about a round": the combat update and the clock move are the same
    // envelope, and the clock is the world's own number read back from the host's store.
    expect(readWorldClock(boot.store.getAll("settings"))).toBe(before + spr);
    const envelope = boot.log.at(boot.store.seq);
    expect(envelope?.env.by).toBe(session.user._id);
    expect(boot.store.seq).toBe(seqBefore + 1);

    const state = await callTool({ name: "combat.state", args: {} }, ctx);
    expect(state.kind).toBe("result");
    if (state.kind !== "result") return;
    expect(state.result.content[0]?.text).toContain("round 2 — Vex's turn.");
  });

  test("three days pass in one envelope, and the sweep is the Settings window's own", async () => {
    const boot = await bootCombat();
    const { session, grant } = await openAgent(boot, "gm", "Guide");
    const ctx = hexCtxOf(session, grant);
    // A copy, not the store's own array: `getAll` hands back the live list, and an expectation
    // computed from it after the write would describe the world the write produced.
    const settingsBefore = [...boot.store.getAll("settings")];
    const spr = secondsPerRoundOf(worldSettingsFrom(settingsBefore));
    const before = readWorldClock(settingsBefore);
    const delta = 3 * 86_400;
    // The *pre*-state is the only honest input to the comparison: a sweep computed after the
    // effect is already gone produces no ops at all, and would "prove" the agent did nothing.
    const actorsBefore = [...boot.store.getAll("actors")];
    const combatsBefore = [...boot.store.getAll("combats")];

    const seqBefore = boot.store.seq;
    const answered = await callTool({ name: "time.advance", args: { days: 3 } }, ctx);
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError, answered.result.content[0]?.text).toBeUndefined();
    expect(answered.result.content[0]?.text).toContain("fx-mage-armor");

    expect(readWorldClock(boot.store.getAll("settings"))).toBe(before + delta);
    // The spell is gone from the document, not merely reported gone.
    const vex = boot.store.get("actors", "a-vex") as unknown as ActorDocument | undefined;
    expect(vex?.effects ?? ["not-empty"]).toEqual([]);

    // …and the envelope is byte-for-byte what the Settings window's *day* button submits: the
    // clock op first, then the sweep of both effect homes at the new time.
    const envelope = boot.log.at(boot.store.seq);
    console.log("DBG seq", boot.store.seq, "seqBefore", seqBefore, "envSeq", envelope?.env.seq, "ops", JSON.stringify(envelope?.env.ops).slice(0, 300));
    expect(envelope?.env.by).toBe(session.user._id);
    expect(boot.store.seq).toBe(seqBefore + 1);
    expect(envelope?.env.ops).toEqual([
      ...advanceWorldClockOps(settingsBefore, delta),
      ...(pf1eClockSweepOps(
        actorsBefore as never,
        combatsBefore as never,
        before + delta,
        spr,
      ).ops as unknown as Op[]),
    ]);
  });

  test("time.set is absolute, and a player agent may read the hour but not spend it", async () => {
    const boot = await bootCombat();
    const { session, grant } = await openAgent(boot, "gm", "Keeper");
    const gmCtx = hexCtxOf(session, grant);

    // Forward to a minute past midnight: the hour-long spell is still running, so this proves a
    // short jump is not a sweep of everything it can find.
    const set = await callTool({ name: "time.set", args: { seconds: 60 } }, gmCtx);
    expect(set.kind).toBe("result");
    if (set.kind !== "result") return;
    expect(set.result.isError, set.result.content[0]?.text).toBeUndefined();
    expect(readWorldClock(boot.store.getAll("settings"))).toBe(60);
    const vex = boot.store.get("actors", "a-vex") as unknown as ActorDocument | undefined;
    expect(vex?.effects ?? []).toHaveLength(1);

    // …and back to zero. The clock went backwards, so nothing expires: time un-passing has not
    // cast anything in reverse.
    const back = await callTool({ name: "time.set", args: { seconds: 0 } }, gmCtx);
    expect(back.kind).toBe("result");
    if (back.kind !== "result") return;
    expect(back.result.content[0]?.text).toContain("a backward jump, so nothing expired");
    expect(readWorldClock(boot.store.getAll("settings"))).toBe(0);
    expect(
      (boot.store.get("actors", "a-vex") as unknown as ActorDocument | undefined)?.effects ?? [],
    ).toHaveLength(1);

    const player = await openAgent(boot, "player");
    const playerCtx = hexCtxOf(player.session, player.grant);
    const refused = await callTool(
      { name: "time.advance", args: { hours: 6 } },
      playerCtx,
    );
    expect(refused.kind).toBe("result");
    if (refused.kind !== "result") return;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]?.text).toBe(refusalFor("time.control"));
    // Nothing moved: a refused write is not a partial write.
    expect(readWorldClock(boot.store.getAll("settings"))).toBe(0);

    const tod = await callTool({ name: "time.of_day", args: {} }, playerCtx);
    expect(tod.kind).toBe("result");
    if (tod.kind !== "result") return;
    expect(tod.result.isError).toBeUndefined();
    expect(tod.result.content[0]?.text).toContain("It is 00:00 on day 0 — night");
  });
});

describe("dice, through the host's own dice (§5.5)", () => {
  test("the number is the host's, the card is the agent's, and applying it lands on the actor", async () => {
    const boot = await bootCombat();
    const { session, grant } = await openAgent(boot, "gm", "Roller");
    const ctx = hexCtxOf(session, grant);

    const rolled = await callTool(
      { name: "dice.roll", args: { formula: "1d20+5", flavor: "attack: goblin" } },
      ctx,
    );
    expect(rolled.kind).toBe("result");
    if (rolled.kind !== "result") return;
    expect(rolled.result.isError, rolled.result.content[0]?.text).toBeUndefined();
    const body = rolled.result.content[0]?.text ?? "";
    const total = Number(/1d20\+5 = (-?\d+)/.exec(body)?.[1] ?? "NaN");
    // The number came from the host's dice, so all this can assert is that it is a legal one.
    expect(total).toBeGreaterThanOrEqual(6);
    expect(total).toBeLessThanOrEqual(25);
    expect(body).toContain("rolled by the host");

    // …and it is a card on the replica, authored by the agent and carrying the same total: the
    // roll is not a number the bridge computed and whispered back.
    const card = (boot.store.getAll("messages") as unknown as MessageDocument[])
      .filter((row) => (row as unknown as { roll?: { total?: number } | null }).roll !== null)
      .at(-1);
    expect(card).toBeDefined();
    expect(card?.author).toBe(session.user._id);
    expect(card?.roll?.total).toBe(total);
    expect(card?.flavor).toBe("attack: goblin");

    const applied = await callTool(
      {
        name: "dice.apply",
        args: { messageId: card?._id ?? "", actorId: "a-vex", mode: "damage" },
      },
      ctx,
    );
    expect(applied.kind).toBe("result");
    if (applied.kind !== "result") return;
    expect(applied.result.isError, applied.result.content[0]?.text).toBeUndefined();
    expect(applied.result.content[0]?.text).toContain(`hit points 30 → ${30 - total}`);

    // The host's own arithmetic, read back off the actor: the agent named a card, never an amount.
    const vex = boot.store.get("actors", "a-vex") as unknown as ActorDocument | undefined;
    expect(
      ((vex?.system as { pf1e?: { hp?: number } } | undefined)?.pf1e?.hp ?? -1) as number,
    ).toBe(30 - total);
    // …and the card records it, so the same card cannot be counted twice against the same actor.
    const after = boot.store.get("messages", card?._id ?? "") as unknown as MessageDocument | undefined;
    expect(readRollApplications(after as never)["a-vex"]?.damage).toBe(total);
  });

  test("a player agent may roll, and may not apply the number it rolled", async () => {
    const boot = await bootCombat();
    const { session, grant } = await openAgent(boot, "player", "Vex");
    const ctx = hexCtxOf(session, grant);

    const rolled = await callTool({ name: "dice.roll", args: { formula: "1d20" } }, ctx);
    expect(rolled.kind).toBe("result");
    if (rolled.kind !== "result") return;
    expect(rolled.result.isError, rolled.result.content[0]?.text).toBeUndefined();

    const applied = await callTool(
      { name: "dice.apply", args: { messageId: "m-1", actorId: "a-vex", mode: "damage" } },
      ctx,
    );
    expect(applied.kind).toBe("result");
    if (applied.kind !== "result") return;
    expect(applied.result.isError).toBe(true);
    expect(applied.result.content[0]?.text).toBe(refusalFor("dice.apply"));
    expect(
      ((boot.store.get("actors", "a-vex") as unknown as ActorDocument | undefined)?.system as
        | { pf1e?: { hp?: number } }
        | undefined)?.pf1e?.hp ?? 0,
    ).toBe(30);
  });
});

describe("fog, through a real host (§5.5)", () => {
  test("opening a cell opens it for the table — the mask and the reveal set move together", async () => {
    const boot = await bootHexcrawl();
    const { session, grant } = await openAgent(boot, "gm", "Cartographer");
    const ctx = hexCtxOf(session, grant);
    const player = await openAgent(boot, "player", "Scout");
    const playerCtx = hexCtxOf(player.session, player.grant);

    const before = await callTool({ name: "hexcrawl.cells", args: {} }, playerCtx);
    expect(before.kind).toBe("result");
    if (before.kind !== "result") return;
    expect(before.result.content[0]?.text).not.toContain("1,0");

    const seqBefore = boot.store.seq;
    const revealed = await callTool({ name: "fog.reveal", args: { cells: ["1,0"] } }, ctx);
    expect(revealed.kind).toBe("result");
    if (revealed.kind !== "result") return;
    expect(revealed.result.isError, revealed.result.content[0]?.text).toBeUndefined();
    expect(revealed.result.content[0]?.text).toContain("revealed 1 cell(s) on Goblinwood");
    // One envelope: the mask a canvas paints and the hex list the tools read are the same act.
    expect(boot.store.seq).toBe(seqBefore + 1);
    const envelope = boot.log.at(boot.store.seq);
    expect(envelope?.env.by).toBe(session.user._id);
    expect(envelope?.env.ops.length).toBeGreaterThan(1);

    const state = await callTool({ name: "fog.state", args: {} }, ctx);
    expect(state.kind).toBe("result");
    if (state.kind !== "result") return;
    expect(state.result.content[0]?.text).toContain("2 of 3 shown to the table");

    // …and the player's replica **received the document**: a hex the party has not been shown is
    // not sent at all (D-271), so this is what "opening a cell" means to a player agent.
    for (let i = 0; i < 6; i++) await flushMicrotasks();
    const after = await callTool({ name: "hexcrawl.cells", args: {} }, playerCtx);
    expect(after.kind).toBe("result");
    if (after.kind !== "result") return;
    expect(after.result.content[0]?.text).toContain("1,0");

    // Closing it puts it back under cover, and the player's replica loses the document again.
    const hidden = await callTool({ name: "fog.hide", args: { cells: ["1,0"] } }, ctx);
    expect(hidden.kind).toBe("result");
    if (hidden.kind !== "result") return;
    expect(hidden.result.isError, hidden.result.content[0]?.text).toBeUndefined();
    for (let i = 0; i < 6; i++) await flushMicrotasks();
    const closed = await callTool({ name: "hexcrawl.cells", args: {} }, playerCtx);
    expect(closed.kind).toBe("result");
    if (closed.kind !== "result") return;
    expect(closed.result.content[0]?.text).not.toContain("1,0");
  });

  test("a player agent cannot paint the mask, and the fog does not move", async () => {
    const boot = await bootHexcrawl();
    const { session, grant } = await openAgent(boot, "player", "Scout");
    const ctx = hexCtxOf(session, grant);
    const seqBefore = boot.store.seq;
    const answered = await callTool({ name: "fog.reveal", args: { all: true } }, ctx);
    expect(answered.kind).toBe("result");
    if (answered.kind !== "result") return;
    expect(answered.result.isError).toBe(true);
    expect(answered.result.content[0]?.text).toBe(refusalFor("fog.reveal"));
    expect(boot.store.seq).toBe(seqBefore);
  });
});
