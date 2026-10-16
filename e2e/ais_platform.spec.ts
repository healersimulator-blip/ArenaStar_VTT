import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { entry, manualFragment, playerCall, surfaceCallArg, waitForSurface } from "./lib";

/**
 * D-476…D-479 in the real bundle (no RPC mocks): declared settings edited through the generated
 * form — GM: world + device scope, player: device scope with the GM's world values replicated and
 * read-only — compendium reads over an imported content package, the module bus along a declared
 * dependency with the device's authority, and the Health block + Restart in the GM's review.
 */

const siblingSource = `
AIS.commands.on("ping", function (input, context) {
  return { pong: input, runAs: context.runAs, requestId: context.requestId };
});
`;

/** Records every settings change it hears; reports everything a module can see through the new surfaces. */
const probeSource = `
const changes = [];
AIS.settings.onChange(function (change) { changes.push(change.scope + ":" + change.key + "=" + change.value); });
AIS.commands.on("probe", async function (input, context) {
  const ais = context.ais;
  const listed = await ais.settings.list();
  const packs = await ais.compendium.list();
  const hits = await ais.compendium.search("owlbear", { limit: 5 });
  const beast = hits.length ? await ais.compendium.get(hits[0].packId, hits[0].entryId) : null;
  const modules = (await ais.modules.list()).map(function (row) { return row.packageId + ":" + row.running; });
  const sibling = await ais.modules.invoke("ais-sibling", "ping", { n: 1 });
  let selfInvoke = null;
  try { await ais.modules.invoke("ais-settings-probe", "probe", {}); } catch (error) { selfInvoke = error.message; }
  return {
    settings: listed.settings.map(function (row) { return row.key + "/" + row.scope + "=" + row.value; }),
    radius: await ais.settings.get("radius"),
    packs: packs.map(function (pack) { return pack.id + "#" + pack.entries; }),
    beast: beast ? beast.name + "/" + beast.type + "/" + beast.data.system.cr : null,
    modules, sibling, selfInvoke, changes,
  };
});
AIS.commands.on("status", async function (input, context) {
  const ais = context.ais;
  const radius = await ais.settings.get("radius");
  // A write of the current value: a no-op for GM authority, refused outright for a player.
  let worldWrite = null;
  try { await ais.settings.set("radius", radius); } catch (error) { worldWrite = String(error.message).slice(0, 60); }
  return { radius, quiet: await ais.settings.get("quiet"), changes, worldWrite };
});
`;

const settings = [
  { key: "radius", scope: "world", type: "number", label: "Light radius (ft)", hint: "Replicated to every player.", default: 20, min: 0, max: 120, step: 5 },
  { key: "quiet", scope: "device", type: "boolean", label: "No notifications", default: false },
  { key: "style", scope: "world", type: "choice", label: "Style", default: "warm", choices: [{ value: "warm", label: "Warm" }, { value: "cold", label: "Cold" }] },
];

interface ModuleSpec { id: string; source: string; capabilities: string[]; commands: string[]; requires?: string[]; settings?: typeof settings }
function moduleZip(spec: ModuleSpec): Buffer {
  return Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify({
      id: spec.id, name: spec.id, version: "1.0.0", type: "module",
      interconnect: {
        api: "arena.ais/1", entry: "automation/entry.js", capabilities: spec.capabilities,
        commands: spec.commands.map((command) => ({ id: command, contract: 1 })),
        ...(spec.requires ? { requires: spec.requires.map((id) => ({ id })) } : {}),
        ...(spec.settings ? { settings: spec.settings } : {}),
      },
    })),
    "automation/entry.js": strToU8(spec.source),
  }));
}

const beastsZip = Buffer.from(zipSync({
  "manifest.json": strToU8(JSON.stringify({
    id: "ais-beasts", name: "AIS Beasts", version: "1.0.0", type: "data",
    packs: [{ name: "Beasts", type: "actors", file: "packs/beasts.json" }],
  })),
  "packs/beasts.json": strToU8(JSON.stringify({ name: "Beasts", type: "actors", entries: [
    { id: "owlbear", name: "Owlbear", keywords: ["beast"], data: { type: "actor", name: "Owlbear", system: { cr: 4 } } },
    { id: "wolf", name: "Wolf", data: { type: "actor", name: "Wolf", system: { cr: 1 } } },
  ] })),
}));

async function importPackage(page: Page, name: string, buffer: Buffer, id: string): Promise<void> {
  await page.locator("#pkg-file").setInputFiles({ name, mimeType: "application/zip", buffer });
  await expect(page.locator(`[data-pkg-row][data-pkg-id="${id}"]`)).toBeVisible();
}

