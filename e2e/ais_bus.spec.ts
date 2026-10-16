/**
 * D-487 — Multi-device AIS: modules are not host-bound any more. One generic (non-Foundry) AIS
 * module and one UNMODIFIED Foundry-format module run on both the GM's and a player's device and
 * talk across devices over the kernel's bounded channel: `AIS.bus` for generic modules,
 * `game.socket` mapped onto it for Foundry modules. Delivery is same-package only and includes
 * the sender's own frame (Foundry's broadcast semantics); the sender identity is host-stamped.
 *
 * The test boots both modules on the GM, joins a player device (manual signalling, as in
 * ais_player.spec.ts), consents there, and proves both directions by chat traffic: each instance
 * announces itself at boot (player → GM crosses devices), and a GM script-macro ping reaches the
 * player's instances (GM → player crosses devices).
 */
import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { entry, manualFragment, playerCall, waitForSurface } from "./lib";

const demoWorld = fileURLToPath(new URL("../dist/worlds/ais-foundry-feasibility-0.1.0.zip", import.meta.url));

/** A generic AIS module speaking only the kernel API — no Foundry emulation involved. */
function busDemoZip(): Buffer {
  return Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify({
      id: "bus-demo", name: "Bus Demo", version: "1.0.0", type: "module",
      interconnect: {
        api: "arena.ais/1", entry: "automation/entry.js",
        capabilities: ["bus.transmit", "chat.post", "documents.read"],
        commands: [{ id: "ping", contract: 1 }],
      },
    })),
    "automation/entry.js": strToU8([
      `AIS.bus.on("chat", function (data, by) {`,
      `  void AIS.chat.post("bus saw " + JSON.stringify(data) + " from " + (by ? by.name : "?")).catch(function () {});`,
      `});`,
      `AIS.runtime.initialize(async function () {`,
      `  const ctx = await AIS.documents.context();`,
      `  await AIS.bus.emit("chat", { hello: true, from: ctx.userId });`,
      `});`,
      `AIS.commands.on("ping", async function (input) {`,
      `  await AIS.bus.emit("chat", { text: input && input.text, from: "command" });`,
      `  return true;`,
      `});`,
    ].join("\n")),
  }));
}

/** A Foundry-format module speaking only Foundry core APIs (`game.socket`, hooks, chat). */
function fsdSocketZip(): Buffer {
  const files: Record<string, string> = {
    "module.json": JSON.stringify({
      id: "fsd-socket", title: "FSD Socket Probe", version: "1.0.0", description: "<p>socket probe</p>",
      compatibility: { minimum: "12", verified: "13" },
      esmodules: ["scripts/main.mjs"], relationships: { systems: [], requires: [] },
    }, null, 2),
    "scripts/main.mjs": [
      `const MODULE_ID = "fsd-socket";`,
      `const seen = [];`,
      `game.socket.on("module.fsd-socket", (data) => {`,
      `  seen.push(data);`,
      `  ChatMessage.create({ content: "fsd socket " + JSON.stringify(data) }).catch(() => {});`,
      `});`,
      `Hooks.once("ready", () => {`,
      `  game.modules.get(MODULE_ID).api = {`,
      `    seen: () => seen,`,
      `    socketEmit: (data) => { game.socket.emit("module.fsd-socket", data); return true; },`,
      `  };`,
      `  game.socket.emit("module.fsd-socket", { hello: true, from: game.user.id, isGM: game.user.isGM });`,
      `});`,
    ].join("\n"),
  };
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[`fsd-socket/${path}`] = strToU8(text);
  return Buffer.from(zipSync(entries));
}

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

/** GM-side chat traffic as the shell's own store holds it. */
const gmChat = (page: Page) => page.evaluate(() => {
  const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
  return client.store.getAll("messages").map((message) => String(message.content));
});

/** Run a reviewed script macro on the GM device that invokes one module command (as ais_foundry_module.spec.ts). */
async function invoke(page: Page, moduleId: string, command: string, input: unknown = {}): Promise<void> {
  const settingsClose = page.locator('[data-window="settings"] [data-window-close]');
  if (await settingsClose.count()) await settingsClose.click();
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-script-tab]").click();
  const panel = page.locator("[data-script-wizard]");
  await panel.locator("[data-script-name]").fill("D-487 bus probe");
  await panel.locator("[data-script-source]").fill(`return await api.ais.invoke(${JSON.stringify(moduleId)}, ${JSON.stringify(command)}, ${JSON.stringify(input)});`);
  await panel.locator(".grants label").filter({ hasText: "ais.invoke" }).locator("input").check();
  await panel.getByLabel("I reviewed this exact revision and its host grants").check();
  await panel.locator("[data-script-save]").click();
  await expect(panel.getByRole("status")).toContainText("Script revision published");
  await panel.locator("[data-script-run]").click();
  await expect(panel.getByRole("status")).toContainText("Script completed", { timeout: 12_000 });
}

