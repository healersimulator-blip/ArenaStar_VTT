#!/usr/bin/env node
/**
 * Package the converted content as a standalone data package (plan §1.1, gap G-44).
 *
 * `pnpm content:convert` writes `dist/content/pf1e/` — a package *directory*. That directory is
 * embedded in the tester world zip, but a GM who already has a world wants the compendium in it
 * without adopting someone else's world, and a GM without the toolchain wants a file to download.
 * This emits `dist/packages/pf1e-content-<version>.zip` in exactly the shape the app already
 * installs (Settings → *Strategic ruleset & content*): `manifest.json` at the root beside
 * `packs/`, plus the licence notices the data ships with.
 *
 * It also writes `dist/release/SHA256SUMS` over whatever artifacts exist, because "the artifact a
 * GM downloads" needs a checksum next to it or the download is unverifiable (plan §1.1 step 2).
 *
 * Usage: node scripts/buildContentPackage.mjs [--content-dir dist/content/pf1e] [--out dist/packages]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file under `dir`, relative and sorted — deterministic bytes for a reproducible artifact. */
export function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const abs = join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(relative(dir, abs));
    }
  };
  walk(dir);
  return out.sort();
}

/** The package zip: every file of the converted package, at its own relative path. */
export function zipContentPackage(contentDir) {
  const files = {};
  for (const rel of listFiles(contentDir)) {
    files[rel] = strToU8(readFileSync(join(contentDir, rel), "utf8"));
  }
  // A fixed mtime keeps the bytes reproducible from the same inputs, which is what makes the
  // published checksum verifiable by anyone who rebuilds the package. (ZIP stores MS-DOS times,
  // so the floor is 1980 — 1980-01-02 keeps the date valid in every timezone.)
  return zipSync(files, { level: 6, mtime: new Date(Date.UTC(1980, 0, 2)) });
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function main() {
  const argv = process.argv.slice(2);
  const argOf = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  const contentDir = resolve(
    repoRoot,
    argOf("--content-dir") ?? process.env.VTT_CONTENT_DIR ?? join("dist", "content", "pf1e"),
  );
  const outDir = resolve(repoRoot, argOf("--out") ?? join("dist", "packages"));
  const releaseDir = join(repoRoot, "dist", "release");

  if (!statSync(contentDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`content package missing: ${relative(repoRoot, contentDir)}`);
    console.error("  Build it first: pnpm content:fetch && pnpm content:convert");
    process.exit(1);
  }

  const manifest = JSON.parse(readFileSync(join(contentDir, "manifest.json"), "utf8"));
  const zipPath = join(outDir, `${manifest.id}-${manifest.version}.zip`);
  const bytes = zipContentPackage(contentDir);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(zipPath, bytes);

  // Checksums for the artifacts a person downloads: this package and any world zips present.
  const artifacts = [zipPath];
  const worldsDir = join(repoRoot, "dist", "worlds");
  if (statSync(worldsDir, { throwIfNoEntry: false })?.isDirectory()) {
    for (const name of readdirSync(worldsDir).sort()) {
      if (name.endsWith(".zip")) artifacts.push(join(worldsDir, name));
    }
  }
  mkdirSync(releaseDir, { recursive: true });
  const lines = artifacts.map((p) => `${sha256(readFileSync(p))}  ${relative(repoRoot, p)}`);
  writeFileSync(join(releaseDir, "SHA256SUMS"), `${lines.join("\n")}\n`);

  console.log(
    `${manifest.id}: ${manifest.version} → ${relative(repoRoot, zipPath)} (${(
      bytes.length / 1024
    ).toFixed(1)} kB, ${manifest.packs.length} packs)`,
  );
  console.log(`checksums → ${relative(repoRoot, join(releaseDir, "SHA256SUMS"))} (${artifacts.length} artifact(s))`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
