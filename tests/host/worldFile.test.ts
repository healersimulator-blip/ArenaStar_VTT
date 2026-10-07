import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, test } from "vitest";
import {
  deleteAsset,
  deleteWorldData,
  getAllDocumentRecords,
  listAssets,
  openVttDb,
} from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import {
  exportWorldZip,
  importWorldZip,
  WORLD_FILE_FORMAT,
  type WorldFileDocuments,
  type WorldFileMeta,
} from "../../src/host/worldFile";
import { DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import { boot, settle } from "../app/fakes";
import { HostPersister } from "../../src/storage/persistence";
import {
  getReport,
  latestCheckpoint,
  putCheckpoint,
  putReport,
} from "../../src/storage/strategicStore";
import type { ActorDocument, AutomationDocument, MacroDocument, TokenDocument, UserDocument } from "../../src/core/documents";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair } from "../../src/net/memory";
import { createEventBus } from "../../src/core/events";
import { projectWorld } from "../../src/core/projection";
import { canSaveWorldMacros, UNAPPROVED_SCRIPT_HASH, type PlayerMacroDraft } from "../../src/core/playerMacros";
import { scriptApprovalHash, validateScriptMacro, type ScriptPolicy } from "../../src/core/scriptMacros";

const token = (id: string, x: number, y: number): TokenDocument => ({
  _id: id,
  type: "token",
  name: id,
  ownership: { default: 0, gm: 3 },
  flags: {},
  system: {},
  x,
  y,
  rotation: 0,
  width: 100,
  height: 100,
  img: "",
  hidden: false,
  disposition: "neutral",
  vision: true,
  light: { radius: 0, color: "#fff", alpha: 0.5 },
});

async function addToken(app: HostApp, doc: TokenDocument): Promise<void> {
  app.gm.client.submit([
    {
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: DEFAULT_SCENE_ID },
      data: doc,
    },
  ]);
  await settle();
}

function parseZip(bytes: Uint8Array): Map<string, Uint8Array> {
  return new Map(Object.entries(unzipSync(bytes)));
}

