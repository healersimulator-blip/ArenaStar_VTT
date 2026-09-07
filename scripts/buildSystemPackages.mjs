#!/usr/bin/env node
/**
 * §12 system-package build (Gap List §1.1): turn the in-repo rules sources into the real
 * artifacts a GM imports — `systems/<id>/rules.js` (one self-contained ESM text) and
 * `dist/packages/<id>-<version>.zip`.
 *
 * Why a build step at all: the SimWorker sandbox resolves nothing (D-086 — `fetch`, XHR,
 * `importScripts` and IDB are stripped by `hardenSandbox`, and `rulesLoader` imports exactly one
 * blob-URL module), so a package's `rules.entry` must already be a single file with every import
 * inlined. `src/packages/pf1e/**` is the source of truth; the emitted `rules.js` is a build
 * product and is git-ignored, so it can never drift from the module it was bundled from.
 *
 * The emitted file is additionally rewritten into the single-expression default form
 * (`export default (() => { … })();`) because `rulesLoader.evalRulesModule` — the fallback for
 * engines whose classic workers cannot import module scripts — only accepts that shape.
 *
 * Usage:  node scripts/buildSystemPackages.mjs [--only <packageId>] [--out <dir>]
 *         [--zip-dir <dir>] [--dry-run]
 *
 * `--out` copies the package folders (manifest + checked-in packs) to a staging directory and
 * writes the generated entries there instead of into `systems/` — that is what the tests use, so
 * a test run never mutates the tree.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Which source file each package's `rules.entry` is built from. Data-only packages (no rules
 * block) are zipped as-is, and anything not listed here keeps whatever `rules.js` the folder
 * already has — that is an error for a `system` package, checked below.
 */
const RULES_SOURCES = {
  "pf1e-mass-battles": "src/packages/pf1e/rulesEntry.ts",
};

/** Where the package folders live (each is one importable package). */
const PACKAGE_ROOT = "systems";

