/**
 * The REAL built tester world (dist/worlds/pf1e-mass-battles-tester-<v>.zip — the converted
 * content, 28 packs / 25 k entries) imports and boots, and the licence notices that must travel
 * with that content are inside the artifact. Skips itself when the artifact is not built (fresh
 * clones): build it with `pnpm content:fetch && pnpm build && pnpm build:systems &&
 * pnpm content:convert && pnpm build:worlds` first — the skip note says so, and D-258 records the
 * run where this test executed instead of skipping, which is the G-44 acceptance. The hermetic
 * counterpart (a small fixture content package) is in tests/scripts/buildStarterWorlds.test.ts.
 */
import "fake-indexeddb/auto";
import { existsSync, readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootHostApp } from "../../src/app/hostBoot";
import { searchCompendia } from "../../src/core/compendium";
import {
  buildCompendiumIndex,
  indexFootprintBytes,
  rankIndex,
  searchIndex,
} from "../../src/core/compendiumIndex";
import { importWorldZip } from "../../src/host/worldFile";
import { openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec } from "../app/fakes";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const zipPath = join(repoRoot, "dist/worlds/pf1e-mass-battles-tester-1.0.0.zip");

describe.skipIf(!existsSync(zipPath))("real tester zip (real converted content)", () => {
  test("imports + boots with the 28-pack content package", async () => {
    const bytes = new Uint8Array(readFileSync(zipPath));
    const db = await openVttDb();
    const root = new MemDirHandle();

    const imported = await importWorldZip({ db, file: bytes, root, mode: "copy", name: "Real Tester" });
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
      expect(app.rulesBoot).toMatchObject({ source: "package", packageId: "pf1e-mass-battles", error: null });
      const store = app.gm.client.store;
      expect(store.get("scenes", "scene-2")).toBeDefined();
      expect(store.get("actors", "goblin-a")).toBeDefined();
      // the goblin from the REAL converted pack (basic-npcs: str 13)
      const goblin = store.get("actors", "goblin-a") as
        | { system?: { pf1e?: { abilities?: Record<string, number> } } }
        | undefined;
      expect(goblin?.system?.pf1e?.abilities?.str).toBe(13);
      const army = store.get("armies", "enemy-army") as { units?: unknown[] } | undefined;
      expect(army?.units).toHaveLength(4);
      // the content package's compendia resolve (lazy parse of the real packs)
      const pkgs = await app.packages.list();
      const content = pkgs.find((p) => p.id === "pf1e-content");
      expect(content).toBeDefined();
      expect(content?.missingDependencies.length ?? 0).toBe(0);
      const allCompendia = await app.packages.compendia();
      const compendia = allCompendia.filter((c) => c.packageId === "pf1e-content");
      expect(compendia.length).toBe(28);
      const spells = compendia.find((c) => c.pack.name === "PF1e Spells (Core)");
      expect(spells?.pack.entries.length).toBe(3028);
      const rulesRef = compendia.find((c) => c.pack.name === "PF1e Rules (Reference)");
      expect(rulesRef?.pack.entries.length).toBe(591);

      // ── G-45: the real 25 k-entry corpus through the reader's index ──────────────
      // The synthetic budget test (`tests/core/compendiumIndex.test.ts`) proves the arithmetic;
      // this runs the *converted Foundry content itself* — the shapes the facet rules have to
      // read (`system.category`, spell keywords vs `system.school`, string-keyed tables) and the
      // queries the browser acceptance uses (`e2e/content_world.spec.ts`).
      const converted = compendia.filter((c) => c.packageId === "pf1e-content").map((c) => c.pack);
      const index = buildCompendiumIndex(converted);
      expect(index.counts).toEqual({ packs: 28, entries: 25_376 });

      // Kinds are read from the data — every group here is a real pack's shape, not a guess.
      const kindCounts = new Map<string, number>();
      for (const e of index.entries) kindCounts.set(e.facets.kind, (kindCounts.get(e.facets.kind) ?? 0) + 1);
      const kinds = Object.fromEntries([...kindCounts.entries()].sort((a, b) => b[1] - a[1]));
      expect(kinds["Class ability"]).toBe(4727); // class-abilities.json (category classFeat)
      expect(kinds["Spell"]).toBe(3028); // spells-core.json (keyword `spell`, school on 1459)
      expect(kinds.Feat).toBe(3609); // feats.json + feats-core.json, minus their racial-feat rows
      expect(kinds.Trait).toBe(1915); // traits.json (category trait)
      expect(kinds.Racial).toBe(1536); // 1214 racial traits + 322 racial feats
      expect(kinds.Equipment).toBe(4357);
      expect(kinds.Loot).toBe(1884);
      expect(kinds.Weapon).toBe(916);
      expect(kinds.Creature).toBe(399); // basic-npcs 15 + companions 209 + familiars 175
      expect(kinds.Class).toBe(49);
      expect(kinds["Roll table"]).toBe(288);
      expect(kinds.Journal).toBe(601);
      expect(kinds.Misc).toBe(333); // special-qualities.json (universal monster rules)
      expect(kindCounts.size).toBeGreaterThanOrEqual(15);

      // Facets: a school where the data states one (1459 of the 3028 spells), spell levels 0–9.
      const evocation = index.facetOptions.schools.find((o) => o.value === "Evocation");
      expect(evocation?.count).toBeGreaterThan(300);
      expect(index.facetOptions.levels.map((o) => o.value)).toEqual(
        expect.arrayContaining(["0", "1", "5", "9"]),
      );
      expect(index.facetOptions.packs).toHaveLength(28);

      // The queries the browser acceptance runs, answered by the index.
      const aboleth = searchIndex(index, "aboleth", { limit: 50 });
      expect(aboleth.length).toBeGreaterThan(0);
      expect(aboleth[0]?.entry.name).toMatch(/aboleth/i);
      const weaponFocus = searchIndex(index, "weapon focus", { limit: 50 });
      expect(weaponFocus.length).toBeGreaterThanOrEqual(2);
      expect(weaponFocus.some((h) => h.entry.name === "Weapon Focus")).toBe(true);
      expect(searchIndex(index, "goblin", { limit: 50 }).length).toBeGreaterThan(0);

      // The world as the reader sees it: content pack + the hand-authored core pack beside it, so
      // the two *authoring* styles (converter output and D-090 packs) share one index and one
      // facet vocabulary.
      const worldIndex = buildCompendiumIndex(allCompendia.map((c) => c.pack));
      expect(worldIndex.counts).toEqual({ packs: 33, entries: 25_538 });
      const table = searchIndex(worldIndex, "unarmed strike damage", { limit: 50 })[0];
      expect(table?.entry.name).toBe("Unarmed Strike Damage by Size");
      expect(table?.facets.kind).toBe("Table"); // the core pack's string-keyed rules table
      expect(table?.facets.level).toBeNull();
      // The core *spells* pack is "PF1e Spells"; the converted one is "PF1e Spells (Core)" — the
      // core entry states a school and no `spell` keyword, which is the other way in.
      const coreSpell = searchIndex(worldIndex, "fireball", { limit: 500 }).find(
        (h) => h.pack.name === "PF1e Spells",
      );
      expect(coreSpell?.entry.name).toBe("Fireball");
      expect(coreSpell?.facets.kind).toBe("Spell");
      expect(coreSpell?.facets.school).toBe("Evocation");
      expect(coreSpell?.facets.level).toBe(3); // lowest class level across the record

      // Parity with the reference search on the real corpus — sample queries that hit different
      // rungs (name prefix, word prefix, contains, keyword, multi-term, a 1-character term).
      for (const q of ["aboleth", "weapon focus", "fireball", "magic missile", "evocation", "e", "zzzz"]) {
        const reference = searchCompendia(converted, q, 50);
        const indexed = searchIndex(index, q, { limit: 50 });
        expect({
          ids: indexed.map((h) => h.entry.id),
          scores: indexed.map((h) => h.score),
          packs: indexed.map((h) => h.pack.name),
        }, `query "${q}"`).toEqual({
          ids: reference.map((h) => h.entry.id),
          scores: reference.map((h) => h.score),
          packs: reference.map((h) => h.pack.name),
        });
      }

      // Browse: one row per pack before any pack's second row (no large-pack starvation).
      const browse = rankIndex(index, "", { cap: 40 });
      expect(browse.total).toBe(25_376);
      expect(new Set([...browse.indices].map((i) => index.packs[index.entries[i]?.packIndex ?? 0]?.name)).size).toBe(28);

      // and the real-mode numbers, printed (the synthetic test owns the assertions).
      const typed = ["f", "fi", "fir", "fire", "fireb", "firebal", "fireball"];
      for (const q of typed) searchIndex(index, q, { limit: 50 });
      let keystrokes = 0;
      for (const q of typed) {
        const t0 = performance.now();
        searchIndex(index, q, { limit: 50 });
        keystrokes += performance.now() - t0;
      }
      const footprint = indexFootprintBytes(index);
      console.log(
        `[G-45 real] 28 packs / ${index.counts.entries} entries · ${typed.length} keystrokes ` +
          `${keystrokes.toFixed(1)} ms · index ${(footprint / 1024 / 1024).toFixed(2)} MB`,
      );
      expect(footprint).toBeLessThan(8 * 1024 * 1024);

      // ── G-44: the notices ship WITH the data, inside the same artifact ──
      // A licence notice that lives only in the repo does not travel with a world a GM downloads,
      // so the package carries the OGL text and the credits next to its packs. (The in-app
      // pointer to them is the Help window's "Licences & credits" section.)
      const files = unzipSync(bytes);
      const names = Object.keys(files);
      const notice = names.find((n) => /packages\/pf1e-content\/OGL\.txt$/.test(n));
      const credits = names.find((n) => /packages\/pf1e-content\/CREDITS\.md$/.test(n));
      expect(notice).toBeDefined();
      expect(credits).toBeDefined();
      const ogl = strFromU8(files[notice as string] as Uint8Array);
      expect(ogl).toMatch(/OPEN GAME LICENSE Version 1\.0a/i);
      expect(ogl).toMatch(/15\. COPYRIGHT NOTICE/);
      // the notice is the *content's* Section 15 list, not an empty template
      expect(ogl).toContain("Pathfinder RPG Core Rulebook");
      expect(ogl.length).toBeGreaterThan(20_000);
      const creditText = strFromU8(files[credits as string] as Uint8Array);
      // the credits name the pinned upstreams, both commits, and every converted pack
      expect(creditText).toContain("681929d1f5471178a99fc3285f94caa85d78e427");
      expect(creditText).toContain("baf5232c5dc16af99d49ae1bf57ead6473b46bbb");
      expect(creditText).toContain("PF1e Spells (Core)");
      expect(creditText).toContain("PF1e Feats (Expanded)");
      await app.persister.flush();
    } finally {
      await app.close();
    }
  }, 120_000);
});
