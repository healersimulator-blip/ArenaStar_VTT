import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https, { type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { entry, waitForSurface, hostCall } from "./lib";

/** Real package code, the production iframe SDK and the reviewed script Worker, not RPC mocks. */
const probeSource = `
let snapshots = 0;
let commits = 0;
let rawOps = false;
let forgedCommands = 0;
AIS.events.on("world.snapshot", function () { snapshots++; });
AIS.events.on("world.ops.committed", function (event) { commits++; rawOps = rawOps || "ops" in event; });
AIS.commands.on("mark", function () { forgedCommands++; return null; });
AIS.commands.on("roundtrip", async function (input, context) {
  const previous = await context.ais.storage.get("count") || 0;
  await context.ais.storage.set("count", previous + 1);
  const scene = await context.ais.scene.readVisible();
  let denied;
  try { await context.ais.chat.post("UNAUTHORIZED AIS CHAT"); }
  catch (error) { denied = error.message; }
  return { echo: input.text, count: previous + 1, scene: scene.id,
    snapshots, commits, rawOps, forgedCommands, denied };
});
`;

interface ModuleOptions { commands?: string[]; emits?: string[]; expectedState?: "ready" | "failed" }
function moduleZip(id: string, source: string, capabilities: string[], options: ModuleOptions = {}): Buffer {
  return Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify({
      id, name: id, version: "1.0.0", type: "module",
      interconnect: {
        api: "arena.ais/1", entry: "automation/entry.js", capabilities,
        commands: (options.commands ?? ["roundtrip"]).map((command) => ({ id: command, contract: 1 })),
        ...(options.emits ? { emits: options.emits } : {}),
      },
    })),
    "automation/entry.js": strToU8(source),
  }));
}

async function approveExisting(page: Page, id: string, expectedState = "ready"): Promise<void> {
  const row = page.locator(`[data-pkg-row][data-pkg-id="${id}"]`);
  if (await row.locator("[data-ais-enable]").count()) await row.locator("[data-ais-enable]").click();
  const review = page.locator(`[data-ais-module-review="${id}"]`);
  for (const checkbox of await review.locator('fieldset input[type="checkbox"]').all()) await checkbox.check();
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator(".ais-source-preview pre")).toContainText("AIS.commands.on");
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator("[data-ais-approved]")).toBeVisible();
  await expect(page.locator(`iframe[title="AIS module:${id}"]`)).toHaveCount(0);
  await Promise.all([page.waitForEvent("load"), page.locator("[data-ais-reload]").click()]);
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  await expect(review.locator("[data-ais-runtime]")).toHaveAttribute("data-ais-runtime", expectedState, { timeout: 10_000 });
  await expect(page.locator(`iframe[title="AIS module:${id}"]`)).toHaveCount(expectedState === "ready" ? 1 : 0);
}

async function importAndApprove(page: Page, id: string, source: string, capabilities: string[], options: ModuleOptions = {}): Promise<void> {
  await page.locator("#gm-settings").click();
  await page.locator("#pkg-file").setInputFiles({
    name: `${id}.zip`, mimeType: "application/zip", buffer: moduleZip(id, source, capabilities, options),
  });
  await expect(page.locator(`[data-pkg-row][data-pkg-id="${id}"]`)).toBeVisible();
  // Import is data only. Enabling a profile is still not executable-code approval.
  await expect(page.locator(`iframe[title="AIS module:${id}"]`)).toHaveCount(0);
  await approveExisting(page, id, options.expectedState);
}

async function runReviewedScript(page: Page, source: string): Promise<ReturnType<Page["locator"]>> {
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-script-tab]").click();
  const scripts = page.locator("[data-script-wizard]");
  await scripts.locator("[data-script-name]").fill("AIS browser acceptance");
  await scripts.locator("[data-script-source]").fill(source);
  await scripts.locator(".grants label").filter({ hasText: "ais.invoke" }).locator("input").check();
  await scripts.getByLabel("I reviewed this exact revision and its host grants").check();
  await scripts.locator("[data-script-save]").click();
  await expect(scripts.getByRole("status")).toContainText("Script revision published");
  await scripts.locator("[data-script-run]").click();
  return scripts;
}

