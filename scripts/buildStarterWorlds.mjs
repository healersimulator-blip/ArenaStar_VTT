#!/usr/bin/env node
/**
 * D-249 starter worlds: one importable world file per strategic ruleset package —
 * `dist/worlds/<id>-starter-<version>.zip`. A starter is a format-2 world archive
 * (`src/host/worldFile.ts`) with NO documents (seq 0 — the host seeds the default scene on first
 * boot, exactly like a brand-new world), the ruleset installed and active, and every content
 * pack it declares as a dependency installed beside it. `world.json.starter = true` makes the
 * start screen open it as a fresh copy every time, so a starter never asks "replace?".
 *
 * Why a world file and not a package: the tester's complaint was three zips to load in the
 * right order. A GM now downloads one file, opens it, and is in a PF1e strategic world — the
 * same file the New-world wizard would have produced from the two packages.
 *
 * Package folders are read from `systems/<id>/` and must already contain their built entries
 * (`pnpm build:systems` first — `rules.js` is a build product). The writer is deliberately a
 * few lines of plain JS rather than a bundle of the TS exporter; `tests/scripts/
 * buildStarterWorlds.test.ts` imports the result through the real `importWorldZip`, which is the
 * parity check that matters.
 *
 * Usage:  node scripts/buildStarterWorlds.mjs [--only <packageId>] [--systems-dir <dir>]
 *         [--out <dir>] [--content-dir <dir>] [--dry-run]
 *
 * `--content-dir` (default dist/content/pf1e — the `pnpm content:convert` output) adds the
 * TESTER starter: the mass-battles ruleset + pf1e-core + the converted content, with a
 * pre-placed tactical + strategic + overland scenario and a tester guide. Missing
 * content dir ⇒ the tester is skipped with a note (fresh clones build the plain starter only).
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Must match `WORLD_FILE_FORMAT` in src/host/worldFile.ts. */
export const STARTER_WORLD_FORMAT = 2;

/**
 * Starter recipes. Keyed by the strategic ruleset (`type: "system"`) package; `content` lists
 * the data packages installed with it — by default the ruleset's declared `dependencies` that
 * exist under systems/. A ruleset without an entry here still gets a starter from its manifest.
 */
const STARTERS = {
  "pf1e-mass-battles": { name: "Pathfinder 1e Mass Battles — starter" },
};

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
 * Read a package manifest. `expectedId` enforces manifest.id === folder name (the systems/
 * layout); the converted content package lives in dist/content/pf1e with id "pf1e-content",
 * so the caller omits it there (the archive is keyed by manifest.id, not the folder name).
 */
function readManifestFromDir(dir, expectedId = null) {
  const path = join(dir, "manifest.json");
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (expectedId !== null && manifest.id !== expectedId) {
    throw new Error(`${expectedId}: manifest.id "${manifest.id}" must equal the folder name`);
  }
  return manifest;
}

function readManifest(systemsDir, id) {
  return readManifestFromDir(join(systemsDir, id), id);
}

/** A package folder as `packages/<id>/…` archive entries, verifying the manifest's declared files. */
function packageEntriesFromDir(dir, manifest) {
  const files = listPackageFiles(dir);
  for (const [label, path] of [
    ["rules.entry", manifest.rules?.entry],
    ["module.entry", manifest.module?.entry],
    ...[...(manifest.packs ?? [])].map((pack) => [`pack ${pack.name}`, pack.file]),
  ]) {
    if (path === undefined) continue;
    if (!files.includes(path)) {
      throw new Error(
        `${manifest.id}: manifest declares ${label} "${path}" — missing from ${dir}` +
          (label === "rules.entry" ? " (run `pnpm build:systems` first)" : ""),
      );
    }
  }
  const entries = {};
  for (const rel of files) {
    entries[`packages/${manifest.id}/${rel}`] = strToU8(readFileSync(join(dir, rel), "utf8"));
  }
  return { files, entries };
}

