/**
 * D-248 — world.zip format 2 is self-contained: the §12 strategic ruleset and content packs
 * a world was built on ride in the archive with the pin that selects them, so a shared world
 * boots the SAME rules on another machine. The mixed-scene fixture is the point of the
 * exercise: one tactical scene (heroes only) and one strategic scene (heroes + units) under a
 * package ruleset, exported, wiped, imported elsewhere, rebooted.
 */
import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, test } from "vitest";
import {
  deletePackage,
  deleteWorldData,
  getWorld,
  listPackages,
  openVttDb,
  putPackage,
} from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import {
  exportWorldToFolder,
  exportWorldZip,
  importWorldZip,
  WORLD_FILE_FORMAT,
  type WorldFileMeta,
  type WorldFilePackage,
} from "../../src/host/worldFile";
import { bootHostApp, DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import { FakeCodec, settle } from "../app/fakes";
import { HostPersister } from "../../src/storage/persistence";
import { latestCheckpoint, putCheckpoint } from "../../src/storage/strategicStore";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { sceneIsStrategic } from "../../src/core/strategicFog";
import type { SceneDocument, TokenDocument } from "../../src/core/documents";
import type { ArmyDocument, FactionDocument } from "../../src/core/strategic";

// ─── fixtures ─────────────────────────────────────────────────────────────────

/** A rules module the InlineSimRunner accepts (same shape as packageLoader.test.ts). */
const RULES_JS =
  "export default { schema: { version: '2.0.0', modelColumns: { ammo: 'u8', morale: 'f32' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] }, validateOrder(){ return {ok:true}; }, resolveTurn(){}, detection(){ return 5; } };";

const RULESET_MANIFEST = {
  id: "probe-rules",
  name: "Probe Strategic Rules",
  version: "2.0.0",
  type: "system",
  dependencies: ["probe-content"],
  rules: { entry: "rules.js", modelColumns: { ammo: "u8", morale: "f32" } },
};

const CONTENT_MANIFEST = {
  id: "probe-content",
  name: "Probe Content",
  version: "1.1.0",
  type: "data",
  packs: [{ name: "Probe Bestiary", type: "actors", file: "packs/bestiary.json" }],
};

const BESTIARY = {
  name: "Probe Bestiary",
  type: "actors",
  entries: [
    { id: "goblin", name: "Goblin", data: { type: "actor", name: "Goblin", system: {} } },
  ],
};

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const rulesetZip = (): Uint8Array =>
  zipOf({ "manifest.json": JSON.stringify(RULESET_MANIFEST), "rules.js": RULES_JS });
const contentZip = (): Uint8Array =>
  zipOf({
    "manifest.json": JSON.stringify(CONTENT_MANIFEST),
    "packs/bestiary.json": JSON.stringify(BESTIARY),
  });

const heroToken = (id: string, x: number, y: number): TokenDocument => ({
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
  disposition: "friendly",
  vision: true,
  light: { radius: 0, color: "#fff", alpha: 0.5 },
});

const bootWorld = async (worldId: string, root: MemDirHandle): Promise<HostApp> =>
  bootHostApp({
    db: await openVttDb(),
    root,
    codec: new FakeCodec(),
    simRunner: new InlineSimRunner(),
    worldId: worldId as HostApp["worldId"],
  });

const parseZip = (bytes: Uint8Array): Map<string, Uint8Array> =>
  new Map(Object.entries(unzipSync(bytes)));

/**
 * The mixed world: scene-1 flagged strategic with a faction + army (heroes AND units),
 * scene-2 tactical with two hero tokens, both packages imported, the ruleset active, and one
 * checkpoint on the strategic scene so the ruleset pin is a live constraint.
 */
async function buildMixedWorld(worldId: string, root: MemDirHandle): Promise<HostApp> {
  const db = await openVttDb();
  await HostPersister.createWorld(db, {
    worldId: worldId as HostApp["worldId"],
    name: "Mixed Campaign",
    system: "mass-battle-basic",
    systemVersion: "1.0.0",
  });
  const app = await bootWorld(worldId, root);
  const client = app.gm.client;

  // scene-1 → strategic (heroes + units); scene-2 → tactical (heroes only)
  const scene1 = client.store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument;
  const tacticalScene: SceneDocument = {
    ...scene1,
    _id: "scene-tactical",
    name: "Tavern Brawl",
    active: false,
    flags: { core: { scale: "tactical" } },
    tokens: [],
  };
  const faction: FactionDocument = {
    _id: "f-red",
    type: "faction",
    name: "Red",
    ownership: { default: 0, gm: 3 },
    flags: {},
    system: {},
    color: "#c33",
    allies: [],
  };
  const army: ArmyDocument = {
    _id: "a-red-1",
    type: "army",
    name: "Red Host",
    ownership: { default: 0, gm: 3 },
    flags: {},
    system: {},
    factionId: "f-red",
    commander: [],
    supply: {},
    units: [
      {
        _id: "u-1",
        type: "infantry",
        name: "Spears",
        ownership: { default: 0, gm: 3 },
        flags: {},
        system: {},
        profile: {},
        formation: "line",
        sceneId: DEFAULT_SCENE_ID,
        modelRange: null,
        orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
        stats: { strength: 40, morale: 5, fatigue: 0, supply: 10 },
      },
    ],
  };
  client.submit([
    {
      kind: "update",
      ref: { coll: "scenes", id: DEFAULT_SCENE_ID },
      diff: { flags: { core: { scale: "strategic" } } },
    },
    { kind: "create", coll: "scenes", data: tacticalScene },
    { kind: "create", coll: "factions", data: faction },
    { kind: "create", coll: "armies", data: army },
  ]);
  await settle();
  // tokens in a second envelope: their parent scene must exist when they are validated
  client.submit([
    {
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: DEFAULT_SCENE_ID },
      data: heroToken("hero-general", 150, 150),
    },
    {
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: "scene-tactical" },
      data: heroToken("hero-rogue", 100, 100),
    },
    {
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: "scene-tactical" },
      data: heroToken("hero-cleric", 300, 100),
    },
  ]);
  await settle();

  expect((await app.packages.importZip(contentZip())).ok).toBe(true);
  expect((await app.packages.importZip(rulesetZip())).ok).toBe(true);
  const activated = await app.packages.activate("probe-rules");
  expect(activated).toEqual({ ok: true }); // dependency present → no warning

  // a resolved turn on the strategic scene: the pin now holds (§5A)
  await putCheckpoint(db, {
    worldId: app.worldId,
    sceneId: DEFAULT_SCENE_ID,
    slot: 1,
    turnNumber: 1,
    tick: null,
    pool: new Uint8Array([7, 7, 7]),
    maxHpMax: 4,
    version: 0,
    unitStats: {},
    seed: 42,
    rulesVersion: "2.0.0",
    hash: "cp-hash",
  });
  await app.persister.flush();
  return app;
}

