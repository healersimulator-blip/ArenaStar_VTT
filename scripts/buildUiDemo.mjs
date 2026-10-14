#!/usr/bin/env node
/** Pinned UI-module appearance profiles + a self-opening, portable preview. No upstream entry
 * runs during world import, no foreign CSS reaches the parent document, no CDN is required. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { strToU8, zipSync } from "fflate";
import postcss from "postcss";
import { build } from "vite";
import { uiDemoMap, uiDemoPortrait } from "./uiDemoMap.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const uiCaps = ["runtime.execute", "package.resources.read", "ui.theme"];
const json = (value) => JSON.stringify(value, null, 2);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function hashPackage(files) {
  const hash = createHash("sha256");
  const uint = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  hash.update(uint(entries.length));
  for (const [path, text] of entries) {
    const a = Buffer.from(path), b = Buffer.from(text);
    hash.update(uint(a.length)).update(uint(b.length)).update(a).update(b);
  }
  return hash.digest("hex");
}
const zip = (entries) => zipSync(entries, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });
function readPackage(id) {
  const folder = join(root, "modules", id), files = {};
  const visit = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory()) visit(join(dir, entry.name), path + "/");
      else {
        const bytes = readFileSync(join(dir, entry.name));
        files[path.endsWith(".webp") ? path + ".b64" : path] = bytes.toString(path.endsWith(".webp") ? "base64" : "utf8");
      }
    }
  };
  visit(folder);
  if (files["PROVENANCE.json"]) {
    const proof = JSON.parse(files["PROVENANCE.json"]);
    for (const [path, expected] of Object.entries(proof.files))
      if (digest(readFileSync(join(folder, "upstream", path))) !== expected) throw new Error(`Upstream source changed: ${id}/${path}`);
  }
  return files;
}
export function prepareUiCss(source) {
  const sheet = postcss.parse(source);
  let imports = 0, urls = 0;
  sheet.walkComments((comment) => comment.remove());
  sheet.walkAtRules((rule) => { if (["import", "font-face", "namespace"].includes(rule.name.toLowerCase())) { rule.remove(); imports++; } });
  sheet.walkDecls((declaration) => { if (/url\s*\(/i.test(declaration.value)) { declaration.remove(); urls++; } });
  return { css: sheet.toString(), imports, urls };
}
function cssValue(source, selector, property) {
  let value;
  postcss.parse(source).walkRules((rule) => {
    if (rule.selector !== selector) return;
    rule.walkDecls(property, (declaration) => { value = declaration.value; });
  });
  if (!value) throw new Error(`Pinned CSS declaration not found: ${selector} / ${property}`);
  return value;
}
const title = (id) => id.replace(/^crlngn-theme-/, "").split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join(" ");

export async function buildUiDemo(outDir = join(root, "dist")) {
  const packages = [];
  const providerFiles = readPackage("ais-foundry-ui");
  packages.push({ files: providerFiles, manifest: JSON.parse(providerFiles["manifest.json"]) });
  for (const name of ["your-flavor", "crlngn-ui", "rpg-styled-ui"]) {
    const id = `foundry-ui-${name}`, files = readPackage(id), proof = JSON.parse(files["PROVENANCE.json"]);
    const manifestPath = name === "crlngn-ui" ? "upstream/src/module.json" : "upstream/module.json";
    const upstream = JSON.parse(files[manifestPath]);
    const configuration = { id: upstream.id, styles: [], styleAliases: {},
      uiTheme: { name: name === "your-flavor" ? "Your Flavor" : name === "crlngn-ui" ? "Carolingian" : "RPG Styled UI",
        description: "", mode: "", sourceUrl: proof.repository, sourceVersion: upstream.version, sourceCommit: proof.commit,
        variants: [], swatches: [], exclusions: [] } };
    const resources = [];
    if (name === "your-flavor") {
      // This pinned constants file is pure data; no upstream UI entry point/build scripts run.
      const { FOUNDRY_THEME_PRESETS } = await import(pathToFileURL(join(root, "modules", id, "upstream/scripts/constants.js")).href);
      configuration.mode = "flavor-tokens";
      configuration.uiTheme.description = "Warm, legible surfaces with ten original color palettes.";
      configuration.uiTheme.mode = "Original theme-token JavaScript";
      configuration.uiTheme.variants = FOUNDRY_THEME_PRESETS.map((preset) => ({ id: preset.id, name: title(preset.id) }));
      configuration.uiTheme.swatches = ["#18130f", "#241e18", "#d4872c"];
      configuration.uiTheme.exclusions = ["Studio editor", "chat card templates", "Foundry DOM layout tools", "remote fonts"];
      const result = await build({ configFile: false, logLevel: "silent", build: { write: false, minify: true, target: "es2022",
        lib: { entry: join(root, "modules", id, "binding/engine.js"), name: "UpstreamFlavor", formats: ["iife"] } } });
      const chunks = (Array.isArray(result) ? result : [result]).flatMap((entry) => entry.output).filter((entry) => entry.type === "chunk");
      if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) throw new Error("Theme engine is not a closed bundle");
      files["prepared/engine.js"] = chunks[0].code;
    } else if (name === "crlngn-ui") {
      configuration.mode = "crlngn-css";
      configuration.uiTheme.description = "Cool, restrained chrome with Carolingian's original theme colors.";
      configuration.uiTheme.mode = "Upstream CSS appearance profile";
      const source = files["upstream/src/styles/vars.css"];
      configuration.uiTheme.variants = [{ id: "default", name: "Carolingian Blue" },
        ...[...new Set(source.match(/crlngn-theme-[a-z-]+/g))].map((id) => ({ id, name: title(id) }))];
      configuration.uiTheme.swatches = ["#0b0a13", "#182026", "#4493ad"];
      configuration.uiTheme.exclusions = ["combat carousel", "sidebar and taskbar JavaScript", "camera dock", "system sheets", "remote fonts"];
      const prepared = prepareUiCss(source);
      files["prepared/vars.css"] = prepared.css;
      files["prepared/css-report.json"] = json({ source: "upstream/src/styles/vars.css", ...prepared, css: undefined });
      configuration.styles = ["prepared/vars.css"];
      resources.push(...configuration.styles);
      files["prepared/engine.js"] = "// CSS profile: no upstream Carolingian behavior script is executed.\n";
    } else {
      configuration.mode = "rpg-hooks";
      configuration.uiTheme.description = "Textured fantasy panels and compact controls from RPG Styled UI.";
      configuration.uiTheme.mode = "Original startup hooks + shell artwork";
      configuration.uiTheme.variants = [{ id: "default", name: "RPG dark parchment" }];
      configuration.uiTheme.swatches = ["#181413", "#251f1d", "#9a2619"];
      configuration.uiTheme.exclusions = ["D&D / Shadowdark / Blades sheets", "combat carousel", "navigation reflow", "Foundry branding", "remote fonts"];
      const source = files["upstream/css/rpg-ui.css"];
      configuration.cssFacts = {
        background: cssValue(source, "#chat ::-webkit-scrollbar-track", "background"),
        panel: cssValue(source, "#chat ::-webkit-scrollbar-track", "background"),
        raised: cssValue(source, "#chat ::-webkit-scrollbar-thumb", "background"),
        accent: cssValue(source, "#sidebar a.entity-link,\n#sidebar a.inline-roll", "border").match(/#[a-f0-9]{6}/i)[0],
      };
      configuration.translations = JSON.parse(files["upstream/lang/en.json"]);
      for (const path of ["rpg-ui.css", "compatibility.css"]) {
        const prepared = prepareUiCss(files[`upstream/css/${path}`]);
        files[`prepared/${path}`] = prepared.css;
        configuration.styles.push(`prepared/${path}`);
        configuration.styleAliases[`modules/rpg-styled-ui/css/${path}`] = `prepared/${path}`;
      }
      configuration.images = { panel: "upstream/ui/frames/chat-background.webp.b64", header: "upstream/ui/frames/header.webp.b64", button: "upstream/ui/buttons/button-bg.webp.b64" };
      resources.push(...configuration.styles, ...Object.values(configuration.images));
      // Explicit compatibility recipe: provide the legacy unqualified navigation binding in
      // a private lexical scope. The original executable bytes remain unchanged under upstream/.
      files["prepared/engine.js"] = `/* Original RPG entry in an adapter-owned lexical scope. */\n(function(){ let navigation;\n${files["upstream/scripts/rpg-ui.js"]}\n})();\n`;
    }
    files["compatibility.json"] = json(configuration);
    files["automation/theme.js"] = 'AIS.commands.on("theme", (input, context) => AisUiAdapter.compose(input, context));\n';
    files["manifest.json"] = json({ id, name: configuration.uiTheme.name + " — AIS appearance", version: "0.1.0", type: "module",
      description: configuration.uiTheme.description,
      interconnect: { api: "arena.ais/1", entry: "automation/theme.js", requires: [{ id: "ais-foundry-ui", version: "0.1.0" }],
        runtime: { provider: "ais-foundry-ui", profile: "foundry-ui-v1", scripts: ["prepared/engine.js"], configuration: "compatibility.json", resources },
        capabilities: uiCaps, provides: [{ id: "ui.theme", mode: "exclusive", contract: 1 }], commands: [{ id: "theme", contract: 1 }] } });
    packages.push({ files, manifest: JSON.parse(files["manifest.json"]) });
  }
  mkdirSync(join(outDir, "packages"), { recursive: true }); mkdirSync(join(outDir, "worlds"), { recursive: true });
  for (const pkg of packages) {
    pkg.hash = hashPackage(pkg.files);
    writeFileSync(join(outDir, "packages", `${pkg.manifest.id}-0.1.0.zip`), zip(Object.fromEntries(Object.entries(pkg.files).map(([p, v]) => [p, strToU8(v)]))));
  }
  const base = (id, type, name) => ({ _id: id, type, name, ownership: { default: 2, gm: 3 }, flags: {}, system: {} });
  let map = { ...uiDemoMap(), mime: "image/png" };
  const illustrated = join(root, "Examples/ais-ui-courtyard.jpg");
  if (existsSync(illustrated)) {
    const bytes = readFileSync(illustrated);
    let position = 2;
    while (position < bytes.length) {
      if (bytes[position] !== 255) { position++; continue; }
      const marker = bytes[position + 1]; position += 2;
      if ([0xc0,0xc1,0xc2].includes(marker)) {
        map = { bytes, width: bytes.readUInt16BE(position + 5), height: bytes.readUInt16BE(position + 3), mime: "image/jpeg" }; break;
      }
      position += bytes.readUInt16BE(position);
    }
    if (map.mime !== "image/jpeg") throw new Error("Demo illustration has no supported JPEG dimensions");
  }
  const mapId = digest(map.bytes);
  const portraits = [0,1,2].map((index) => { const bytes = uiDemoPortrait(index); return { bytes, hash: digest(bytes), mime: "image/png", name: `Original portrait ${index+1}.png` }; });
  const actors = ["Mira Dawn", "Rowan Ash", "The Warden"].map((name, i) => ({ ...base(`actor-ui-${i}`, "actor", name),
    img: portraits[i].hash, items: [], effects: [], system: { pf1e: { hp: [24, 32, 45][i], hpMax: [24, 32, 45][i], level: 3 } } }));
  const scene = { ...base("scene-ui", "scene", "Alderwatch Courtyard"), active: true, img: mapId,
    width: map.width, height: map.height, darkness: 0, flags: { core: { scale: "tactical" } },
    grid: { type: "gridless", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: actors.map((actor, i) => ({ ...base(`hero-${i}`, "token", actor.name), actorId: actor._id,
      x: [0.34, 0.56, 0.68][i] * map.width, y: [0.56, 0.65, 0.40][i] * map.height, width: 70, height: 70, rotation: 0, img: portraits[i].hash, hidden: false,
      disposition: i === 2 ? "hostile" : "friendly", vision: true, light: { radius: 0, color: "#ffffff", alpha: 0.5 } })),
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [], regions: [] };
  const user = { ...base("gm", "user", "GM"), role: "GM", character: null, color: "#79d1bd" };
  const settings = { ...base("ais-ui-appearance", "settings", "Interface appearance"), system: { selected: null, variant: "default", density: "compact", sidebarWidth: 300 } };
  const messages = [
    ["Welcome to Alderwatch", "A quiet courtyard, three travelers, and a table ready to play. The world is already loaded—no download or file picker needed."],
    ["Choose your interface", "Use the palette button above. Your Flavor uses its original token engine; RPG runs its original startup hooks; Carolingian supplies its CSS theme colors."],
  ].map(([name, content], i) => ({ ...base(`ui-intro-${i}`, "message", name), author: "gm", content, whisper: [], roll: null, flavor: name }));
  const documents = [user, scene, settings, ...actors, ...messages];
  const collections = { user: "users", scene: "scenes", settings: "settings", actor: "actors", message: "messages" };
  const docs = documents.map((doc) => ({ coll: collections[doc.type], id: doc._id, doc }));
  const entries = {
    "world.json": strToU8(json({ format: 5, requiredFeatures: ["scene-level-drafts-v1", "arena.ais/1", "arena.ais.runtime/1"],
      worldId: "ais-ui-laboratory", name: "Alderwatch · UI module laboratory", system: "mass-battle-basic", version: "1.0.0", seq: docs.length,
      exportedAt: 0, starter: true, rules: { active: null }, automation: { api: "arena.ais/1", modules: [], providers: {} } })),
    "documents.json": strToU8(json({ seq: docs.length, docs })),
    "assets.json": strToU8(json([{ hash: mapId, name: "Alderwatch courtyard", mime: map.mime, bytes: map.bytes }, ...portraits].map(({ bytes, ...asset }) =>
      ({ ...asset, size: bytes.length, chunks: Math.ceil(bytes.length / 32768), visibility: "referenced" })))),
    [`assets/${mapId}`]: map.bytes,
    "packages.json": strToU8(json(packages.map(({ manifest }) => ({ id: manifest.id, name: manifest.name, version: manifest.version, type: "module", importedAt: 0, packCount: 0 })))),
  };
  for (const portrait of portraits) entries[`assets/${portrait.hash}`] = portrait.bytes;
  for (const pkg of packages) for (const [path, text] of Object.entries(pkg.files)) entries[`packages/${pkg.manifest.id}/${path}`] = strToU8(text);
  const bytes = zip(entries), filename = join(outDir, "worlds/ais-ui-laboratory-0.1.0.zip"); writeFileSync(filename, bytes);
  const index = join(outDir, "index.html");
  if (existsSync(index)) {
    const data = json({ id: "ais-ui-laboratory", sha256: digest(bytes), archive: Buffer.from(bytes).toString("base64") });
    const preview = readFileSync(index, "utf8").replace('<div id="app"></div>', `<script type="application/json" id="arena-demo-world">${data}</script><div id="app"></div>`);
    mkdirSync(join(outDir, "preview"), { recursive: true });
    writeFileSync(join(outDir, "preview/index.html"), preview);
    writeFileSync(join(outDir, "ui-demo.html"), preview);
  }
  return { filename, bytes: bytes.length, packages: packages.length, mapBytes: map.bytes.length };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--out");
  console.log(await buildUiDemo(flag >= 0 ? resolve(process.argv[flag + 1]) : undefined));
}