let server: Server;
let tlsDir: string;
let servedEntry: string;

test.beforeAll(async () => {
  tlsDir = mkdtempSync(join(tmpdir(), "ais-tls-"));
  const key = join(tlsDir, "key.pem");
  const cert = join(tlsDir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
  const html = readFileSync(fileURLToPath(new URL("../dist/index.html", import.meta.url)));
  server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    if (req.url?.startsWith("/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servedEntry = `https://localhost:${(server.address() as AddressInfo).port}/index.html`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
});

test.use({ ignoreHTTPSErrors: true });

for (const origin of ["file://", "https://"] as const) {
  test(`${origin} approved module RPCs and reviewed macro commands round-trip`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto((origin === "file://" ? entry : servedEntry) + "?e2e=1");
    await waitForSurface(page, "app");
    await importAndApprove(page, "ais-probe", probeSource,
      ["scene.read.visible", "module.storage.read", "module.storage.write", "action.observe"], { commands: ["roundtrip", "mark"] });
    // Even an actual parent Window message cannot forge a port command. The bridge
    // must not reintroduce wildcard Window RPCs to make file:// work.
    await page.evaluate(() => {
      const iframe = document.querySelector('iframe[title="AIS module:ais-probe"]') as HTMLIFrameElement;
      iframe.contentWindow?.postMessage({ vttAisRpc: 1, kind: "command", id: "cmd-999", commandId: "mark", input: {}, context: {} }, "*");
    });
    const scripts = await runReviewedScript(page,
      `return await api.ais.invoke("ais-probe", "roundtrip", { text: "AIS is connected" });`);
    await expect(scripts.getByRole("status")).toContainText("Script completed", { timeout: 12_000 });
    await expect(scripts.locator("details pre")).toContainText('"echo": "AIS is connected"');
    await expect(scripts.locator("details pre")).toContainText('"count": 1');
    await expect(scripts.locator("details pre")).toContainText('"snapshots": 1');
    const observed = JSON.parse(await scripts.locator("details pre").innerText()) as { commits: number };
    expect(observed.commits).toBeGreaterThan(0);
    await expect(scripts.locator("details pre")).toContainText('"rawOps": false');
    await expect(scripts.locator("details pre")).toContainText('"forgedCommands": 0');
    await expect(scripts.locator("details pre")).toContainText("Capability not granted: chat.post");
    await expect(page.locator("#chat-log")).not.toContainText("UNAUTHORIZED AIS CHAT");
    await scripts.locator("[data-script-run]").click();
    await expect(scripts.getByRole("status")).toContainText("Script completed");
    await expect(scripts.locator("details pre")).toContainText('"count": 2');
    await page.reload();
    await waitForSurface(page, "app");
    const restored = await runReviewedScript(page, `return await api.ais.invoke("ais-probe", "roundtrip", { text: "reloaded" });`);
    await expect(restored.getByRole("status")).toContainText("Script completed");
    await expect(restored.locator("details pre")).toContainText('"count": 3');
    await page.locator("#gm-settings").click();
    const review = page.locator('[data-ais-module-review="ais-probe"]');
    await review.locator("[data-ais-revoke]").click();
    await expect(review.locator("[data-ais-runtime]")).toHaveAttribute("data-ais-runtime", "stopped");
    await expect(page.locator('iframe[title="AIS module:ais-probe"]')).toHaveCount(0);
    await page.locator('[data-window="settings"] [data-window-close]').click();
    await page.locator("#gm-macros").click();
    await restored.locator("[data-script-run]").click();
    await expect(restored.getByRole("status")).toContainText("not running");
  });
}

test("custom events reach a separately approved observer with authenticated package identity", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importAndApprove(page, "ais-observer", `
    const seen = [];
    AIS.events.on("module.event", function (event) { seen.push(event); });
    AIS.commands.on("roundtrip", function () { return seen; });`, ["action.observe"]);
  await importAndApprove(page, "ais-publisher", `
    AIS.commands.on("roundtrip", async function (input, context) {
      await context.ais.events.emit("probe.changed", { value: input.text });
      return "published";
    });`, ["event.emit"], { emits: ["probe.changed"] });
  const publisher = await runReviewedScript(page,
    `return await api.ais.invoke("ais-publisher", "roundtrip", { text: "typed event" });`);
  await expect(publisher.getByRole("status")).toContainText("Script completed");
  const observer = await runReviewedScript(page, `return await api.ais.invoke("ais-observer", "roundtrip", {});`);
  await expect(observer.getByRole("status")).toContainText("Script completed");
  await expect(observer.locator("details pre")).toContainText('"packageId": "ais-publisher"');
  await expect(observer.locator("details pre")).toContainText('"eventId": "probe.changed"');
  await expect(observer.locator("details pre")).toContainText('"value": "typed event"');
});

test("entry failure is visible, and replacement requires reviewing the NEW source/hash", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importAndApprove(page, "ais-broken", `AIS.commands.on("roundtrip", function () { return null; });
    throw new Error("Deliberately broken entry");`, [], { expectedState: "failed" });
  const review = page.locator('[data-ais-module-review="ais-broken"]');
  await expect(review.locator("[data-ais-runtime]")).toContainText("Deliberately broken entry");
  // Cache the old preview, then replace the bytes under the same ID/version.
  await review.locator("[data-ais-preview]").click();
  await expect(review.locator(".ais-source-preview pre")).toContainText("Deliberately broken entry");
  const replacement = `AIS.commands.on("roundtrip", function () { return "replacement reviewed"; });`;
  await page.locator("#pkg-file").setInputFiles({
    name: "fixed.zip", mimeType: "application/zip", buffer: moduleZip("ais-broken", replacement, []),
  });
  await expect(review.locator("[data-ais-approved]")).toHaveCount(0);
  await expect(review.locator(".ais-source-preview")).toHaveCount(0);
  await approveExisting(page, "ais-broken");
  const scripts = await runReviewedScript(page, `return await api.ais.invoke("ais-broken", "roundtrip", {});`);
  await expect(scripts.getByRole("status")).toContainText("Script completed");
  await expect(scripts.locator("details pre")).toContainText("replacement reviewed");
});

