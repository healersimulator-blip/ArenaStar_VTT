/**
 * The REAL built tester world (dist/worlds/pf1e-mass-battles-tester-<v>.zip — the converted
 * content, 28 packs / 25 k entries) imports and boots. Skips itself when the artifact is not
 * built (fresh clones): build it with `pnpm build && pnpm build:systems && pnpm content:convert
 * && pnpm build:worlds` first. The hermetic counterpart (a small fixture content package) is
 * in tests/scripts/buildStarterWorlds.test.ts.
 */
import "fake-indexeddb/auto";
import { existsSync, readFileSync } from "node:fs";
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
      await app.persister.flush();
    } finally {
      await app.close();
    }
  }, 120_000);
});