/**
 * Assemble the archive entries for a starter (pure; no I/O beyond reading package folders).
 * Returns { id, worldId, name, version, files: string[], zip: Uint8Array, packages: string[] }.
 *
 * opts: { now, contentDir, nameOverride, worldIdSuffix, docs } — the tester starter passes an
 * extra content package dir (the converted PF1e content, e.g. dist/content/pf1e), a suffix, and
 * pre-placed documents; the plain starter passes none of them (seq 0, docs []).
 */
function assembleArchive(systemsDir, rulesetId, opts = {}) {
  const now = opts.now ?? 0; // deterministic bytes: a starter has no meaningful timestamps
  const ruleset = readManifest(systemsDir, rulesetId);
  if (!ruleset) throw new Error(`${rulesetId}: no manifest.json`);
  if (ruleset.type !== "system" || !ruleset.rules?.entry) {
    throw new Error(`${rulesetId}: a starter needs a strategic ruleset (type "system" with rules.entry)`);
  }
  const recipe = STARTERS[rulesetId] ?? {};
  const contentIds =
    recipe.content ??
    [...(ruleset.dependencies ?? [])].filter((dep) => readManifest(systemsDir, dep) !== null);
  const manifests = [ruleset];
  for (const dep of contentIds) {
    const m = readManifest(systemsDir, dep);
    if (!m) throw new Error(`${rulesetId}: starter content ${dep} has no manifest.json`);
    if (m.type !== "data") {
      throw new Error(`${rulesetId}: starter content ${dep} is a ${m.type} package, not a content pack`);
    }
    manifests.push(m);
  }
  // Extra content package from its own folder (the converted PF1e content for the tester).
  const extraContent = opts.contentDir ? readManifestFromDir(resolve(opts.contentDir)) : null;
  if (opts.contentDir && !extraContent) {
    throw new Error(`content dir ${opts.contentDir}: no manifest.json`);
  }
  const extraDirs = [];
  if (extraContent) {
    if (extraContent.type !== "data") {
      throw new Error(`${extraContent.id} is a ${extraContent.type} package, not a content pack`);
    }
    manifests.push(extraContent);
    extraDirs.push(resolve(opts.contentDir));
  }

  const worldId = `starter-${rulesetId}${opts.worldIdSuffix ?? ""}`;
  const name = opts.nameOverride ?? recipe.name ?? `${ruleset.name} — starter`;
  const docRows = (opts.docs ?? []).map(docRow);
  const entries = {};
  const json = (value) => strToU8(JSON.stringify(value, null, 2));
  entries["world.json"] = json({
    format: STARTER_WORLD_FORMAT,
    worldId,
    name,
    system: ruleset.id,
    version: ruleset.version,
    seq: docRows.length,
    exportedAt: now,
    rules: { active: ruleset.id },
    starter: true,
  });
  entries["documents.json"] = json({ seq: docRows.length, docs: docRows });
  entries["assets.json"] = json([]);
  entries["packages.json"] = json(
    manifests.map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      type: m.type,
      importedAt: now,
      packCount: m.packs?.length ?? 0,
    })),
  );
  const files = [];
  for (const [i, m] of manifests.entries()) {
    const dir = i < manifests.length - extraDirs.length
      ? join(systemsDir, m.id)
      : extraDirs[i - (manifests.length - extraDirs.length)];
    const pkg = packageEntriesFromDir(dir, m);
    Object.assign(entries, pkg.entries);
    files.push(...pkg.files.map((f) => `packages/${m.id}/${f}`));
  }
  const zip = zipSync(entries, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });
  return {
    id: opts.idOverride ?? rulesetId,
    worldId,
    name,
    version: ruleset.version,
    files: ["world.json", "documents.json", "assets.json", "packages.json", ...files],
    packages: manifests.map((m) => m.id),
    zip,
  };
}

/** Assemble the plain (document-less) starter for one strategic ruleset. */
export function buildStarterArchive(systemsDir, rulesetId, opts = {}) {
  const docs = opts.docs ?? (rulesetId === "pf1e-mass-battles" ? testerDocuments(null) : []);
  return assembleArchive(systemsDir, rulesetId, { ...opts, docs });
}

// ─── tester starter: rulesets + converted content + a playable scenario ────────