test("iframe navigation terminates the instance and rejects an in-flight command", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(servedEntry + "?e2e=1");
  await waitForSurface(page, "app");
  await importAndApprove(page, "ais-navigation", `AIS.commands.on("roundtrip", function () {
    setTimeout(function () { location.href = "about:blank"; }, 0);
    return new Promise(function () {});
  });`, []);
  const scripts = await runReviewedScript(page, `return await api.ais.invoke("ais-navigation", "roundtrip", {});`);
  await expect(scripts.getByRole("status")).toContainText("navigated");
  await expect(page.locator('iframe[title="AIS module:ais-navigation"]')).toHaveCount(0);
  await page.locator("#gm-settings").click();
  await expect(page.locator('[data-ais-module-review="ais-navigation"] [data-ais-runtime]'))
    .toHaveAttribute("data-ais-runtime", "failed");
});

test("a stalled command times out without poisoning the next invocation", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importAndApprove(page, "ais-timeout", `AIS.commands.on("roundtrip", function (input) {
    if (input.hang) return new Promise(function () {});
    return "still responsive";
  });`, []);
  const stalled = await runReviewedScript(page, `return await api.ais.invoke("ais-timeout", "roundtrip", { hang: true });`);
  await expect(stalled.getByRole("status")).toContainText("timed out", { timeout: 12_000 });
  const recovered = await runReviewedScript(page, `return await api.ais.invoke("ais-timeout", "roundtrip", {});`);
  await expect(recovered.getByRole("status")).toContainText("Script completed");
  await expect(recovered.locator("details pre")).toContainText("still responsive");
});