/** The same approval dance as e2e/ais_modules.spec.ts: enable → review source → approve hash → reload → ready. */
async function approve(page: Page, id: string): Promise<void> {
  const row = page.locator(`[data-pkg-row][data-pkg-id="${id}"]`);
  if (await row.locator("[data-ais-enable]").count()) await row.locator("[data-ais-enable]").click();
  const review = page.locator(`[data-ais-module-review="${id}"]`);
  for (const checkbox of await review.locator('fieldset input[type="checkbox"]').all()) await checkbox.check();
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator(".ais-source-preview pre")).toContainText("AIS.commands.on");
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator("[data-ais-approved]")).toBeVisible();
  await Promise.all([page.waitForEvent("load"), page.locator("[data-ais-reload]").click()]);
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  await expect(review.locator("[data-ais-runtime]")).toHaveAttribute("data-ais-runtime", "ready", { timeout: 10_000 });
  await expect(page.locator(`iframe[title="AIS module:${id}"]`)).toHaveCount(1);
}

async function runReviewedScript(page: Page, source: string): Promise<ReturnType<Page["locator"]>> {
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-script-tab]").click();
  const scripts = page.locator("[data-script-wizard]");
  await scripts.locator("[data-script-name]").fill("AIS platform acceptance");
  await scripts.locator("[data-script-source]").fill(source);
  await scripts.locator(".grants label").filter({ hasText: "ais.invoke" }).locator("input").check();
  await scripts.getByLabel("I reviewed this exact revision and its host grants").check();
  await scripts.locator("[data-script-save]").click();
  await expect(scripts.getByRole("status")).toContainText("Script revision published");
  await scripts.locator("[data-script-run]").click();
  await expect(scripts.getByRole("status")).toContainText("Script completed", { timeout: 15_000 });
  return scripts;
}

const settingsDoc = (page: Page, id: string) => page.evaluate((id) => {
  const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
  const doc = client.store.get("settings", `ais-settings:${id}`);
  return doc ? (doc.flags as { ais: { values: Record<string, unknown> } }).ais.values : null;
}, id);