/** A BaseDocument with the shared fields pre-filled (ownership OBSERVER, empty flags/system). */
function baseDoc(id, type, name, extra = {}) {
  return {
    _id: id,
    type,
    name,
    ownership: { default: 2 },
    flags: {},
    system: {},
    ...extra,
  };
}

function sceneDoc2(id, name, width, height, flags = {}, tokens = [], notes = [], active = false) {
  return baseDoc(id, "scene", name, {
    active,
    img: null,
    width,
    height,
    darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens,
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes,
    flags,
  });
}

/** Top-level collection for a document type (the documents.json rows are { coll, id, doc }). */
const COLL_OF_TYPE = {
  user: "users",
  scene: "scenes",
  actor: "actors",
  faction: "factions",
  army: "armies",
  journal: "journals",
  encounterTable: "encounterTables",
};

function docRow(doc) {
  const coll = COLL_OF_TYPE[doc.type];
  if (!coll) throw new Error(`tester document ${doc._id}: no collection for type "${doc.type}"`);
  return { coll, id: doc._id, doc };
}

function tokenDoc(id, name, x, y, actorId, disposition) {
  return baseDoc(id, "token", name, {
    // D-061 tabletop default (hostBoot.makeToken): players see & move
    ownership: { default: 3, gm: 3 },
    x,
    y,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    actorId,
    hidden: false,
    disposition,
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  });
}

function unitDoc(id, type, name, extra = {}) {
  return {
    ...baseDoc(id, type, name),
    profile: {},
    formation: "line",
    sceneId: "scene-2",
    modelRange: null,
    orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
    stats: { strength: 10, morale: 10, supply: 10, fatigue: 0 },
    ...extra,
  };
}

const TESTER_HERO_PF1E = {
  size: "Medium",
  speedFt: 30,
  abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 10, cha: 8 },
  baseAttack: 3,
  armor: { armorBonus: 6, shieldBonus: 2, maxDexBonus: 0, checkPenalty: -2, spellFailure: 0 },
  saves: { fort: 4, ref: 1, will: 0 },
  savesAsTotal: true,
  hp: 18,
  hpMax: 18,
  attacks: [{ name: "Longsword", damageDice: "1d8", damageType: "slashing", critThreatMin: 19, critMultiplier: 2 }],
  feats: ["Power Attack"],
  traits: ["human"],
  notes: "Fighter 3 — the tester hero. AC 19 = 10 + Dex 1 + armor 6 + shield 2; BAB +3.",
};

/** Hand-written fallback if the converted pack is missing its Goblin (keeps the tester buildable). */
const TESTER_GOBLIN_PF1E = {
  size: "Small",
  speedFt: 30,
  abilities: { str: 13, dex: 11, con: 12, int: 10, wis: 9, cha: 8 },
  hp: 4,
  hpMax: 4,
  saves: { fort: 1, ref: 1, will: 0 },
  savesAsTotal: true,
  attacks: [{ name: "Scimitar", damageDice: "1d6", damageType: "slashing", critThreatMin: 18, critMultiplier: 2 }],
  notes: "Goblin — Basic NPC (hand-written fallback).",
};

/**
 * The Goblin's `system.pf1e` block, read from the CONVERTED pack (packs/basic-npcs.json in the
 * content dir) so the tester world demonstrates pack → actor data flow. Fallback when absent.
 */
function goblinPf1eFromPack(contentDir) {
  try {
    const pack = JSON.parse(readFileSync(join(contentDir, "packs", "basic-npcs.json"), "utf8"));
    const goblin = (pack.entries ?? []).find((e) => e.name === "Goblin");
    const pf1e = goblin?.data?.system?.pf1e;
    return pf1e && typeof pf1e === "object" && Object.keys(pf1e).length > 0 ? pf1e : TESTER_GOBLIN_PF1E;
  } catch {
    return TESTER_GOBLIN_PF1E;
  }
}

