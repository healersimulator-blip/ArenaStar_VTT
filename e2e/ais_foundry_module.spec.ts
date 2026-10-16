/**
 * D-482 — Target A: Foundry core-API modules run UNMODIFIED through AIS.
 *
 * Part 1: the pinned upstream Tagger 1.5.4 as a Foundry-format distribution (module.json at the
 *   root of one folder, exactly as GitHub releases it; no ArenaStar wrapper, no bundling) is
 *   imported through the ordinary package importer, approved, loaded from its own ES modules
 *   (blob URLs + import map) and driven through its own global API from a reviewed script macro.
 * Part 2: a module written purely against Foundry core APIs (game.settings with onChange,
 *   game.i18n + lang file, classic script + nested ESM imports, styles, keybindings, Handlebars
 *   helper, ui.notifications, game.modules api) boots; its `config: true` settings appear in the
 *   GM's generated settings form and a change made there reaches the module's onChange.
 * Part 3 (D-483): the same module's Foundry UI — a FormApplication settings menu with `.hbs`
 *   templates/partials, jQuery listeners and `_updateObject` → game.settings.set; Dialog.confirm;
 *   an ApplicationV2 + HandlebarsApplicationMixin window with data-action handlers — renders
 *   inside the module's own sandboxed panel and is driven by real clicks in that frame.
 * Part 4 (D-484): the emulator's own core resource library — the module references
 *   `templates/generic/tab-navigation.hbs` / `form-footer.hbs` / `templates/dice/roll.html`,
 *   core language keys (`COMMON.Yes`, `SETTINGS.Save`), `foundry.data.fields` + a DataModel-typed
 *   setting, `Actor.TYPES`, `CONST.TOKEN_DISPLAY_MODES` — and ships none of it, exactly as modules
 *   written for Foundry do; a core path the library lacks fails with a diagnosable error.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { entry, waitForSurface } from "./lib";

const demoWorld = fileURLToPath(new URL("../dist/worlds/ais-foundry-feasibility-0.1.0.zip", import.meta.url));
const upstreamZip = fileURLToPath(new URL("../dist/packages/foundry-tagger-upstream-1.5.4.zip", import.meta.url));

async function openWorld(page: Page) {
  await page.goto(entry);
  await page.locator("#role-import").setInputFiles(demoWorld);
  await page.locator("[data-open-copy]").click();
  await expect(page.locator("#status")).toContainText("AIS Foundry feasibility");
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
}

async function importPackage(page: Page, name: string, buffer: Buffer, id: string): Promise<void> {
  await page.locator("#pkg-file").setInputFiles({ name, mimeType: "application/zip", buffer });
  await expect(page.locator(`[data-pkg-row][data-pkg-id="${id}"]`)).toBeVisible();
}

async function approve(page: Page, id: string): Promise<void> {
  const row = page.locator(`[data-pkg-row][data-pkg-id="${id}"]`);
  if (await row.locator("[data-ais-enable]").count()) await row.locator("[data-ais-enable]").click();
  const review = page.locator(`[data-ais-module-review="${id}"]`);
  for (const checkbox of await review.locator('fieldset input[type="checkbox"]').all()) await checkbox.check();
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator(".ais-source-preview pre")).toBeVisible();
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator("[data-ais-approved]")).toBeVisible();
}

async function reloadAndWaitReady(page: Page, ids: string[]): Promise<void> {
  await Promise.all([page.waitForEvent("load"), page.locator("[data-ais-reload]").click()]);
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  for (const id of ids)
    await expect(page.locator(`[data-ais-module-review="${id}"] [data-ais-runtime]`)).toHaveAttribute("data-ais-runtime", "ready", { timeout: 15_000 });
}

async function invoke(page: Page, moduleId: string, command: string, input: unknown = {}) {
  const settingsClose = page.locator('[data-window="settings"] [data-window-close]');
  if (await settingsClose.count()) await settingsClose.click();
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-script-tab]").click();
  const panel = page.locator("[data-script-wizard]");
  await panel.locator("[data-script-name]").fill("Foundry module acceptance");
  await panel.locator("[data-script-source]").fill(`return await api.ais.invoke(${JSON.stringify(moduleId)}, ${JSON.stringify(command)}, ${JSON.stringify(input)});`);
  await panel.locator(".grants label").filter({ hasText: "ais.invoke" }).locator("input").check();
  await panel.getByLabel("I reviewed this exact revision and its host grants").check();
  await panel.locator("[data-script-save]").click();
  await expect(panel.getByRole("status")).toContainText("Script revision published");
  await panel.locator("[data-script-run]").click();
  return panel;
}
async function result(page: Page, moduleId: string, command: string, input: unknown = {}) {
  const panel = await invoke(page, moduleId, command, input);
  await expect(panel.getByRole("status")).toContainText("Script completed", { timeout: 12_000 });
  const parsed = JSON.parse(await panel.locator("details pre").innerText());
  const macrosClose = page.locator('[data-window="macros"] [data-window-close]');
  if (await macrosClose.count()) await macrosClose.click();
  return parsed;
}
const tokenTags = (page: Page) => page.evaluate(() => {
  const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
  return client.store.get("scenes", "scene-1")?.tokens.map((token) => ({ id: token._id, tags: token.taggerTags }));
});
const settingsDoc = (page: Page, id: string) => page.evaluate((packageId) => {
  const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
  const doc = client.store.get("settings", `ais-settings:${packageId}`) as { flags?: { ais?: { values?: Record<string, unknown> } } } | undefined;
  return doc?.flags?.ais?.values ?? null;
}, id);

/** A module that only speaks Foundry core APIs — no ArenaStar/AIS call anywhere in it. */
function foundryCoreApiModuleZip(): Buffer {
  const files: Record<string, string> = {
    "module.json": JSON.stringify({
      id: "fsd-demo", title: "Foundry Settings Demo", version: "1.0.0", description: "<p>Core-API probe</p>",
      compatibility: { minimum: "12", verified: "13" },
      esmodules: ["scripts/main.mjs"], scripts: ["./scripts/classic.js"], styles: ["styles/demo.css"],
      languages: [{ lang: "en", name: "English", path: "lang/en.json" }],
      relationships: { systems: [], requires: [] },
    }, null, 2),
    "scripts/classic.js": "window.FSD_CLASSIC = { kind: \"classic\" };\n",
    "scripts/lib/util.mjs": "export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));\nexport default clamp;\n",
    "scripts/lib/side.mjs": "globalThis.FSD_SIDE = true;\n",
    "scripts/main.mjs": [
      `import clamp, { clamp as named } from "./lib/util.mjs";`,
      `import "/scripts/lib/side.mjs";`,
      `const MODULE_ID = "fsd-demo";`,
      `const state = { changes: [], ready: false, classic: typeof window.FSD_CLASSIC, side: globalThis.FSD_SIDE === true, socket: [] };`,
      `Hooks.once("init", () => {`,
      `  game.settings.register(MODULE_ID, "radius", { name: "FSD.Radius", hint: "FSD.RadiusHint", scope: "world", config: true, type: Number,`,
      `    default: 20, range: { min: 0, max: 60, step: 5 }, onChange: (value) => state.changes.push(["radius", value]) });`,
      `  game.settings.register(MODULE_ID, "enabled", { name: "FSD.Enabled", scope: "client", config: true, type: Boolean, default: true });`,
      `  game.settings.register(MODULE_ID, "mode", { name: "FSD.Mode", scope: "world", config: true, type: String, choices: { soft: "FSD.Soft", hard: "FSD.Hard" }, default: "soft" });`,
      `  game.settings.register(MODULE_ID, "state", { scope: "world", config: false, type: Object, default: { seen: [] } });`,
      // D-484: a DataModel-typed setting and a V2 form assembled from the emulator's core parts + DataField helpers.
      `  const { NumberField, StringField, BooleanField } = foundry.data.fields;`,
      `  class FsdPrefs extends foundry.abstract.DataModel {`,
      `    static defineSchema() { return {`,
      `      radius: new NumberField({ required: true, integer: true, min: 0, max: 60, step: 5, initial: 20, label: "FSD.Radius", hint: "FSD.RadiusHint" }),`,
      `      mode: new StringField({ required: true, choices: { soft: "FSD.Soft", hard: "FSD.Hard" }, initial: "soft", label: "FSD.Mode" }),`,
      `      enabled: new BooleanField({ initial: true, label: "FSD.Enabled" }) }; }`,
      `  }`,
      `  game.settings.register(MODULE_ID, "prefs", { scope: "world", config: false, type: FsdPrefs, default: new FsdPrefs() });`,
      `  game.keybindings.register(MODULE_ID, "toggle", { name: "Toggle", editable: [{ key: "KeyT" }], onDown: () => {} });`,
      `  Handlebars.registerHelper("fsdUpper", (text) => String(text).toUpperCase());`,
      `  CONFIG.debug.fsd = true;`,
      // D-483: a v1 FormApplication settings menu, exactly as a Foundry module writes one.
      `  class FsdConfig extends FormApplication {`,
      `    static get defaultOptions() { return foundry.utils.mergeObject(super.defaultOptions, { id: "fsd-config", title: "FSD.ConfigTitle",`,
      `      template: "modules/fsd-demo/templates/config.hbs", width: 440, closeOnSubmit: true }); }`,
      `    getData() { return { user: game.user.name, radius: game.settings.get(MODULE_ID, "radius"), mode: game.settings.get(MODULE_ID, "mode"),`,
      `      modes: { soft: "FSD.Soft", hard: "FSD.Hard" }, enabled: game.settings.get(MODULE_ID, "enabled"), items: [{ name: "alpha", hot: true }, { name: "beta", hot: false }] }; }`,
      `    activateListeners(html) {`,
      `      super.activateListeners(html);`,
      `      html.find("[data-action=bump]").click((event) => { event.preventDefault(); const input = html.find("input[name=radius]"); input.val(Number(input.val()) + 5); });`,
      `    }`,
      `    async _updateObject(event, formData) {`,
      `      await game.settings.set(MODULE_ID, "radius", formData.radius);`,
      `      await game.settings.set(MODULE_ID, "mode", formData.mode);`,
      `      state.submitted = formData;`,
      `    }`,
      `  }`,
      `  game.settings.registerMenu(MODULE_ID, "config", { name: "FSD.ConfigTitle", label: "FSD.Open", hint: "FSD.OpenHint", icon: "fas fa-cog", type: FsdConfig, restricted: true });`,
      `  const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;`,
      `  class FsdPanel extends HandlebarsApplicationMixin(ApplicationV2) {`,
      `    static DEFAULT_OPTIONS = { id: "fsd-panel", classes: ["fsd"], window: { title: "FSD.PanelTitle" }, position: { width: 320 }, actions: { ping: FsdPanel.ping } };`,
      `    static PARTS = { body: { template: "modules/fsd-demo/templates/panel.hbs" } };`,
      `    static ping(event, target) { this.pings = (this.pings ?? 0) + 1; state.pingTarget = target.dataset.action; ui.notifications.info("FSD ping " + this.pings); return this.render({ parts: ["body"] }); }`,
      `    async _prepareContext() { return { pings: this.pings ?? 0, radius: game.settings.get(MODULE_ID, "radius"), mode: game.settings.get(MODULE_ID, "mode") }; }`,
      `  }`,
      `  class FsdPrefsApp extends HandlebarsApplicationMixin(ApplicationV2) {`,
      `    static DEFAULT_OPTIONS = { id: "fsd-prefs", classes: ["fsd-prefs"], tag: "form", window: { title: "FSD.PrefsTitle" }, position: { width: 400 },`,
      `      form: { handler: FsdPrefsApp.onSubmit, closeOnSubmit: true } };`,
      `    static PARTS = { tabs: { template: "templates/generic/tab-navigation.hbs" }, body: { template: "modules/fsd-demo/templates/prefs.hbs" }, footer: { template: "templates/generic/form-footer.hbs" } };`,
      `    static TABS = { primary: { tabs: [{ id: "general", label: "FSD.General", icon: "fa-solid fa-gear" }, { id: "about", label: "FSD.About" }], initial: "general" } };`,
      `    static async onSubmit(event, form, formData) {`,
      `      const prefs = game.settings.get(MODULE_ID, "prefs");`,
      `      prefs.updateSource(formData.object);`,
      `      await game.settings.set(MODULE_ID, "prefs", prefs);`,
      `      state.prefsSaved = game.settings.get(MODULE_ID, "prefs").toObject();`,
      `      state.prefsIsModelAfter = game.settings.get(MODULE_ID, "prefs") instanceof FsdPrefs;`,
      `    }`,
      `    async _prepareContext() { const prefs = game.settings.get(MODULE_ID, "prefs"); return { tabs: this._prepareTabs("primary"), fields: prefs.schema.fields, prefs: prefs.toObject(),`,
      `      buttons: [{ type: "submit", icon: "fa-solid fa-save", label: "SETTINGS.Save" }, { type: "button", action: "reset", label: "SETTINGS.Reset" }] }; }`,
      `  }`,
      `  globalThis.FsdUi = { FsdConfig, FsdPanel, FsdPrefsApp,`,
      `    confirm: () => Dialog.confirm({ title: game.i18n.localize("FSD.Sure"), content: '<p class="fsd">Apply?</p>' }),`,
      `    confirmV2: () => DialogV2.confirm({ window: { title: "FSD.Sure" }, content: "<p>Apply v2?</p>", rejectClose: false }),`,
      `    openPanel: () => new FsdPanel().render({ force: true }).then((app) => app.toObject()) };`,
      `});`,
      `Hooks.once("ready", async () => {`,
      `  state.ready = true;`,
      `  state.clamp = clamp(99, 0, named(10, 0, 50));`,
      `  state.title = game.i18n.localize("FSD.Title");`,
      `  state.hello = game.i18n.format("FSD.Hello", { name: game.user.name });`,
      `  state.system = game.system.id;`,
      `  state.module = game.modules.get(MODULE_ID)?.active === true;`,
      `  state.radius = game.settings.get(MODULE_ID, "radius");`,
      `  const saved = game.settings.get(MODULE_ID, "state");`,
      `  await game.settings.set(MODULE_ID, "state", { seen: [...saved.seen, "boot"] });`,
      `  state.persisted = game.settings.get(MODULE_ID, "state");`,
      // D-484 probes: core i18n keys, document type lists, CONST enumerations, a core template render, and a core path the library lacks.
      `  state.coreI18n = [game.i18n.localize("COMMON.Yes"), game.i18n.localize("SETTINGS.Save"), game.i18n.has("COMMON.No"), game.i18n.localize("FSD.Title")];`,
      `  state.actorTypes = Actor.TYPES; state.displayModes = Object.keys(CONST.TOKEN_DISPLAY_MODES); state.release = game.release.generation;`,
      `  const prefs = game.settings.get(MODULE_ID, "prefs"); state.prefsIsModel = prefs instanceof foundry.abstract.DataModel; state.prefs = prefs.toObject();`,
      `  state.rollCard = await renderTemplate("templates/dice/roll.html", { formula: "1d20 + 5", total: 17, tooltip: "" });`,
      `  try { await renderTemplate("templates/sidebar/apps/compendium.html", {}); state.missing = "rendered"; } catch (error) { state.missing = error.message; }`,
      `  ui.notifications.info(game.i18n.localize("FSD.Ready"));`,
      `  game.modules.get(MODULE_ID).api = { state: () => state, radius: () => game.settings.get(MODULE_ID, "radius"),`,
      `    setRadius: (value) => game.settings.set(MODULE_ID, "radius", value), documents: probeDocuments, docEvents: () => state.docEvents, bench: benchDocuments,`,
      `    socketLog: () => state.socket, socketEmit: (data) => { game.socket.emit("module.fsd-demo", data); return true; },`,
      `    actorView: (id) => { const actor = game.actors.get(id); return actor ? { name: actor.name, hp: actor.system.hp?.value ?? null, flags: actor.flags[MODULE_ID] ?? null, items: actor.items.map((item) => item.name) } : null; } };`,
      // D-487: announce this instance across devices (the sender hears itself; every other device hears it too).
      `  game.socket.emit("module.fsd-demo", { hello: true, from: game.user.name });`,
      `});`,
      // D-485 probes: plain Foundry document code — classes, embedded collections, flags, uuids and the create*/update*/delete* hooks.
      `state.docEvents = [];`,
      `for (const hook of ["createActor", "updateActor", "deleteActor", "createItem", "updateItem", "deleteItem", "createJournalEntry"])`,
      `  Hooks.on(hook, (doc, changes, options, userId) => state.docEvents.push({ hook, name: doc.name, uuid: doc.uuid, changes: hook.startsWith("update") ? changes : null, userId: hook.startsWith("delete") ? options : userId }));`,
      // D-487: game.socket over the kernel's cross-device channel (same module on every device).
      `game.socket.on("module.fsd-demo", (data) => { state.socket.push(data); ChatMessage.create({ content: "fsd socket " + JSON.stringify(data) }).catch(() => {}); });`,
      // Measured, not asserted: what a module experiences per awaited write (mutate → commit → change event → replica refresh).
      `async function benchDocuments(id, n) {`,
      `  const actor = game.actors.get(id); const started = performance.now();`,
      `  for (let i = 0; i < n; i += 1) await actor.update({ "system.hp.value": 10 + i });`,
      `  return { n, msPerWrite: Math.round((performance.now() - started) / n), hp: actor.system.hp.value };`,
      `}`,
      `async function probeDocuments() {`,
      `  const before = { actors: game.actors.size, users: game.users.size, isGM: game.user.isGM, userId: game.user.id, userName: game.user.name, userDoc: game.user instanceof User };`,
      `  const actor = await Actor.create({ name: "FSD Guard", type: "npc", system: { hp: { value: 5, max: 5 } }, flags: { [MODULE_ID]: { origin: "probe" } },`,
      `    items: [{ name: "Shield", type: "equipment" }] });`,
      `  const [torch] = await actor.createEmbeddedDocuments("Item", [{ name: "Torch", type: "weapon", system: { lit: false } }]);`,
      `  await torch.update({ "system.lit": true });`,
      `  await actor.setFlag(MODULE_ID, "count", 1);`,
      `  await actor.update({ name: "FSD Guard II", "system.hp.value": 4 });`,
      `  const journal = await JournalEntry.create({ name: "FSD Notes", pages: [{ name: "Plan", type: "text", text: { content: "<p>Hold the gate</p>" } }] });`,
      `  const resolved = { torchSync: fromUuidSync(torch.uuid) === torch, actorAsync: (await fromUuid(actor.uuid)) === actor, pageType: journal.pages.contents[0].type,`,
      `    pageText: journal.pages.contents[0].text.content, byName: game.actors.getName("FSD Guard II") === actor, inCollection: game.actors.get(actor.id) === actor };`,
      `  return { before, actorId: actor.id, uuid: actor.uuid, type: actor.type, name: actor.name, hp: actor.system.hp.value, isOwner: actor.isOwner, flags: actor.flags[MODULE_ID],`,
      `    items: actor.items.map((item) => ({ name: item.name, type: item.type, lit: item.system.lit ?? null, uuid: item.uuid })), itemTypes: Object.keys(actor.itemTypes).sort(),`,
      `    journalId: journal.id, resolved, after: { actors: game.actors.size, journal: game.journal.size } };`,
      `}`,
      "",
    ].join("\n"),
    "lang/en.json": JSON.stringify({ FSD: { Title: "Foundry Settings Demo", Radius: "Light radius", RadiusHint: "In feet", Enabled: "Enabled on this device",
      Mode: "Mode", Soft: "Soft", Hard: "Hard", Hello: "Hello, {name}!", Ready: "Demo is ready",
      ConfigTitle: "Settings demo config", Open: "Open config", OpenHint: "Opens the demo window", PanelTitle: "Demo panel", Save: "Save changes", Sure: "Are you sure?",
      PrefsTitle: "Demo preferences", General: "General", About: "About" } }),
    "styles/demo.css": ".fsd { color: red; }\n",
    // D-483: templates exactly as a Foundry module ships them (module-absolute partial path, core helpers).
    "templates/config.hbs": [
      "<form class=\"fsd-config flexcol\" autocomplete=\"off\">",
      "  <h2 class=\"fsd\">{{localize \"FSD.ConfigTitle\"}} — {{localize \"FSD.Hello\" name=user}}</h2>",
      "  {{> \"modules/fsd-demo/templates/parts/number.hbs\" name=\"radius\" label=\"FSD.Radius\" value=radius}}",
      "  <div class=\"form-group\"><label>{{localize \"FSD.Mode\"}}</label><div class=\"form-fields\"><select name=\"mode\">{{selectOptions modes selected=mode localize=true}}</select></div></div>",
      "  <div class=\"form-group\"><label>{{localize \"FSD.Enabled\"}}</label><input type=\"checkbox\" name=\"enabled\" {{checked enabled}}></div>",
      "  <ul class=\"fsd-items\">{{#each items as |item i|}}<li data-index=\"{{i}}\" class=\"{{#if item.hot}}hot{{/if}}\">{{fsdUpper item.name}}</li>{{/each}}</ul>",
      "  <footer class=\"sheet-footer flexrow\"><button type=\"button\" data-action=\"bump\">+5</button><button type=\"submit\"><i class=\"fas fa-save\"></i> {{localize \"FSD.Save\"}}</button></footer>",
      "</form>",
    ].join("\n"),
    "templates/parts/number.hbs": "<div class=\"form-group\"><label>{{localize label}}</label><div class=\"form-fields\"><input type=\"number\" name=\"{{name}}\" value=\"{{value}}\" step=\"5\" data-dtype=\"Number\"></div></div>",
    "templates/panel.hbs": "<section class=\"fsd-panel\"><p class=\"fsd-pings\">pings: {{pings}}</p><p class=\"fsd-radius\">radius: {{radius}} ({{mode}})</p><button type=\"button\" data-action=\"ping\">Ping</button></section>",
    // D-484: the body part uses only DataField helpers + a core partial; the tab strip and footer are core parts the module never ships.
    "templates/prefs.hbs": "<div class=\"fsd-prefs-body\"><section class=\"tab {{tabs.general.cssClass}}\" data-group=\"primary\" data-tab=\"general\">"
      + "{{formGroup fields.radius value=prefs.radius localize=true}}{{formGroup fields.mode value=prefs.mode localize=true}}{{formGroup fields.enabled value=prefs.enabled localize=true}}"
      + "{{> \"templates/generic/form-group.hbs\" label=\"DOCUMENT.Actor\" input=\"<input name='actor' value='Mara'>\" localize=true}}"
      + "</section><section class=\"tab {{tabs.about.cssClass}}\" data-group=\"primary\" data-tab=\"about\"><p class=\"fsd-about\">{{localize \"AreYouSure\"}}</p></section></div>",
  };
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[`fsd-demo/${path}`] = strToU8(text);
  entries["fsd-demo/icons/icon.png"] = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
  return Buffer.from(zipSync(entries));
}

