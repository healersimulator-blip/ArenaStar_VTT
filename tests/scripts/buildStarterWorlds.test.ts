/**
 * D-249 — starter worlds from the build (`scripts/buildStarterWorlds.mjs`).
 *
 * The writer is plain JS, so parity with the TS reader is proven here rather than by sharing
 * code: the emitted `pf1e-mass-battles-starter-<v>.zip` is sniffed as a starter, imported as a
 * copy through the real `importWorldZip`, booted by the real `bootHostApp`, and the PF1e ruleset
 * (not the built-in one) answers from the sim. A second import yields a second, independent world.
 *
 * The package build runs once for the file (a vite build in a subprocess, ~2 s) into a temp
 * staging dir, so the source tree is never mutated.
 */
import "fake-indexeddb/auto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bootHostApp, DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import { searchCompendia } from "../../src/core/compendium";
import { buildCompendiumIndex, searchIndex } from "../../src/core/compendiumIndex";
import {
  cellAtPoint,
  cellCenterOf,
  cellsInMap,
  cellsOf,
} from "../../src/core/hexcrawl/cells";
import { PF1E_TERRAIN_CATALOG } from "../../src/core/hexcrawl/terrain";
import { validateEncounterTable } from "../../src/core/hexcrawl/tables";
import { hexcrawlProfileOf, isHexcrawlScene } from "../../src/core/hexcrawl/types";
import { importWorldZip, type WorldFileMeta } from "../../src/host/worldFile";
import { classifyZip, describeWorldContents } from "../../src/host/zipKind";
import { getWorld, listPackages, listWorlds, openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec } from "../app/fakes";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const stage = mkdtempSync(join(tmpdir(), "starter-worlds-"));
const systemsDir = join(stage, "systems");
const worldsDir = join(stage, "worlds");

interface BuiltStarter {
  id: string;
  worldId: string;
  name: string;
  version: string;
  packages: string[];
  files: string[];
  zip: string | null;
}

let built: BuiltStarter[] = [];

beforeAll(async () => {
  execFileSync(
    process.execPath,
    [join(repoRoot, "scripts/buildSystemPackages.mjs"), "--out", systemsDir, "--zip-dir", join(stage, "pkgs")],
    { cwd: repoRoot, encoding: "utf8", timeout: 120_000, stdio: "pipe" },
  );
  const mod = (await import(
    /* @vite-ignore */ join(repoRoot, "scripts/buildStarterWorlds.mjs")
  )) as { buildStarterWorlds: (o: object) => Promise<BuiltStarter[]> };
  built = await mod.buildStarterWorlds({ systemsDir, outDir: worldsDir });
}, 120_000);

afterAll(() => {
  rmSync(stage, { recursive: true, force: true });
});

const starterOf = (id: string): BuiltStarter => {
  const s = built.find((b) => b.id === id);
  if (!s?.zip) throw new Error(`no starter built for ${id}`);
  return s;
};

