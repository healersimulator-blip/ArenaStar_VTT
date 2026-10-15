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
      `const state = { changes: [], ready: false, classic: typeof window.FSD_CLASSIC, side: globalThis.FSD_SIDE === true };`,
      `Hooks.once("init", () => {`,
      `  game.settings.register(MODULE_ID, "radius", { name: "FSD.Radius", hint: "FSD.RadiusHint", scope: "world", config: true, type: Number,`,
      `    default: 20, range: { min: 0, max: 60, step: 5 }, onChange: (value) => state.changes.push(["radius", value]) });`,
      `  game.settings.register(MODULE_ID, "enabled", { name: "FSD.Enabled", scope: "client", config: true, type: Boolean, default: true });`,
      `  game.settings.register(MODULE_ID, "mode", { name: "FSD.Mode", scope: "world", config: true, type: String, choices: { soft: "FSD.Soft", hard: "FSD.Hard" }, default: "soft" });`,
      `  game.settings.register(MODULE_ID, "state", { scope: "world", config: false, type: Object, default: { seen: [] } });`,
      `  game.keybindings.register(MODULE_ID, "toggle", { name: "Toggle", editable: [{ key: "KeyT" }], onDown: () => {} });`,
      `  Handlebars.registerHelper("fsdUpper", (text) => String(text).toUpperCase());`,
      `  CONFIG.debug.fsd = true;`,
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
      `  ui.notifications.info(game.i18n.localize("FSD.Ready"));`,
      `  game.modules.get(MODULE_ID).api = { state: () => state, radius: () => game.settings.get(MODULE_ID, "radius"),`,
      `    setRadius: (value) => game.settings.set(MODULE_ID, "radius", value) };`,
      `});`,
      "",
    ].join("\n"),
    "lang/en.json": JSON.stringify({ FSD: { Title: "Foundry Settings Demo", Radius: "Light radius", RadiusHint: "In feet", Enabled: "Enabled on this device",
      Mode: "Mode", Soft: "Soft", Hard: "Hard", Hello: "Hello, {name}!", Ready: "Demo is ready" } }),
    "styles/demo.css": ".fsd { color: red; }\n",
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
  await expect(block.locator("summary")).toContainText("Settings (4)");
  await block.locator("summary").click();
  const form = block.locator('[data-ais-settings-form="fsd-demo"]');
  await expect(form.locator("[data-ais-setting]")).toHaveCount(3);
  await expect(form.locator("[data-ais-settings-hidden]")).toHaveAttribute("data-ais-settings-hidden", "1");
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