test("D-482: the unmodified upstream Tagger distribution imports, loads from its own ES modules and runs through AIS", async ({ page }) => {
  test.setTimeout(180_000);
  await openWorld(page);
  await page.locator("#gm-settings").click();
  // The importer recognises module.json (no manifest.json anywhere in the archive).
  await importPackage(page, "foundry-tagger-upstream-1.5.4.zip", readFileSync(upstreamZip), "tagger");
  await expect(page.locator('[data-pkg-row][data-pkg-id="tagger"]')).toContainText("Tagger");
  await approve(page, "ais-foundry-v13");
  await approve(page, "tagger");
  await expect(page.locator('iframe[title^="AIS module:"]')).toHaveCount(0); // nothing runs before reload
  await reloadAndWaitReady(page, ["tagger"]);
  await expect(page.locator('iframe[title="AIS module:tagger"]')).toHaveCount(1);

  const info = await result(page, "tagger", "foundry.info");
  expect(info).toMatchObject({ profile: "foundry-module", foundryId: "tagger", packageId: "tagger", systemId: "arenastar", ready: true,
    loaded: [{ path: "scripts/module.js", kind: "esmodule" }], unresolvedImports: [], declaredSystems: [] });
  expect(info.globals).toContain("Tagger");            // `window.Tagger = Tagger` in the module's own ready hook
  expect(info.hookNames).toEqual(expect.arrayContaining(["preUpdateToken", "preCreateToken", "renderTokenConfig"]));
  expect(info.keybindings).toEqual(["tagger.do-not-apply-tag-rules"]);
  expect(info.hookErrors).toEqual([]);
  expect(typeof info.loadMs).toBe("number");

  // Tagger's own API, called the way a Foundry macro would call it.
  const found = await result(page, "tagger", "foundry.api", { path: "Tagger.getByTag", args: ["Beacon"] });
  expect(found.map((row: { _id: string }) => row._id)).toEqual(["beacon-one", "beacon-two"]);
  const caseInsensitive = await result(page, "tagger", "foundry.api", { path: "Tagger.getByTag", args: ["bea*", { caseInsensitive: true }] });
  expect(caseInsensitive).toHaveLength(2);
  const invalid = await invoke(page, "tagger", "foundry.api", { path: "Tagger.getByTag", args: [123] });
  await expect(invalid.getByRole("status")).toContainText("Tagger | getByTag | inTags must be");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  // A write goes Tagger → document.update → AIS scene.tags.update → host commit (visible in the replica).
  // (Tagger.addTags resolves to undefined upstream — the proof is the replicated token document.)
  expect(await result(page, "tagger", "foundry.api", { path: "Tagger.addTags", args: ["@uuid:Scene.scene-1.Token.beacon-one", ["adapted", " adapted "]] })).toBeNull();
  expect(await tokenTags(page)).toEqual(expect.arrayContaining([
    { id: "beacon-one", tags: ["Beacon", "lamp-1", "adapted"] },
    { id: "hidden-beacon", tags: ["Beacon", "secret"] },
  ]));
  const hidden = await invoke(page, "tagger", "foundry.api", { path: "Tagger.setTags", args: ["@uuid:Scene.scene-1.Token.hidden-beacon", ["leaked"]] });
  await expect(hidden.getByRole("status")).toContainText("is not in the projected scene");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const forbidden = await invoke(page, "tagger", "foundry.api", { path: "AIS.settings.list", args: [] });
  await expect(forbidden.getByRole("status")).toContainText("foundry.api cannot reach AIS");
});

