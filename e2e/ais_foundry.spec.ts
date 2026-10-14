import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https, { type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { entry, waitForSurface } from "./lib";

const demo = fileURLToPath(new URL("../dist/worlds/ais-foundry-feasibility-0.1.0.zip", import.meta.url));
let server: Server;
let tlsDir: string;
let served: string;
test.use({ ignoreHTTPSErrors: true });
test.beforeAll(async () => {
  tlsDir = mkdtempSync(join(tmpdir(), "ais-foundry-tls-"));
  const key = join(tlsDir, "key.pem"), cert = join(tlsDir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=localhost"], { stdio: "ignore" });
  const html = readFileSync(fileURLToPath(new URL("../dist/index.html", import.meta.url)));
  server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  served = `https://localhost:${(server.address() as AddressInfo).port}/index.html`;
});
test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
});

async function openWorld(page: Page, base: string, path = demo) {
  await page.goto(base);
  await page.locator("#role-import").setInputFiles(path);
  await page.locator("[data-open-copy]").click();
  await expect(page.locator("#status")).toContainText("AIS Foundry feasibility");
  await page.goto(base + "?e2e=1");
  await waitForSurface(page, "app");
  await expect(page.locator('iframe[title^="AIS module:"]')).toHaveCount(0);
}

async function approve(page: Page, id: string) {
  const review = page.locator(`[data-ais-module-review="${id}"]`);
  for (const checkbox of await review.locator('fieldset input[type="checkbox"]').all()) await checkbox.check();
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator(".ais-source-preview pre")).toBeVisible();
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator("[data-ais-approved]")).toBeVisible();
}

async function enableRuntime(page: Page) {
  await page.locator("#gm-settings").click();
  await expect(page.locator('[data-pkg-id="foundry-tagger"] [data-ais-disable]')).toBeVisible();
  await approve(page, "ais-foundry-v13");
  await approve(page, "foundry-tagger");
  // Approval is separate for BOTH packages, and no code runs until reload.
  await expect(page.locator('iframe[title^="AIS module:"]')).toHaveCount(0);
  await Promise.all([page.waitForEvent("load"), page.locator("[data-ais-reload]").click()]);
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  await expect(page.locator('[data-ais-module-review="ais-foundry-v13"] [data-ais-runtime]'))
    .toHaveAttribute("data-ais-runtime", "available");
  await expect(page.locator('[data-ais-module-review="foundry-tagger"] [data-ais-runtime]'))
    .toHaveAttribute("data-ais-runtime", "ready", { timeout: 10_000 });
  await expect(page.locator('iframe[title="AIS module:foundry-tagger"]')).toHaveCount(1);
  await expect(page.locator('iframe[title="AIS module:ais-foundry-v13"]')).toHaveCount(0);
}

async function invoke(page: Page, command: string, input: unknown = {}) {
  const settingsClose = page.locator('[data-window="settings"] [data-window-close]');
  if (await settingsClose.count()) await settingsClose.click();
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-script-tab]").click();
  const panel = page.locator("[data-script-wizard]");
  await panel.locator("[data-script-name]").fill("Original Tagger acceptance");
  await panel.locator("[data-script-source]").fill(`return await api.ais.invoke("foundry-tagger", ${JSON.stringify(command)}, ${JSON.stringify(input)});`);
  await panel.locator(".grants label").filter({ hasText: "ais.invoke" }).locator("input").check();
  await panel.getByLabel("I reviewed this exact revision and its host grants").check();
  await panel.locator("[data-script-save]").click();
  await expect(panel.getByRole("status")).toContainText("Script revision published");
  await panel.locator("[data-script-run]").click();
  return panel;
}
async function result(page: Page, command: string, input: unknown = {}) {
  const panel = await invoke(page, command, input);
  await expect(panel.getByRole("status")).toContainText("Script completed", { timeout: 12_000 });
  return JSON.parse(await panel.locator("details pre").innerText());
}
const tags = (page: Page) => page.evaluate(() => {
  const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
  return client.store.get("scenes", "scene-1")?.tokens.map((token) => ({ id: token._id, tags: token.taggerTags }));
});

