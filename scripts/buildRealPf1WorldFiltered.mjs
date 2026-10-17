#!/usr/bin/env node
import {
  packageFilesFromDir as fileMap,
  packageContentHashFromMap as packageHash,
  archiveOuterRoot,
  foundryManifestPath,
} from "./lib/packageFixture.mjs";
import { foundryFixtureTools, transcodeYamlPacks } from "./lib/foundryFixture.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync, unzipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));
const pf1ZipPath = join(
  process.env.VTT_FOUNDRY_FIXTURES ?? join(root, "tools/content/vendor/foundry-fixtures"),
  "pf1-system.zip",
);

const json = (v) => strToU8(JSON.stringify(v, null, 2));
const zip = (files) =>
  zipSync(files, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });

async function main() {
  const adapterDir = join(root, "modules/ais-foundry-v13");
  const adapterFiles = fileMap(adapterDir);
  const adapterManifest = JSON.parse(adapterFiles["manifest.json"]);
  const adapterHash = packageHash(adapterFiles);

  const rawZip = readFileSync(pf1ZipPath);
  const entries = unzipSync(rawZip);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const textFiles = {};
  const binaries = new Map();
  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith("/")) continue;
    try {
      textFiles[path] = decoder.decode(data);
    } catch {
      binaries.set(path, data);
    }
  }
  const allPaths = [...Object.keys(textFiles), ...binaries.keys()];
  const manifestPath = foundryManifestPath(allPaths);
  if (!manifestPath) throw new Error(`No system.json in ${pf1ZipPath}`);
  const rootPrefix = archiveOuterRoot(allPaths, manifestPath);
  const rooted = {};
  for (const [p, txt] of Object.entries(textFiles)) {
    if (p.startsWith(rootPrefix)) rooted[p.slice(rootPrefix.length)] = txt;
  }
  const rootedBinaryPaths = [...binaries.keys()]
    .filter((p) => p.startsWith(rootPrefix))
    .map((p) => p.slice(rootPrefix.length));

  const essentialPacks = new Set(["basic-monsters", "spells"]);
  const moduleOnly = {};
  for (const [p, txt] of Object.entries(rooted)) {
    const isPack = p.startsWith("packs/") || p.startsWith("public/packs/");
    let includePack = false;
    if (isPack) {
      for (const ep of essentialPacks) {
        if (
          p.includes(`/${ep}/`) ||
          p.includes(`/${ep}.`) ||
          p.startsWith(`packs/${ep}`) ||
          p.startsWith(`public/packs/${ep}`)
        ) {
          includePack = true;
          break;
        }
      }
    }
    if (
      p.startsWith("module/") ||
      p === "public/system.json" ||
      p === "system.json" ||
      p === "pf1.js" ||
      p === "module/tsconfig.json" ||
      p.startsWith("templates/") ||
      p.startsWith("public/templates/") ||
      p.startsWith("lang/") ||
      includePack
    ) {
      moduleOnly[p] = txt;
      if (p.startsWith("public/templates/")) {
        const alt = p.replace(/^public\//, "");
        if (!moduleOnly[alt]) moduleOnly[alt] = txt;
      }
      if (p.startsWith("public/packs/")) {
        const alt = p.replace(/^public\//, "");
        if (!moduleOnly[alt]) moduleOnly[alt] = txt;
      }
    }
  }
  console.log("moduleOnly count", Object.keys(moduleOnly).length);

  const { synthesizeFoundryModulePackage, foundryPackStorageError } = await foundryFixtureTools();
  const storageError = foundryPackStorageError(rooted, rootedBinaryPaths);
  if (storageError) throw new Error(storageError);
  const synthesized = synthesizeFoundryModulePackage(transcodeYamlPacks(moduleOnly), []);
  if (!synthesized.ok) {
    console.error("synthesize failed", synthesized.error);
    process.exit(1);
  }
  console.log(
    "synthesized",
    synthesized.value.foundry.id,
    Object.keys(synthesized.value.files).length,
  );

  const pf1PackageFiles = synthesized.value.files;
  const pf1Manifest = synthesized.value.manifest;
  const pf1Id = pf1Manifest.id;
  const pf1Hash = packageHash(pf1PackageFiles);

  const packages = [
    {
      id: adapterManifest.id,
      files: adapterFiles,
      manifest: adapterManifest,
      hash: adapterHash,
    },
    { id: pf1Id, files: pf1PackageFiles, manifest: pf1Manifest, hash: pf1Hash },
  ];

  const base = (id, type, name) => ({
    _id: id,
    type,
    name,
    ownership: { default: 2 },
    flags: {},
    system: {},
  });
  const scene = {
    ...base("scene-1", "scene", "PF1 Minimal"),
    active: true,
    img: null,
    width: 1400,
    height: 900,
    darkness: 0,
    grid: {
      type: "square",
      size: 100,
      distance: 5,
      units: "ft",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    regions: [],
  };
  const user = {
    ...base("gm", "user", "GM"),
    ownership: { default: 3 },
    role: "GM",
    character: null,
    color: "#e0b341",
  };
  const docs = [
    { coll: "users", id: user._id, doc: user },
    { coll: "scenes", id: scene._id, doc: scene },
  ];

  const worldEntries = {
    "world.json": json({
      format: 5,
      requiredFeatures: [
        "scene-level-drafts-v1",
        "arena.ais/1",
        "arena.ais.runtime/1",
      ],
      worldId: "real-pf1-minimal",
      name: "Real PF1 Minimal",
      system: "mass-battle-basic",
      version: "1.0.0",
      seq: docs.length,
      exportedAt: 0,
      starter: true,
      rules: { active: null },
      automation: {
        api: "arena.ais/1",
        modules: packages.map((p) => ({
          id: p.id,
          version: p.manifest.version,
          hash: p.hash,
        })),
        providers: {},
      },
    }),
    "documents.json": json({ seq: docs.length, docs }),
    "assets.json": json([]),
    "packages.json": json(
      packages.map((p) => ({
        id: p.id,
        name: p.manifest.name,
        version: p.manifest.version,
        type: "module",
        importedAt: 0,
        packCount: p.manifest.packs?.length ?? 0,
      })),
    ),
  };
  for (const pkg of packages)
    for (const [path, text] of Object.entries(pkg.files))
      worldEntries[`packages/${pkg.id}/${path}`] = strToU8(text);

  const outDir = join(root, "dist/worlds");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "real-pf1-minimal-test-1.0.0.zip");
  writeFileSync(outPath, zip(worldEntries));
  console.log("wrote", outPath);
}

await main();
