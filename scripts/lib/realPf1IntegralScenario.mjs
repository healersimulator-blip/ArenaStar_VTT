/** Genuine upstream documents, serialized using the same adapter as live imports.
 * Scene placement and Wizard level/preparation are scenario choices, not computed rules.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { foundryFixtureTools } from "./foundryFixture.mjs";

export async function buildRealPf1IntegralScenario({ root, pf1, pf1Content, archetypes, statblock }) {
  const realm = vm.createContext({ structuredClone });
  vm.runInContext(readFileSync(join(root, "modules/ais-foundry-v13/runtime/documents.js"), "utf8"), realm);
  const layer = realm.__aisFoundryDocuments.install({
    AIS: { events: { on() {} } }, Hooks: {}, warn() {}, clone: structuredClone,
    Collection: Map, game: () => ({}),
  });
  const documents = (pkg, packName) => {
    const pack = pkg.foundry.packs.find((p) => p.name === packName);
    if (!pack) throw new Error(`Missing required upstream pack ${packName}`);
    const paths = Object.keys(pkg.files).filter((p) => p === pack.path || p.startsWith(pack.path + "/"));
    const rows = [];
    for (const path of paths) {
      const text = pkg.files[path];
      try {
        const parsed = JSON.parse(text);
        rows.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch { rows.push(...text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))); }
    }
    return rows;
  };
  const requireNamed = (rows, name) => {
    const row = rows?.find((d) => d.name === name);
    if (!row) throw new Error(`Missing upstream scenario document ${name}`);
    return structuredClone(row);
  };
  const sourceId = (pkg, pack, doc, kind) => `Compendium.${pkg.foundry.id}.${pack}.${kind}.${doc._id}`;
  const mage = requireNamed(documents(pf1, "basic-monsters"), "Battle Mage");
  const monster = requireNamed(documents(pf1, "basic-monsters"), "Orc");
  const fireball = requireNamed(documents(pf1, "spells"), "Fireball");
  fireball.flags = { ...fireball.flags, core: { sourceId: sourceId(pf1, "spells", fireball, "Item") } };
  fireball.system.spellbook = "primary";
  fireball.system.preparation = { value: 1, max: 1 };
  mage.items.find((i) => i.type === "class" && i.name === "Wizard").system.level = 5;
  mage.items.push(fireball);
  // A GM-granted demonstration spell in the existing book; its data/action and
  // all derived values remain upstream. This is not a claim of Wizard list legality.
  const entangle = requireNamed(documents(pf1, "spells"), "Entangle");
  entangle.flags = { ...entangle.flags, core: { sourceId: sourceId(pf1, "spells", entangle, "Item") } };
  entangle.system.spellbook = "primary";
  entangle.system.preparation = { value: 1, max: 1 };
  mage.items.push(entangle);
  const actor = (raw, id, name, pack) => {
    raw.flags = { ...raw.flags, core: { sourceId: sourceId(pf1, pack, raw, "Actor") } };
    return { ...layer.classes.Actor.toSource({ ...raw, _id: id, name, ownership: { default: 0, gm: 3 } }), type: "actor" };
  };
  const actors = [actor(mage, "integral-wizard", "Valtiel — Wizard 5", "basic-monsters"), actor(monster, "integral-orc", "Orc — Integral Target", "basic-monsters")];
  const feat = requireNamed(documents(pf1Content, "pf-feats"), "Acrobatic");
  const archetypeRows = documents(archetypes, "pf-archetypes");
  const archetype = archetypeRows.find((d) => /^Wizard \(/.test(d.name));
  if (!archetype) throw new Error("Missing upstream Wizard archetype");
  const stat = requireNamed(documents(statblock, "sb-bestiaries1-3"), "Orc (warrior 1)");
  const entangleUuid = `Actor.integral-wizard.Item.${entangle._id}`;
  const invoke = `const call = (path, args) => api.ais.invoke("pf1", "foundry.api", { path, args });\n`;
  const scripts = [
    ["entangle-cast", "Entangle 1 — Cast (review first)", invoke + `return await call("FoundryAdapter.callDocument", [${JSON.stringify(entangleUuid)}, "use", [{skipDialog:true, options:{measureTemplate:false}}]]);`],
    ["entangle-failed-save", "Entangle 2 — GM confirms failed save", invoke + `// Run ONLY after the target fails its Reflex save. PF1 does not auto-apply area spells.\nconst spell = ${JSON.stringify(entangleUuid)};\nconst cl = await call("FoundryAdapter.documentValue", [spell, "system.casterLevel"]);\nconst formula = await call("FoundryAdapter.documentValue", [spell, "defaultAction.duration.value"]);\nconst units = await call("FoundryAdapter.documentValue", [spell, "defaultAction.duration.units"]);\nif (units !== "minute") throw new Error("Review the spell's changed duration units");\nconst duration = await call("RollPF.safeRollSync", [formula, {cl}]);\nif (!Number.isFinite(duration.total)) throw new Error("Invalid upstream duration");\nreturn await call("FoundryAdapter.callDocument", ["Actor.integral-orc", "setCondition", ["entangled", {flags:{"ais-foundry":{itemUuid:spell}}, duration:{seconds:duration.total*60}}]]);`],
    ["entangle-clear", "Entangle 3 — Release / dismiss", invoke + `return await call("FoundryAdapter.callDocument", ["Actor.integral-orc", "setCondition", ["entangled", false]]);`],
    ["entangle-expire", "Entangle 4 — Expire (demo time offset)", invoke + `// PF1's own expiry evaluation at a future offset; does not advance the world clock.\nconst cl = await call("FoundryAdapter.documentValue", [${JSON.stringify(entangleUuid)}, "system.casterLevel"]);\nreturn await call("FoundryAdapter.callDocument", ["Actor.integral-orc", "expireActiveEffects", [{timeOffset:cl*60+1, event:"time"}]]);`],
  ].map(([id, name, command]) => ({ _id: id, type: "macro", name, kind: "script", command,
    ownership: { default: 0, gm: 3 }, flags: {}, system: {},
    // Deliberately NOT pre-approved. Importing a world must not approve code.
    script: { version: 1, approvedHash: "0".repeat(64), sceneId: "scene-1", runAs: "gm", playerCallable: false, grants: ["ais.invoke"], inputs: [] } }));
  const cue = { _id: "entangle-native-vines", type: "macro", kind: "sequence", name: "Entangle — Native linked vines",
    ownership: { default: 0, gm: 3 }, flags: {}, system: {}, command: "",
    fxItem: { actorId: "integral-wizard", itemId: entangle._id, events: ["use"] },
    sequence: { version: 1, persistent: true, audience: "scene", sections: [{ id: "vines", kind: "text", startMs: 0, durationMs: 2000,
      at: { kind: "target" }, text: "╲│╱ ENTANGLED ╲│╱", color: "#54c75a", follow: true }] } };
  const instructions = {
    _id: "integral-instructions", type: "journal", name: "Integral Test — Acceptance Checklist",
    ownership: { default: 2 }, flags: {}, system: {}, pages: [{ _id: "integral-checklist", flags: { "ais-foundry": { type: "text" } }, name: "Real upstream stack", text: `<h1>PF1 Unified Starter — Integral Test</h1><p>Approve the adapter, PF1, PF Content, archetypes and statblock library in Settings, then reload.</p><p>Valtiel is the upstream Battle Mage configured as Wizard 5, with one prepared upstream Fireball. The target is the upstream Orc. No native PF1 rule provider is active.</p><ol><li>Open the real PF1 actor sheet. Verify level, INT modifier, caster level and save DC.</li><li>Import Acrobatic from PF Content; verify the upstream skill modifier increases by 2 and reverts on removal.</li><li>Resolve ${archetype.name} from the archetype module and inspect its actual progression; do not treat a description as an applied archetype.</li><li>Resolve Orc (warrior 1) from statblock-library. It is a journal; its SBC import button requires the separate converter.</li><li>Cast Fireball using the upstream item action. Verify caster-level damage, save DC, preparation consumption and an authoritative chat message.</li><li>Apply damage through the upstream PF1 actor API, then heal/restore; verify host HP and reload persistence.</li></ol><p>Entangle demonstration: a GM-granted Entangle is prepared in Valtiel’s book (not a claim of Wizard spell-list legality). Open Macros → FX Wizard and edit the saved “Entangle — Native linked vines” timeline. Its item binding is the real Entangle item. In Macros → Scripts, inspect and approve the four Entangle templates individually. Run Cast; make the target’s Reflex save using its upstream sheet; ONLY on failure run “GM confirms failed save”. That calls PF1 setCondition with the visual source-item flag and upstream-derived duration (Foundry origin is left free for PF1 buff ownership and expiry). The linked persistent native visual starts on the target. “Release / dismiss” removes the upstream condition and stops its FX. For an expiry demonstration, reapply after the confirmed failed save, then run “Expire (demo time offset)”: PF1 evaluates expiration at the future offset without advancing the global world clock. Template placement and area-membership automation are not simulated. Scene markers alone are not proof of targeting or elevation rules. An unverified step is a failed acceptance gate, not an implied pass.</p>` }],
  };
  const base = { ownership: { default: 2 }, flags: {}, system: {} };
  const scene = { ...base, _id: "scene-1", type: "scene", name: "Integral PF1 — Real Stack", active: true, img: null,
    width: 1600, height: 1000, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: actors.map((a, i) => ({ ...base, _id: `integral-token-${i}`, type: "token", name: a.name, actorId: a._id, actorLink: true, x: 100 + i * 500, y: 200, width: 100, height: 100, rotation: 0, elevation: 0, hidden: false, locked: false, img: null, hp: null, maxHp: null, disposition: i ? "hostile" : "friendly", vision: true, light: { radius: 0, color: "#ffffff", alpha: 0.5 } })),
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [], regions: [], levels: [],
  };
  const { normalizeAisDocumentMutations } = await foundryFixtureTools();
  let nextId = 0;
  const normalized = normalizeAisDocumentMutations([
    ...actors.map((data) => ({ kind: "create", collection: "actors", data: JSON.parse(JSON.stringify(data)) })),
    { kind: "create", collection: "journals", data: instructions },
  ], { userId: "gm", newId: () => `integral-doc-${++nextId}`, boundedJson: () => true });
  if (!normalized.ok) throw new Error(`Invalid integral source documents: ${normalized.error}`);
  const rows = normalized.value.ops;
  return { scene, macros: [cue, ...scripts], actors: rows.filter((op) => op.coll === "actors").map((op) => op.data), journals: rows.filter((op) => op.coll === "journals").map((op) => op.data), sources: { feat: feat._id, archetype: archetype._id, statblock: stat._id } };
}