test("GM: the generated settings form, compendium reads, the module bus and Health/Restart on real modules", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  await importPackage(page, "ais-beasts.zip", beastsZip, "ais-beasts");
  await importPackage(page, "ais-sibling.zip", moduleZip({ id: "ais-sibling", source: siblingSource, capabilities: [], commands: ["ping"] }), "ais-sibling");
  await approve(page, "ais-sibling");
  await importPackage(page, "ais-settings-probe.zip", moduleZip({
    id: "ais-settings-probe", source: probeSource, commands: ["probe", "status"], requires: ["ais-sibling"], settings,
    capabilities: ["module.settings.write", "modules.invoke", "compendium.read"],
  }), "ais-settings-probe");
  await approve(page, "ais-settings-probe");

  const review = page.locator('[data-ais-module-review="ais-settings-probe"]');
  await expect(review.locator("[data-ais-requires]")).toContainText("ais-sibling");

  // D-476: the form is generated from the manifest; world values become a replicated document,
  // device values stay here; the declaration validates every write.
  const block = review.locator('[data-ais-settings="ais-settings-probe"]');
  await block.locator("summary").click();
  const form = block.locator('[data-ais-settings-form="ais-settings-probe"]');
  const radius = form.locator('[data-ais-setting="radius"] input');
  await expect(radius).toHaveValue("20");
  await expect(form.locator('[data-ais-setting="radius"]')).toHaveAttribute("data-ais-setting-scope", "world");
  await radius.fill("7");
  await radius.dispatchEvent("change");
  await expect(form.locator('[data-ais-setting-error="radius"]')).toContainText("steps of 5");
  expect(await settingsDoc(page, "ais-settings-probe")).toBeNull();
  await radius.fill("45");
  await radius.dispatchEvent("change");
  await expect.poll(() => settingsDoc(page, "ais-settings-probe")).toEqual({ radius: 45 });
  await expect(form.locator('[data-ais-setting-error="radius"]')).toHaveCount(0);
  await form.locator('[data-ais-setting="style"] select').selectOption("cold");
  await expect.poll(() => settingsDoc(page, "ais-settings-probe")).toEqual({ radius: 45, style: "cold" });
  await form.locator('[data-ais-setting="quiet"] input').check();
  await expect(form.locator('[data-ais-setting="quiet"] input')).toBeChecked();
  expect(await settingsDoc(page, "ais-settings-probe")).toEqual({ radius: 45, style: "cold" }); // device scope never becomes a document
  await page.locator('[data-window="settings"] [data-window-close]').click();

  // What the module saw: its own settings (world + device), the change events, the imported pack
  // through compendium.read, its sibling over the bus with GM-device authority and a traceable id.
  const scripts = await runReviewedScript(page, `return await api.ais.invoke("ais-settings-probe", "probe", {});`);
  const report = JSON.parse(await scripts.locator("details pre").innerText()) as {
    settings: string[]; radius: number; packs: string[]; beast: string | null; modules: string[];
    sibling: { pong: { n: number }; runAs: string; requestId: string }; selfInvoke: string; changes: string[];
  };
  expect(report.settings).toEqual(["radius/world=45", "quiet/device=true", "style/world=cold"]);
  expect(report.radius).toBe(45);
  expect(report.packs).toContain("ais-beasts/packs/beasts.json#2");
  expect(report.beast).toBe("Owlbear/actor/4"); // `type` is the entry document type (D-477), the pack type is on compendium.list
  expect(report.modules).toContain("ais-sibling:true");
  expect(report.modules).not.toContain("ais-settings-probe:true");
  expect(report.sibling).toEqual({ pong: { n: 1 }, runAs: "gm", requestId: "ais-module:ais-settings-probe:1" });
  expect(report.selfInvoke).toContain("cannot invoke itself");
  expect(report.changes).toEqual(["world:radius=45", "world:style=cold", "device:quiet=true"]);

  // D-479: the Health block counts that traffic; Restart brings a fresh frame that re-reads the same values.
  await page.locator("#gm-settings").click();
  const health = review.locator('[data-ais-health="ais-settings-probe"]');
  await health.locator("summary").click();
  await expect(health.locator("[data-ais-health-counters]")).toContainText("commands 1");
  const counters = await health.locator("[data-ais-health-counters]").innerText();
  const requests = Number(/Requests (\d+)/.exec(counters)?.[1] ?? "0");
  expect(requests).toBeGreaterThanOrEqual(8);
  await expect(health.locator(".ais-trace li").first()).toContainText("command probe");
  await health.locator("[data-ais-restart]").click();
  await expect(health.locator("[data-ais-health-notice]")).toContainText("Restarted");
  await expect(review.locator("[data-ais-runtime]")).toHaveAttribute("data-ais-runtime", "ready", { timeout: 10_000 });
  await expect(page.locator('iframe[title="AIS module:ais-settings-probe"]')).toHaveCount(1);
  await page.locator('[data-window="settings"] [data-window-close]').click();
  const after = await runReviewedScript(page, `return await api.ais.invoke("ais-settings-probe", "status", {});`);
  await expect(after.locator("details pre")).toContainText('"radius": 45');
  await expect(after.locator("details pre")).toContainText('"quiet": true');
  await expect(after.locator("details pre")).toContainText('"worldWrite": null'); // GM device: world writes are allowed
  await expect(after.locator("details pre")).toContainText('"changes": []'); // a fresh frame has heard nothing yet

  // The device value survives a reload; the world value is in the world.
  await page.reload();
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  await review.locator('[data-ais-settings="ais-settings-probe"] summary').click();
  await expect(review.locator('[data-ais-setting="radius"] input')).toHaveValue("45");
  await expect(review.locator('[data-ais-setting="quiet"] input')).toBeChecked();
  await expect(review.locator('[data-ais-setting="style"] select')).toHaveValue("cold");
});

