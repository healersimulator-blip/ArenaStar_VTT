import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { openSceneNav, applySidebarMap, solidPng, chromeAction, waitForSurface } from "./lib";

/**
 * Actual-use strategic acceptance: author a normal campaign scene, add its map and tokens,
 * mark it strategic, launch twelve isolated browser identities, exercise GM grants, submit
 * commander orders and resolve a turn. It verifies that authored map art and opposing campaign
 * tokens become the hosted battlefield rather than being replaced by a schematic deployment.
 */
test("GM authors a strategic scene and twelve commanders play a hosted skirmish", async ({ page, browser }, testInfo) => {
  const db = process.env.STRATEGIC_TEST_DATABASE_URL;
  test.skip(!db, "Set STRATEGIC_TEST_DATABASE_URL to a disposable database");
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);

  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${address.port}`;
  const key = randomUUID();
  const slot = `actual-${randomUUID()}`;
  const service: ChildProcess = spawn(process.execPath, ["services/strategic-room/dist/server/main.mjs", "campaign"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DATABASE_URL: db, PORT: String(address.port), STRATEGIC_ROOM: slot,
      STRATEGIC_ORIGINS: origin, STRATEGIC_LAUNCH_KEY: key, STRATEGIC_METRICS: "1" },
  });
  const serviceLog: string[] = [];
  service.stdout?.on("data", (chunk) => serviceLog.push(String(chunk)));
  service.stderr?.on("data", (chunk) => serviceLog.push(String(chunk)));
  const contexts: BrowserContext[] = [];
  const players: Page[] = [];
  const started = Date.now();
  const stop = async () => {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, "exit");
      service.kill("SIGTERM");
      await exited;
    }
  };
  try {
    await expect.poll(async () => {
      try { return (await fetch(origin)).status; } catch { return 0; }
    }, { timeout: 12_000 }).toBe(200);

    // GM campaign authoring through the shipped UI.
    await page.goto(`${origin}/?e2e=1`);
    await waitForSurface(page, "app");
    await openSceneNav(page);
    await page.locator("#scene-add").click();
    await page.getByRole("menuitem", { name: "Blank scene" }).click();
    await page.getByRole("button", { name: "Scene 2", exact: true }).click();
    await page.locator("#map-input").setInputFiles({
      name: "twelve-commanders-field.png", mimeType: "image/png",
      buffer: solidPng(320, 240, [58, 82, 48]),
    });
    await applySidebarMap(page);
    await openSceneNav(page);
    const sceneTwo = page.locator('[data-testid="scene-nav"] [data-scene]').filter({ hasText: /^Scene 2$/ });
    const authoredSceneId = await sceneTwo.getAttribute("data-scene");
    if (!authoredSceneId) throw new Error("Authored scene ID missing");
    await sceneTwo.click();
    await expect.poll(() => page.evaluate(() => {
      const app = (globalThis as { __vttE2E?: { app?: { activeSceneId(): string | null } } }).__vttE2E?.app;
      return app?.activeSceneId() ?? null;
    })).toBe(authoredSceneId);
    const placed = await page.evaluate((sceneId) => {
      const app = (globalThis as { __vttE2E?: { app?: { pf1ePlaceTokens(spec: unknown): { ok: boolean; placed: number } } } }).__vttE2E?.app;
      if (!app) throw new Error("GM E2E surface unavailable");
      return app.pf1ePlaceTokens(Array.from({ length: 48 }, (_, i) => {
        const sideIndex = i % 24;
        const hostile = i >= 24;
        return {
          id: `campaign-unit-${i + 1}`,
          sceneId,
          // Six ranks of four companies on a deliberately enlarged strategic scene.
          col: (hostile ? 60 : 20) + (sideIndex % 4) * 10,
          row: 10 + Math.floor(sideIndex / 4) * 12,
          disposition: hostile ? "hostile" : "friendly",
        };
      }));
    }, authoredSceneId);
    expect(placed).toMatchObject({ ok: true, placed: 48 });
    await expect.poll(() => page.evaluate((sceneId) => {
      const app = (globalThis as { __vttE2E?: { app?: { sceneChildren(id: string): { tokens: Array<{ disposition: string }> } | null } } }).__vttE2E?.app;
      return app?.sceneChildren(sceneId)?.tokens.map((token) => token.disposition) ?? [];
    }, authoredSceneId)).toEqual([...Array(24).fill("friendly"), ...Array(24).fill("hostile")]);
    await openSceneNav(page);
    await page.getByRole("button", { name: "Scene settings" }).click();
    const sceneSettings = page.locator('[data-window="scene-settings"]');
    await sceneSettings.locator("[data-scene-width]").fill("16000");
    await sceneSettings.locator("[data-scene-width]").press("Tab");
    await sceneSettings.locator("[data-scene-height]").fill("8000");
    await sceneSettings.locator("[data-scene-height]").press("Tab");
    await sceneSettings.locator("[data-window-close]").click();
    await chromeAction(page, "gm-settings");
    const settings = page.locator('[data-window="settings"]');
    await settings.locator("[data-scene-scale]").selectOption("strategic");
    await expect(settings.locator("[data-scene-scale]")).toHaveValue("strategic");
    await settings.locator("[data-window-close]").click();

    await openSceneNav(page);
    await sceneTwo.click();
    await expect.poll(() => page.evaluate(() => {
      const app = (globalThis as { __vttE2E?: { app?: { activeSceneId(): string | null } } }).__vttE2E?.app;
      return app?.activeSceneId() ?? null;
    })).toBe(authoredSceneId);
    await openSceneNav(page);
    await page.getByRole("button", { name: "Multiplayer battle…" }).click();
    await expect(page.getByText(/48 visible friendly\/hostile scene tokens/)).toBeVisible();
    await page.getByLabel("Commander seats").fill("12");
    await page.getByLabel("Models per token").fill("80");
    await page.getByLabel("GM launch key").fill(key);
    await page.getByRole("button", { name: "Launch multiplayer battle" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Battle ready." })).toBeVisible();
    await page.getByText(/Commander admission \(/).click();
    const codes = await page.locator(".campaign details code").allTextContents();
    expect(codes).toHaveLength(12);
    const frame = page.frameLocator('iframe[title="Live strategic battlefield"]');
    await expect(frame.getByRole("button", { name: "Close and resolve" })).toBeVisible();
    await frame.getByRole("button", { name: "Commanders (12)" }).click();
    await expect(frame.locator("[data-hosted-roster] [data-member]")).toHaveCount(12);

    // GM allegiance administration is durable and immediately rebuilds projection cohorts.
    const firstSeat = frame.locator('[data-member="commander-1"]');
    const grants = firstSeat.locator("[data-member-unit]");
    await expect(grants).toHaveCount(4);
    const allegiance = firstSeat.locator("[data-member-unit-faction]").first();
    await expect(allegiance).toHaveValue("friendly");
    await allegiance.selectOption("hostile");
    await expect(allegiance).toHaveValue("hostile");
    await allegiance.selectOption("friendly");
    await expect(allegiance).toHaveValue("friendly");

    const battlePath = (await page.locator('iframe[title="Live strategic battlefield"]').getAttribute("src"))?.split("?")[0];
    if (!battlePath) throw new Error("Battle path missing");
    for (let i = 0; i < codes.length; i++) {
      const context = await browser.newContext();
      contexts.push(context);
      const commander = await context.newPage();
      players.push(commander);
      await commander.goto(origin + battlePath);
      const code = codes[i];
      if (!code) throw new Error(`Missing invite ${i + 1}`);
      await commander.getByLabel("One-time invite").fill(code);
      await commander.getByRole("button", { name: "Join room" }).click();
      await expect(commander.getByLabel("Assigned unit")).toBeEnabled();
      await expect(commander.getByLabel("Assigned unit").locator("option")).toHaveCount(4);
      await expect(commander.locator('canvas[data-hosted-background="true"]')).toBeVisible();
    }
    // Membership-generation refreshes may replace the iframe view; reopen the roster if needed.
    if (await frame.locator("[data-hosted-roster]").count() === 0)
      await frame.getByRole("button", { name: "Commanders (12)" }).click();
    await expect(frame.locator("[data-hosted-roster] [data-member]")).toHaveCount(12);

    // Withdraw one live player's right, prove their authorized view shrinks, then restore it.
    const firstPlayer = players[0];
    if (!firstPlayer) throw new Error("First commander browser missing");
    const grant = firstSeat.locator("[data-member-unit]").first();
    await expect(grant).toBeChecked();
    await grant.uncheck();
    await expect(grant).not.toBeChecked();
    await expect(firstPlayer.getByLabel("Assigned unit").locator("option")).toHaveCount(3);
    await grant.check();
    await expect(grant).toBeChecked();
    await expect(firstPlayer.getByLabel("Assigned unit").locator("option")).toHaveCount(4);

    // Each player controls a four-company command. Exercise every company rather than treating
    // one browser as one token: attack where opposition is visible and hold the remaining ranks.
    let attacks = 0;
    let holds = 0;
    for (let i = 0; i < players.length; i++) {
      const commander = players[i];
      if (!commander) throw new Error(`Missing commander ${i + 1}`);
      const assigned = commander.getByLabel("Assigned unit");
      for (let unitIndex = 0; unitIndex < 4; unitIndex++) {
        await assigned.selectOption({ index: unitIndex });
        const enemies = commander.getByLabel("Visible enemy");
        await expect(enemies).toBeEnabled();
        if (unitIndex < 2 && await enemies.locator("option").count() > 1) {
          await enemies.selectOption({ index: 1 });
          await commander.getByRole("button", { name: /Draft (melee|ranged) attack/ }).click();
          attacks++;
        } else {
          await commander.getByRole("button", { name: "Draft hold" }).click();
          holds++;
        }
      }
      await commander.getByRole("button", { name: "Submit orders" }).click();
      await expect.poll(async () => Number(await commander.locator("[data-revision]").textContent())).toBeGreaterThan(0);
    }
    expect(attacks).toBeGreaterThan(0);
    expect(attacks + holds).toBe(48);
    const resolveStarted = Date.now();
    await frame.getByRole("button", { name: "Close and resolve" }).click();
    await expect(frame.locator('[data-version="1"]')).toBeVisible({ timeout: 30_000 });
    await Promise.all(players.map((commander) => expect(commander.locator('[data-version="1"]')).toBeVisible()));
    await frame.getByRole("button", { name: "View report" }).click();
    await expect(frame.locator("[data-report-unit]")).toHaveCount(40);
    const rows = await frame.locator("[data-report-unit]").allTextContents();
    await frame.getByRole("button", { name: "Next page" }).click();
    await expect(frame.locator("[data-report-unit]")).toHaveCount(8);
    rows.push(...await frame.locator("[data-report-unit]").allTextContents());
    expect(rows).toHaveLength(48);

    const result = {
      capability: attacks > 0 ? "PASS" : "PARTIAL",
      campaign: { mapUploaded: true, campaignTokensCreated: 48, scale: "strategic" },
      hosted: { commanders: 12, unitsPerCommander: 4, units: 48, modelsPerUnit: 80, models: 3840,
        explicitGrantRoundTrip: true, liveGrantProjectionVerified: true, allegianceRoundTrip: true,
        submittedBatches: 12, submittedUnitOrders: attacks + holds,
        attackOrders: attacks, holdOrders: holds, publishedVersion: 1, reportRows: rows.length },
      formationCapabilities: {
        ranksAndFiles: "exercised by 80-model companies",
        reforming: "unsupported by hosted order protocol",
        enveloping: "unsupported by hosted order protocol",
        hazardAvoidance: "service-tested for active Entangle and Black Tentacles zones; browser spell casting does not yet create persistent hosted zones",
      },
      timingsMs: { total: Date.now() - started, resolve: Date.now() - resolveStarted },
      boundary: "Authored scene art and visible friendly/hostile tokens drive the hosted board. Token conversion remains a fallback when no authored Army documents exist.",
      reportRows: rows,
    };
    await testInfo.attach("strategic-actual-use-result.json", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    console.log("STRATEGIC_ACTUAL_USE", JSON.stringify(result));
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await stop();
    await testInfo.attach("strategic-service.log", { body: serviceLog.join(""), contentType: "text/plain" });
  }
});