test("D-482: a module written against Foundry core APIs boots; its game.settings become the GM's generated settings form", async ({ page }) => {
  test.setTimeout(180_000);
  await openWorld(page);
  await page.locator("#gm-settings").click();
  await importPackage(page, "fsd-demo-1.0.0.zip", foundryCoreApiModuleZip(), "fsd-demo");
  await approve(page, "ais-foundry-v13");
  await approve(page, "fsd-demo");
  await reloadAndWaitReady(page, ["fsd-demo"]);

  const info = await result(page, "fsd-demo", "foundry.info");
  expect(info).toMatchObject({ foundryId: "fsd-demo", languages: ["en"], styles: ["styles/demo.css"], hookErrors: [], unresolvedImports: [],
    loaded: [{ path: "scripts/classic.js", kind: "script" }, { path: "scripts/main.mjs", kind: "esmodule" }], keybindings: ["fsd-demo.toggle"] });
  expect(info.settings).toEqual([
    { key: "fsd-demo.radius", aisKey: "fsd_demo_radius", scope: "world", kind: "number", synced: true, hidden: false },
    { key: "fsd-demo.enabled", aisKey: "fsd_demo_enabled", scope: "device", kind: "boolean", synced: true, hidden: false },
    { key: "fsd-demo.mode", aisKey: "fsd_demo_mode", scope: "world", kind: "choice", synced: true, hidden: false },
    { key: "fsd-demo.state", aisKey: "fsd_demo_state", scope: "world", kind: "json", synced: true, hidden: true },
    { key: "fsd-demo.prefs", aisKey: "fsd_demo_prefs", scope: "world", kind: "json", synced: true, hidden: true },
  ]);
  const state = await result(page, "fsd-demo", "foundry.api", { path: "state" }); // game.modules.get(id).api.state()
  expect(state).toMatchObject({ ready: true, classic: "object", side: true, clamp: 10, title: "Foundry Settings Demo", hello: "Hello, GM!",
    system: "arenastar", module: true, radius: 20, persisted: { seen: ["boot"] }, changes: [] });
  expect(await result(page, "fsd-demo", "foundry.api", { path: "FSD_SIDE" })).toBe(true);
  // The hidden Object setting was persisted as JSON text in the replicated world-settings document.
  expect(await settingsDoc(page, "fsd-demo")).toEqual({ fsd_demo_state: JSON.stringify({ seen: ["boot"] }) });

  // The GM form: three visible settings + one internal, labels from the module's own lang file.
  await page.locator("#gm-settings").click();
  const review = page.locator('[data-ais-module-review="fsd-demo"]');
  const block = review.locator('[data-ais-settings="fsd-demo"]');
  await expect(block.locator("summary")).toContainText("Settings (5)");
  await block.locator("summary").click();
  const form = block.locator('[data-ais-settings-form="fsd-demo"]');
  await expect(form.locator("[data-ais-setting]")).toHaveCount(3);
  await expect(form.locator("[data-ais-settings-hidden]")).toHaveAttribute("data-ais-settings-hidden", "2");
  const radius = form.locator('[data-ais-setting="fsd_demo_radius"]');
  await expect(radius).toContainText("Light radius");
  await expect(radius).toContainText("In feet");
  await expect(radius).toHaveAttribute("data-ais-setting-scope", "world");
  await expect(form.locator('[data-ais-setting="fsd_demo_enabled"]')).toHaveAttribute("data-ais-setting-scope", "device");
  await expect(form.locator('[data-ais-setting="fsd_demo_mode"] select option')).toHaveText(["Soft", "Hard"]);
  await radius.locator("input").fill("7");
  await radius.locator("input").dispatchEvent("change");
  await expect(form.locator('[data-ais-setting-error="fsd_demo_radius"]')).toContainText("steps of 5");
  await radius.locator("input").fill("45");
  await radius.locator("input").dispatchEvent("change");
  await expect.poll(() => settingsDoc(page, "fsd-demo")).toMatchObject({ fsd_demo_radius: 45 });
  // …and the module saw it through its own onChange, then reads the new value synchronously.
  await expect.poll(async () => (await result(page, "fsd-demo", "foundry.api", { path: "state" })).changes).toEqual([["radius", 45]]);
  expect(await result(page, "fsd-demo", "foundry.api", { path: "radius" })).toBe(45);
  // A write from the module side lands in the same document and the same form.
  expect(await result(page, "fsd-demo", "foundry.api", { path: "setRadius", args: [30] })).toBe(30);
  await expect.poll(() => settingsDoc(page, "fsd-demo")).toMatchObject({ fsd_demo_radius: 30 });
  await page.locator("#gm-settings").click();
  const reopened = page.locator('[data-ais-module-review="fsd-demo"] [data-ais-settings="fsd-demo"]');
  if (!(await reopened.evaluate((element) => (element as HTMLDetailsElement).open))) await reopened.locator("summary").click();
  await expect(reopened.locator('[data-ais-setting="fsd_demo_radius"] input')).toHaveValue("30");
});

