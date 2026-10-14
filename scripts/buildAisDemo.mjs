#!/usr/bin/env node
/** Reproducible, offline build: original pinned Tagger source + world-packaged AIS adapter.
 * No downloads, upstream build scripts or imported code execution. All output stays in dist.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const uint = (value) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
function packageHash(files) {
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const hash = createHash("sha256").update(uint(entries.length));
  for (const [path, text] of entries) {
    const p = Buffer.from(path), body = Buffer.from(text);
    hash.update(uint(p.length)).update(uint(body.length)).update(p).update(body);
  }
  return hash.digest("hex");
}
function fileMap(dir) {
  const files = {};
  const visit = (path, prefix = "") => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) visit(join(path, entry.name), relative + "/");
      else files[relative] = readFileSync(join(path, entry.name), "utf8");
    }
  };
  visit(dir);
  return files;
}
const json = (value) => strToU8(JSON.stringify(value, null, 2));
const zip = (files) => zipSync(files, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });

export async function buildAisDemo(outDir = join(root, "dist")) {
  const guestDir = join(root, "modules/foundry-tagger");
  const provenance = JSON.parse(readFileSync(join(guestDir, "PROVENANCE.json"), "utf8"));
  for (const [path, expected] of Object.entries(provenance.files)) {
    const actual = createHash("sha256").update(readFileSync(join(guestDir, path))).digest("hex");
    if (actual !== expected) throw new Error(`Pinned upstream file changed: ${path}`);
  }
  const result = await build({ configFile: false, logLevel: "silent", build: {
    write: false, minify: false, target: "es2022", sourcemap: false,
    lib: { entry: join(guestDir, "upstream/scripts/module.js"), formats: ["iife"], name: "UpstreamTagger" },
  } });
  const output = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output ?? []);
  const chunks = output.filter((entry) => entry.type === "chunk");
  if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length)
    throw new Error("The feasibility guest must compile to one closed, classic-script program");
  const packages = ["ais-foundry-v13", "foundry-tagger"].map((id) => {
    const files = fileMap(join(root, "modules", id));
    if (id === "foundry-tagger") files["prepared/tagger.js"] = chunks[0].code;
    const manifest = JSON.parse(files["manifest.json"]);
    return { id, files, manifest, hash: packageHash(files) };
  });
  mkdirSync(join(outDir, "packages"), { recursive: true });
  mkdirSync(join(outDir, "worlds"), { recursive: true });
  for (const pkg of packages) {
    const bytes = zip(Object.fromEntries(Object.entries(pkg.files).map(([path, text]) => [path, strToU8(text)])));
    writeFileSync(join(outDir, "packages", `${pkg.id}-${pkg.manifest.version}.zip`), bytes);
  }
  const base = (id, type, name) => ({ _id: id, type, name, ownership: { default: 2 }, flags: {}, system: {} });
  const token = (id, x, tags, hidden = false) => ({ ...base(id, "token", id), x, y: 250,
    rotation: 0, width: 100, height: 100, img: "", hidden, disposition: "neutral", vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 }, taggerTags: tags });
  const scene = { ...base("scene-1", "scene", "AIS Foundry feasibility"), active: true, img: null,
    width: 1400, height: 900, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [token("beacon-one", 250, ["Beacon", "lamp-1"]), token("beacon-two", 450, ["Beacon"]),
      token("hidden-beacon", 650, ["Beacon", "secret"], true)],
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [], regions: [] };
  const user = { ...base("gm", "user", "GM"), ownership: { default: 3 }, role: "GM", character: null, color: "#e0b341" };
  const docs = [{ coll: "users", id: user._id, doc: user }, { coll: "scenes", id: scene._id, doc: scene }];
  const entries = {
    "world.json": json({ format: 5, requiredFeatures: ["scene-level-drafts-v1", "arena.ais/1", "arena.ais.runtime/1"],
      worldId: "ais-foundry-feasibility", name: "AIS Foundry feasibility", system: "mass-battle-basic", version: "1.0.0",
      seq: docs.length, exportedAt: 0, starter: true, rules: { active: null },
      automation: { api: "arena.ais/1", modules: packages.map((pkg) => ({ id: pkg.id, version: pkg.manifest.version, hash: pkg.hash })), providers: {} } }),
    "documents.json": json({ seq: docs.length, docs }),
    "assets.json": json([]),
    "packages.json": json(packages.map((pkg) => ({ id: pkg.id, name: pkg.manifest.name, version: pkg.manifest.version,
      type: "module", importedAt: 0, packCount: 0 }))),
  };
  for (const pkg of packages) for (const [path, text] of Object.entries(pkg.files)) entries[`packages/${pkg.id}/${path}`] = strToU8(text);
  const world = zip(entries);
  const destination = join(outDir, "worlds", "ais-foundry-feasibility-0.1.0.zip");
  writeFileSync(destination, world);
  return { destination, bytes: world.length, packages: packages.map((pkg) => ({ id: pkg.id, hash: pkg.hash })) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const result = await buildAisDemo(i >= 0 ? resolve(process.argv[i + 1]) : undefined);
  console.log(`AIS feasibility: ${result.destination} (${result.bytes} bytes); original source pins verified; no consent exported`);
}
