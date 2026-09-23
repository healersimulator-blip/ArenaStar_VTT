// MCP connector — **the proof that an agent can author a hexcrawl.**
//
// Phase 5 gave the connector the reads of the overland map and the two verbs of walking it
// (`travel.plan`, `travel.advance`). What it could not do was *make* one. These seven tools close
// that, and the claim they make is not "the tools exist" — it is that **what an agent writes is the
// same document the Hex window writes**, that a hex authored this way is found by the same rules the
// UI uses, and that an agent with a PLAYER grant is refused the whole set.
//
// So this file never touches a fixture: it boots a real host, opens a real agent session, calls the
// tools through `callTool` (the same path an MCP client takes), and then reads the **host's own
// store** — not the agent's answer — to see what landed. A test that trusted the tool's prose would
// prove the tool can talk.
import { describe, expect, test } from "vitest";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { createEventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { enableHexcrawlOps } from "../../src/core/hexcrawl/scene";
import { hexcrawlProfileOf } from "../../src/core/hexcrawl/types";
import type { CellDocument, SceneDocument, UserDocument } from "../../src/core/documents";
import type { AgentGrant } from "../../src/core/agents/capabilities";
import { grantFor, refusalFor } from "../../src/core/agents/capabilities";
import type { ToolContext } from "../../src/core/agents/types";
import type { ToolCall } from "../../src/core/agents/tools";
import { callTool } from "../../src/core/agents/tools";
import { openAgentSession } from "../../src/app/agentSession";
import type { AgentSession } from "../../src/app/agentSession";
import { agentWorldView } from "../../src/app/agentBridge";

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

/** A 1000×1000 square scene with one party token on it. */
function sceneDoc(): SceneDocument {
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
      {
        _id: "t-party",
        type: "token",
        name: "Vex",
        ownership: { default: 2 },
        flags: {},
        system: {},
        x: 150,
        y: 150,
        rotation: 0,
        width: 100,
        height: 100,
        img: null,
        hidden: false,
        disposition: "friendly",
        vision: false,
        light: { radius: 0, color: "#ffffff", intensity: 0.5 },
      },
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

interface Booted {
  host: HostSync;
  store: DocumentStore;
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
    roomId: "room-authoring",
    verifyHelloSig: async (hello) => hello.sig === "valid",
  });
  const ops = [
    { kind: "create" as const, coll: "users" as const, data: userDoc(GM_ID, "GM", "GM") },
    { kind: "create" as const, coll: "users" as const, data: userDoc(PLAYER_ID, "Vex", "PLAYER") },
    { kind: "create" as const, coll: "scenes" as const, data: sceneDoc() },
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
  return { host, store, gm };
}

/**
 * A hexcrawl world, switched on with the app's own builder: two cells the GM authored by hand, one
 * of them still under cover. Everything below writes into *this* scene, so what the tests assert is
 * that the tools land on the same documents the Hex window edits.
 */
async function bootHexcrawl(): Promise<Booted> {
  const boot = await bootWorld();
  const scene = boot.store.get("scenes", "s1") as unknown as SceneDocument;
  boot.gm.submit(enableHexcrawlOps(scene, { revealed: ["0,0"], partyTokenId: "t-party" }));
  for (let i = 0; i < 6; i++) await flushMicrotasks();
  return boot;
}

async function openAgent(boot: Booted, preset: "player" | "gm", name = "Cartographer") {
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
  return opened.session;
}

/** A tool context over the real session — plus a fake asset pipeline for `asset.import`. */
function ctxOf(
  session: AgentSession,
  grant: AgentGrant,
  importImage?: (bytes: Uint8Array, name: string, mime: string) => Promise<{ hash: string }>,
): ToolContext {
  return {
    view: agentWorldView(session.client, importImage ? { importImage } : {}),
    grant,
    writer: session.writer,
  };
}

const gmGrant = grantFor("gm");
const playerGrant = grantFor("player");

/** The text of an answered tool, which is what a model reads. */
async function said(outcome: ToolCall): Promise<{ text: string; isError: boolean }> {
  expect(outcome.kind).toBe("result");
  if (outcome.kind !== "result") throw new Error("no result");
  return {
    text: outcome.result.content[0]?.text ?? "",
    isError: outcome.result.isError === true,
  };
}

async function call(
  session: AgentSession,
  grant: AgentGrant,
  name: string,
  args: Record<string, unknown>,
  importImage?: (bytes: Uint8Array, n: string, m: string) => Promise<{ hash: string }>,
): Promise<{ text: string; isError: boolean; outcome: ToolCall }> {
  const outcome = await callTool({ name, args: args as never }, ctxOf(session, grant, importImage));
  const answer = await said(outcome);
  return { ...answer, outcome };
}

// Cells are embedded in their scene (D-012), so there is no `cells` collection to read: the
// host's own scene is the truth, exactly as it is for the Hex window.
const cellsOf = (store: DocumentStore): CellDocument[] =>
  ((store.get("scenes", "s1") as unknown as SceneDocument | null)?.cells ??
    []) as unknown as CellDocument[];

const cellByKey = (store: DocumentStore, key: string): CellDocument | null =>
  cellsOf(store).find((cell) => cell.key === key) ?? null;

describe("an agent can author a hexcrawl (D-292)", () => {
  test("hexcrawl.configure switches the scene on and sets what one hex means", async () => {
    const boot = await bootWorld();
    const session = await openAgent(boot, "gm");

    const answer = await call(session, gmGrant, "hexcrawl.configure", {
      cellDistance: 6,
      units: "mi",
      sightMode: "gm+party",
      radiusCells: 1,
      encounterMode: "prompt",
      partyTokenId: "t-party",
    });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("one hex = 6 mi");

    // The host's own scene: the scale is a grid field, because that is where the app keeps it.
    const scene = boot.store.get("scenes", "s1") as unknown as SceneDocument;
    expect(scene.grid.distance).toBe(6);
    expect(scene.grid.units).toBe("mi");
    const profile = hexcrawlProfileOf(scene);
    expect(profile?.sight.mode).toBe("gm+party");
    expect(profile?.sight.radiusCells).toBe(1);
    expect(profile?.encounterMode).toBe("prompt");
    expect(profile?.partyTokenId).toBe("t-party");
  });

  test("a value the app does not read is refused, not silently dropped", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    const before = boot.store.seq;

    // The first draft of this call accepted any string and wrote nothing at all for a mode the
    // profile does not read: the tool answered "written", and the scene behaved as before.
    const sight = await call(session, gmGrant, "hexcrawl.configure", { sightMode: "gm+parties" });
    expect(sight.isError).toBe(true);
    expect(sight.text).toContain("sightMode");
    expect(sight.text).toContain("gm+party");

    const mode = await call(session, gmGrant, "hexcrawl.configure", { encounterMode: "sometimes" });
    expect(mode.isError).toBe(true);
    expect(mode.text).toContain("auto, prompt, manual");

    expect(boot.store.seq).toBe(before);
  });

  test("hex.write authors a hex whole — name, terrain, texts, and a hidden feature", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");

    const answer = await call(session, gmGrant, "hex.write", {
      key: "2,1",
      name: "The Ash Mile",
      terrain: "forest",
      description: "A burned mile of road; the ash is warm.",
      playerText: "The road runs through a burned wood.",
      features: [
        {
          name: "Charred shrine",
          text: "A wayside shrine, blackened but standing.",
          reveal: { kind: "perception", dc: 15 },
        },
      ],
      open: true,
    });
    expect(answer.isError).toBe(false);
    // The read-back names the hex the GM would see in the window, not the key it was written to.
    expect(answer.text).toContain("The Ash Mile");
    expect(answer.text).toContain("open to the party");

    // The host's store, not the tool's answer: one cell, with everything on it.
    const cell = cellByKey(boot.store, "2,1");
    expect(cell).not.toBeNull();
    if (!cell) return;
    expect(cell.name).toBe("The Ash Mile");
    expect(cell.terrain).toBe("forest");
    expect(cell.description).toBe("A burned mile of road; the ash is warm.");
    expect(cell.playerText).toBe("The road runs through a burned wood.");
    expect(cell.features).toHaveLength(1);
    const feature = cell.features?.[0];
    expect(feature?.name).toBe("Charred shrine");
    // Hidden is the default and the point: an authored feature is one the party has not found.
    expect(feature?.state?.revealed).toBe(false);
    // The rule survived as the rule, not as a prose label: the game's own reveal pass is what
    // finds it later, and it reads `reveal` off the feature.
    expect(feature?.reveal).toEqual({ kind: "perception", dc: 15 });
    expect(feature?.autoReveal).toBe(true);

    const scene = boot.store.get("scenes", "s1") as unknown as SceneDocument;
    expect(hexcrawlProfileOf(scene)?.revealed).toContain("2,1");
  });

  test("a hex that is already as described writes nothing, and says so", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    await call(session, gmGrant, "hex.write", { key: "3,1", name: "Ford", terrain: "plains" });
    const seq = boot.store.seq;

    const again = await call(session, gmGrant, "hex.write", { key: "3,1", name: "Ford", terrain: "plains" });
    expect(again.isError).toBe(false);
    expect(again.text).toContain("already as you described it");
    expect(boot.store.seq).toBe(seq);
  });

  test("hex.write with dryRun changes nothing and prints the envelope", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    const seq = boot.store.seq;

    const answer = await call(session, gmGrant, "hex.write", {
      key: "4,1",
      name: "Barrow",
      terrain: "hills",
      dryRun: true,
    });
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("dry run");
    expect(answer.text).toContain("create cells");
    expect(cellByKey(boot.store, "4,1")).toBeNull();
    expect(boot.store.seq).toBe(seq);
  });

  test("hex.reveal opens several hexes in one envelope, and closes them again", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    await call(session, gmGrant, "hex.write", { key: "2,0", name: "Treeline" });
    await call(session, gmGrant, "hex.write", { key: "3,0", name: "Thornwood" });

    const opened = await call(session, gmGrant, "hex.reveal", { keys: ["2,0", "3,0"] });
    expect(opened.isError).toBe(false);
    const scene = boot.store.get("scenes", "s1") as unknown as SceneDocument;
    expect(hexcrawlProfileOf(scene)?.revealed).toEqual(expect.arrayContaining(["2,0", "3,0"]));

    const closed = await call(session, gmGrant, "hex.reveal", { keys: ["2,0"], open: false });
    expect(closed.isError).toBe(false);
    const after = hexcrawlProfileOf(boot.store.get("scenes", "s1") as unknown as SceneDocument);
    expect(after?.revealed).not.toContain("2,0");
    expect(after?.revealed).toContain("3,0");

    // Re-closing a closed hex is nothing, not an error: idempotence is what makes a retry safe.
    const twice = await call(session, gmGrant, "hex.reveal", { keys: ["2,0"], open: false });
    expect(twice.text).toContain("already in that state");
  });

  test("a refusals names what is missing rather than writing a hex that points at nothing", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");

    const terrain = await call(session, gmGrant, "hex.write", { key: "5,1", terrain: "volcano" });
    expect(terrain.isError).toBe(true);
    // And the refusal names the catalog it checked, because "plains, forest, …" is the whole
    // answer to "what should I have said".
    expect(terrain.text).toContain("terrain 'volcano' is not in this world's catalog");
    expect(terrain.text).toContain("plains");

    const table = await call(session, gmGrant, "hex.write", { key: "5,1", tables: ["tbl-nope"] });
    expect(table.isError).toBe(true);
    expect(table.text).toContain("no encounter table 'tbl-nope'");

    const rule = await call(session, gmGrant, "hex.write", {
      key: "5,1",
      features: [{ name: "Ruin", text: "…", reveal: { kind: "perception" } }],
    });
    expect(rule.isError).toBe(true);
    // The refusal names the field, because "how hard is it to spot" is the question the agent has
    // to answer before the feature means anything.
    expect(rule.text).toContain("perception rule with no dc");

    const unknown = await call(session, gmGrant, "hex.write", {
      key: "5,1",
      features: [{ name: "Ruin", text: "…", reveal: { kind: "vibes" } }],
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("manual, perception, time or dice");

    const empty = await call(session, gmGrant, "hex.write", { key: "5,1" });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("nothing to write");

    // A call that names no cell at all is malformed, not refused: the schema catches it before
    // the gate does, and the client gets a -32602 rather than a sentence about the world.
    const noKey = await callTool({ name: "hex.write", args: {} }, ctxOf(session, gmGrant));
    expect(noKey.kind).toBe("invalid");

    // And none of the refusals wrote anything.
    expect(cellByKey(boot.store, "5,1")).toBeNull();
  });

  test("encounterTable.create writes a table whose rows point at real actors", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");

    // The thing a row will point at: an actor, made the way the agent makes one elsewhere.
    const made = await call(session, gmGrant, "actor.from_statblock", {
      text: "Goblin Warrior CR 1/3\nXP 135\nGoblin warrior 1\nNE Small humanoid (goblinoid)\nInit +6; Senses darkvision 60 ft.; Perception -1\n\nDEFENSE\n\nAC 16, touch 13, flat-footed 14 (+2 armor, +2 Dex, +1 shield, +1 size)\nhp 6 (1d10+1)\nFort +3, Ref +4, Will -1\n\nOFFENSE\n\nSpeed 30 ft.\nMelee short sword +2 (1d4/19-20)\n\nSTATISTICS\n\nStr 11, Dex 15, Con 12, Int 10, Wis 9, Cha 6\nBase Atk +1; CMB +1; CMD 12\nFeats Improved Initiative\nSkills Ride +6, Stealth +10\nLanguages Goblin",
    });
    expect(made.isError).toBe(false);
    const actorId = String(
      (made.outcome as { result?: { structuredContent?: Record<string, unknown> } }).result
        ?.structuredContent?.["actorId"] ?? "",
    );
    expect(actorId).not.toBe("");

    const table = await call(session, gmGrant, "encounterTable.create", {
      name: "Goblinwood — road",
      entries: [
        { text: "Nothing but crows", weight: 3 },
        { text: "Goblin bandits", weight: 1, count: 2, refs: [{ kind: "actor", actorId }] },
      ],
      sceneId: "s1",
      cooldownSeconds: 3600,
      exploring: true,
    });
    expect(table.isError).toBe(false);
    expect(table.text).toContain("[table-");

    const rows = boot.store.getAll("encounterTables") as unknown as Array<
      Record<string, unknown> & { name: string; entries: Array<Record<string, unknown>> }
    >;
    expect(rows).toHaveLength(1);
    const written = rows[0];
    if (!written) return;
    expect(written.name).toBe("Goblinwood — road");
    expect(written.mode).toBe("weighted");
    expect(written.cooldownSeconds).toBe(3600);
    expect(written.sceneId).toBe("s1");
    // The ref is the point of the whole exercise: a row that names a monster has to be able to
    // point at the monster, or the encounter it draws places nothing on the map.
    const bandits = written.entries.find((entry) => entry["text"] === "Goblin bandits");
    expect(bandits?.["refs"]).toEqual([{ kind: "actor", actorId }]);
    expect(bandits?.["count"]).toBe(2);
    // Tags default to the app's own defaults, not to whatever the JSON happened to hold.
    expect(written.tags).toMatchObject({ day: true, night: true, entering: true, moving: true, exploring: true, fighting: false });
  });

  test("a table row pointing at an actor who does not exist is refused, not silently dropped", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");

    const answer = await call(session, gmGrant, "encounterTable.create", {
      name: "Goblinwood — ghosts",
      entries: [{ text: "A ghost", refs: [{ kind: "actor", actorId: "a-nobody" }] }],
    });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("no actor 'a-nobody'");
    expect(answer.text).toContain("actor.from_compendium");
    expect(boot.store.getAll("encounterTables")).toHaveLength(0);
  });

  test("a hex is attached to its table, and the table follows into the hex's read-back", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");

    const created = await call(session, gmGrant, "encounterTable.create", {
      name: "Goblinwood — road",
      entries: [{ text: "Nothing but crows", weight: 1 }],
    });
    const tableId = String(
      (created.outcome as { result?: { structuredContent?: Record<string, unknown> } }).result
        ?.structuredContent?.["tableId"] ?? "",
    );
    expect(tableId).not.toBe("");

    await call(session, gmGrant, "hex.write", {
      key: "1,0",
      name: "The King's Road",
      terrain: "road",
      tables: [tableId],
    });

    const cell = cellByKey(boot.store, "1,0");
    expect(cell?.tables).toEqual([tableId]);
    // And the connector's own read of it, which is what the agent sees next turn.
    const read = await call(session, gmGrant, "hex.read", { key: "1,0" });
    expect(read.text).toContain(tableId);
  });

  test("encounterTable.update rewrites a table, and an update that sends no rows keeps them", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    const created = await call(session, gmGrant, "encounterTable.create", {
      name: "Goblinwood — road",
      entries: [{ text: "Nothing but crows", weight: 1 }],
    });
    const tableId = String(
      (created.outcome as { result?: { structuredContent?: Record<string, unknown> } }).result
        ?.structuredContent?.["tableId"] ?? "",
    );

    const renamed = await call(session, gmGrant, "encounterTable.update", {
      tableId,
      name: "Goblinwood — the high road",
    });
    expect(renamed.isError).toBe(false);
    const rows = boot.store.getAll("encounterTables") as unknown as Array<
      Record<string, unknown> & { entries: unknown[] }
    >;
    expect(rows[0]?.name).toBe("Goblinwood — the high road");
    expect(rows[0]?.entries).toHaveLength(1);

    const rewritten = await call(session, gmGrant, "encounterTable.update", {
      tableId,
      entries: [
        { text: "Crows", weight: 1 },
        { text: "Wolves", weight: 2 },
      ],
    });
    expect(rewritten.isError).toBe(false);
    const after = boot.store.getAll("encounterTables") as unknown as Array<
      Record<string, unknown> & { entries: unknown[] }
    >;
    expect(after[0]?.entries).toHaveLength(2);

    const gone = await call(session, gmGrant, "encounterTable.update", { tableId: "tbl-nope", name: "X" });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain("no encounter table 'tbl-nope'");
  });

  test("encounterTable.delete removes it, and refuses before it is called on one that is not there", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    const created = await call(session, gmGrant, "encounterTable.create", {
      name: "Goblinwood — road",
      entries: [{ text: "Crows", weight: 1 }],
    });
    const tableId = String(
      (created.outcome as { result?: { structuredContent?: Record<string, unknown> } }).result
        ?.structuredContent?.["tableId"] ?? "",
    );

    const dry = await call(session, gmGrant, "encounterTable.delete", { tableId, dryRun: true });
    expect(dry.text).toContain("dry run");
    expect(boot.store.getAll("encounterTables")).toHaveLength(1);

    const done = await call(session, gmGrant, "encounterTable.delete", { tableId });
    expect(done.isError).toBe(false);
    expect(boot.store.getAll("encounterTables")).toHaveLength(0);

    const again = await call(session, gmGrant, "encounterTable.delete", { tableId });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("no encounter table");
  });

  test("asset.import stores an image and the hash goes straight onto a feature", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    let stored: Uint8Array | null = null;
    const importImage = async (bytes: Uint8Array) => {
      stored = bytes;
      // The pipeline's answer is a content hash: the one name a picture has in this world.
      return { hash: "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" };
    };

    const answer = await call(
      session,
      gmGrant,
      "asset.import",
      { name: "shrine.png", mime: "image/png", base64: Buffer.from("test-image-bytes").toString("base64") },
      importImage,
    );
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("sha256:9f86d081");
    expect(stored).not.toBeNull();

    const hash = "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const wrote = await call(session, gmGrant, "hex.write", {
      key: "6,1",
      name: "The Black Shrine",
      features: [
        { name: "Shrine door", text: "Iron-bound.", img: hash, reveal: { kind: "manual" } },
      ],
    });
    expect(wrote.isError).toBe(false);
    const feature = cellByKey(boot.store, "6,1")?.features?.[0];
    expect(feature?.img).toBe(hash);
  });

  test("asset.import refuses a file too large for the pipeline rather than failing inside it", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    const big = Buffer.alloc(9 * 1024 * 1024, 1).toString("base64");
    const answer = await call(
      session,
      gmGrant,
      "asset.import",
      { name: "huge.png", mime: "image/png", base64: big },
      async () => ({ hash: "sha256:never" }),
    );
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("the limit is");
  });

  test("a gridless map authors zones, and a zone with no geometry is refused", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    // Make the scene gridless first: the same call that sets the scale.
    await call(session, gmGrant, "hexcrawl.configure", { cellDistance: 3, units: "mi", hexLayout: "" });
    boot.gm.submit([
      {
        kind: "update",
        ref: { coll: "scenes", id: "s1" },
        diff: { "grid.type": "gridless" } as never,
      },
    ]);
    for (let i = 0; i < 6; i++) await flushMicrotasks();

    const bare = await call(session, gmGrant, "hex.write", {
      key: "the-ford",
      name: "The Ford",
      terrain: "water",
    });
    expect(bare.isError).toBe(true);
    expect(bare.text).toContain("poly");

    const zoned = await call(session, gmGrant, "hex.write", {
      key: "the-ford",
      name: "The Ford",
      terrain: "water",
      poly: [10, 10, 60, 10, 60, 60, 10, 60],
    });
    expect(zoned.isError).toBe(false);
    const cell = cellByKey(boot.store, "the-ford");
    expect(cell?.name).toBe("The Ford");
    expect(cell?.poly).toEqual([10, 10, 60, 10, 60, 60, 10, 60]);
  });

  test("hex.write deletes a hex when it is told to", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    await call(session, gmGrant, "hex.write", { key: "7,1", name: "Camp" });
    expect(cellByKey(boot.store, "7,1")).not.toBeNull();

    const gone = await call(session, gmGrant, "hex.write", { key: "7,1", delete: true });
    expect(gone.isError).toBe(false);
    expect(cellByKey(boot.store, "7,1")).toBeNull();
  });
});

