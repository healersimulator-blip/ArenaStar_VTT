#!/usr/bin/env node
import {
  packageFilesFromDir as fileMap,
  packageContentHashFromMap as packageHash,
  archiveOuterRoot,
  foundryManifestPath,
} from "./lib/packageFixture.mjs";
import { buildRealPf1IntegralScenario } from "./lib/realPf1IntegralScenario.mjs";
import { foundryFixtureTools, transcodeYamlPacks } from "./lib/foundryFixture.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync, unzipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));

const json = (v) => strToU8(JSON.stringify(v, null, 2));
const zip = (files) =>
  zipSync(files, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });

function loadZipTextFiles(zipPath) {
  const rawZip = readFileSync(zipPath);
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
  return { textFiles, binaries };
}

async function synthesizeFromZip(zipPath, filterFn) {
  const { textFiles, binaries } = loadZipTextFiles(zipPath);
  const allPaths = [...Object.keys(textFiles), ...binaries.keys()];
  const manifestPath = foundryManifestPath(allPaths);
  if (!manifestPath) throw new Error(`no manifest in ${zipPath}`);
  const rootPrefix = archiveOuterRoot(allPaths, manifestPath);
  const rooted = {};
  for (const [p, txt] of Object.entries(textFiles)) {
    if (p.startsWith(rootPrefix)) rooted[p.slice(rootPrefix.length)] = txt;
  }
  // apply filter
  const filtered = {};
  for (const [p, txt] of Object.entries(rooted)) {
    if (!filterFn || filterFn(p)) filtered[p] = txt;
  }
  const { synthesizeFoundryModulePackage, foundryPackStorageError } = await foundryFixtureTools();
  const storageError = foundryPackStorageError(
    rooted,
    [...binaries.keys()]
      .filter((p) => p.startsWith(rootPrefix))
      .map((p) => p.slice(rootPrefix.length)),
  );
  if (storageError) throw new Error(storageError);
  const synthesized = synthesizeFoundryModulePackage(transcodeYamlPacks(filtered), []);
  if (!synthesized.ok)
    throw new Error(`synthesize failed for ${zipPath}: ${synthesized.error}`);
  return synthesized.value;
}