describe("scripts/buildStarterWorlds.mjs", () => {
  test("emits one starter per strategic ruleset, named after it, carrying its content dependencies", () => {
    expect(built.map((b) => b.id)).toEqual(["pf1e-mass-battles"]);
    const s = starterOf("pf1e-mass-battles");
    expect(s.zip).toMatch(/worlds\/pf1e-mass-battles-starter-1\.0\.0\.zip$/);
    expect(s.worldId).toBe("starter-pf1e-mass-battles");
    expect(s.packages).toEqual(["pf1e-mass-battles", "pf1e-core"]);
    const entries = unzipSync(new Uint8Array(readFileSync(s.zip as string)));
    const header = JSON.parse(strFromU8(entries["world.json"] as Uint8Array)) as WorldFileMeta;
    expect(header).toMatchObject({
      format: 2,
      worldId: "starter-pf1e-mass-battles",
      system: "pf1e-mass-battles",
      version: "1.0.0",
      seq: 17,
      rules: { active: "pf1e-mass-battles" },
      starter: true,
    });
    const starterDocuments = JSON.parse(strFromU8(entries["documents.json"] as Uint8Array)) as { seq: number; docs: unknown[] };
    expect(starterDocuments.seq).toBe(17);
    expect(starterDocuments.docs).toHaveLength(17);
    expect(Object.keys(entries)).toEqual(expect.arrayContaining([
      "packages/pf1e-mass-battles/manifest.json",
      "packages/pf1e-mass-battles/rules.js",
      "packages/pf1e-core/manifest.json",
      "packages/pf1e-core/packs/bestiary.json",
    ]));
  });

  test("is deterministic: the same tree builds byte-identical archives", async () => {
    const mod = (await import(
      /* @vite-ignore */ join(repoRoot, "scripts/buildStarterWorlds.mjs")
    )) as { buildStarterArchive: (dir: string, id: string) => { zip: Uint8Array } };
    const a = mod.buildStarterArchive(systemsDir, "pf1e-mass-battles").zip;
    const b = mod.buildStarterArchive(systemsDir, "pf1e-mass-battles").zip;
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(a).equals(readFileSync(starterOf("pf1e-mass-battles").zip as string))).toBe(true);
  });

  test("the start screen's sniff names it as a starter with its ruleset and content", async () => {
    const bytes = new Uint8Array(readFileSync(starterOf("pf1e-mass-battles").zip as string));
    const info = await classifyZip(bytes);
    expect(info).toMatchObject({
      kind: "world",
      starter: true,
      name: "Pathfinder 1e Mass Battles — starter",
      activeRules: "pf1e-mass-battles",
    });
    if (info.kind === "world") {
      expect(describeWorldContents(info)).toBe(
        "strategic ruleset Pathfinder 1e Mass Battles Engine v1.0.0 · content pack Pathfinder 1e Core",
      );
    }
  });

  test("imports as a copy through the real reader, boots on the PF1e ruleset, and imports again as a second world", async () => {
    const bytes = new Uint8Array(readFileSync(starterOf("pf1e-mass-battles").zip as string));
    const db = await openVttDb();
    const root = new MemDirHandle();

    const first = await importWorldZip({ db, file: bytes, root, mode: "copy", name: "Kingmaker" });
    expect(first.mode).toBe("copy");
    expect(first.packages.sort()).toEqual(["pf1e-core", "pf1e-mass-battles"]);
    expect(first.activeRulesPackage).toBe("pf1e-mass-battles");
    expect(await getWorld(db, "starter-pf1e-mass-battles" as HostApp["worldId"])).toBeUndefined();

    const app = await bootHostApp({
      db,
      root,
      codec: new FakeCodec(),
      simRunner: new InlineSimRunner(),
      worldId: first.worldId,
    });
    try {
      expect(app.meta.name).toBe("Kingmaker");
      expect(app.rulesBoot).toMatchObject({ source: "package", packageId: "pf1e-mass-battles", error: null });
      // seq 0 → the host seeded the world like a brand-new one: default scene, tactical by default
      const scene = app.gm.client.store.get("scenes", DEFAULT_SCENE_ID) as
        | { flags?: { core?: { scale?: string } } }
        | undefined;
      expect(scene).toBeDefined();
      expect(scene?.flags?.core?.scale ?? "tactical").toBe("tactical");
      // the content pack is installed beside the ruleset and no dependency is missing
      const pkgs = await app.packages.list();
      expect(pkgs.map((p) => [p.id, p.active, p.missingDependencies.length])).toEqual(
        expect.arrayContaining([
          ["pf1e-mass-battles", true, 0],
          ["pf1e-core", false, 0],
        ]),
      );
      expect((await listPackages(db, first.worldId)).length).toBe(2);

      // ── G-45: the starter world's own compendium, through the reader's index ──────
      // The starter ships `pf1e-core` alone (5 packs, 162 hand-authored entries). Its shapes are
      // NOT the converter's: spells state a school and no `spell` keyword, the equipment pack
      // authors `table` as a string key with rows as an *object*, and the bestiary/classes packs
      // are the only actors. This is the check that the reader is not tuned to one producer.
      const starterCompendia = await app.packages.compendia();
      expect(starterCompendia.map((c) => c.pack.name).sort()).toEqual([
        "PF1e Bestiary",
        "PF1e Classes",
        "PF1e Equipment",
        "PF1e Feats",
        "PF1e Spells",
      ]);
      const starterIndex = buildCompendiumIndex(starterCompendia.map((c) => c.pack));
      expect(starterIndex.counts).toEqual({ packs: 5, entries: 162 });
      const starterKinds = new Map<string, number>();
      for (const e of starterIndex.entries) {
        starterKinds.set(e.facets.kind, (starterKinds.get(e.facets.kind) ?? 0) + 1);
      }
      expect(Object.fromEntries([...starterKinds.entries()].sort((a, b) => b[1] - a[1]))).toEqual({
        Spell: 75, // PF1e Spells — school stated, no `spell` keyword
        Creature: 40, // PF1e Bestiary — `system.pf1e`
        Feat: 33, // PF1e Feats — `feat` keyword + a feat category
        Table: 8, // PF1e Equipment — `table` string + rows object
        Class: 6, // PF1e Classes — `hd` + `babProgression`
      });
      // Levels and schools come from the core spell pack's own records.
      expect(starterIndex.facetOptions.levels.map((o) => o.value)).toEqual(
        expect.arrayContaining(["0", "1", "3", "9"]),
      );
      expect(starterIndex.facetOptions.schools.map((o) => o.value)).toContain("Evocation");
      const fireball = searchIndex(starterIndex, "fireball", { limit: 10 })[0];
      expect(fireball?.entry.name).toBe("Fireball");
      expect(fireball?.facets).toMatchObject({ kind: "Spell", school: "Evocation", level: 3 });
      const table = searchIndex(starterIndex, "unarmed strike damage", { limit: 10 })[0];
      expect(table?.facets.kind).toBe("Table");
      expect(table?.facets.level).toBeNull();
      // and the reference search still agrees with the index on this corpus
      for (const q of ["fireball", "goblin", "power", "e"]) {
        const packs = starterCompendia.map((c) => c.pack);
        expect(
          searchIndex(starterIndex, q, { limit: 50 }).map((h) => `${h.pack.name}:${h.entry.id}:${h.score}`),
          `query "${q}"`,
        ).toEqual(
          searchCompendia(packs, q, 50).map((h) => `${h.pack.name}:${h.entry.id}:${h.score}`),
        );
      }
      await app.persister.flush();
    } finally {
      await app.close();
    }

    const second = await importWorldZip({ db, file: bytes, root, mode: "copy" });
    expect(second.worldId).not.toBe(first.worldId);
    expect(second.name).toBe("Pathfinder 1e Mass Battles — starter");
    const ids = (await listWorlds(db)).map((w) => w.worldId);
    expect(ids).toEqual(expect.arrayContaining([first.worldId, second.worldId]));
  }, 30_000);

  test("CLI: --dry-run lists without writing; a missing rules.js is a build error, not a GM error", () => {
    const out = execFileSync(
      process.execPath,
      [join(repoRoot, "scripts/buildStarterWorlds.mjs"), "--systems-dir", systemsDir, "--out", join(stage, "dry"), "--content-dir", join(stage, "no-content"), "--dry-run"],
      { cwd: repoRoot, encoding: "utf8", timeout: 60_000, stdio: "pipe" },
    );
    expect(out).toBe(""); // dry-run logs nothing and writes nothing
    // the unbuilt source tree has no systems/pf1e-mass-battles/rules.js unless build:systems ran;
    // point the script at a folder whose ruleset lacks its entry to see the guard fire
    const broken = join(stage, "broken");
    execFileSync("cp", ["-r", systemsDir, broken]);
    rmSync(join(broken, "pf1e-mass-battles", "rules.js"), { force: true });
    let error = "";
    try {
      execFileSync(
        process.execPath,
        [join(repoRoot, "scripts/buildStarterWorlds.mjs"), "--systems-dir", broken, "--out", join(stage, "broken-out")],
        { cwd: repoRoot, encoding: "utf8", timeout: 60_000, stdio: "pipe" },
      );
    } catch (e) {
      error = String((e as { stderr?: string }).stderr ?? e);
    }
    expect(error).toMatch(/rules\.entry "rules\.js" — missing/);
    expect(error).toMatch(/build:systems/);
  }, 60_000);
});