describe("the gate: who may author the overworld (§4)", () => {
  test("a PLAYER-grant agent is refused every authoring tool, and writes nothing", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "player");
    const before = boot.store.seq;

    const attempts: Array<[string, Record<string, unknown>]> = [
      ["hex.write", { key: "9,9", name: "Somewhere" }],
      ["hex.reveal", { keys: ["0,0"] }],
      ["hexcrawl.configure", { cellDistance: 12, units: "mi" }],
      ["encounterTable.create", { name: "Road", entries: [{ text: "Crows" }] }],
      ["encounterTable.update", { tableId: "tbl-road", name: "Road" }],
      ["encounterTable.delete", { tableId: "tbl-road" }],
      ["asset.import", { name: "map.png", mime: "image/png", base64: "aGk=" }],
    ];
    for (const [name, args] of attempts) {
      const answer = await call(session, playerGrant, name, args);
      expect(answer.isError, `${name} should be refused`).toBe(true);
      expect(answer.text, `${name} should say which capability it wants`).toBe(
        refusalFor(name === "asset.import" ? "assets.write" : "hexcrawl.author"),
      );
    }
    // Nothing landed: a refusal that changed the world would not be a refusal.
    expect(boot.store.seq).toBe(before);
    expect(cellByKey(boot.store, "9,9")).toBeNull();
  });

  test("an agent with no session to attribute a write to says so", async () => {
    const boot = await bootHexcrawl();
    const session = await openAgent(boot, "gm");
    const ctx: ToolContext = { view: agentWorldView(session.client), grant: gmGrant };
    const outcome = await callTool({ name: "hex.write", args: { key: "8,8" } }, ctx);
    const answer = await said(outcome);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("no agent session is bound");
    expect(cellByKey(boot.store, "8,8")).toBeNull();
  });

  test("the capability is not in the player's or the observer's preset", async () => {
    expect(grantFor("player").capabilities).not.toContain("hexcrawl.author");
    expect(grantFor("observer").capabilities).not.toContain("hexcrawl.author");
    expect(grantFor("gm").capabilities).toContain("hexcrawl.author");
  });
});