const TESTER_GUIDE = `# PF1e tester world — what to test

This world bundles three things at once: the **PF1e tactical content** (pf1e-core), the
**PF1e strategic ruleset** (pf1e-mass-battles — active), and the **converted PF1e content
packs** (pf1e-content — spells, feats, classes, items, rules, roll tables, …).

## 1. Tactical — Scene 1 (Goblin Skirmish)
- Open **Ser Aldric Vane** (Fighter 3) — the sheet's summary / attributes / combat / weapons /
  armor / features tabs; AC 19, BAB +3, Longsword 1d8 crit 19–20 ×2.
- Roll an attack and note damage; the two goblins come from the converted Basic NPCs pack.
- Fog: explore, then leave and re-enter the scene — the explored fog is kept per user (D-250).

## 2. Strategic — Scene 2 (Battle of the Ford)
- Open the Army window: **Hero's Army** (infantry + hero unit) vs **Goblin Warband**
  (2 infantry, cavalry, artillery).
- Issue orders (move / attack / hold / formation), run turns (orders → resolution → report).
- The hero unit is linked to the Scene 1 token (leaderTokenId) — leadership auras apply.
- The scene note links back to the tactical scene (linkedSceneId).

## 3. Overland — Scene 3 (The Hollow Reach)
- Open **Overland — The Hollow Reach** from the scene rail: 28 authored hexes, one hex = 6 miles,
  every one with a description, a player-facing line, and — where there is something to find — a
  hidden feature with a rule that uncovers it (Perception DC, hours spent, a dice check, or the
  GM's own say-so).
- **Right-click a hex** for its menu. **Shift+H** opens the hex you are standing in.
- **Y** arms *Travel path*: click hexes, **Commit route**, and the panel prices the route off the
  terrain — forest 2 h a hex, plains 1 h, a road crosses as open ground whatever it runs through.
- Spend hours with the travel panel: the **world clock** advances, the party walks as far as that
  buys, night falls when it falls, and an encounter check fires where the tables are attached.
- Four encounter tables ship with it (road, forest, fen, downs) and are wired to the hexes that
  should roll them. The **traveller's guide** journal lists every hex, every rumour, and every
  hidden feature with the rule that finds it.

## 4. Content packs — compendium searches to try
- "fireball" → PF1e Spells (Core): level table, school, descriptors, save.
- "power attack" → PF1e Feats (Core + Expanded): categories, raw Foundry data under system.foundry.
- "abjurant salt" → PF1e Wondrous Items: armor block + item hp/hardness.
- "barbarian" → PF1e Classes (Core): the 20-level BAB/save table.
- "how to play" / "combat" → PF1e Rules (Reference / Core): markdown rulebook pages.
- roll tables → PF1e Ultimate Equipment + Roll Tables (Core).
- actors: Goblin (basic NPC), Allosaurus (companion), deities, artifacts.

## 5. Export round-trip
Export this world to a zip and re-import it: all 17 pre-placed documents — three scenes, the armies
and their units, the encounter tables and their hexes, the journals — the three packages, the active
ruleset, and the explored fog must come back identical.
`;

// ─── the Hollow Reach: a hexcrawl the starter world ships complete ────────────
//
// A starter world that let a tester *read* about the hexcrawl without ever standing on one is a
// starter world that hides half of what the app can do. So the region ships as **content** —
// `content/hexcrawl/hollow-reach.json`, in the shape an adventure author would write it (a hex
// per entry: name, terrain, what is there, what the party is told, what is hidden and by what
// rule) — and this block converts it into the documents the app actually stores: one scene with
// its cells embedded, four encounter tables, and a traveller's guide.
//
// Keeping the prose out of code is the point: the region can be edited, extended or replaced
// without touching the build, and `tests/scripts/buildStarterWorlds.test.ts` boots the result
// through the real importer to prove the conversion still lands.
const HEXCRAWL_CONTENT = join(repoRoot, "content", "hexcrawl", "hollow-reach.json");

const SQRT3 = Math.sqrt(3);

/**
 * The centre of an odd-Q hex, mirroring `canvas/grid/hex.ts` (`offsetToAxial` +
 * `axialToPixel`). The writer is plain JS and cannot import the TS geometry module, so the
 * formula is restated here and *checked* instead: the starter-world test asks `cellAtPoint`
 * which hex each authored cell's centre falls in, and a mismatch fails the build.
 */