test("capability edits and disablement stop the old instance without a reload", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  const source = `AIS.commands.on("roundtrip", function () { return "alive"; });`;
  await importAndApprove(page, "ais-grants", source, ["ui.notify"]);
  const review = page.locator('[data-ais-module-review="ais-grants"]');
  await review.locator('fieldset input[type="checkbox"]').uncheck();
  await review.locator("[data-ais-update-grant]").click();
  await expect(review.locator("[data-ais-runtime]")).toHaveAttribute("data-ais-runtime", "stopped");
  await expect(page.locator('iframe[title="AIS module:ais-grants"]')).toHaveCount(0);
  await Promise.all([page.waitForEvent("load"), page.locator("[data-ais-reload]").click()]);
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  await expect(review.locator("[data-ais-runtime]")).toHaveAttribute("data-ais-runtime", "ready");
  await page.locator('[data-pkg-id="ais-grants"] [data-ais-disable]').click();
  await expect(review.locator("[data-ais-runtime]")).toHaveAttribute("data-ais-runtime", "stopped");
  await expect(review.locator("[data-ais-approved]")).toHaveCount(0);
  await expect(page.locator('iframe[title="AIS module:ais-grants"]')).toHaveCount(0);
});

for (const origin of ["file://", "https://"] as const) {
  test(`${origin} PF1e Torch native controls, selection, inventory and macro command use real host commits`, async ({ page }) => {
    test.setTimeout(90_000);
    const base = origin === "file://" ? entry : servedEntry;
    await page.goto(base);
    await page.locator("#role-import").setInputFiles(fileURLToPath(new URL("../dist/worlds/pf1e-mass-battles-starter-1.0.0.zip", import.meta.url)));
    await page.locator("[data-open-copy]").click();
    await expect(page.locator("#status")).toContainText("Pathfinder 1e Mass Battles");
    await page.goto(base + "?e2e=1");
    await waitForSurface(page, "app");
    await page.locator("#gm-settings").click();
    await approveExisting(page, "pf1e-torch");
    const target = await page.evaluate(async () => {
      const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
      const scene = client.store.getAll("scenes").find((row) => row.active);
      const token = scene?.tokens.find((row) => row.actorId);
      const actor = token?.actorId ? client.store.get("actors", token.actorId) : undefined;
      if (!scene || !token || !actor) throw new Error("starter world needs a token linked to an actor");
      await client.submitAndWait([
        { kind: "create", coll: "items", parent: { coll: "actors", id: actor._id }, data: {
          _id: "ais-test-torch", name: "Torch", type: "loot", ownership: { default: 0 }, flags: {}, system: { quantity: 2 },
        } },
        { kind: "update", ref: { coll: "tokens", id: token._id, parent: { coll: "scenes", id: scene._id } }, diff: {
          light: { radius: 0, bright: 0, color: "#ffffff", alpha: 0.8, angle: 360 }, "flags.ais": {},
        } },
      ]);
      return { sceneId: scene._id, tokenId: token._id, actorId: actor._id, pixelsPerFoot: scene.grid.size / scene.grid.distance };
    });
    const readLight = () => page.evaluate(({ sceneId, tokenId, actorId }) => {
      const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
      const token = client.store.get("scenes", sceneId)?.tokens.find((row) => row._id === tokenId);
      const item = client.store.get("actors", actorId)?.items.find((row) => row._id === "ais-test-torch");
      if (!token || !item) throw new Error("fixture token or inventory is missing");
      return { radius: token.light.radius, animation: token.light.animation?.type, quantity: item.system.quantity };
    }, target);
    const menu = async (action: string) => {
      for (const close of await page.locator("[data-window-close]").all()) await close.click();
      const token = await page.evaluate(({ sceneId, tokenId }) => {
        const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
        const token = client.store.get("scenes", sceneId)?.tokens.find((row) => row._id === tokenId);
        if (!token) throw new Error("fixture token is missing");
        return token;
      }, target);
      const box = await page.locator(".canvas-host canvas").boundingBox();
      const camera = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");
      if (!box) throw new Error("canvas unavailable");
      await page.mouse.click(box.x + (token.x - camera.x) * camera.scale, box.y + (token.y - camera.y) * camera.scale, { button: "right" });
      await page.locator(`[data-token-menu="${target.tokenId}"] [data-token-menu-action="token-light-${action}"]`).click();
    };
    await menu("toggle");
    await expect.poll(readLight).toEqual({ radius: 40 * target.pixelsPerFoot, animation: "torch", quantity: 1 });
    await menu("off");
    await expect.poll(async () => (await readLight()).radius).toBe(0);
    await menu("settings");
    await page.locator('[data-ais-choice="consume:off"]').click();
    await expect(page.locator("[data-ais-choice]")).toHaveCount(0);
    const script = await runReviewedScript(page, `return await api.ais.invoke("pf1e-torch", "toggle", { tokenId: ${JSON.stringify(target.tokenId)} });`);
    await expect(script.getByRole("status")).toContainText("Script completed");
    await expect(script.locator("details pre")).toContainText('"active": true');
    // The acknowledged result agrees with the actual committed token and inventory.
    await expect.poll(readLight).toEqual({ radius: 40 * target.pixelsPerFoot, animation: "torch", quantity: 1 });
    await page.reload();
    await waitForSurface(page, "app");
    await expect.poll(readLight).toEqual({ radius: 40 * target.pixelsPerFoot, animation: "torch", quantity: 1 });
    await menu("off");
    await expect.poll(async () => (await readLight()).radius).toBe(0);
    await menu("toggle");
    await expect.poll(readLight).toEqual({ radius: 40 * target.pixelsPerFoot, animation: "torch", quantity: 1 });
  });
}