export async function buildRealPf1FullWorld({ integral = false } = {}) {
  const adapterDir = join(root, "modules/ais-foundry-v13");
  const adapterFiles = fileMap(adapterDir);
  const adapterManifest = JSON.parse(adapterFiles["manifest.json"]);
  const adapterHash = packageHash(adapterFiles);
  console.log(
    "adapter",
    adapterManifest.id,
    Object.keys(adapterFiles).length,
    "files",
  );

  // PF1 system filtered to essential packs basic-monsters + spells + module + templates + lang
  const essentialPacks = new Set(["basic-monsters", "spells"]);
  const pf1 = await synthesizeFromZip(
    join(process.env.VTT_FOUNDRY_FIXTURES ?? join(root, "tools/content/vendor/foundry-fixtures"), "pf1-system.zip"),
    (p) => {
      const isPack = p.startsWith("packs/") || p.startsWith("public/packs/");
      if (isPack) {
        for (const ep of essentialPacks) {
          if (
            p.includes(`/${ep}/`) ||
            p.includes(`/${ep}.`) ||
            p.startsWith(`packs/${ep}`) ||
            p.startsWith(`public/packs/${ep}`)
          )
            return true;
        }
        return false;
      }
      return (
        p.startsWith("module/") ||
        p === "public/system.json" ||
        p === "pf1.js" ||
        p.startsWith("templates/") ||
        p.startsWith("public/templates/") ||
        p.startsWith("lang/")
      );
    },
  );
  console.log(
    "pf1",
    pf1.foundry.id,
    Object.keys(pf1.files).length,
    "files",
    "packs",
    pf1.foundry.packs.length,
  );

  // PF1-content: keep module.json + only a couple packs to keep size reasonable (demonstrate it runs)
  const pfContentKeep = new Set(["pf-feats", "pf-items"]);
  const pf1Content = await synthesizeFromZip(
    join(process.env.VTT_FOUNDRY_FIXTURES ?? join(root, "tools/content/vendor/foundry-fixtures"), "pf1-content.zip"),
    (p) => {
      if (p === "module.json") return true;
      if (p.startsWith("packs/")) {
        for (const keep of pfContentKeep) if (p.includes(keep)) return true;
        return false;
      }
      return false;
    },
  );
  console.log(
    "pf1-content",
    pf1Content.foundry.id,
    Object.keys(pf1Content.files).length,
    "files",
  );

  // Archetypes: module.json + packs (all 4, small)
  const archetypes = await synthesizeFromZip(
    join(process.env.VTT_FOUNDRY_FIXTURES ?? join(root, "tools/content/vendor/foundry-fixtures"), "pf1e-archetypes.zip"),
    (p) => {
      return p === "module.json" || p.startsWith("packs/");
    },
  );
  console.log(
    "archetypes",
    archetypes.foundry.id,
    Object.keys(archetypes.files).length,
    "files",
  );

  // Statblock library: module.json + only 2 packs to keep size reasonable
  const statblockKeep = new Set(["sb-bestiaries1-3", "sb-bestiaries4-6"]);
  const statblock = await synthesizeFromZip(
    join(process.env.VTT_FOUNDRY_FIXTURES ?? join(root, "tools/content/vendor/foundry-fixtures"), "statblock-library.zip"),
    (p) => {
      if (p === "module.json" || p.startsWith("scripts/")) return true;
      if (p.startsWith("packs/")) {
        for (const keep of statblockKeep) if (p.includes(keep)) return true;
        return false;
      }
      return false;
    },
  );
  console.log(
    "statblock",
    statblock.foundry.id,
    Object.keys(statblock.files).length,
    "files",
  );

  const packages = [
    {
      id: adapterManifest.id,
      files: adapterFiles,
      manifest: adapterManifest,
      hash: adapterHash,
    },
    {
      id: pf1.manifest.id,
      files: pf1.files,
      manifest: pf1.manifest,
      hash: packageHash(pf1.files),
    },
    {
      id: pf1Content.manifest.id,
      files: pf1Content.files,
      manifest: pf1Content.manifest,
      hash: packageHash(pf1Content.files),
    },
    {
      id: archetypes.manifest.id,
      files: archetypes.files,
      manifest: archetypes.manifest,
      hash: packageHash(archetypes.files),
    },
    {
      id: statblock.manifest.id,
      files: statblock.files,
      manifest: statblock.manifest,
      hash: packageHash(statblock.files),
    },
  ];

  const base = (id, type, name) => ({
    _id: id,
    type,
    name,
    ownership: { default: 2 },
    flags: {},
    system: {},
  });
  const scenario = integral ? await buildRealPf1IntegralScenario({ root, pf1, pf1Content, archetypes, statblock }) : null;
  const scene = scenario?.scene ?? {
    ...base("scene-1", "scene", "PF1 Full"),
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
    ...(scenario?.actors ?? []).map((doc) => ({ coll: "actors", id: doc._id, doc })),
    ...(scenario?.macros ?? []).map(doc => ({ coll: "macros", id: doc._id, doc })),
    ...(scenario?.journals ?? []).map((doc) => ({ coll: "journals", id: doc._id, doc })),
  ];

  const worldEntries = {
    "world.json": json({
      format: 5,
      requiredFeatures: [
        "scene-level-drafts-v1",
        "arena.ais/1",
        "arena.ais.runtime/1",
      ],
      worldId: integral ? "pf1e-unified-starter" : "real-pf1-full",
      name: integral ? "PF1 Unified Starter — Integral Test" : "Real PF1 Full",
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
  const outPath = join(outDir, integral ? "pf1e-integral-test-1.0.0.zip" : "real-pf1-full-1.0.0.zip");
  const archive = zip(worldEntries);
  writeFileSync(outPath, archive);
  if (integral) {
    const starterPath = join(outDir, "pf1e-unified-starter-1.0.0.zip");
    writeFileSync(starterPath, archive);
    console.log("wrote", starterPath);
  }
  console.log("wrote", outPath, "entries", Object.keys(worldEntries).length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await buildRealPf1FullWorld();