test("D-487: generic and Foundry modules run on the player device and their channels cross devices", async ({ browser }) => {
  test.setTimeout(360_000);
  const gmContext = await browser.newContext();
  const playerContext = await browser.newContext();
  const gm = await gmContext.newPage();
  const player = await playerContext.newPage();
  try {
    await openWorld(gm);
    await gm.locator("#gm-settings").click();
    await importPackage(gm, "bus-demo.zip", busDemoZip(), "bus-demo");
    await importPackage(gm, "fsd-socket-1.0.0.zip", fsdSocketZip(), "fsd-socket");
    await approve(gm, "ais-foundry-v13");
    await approve(gm, "bus-demo");
    await approve(gm, "fsd-socket");
    await Promise.all([gm.waitForEvent("load"), gm.locator("[data-ais-reload]").click()]);
    await waitForSurface(gm, "app");
    await gm.locator("#gm-settings").click();
    for (const id of ["bus-demo", "fsd-socket"])
      await expect(gm.locator(`[data-ais-module-review="${id}"] [data-ais-runtime]`))
        .toHaveAttribute("data-ais-runtime", "ready", { timeout: 15_000 });
    await gm.locator('[data-window="settings"] [data-window-close]').click();

    // The GM's own instances heard their boot announces (sender hears itself).
    await expect.poll(() => gmChat(gm), { timeout: 15_000 }).toEqual(expect.arrayContaining([
      expect.stringContaining('"hello":true'),
      expect.stringContaining("fsd socket "),
    ]));
    const gmHello = (await gmChat(gm)).filter((line) => line.includes("fsd socket ") && line.includes('"hello":true'));
    expect(gmHello.some((line) => line.includes('"isGM":true'))).toBe(true);

    // Join a player device (manual signalling, as in ais_player.spec.ts / e2e/join.spec.ts).
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
    const playerId = await playerCall<string>(player, "userId");

    // Both modules are shared now (D-487: Foundry-profile modules are player-shareable); each
    // needs this player's consent on this device before its frame exists.
    for (const id of ["bus-demo", "fsd-socket"]) {
      const consent = player.locator(`[data-ais-consent="${id}"]`);
      await expect(consent).toBeVisible({ timeout: 20_000 });
      await consent.locator("[data-ais-consent-allow]").click();
      await expect(player.locator(`iframe[title="AIS module:${id}"]`)).toHaveCount(1, { timeout: 15_000 });
    }

   
    // Player → GM: the player instances' boot announces crossed devices and were echoed locally.
    const playerChat = () => playerCall<string[]>(player, "aisChatTexts");
    await expect.poll(() => gmChat(gm).then((lines) => lines.some(
      (line) => line.startsWith("bus saw ") && line.includes(`"from":"${playerId}"`))), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => gmChat(gm).then((lines) => lines.some(
      (line) => line.startsWith("fsd socket ") && line.includes(`"from":"${playerId}"`) && line.includes('"isGM":false'))),
      { timeout: 20_000 }).toBe(true);
    // The sender hears itself on its own device too (Foundry broadcast semantics).
    await expect.poll(playerChat, { timeout: 15_000 }).toEqual(expect.arrayContaining([
      expect.stringContaining(`"from":"${playerId}"`),
    ]));

   
    // GM → player: GM-side triggers (generic module command; Foundry module's own API) cross devices.
    await invoke(gm, "bus-demo", "ping", { text: "gm-later" });
    await invoke(gm, "fsd-socket", "foundry.api", { path: "socketEmit", args: [{ ping: 1, from: "gm" }] });
    await expect.poll(() => gmChat(gm).then((lines) => lines.some(
      (line) => line.startsWith("bus saw ") && line.includes('"text":"gm-later"'))), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => playerChat().then((lines) => lines.some(
      (line) => line.startsWith("bus saw ") && line.includes('"text":"gm-later"'))), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => playerChat().then((lines) => lines.some(
      (line) => line.startsWith("fsd socket ") && line.includes('"ping":1'))), { timeout: 20_000 }).toBe(true);

    // The Foundry instance on the player device is the player: its socket state holds what it
    // heard, and its view of `game.user` is the player (announced as isGM:false above).
    expect((await playerChat()).some((line) => line.includes("fsd socket ") && line.includes('"from":"gm"'))).toBe(true);
  } finally {
    await gmContext.close();
    await playerContext.close();
  }
});