test("D-483: the module's Foundry windows (FormApplication menu, Dialog.confirm, ApplicationV2) render in its own sandboxed panel and act on real clicks", async ({ page }) => {
  test.setTimeout(180_000);
  await openWorld(page);
  await page.locator("#gm-settings").click();
  await importPackage(page, "fsd-demo-1.0.0.zip", foundryCoreApiModuleZip(), "fsd-demo");
  await approve(page, "ais-foundry-v13");
  await approve(page, "fsd-demo");
  await reloadAndWaitReady(page, ["fsd-demo"]);
  const panel = page.locator('[data-ais-panel="fsd-demo"]');
  const frame = page.frameLocator('iframe[title="AIS module:fsd-demo"]');
  await expect(panel).toHaveAttribute("data-ais-panel-open", "false");

  // The registered settings menu opens as a v1 FormApplication window inside the module's panel.
  const info = await result(page, "fsd-demo", "foundry.info");
  expect(info.menus).toEqual([{ key: "fsd-demo.config", name: "FSD.ConfigTitle", label: "FSD.Open", type: "FsdConfig", restricted: true }]);
  expect(info.windows).toEqual([]);
  const opened = await result(page, "fsd-demo", "foundry.ui", { menu: "fsd-demo.config" });
  expect(opened).toMatchObject({ id: "fsd-config", class: "FsdConfig", title: "Settings demo config", rendered: true, windows: [{ id: "fsd-config", api: "Application" }] });
  await expect(panel).toHaveAttribute("data-ais-panel-open", "true");
  await expect(panel).toBeVisible();
  const config = frame.locator("#fsd-config");
  await expect(config.locator(".window-title")).toHaveText("Settings demo config");
  await expect(config.locator("h2.fsd")).toHaveText("Settings demo config — Hello, GM!");
  await expect(config.locator("h2.fsd")).toHaveCSS("color", "rgb(255, 0, 0)"); // the module's own styles.css applies in its frame
  await expect(config.locator("input[name=radius]")).toHaveValue("20");
  await expect(config.locator("select[name=mode] option")).toHaveText(["Soft", "Hard"]);
  await expect(config.locator("ul.fsd-items li")).toHaveText(["ALPHA", "BETA"]);
  await expect(config.locator("ul.fsd-items li.hot")).toHaveCount(1);
  await expect(config.locator("button[type=submit]")).toContainText("Save changes");
  // jQuery listener from activateListeners, then the form submit → _updateObject → game.settings.set → replicated world settings.
  await config.locator("[data-action=bump]").click();
  await config.locator("[data-action=bump]").click();
  await expect(config.locator("input[name=radius]")).toHaveValue("30");
  await config.locator("select[name=mode]").selectOption("hard");
  await config.locator("button[type=submit]").click();
  await expect(frame.locator("#fsd-config")).toHaveCount(0);               // closeOnSubmit
  await expect(panel).toHaveAttribute("data-ais-panel-open", "false");      // last window closed → panel hidden
  await expect.poll(() => settingsDoc(page, "fsd-demo")).toMatchObject({ fsd_demo_radius: 30, fsd_demo_mode: "hard" });
  const state = await result(page, "fsd-demo", "foundry.api", { path: "state" });
  expect(state.submitted).toEqual({ radius: 30, mode: "hard", enabled: true });
  expect(state.changes).toEqual([["radius", 30]]);

  // Dialog.confirm: the macro waits on the dialog; the GM's click in the frame resolves it.
  const pending = await invoke(page, "fsd-demo", "foundry.api", { path: "FsdUi.confirm" });
  const dialog = frame.locator(".window-app.dialog");
  await expect(dialog.locator(".window-title")).toHaveText("Are you sure?");
  await expect(dialog.locator(".dialog-content")).toHaveText("Apply?");
  await dialog.locator("button.dialog-button.yes").click();
  await expect(pending.getByRole("status")).toContainText("Script completed", { timeout: 12_000 });
  expect(JSON.parse(await pending.locator("details pre").innerText())).toBe(true);
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const pendingV2 = await invoke(page, "fsd-demo", "foundry.api", { path: "FsdUi.confirmV2" });
  await frame.locator('.application.dialog button[data-action="no"]').click();
  await expect(pendingV2.getByRole("status")).toContainText("Script completed", { timeout: 12_000 });
  expect(JSON.parse(await pendingV2.locator("details pre").innerText())).toBe(false);
  await page.locator('[data-window="macros"] [data-window-close]').click();

  // ApplicationV2 + HandlebarsApplicationMixin: PARTS re-render from a data-action handler.
  const v2 = await result(page, "fsd-demo", "foundry.api", { path: "FsdUi.openPanel" });
  expect(v2).toMatchObject({ id: "fsd-panel", class: "FsdPanel", title: "Demo panel", rendered: true });
  const v2Window = frame.locator("#fsd-panel");
  await expect(v2Window.locator(".window-title")).toHaveText("Demo panel");
  await expect(v2Window.locator(".fsd-radius")).toHaveText("radius: 30 (hard)");
  await v2Window.locator("[data-action=ping]").click();
  await v2Window.locator("[data-action=ping]").click();
  await expect(v2Window.locator(".fsd-pings")).toHaveText("pings: 2");
  await expect(page.locator("[data-notify]").last()).toContainText("FSD ping 2"); // ui.notifications.info → the shell's notice stack
  expect((await result(page, "fsd-demo", "foundry.info")).windows).toEqual([expect.objectContaining({ id: "fsd-panel", api: "ApplicationV2", rendered: true })]);
  // The shell's own panel chrome closes the panel without touching the module's document; its window survives for the next open.
  await panel.locator("[data-ais-panel-close]").click();
  await expect(panel).toHaveAttribute("data-ais-panel-open", "false");
  // D-483 `ui.panel.closed`: the chrome's Close button really closes the module's windows (close hooks run),
  // so the next render starts from a clean frame instead of resurrecting stale windows.
  await expect.poll(async () => (await result(page, "fsd-demo", "foundry.info")).windows).toEqual([]);
  await result(page, "fsd-demo", "foundry.ui", { app: "FsdUi.FsdPanel" });
  await expect(panel).toHaveAttribute("data-ais-panel-open", "true");
  await expect(frame.locator(".application.fsd")).toHaveCount(1);
  await expect(frame.locator(".fsd-pings")).toHaveText("pings: 0"); // foundry.ui {app} constructs a fresh instance
});