describe("world.zip export/import (§8)", () => {
  let db: Awaited<ReturnType<typeof openVttDb>>;

  beforeEach(async () => {
    db = await openVttDb();
  });

  test("D-394 authenticated player saves reach the actual world ZIP and restore/copy with GM opt-in and original drafts", async () => {
    const root = new MemDirHandle();
    const app = await boot(root);
    const authorId = "archive-author";
    const author: UserDocument = { _id: authorId, type: "user", name: "Archive author", role: "PLAYER",
      ownership: { default: 0 }, flags: {}, system: {}, character: null, color: "#fff" };
    // Users are host-assigned (never created by generic intents); authenticate the fixture peer.
    expect(app.host.commitSystem([{ kind: "create", coll: "users", data: author }]).ok).toBe(true);
    await settle();
    const pair = createTransportPair();
    app.host.addSession("archive-player", pair.a, { id: authorId, role: "PLAYER", name: author.name });
    const bus = createEventBus<ClientEvents>();
    const player = new ClientSync({ transport: pair.b, bus, meta: app.store.meta });
    await settle();
    const results: ClientEvents["macroResult"][] = [];
    bus.on("macroResult", (message) => results.push(message));
    const chat: PlayerMacroDraft = { kind: "chat", name: "World-persisted roll", command: "/roll 1d20" };
    const script: PlayerMacroDraft = { kind: "script", name: "World-persisted script draft", command: "return { original: true };",
      sceneId: DEFAULT_SCENE_ID, inputs: [{ name: "note", type: "string" }] };
    player.saveWorldMacro("archive-chat", chat);
    await settle();
    expect(results.at(-1)?.ok).toBe(false);
    expect(app.store.get("macros", "archive-chat")).toBeUndefined();
    app.gm.client.submit([{ kind: "update", ref: { coll: "users", id: authorId }, diff: { canSaveMacros: true } }]);
    await settle();
    expect(canSaveWorldMacros(player.user, player.store.getAll("users"))).toBe(true);
    player.saveWorldMacro("archive-chat", chat);
    await settle();
    expect(results.at(-1)?.ok).toBe(true);
    player.saveWorldMacro("archive-script", script);
    await settle();
    expect(results.at(-1)?.ok).toBe(true);
    const exportedSeq = app.store.seq;
    const archive = await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister });
    const files = parseZip(new Uint8Array(await archive.arrayBuffer()));
    const documents = JSON.parse(strFromU8(files.get("documents.json") as Uint8Array)) as WorldFileDocuments;
    expect(documents.seq).toBe(exportedSeq);
    const exportedAuthor = documents.docs.find((row) => row.coll === "users" && row.id === authorId)?.doc as UserDocument;
    expect(exportedAuthor.canSaveMacros).toBe(true);
    for (const [id, draft] of [["archive-chat", chat], ["archive-script", script]] as const) {
      const doc = documents.docs.find((row) => row.coll === "macros" && row.id === id)?.doc as MacroDocument;
      expect(doc.command).toBe(draft.command);
      expect(doc.playerAuthoring).toEqual({ version: 1, userId: authorId, draft });
      expect(doc.ownership).toEqual({ default: 0, [authorId]: 3 });
    }
    expect((documents.docs.find((row) => row.id === "archive-script")?.doc as MacroDocument).script).toMatchObject({
      approvedHash: UNAPPROVED_SCRIPT_HASH, playerCallable: false, grants: [], runAs: "caller",
    });
    // Drift after the export; restore must restore the saved documents, not the current store.
    player.deleteWorldMacro("archive-chat");
    await settle();
    expect(app.store.get("macros", "archive-chat")).toBeUndefined();
    player.close();
    await app.close();

    for (const options of [{ mode: "copy" as const, worldId: "w-personal-copy" }, { mode: "replace" as const }]) {
      const imported = await importWorldZip({ db, file: archive, root, ...options });
      const reopened = await boot(root, imported.worldId);
      try {
        expect(reopened.store.seq).toBe(exportedSeq);
        const savedUser = reopened.store.get("users", authorId);
        expect(savedUser?.canSaveMacros).toBe(true);
        const viewer = { id: authorId, role: "PLAYER" as const };
        expect(canSaveWorldMacros(viewer, reopened.store.getAll("users"))).toBe(true);
        for (const [id, draft] of [["archive-chat", chat], ["archive-script", script]] as const) {
          expect(reopened.store.get("macros", id)?.playerAuthoring).toEqual({ version: 1, userId: authorId, draft });
          expect(reopened.store.get("macros", id)?.command).toBe(draft.command);
        }
        const projected = projectWorld(reopened.store.world, reopened.store.seq, viewer).collections.macros;
        expect(projected?.find((macro) => macro._id === "archive-script")?.command).toBe("");
        expect(projected?.find((macro) => macro._id === "archive-script")?.playerAuthoring?.draft.command).toBe(script.command);
        expect(projectWorld(reopened.store.world, reopened.store.seq, { id: "other", role: "PLAYER" }).collections.macros).toEqual([]);
        const restoredScript = reopened.store.get("macros", "archive-script");
        expect(restoredScript?.script).toMatchObject({ approvedHash: UNAPPROVED_SCRIPT_HASH, playerCallable: false });
        expect(restoredScript?.scriptState?.recent).toEqual([]); // import never carries execution approval
      } finally { await reopened.close(); }
    }
    await deleteWorldData(db, "w-personal-copy");
    await deleteWorldData(db, app.worldId);
  });

  test("a user-provided FX pack cannot be exported until separate redistribution rights are granted", async () => {
    const root = new MemDirHandle();
    const app = await boot(root);
    const bytes = new Uint8Array([21, 34, 55]);
    const { hash } = await app.assets.import(bytes, "premium.webm", "video/webm", "gm", "restricted");
    expect(app.store.world.assetManifest[hash]).toMatchObject({ visibility: "gm", exportRights: "restricted" });
    await expect(exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister }))
      .rejects.toThrow(/world-export rights.*premium\.webm/);
    expect((await app.assets.meta(hash))?.exportRights).toBe("restricted");
    await app.assets.describe(hash, { exportRights: "granted" });
    const archive = await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister });
    const files = parseZip(new Uint8Array(await archive.arrayBuffer()));
    const exported = JSON.parse(strFromU8(files.get("assets.json") as Uint8Array)) as Array<{
      hash: string; visibility: string; exportRights: string;
    }>;
    expect(exported.find((asset) => asset.hash === hash)).toMatchObject({
      hash, visibility: "gm", exportRights: "granted",
    });
    expect(files.get(`assets/${hash}`)).toEqual(bytes);
    await app.close();
    const copied = await importWorldZip({ db, file: archive, root, mode: "copy", worldId: "w-rights-copy" });
    const restored = (await listAssets(db, copied.worldId)).find((asset) => asset.hash === hash);
    expect(restored).toMatchObject({ visibility: "gm", exportRights: "restricted" });
    await expect(exportWorldZip({ db, worldId: copied.worldId, root }))
      .rejects.toThrow(/world-export rights/);
    await deleteWorldData(db, copied.worldId);
    // Every case in this file boots the most recent test world against an
    // independent in-memory OPFS root. Do not strand this case's asset row in
    // IDB for a later case whose root correctly has no such blob.
    await deleteWorldData(db, app.worldId);
  });

  test("FX timelines, spell/item bindings, presets and media survive world-file copy and restore", async () => {
    const root = new MemDirHandle();
    const app = await boot(root);
    const bytes = new Uint8Array([2, 3, 5, 7]);
    const { hash } = await app.assets.import(bytes, "fireball-glow.png", "image/png", "gm", "granted");
    const item = { _id: "archive-sword", type: "item" as const, name: "Archive sword",
      ownership: { default: 0 as const }, flags: {}, system: {}, effects: [] };
    const actor: ActorDocument = { _id: "archive-hero", type: "actor", name: "Archive hero",
      ownership: { default: 0 }, flags: {}, system: {}, items: [item], effects: [] };
    app.gm.client.submit([{ kind: "create", coll: "actors", data: actor }]);
    await settle();

    const image = { id: "fireball-media", kind: "image" as const, assetId: hash,
      startMs: 0, durationMs: 900, at: { kind: "point" as const, x: 120, y: 140 }, scale: 1.25 };
    const failure: MacroDocument = { _id: "fx-archive-fizzle", type: "macro", name: "Archive fizzle",
      command: "", kind: "sequence", ownership: { default: 0 }, flags: {}, system: {},
      sequence: { version: 1, audience: "gm", sections: [{ id: "fizzle", kind: "text",
        text: "The spell fizzles", startMs: 0, durationMs: 500,
        at: { kind: "point", x: 120, y: 140 } }] } };
    app.gm.client.submit([{ kind: "create", coll: "macros", data: failure }]);
    await settle();

    const spellCue: MacroDocument = { _id: "fx-archive-fireball", type: "macro", name: "Archive Fireball",
      command: "", kind: "sequence", ownership: { default: 2, "archive-player": 2 },
      flags: { core: { playerCallable: true } }, system: {},
      fxSpell: { spellId: "fireball", spellName: "Fireball", onFailureId: failure._id },
      sequence: { version: 1, audience: { players: ["archive-player"] }, sections: [image] } };
    const itemCue: MacroDocument = { _id: "fx-archive-sword", type: "macro", name: "Archive sword swing",
      command: "", kind: "sequence", ownership: { default: 2, "archive-player": 2 },
      flags: { core: { playerCallable: true } }, system: {},
      fxItem: { actorId: actor._id, itemId: item._id, events: ["attack"],
        recognition: "auto", enabled: true },
      sequence: { version: 1, audience: "others", sections: [{ id: "swing", kind: "text",
        text: "Steel flashes", startMs: 0, durationMs: 450,
        at: { kind: "point", x: 80, y: 90 } }] } };
    const preset: MacroDocument = { _id: "fx-archive-preset", type: "macro", name: "Archive glow preset",
      command: "", kind: "fxPreset", ownership: { default: 0 }, flags: {}, system: {},
      preset: { version: 1, sections: [image] } };
    app.gm.client.submit([{ kind: "create", coll: "macros", data: spellCue },
      { kind: "create", coll: "macros", data: itemCue }, { kind: "create", coll: "macros", data: preset }]);
    await settle();
    expect(app.store.get("macros", spellCue._id)?.fxSpell).toEqual(spellCue.fxSpell);
    expect(app.store.get("macros", itemCue._id)?.fxItem).toEqual(itemCue.fxItem);

    const archive = await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister });
    const files = parseZip(new Uint8Array(await archive.arrayBuffer()));
    const documents = JSON.parse(strFromU8(files.get("documents.json") as Uint8Array)) as WorldFileDocuments;
    const exportedMacro = (id: string): MacroDocument =>
      documents.docs.find((row) => row.coll === "macros" && row.id === id)?.doc as MacroDocument;
    expect(exportedMacro(spellCue._id)).toEqual(spellCue);
    expect(exportedMacro(itemCue._id)).toEqual(itemCue);
    expect(exportedMacro(preset._id)).toEqual(preset);
    expect(files.get(`assets/${hash}`)).toEqual(bytes);
    await app.close();

    for (const options of [{ mode: "copy" as const, worldId: "w-fx-archive-copy" },
      { mode: "replace" as const }]) {
      const imported = await importWorldZip({ db, file: archive, root, ...options });
      const rows = await getAllDocumentRecords(db, imported.worldId);
      const restored = (id: string): MacroDocument =>
        rows.find((row) => row.coll === "macros" && row.id === id)?.doc as MacroDocument;
      expect(restored(spellCue._id)).toEqual(spellCue);
      expect(restored(itemCue._id)).toEqual(itemCue);
      expect(restored(preset._id)).toEqual(preset);
      expect(rows.find((row) => row.coll === "actors" && row.id === actor._id)?.doc).toEqual(actor);
      const restoredAsset = (await listAssets(db, imported.worldId)).find((asset) => asset.hash === hash);
      // Import never transfers a redistribution or player-serving permission from another GM.
      expect(restoredAsset).toMatchObject({ visibility: "gm", exportRights: "restricted" });
    }
    await deleteWorldData(db, "w-fx-archive-copy");
    await deleteWorldData(db, app.worldId);
  });

  test("legacy FX media referenced by timelines and presets needs explicit export review", async () => {
    const root = new MemDirHandle();
    const app = await boot(root);
    const timelineBytes = new Uint8Array([3, 5, 8]);
    const presetBytes = new Uint8Array([13, 21, 34]);
    const unrelatedBytes = new Uint8Array([55, 89, 144]);
    const { hash: timelineHash } = await app.assets.import(
      timelineBytes, "legacy-timeline.webm", "video/webm", "referenced");
    const { hash: presetHash } = await app.assets.import(
      presetBytes, "legacy-preset.ogg", "audio/ogg", "referenced");
    const { hash: unrelatedHash } = await app.assets.import(
      unrelatedBytes, "legacy-background.png", "image/png", "referenced");
    const imageSection = { id: "legacy-video", kind: "image" as const, assetId: timelineHash,
      startMs: 0, durationMs: 800, at: { kind: "point" as const, x: 100, y: 100 } };
    const soundSection = { id: "legacy-sound", kind: "sound" as const, assetId: presetHash,
      startMs: 0, durationMs: 800 };
    const timeline: MacroDocument = { _id: "legacy-timeline", type: "macro", name: "Legacy timeline",
      ownership: { default: 0 }, flags: {}, system: {}, kind: "sequence", command: "",
      sequence: { version: 1, audience: "gm", sections: [imageSection] } };
    const preset: MacroDocument = { _id: "legacy-preset", type: "macro", name: "Legacy preset",
      ownership: { default: 0 }, flags: {}, system: {}, kind: "fxPreset", command: "",
      preset: { version: 1, sections: [soundSection] } };
    app.gm.client.submit([{ kind: "create", coll: "macros", data: timeline },
      { kind: "create", coll: "macros", data: preset }]);
    await settle();

    const exportWorld = () => exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister });
    const expectExportBlock = async (name: string, reason: string) => {
      let caught: unknown;
      try { await exportWorld(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("world-export rights");
      expect((caught as Error).message).toContain(name);
      expect((caught as Error).message).toContain(reason);
    };

    // A legacy asset has no affirmative rights fact. Both runnable timelines and
    // authoring-only presets are included in the archive and therefore need review.
    await expectExportBlock("legacy-timeline.webm", "unreviewed legacy FX media");
    await app.assets.describe(timelineHash, { exportRights: "restricted" });
    await expectExportBlock("legacy-timeline.webm", "restricted");
    await app.assets.describe(timelineHash, { exportRights: "granted" });
    await expectExportBlock("legacy-preset.ogg", "unreviewed legacy FX media");
    await app.assets.describe(presetHash, { exportRights: "granted" });

    const archive = await exportWorld();
    const files = parseZip(new Uint8Array(await archive.arrayBuffer()));
    expect(files.get(`assets/${timelineHash}`)).toEqual(timelineBytes);
    expect(files.get(`assets/${presetHash}`)).toEqual(presetBytes);
    expect((await app.assets.meta(unrelatedHash))?.exportRights).toBeUndefined();
    expect(files.get(`assets/${unrelatedHash}`)).toEqual(unrelatedBytes);
    await app.close();
    await deleteWorldData(db, app.worldId);
  });

  test("archive copies and restores keep script source but require this host to review and republish", async () => {
    const root = new MemDirHandle();
    const app = await boot(root);
    const source = "await api.chat.say('from saved script', 'gm'); return 1;";
    const settings: Omit<ScriptPolicy, "approvedHash"> = { version: 1, sceneId: DEFAULT_SCENE_ID,
      runAs: "gm", playerCallable: true, grants: ["chat"], inputs: [] };
    const macro: MacroDocument = { _id: "reviewed", type: "macro", name: "Reviewed",
      ownership: { default: 1 }, flags: { core: { playerCallable: true } }, system: {},
      kind: "script", command: source,
      script: { ...settings, approvedHash: await scriptApprovalHash(source, settings) } };
    app.gm.client.submit([{ kind: "create", coll: "macros", data: macro }]);
    await settle();
    expect(app.store.get("macros", "reviewed")).toBeDefined();
    app.host.commitSystem([{ kind: "update", ref: { coll: "macros", id: "reviewed" },
      diff: { scriptState: { recent: [{ key: "player:prior", at: 100,
        revision: macro.script?.approvedHash ?? "" }] } } }]);
    await app.persister.flush();
    const archive = await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister });
    await app.close();

    for (const options of [{ mode: "copy" as const, worldId: "w-script-copy" },
      { mode: "replace" as const }]) {
      const result = await importWorldZip({ db, file: archive, root, ...options });
      const rows = await getAllDocumentRecords(db, result.worldId);
      const restored = rows.find((row) => row.coll === "macros" && row.id === "reviewed")?.doc as MacroDocument;
      expect(restored.command).toBe(source); // GM can inspect and explicitly republish
      expect(restored.script).toMatchObject({ ...settings, playerCallable: false,
        approvedHash: "0".repeat(64) });
      expect(restored.scriptState).toEqual({ recent: [] });
      expect(restored.ownership.default).toBe(0);
      expect((restored.flags.core as Record<string, unknown>).playerCallable).toBe(false);
      expect(validateScriptMacro(restored).ok).toBe(true);
      expect(await scriptApprovalHash(restored.command, { ...settings, playerCallable: false }))
        .not.toBe(restored.script?.approvedHash); // never trusted merely for matching bundled bytes
    }
  });

  test("round-trips losslessly and acts as restore (M1 acceptance)", async () => {
    const root = new MemDirHandle();
    const app = await boot(root);
    await addToken(app, token("t-1", 100, 100));
    await addToken(app, token("t-2", 400, 300));
    const { hash } = await app.pipeline.importImage(
      new Uint8Array([1, 2, 3, 4]),
      "map.png",
      "image/png",
    );
    app.gm.client.submit([
      { kind: "update", ref: { coll: "scenes", id: DEFAULT_SCENE_ID }, diff: { img: hash } },
    ]);
    await settle();
    await app.persister.flush();

    // §8A strategic state rides along
    await putCheckpoint(db, {
      worldId: app.worldId,
      sceneId: DEFAULT_SCENE_ID,
      slot: 1,
      turnNumber: 1,
      tick: null,
      pool: new Uint8Array([9, 9, 9]),
      maxHpMax: 4,
      version: 0,
      unitStats: {},
      seed: 42,
      rulesVersion: "1.0.0",
      hash: "cp-hash",
    });
    await putReport(db, app.worldId, DEFAULT_SCENE_ID, {
      turn: 1,
      sceneId: DEFAULT_SCENE_ID,
      subPhases: ["move"],
      events: [{ subPhase: "move", type: "arrive", unitId: "u1", text: "marched" }],
      summary: { events: 1 },
      rulesVersion: "1.0.0",
    });

    // ── export at this exact point ──
    const blob = await exportWorldZip({
      db,
      worldId: app.worldId,
      root,
      persister: app.persister,
    });
    const archive = new Uint8Array(await blob.arrayBuffer());
    const files = parseZip(archive);
    const meta = JSON.parse(strFromU8(files.get("world.json") as Uint8Array)) as WorldFileMeta;
    expect(meta.format).toBe(WORLD_FILE_FORMAT);
    expect(meta.worldId).toBe(app.worldId);
    // D-248: a world on the built-in ruleset says so, and carries an (empty) package index
    expect(meta.rules).toEqual({ active: null });
    expect(meta.system).toBe("mass-battle-basic");
    expect(JSON.parse(strFromU8(files.get("packages.json") as Uint8Array))).toEqual([]);
    const documents = JSON.parse(
      strFromU8(files.get("documents.json") as Uint8Array),
    ) as WorldFileDocuments;
    expect(documents.docs.length).toBeGreaterThan(0); // gm user + scene
    // map + derived thumb/mid artifacts, each with a blob in assets/
    const assetFiles = [...files.keys()].filter((k) => k.startsWith("assets/"));
    expect(assetFiles.length).toBeGreaterThanOrEqual(3);
    const worldId = app.worldId;
    const seqAtExport = meta.seq;
    await app.close();

    // ── keep mutating AFTER the export (world drifts ahead) ──
    const drifted = await boot(root);
    expect(drifted.worldId).toBe(worldId);
    await addToken(drifted, token("t-3", 900, 900));
    drifted.gm.client.submit([
      { kind: "update", ref: { coll: "scenes", id: DEFAULT_SCENE_ID }, diff: { name: "Drifted" } },
    ]);
    await settle();
    await drifted.persister.flush();
    await drifted.close();

    // ── import = restore to the export point ──
    expect(files.get(`checkpoints/${DEFAULT_SCENE_ID}/1.pool`)).toBeDefined();
    expect(files.get(`reports/${DEFAULT_SCENE_ID}/1.json`)).toBeDefined();
    const imported = await importWorldZip({ db, file: archive, root });
    // §8A: strategic state rides in the archive and restores
    expect(
      Array.from((await latestCheckpoint(db, imported.worldId, DEFAULT_SCENE_ID))?.pool ?? []),
    ).toEqual([9, 9, 9]);
    expect(await getReport(db, imported.worldId, DEFAULT_SCENE_ID, 1)).toBeTruthy();
    expect(imported).toMatchObject({ worldId, seq: seqAtExport });

    const restored = await boot(root);
    expect(restored.worldId).toBe(worldId);
    expect(restored.store.seq).toBe(seqAtExport);
    const scene = restored.gm.client.store.get("scenes", DEFAULT_SCENE_ID);
    expect(scene?.name).toBe("Scene 1"); // post-export rename rolled back
    expect(scene?.tokens.length).toBe(2); // post-export token rolled back
    expect(scene?.tokens.map((t) => t._id).sort()).toEqual(["t-1", "t-2"]);
    expect(scene?.img).toBe(hash);

    // every exported document row survived, byte-identical semantics
    const rows = new Map(documents.docs.map((d) => [`${d.coll}/${d.id}`, d.doc]));
    for (const [key, doc] of rows) {
      const [coll, id] = key.split("/") as [string, string];
      expect(restored.store.get(coll as never, id as never)).toEqual(doc);
    }

    // assets still stream from the restored world (blobs + manifest intact)
    const bytes = await restored.gm.fetcher.request(hash, "scene");
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    await restored.persister.flush();
    await restored.close();
  });

  test("import into a database that has never seen the world", async () => {
    const root = new MemDirHandle();
    // explicit fresh world (a no-worldId boot would reopen test 1's world)
    await HostPersister.createWorld(db, {
      worldId: "w-fresh-2",
      name: "Fresh Two",
      system: "mass-battle-basic",
      systemVersion: "1.0.0",
    });
    const app = await boot(root, "w-fresh-2");
    const worldId = app.worldId;
    await addToken(app, token("t-1", 50, 50));
    await app.persister.flush();
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId, root, persister: app.persister })).arrayBuffer(),
    );
    await app.close();

    // simulate a brand-new host machine: wipe every trace of the world
    await deleteWorldData(db, worldId);
    for (const record of await listAssets(db, worldId)) {
      await deleteAsset(db, worldId, record.hash);
    }

    const imported = await importWorldZip({ db, file: archive, root: new MemDirHandle() });
    expect(imported.worldId).toBe(worldId);
    const fresh = await boot(); // no worldId → most recent = imported
    expect(fresh.worldId).toBe(worldId);
    expect(fresh.gm.client.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.length).toBe(1);
    await fresh.persister.flush();
    await fresh.close();
  });

  test("rejects corrupt archives with explicit errors", async () => {
    await expect(importWorldZip({ db, file: new Uint8Array([1, 2, 3]) })).rejects.toThrow(
      /world file/,
    );
    await expect(
      importWorldZip({ db, file: new Blob([new TextEncoder().encode("{}")]) }),
    ).rejects.toThrow(/world file/);

    // valid zip, but world.json declares an unknown format
    const bad = zipSync({
      "world.json": strToU8(JSON.stringify({ format: 99, worldId: "w-x", seq: 1 })),
    });
    await expect(importWorldZip({ db, file: bad })).rejects.toThrow(/unsupported format/);

    // valid format, but the archive is missing documents.json
    const noDocs = zipSync({
      "world.json": strToU8(
        JSON.stringify({ format: 1, worldId: "w-x", name: "n", system: "s", version: "1", seq: 1 }),
      ),
      "assets.json": strToU8("[]"),
    });
    await expect(importWorldZip({ db, file: noDocs })).rejects.toThrow(/missing documents\.json/);
  });
  /**
   * D-179 regression — the restore must win over the persister's final flush.
   *
   * §8 persistence batches document writes (~500 ms) and `HostPersister.close()`
   * runs one FINAL flush. `App.importWorld` calls `close()` and then replaces
   * every world row with the archive's, so a `close()` that returns before that
   * flush settles lets it commit AFTER the restore's delete+put: the drifted
   * scene document (tokens are embedded in it) is written back over the
   * restored one, and the rebooted world carries a token the archive never
   * contained. In the browser that surfaced as `worldfile.spec.ts` polling
   * tokenCount 2 and timing out on 3 — intermittently, only under load.
   */
  test("close() settles the final flush before a restore replaces the rows", async () => {
    const root = new MemDirHandle();
    await HostPersister.createWorld(db, {
      worldId: "w-restore-race",
      name: "Restore Race",
      system: "mass-battle-basic",
      systemVersion: "1.0.0",
    });
    const app = await boot(root, "w-restore-race");
    const worldId = app.worldId;
    await addToken(app, token("t-1", 100, 100));
    await addToken(app, token("t-2", 400, 300));
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId, root, persister: app.persister })).arrayBuffer(),
    );
    const meta = JSON.parse(
      strFromU8(parseZip(archive).get("world.json") as Uint8Array),
    ) as WorldFileMeta;

    /** The persisted scene row's token ids — the documents store, not a boot. */
    const storedTokens = async (): Promise<string[]> => {
      const rows = await getAllDocumentRecords(db, worldId);
      const scene = rows.find((r) => r.coll === "scenes" && r.id === DEFAULT_SCENE_ID);
      const doc = scene?.doc as { tokens?: Array<{ _id: string }> } | undefined;
      return (doc?.tokens ?? []).map((t) => t._id).sort();
    };

    // Drift past the export point and leave the write DIRTY: the batch has not
    // run and nothing drains it, so this is the exact window the import raced.
    await addToken(app, token("t-3", 900, 900));
    expect(await storedTokens()).toEqual(["t-1", "t-2"]);

    // The fix: close() resolves only once that last flush has committed.
    await app.close();
    expect(await storedTokens()).toEqual(["t-1", "t-2", "t-3"]);

    // Nothing is in flight now, so the restore is the last writer.
    const imported = await importWorldZip({ db, file: archive, root });
    expect(imported).toMatchObject({ worldId, seq: meta.seq });

    const restored = await boot(root, worldId);
    expect(restored.store.seq).toBe(meta.seq);
    const scene = restored.gm.client.store.get("scenes", DEFAULT_SCENE_ID);
    expect(scene?.tokens.map((t) => t._id).sort()).toEqual(["t-1", "t-2"]);
    await restored.persister.flush();
    await restored.close();
  });
});