describe("world.zip format 2 — the ruleset and content travel with the world (D-248)", () => {
  let db: Awaited<ReturnType<typeof openVttDb>>;

  beforeEach(async () => {
    db = await openVttDb();
  });

  test("mixed tactical + strategic world: export → wipe → import elsewhere → same rules boot", async () => {
    const root = new MemDirHandle();
    const app = await buildMixedWorld("w-mixed", root);
    const worldId = app.worldId;

    // The record names the ruleset it runs (Phase 0): no more "mass-battle-basic v2.0.0".
    const before = await getWorld(db, worldId);
    expect(before?.system).toBe("probe-rules");
    expect(before?.version).toBe("2.0.0");
    expect(before?.activeRulesPackage).toBe("probe-rules");

    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId, root, persister: app.persister })).arrayBuffer(),
    );
    await app.close();

    // ── archive shape ──
    const files = parseZip(archive);
    const meta = JSON.parse(strFromU8(files.get("world.json") as Uint8Array)) as WorldFileMeta;
    expect(meta.format).toBe(WORLD_FILE_FORMAT);
    expect(meta.rules).toEqual({ active: "probe-rules" });
    expect(meta.system).toBe("probe-rules");
    const index = JSON.parse(
      strFromU8(files.get("packages.json") as Uint8Array),
    ) as WorldFilePackage[];
    expect(index.map((p) => [p.id, p.type, p.packCount])).toEqual([
      ["probe-content", "data", 1],
      ["probe-rules", "system", 0],
    ]);
    expect(strFromU8(files.get("packages/probe-rules/rules.js") as Uint8Array)).toBe(RULES_JS);
    expect(files.get("packages/probe-rules/manifest.json")).toBeDefined();
    expect(files.get("packages/probe-content/packs/bestiary.json")).toBeDefined();
    expect(files.get(`checkpoints/${DEFAULT_SCENE_ID}/1.pool`)).toBeDefined();
    // trust is local consent (D-089): never in the archive
    expect(JSON.stringify(meta)).not.toContain("trusted");

    // ── "another GM's machine": no trace of the world or its packages ──
    await deleteWorldData(db, worldId);
    for (const p of await listPackages(db, worldId)) await deletePackage(db, worldId, p.id);
    expect(await listPackages(db, worldId)).toEqual([]);

    const imported = await importWorldZip({ db, file: archive, root: new MemDirHandle() });
    expect(imported).toMatchObject({
      worldId,
      format: 2,
      packages: ["probe-content", "probe-rules"],
      activeRulesPackage: "probe-rules",
    });
    const restoredRec = await getWorld(db, worldId);
    expect(restoredRec?.activeRulesPackage).toBe("probe-rules");
    expect(restoredRec?.system).toBe("probe-rules");
    expect(restoredRec?.trustedPackages).toBeUndefined();
    const restoredPkgs = await listPackages(db, worldId);
    expect(restoredPkgs.map((p) => p.id)).toEqual(["probe-content", "probe-rules"]);
    expect(restoredPkgs.find((p) => p.id === "probe-rules")?.files["rules.js"]).toBe(RULES_JS);

    // ── reboot: the package takes the SimWorker rules slot, both scene kinds intact ──
    const rebooted = await bootWorld(worldId, new MemDirHandle());
    expect(rebooted.rulesBoot).toEqual({
      source: "package",
      packageId: "probe-rules",
      version: "2.0.0",
      error: null,
    });
    const store = rebooted.gm.client.store;
    const strategic = store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument;
    const tactical = store.get("scenes", "scene-tactical") as SceneDocument;
    expect(sceneIsStrategic(strategic)).toBe(true);
    expect(sceneIsStrategic(tactical)).toBe(false);
    expect(strategic.tokens.map((t) => t._id)).toEqual(["hero-general"]); // a hero on the field
    expect(tactical.tokens.map((t) => t._id).sort()).toEqual(["hero-cleric", "hero-rogue"]);
    expect((store.get("armies", "a-red-1") as ArmyDocument).units[0]?.stats.strength).toBe(40);
    expect(store.get("factions", "f-red")?.name).toBe("Red");
    // strategic state and the pin survived: the checkpoint is back and the ruleset is locked
    expect(
      Array.from((await latestCheckpoint(db, worldId, DEFAULT_SCENE_ID))?.pool ?? []),
    ).toEqual([7, 7, 7]);
    const swap = await rebooted.packages.deactivate();
    expect(swap.ok).toBe(false);
    if (!swap.ok) expect(swap.error).toContain("pinned");
    // the content pack is indexed again as compendia
    const packs = await rebooted.packages.compendia();
    expect(packs.map((p) => `${p.packageId}:${p.pack.name}`)).toEqual([
      "probe-content:Probe Bestiary",
    ]);
    const rows = await rebooted.packages.list();
    expect(rows.find((r) => r.id === "probe-rules")).toMatchObject({
      active: true,
      dependencies: ["probe-content"],
      missingDependencies: [],
    });
    await rebooted.persister.flush();
    await rebooted.close();
  }, 20_000);

  test("format 1 archives still import and do not disturb the local packages", async () => {
    const root = new MemDirHandle();
    const app = await buildMixedWorld("w-legacy", root);
    const worldId = app.worldId;
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId, root, persister: app.persister })).arrayBuffer(),
    );
    await app.close();

    // Downgrade the archive to what a pre-D-248 build wrote: format 1, no packages.
    const files = unzipSync(archive);
    const meta = JSON.parse(strFromU8(files["world.json"] as Uint8Array)) as WorldFileMeta;
    const legacy: Record<string, Uint8Array> = {};
    for (const [path, bytes] of Object.entries(files)) {
      if (path === "packages.json" || path.startsWith("packages/")) continue;
      legacy[path] = bytes;
    }
    const rest: Partial<WorldFileMeta> = { ...meta };
    delete rest.rules;
    legacy["world.json"] = strToU8(
      JSON.stringify({ ...rest, format: 1, system: "mass-battle-basic" }),
    );
    const legacyArchive = zipSync(legacy);

    const imported = await importWorldZip({ db, file: legacyArchive, root });
    expect(imported).toMatchObject({ worldId, format: 1, packages: [] });
    // the local packages and the local activation are kept — the archive has no say
    expect(imported.activeRulesPackage).toBe("probe-rules");
    expect((await listPackages(db, worldId)).map((p) => p.id)).toEqual([
      "probe-content",
      "probe-rules",
    ]);
    const rec = await getWorld(db, worldId);
    expect(rec?.activeRulesPackage).toBe("probe-rules");
    expect(rec?.system).toBe("probe-rules");

    const rebooted = await bootWorld(worldId, root);
    expect(rebooted.rulesBoot.source).toBe("package");
    await rebooted.persister.flush();
    await rebooted.close();
  }, 20_000);

  test("a restore keeps this browser's trust grants and ignores any the archive claims", async () => {
    const root = new MemDirHandle();
    const worldId = "w-trust";
    await HostPersister.createWorld(db, {
      worldId: worldId as HostApp["worldId"],
      name: "Trust",
      system: "mass-battle-basic",
      systemVersion: "1.0.0",
    });
    const app = await bootWorld(worldId, root);
    const trusting = zipOf({
      "manifest.json": JSON.stringify({
        ...RULESET_MANIFEST,
        id: "trusting-rules",
        name: "Trusting",
        dependencies: undefined,
        module: { entry: "module.js", trusted: true },
      }),
      "rules.js": RULES_JS,
      "module.js": "globalThis.__probe = 1;",
    });
    expect((await app.packages.importZip(trusting)).ok).toBe(true);
    expect((await app.packages.activate("trusting-rules")).ok).toBe(true);
    expect((await app.packages.grantTrust("trusting-rules")).ok).toBe(true);
    await app.persister.flush();
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId, root, persister: app.persister })).arrayBuffer(),
    );
    await app.close();

    // Forge an archive that claims trust the way a stranger's zip might.
    const files = unzipSync(archive);
    const meta = JSON.parse(strFromU8(files["world.json"] as Uint8Array)) as Record<string, unknown>;
    files["world.json"] = strToU8(JSON.stringify({ ...meta, trustedPackages: ["trusting-rules"] }));
    const forged = zipSync(files);

    // Same browser, restore: the grant this GM made locally survives (it is not from the archive).
    await importWorldZip({ db, file: forged, root });
    expect((await getWorld(db, worldId))?.trustedPackages).toEqual(["trusting-rules"]);

    // A browser that never granted anything: the claim in the archive is ignored.
    await deleteWorldData(db, worldId);
    await deletePackage(db, worldId, "trusting-rules");
    await importWorldZip({ db, file: forged, root: new MemDirHandle() });
    const fresh = await getWorld(db, worldId);
    expect(fresh?.trustedPackages).toBeUndefined();
    expect(fresh?.activeRulesPackage).toBe("trusting-rules");
    const rebooted = await bootWorld(worldId, new MemDirHandle());
    expect(rebooted.moduleBoot?.mode).toBe("iframe"); // sandboxed until THIS GM grants
    await rebooted.persister.flush();
    await rebooted.close();
  }, 20_000);

  test("an archive whose embedded package would not import as a zip is refused whole", async () => {
    const root = new MemDirHandle();
    const app = await buildMixedWorld("w-corrupt", root);
    const worldId = app.worldId;
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId, root, persister: app.persister })).arrayBuffer(),
    );
    await app.close();
    const files = unzipSync(archive);

    // 1. the ruleset's entry file is gone → the loader's own message, prefixed
    const noEntry = { ...files };
    delete noEntry["packages/probe-rules/rules.js"];
    await expect(importWorldZip({ db, file: zipSync(noEntry), root })).rejects.toThrow(
      /world file: package probe-rules: .*rules entry rules\.js is missing/,
    );

    // 2. the pin names a package the archive does not carry
    const meta = JSON.parse(strFromU8(files["world.json"] as Uint8Array)) as WorldFileMeta;
    const dangling = {
      ...files,
      "world.json": strToU8(JSON.stringify({ ...meta, rules: { active: "ghost-rules" } })),
    };
    await expect(importWorldZip({ db, file: zipSync(dangling), root })).rejects.toThrow(
      /rules\.active names ghost-rules/,
    );

    // 3. the pin names a content pack
    const wrongKind = {
      ...files,
      "world.json": strToU8(JSON.stringify({ ...meta, rules: { active: "probe-content" } })),
    };
    await expect(importWorldZip({ db, file: zipSync(wrongKind), root })).rejects.toThrow(
      /content pack, not a ruleset/,
    );

    // nothing above touched the database: the world is exactly as exported
    expect((await getWorld(db, worldId))?.activeRulesPackage).toBe("probe-rules");
    expect((await listPackages(db, worldId)).length).toBe(2);
  }, 20_000);

  test("save-to-folder writes the same tree as the zip, packages included", async () => {
    const root = new MemDirHandle();
    const app = await buildMixedWorld("w-folder", root);
    const worldId = app.worldId;
    const zipFiles = parseZip(
      new Uint8Array(
        await (
          await exportWorldZip({ db, worldId, root, persister: app.persister })
        ).arrayBuffer(),
      ),
    );
    const dir = new MemDirHandle();
    const { filesCount } = await exportWorldToFolder({ db, worldId, root, persister: app.persister }, dir);
    await app.close();

    const walk = (d: MemDirHandle, prefix: string, out: string[]): string[] => {
      for (const name of d.files.keys()) out.push(prefix + name);
      for (const [name, sub] of d.dirs) walk(sub, `${prefix}${name}/`, out);
      return out;
    };
    const folderPaths = walk(dir, "", []).sort();
    expect(folderPaths.length).toBe(filesCount);
    expect(folderPaths).toEqual([...zipFiles.keys()].sort());
    expect(folderPaths).toContain("packages/probe-rules/rules.js");
    expect(folderPaths).toContain("packages/probe-content/packs/bestiary.json");
  }, 20_000);

  test("export never claims a ruleset it does not carry", async () => {
    const root = new MemDirHandle();
    const worldId = "w-dangling";
    await HostPersister.createWorld(db, {
      worldId: worldId as HostApp["worldId"],
      name: "Dangling",
      system: "mass-battle-basic",
      systemVersion: "1.0.0",
    });
    const app = await bootWorld(worldId, root);
    expect((await app.packages.importZip(rulesetZip())).ok).toBe(true);
    expect((await app.packages.activate("probe-rules")).ok).toBe(true);
    await app.persister.flush();
    // the record disappears underneath the activation (a deleted/failed import)
    await deletePackage(db, worldId, "probe-rules");
    const files = parseZip(
      new Uint8Array(
        await (
          await exportWorldZip({ db, worldId, root, persister: app.persister })
        ).arrayBuffer(),
      ),
    );
    await app.close();
    const meta = JSON.parse(strFromU8(files.get("world.json") as Uint8Array)) as WorldFileMeta;
    expect(meta.rules).toEqual({ active: null });
    expect(meta.system).toBe("mass-battle-basic");
    // …and such an archive imports on the built-in ruleset without error
    await deleteWorldData(db, worldId);
    const imported = await importWorldZip({ db, file: zipSync(Object.fromEntries(files)), root });
    expect(imported.activeRulesPackage).toBeNull();
  }, 20_000);
});

describe("package records survive putPackage/listPackages ordering used by the archive", () => {
  test("index order is id order (deterministic archives)", async () => {
    const db = await openVttDb();
    const worldId = "w-order" as HostApp["worldId"];
    for (const id of ["zeta", "alpha", "mid"]) {
      await putPackage(db, {
        worldId,
        id,
        name: id,
        version: "1.0.0",
        type: "data",
        importedAt: 1,
        manifest: { id, name: id, version: "1.0.0", type: "data" },
        files: { "manifest.json": "{}" },
      });
    }
    expect((await listPackages(db, worldId)).map((p) => p.id)).toEqual(["alpha", "mid", "zeta"]);
  });
});