test("D-484: the emulator's own core resource library — core templates, core i18n keys, foundry.data.fields/DataModel settings — serves a module that ships none of it", async ({ page }) => {
  test.setTimeout(180_000);
  await openWorld(page);
  await page.locator("#gm-settings").click();
  await importPackage(page, "fsd-demo-1.0.0.zip", foundryCoreApiModuleZip(), "fsd-demo");
  await approve(page, "ais-foundry-v13");
  await approve(page, "fsd-demo");
  await reloadAndWaitReady(page, ["fsd-demo"]);
  const panel = page.locator('[data-ais-panel="fsd-demo"]');
  const frame = page.frameLocator('iframe[title="AIS module:fsd-demo"]');

  // Ready-hook probes: core keys resolve (module keys still win), type lists and enumerations exist,
  // the DataModel-typed setting comes back as an instance, a core template renders, a missing one names itself.
  const state = await result(page, "fsd-demo", "foundry.api", { path: "state" });
  expect(state).toMatchObject({
    coreI18n: ["Yes", "Save Changes", true, "Foundry Settings Demo"], actorTypes: ["base", "character", "npc"], release: 13,
    displayModes: ["NONE", "CONTROL", "OWNER_HOVER", "HOVER", "OWNER", "ALWAYS"],
    prefsIsModel: true, prefs: { radius: 20, mode: "soft", enabled: true },
  });
  expect(state.rollCard).toContain('<div class="dice-formula">1d20 + 5</div>');
  expect(state.rollCard).toContain('<h4 class="dice-total">17</h4>');
  expect(state.missing).toContain("Core template templates/sidebar/apps/compendium.html is not in the AIS Foundry core library yet");
  const info = await result(page, "fsd-demo", "foundry.info");
  expect(info.templates).toMatchObject({ core: ["templates/dice/roll.html"], missing: ["templates/sidebar/apps/compendium.html"] });
  expect(info.settings).toContainEqual({ key: "fsd-demo.prefs", aisKey: "fsd_demo_prefs", scope: "world", kind: "json", synced: true, hidden: true });

  // The V2 form: tab strip and footer are core parts; the inputs come from DataFields; labels from module + core keys.
  const opened = await result(page, "fsd-demo", "foundry.ui", { app: "FsdUi.FsdPrefsApp" });
  expect(opened).toMatchObject({ id: "fsd-prefs", class: "FsdPrefsApp", title: "Demo preferences", rendered: true });
  await expect(panel).toHaveAttribute("data-ais-panel-open", "true");
  const win = frame.locator("form#fsd-prefs.application");
  await expect(win.locator(".window-title")).toHaveText("Demo preferences");
  const nav = win.locator('nav.tabs[data-application-part="tabs"][data-group="primary"]');
  await expect(nav.locator("a.item")).toHaveCount(2);
  await expect(nav.locator('a.item.active[data-tab="general"]')).toContainText("General");
  const radius = win.locator('input[name="radius"]');
  await expect(radius).toHaveAttribute("type", "number");
  await expect(radius).toHaveAttribute("max", "60");
  await expect(radius).toHaveValue("20");
  const radiusGroup = win.locator(".form-group", { has: frame.locator('input[name="radius"]') });
  await expect(radiusGroup.locator("label")).toHaveText("Light radius");
  await expect(radiusGroup.locator("p.hint")).toHaveText("In feet");
  await expect(win.locator('select[name="mode"] option')).toHaveText(["Soft", "Hard"]);
  await expect(win.locator('input[name="enabled"]')).toBeChecked();
  await expect(win.locator(".form-group", { has: frame.locator('input[name="actor"]') }).locator("label")).toHaveText("Actor");
  const footer = win.locator('footer.form-footer[data-application-part="footer"]');
  await expect(footer.locator('button[type="submit"]')).toContainText("Save Changes");
  await expect(footer.locator('button[data-action="reset"]')).toContainText("Reset Defaults");
  await nav.locator('a.item[data-tab="about"]').click();
  await expect(win.locator('.tab.active[data-tab="about"] .fsd-about')).toHaveText("Are you sure?");
  await nav.locator('a.item[data-tab="general"]').click();
  // Submit through the core footer → DataModel.updateSource (cast + validated) → game.settings.set → replicated world settings.
  await radius.fill("35");
  await win.locator('select[name="mode"]').selectOption("hard");
  await footer.locator('button[type="submit"]').click();
  await expect(frame.locator("#fsd-prefs")).toHaveCount(0); // closeOnSubmit
  await expect.poll(() => settingsDoc(page, "fsd-demo")).toMatchObject({ fsd_demo_prefs: JSON.stringify({ radius: 35, mode: "hard", enabled: true }) });
  const after = await result(page, "fsd-demo", "foundry.api", { path: "state" });
  expect(after).toMatchObject({ prefsSaved: { radius: 35, mode: "hard", enabled: true }, prefsIsModelAfter: true });
  // Out-of-range source is refused by the model before anything is written.
  const rejected = await invoke(page, "fsd-demo", "foundry.api", { path: "game.settings.set", args: ["fsd-demo", "prefs", { radius: 999 }] });
  await expect(rejected.getByRole("status")).toContainText("radius must be at most 60");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  expect(await settingsDoc(page, "fsd-demo")).toMatchObject({ fsd_demo_prefs: JSON.stringify({ radius: 35, mode: "hard", enabled: true }) });
  expect((await result(page, "fsd-demo", "foundry.info")).templates.core).toEqual(["templates/dice/roll.html", "templates/generic/form-footer.hbs", "templates/generic/form-group.hbs", "templates/generic/tab-navigation.hbs"]);
});

