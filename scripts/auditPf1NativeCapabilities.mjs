#!/usr/bin/env node
/** Reproducible inventory, not gameplay/semantic parity certification. No upstream code runs. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";
import { parseDocument } from "yaml";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
const fixtures = process.env.VTT_FOUNDRY_FIXTURES ?? resolve(root, "tools/content/vendor/foundry-fixtures");
const output = resolve(root, process.argv[2] ?? "docs/research/PF1_NATIVE_REFERENCE_INVENTORY.json");
const sources = JSON.parse(readFileSync(resolve(root, "tools/content/foundry-fixtures.json"), "utf8")).sources;
const server = await createServer({ root, configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
const tally = (map, key) => { map[key] = (map[key] ?? 0) + 1; };
try {
  const { itemChangesToMods } = await server.ssrLoadModule("/src/packages/pf1e/itemChanges.ts");
  const { PF1E_SPELL_EFFECTS } = await server.ssrLoadModule("/src/packages/pf1e/spellEffects.ts");
  const { importCharacter, characterImportReport } = await server.ssrLoadModule("/src/packages/pf1e/import/index.ts");
  const builder = await server.ssrLoadModule("/src/packages/pf1e/builder.ts");
  const report = {
    schemaVersion: 1,
    scope: "Declared packs in pinned archives only; top-level documents, not embedded items. Keyed change objects are normalized to arrays as the native inventory reader does. Mapper acceptance is syntactic, not semantic or gameplay parity. Missing source pack files are reported, not treated as empty packs.",
    upstream: [], native: {},
  };
  for (const source of sources) {
    const bytes = readFileSync(resolve(fixtures, `${source.id}.zip`));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const receipt = JSON.parse(readFileSync(resolve(fixtures, `${source.id}.zip.source.json`), "utf8"));
    if (receipt.id !== source.id || receipt.commit !== source.commit) throw new Error(`Receipt pin mismatch: ${source.id}`);
    if (receipt.sha256 !== sha256) throw new Error(`Receipt hash mismatch: ${source.id}`);
    const files = unzipSync(bytes);
    const names = Object.keys(files);
    const manifestPath = names.find(p => p.endsWith(source.id === "pf1-system" ? "/public/system.json" : "/module.json"));
    if (!manifestPath) throw new Error(`No manifest: ${source.id}`);
    const manifest = JSON.parse(strFromU8(files[manifestPath]));
    const outer = source.id === "pf1-system" ? manifestPath.slice(0, -"public/system.json".length) : manifestPath.slice(0, -"module.json".length);
    const row = { id: source.id, version: manifest.version, commit: source.commit, upstream: source.upstream, mirror: source.mirror, archiveSha256: sha256,
      declaredPackCount: manifest.packs?.length ?? 0, scripts: [...(manifest.scripts ?? []), ...(manifest.esmodules ?? [])], packs: [] };
    for (const pack of manifest.packs ?? []) {
      const folder = `${outer}packs/${pack.name}/`;
      const yamlPaths = names.filter(p => p.startsWith(folder) && /\.ya?ml$/.test(p)).sort();
      let docs = [], storage;
      if (yamlPaths.length) {
        storage = "yaml-source";
        for (const path of yamlPaths) {
          const parsed = parseDocument(strFromU8(files[path]));
          if (parsed.errors.length) throw new Error(`Bad YAML ${path}: ${parsed.errors[0].message}`);
          const doc = parsed.toJS({ maxAliasCount: 100 });
          if (!doc._key?.startsWith("!folders!")) docs.push(doc);
        }
      } else if (pack.path && files[outer + pack.path]) {
        storage = "json-lines-db";
        docs = strFromU8(files[outer + pack.path]).split(/\r?\n/).filter(s => s.trim()).map((s, i) => {
          try { return JSON.parse(s); } catch { throw new Error(`Invalid JSON-lines ${pack.path}:${i + 1}`); }
        });
      } else { storage = "missing-declared-source"; }
      const itemChanges = { documents: 0, entries: 0, acceptedMods: 0, refusedEntries: 0, notes: 0, refusalReasons: {}, operators: {} };
      let scriptCallDocuments = 0;
      const documentTypes = {};
      for (const doc of docs) {
        tally(documentTypes, doc.type ?? pack.type ?? "unknown");
        const system = doc.system ?? doc.data ?? {};
        if (Array.isArray(system.scriptCalls) && system.scriptCalls.length) scriptCallDocuments++;
        const changes = Array.isArray(system.changes) ? system.changes : system.changes && typeof system.changes === "object" ? Object.values(system.changes) : [];
        if (!changes.length) continue;
        itemChanges.documents++; itemChanges.entries += changes.length;
        for (const c of changes) tally(itemChanges.operators, String(c?.operator ?? "add"));
        const mapped = itemChangesToMods(changes, doc.name ?? "audit");
        itemChanges.acceptedMods += mapped.mods.length; itemChanges.refusedEntries += mapped.unmapped.length; itemChanges.notes += mapped.notes.length;
        for (const u of mapped.unmapped) tally(itemChanges.refusalReasons, u.reason);
      }
      if (source.id === "pf1-system" && pack.name === "basic-monsters") {
        row.nativeActorAdmission = docs.map(doc => {
          const imported = importCharacter(JSON.stringify(doc), { fileName: "reference.json" });
          if (!imported.ok) return { name: doc.name, accepted: false, error: imported.error };
          const result = characterImportReport(imported.value);
          return { name: doc.name, accepted: true, importedItems: imported.value.items.length, warningLines: result.warnings.length };
        });
      }
      row.packs.push({ name: pack.name, documentKind: pack.type, storage, documents: docs.length, documentTypes, topLevelScriptCallDocuments: scriptCallDocuments, itemChanges });
    }
    report.upstream.push(row);
  }
  for (const name of ["bestiary", "classes", "equipment", "feats", "poisons", "spells"]) {
    const pack = JSON.parse(readFileSync(resolve(root, `systems/pf1e-core/packs/${name}.json`), "utf8"));
    const automation = {};
    for (const entry of pack.entries ?? []) tally(automation, entry.data?.system?.automation ?? "not-declared");
    report.native[name] = { entries: pack.entries?.length ?? 0, automation, automatedIds: (pack.entries ?? []).filter(e => e.data?.system?.automation === "automated").map(e => e.id) };
  }
  report.native.tacticalConditionSpellProfiles = PF1E_SPELL_EFFECTS.map(s => s.id);
  report.native.builderCatalogues = Object.fromEntries(Object.entries(builder).filter(([k,v]) => /CORE_(RACES|CLASSES)/.test(k) && Array.isArray(v)).map(([k,v]) => [k,v.length]));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${output}`);
  for (const s of report.upstream) console.log(`${s.id} ${s.version}: ${s.declaredPackCount} declared packs, ${s.packs.reduce((n,p) => n+p.documents,0)} source records, ${s.packs.filter(p => p.storage === "missing-declared-source").length} missing source packs`);
  console.log(JSON.stringify(report.native, null, 2));
} finally { await server.close(); }