for (const origin of ["file://", "https://"] as const) {
  test(`${origin} world-packaged adapter runs original Tagger through AIS and renders native FX`, async ({ page, browser }) => {
    test.setTimeout(150_000);
    const base = origin === "file://" ? entry : served;
    await openWorld(page, base);
    await enableRuntime(page);
    const info = await result(page, "info");
    expect(info).toMatchObject({ realTagger: true, upstreamId: "tagger", upstreamVersion: "1.5.4",
      sourceCommit: "e7936bc9ee01e4445624fbc82a11e887e5cd0075" });
    expect(info.hookNames).toContain("preUpdateToken");
    expect((await result(page, "find", { tags: "bea*", caseInsensitive: true })).map((row: { id: string }) => row.id))
      .toEqual(["beacon-one", "beacon-two"]);
    const invalid = await invoke(page, "find", { tags: 123 });
    await expect(invalid.getByRole("status")).toContainText("Tagger | getByTag | inTags must be");
    expect(await result(page, "add-tags", { tokenId: "beacon-one", tags: ["  adapted  ", "adapted"] }))
      .toMatchObject({ id: "beacon-one", tags: ["Beacon", "lamp-1", "adapted"] });
    expect(await tags(page)).toEqual(expect.arrayContaining([
      { id: "beacon-one", tags: ["Beacon", "lamp-1", "adapted"] },
      { id: "hidden-beacon", tags: ["Beacon", "secret"] },
    ]));
    expect(await result(page, "veto-test", { tokenId: "beacon-one" })).toMatchObject({ vetoed: true });
    expect(JSON.stringify(await tags(page))).not.toContain("must-not-commit");
    const hidden = await invoke(page, "set-tags", { tokenId: "hidden-beacon", tags: ["leaked"] });
    await expect(hidden.getByRole("status")).toContainText("outside this visible scene projection");

    // Instrument the actual Pixi layer without replacing its renderer; a wire echo isn't proof.
    await page.evaluate(() => {
      const root = globalThis as unknown as { __aisFxDrawn?: string[]; __stage?: { getFxLayer(): { count: number; spawn: (...args: unknown[]) => void } } };
      const layer = root.__stage?.getFxLayer();
      if (!layer) throw new Error("Native FX layer is missing");
      root.__aisFxDrawn = [];
      const spawn = layer.spawn.bind(layer);
      layer.spawn = (...args: unknown[]) => {
        spawn(...args);
        if (layer.count > 0) root.__aisFxDrawn?.push(String((args[1] as { id: string }).id));
      };
    });
    const macroCount = () => page.evaluate(() => (globalThis as unknown as {
      __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } }
    }).__vttE2E.app.gm.client.store.getAll("macros").filter((macro) => macro.kind === "sequence").length);
    const before = await macroCount();
    expect(await result(page, "fx-demo", { tokenId: "beacon-one" })).toMatchObject({ nativeFx: true });
    expect(await page.evaluate(() => (globalThis as unknown as { __aisFxDrawn: string[] }).__aisFxDrawn))
      .toEqual(["part-1", "part-2"]);
    expect(await macroCount()).toBe(before); // no hidden saved FX macro as a shortcut

    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#export-world").click()]);
    const path = await download.path();
    if (!path) throw new Error("World export unavailable");
    const files = unzipSync(readFileSync(path));
    const manifest = files["world.json"];
    if (!manifest) throw new Error("Missing world manifest");
    const meta = JSON.parse(strFromU8(manifest));
    expect(meta.format).toBe(5);
    expect(meta.requiredFeatures).toContain("arena.ais.runtime/1");
    expect(JSON.stringify(meta)).not.toContain("automationGrants");
    expect(files["packages/ais-foundry-v13/runtime/adapter.js"]).toBeDefined();
    expect(files["packages/foundry-tagger/prepared/tagger.js"]).toBeDefined();

    const copyContext = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const copy = await copyContext.newPage();
      await openWorld(copy, base, path);
      await copy.locator("#gm-settings").click();
      await expect(copy.locator("[data-ais-approved]")).toHaveCount(0);
      await enableRuntime(copy);
      expect((await result(copy, "find", { tags: "adapted" })).map((row: { id: string }) => row.id)).toEqual(["beacon-one"]);
    } finally { await copyContext.close(); }

    await page.locator("#gm-settings").click();
    await page.locator('[data-ais-module-review="ais-foundry-v13"] [data-ais-revoke]').click();
    await expect(page.locator('iframe[title="AIS module:foundry-tagger"]')).toHaveCount(0);
    await expect(page.locator('[data-ais-module-review="foundry-tagger"] [data-ais-runtime]'))
      .toHaveAttribute("data-ais-runtime", "stopped");
  });
}

test("guest approval alone cannot execute; adapter-only read grants cannot authorize guest writes", async ({ page }) => {
  test.setTimeout(100_000);
  await openWorld(page, served);
  await page.locator("#gm-settings").click();
  await approve(page, "foundry-tagger");
  await Promise.all([page.waitForEvent("load"), page.locator("[data-ais-reload]").click()]);
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  const guest = page.locator('[data-ais-module-review="foundry-tagger"]');
  await expect(guest.locator("[data-ais-runtime]")).toHaveAttribute("data-ais-runtime", "blocked");
  await expect(page.locator('iframe[title^="AIS module:"]')).toHaveCount(0);
  const provider = page.locator('[data-ais-module-review="ais-foundry-v13"]');
  for (const checkbox of await provider.locator('fieldset input[type="checkbox"]').all()) await checkbox.uncheck();
  await provider.locator("fieldset label").filter({ hasText: "runtime.execute" }).locator("input").check();
  await provider.locator("fieldset label").filter({ hasText: "scene.tags.read" }).locator("input").check();
  await provider.locator("[data-ais-approve]").click();
  await expect(provider.locator(".ais-source-preview pre")).toBeVisible();
  await provider.locator("[data-ais-approve]").click();
  await expect(provider.locator("[data-ais-approved]")).toBeVisible();
  await Promise.all([page.waitForEvent("load"), page.locator("[data-ais-reload]").click()]);
  await waitForSurface(page, "app");
  expect((await result(page, "find", { tags: "Beacon" })).length).toBe(2);
  const denied = await invoke(page, "set-tags", { tokenId: "beacon-one", tags: ["not-approved"] });
  await expect(denied.getByRole("status")).toContainText("Capability not granted: scene.tags.write");
  expect(JSON.stringify(await tags(page))).not.toContain("not-approved");
  await page.locator("#gm-settings").click();
  await page.locator('[data-pkg-id="ais-foundry-v13"] [data-ais-disable]').click();
  await expect(page.locator('iframe[title="AIS module:foundry-tagger"]')).toHaveCount(0);
  await expect(guest.locator("[data-ais-runtime]")).toHaveAttribute("data-ais-runtime", "stopped");
});
