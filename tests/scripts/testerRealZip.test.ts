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
      const compendia = (await app.packages.compendia()).filter((c) => c.packageId === "pf1e-content");
      expect(compendia.length).toBe(28);
      const spells = compendia.find((c) => c.pack.name === "PF1e Spells (Core)");
      expect(spells?.pack.entries.length).toBe(3028);
      const rulesRef = compendia.find((c) => c.pack.name === "PF1e Rules (Reference)");
      expect(rulesRef?.pack.entries.length).toBe(591);

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