function hexCenterPixels(size, q, r) {
  const b = r - (q - (q & 1)) / 2;
  return { x: 1.5 * size * q, y: SQRT3 * size * (b + q / 2) };
}

/** Read the region, throwing with the path when it is missing or malformed (never a silent skip). */
export function readHexcrawlContent(file = HEXCRAWL_CONTENT) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw.hexes) || raw.hexes.length === 0) {
    throw new Error(`${file}: no hexes`);
  }
  return raw;
}

/** One authored cell, as the document the canvas, the projection and the world file all read. */
function hexcrawlCellDoc(content, hex, index) {
  const features = (hex.features ?? []).map((feature) => ({
    id: feature.id,
    name: feature.name,
    text: feature.text,
    reveal: feature.reveal,
    autoReveal: feature.autoReveal !== false,
    // Nothing is found before a party finds it: the starter ships the *rules*, not the answers.
    state: { revealed: false },
  }));
  return baseDoc(`cell-${hex.key.replace(",", "-")}-${index}`, "cell", hex.name, {
    key: hex.key,
    ...(hex.terrain ? { terrain: hex.terrain } : {}),
    ...(hex.description ? { description: hex.description } : {}),
    ...(hex.playerText ? { playerText: hex.playerText } : {}),
    ...(hex.tables && hex.tables.length > 0 ? { tables: [...hex.tables] } : {}),
    ...(features.length > 0 ? { features } : {}),
  });
}

/** An encounter table, one row per drawable outcome, exactly as the editor stores it. */
function hexcrawlTableDoc(table) {
  const entries = table.entries.map((entry) => ({
    weight: entry.weight ?? 1,
    ...(entry.range ? { range: [entry.range[0], entry.range[1]] } : {}),
    text: entry.text,
    count: entry.count ?? 0,
    refs: entry.refs ?? [],
  }));
  return baseDoc(table.id, "encounterTable", table.name, {
    mode: table.mode === "dice" ? "dice" : "weighted",
    formula: table.formula ?? "",
    entries,
    tags: table.tags ?? {
      day: true,
      night: true,
      entering: true,
      moving: true,
      exploring: false,
      fighting: false,
    },
    ...(typeof table.cooldownSeconds === "number" ? { cooldownSeconds: table.cooldownSeconds } : {}),
  });
}

/** The region's guide: what it is, how to walk it, what the rumours are, and what is in each hex. */
function hexcrawlGuideMarkdown(content) {
  const terrainNames = {
    plains: "plains",
    road: "road",
    hills: "hills",
    forest: "forest",
    marsh: "marsh",
    mountains: "mountains",
    water: "water",
    city: "town",
  };
  const lines = [
    `# ${content.name}`,
    "",
    content.subtitle ?? "",
    "",
    content.blurb ?? "",
    "",
    `**${content.hexes.length} hexes · one hex is ${content.scene.distance} ${content.scene.units}.** ` +
      `**${content.party.name}** starts at ${content.hexes.find((h) => h.key === content.party.start)?.name ?? content.party.start}.`,
    "",
    "## How to walk it",
    "",
    `- Open the scene **Overland — ${content.name}** from the scene rail.`,
    "- **Right-click a hex** for its menu: description, terrain, features, tables.",
    "- **Shift+H** opens the hex the party is standing in.",
    "- **Y** arms *Travel path*; click the hexes you want, then **Commit route**. The panel prices",
    "  the route cell by cell off the terrain — forest is two hours a hex at a normal pace, plains",
    "  one, and a road crosses as open ground whatever it runs through.",
    "- The travel buttons then spend the **world clock**: the party walks as far as that buys and",
    "  camps where the road ends. Night falls when the clock says it does.",
    "- Every hex keeps the hours the party spent in it, which is what a hidden feature's *time*",
    "  rule reads. A shrine that wants two days of travelling gives itself up on the third.",
    "",
    "## Rumours in Gallows Ford",
    "",
    ...(content.rumours ?? []).map((rumour, i) => `${i + 1}. ${rumour}`),
    "",
    "## The hexes",
    "",
    "| Hex | Where | Terrain | What is there |",
    "|---|---|---|---|",
    ...content.hexes.map((hex) => {
      const first = (hex.description ?? "").split(/(?<=\.)\s/)[0] ?? "";
      return `| ${hex.key} | **${hex.name}** | ${terrainNames[hex.terrain] ?? hex.terrain} | ${first.replace(/\|/g, "/")} |`;
    }),
    "",
    "## What is hidden, and by what rule",
    "",
    ...(content.hexes.flatMap((hex) =>
      (hex.features ?? []).map((feature) => {
        const rule =
          feature.reveal.kind === "perception"
            ? `Perception DC ${feature.reveal.dc}${feature.reveal.active ? " (rolled)" : " (passive)"}`
            : feature.reveal.kind === "time"
              ? `${Math.round(feature.reveal.seconds / 3600)} h spent in the hex`
              : feature.reveal.kind === "dice"
                ? `${feature.reveal.formula} vs ${feature.reveal.target}`
                : "the GM decides";
        return `- **${feature.name}** (${hex.name}, ${hex.key}) — ${rule}${feature.autoReveal === false ? "; the GM ticks it, the rule only says when" : ""}.`;
      }),
    )),
    "",
  ];
  return lines.join("\n");
}