// ─── tester starter: rulesets + converted content + pre-placed scenario ───────

/**
 * The tester starter bundles the mass-battles ruleset (active) + pf1e-core + the converted
 * PF1e content package, with 17 pre-placed documents (a tactical skirmish, a strategic
 * battle with two armies, an overland hexcrawl, and a tester guide). The content package here
 * is a SMALL fixture
 * shaped like the real `dist/content/pf1e` (the real one is 58 MB / 25 k entries — the
 * conversion itself is covered by tests/scripts/contentConverter.test.ts).
 */
describe("tester starter (buildStarterWorlds with contentDir)", () => {
  const contentDir = join(stage, "content/pf1e");
  const testerOut = join(stage, "tester-worlds");
  let tester: BuiltStarter | undefined;

  beforeAll(async () => {
    mkdirSync(join(contentDir, "packs"), { recursive: true });
    writeFileSync(
      join(contentDir, "manifest.json"),
      JSON.stringify({
        id: "pf1e-content",
        name: "Pathfinder 1e Content (Foundry transfer)",
        version: "1.0.0",
        type: "data",
        packs: [{ name: "PF1e Basic NPCs", type: "actors", file: "packs/basic-npcs.json" }],
      }),
    );
    writeFileSync(
      join(contentDir, "packs/basic-npcs.json"),
      JSON.stringify({
        name: "PF1e Basic NPCs",
        type: "actors",
        entries: [
          {
            id: "goblin",
            name: "Goblin",
            data: {
              type: "actor",
              name: "Goblin",
              system: {
                pf1e: {
                  // str 15 on purpose: the fallback goblin is str 13, so asserting 15
                  // proves the actor was read from the converted pack, not the fallback
                  size: "Small",
                  speedFt: 30,
                  abilities: { str: 15, dex: 11, con: 12, int: 10, wis: 9, cha: 8 },
                  hp: 4,
                  hpMax: 4,
                  saves: { fort: 1, ref: 1, will: 0 },
                  savesAsTotal: true,
                },
              },
              items: [],
              effects: [],
            },
          },
        ],
      }),
    );
    writeFileSync(join(contentDir, "OGL.txt"), "OGL 1.0a (stub for the test)\n");
    const mod = (await import(
      /* @vite-ignore */ join(repoRoot, "scripts/buildStarterWorlds.mjs")
    )) as { buildStarterWorlds: (o: object) => Promise<BuiltStarter[]> };
    const built = await mod.buildStarterWorlds({ systemsDir, outDir: testerOut, contentDir });
    tester = built.find((b) => b.id === "pf1e-mass-battles-tester");
  }, 120_000);

  test("builds the plain starter PLUS the tester with three packages and 17 documents", () => {
    expect(tester).toBeDefined();
    if (!tester?.zip) throw new Error("tester starter not built");
    expect(tester.name).toBe("Pathfinder 1e Mass Battles — tester");
    expect(tester.worldId).toBe("starter-pf1e-mass-battles-tester");
    expect(tester.packages).toEqual(["pf1e-mass-battles", "pf1e-core", "pf1e-content"]);
    expect(tester.zip).toMatch(/tester-worlds\/pf1e-mass-battles-tester-1\.0\.0\.zip$/);

    const entries = unzipSync(new Uint8Array(readFileSync(tester.zip)));
    const header = JSON.parse(strFromU8(entries["world.json"] as Uint8Array)) as WorldFileMeta;
    expect(header).toMatchObject({
      format: 2,
      worldId: "starter-pf1e-mass-battles-tester",
      system: "pf1e-mass-battles",
      seq: 17,
      rules: { active: "pf1e-mass-battles" },
      starter: true,
    });
    interface DocRow {
      coll: string;
      id: string;
      doc: Record<string, unknown>;
    }
    interface TesterScene {
      flags: { core?: { scale?: string } };
      tokens: { actorId: string }[];
      notes: { linkedSceneId?: string }[];
    }
    interface TesterPf1e {
      baseAttack?: number;
      abilities?: Record<string, number>;
      savesAsTotal?: boolean;
      attacks?: { name: string; damageDice: string; critThreatMin: number }[];
    }
    interface TesterActor {
      system: { pf1e: TesterPf1e };
    }
    interface TesterArmy {
      units: { type: string; leaderTokenId?: string }[];
    }
    interface TesterFaction {
      color: string;
    }
    interface TesterJournal {
      pages: { text: string }[];
    }
    const docs = JSON.parse(strFromU8(entries["documents.json"] as Uint8Array)) as {
      seq: number;
      docs: DocRow[];
    };
    expect(docs.seq).toBe(17);
    expect(docs.docs).toHaveLength(17);
    const byId = new Map(docs.docs.map((d) => [d.id, d]));
    const docOf = <T>(id: string): T => {
      const row = byId.get(id);
      if (!row) throw new Error(`tester document ${id} is missing`);
      return row.doc as T;
    };
    // the GM user carries the host's GM id — a seeded world skips seeding at seq > 0
    expect(docs.docs.find((d) => d.id === "gm")).toMatchObject({ coll: "users", doc: { role: "GM", type: "user" } });
    // tactical scene: 3 tokens (hero + 2 goblins from the pack)
    const scene1 = docOf<TesterScene>("scene-1");
    expect(scene1.flags).toEqual({});
    expect(scene1.tokens.map((t) => t.actorId)).toEqual(["hero", "goblin-a", "goblin-b"]);
    // strategic scene: the flag + the link note to scene-1
    const scene2 = docOf<TesterScene>("scene-2");
    expect(scene2.flags.core?.scale).toBe("strategic");
    expect(scene2.notes).toHaveLength(1);
    expect(scene2.notes[0]).toMatchObject({ linkedSceneId: "scene-1" });
    // hero: the authored Fighter-3 block; goblins: the pf1e block READ FROM THE PACK
    const hero = docOf<TesterActor>("hero");
    expect(hero.system.pf1e.baseAttack).toBe(3);
    expect(hero.system.pf1e.abilities).toMatchObject({ str: 16, con: 14 });
    expect(hero.system.pf1e.attacks?.[0]).toMatchObject({ name: "Longsword", damageDice: "1d8", critThreatMin: 19 });
    const goblin = docOf<TesterActor>("goblin-a");
    expect(goblin.system.pf1e.abilities).toEqual({ str: 15, dex: 11, con: 12, int: 10, wis: 9, cha: 8 });
    expect(goblin.system.pf1e.savesAsTotal).toBe(true);
    // armies: 2 + 4 units, hero unit linked to the scene-1 token
    const heroArmy = docOf<TesterArmy>("hero-army");
    expect(heroArmy.units).toHaveLength(2);
    expect(heroArmy.units.map((u) => u.type)).toEqual(["infantry", "hero"]);
    expect(heroArmy.units[1]?.leaderTokenId).toBe("tok-hero");
    const enemyArmy = docOf<TesterArmy>("enemy-army");
    expect(enemyArmy.units.map((u) => u.type)).toEqual(["infantry", "infantry", "cavalry", "artillery"]);
    expect(docOf<TesterFaction>("faction-hero").color).toBe("#4a90d9");
    expect(docOf<TesterFaction>("faction-foe").color).toBe("#d9534f");
    expect(docOf<TesterJournal>("journal-welcome").pages[0]?.text).toContain("PF1e tester world");
    // the converted content package rides in the archive
    expect(Object.keys(entries)).toEqual(expect.arrayContaining([
      "packages/pf1e-content/manifest.json",
      "packages/pf1e-content/packs/basic-npcs.json",
      "packages/pf1e-content/OGL.txt",
    ]));
    const pkgs = JSON.parse(strFromU8(entries["packages.json"] as Uint8Array)) as { id: string }[];
    expect(pkgs.map((p) => p.id)).toEqual(["pf1e-mass-battles", "pf1e-core", "pf1e-content"]);
  });

  test("imports as a copy and boots: strategic scene, armies and pack-derived goblin are live", async () => {
    if (!tester?.zip) throw new Error("tester starter not built");
    const bytes = new Uint8Array(readFileSync(tester.zip));
    const db = await openVttDb();
    const root = new MemDirHandle();

    const imported = await importWorldZip({ db, file: bytes, root, mode: "copy", name: "Tester World" });
    expect(imported.packages.sort()).toEqual(["pf1e-content", "pf1e-core", "pf1e-mass-battles"]);
    expect(imported.activeRulesPackage).toBe("pf1e-mass-battles");

    const app = await bootHostApp({
      db,
      root,
      codec: new FakeCodec(),
      simRunner: new InlineSimRunner(),
      worldId: imported.worldId,
    });
    try {
      expect(app.meta.name).toBe("Tester World");
      expect(app.rulesBoot).toMatchObject({ source: "package", packageId: "pf1e-mass-battles", error: null });
      const store = app.gm.client.store;
      // pre-placed docs: no default seed (seq 17), the tactical scene is DEFAULT_SCENE_ID
      expect(store.get("scenes", "scene-1")).toBeDefined();
      const scene2 = store.get("scenes", "scene-2") as { flags?: { core?: { scale?: string } } } | undefined;
      expect(scene2?.flags?.core?.scale).toBe("strategic");
      const hero = store.get("actors", "hero") as { system?: { pf1e?: Record<string, unknown> } } | undefined;
      expect(hero?.system?.pf1e?.baseAttack).toBe(3);
      const goblin = store.get("actors", "goblin-a") as
        | { system?: { pf1e?: { abilities?: Record<string, number> } } }
        | undefined;
      // the goblin's abilities came from the converted pack (str 15), not the fallback (str 13)
      expect(goblin?.system?.pf1e?.abilities?.str).toBe(15);
      const army = store.get("armies", "enemy-army") as { units?: unknown[] } | undefined;
      expect(army?.units).toHaveLength(4);
      const journal = store.get("journals", "journal-welcome") as { pages?: { text: string }[] } | undefined;
      expect(journal?.pages?.[0]?.text).toContain("compendium searches");
      // all three packages installed; the content pack's compendium is resolvable
      const pkgs = await app.packages.list();
      expect(pkgs.map((p) => p.id).sort()).toEqual(["pf1e-content", "pf1e-core", "pf1e-mass-battles"]);
      await app.persister.flush();
    } finally {
      await app.close();
    }
  }, 30_000);

  test("a missing content dir skips the tester (plain starter only) without failing the build", async () => {
    const mod = (await import(
      /* @vite-ignore */ join(repoRoot, "scripts/buildStarterWorlds.mjs")
    )) as { buildStarterWorlds: (o: object) => Promise<BuiltStarter[]> };
    const built = await mod.buildStarterWorlds({
      systemsDir,
      outDir: join(stage, "plain-worlds"),
      contentDir: join(stage, "no-such-content"),
    });
    expect(built.map((b) => b.id)).toEqual(["pf1e-mass-battles"]);
  });
});