test("missing startup readiness fails visibly within the boot budget", async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importAndApprove(page, "ais-not-ready", `AIS.commands.on("roundtrip", function () { return null; });
    globalThis.AIS = { __ready: function () {} };`, [], { expectedState: "failed" });
  await expect(page.locator('[data-ais-module-review="ais-not-ready"] [data-ais-runtime]'))
    .toContainText("did not become ready");
});

test("simultaneous macro commands reserve one slot before asynchronous consent checks", async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importAndApprove(page, "ais-concurrency", `
    let calls = 0;
    AIS.commands.on("roundtrip", async function () {
      await new Promise(function (resolve) { setTimeout(resolve, 100); });
      return ++calls;
    });`, []);
  const scripts = await runReviewedScript(page, `
    const results = await Promise.allSettled([
      api.ais.invoke("ais-concurrency", "roundtrip", {}),
      api.ais.invoke("ais-concurrency", "roundtrip", {})
    ]);
    return results.map(result => result.status === "fulfilled"
      ? { status: result.status, value: result.value }
      : { status: result.status, error: result.reason.message });`);
  await expect(scripts.getByRole("status")).toContainText("Script completed");
  const results = JSON.parse(await scripts.locator("details pre").innerText()) as Array<{ status: string; value?: number; error?: string }>;
  expect(results.filter((result) => result.status === "fulfilled")).toEqual([{ status: "fulfilled", value: 1 }]);
  expect(results.find((result) => result.status === "rejected")?.error).toContain("already has a command running");
});

test("navigation before the first iframe load cannot leave a falsely ready runtime", async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto(servedEntry + "?e2e=1");
  await waitForSurface(page, "app");
  await importAndApprove(page, "ais-early-navigation", `AIS.commands.on("roundtrip", function () { return "unreachable"; });
    location.href = "about:blank";`, [], { expectedState: "failed" });
});