/**
 * The region as documents: the scene (cells embedded, party token on it, the profile as
 * `flags.core.hexcrawl`), the encounter tables, and the guide.
 *
 * The scene is **not** active — the starter still opens on the tactical skirmish, and the guide
 * says where the overland map is.
 */
export function hexcrawlDocuments(file = HEXCRAWL_CONTENT) {
  const content = readHexcrawlContent(file);
  const { width, height, cellSize, distance, units, layout } = content.scene;
  const partyId = "tok-party";
  const start = content.hexes.find((h) => h.key === content.party.start) ?? content.hexes[0];
  const [sq, sr] = String(start.key).split(",").map(Number);
  const centre = hexCenterPixels(cellSize, sq, sr);
  const cells = content.hexes.map((hex, index) => hexcrawlCellDoc(content, hex, index));
  const tables = (content.tables ?? []).map(hexcrawlTableDoc);
  const party = tokenDoc(partyId, content.party.name, Math.round(centre.x), Math.round(centre.y), null, "friendly");
  const pin = baseDoc("note-hex-start", "note", "The Company starts here", {
    x: Math.round(centre.x),
    y: Math.round(centre.y - 60),
    text: `${content.party.name} begins at ${start.name}. Right-click any hex to work on it; \`Y\` draws a travel path.`,
    icon: "\u{1F6A0}",
    visible: true,
  });
  const scene = baseDoc("scene-3", "scene", `Overland — ${content.name}`, {
    active: false,
    img: null,
    width,
    height,
    darkness: 0,
    grid: {
      type: "hex",
      size: cellSize,
      distance,
      units,
      diagonals: "555",
      hexLayout: layout,
    },
    tokens: [party],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [pin],
    cells,
    flags: {
      core: {
        hexcrawl: {
          version: 1,
          revealed: [...(content.revealed ?? [])],
          sight: {
            mode: content.sight?.mode === "gm" ? "gm" : "gm+party",
            radiusCells: content.sight?.radiusCells ?? 1,
            radiusWorldUnits: 0,
          },
          partyTokenId: partyId,
          encounterMode: "prompt",
          encounterAnnounce: "names",
          daylight: content.daylight ?? { dawnHour: 6, duskHour: 20 },
          terrain: "pf1e-overland",
          travel: null,
        },
      },
    },
  });
  const guide = baseDoc("journal-hollow-reach", "journal", `${content.name} — a traveller's guide`, {
    pages: [{ name: content.name, text: hexcrawlGuideMarkdown(content), src: null }],
  });
  return [scene, ...tables, guide];
}

/**
 * The pre-placed documents of the tester world, in deterministic order. `contentDir` is the
 * built content package (dist/content/pf1e) — the Goblin actor is read from its pack.
 */