test("player: device settings are theirs, world settings are the GM's and arrive through the replica", async ({ browser }) => {
  test.setTimeout(180_000);
  const gmContext = await browser.newContext();
  const playerContext = await browser.newContext();
  const gm = await gmContext.newPage();
  const player = await playerContext.newPage();
  try {
    await gm.goto(entry);
    await gm.locator("#role-import").setInputFiles(fileURLToPath(new URL("../dist/worlds/pf1e-mass-battles-starter-1.0.0.zip", import.meta.url)));
    await gm.locator("[data-open-copy]").click();
    await expect(gm.locator("#status")).toContainText("Pathfinder 1e Mass Battles");
    await gm.goto(entry + "?e2e=1");
    await waitForSurface(gm, "app");
    await gm.locator("#gm-settings").click();
    await importPackage(gm, "ais-settings-probe.zip", moduleZip({
      id: "ais-settings-probe", source: probeSource, commands: ["status"], settings,
      capabilities: ["module.settings.write"],
    }), "ais-settings-probe");
    await approve(gm, "ais-settings-probe");
    const review = gm.locator('[data-ais-module-review="ais-settings-probe"]');
    await expect(review.locator("[data-ais-share-players]")).toBeChecked();
    await review.locator('[data-ais-settings="ais-settings-probe"] summary').click();
    const gmRadius = review.locator('[data-ais-setting="radius"] input');
    await gmRadius.fill("45");
    await gmRadius.dispatchEvent("change");
    await expect.poll(() => settingsDoc(gm, "ais-settings-probe")).toEqual({ radius: 45 });

    // A token the player owns, for the command runner.
    const target = await gm.evaluate(async () => {
      const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
      const scene = client.store.getAll("scenes").find((row) => row.active);
      const token = scene?.tokens.find((row) => row.actorId);
      if (!scene || !token) throw new Error("starter world needs a token linked to an actor");
      await client.submitAndWait([
        { kind: "update", ref: { coll: "tokens", id: token._id, parent: { coll: "scenes", id: scene._id } }, diff: { "ownership.default": 3 } },
      ]);
      return { centre: { x: token.x, y: token.y } }; // token x/y is the centre (src/canvas/tokens.ts tokenRect)
    });
    await gm.locator('[data-window="settings"] [data-window-close]').click();

    // Manual signalling, as in e2e/join.spec.ts.
    await gm.locator("#share").click();
    const fragment = manualFragment(await gm.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await gm.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await gm.locator("#code-apply").click();
    await expect.poll(() => gm.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await gm.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");

    const consent = player.locator('[data-ais-consent="ais-settings-probe"]');
    await expect(consent).toBeVisible({ timeout: 20_000 });
    await consent.locator("[data-ais-consent-allow]").click();
    await expect(player.locator('iframe[title="AIS module:ais-settings-probe"]')).toHaveCount(1, { timeout: 15_000 });

    // The player's card (in the guide drawer, like every per-device choice) renders the same
    // declarations: world read-only with the GM's value, device editable.
    await player.click("[data-player-setup]");
    await expect(player.locator("[data-player-guide]")).toBeVisible();
    const card = player.locator('[data-player-ais-settings="ais-settings-probe"]');
    await card.locator("summary").click();
    const playerRadius = card.locator('[data-ais-setting="radius"] input');
    await expect(playerRadius).toHaveValue("45");
    await expect(playerRadius).toBeDisabled();
    await expect(card.locator('[data-ais-setting="style"] select')).toBeDisabled();
    const quiet = card.locator('[data-ais-setting="quiet"] input');
    await expect(quiet).toBeEnabled();
    await quiet.check();
    await expect(quiet).toBeChecked();

    // Select the owned token and ask the module what it sees: the device value, the replicated
    // world value, the change events, and a world write refused before any op is built.
    // (The point is re-read per attempt: the player's camera can re-fit after layout changes.)
    const runner = player.locator('[data-player-ais-command="ais-settings-probe"]');
    await expect(async () => {
      const screen = await surfaceCallArg<{ x: number; y: number } | null>(player, "playerCanvas", "screenOf", target.centre);
      if (!screen) throw new Error("player token point unavailable");
      await player.mouse.click(screen.x, screen.y);
      await expect(runner).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    await runner.locator("select").selectOption("status");
    await runner.locator("[data-player-ais-run]").click();
    const result = runner.locator("[data-player-ais-result]");
    await expect(result).toContainText('"radius":45', { timeout: 15_000 });
    await expect(result).toContainText('"quiet":true');
    await expect(result).toContainText("device:quiet=true");
    await expect(result).toContainText("GM authority");
    expect(await settingsDoc(gm, "ais-settings-probe")).toEqual({ radius: 45 }); // the refused write never reached the host

    // The GM changes the world value: the player's module hears it through the replica.
    await gm.locator("#gm-settings").click();
    await review.locator('[data-ais-settings="ais-settings-probe"] summary').click(); // a re-opened window starts collapsed
    await gmRadius.fill("60");
    await gmRadius.dispatchEvent("change");
    await expect.poll(() => settingsDoc(gm, "ais-settings-probe")).toEqual({ radius: 60 });
    await expect.poll(async () => {
      await runner.locator("[data-player-ais-run]").click();
      await player.waitForTimeout(500);
      return result.innerText();
    }, { timeout: 30_000 }).toContain("world:radius=60");
    await expect(result).toContainText('"radius":60');
  } finally {
    await playerContext.close();
    await gmContext.close();
  }
});