function listPackageDirs(systemsDir) {
  return readdirSync(systemsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Every file in a package folder, package-relative and deterministically sorted. */
function listPackageFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Rewrite a bundled ESM module into `export default (() => { … })();`.
 * Throws rather than emitting a file the loader would refuse.
 */
export function toSingleDefaultExpression(code, fileLabel) {
  const named = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(code);
  let body;
  let local = null;
  if (named) {
    for (const part of named[1].split(",")) {
      const m = /^\s*([A-Za-z0-9_$]+)\s+as\s+default\s*$/.exec(part.trim());
      if (m) local = m[1];
    }
    if (local === null) {
      throw new Error(`${fileLabel}: trailing export clause does not export a default: ${named[0]}`);
    }
    body = code.slice(0, named.index);
  } else {
    const direct = /^\s*export\s+default\s+([\s\S]+?);?\s*$/.exec(code);
    if (!direct) {
      throw new Error(
        `${fileLabel}: cannot find a default export to rewrite (tail: ${JSON.stringify(
          code.slice(-160),
        )})`,
      );
    }
    // `export default <expr>;` already is the single-expression form: keep it verbatim.
    if (/^[([{]/.test(direct[1].trim())) return code.endsWith("\n") ? code : `${code}\n`;
    body = code.slice(0, direct.index);
    local = `(${direct[1].replace(/;\s*$/, "")})`;
  }

  // D-086: the package must be one self-contained file — no static imports, and no leftover
  // exports for a worker that resolves nothing.
  const leftover = /^\s*(import|export)\b.*$/m.exec(body);
  if (leftover) {
    throw new Error(
      `${fileLabel}: bundle is not self-contained (${leftover[0].trim().slice(0, 80)} at offset ${
        leftover.index
      })`,
    );
  }

  return `export default (() => {\n${body}\nreturn ${local};\n})();\n`;
}

async function bundleRules(entrySource, outDir) {
  const { build } = await import("vite");
  rmSync(outDir, { recursive: true, force: true });
  await build({
    configFile: false,
    root: repoRoot,
    logLevel: "warn",
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      cssCodeSplit: false,
      target: "es2022",
      lib: {
        entry: resolve(repoRoot, entrySource),
        formats: ["es"],
        fileName: () => "rules.js",
      },
    },
  });
  const produced = join(outDir, "rules.js");
  if (!statSync(produced).isFile()) throw new Error(`build produced no rules.js in ${outDir}`);
  return readFileSync(produced, "utf8");
}

function zipFolder(dir, zipPath) {
  const files = {};
  for (const rel of listPackageFiles(dir)) files[rel] = strToU8(readFileSync(join(dir, rel), "utf8"));
  mkdirSync(dirname(zipPath), { recursive: true });
  writeFileSync(zipPath, zipSync(files, { level: 6 }));
  return Object.keys(files);
}

/**
 * Build (and optionally zip) every package under `systems/`.
 * Returns one record per package: { id, version, type, files, zip }.
 */
export async function buildSystemPackages(opts = {}) {
  const {
    dryRun = false,
    only = null,
    systemsDir = join(repoRoot, PACKAGE_ROOT),
    outDir = systemsDir,
    zipDir = join(repoRoot, "dist/packages"),
    tmpDir = join(repoRoot, "dist/.system-build"),
  } = opts;
  const staging = resolve(outDir) !== resolve(systemsDir);
  if (staging && !dryRun) rmSync(join(outDir), { recursive: true, force: true });

  const results = [];
  for (const id of listPackageDirs(systemsDir)) {
    if (only !== null && only !== id) continue;
    const srcDir = join(systemsDir, id);
    const manifestPath = join(srcDir, "manifest.json");
    if (!statSync(manifestPath, { throwIfNoEntry: false })?.isFile()) {
      // systems/mass-battle-basic is a source barrel + note until its package layout lands.
      console.log(`${id}: no manifest.json — skipped`);
      continue;
    }
    // A staging build works on a copy so the source tree keeps only hand-authored files.
    const dir = staging ? join(outDir, id) : srcDir;
    if (staging) {
      mkdirSync(join(outDir), { recursive: true });
      if (!dryRun) cpSync(srcDir, dir, { recursive: true });
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.id !== id) {
      throw new Error(`${id}: manifest.id "${manifest.id}" must equal the folder name`);
    }
    const entry = manifest.rules?.entry;

    const entrySource = RULES_SOURCES[id];
    if (entrySource !== undefined) {
      if (entry === undefined) {
        throw new Error(`${id}: a build source is registered but the manifest declares no rules.entry`);
      }
      const raw = await bundleRules(entrySource, join(tmpDir, id));
      const final = toSingleDefaultExpression(raw, `${id}/${entry}`);
      if (!dryRun) writeFileSync(join(dir, entry), final);
      console.log(`${id}: ${entry} ${(final.length / 1024).toFixed(1)} kB (from ${entrySource})`);
    } else if (manifest.type === "system" && entry !== undefined) {
      // Nothing to generate: the declared entry must already be in the folder. rules.js is a
      // build product, so this branch only fires for a package built by someone else.
      if (!statSync(join(dir, entry), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(
          `${id}: system package declares rules.entry "${entry}" but no build source is ` +
            `registered in RULES_SOURCES and the file does not exist`,
        );
      }
      console.log(`${id}: using checked-in ${entry}`);
    }

    const files = listPackageFiles(dir);
    // Mirror packageLoader's contract checks so a broken package fails the build, not the GM.
    for (const [label, path] of [
      ["rules.entry", entry],
      ["module.entry", manifest.module?.entry],
      ...[...(manifest.packs ?? [])].map((pack) => [`pack ${pack.name}`, pack.file]),
    ]) {
      if (path === undefined) continue;
      if (!files.includes(path)) {
        throw new Error(`${id}: manifest declares ${label} "${path}" — missing from ${dir}`);
      }
    }

    let zip = null;
    if (!dryRun) {
      zip = join(zipDir, `${id}-${manifest.version}.zip`);
      zipFolder(dir, zip);
      console.log(
        `${id}: ${manifest.version} → ${relative(repoRoot, zip)} (${(readFileSync(zip).length / 1024).toFixed(1)} kB)`,
      );
    }
    results.push({ id, version: manifest.version, type: manifest.type, files, zip });
  }
  if (!dryRun && !staging) rmSync(tmpDir, { recursive: true, force: true });
  return results;
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]).endsWith("buildSystemPackages.mjs");
if (isCli) {
  const argv = process.argv.slice(2);
  const argOf = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  const only = argOf("--only");
  const zipDir = argOf("--zip-dir");
  const out = argOf("--out");
  try {
    const built = await buildSystemPackages({
      dryRun: argv.includes("--dry-run"),
      ...(only !== null ? { only } : {}),
      ...(zipDir !== null ? { zipDir: resolve(repoRoot, zipDir) } : {}),
      ...(out !== null ? { outDir: resolve(repoRoot, out) } : {}),
    });
    if (built.length === 0) {
      console.error("no packages found under systems/");
      process.exit(1);
    }
  } catch (e) {
    console.error(`buildSystemPackages: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