function testerDocuments(contentDir) {
  const goblinPf1e = goblinPf1eFromPack(contentDir);
  const heroToken = tokenDoc("tok-hero", "Ser Aldric Vane", 500, 500, "hero", "friendly");
  const goblinAToken = tokenDoc("tok-goblin-a", "Goblin", 700, 450, "goblin-a", "hostile");
  const goblinBToken = tokenDoc("tok-goblin-b", "Goblin 2", 700, 550, "goblin-b", "hostile");
  const welcomeNote = baseDoc("note-welcome", "note", "Start here", {
    x: 200,
    y: 200,
    text: "Welcome to the PF1e tester world. The full guide is in the Journal. This tactical scene is a small skirmish: three tokens, fog, and a Fighter 3 to sheet.",
    icon: "🚩",
    // D-256: a pin is hidden until the GM publishes it. These two ship published.
    visible: true,
  });
  const linkNote = baseDoc("note-link", "note", "Tactical view", {
    x: 200,
    y: 200,
    text: "Strategic scene — order the armies in the Army window and run turns. The tactical detail of the hero is in the linked scene.",
    icon: "🗺️",
    linkedSceneId: "scene-1",
    visible: true, // D-256
  });

  return [
    // the GM user — id "gm" must match the host's GM_USER_ID, since a seeded world skips seeding
    baseDoc("gm", "user", "GM", {
      ownership: { default: 3 },
      role: "GM",
      character: null,
      color: "#e0b341",
    }),
    sceneDoc2("scene-1", "Tactical — Goblin Skirmish", 2000, 1500, {}, [heroToken, goblinAToken, goblinBToken], [welcomeNote], true),
    sceneDoc2("scene-2", "Strategic — Battle of the Ford", 3000, 2250, { core: { scale: "strategic" } }, [], [linkNote]),
    baseDoc("hero", "actor", "Ser Aldric Vane", {
      system: { pf1e: TESTER_HERO_PF1E },
      items: [],
      effects: [],
    }),
    baseDoc("goblin-a", "actor", "Goblin", { system: { pf1e: goblinPf1e }, items: [], effects: [] }),
    baseDoc("goblin-b", "actor", "Goblin 2", { system: { pf1e: goblinPf1e }, items: [], effects: [] }),
    baseDoc("faction-hero", "faction", "The Company", { color: "#4a90d9", allies: [] }),
    baseDoc("faction-foe", "faction", "Goblin Warband", { color: "#d9534f", allies: [] }),
    baseDoc("hero-army", "army", "Hero's Army", {
      factionId: "faction-hero",
      commander: ["gm"],
      supply: {},
      units: [
        unitDoc("unit-hero-infantry", "infantry", "Vanguard Infantry"),
        unitDoc("unit-hero", "hero", "Hero", { leaderTokenId: "tok-hero", stats: { strength: 12, morale: 12, supply: 10, fatigue: 0 } }),
      ],
    }),
    baseDoc("enemy-army", "army", "Goblin Warband Army", {
      factionId: "faction-foe",
      commander: ["gm"],
      supply: {},
      units: [
        unitDoc("unit-foe-infantry-1", "infantry", "Goblin Raiders", { stats: { strength: 8, morale: 6, supply: 8, fatigue: 0 } }),
        unitDoc("unit-foe-infantry-2", "infantry", "Goblin Spearmen", { stats: { strength: 9, morale: 7, supply: 8, fatigue: 0 } }),
        unitDoc("unit-foe-cavalry", "cavalry", "Goblin Dogs", { stats: { strength: 7, morale: 8, supply: 8, fatigue: 0 } }),
        unitDoc("unit-foe-artillery", "artillery", "Goblin Slingers", { stats: { strength: 5, morale: 6, supply: 8, fatigue: 0 } }),
      ],
    }),
    baseDoc("journal-welcome", "journal", "Tester Guide", {
      pages: [{ name: "PF1e tester world — what to test", text: TESTER_GUIDE, src: null }],
    }),
    // The overland region: a hexcrawl scene with 28 authored hexes, four encounter tables and a
    // traveller's guide, so a tester can walk before they author.
    ...hexcrawlDocuments(),
  ];
}

