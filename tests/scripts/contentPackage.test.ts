// G-44 (plan §1.1): the artifact a GM downloads must be installable *without* our toolchain.
// `pnpm content:package` writes dist/packages/pf1e-content-<v>.zip from dist/content/pf1e; this
// test installs that real zip through the app's own package importer and reads the packs back.
// It skips (with the commands) when the content was not converted — the hermetic counterpart is
// the fixture package in buildStarterWorlds.test.ts.
import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const contentDir = join(repoRoot, "dist", "content", "pf1e");
const packageZip = join(repoRoot, "dist", "packages", "pf1e-content-1.0.0.zip");

// The writer is plain JS, so it is imported as a module path (as buildStarterWorlds.test.ts does
// with its own script) rather than through a type-only shim: these helpers are the shipped ones.
const { listFiles, zipContentPackage, sha256 } = (await import(
  /* @vite-ignore */ join(repoRoot, "scripts", "buildContentPackage.mjs")
)) as {
  listFiles: (dir: string) => string[];
  zipContentPackage: (contentDir: string) => Uint8Array;
  sha256: (bytes: Uint8Array) => string;
};

describe("content package artifact", () => {
  test.skipIf(!existsSync(contentDir))("the converted package lays out the packs and the notices", () => {
    const files = listFiles(contentDir);
    expect(files).toContain("manifest.json");
    expect(files).toContain("OGL.txt");
    expect(files).toContain("CREDITS.md");
    expect(files.filter((f) => f.startsWith("packs/")).length).toBe(28);
    const manifest = JSON.parse(readFileSync(join(contentDir, "manifest.json"), "utf8")) as {
      id: string;
      type: string;
      packs: { name: string; type: string; file: string }[];
    };
    expect(manifest.id).toBe("pf1e-content");
    expect(manifest.type).toBe("data");
    expect(manifest.packs).toHaveLength(28);
    // every pack the manifest names is actually present in the folder
    for (const pack of manifest.packs) expect(files).toContain(pack.file);
  });

  test.skipIf(!existsSync(contentDir))(
    "the zip is byte-reproducible from the same folder (a download can be identified)",
    () => {
      const a = zipContentPackage(contentDir);
      const b = zipContentPackage(contentDir);
      expect(sha256(a)).toBe(sha256(b));
      expect(a.length).toBeGreaterThan(1_000_000); // the real content, not a stub
    },
  );

  test.skipIf(!existsSync(packageZip))(
    "the built package zip installs into a world through the app's own importer",
    async () => {
      const { openVttDb } = await import("../../src/storage/idb");
      const { MemDirHandle } = await import("../../src/storage/opfs");
      const { bootHostApp } = await import("../../src/app/hostBoot");
      const { InlineSimRunner } = await import("../../src/workers/simWorkerClient");
      const { FakeCodec } = await import("../app/fakes");

      const db = await openVttDb();
      const root = new MemDirHandle();
      const file = new Uint8Array(readFileSync(packageZip));

      const app = await bootHostApp({
        db,
        root,
        codec: new FakeCodec(),
        simRunner: new InlineSimRunner(),
      });
      try {
        // the same call the Settings window makes when a GM picks the downloaded file
        const result = await app.packages.importZip(file);
        expect(result.ok).toBe(true);
        const packs = await app.packages.list();
        const content = packs.find((p) => p.id === "pf1e-content");
        expect(content).toBeDefined();
        const compendia = (await app.packages.compendia()).filter(
          (c) => c.packageId === "pf1e-content",
        );
        expect(compendia).toHaveLength(28);
        const total = compendia.reduce((n, c) => n + c.pack.entries.length, 0);
        expect(total).toBeGreaterThanOrEqual(25_376);
      } finally {
        await app.close();
      }
    },
    120_000,
  );

  test("the checksum helper is the plain sha256 of the file", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(sha256(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});
