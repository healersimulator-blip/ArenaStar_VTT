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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bootHostApp, DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
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
      seq: 0,
      rules: { active: "pf1e-mass-battles" },
      starter: true,
    });
    expect(JSON.parse(strFromU8(entries["documents.json"] as Uint8Array))).toEqual({ seq: 0, docs: [] });
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
      [join(repoRoot, "scripts/buildStarterWorlds.mjs"), "--systems-dir", systemsDir, "--out", join(stage, "dry"), "--dry-run"],
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