/**
 * The tester starter: the mass-battles ruleset (active) + pf1e-core + the converted PF1e
 * content package, with a pre-placed tactical + strategic scenario and a tester guide.
 * Returns the same record shape as buildStarterArchive (id suffixed "-tester").
 */
export function buildTesterStarterArchive({ systemsDir, contentDir }) {
  return assembleArchive(systemsDir, "pf1e-mass-battles", {
    contentDir,
    idOverride: "pf1e-mass-battles-tester",
    nameOverride: "Pathfinder 1e Mass Battles — tester",
    worldIdSuffix: "-tester",
    docs: testerDocuments(resolve(contentDir)),
  });
}

/**
 * Build every starter (one per strategic ruleset under systems/) — and, when `contentDir`
 * names a built content package (the converted PF1e content, e.g. dist/content/pf1e), the
 * tester starter for mass-battles as well. Returns one record per starter:
 * { id, worldId, name, version, packages, files, zip: path|null }.
 */
export async function buildStarterWorlds(opts = {}) {
  const {
    dryRun = false,
    only = null,
    systemsDir = join(repoRoot, "systems"),
    outDir = join(repoRoot, "dist/worlds"),
    contentDir = null,
  } = opts;
  const writeZip = (built, fileName) => {
    if (dryRun) return null;
    const zipPath = join(outDir, fileName);
    mkdirSync(dirname(zipPath), { recursive: true });
    writeFileSync(zipPath, built.zip);
    console.log(
      `${built.id}: "${built.name}" (${built.packages.join(" + ")}) → ${relative(repoRoot, zipPath)} (${(built.zip.length / 1024).toFixed(1)} kB)`,
    );
    return zipPath;
  };
  const results = [];
  for (const id of listPackageDirs(systemsDir)) {
    if (only !== null && only !== id) continue;
    const manifest = readManifest(systemsDir, id);
    if (!manifest || manifest.type !== "system" || !manifest.rules?.entry) continue;
    // Keep the built-in starter playable even when the optional converted content checkout is
    // unavailable. The PF1e Core package still supplies the compendia; these seeded documents
    // provide the hero, enemy actors, scene tokens, and tester guide for real browser testing.
    const built = buildStarterArchive(systemsDir, id, {
      docs: id === "pf1e-mass-battles" ? testerDocuments(null) : [],
    });
    results.push({ ...built, zip: writeZip(built, `${id}-starter-${built.version}.zip`) });
  }
  // The tester starter needs the converted content — skip quietly when it is not built
  // (fresh clone: `pnpm content:convert` first). `only` filters the regular starters only.
  if (contentDir !== null && statSync(contentDir, { throwIfNoEntry: false })?.isDirectory()) {
    if (only === null || only === "pf1e-mass-battles-tester") {
      const tester = buildTesterStarterArchive({ systemsDir, contentDir });
      results.push({ ...tester, zip: writeZip(tester, `${tester.id}-${tester.version}.zip`) });
    }
  } else if (contentDir !== null) {
    console.warn(
      `note: content dir ${relative(repoRoot, contentDir)} not found — skipping the tester starter (run \`pnpm content:convert\` first)`,
    );
  }
  return results;
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]).endsWith("buildStarterWorlds.mjs");
if (isCli) {
  const argv = process.argv.slice(2);
  const argOf = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  const only = argOf("--only");
  const out = argOf("--out");
  const systemsDir = argOf("--systems-dir");
  // The converted content package — built by `pnpm content:convert` (tools/convert/).
  const contentDir =
    argOf("--content-dir") ??
    process.env.VTT_CONTENT_DIR ??
    join(repoRoot, "dist", "content", "pf1e");
  try {
    const built = await buildStarterWorlds({
      dryRun: argv.includes("--dry-run"),
      ...(only !== null ? { only } : {}),
      ...(out !== null ? { outDir: resolve(repoRoot, out) } : {}),
      ...(systemsDir !== null ? { systemsDir: resolve(repoRoot, systemsDir) } : {}),
      contentDir: resolve(repoRoot, contentDir),
    });
    if (built.length === 0) {
      console.error("no strategic ruleset packages found under systems/");
      process.exit(1);
    }
  } catch (e) {
    console.error(`buildStarterWorlds: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