test("D-485: world documents — a Foundry module creates/updates Actors, embedded Items and a JournalEntry through the generic document service; hooks follow replication both ways", async ({ page }) => {
  test.setTimeout(180_000);
  await openWorld(page);
  await page.locator("#gm-settings").click();
  await importPackage(page, "fsd-demo-1.0.0.zip", foundryCoreApiModuleZip(), "fsd-demo");
  await approve(page, "ais-foundry-v13");
  await approve(page, "fsd-demo");
  await reloadAndWaitReady(page, ["fsd-demo"]);

  // The replica hydrated before `init`: the GM device's user and collections are real documents.
  const info = await result(page, "fsd-demo", "foundry.info");
  expect(info.documents).toMatchObject({ userName: expect.any(String), events: expect.any(Number), writes: 0, rejectedWrites: 0, hookErrors: [] });
  expect(typeof info.documents.hydrateMs).toBe("number");
  test.info().annotations.push({ type: "documents.hydrate", description: `${info.documents.documents} documents in ${info.documents.hydrateMs} ms (${JSON.stringify(info.documents.collections)})` });
  console.log(`D-485 hydrate: ${info.documents.documents} documents in ${info.documents.hydrateMs} ms`, JSON.stringify(info.documents.collections));
  expect(info.documents.collections.users).toBeGreaterThanOrEqual(1);
  const hydratedActors: number = info.documents.collections.actors;

  // Plain Foundry document code, run inside the module: create → embedded create → update → flags → journal with inline page.
  const probe = await result(page, "fsd-demo", "foundry.api", { path: "documents" });
  expect(probe.before).toMatchObject({ actors: hydratedActors, isGM: true, userDoc: true, userName: info.documents.userName });
  expect(probe).toMatchObject({
    uuid: `Actor.${probe.actorId}`, type: "npc", name: "FSD Guard II", hp: 4, isOwner: true, flags: { origin: "probe", count: 1 },
    itemTypes: ["equipment", "weapon"],
    resolved: { torchSync: true, actorAsync: true, pageType: "text", pageText: "<p>Hold the gate</p>", byName: true, inCollection: true },
    after: { actors: hydratedActors + 1 },
  });
  expect(probe.items).toEqual([
    { name: "Shield", type: "equipment", lit: null, uuid: expect.stringMatching(new RegExp(`^Actor\\.${probe.actorId}\\.Item\\.`)) },
    { name: "Torch", type: "weapon", lit: true, uuid: expect.stringMatching(new RegExp(`^Actor\\.${probe.actorId}\\.Item\\.`)) },
  ]);

  // The shell's own store holds store-shaped documents: kind markers, subtype flag, creator ownership, completed embedded rows.
  const stored = await page.evaluate(({ actorId, journalId }) => {
    const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
    const actor = client.store.get("actors", actorId) as import("../src/core/documents").ActorDocument | undefined;
    const journal = client.store.get("journals", journalId) as import("../src/core/documents").JournalDocument | undefined;
    return { actor: actor && { type: actor.type, name: actor.name, flags: actor.flags, system: actor.system, ownerLevels: Object.values(actor.ownership),
      items: actor.items.map((item) => ({ type: item.type, name: item.name, system: item.system, hasId: typeof item._id === "string" && item._id.length > 0, effects: item.effects })) },
      journal: journal && { type: journal.type, pages: journal.pages.map((p) => ({ type: p.type, name: p.name, text: p.text, src: p.src })) }, userId: client.user?.id };
  }, { actorId: probe.actorId, journalId: probe.journalId });
  expect(stored.actor).toEqual({
    type: "actor", name: "FSD Guard II", flags: { "fsd-demo": { origin: "probe", count: 1 }, "ais-foundry": { type: "npc" } }, system: { hp: { value: 4, max: 5 } },
    ownerLevels: expect.arrayContaining([3]),
    items: [
      { type: "item", name: "Shield", system: {}, hasId: true, effects: [] },
      { type: "item", name: "Torch", system: { lit: true }, hasId: true, effects: [] },
    ],
  });
  expect(stored.journal).toEqual({ type: "journal", pages: [{ type: "page", name: "Plan", text: "<p>Hold the gate</p>", src: null }] });
  expect(probe.before.userId).toBe(stored.userId);

  // Post hooks fired once per replicated change, Foundry-shaped `(doc, changes, options, userId)`.
  const events = await result(page, "fsd-demo", "foundry.api", { path: "docEvents" });
  const names = events.map((row: { hook: string; name: string }) => `${row.hook}:${row.name}`);
  expect(names).toEqual(["createActor:FSD Guard", "createItem:Torch", "updateItem:Torch", "updateActor:FSD Guard", "updateActor:FSD Guard II", "createJournalEntry:FSD Notes"]);
  expect(events[2]).toMatchObject({ changes: { system: { lit: true } }, userId: stored.userId });
  expect(events[3]).toMatchObject({ changes: { flags: { "fsd-demo": { count: 1 } } } });
  expect(events[4]).toMatchObject({ changes: { name: "FSD Guard II", system: { hp: { value: 4 } } } });

  // The other direction: the shell edits the actor; the module's instance refreshes in place and `updateActor` fires.
  await page.evaluate(async (actorId) => {
    const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
    await client.submitAndWait([{ kind: "update", ref: { coll: "actors", id: actorId }, diff: { "system.hp.value": 9 } }]);
  }, probe.actorId);
  await expect.poll(async () => (await result(page, "fsd-demo", "foundry.api", { path: "actorView", args: [probe.actorId] })).hp, { timeout: 15_000 }).toBe(9);
  const afterShell = await result(page, "fsd-demo", "foundry.api", { path: "docEvents" });
  expect(afterShell.at(-1)).toMatchObject({ hook: "updateActor", name: "FSD Guard II", changes: { system: { hp: { value: 9 } } } });
  const finalInfo = await result(page, "fsd-demo", "foundry.info");
  expect(finalInfo.documents).toMatchObject({ writes: 6, rejectedWrites: 0, hookErrors: [] });
  expect(finalInfo.unsupportedCalls).toEqual([]);

  // Measured write latency in the quiet state (recorded in the report, not asserted against a threshold).
  const bench = await result(page, "fsd-demo", "foundry.api", { path: "bench", args: [probe.actorId, 10] });
  expect(bench).toMatchObject({ n: 10, hp: 19 });
  test.info().annotations.push({ type: "documents.write", description: `${bench.msPerWrite} ms per awaited actor.update (10 sequential)` });
  console.log(`D-485 write latency: ${bench.msPerWrite} ms per awaited actor.update (10 sequential)`);
  // Host-side handler time per RPC (the Health trace) separates kernel cost from channel/frame cost.
  await page.locator("#gm-settings").click();
  const health = page.locator('[data-ais-health="fsd-demo"]');
  await health.locator("summary").click();
  await expect(health.locator(".ais-trace li").first()).toBeVisible();
  const trace = await health.locator(".ais-trace li").allInnerTexts();
  test.info().annotations.push({ type: "documents.trace", description: trace.join(" | ") });
  console.log(`D-485 host trace (newest first): ${trace.join(" | ")}`);
  await page.locator('[data-window="settings"] [data-window-close]').click();
});
