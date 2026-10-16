#!/usr/bin/env node
/**
 * Build 4-players test world with Foundry PF1e modules
 * - 4 player wizards (ownership default 3) each with Fireball + Entangle
 * - 4 Ogres derived from pf1-content (flag pf1-content)
 * - Same packs as integral test (pf1, pf1-content, archetypes, statblock-library, ais-foundry-v13)
 * - Levels
 * - Used by e2e/pf1e_4players.spec.ts to verify 4 simultaneous connections, rights, movement, charsheet/compendium
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const root = fileURLToPath(new URL("../", import.meta.url));

function listPackageFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}

function packageDirectoryHash(dir) {
  const files = listPackageFiles(dir).sort();
  const hash = createHash("sha256");
  const uint32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  hash.update(uint32(files.length));
  for (const rel of files) {
    const pathBytes = Buffer.from(rel, "utf8");
    const textBytes = Buffer.from(readFileSync(join(dir, rel), "utf8"), "utf8");
    hash.update(uint32(pathBytes.byteLength)).update(uint32(textBytes.byteLength)).update(pathBytes).update(textBytes);
  }
  return hash.digest("hex");
}

function packageFilesFromDir(dir) {
  const files = {};
  for (const rel of listPackageFiles(dir)) {
    files[rel] = readFileSync(join(dir, rel), "utf8");
  }
  return files;
}

function packageContentHashFromMap(files) {
  const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const hash = createHash("sha256");
  const uint32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
  hash.update(uint32(entries.length));
  for (const [p, text] of entries) {
    const pb = Buffer.from(p, "utf8");
    const bb = Buffer.from(text, "utf8");
    hash.update(uint32(pb.byteLength)).update(uint32(bb.byteLength)).update(pb).update(bb);
  }
  return hash.digest("hex");
}

const json = (v) => strToU8(JSON.stringify(v, null, 2));
const zip = (files) => zipSync(files, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });

async function build() {
  const systemIds = ["pf1e-core", "pf1e-mass-battles"];
  const systemPkgs = systemIds.map(id => {
    const dir = join(root, "systems", id);
    const files = packageFilesFromDir(dir);
    const manifest = JSON.parse(files["manifest.json"]);
    return { id, dir, files, manifest, hash: packageDirectoryHash(dir) };
  });

  const moduleIds = ["ais-foundry-v13"];
  const aisPkgs = moduleIds.map(id => {
    const dir = join(root, "modules", id);
    const files = packageFilesFromDir(dir);
    const manifest = JSON.parse(files["manifest.json"]);
    return { id, dir, files, manifest, hash: packageDirectoryHash(dir) };
  });

  function makeFoundryMock(id, title, version, moduleJson, extraFiles) {
    const resources = Object.keys({ "module.json": "", ...extraFiles }).sort();
    const manifest = {
      id,
      name: title,
      version,
      type: "module",
      description: `Foundry mock ${title} ${version} (id ${id}), imported via ais-foundry-v13`,
      interconnect: {
        api: "arena.ais/1",
        entry: "ais-foundry/entry.js",
        requires: [{ id: "ais-foundry-v13", version: "0.6.0" }],
        runtime: {
          provider: "ais-foundry-v13",
          profile: "foundry-module",
          scripts: ["ais-foundry/loader.js"],
          configuration: "module.json",
          resources
        },
        commands: [{ id: "foundry.info", contract: 1 }, { id: "foundry.api", contract: 1 }, { id: "foundry.ui", contract: 1 }],
        capabilities: [
          "runtime.execute", "package.resources.read", "module.settings.write", "ui.notify",
          "scene.tags.read", "scene.tags.write", "fx.play", "ui.panel",
          "documents.read", "documents.write", "chat.post",
          "compendium.read", "assets.read", "bus.transmit"
        ],
        panel: { title: title.slice(0, 48), width: 760, height: 560 },
        sharing: "players"
      }
    };
    const stubHeader = `// Foundry mock ${id} ${version}\n`;
    const files = {
      "module.json": JSON.stringify(moduleJson),
      ...extraFiles,
      "manifest.json": JSON.stringify(manifest, null, 2),
      "ais-foundry/entry.js": `${stubHeader}// Entry stub\n`,
      "ais-foundry/loader.js": `${stubHeader}// Loader stub\n`
    };
    return { id, files, manifest, hash: packageContentHashFromMap(files) };
  }

  const ogreEntries = [1,2,3,4].map(i => ({
    _id: `ogre${i}000000000000000${i}`,
    name: `Ogre ${i} (PF1 Content)`,
    type: "npc",
    img: "icons/svg/mystery-man.svg",
    system: { details: { cr: 3 }, attributes: { hp: { value: 30, max: 30 } } },
    ownership: { default: 0 }, flags: {}
  }));
  const pf1ContentModuleJson = {
    id: "pf1-content",
    title: "PF1 Content (Mock)",
    version: "11.4.0",
    esmodules: ["scripts/module.js"],
    packs: [{ name: "bestiary", label: "PF1 Bestiary", path: "packs/bestiary.db", type: "Actor" }],
    relationships: { systems: [{ id: "pf1" }] }
  };
  const pf1ContentExtra = {
    "scripts/module.js": `Hooks.on("init", () => console.log("pf1-content mock init")); Hooks.on("ready", () => console.log("pf1-content ready, packs:", game.packs.size));`,
    "packs/bestiary.db": ogreEntries.map(e => JSON.stringify(e)).join("\n")
  };

  const archetypeEntries = [
    { _id: "arch00100000000000001", name: "Aerochemist (Alchemist)", type: "feat", img: "", system: { description: { value: "Archetype" } }, flags: {} },
    { _id: "arch00200000000000002", name: "Beastmorph (Alchemist)", type: "feat", flags: {} }
  ];
  const archetypesModuleJson = {
    id: "pf1e-archetypes",
    title: "PF1e Archetypes (Mock)",
    version: "11.0.1",
    esmodules: ["scripts/module.js"],
    packs: [{ name: "archetypes", label: "Archetypes", path: "packs/archetypes.db", type: "Item" }],
    relationships: { systems: [{ id: "pf1" }] }
  };
  const archetypesExtra = {
    "scripts/module.js": `Hooks.on("init", () => console.log("archetypes mock init"));`,
    "packs/archetypes.db": archetypeEntries.map(e => JSON.stringify(e)).join("\n")
  };

  const statblockEntries = [
    { _id: "sb001000000000000001", name: "Goblin Chief Effigy CR 5", type: "base", pages: [{ _id: "p1", name: "Statblock", type: "text", text: { content: "<p>Goblin Chief Effigy CR 5</p><p>HP 30</p><p>Regeneration 5</p>" } }], flags: {} }
  ];
  const statblockModuleJson = {
    id: "pf1-statblock-library",
    title: "PF1 Statblock Library (Mock)",
    version: "0.8.0",
    esmodules: ["scripts/module.js"],
    packs: [{ name: "statblocks", label: "Statblocks", path: "packs/statblocks.db", type: "JournalEntry" }],
    relationships: { systems: [{ id: "pf1" }] }
  };
  const statblockExtra = {
    "scripts/module.js": `\n      Hooks.on("init", () => { console.log("statblock-library mock init"); });\n      Hooks.on("ready", () => { console.log("statblock-library ready"); });\n    `,
    "packs/statblocks.db": statblockEntries.map(e => JSON.stringify(e)).join("\n")
  };

  const pf1SystemModuleJson = {
    id: "pf1",
    title: "Pathfinder 1e System (Mock)",
    version: "11.11.0",
    esmodules: ["scripts/pf1.js"],
    packs: [
      { name: "spells", label: "Spells", path: "packs/spells.db", type: "Item" },
      { name: "feats", label: "Feats", path: "packs/feats.db", type: "Item" },
      { name: "classes", label: "Classes", path: "packs/classes.db", type: "Item" }
    ],
    compatibility: { minimum: "13" }
  };
  const spellEntries = [
    { _id: "spell0010000000000001", name: "Fireball", type: "spell", img: "icons/magic/fire/projectile-fireball-smoke-orange.webp", system: { level: 3, school: "evocation", description: { value: "<p>Fireball deals 1d6 per level</p>" } }, flags: {} },
    { _id: "spell0020000000000002", name: "Entangle", type: "spell", img: "icons/magic/nature/root-vine-entangle.webp", system: { level: 1, school: "transmutation", description: { value: "<p>Entangle area</p>" } }, flags: {} }
  ];
  const pf1SystemExtra = {
    "system.json": JSON.stringify(pf1SystemModuleJson),
    "scripts/pf1.js": `\n      Hooks.on("init", () => {\n        console.log("PF1 system mock init");\n        CONFIG.PF1 = CONFIG.PF1 || {};\n        CONFIG.PF1.abilities = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };\n        CONFIG.PF1.spellSchools = { evocation: "Evocation", transmutation: "Transmutation" };\n        CONFIG.PF1.conditions = { entangled: "Entangled" };\n        console.log("CONFIG.PF1 shim extended");\n      });\n      Hooks.on("ready", () => {\n        console.log("PF1 system mock ready");\n        const mod = game.modules.get("pf1");\n        if (mod) {\n          mod.api = {\n            getSpellPackInfo: async () => {\n              const pack = game.packs.find(p => p.id.includes('spells'));\n              if (!pack) return { error: \"no spells pack\" };\n              const idx = await pack.getIndex();\n              const entangle = idx.find(e => e.name.toLowerCase().includes('entangle'));\n              const fireball = idx.find(e => e.name.toLowerCase().includes('fireball'));\n              return { hasEntangle: !!entangle, hasFireball: !!fireball, count: idx.length, packId: pack.id };\n            }\n          };\n        }\n      });\n    `,
    "packs/spells.db": spellEntries.map(e => JSON.stringify(e)).join("\n"),
    "packs/feats.db": JSON.stringify({ _id: "feat001", name: "Point-Blank Shot", type: "feat", flags: {} }),
    "packs/classes.db": JSON.stringify({ _id: "class001", name: "Wizard", type: "class", flags: {} })
  };

  const mockPkgs = [
    makeFoundryMock("pf1-content", "PF1 Content (Mock)", "11.4.0", pf1ContentModuleJson, pf1ContentExtra),
    makeFoundryMock("pf1e-archetypes", "PF1e Archetypes (Mock)", "11.0.1", archetypesModuleJson, archetypesExtra),
    makeFoundryMock("pf1-statblock-library", "PF1 Statblock Library (Mock)", "0.8.0", statblockModuleJson, statblockExtra),
    makeFoundryMock("pf1", "PF1 System (Mock)", "11.11.0", pf1SystemModuleJson, pf1SystemExtra)
  ];

  const allPkgs = [...systemPkgs, ...aisPkgs, ...mockPkgs];

  const base = (id, type, name) => ({ _id: id, type, name, ownership: { default: 3 }, flags: {}, system: {} });

  // 4 wizards - each owned by all (default 3) so any player can control
  const wizardActors = [1,2,3,4].map(i => ({
    _id: `actor-wizard${i}`,
    type: "actor",
    name: `Valtiel the Wizard ${i}`,
    ownership: { default: 3 },
    flags: {},
    system: {
      pf1e: {
        abilities: { str: 10, dex: 16, con: 12, int: 18, wis: 12, cha: 10 },
        baseAttack: 2,
        hitDice: 5,
        hp: 28,
        hpMax: 28,
        feats: ["Point-Blank Shot"],
        spells: {
          keyAbility: "int",
          mode: "prepared",
          casterLevel: 5,
          slotsPerDay: { 1: 4, 2: 3, 3: 2 },
          slotsUsed: { 3: 0 },
          prepared: [{ name: "Fireball", level: 3 }, { name: "Entangle", level: 1 }]
        }
      }
    },
    items: [], effects: []
  }));

  const ogreActors = [1,2,3,4].map(i => ({
    _id: `actor-ogre${i}`,
    type: "actor",
    name: `Ogre ${i} (PF1 Content)`,
    ownership: { default: 3 },
    flags: { "pf1-content": { source: "pf1-content" } },
    system: { pf1e: { hp: 30, hpMax: 30, saves: { ref: 0, fort: 6, will: 3 }, abilities: { str: 21, dex: 8, con: 15 } } },
    items: [], effects: []
  }));

  const trollActor = {
    _id: "actor-troll1",
    type: "actor",
    name: "Troll 1",
    ownership: { default: 3 },
    flags: {},
    system: {
      pf1e: {
        hp: 36, hpMax: 36,
        saves: { ref: 4, fort: 11, will: 3 },
        abilities: { str: 21, dex: 14, con: 23 },
        regeneration: { value: 5, suppress: ["fire", "acid"] }
      }
    },
    items: [], effects: []
  };

  const token = (id, x, y, name, actorId, extra = {}) => ({
    ...base(id, "token", name),
    x, y, rotation: 0, width: 100, height: 100, img: "", hidden: false, disposition: "neutral", vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
    actorId,
    ...extra
  });

  const wizardTokens = [1,2,3,4].map(i => token(`wizard${i}`, 100, 100 + (i-1)*150, `Valtiel the Wizard ${i}`, `actor-wizard${i}`));
  const ogreTokens = [1,2,3,4].map(i => token(`ogre${i}`, 600, 100 + (i-1)*150, `Ogre ${i} (PF1 Content)`, `actor-ogre${i}`));
  const trollToken = token("troll1", 800, 250, "Troll 1", "actor-troll1");

  const levels = [
    {
      _id: "level-ground",
      type: "level",
      name: "Ground Floor",
      ownership: { default: 3 },
      flags: {},
      system: {},
      bottom: 0,
      top: 10,
      floorZ: 0,
      sort: 0,
      visibleLevelIds: []
    },
    {
      _id: "level-upper",
      type: "level",
      name: "Upper Floor",
      ownership: { default: 3 },
      flags: {},
      system: {},
      bottom: 10,
      top: null,
      floorZ: 10,
      sort: 1,
      surface: {
        x: 0, y: 0, width: 1000, height: 1000,
        footprint: {
          version: 2,
          components: [
            {
              outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
              holes: [[{ x: 0.2, y: 0.2 }, { x: 0.4, y: 0.2 }, { x: 0.4, y: 0.4 }, { x: 0.2, y: 0.4 }]]
            }
          ]
        },
        source: "art"
      },
      visibleLevelIds: ["level-ground"]
    }
  ];

  const scene = {
    ...base("scene-1", "scene", "PF1e 4 Players - Wizard vs Ogres"),
    active: true,
    img: null,
    width: 2000,
    height: 1200,
    darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: [...wizardTokens, ...ogreTokens, trollToken],
    walls: [
      { _id: "wall1", type: "wall", name: "Wall 1", ownership: { default: 3 }, flags: {}, system: {}, c: [0, 400, 1000, 400], door: 0, ds: 0 }
    ],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    regions: [],
    levels,
    levelMode: "isolated"
  };

  const user = { ...base("gm", "user", "GM"), ownership: { default: 3 }, role: "GM", character: null, color: "#e0b341" };

  const actors = [...wizardActors, ...ogreActors, trollActor];

  const docs = [
    { coll: "users", id: user._id, doc: user },
    { coll: "scenes", id: scene._id, doc: scene },
    ...actors.map(a => ({ coll: "actors", id: a._id, doc: a }))
  ];

  const worldJson = {
    format: 5,
    requiredFeatures: ["scene-level-drafts-v1", "scene-level-play-v1", "arena.ais/1", "arena.ais.runtime/1"],
    worldId: "pf1e-4players-test",
    name: "PF1e 4 Players Test - Foundry Modules + Wizard + Ogres + Levels",
    system: "pf1e-mass-battles",
    version: "1.0.0",
    seq: docs.length,
    exportedAt: 0,
    starter: true,
    rules: { active: "pf1e-mass-battles" },
    automation: {
      api: "arena.ais/1",
      modules: allPkgs.filter(p => p.manifest.type === "module").map(p => ({ id: p.id, version: p.manifest.version, hash: p.hash })),
      providers: {}
    }
  };

  const entries = {
    "world.json": json(worldJson),
    "documents.json": json({ seq: docs.length, docs }),
    "assets.json": json([]),
    "packages.json": json(allPkgs.map(p => ({
      id: p.id,
      name: p.manifest.name,
      version: p.manifest.version,
      type: p.manifest.type || "module",
      importedAt: 0,
      packCount: p.manifest.packs?.length ?? 0
    })))
  };

  for (const pkg of allPkgs) {
    for (const [path, text] of Object.entries(pkg.files)) {
      entries[`packages/${pkg.id}/${path}`] = strToU8(text);
    }
  }

  const world = zip(entries);
  const dest = join(root, "dist", "worlds", "pf1e-4players-test-1.0.0.zip");
  mkdirSync(join(root, "dist", "worlds"), { recursive: true });
  writeFileSync(dest, world);
  console.log(`4-players test world: ${dest} (${world.length} bytes)`);
  console.log(`Packages: ${allPkgs.map(p => p.id).join(", ")}`);
  console.log(`Scene: ${scene.name} with ${scene.tokens.length} tokens, ${scene.levels.length} levels`);
  return { dest, bytes: world.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await build();
}