test("named action Revert persists through a compacted checkpoint, world-file copy and host reboot", async () => {
  const db = await openVttDb();
  const root = new MemDirHandle();
  const app = await boot(root);
  const sceneId = DEFAULT_SCENE_ID;
  const tile = { _id: "history-tile", type: "tile", name: "History tile",
    ownership: { default: 0 as const }, flags: {}, system: {},
    x: 100, y: 100, width: 100, height: 100, img: "", above: false,
    occlusion: { mode: "roof" as const, alpha: 0.5 } };
  app.gm.client.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: sceneId },
    data: tile }]);
  await settle();
  app.gm.client.submit([{ kind: "create", coll: "automations", data: {
    _id: "history-graph", type: "automation", name: "Reversible history",
    ownership: { default: 0 }, flags: {}, system: {},
    definition: { version: 1, sceneId, tileId: tile._id, methods: ["manual"], steps: [
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "mark", kind: "tags", edit: "add", tags: ["action-history"] },
    ] },
  } as AutomationDocument }]);
  await settle();
  const before = app.store.seq;
  app.gm.client.requestAutomation("history-graph", sceneId, "manual");
  await settle();
  expect(app.store.seq).toBe(before + 1);
  const receipt = app.store.getAll("actionReceipts")[0];
  if (!receipt) throw new Error("action receipt missing");
  expect(receipt).toMatchObject({ status: "ready", commits: 1 });
  expect(app.store.resolve({ coll: "tiles", id: tile._id,
    parent: { coll: "scenes", id: sceneId } })?.taggerTags).toEqual(["action-history"]);
  await app.persister.checkpoint();
  const archive = await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister });
  const archiveDocuments = parseZip(new Uint8Array(await archive.arrayBuffer())).get("documents.json");
  if (!archiveDocuments) throw new Error("archive documents missing");
  const docs = JSON.parse(strFromU8(archiveDocuments)) as WorldFileDocuments;
  expect(docs.docs.some((entry) => entry.coll === "actionReceipts" && entry.id === receipt?._id)).toBe(true);
  const worldId = app.worldId;
  await app.close();
  const copied = await importWorldZip({ db, file: archive, root, mode: "copy",
    worldId: `w-action-copy-${Date.now()}` });
  for (const id of [worldId, copied.worldId]) {
    const reopened = await boot(root, id);
    expect(reopened.store.getAll("actionReceipts")[0]?.inverses).toEqual(receipt?.inverses);
    reopened.gm.client.actionRevert(receipt._id);
    await settle();
    expect(reopened.store.getAll("actionReceipts")[0]?.status).toBe("reverted");
    expect(reopened.store.resolve({ coll: "tiles", id: tile._id,
      parent: { coll: "scenes", id: sceneId } })?.taggerTags).toBeUndefined();
    expect(reopened.store.get("automations", "history-graph")?.state).toBeUndefined();
    await reopened.close();
  }
  await deleteWorldData(db, copied.worldId);
  await deleteWorldData(db, worldId);
  db.close();
});