// ─── the overland region: hexcrawl content → documents → a booted world ───────

/**
 * The starter ships a complete hexcrawl — **The Hollow Reach** — because a world you can only
 * read about is a world that hides half the app. The region is authored as content
 * (`content/hexcrawl/hollow-reach.json`) and converted by `hexcrawlDocuments()`; these tests hold
 * both halves: the conversion, and the fact that the host, the importer and the projection all
 * still carry the result.
 */
describe("starter overland region (content/hexcrawl/hollow-reach.json)", () => {
  let regionDocs: Record<string, unknown>[] = [];
  beforeAll(async () => {
    const mod = await regionModule();
    regionDocs = mod.hexcrawlDocuments();
  });

  interface RegionDoc extends Record<string, unknown> {
    _id: string;
    type: string;
    name: string;
  }
  interface RegionScene extends RegionDoc {
    grid: { type: string; size: number; distance: number; units: string; hexLayout: string };
    tokens: Array<{ _id: string; x: number; y: number }>;
    cells: Array<{
      key: string;
      terrain?: string;
      description?: string;
      playerText?: string;
      tables?: string[];
      features?: Array<{ id: string; reveal: { kind: string }; state: { revealed: boolean } }>;
    }>;
    flags: { core: { hexcrawl: Record<string, unknown> } };
  }

  /** The writer is plain JS, loaded the same way the other tests load it. */
  const regionModule = async (): Promise<{
    hexcrawlDocuments: (file?: string) => Record<string, unknown>[];
    readHexcrawlContent: (file?: string) => { hexes: unknown[] };
  }> =>
    (await import(/* @vite-ignore */ join(repoRoot, "scripts/buildStarterWorlds.mjs"))) as never;

  const region = (): {
    scene: RegionScene;
    tables: Array<RegionDoc & { mode: string; entries: unknown[] }>;
    guide: RegionDoc & { pages: Array<{ text: string }> };
  } => {
    const docs = regionDocs as unknown as RegionDoc[];
    const scene = docs.find((d) => d.type === "scene") as unknown as RegionScene;
    const tables = docs.filter((d) => d.type === "encounterTable") as unknown as Array<
      RegionDoc & { mode: string; entries: unknown[] }
    >;
    const guide = docs.find((d) => d.type === "journal") as unknown as RegionDoc & {
      pages: Array<{ text: string }>;
    };
    return { scene, tables, guide };
  };

  test("the region converts to a hexcrawl scene, its tables, and a guide", () => {
    const { scene, tables, guide } = region();
    expect(scene.grid).toEqual({
      type: "hex",
      size: 100,
      distance: 6,
      units: "mi",
      diagonals: "555",
      hexLayout: "oddQ",
    });
    expect(scene.cells).toHaveLength(28);
    expect(tables).toHaveLength(4);
    expect(guide.pages[0]?.text).toContain("The Hollow Reach");
    // Every hex is authored: a name the GM reads, a description, and the line the party reads.
    for (const cell of scene.cells) {
      expect(cell.key, "every cell carries its q,r key").toMatch(/^-?\d+,-?\d+$/);
      expect(cell.description?.length ?? 0).toBeGreaterThan(80);
      expect(cell.playerText?.length ?? 0).toBeGreaterThan(30);
      expect(PF1E_TERRAIN_CATALOG.terrains.some((t) => t.id === cell.terrain), cell.key).toBe(true);
    }
    // The region covers the terrain catalog a GM would want to price travel against.
    const terrains = new Set(scene.cells.map((c) => c.terrain));
    for (const id of ["plains", "road", "hills", "forest", "marsh", "mountains", "water", "city"]) {
      expect(terrains, `the region has no ${id}`).toContain(id);
    }
  });

  test("the profile is a real hexcrawl scene, and the party stands in the hex it should", () => {
    const { scene } = region();
    expect(isHexcrawlScene(scene as never)).toBe(true);
    const profile = hexcrawlProfileOf(scene as never);
    expect(profile).toMatchObject({
      version: 1,
      sight: { mode: "gm+party", radiusCells: 1 },
      partyTokenId: "tok-party",
      encounterMode: "prompt",
      encounterAnnounce: "names",
      terrain: "pf1e-overland",
      travel: null,
    });
    expect(profile?.revealed).toEqual(["1,1", "1,2", "1,3", "2,2", "2,3", "3,2"]);
    // The one thing the writer cannot share with the TS geometry module: the pixel centre it
    // computes for a hex must be the hex the app reads back at that pixel.
    const party = scene.tokens[0];
    expect(party?._id).toBe("tok-party");
    expect(cellAtPoint(scene as never, party?.x ?? 0, party?.y ?? 0)).toBe("1,2");
    // …and every authored cell's centre lands inside that cell, not in a neighbour.
    for (const cell of scene.cells) {
      const centre = cellCenterOf(scene as never, cell.key);
      expect(cellAtPoint(scene as never, centre?.x ?? -1, centre?.y ?? -1), cell.key).toBe(cell.key);
    }
    // The map is bigger than the region: the dark edges are unexplored ground, not a cropped map.
    expect(cellsInMap(scene as never).length).toBeGreaterThan(scene.cells.length);
  });

  test("four encounter tables draw, and every hex that names one names a real one", () => {
    const { scene, tables } = region();
    const ids = new Set(tables.map((t) => t._id));
    for (const table of tables) {
      const check = validateEncounterTable(table as never);
      expect(check.errors, `${table._id}: ${check.errors.join("; ")}`).toEqual([]);
      expect(table.entries.length).toBeGreaterThan(3);
    }
    const attached = new Set(scene.cells.flatMap((c) => c.tables ?? []));
    expect(attached.size).toBeGreaterThan(0);
    for (const id of attached) {
      expect(ids.has(id), `a hex attaches ${id}, which no table provides`).toBe(true);
    }
  });

  test("hidden features ship hidden, each with the rule that finds it", () => {
    const { scene, guide } = region();
    const features = scene.cells.flatMap((c) => c.features ?? []);
    expect(features.length).toBeGreaterThanOrEqual(10);
    for (const feature of features) {
      // Nothing is found before a party finds it — the starter ships rules, not answers.
      expect(feature.state).toEqual({ revealed: false });
      expect(["manual", "perception", "time", "dice"]).toContain(feature.reveal.kind);
    }
    const kinds = new Set(features.map((f) => f.reveal.kind));
    expect([...kinds].sort()).toEqual(["dice", "manual", "perception", "time"]);
    // The guide names every feature and the rule that uncovers it, in the GM's words.
    for (const feature of features.slice(0, 4)) {
      expect(guide.pages[0]?.text).toContain(feature.id.replace(/^feat-/, "").replace(/-/g, " "));
    }
  });

  test("the region survives the world file and boots with its cells intact", async () => {
    const bytes = new Uint8Array(readFileSync(starterOf("pf1e-mass-battles").zip as string));
    const db = await openVttDb();
    const root = new MemDirHandle();
    const imported = await importWorldZip({ db, file: bytes, root, mode: "copy", name: "Reach" });
    const app = await bootHostApp({
      db,
      root,
      codec: new FakeCodec(),
      simRunner: new InlineSimRunner(),
      worldId: imported.worldId,
    });
    try {
      const store = app.gm.client.store;
      const scene = store.get("scenes", "scene-3") as unknown as RegionScene | undefined;
      expect(scene).toBeDefined();
      // The importer and the host kept the cells — the whole point of shipping them.
      expect(cellsOf(scene as never)).toHaveLength(28);
      expect(isHexcrawlScene(scene as never)).toBe(true);
      expect(hexcrawlProfileOf(scene as never)?.partyTokenId).toBe("tok-party");
      expect(store.getAll("encounterTables")).toHaveLength(4);
      const guide = store.get("journals", "journal-hollow-reach") as
        | { pages?: Array<{ text: string }> }
        | undefined;
      expect(guide?.pages?.[0]?.text).toContain("Gallows Ford");
      // The tactical scene the world opens on is untouched by the region.
      expect(store.get("scenes", DEFAULT_SCENE_ID)).toBeDefined();
      await app.persister.flush();
    } finally {
      await app.close();
    }
  }, 60_000);
});
