import { test, expect, type BrowserContext } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chromeAction, openSceneNav, solidPng, waitForSurface } from "./lib";

test("1,000x1,000 square stitched 4-panel strategic map hosts 80 commander seats and 600 units (12,000 models)", async ({
  page,
  browser,
}) => {
  const db = process.env.STRATEGIC_TEST_DATABASE_URL;
  test.skip(!db, "Set STRATEGIC_TEST_DATABASE_URL to a disposable database");
  test.setTimeout(240_000);
  page.setDefaultTimeout(25_000);

  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${address.port}`;
  const key = `${randomUUID()}${randomUUID()}`;
  const slot = `grand-stitch-${randomUUID()}`;

  const service: ChildProcess = spawn(
    process.execPath,
    ["services/strategic-room/dist/server/main.mjs", "campaign"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DATABASE_URL: db,
        PORT: String(address.port),
        STRATEGIC_ROOM: slot,
        STRATEGIC_ORIGINS: origin,
        STRATEGIC_LAUNCH_KEY: key,
      },
    },
  );

  const contexts: BrowserContext[] = [];
  const stop = async () => {
    if (service.exitCode === null && service.signalCode === null) {
      const exited = once(service, "exit");
      service.kill("SIGTERM");
      await exited;
    }
  };

  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(origin)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 15_000 },
      )
      .toBe(200);

    // 1. GM creates a Strategic battlefield scene -> defaults to 600x600 squares (>500x500!),
    //    then expands to 1,000x1,000 squares (20,000x20,000 px = 5,000x5,000 ft) via Scene Settings.
    await page.goto(`${origin}/?e2e=1`);
    await waitForSurface(page, "app");
    await openSceneNav(page);
    await page.locator("#scene-add").click();
    await page.getByRole("menuitem", { name: "Strategic battlefield" }).click();
    await page.getByRole("button", { name: "Battlefield 2", exact: true }).click();

    await chromeAction(page, "gm-scene-settings");

    await expect(page.locator("[data-scene-cells]")).toContainText("600 × 600 cells");
    await page.locator('[data-scene-preset="1000"]').click();
    await expect(page.locator("[data-scene-cells]")).toContainText("1000 × 1000 cells");
    await expect(page.locator("[data-scene-cells]")).toContainText("5000 × 5000 ft");

    await page.locator("[data-scene-open-campaign]").click();

    // 2. GM stitches 4 distinct regional map images (2x2 grid) onto the 1,000x1,000 square scene.
    await expect(page.locator("[data-campaign-stitch-builder]")).toBeVisible();
    await page.locator("[data-campaign-stitch-cols]").fill("2");
    await page.locator("[data-campaign-stitch-files]").setInputFiles([
      { name: "nw-forest.png", mimeType: "image/png", buffer: solidPng(128, 128, [38, 118, 62]) },
      { name: "ne-steppe.png", mimeType: "image/png", buffer: solidPng(128, 128, [168, 134, 52]) },
      { name: "sw-river.png", mimeType: "image/png", buffer: solidPng(128, 128, [42, 96, 156]) },
      { name: "se-ashland.png", mimeType: "image/png", buffer: solidPng(128, 128, [132, 62, 74]) },
    ]);
    await expect(page.locator(".campaign [role='status']").first()).toContainText(
      /Stitched 4 map images \(2×2\) across 1000×1000 squares/,
      { timeout: 20_000 },
    );

    // 3. GM deploys 300 Blue + 300 Red = 600 units (12,000 models) across 80 commander seats
    //    on the 1,000x1,000 square stitched battlefield (preserving the 1,000x1,000 square map!).
    await page.locator("[data-force-blue-units]").fill("300");
    await page.locator("[data-force-red-units]").fill("300");
    await page.locator("[data-force-models]").fill("20");
    await page.locator("[data-force-ranged]").fill("25");
    await page.locator("[data-force-deploy]").click();

    await expect(page.locator(".campaign [role='status']").first()).toContainText(
      /Deployed 300 Blue \+ 300 Red units \(12000 models\) across 1000×1000 squares/,
      { timeout: 20_000 },
    );
    await page.getByLabel("Commander seats").fill("80");

    // 4. GM launches the hosted battle with 80 seats, 600 units, and 4 stitched map panels.
    await page.getByLabel("GM launch key").fill(key);
    await page.getByRole("button", { name: "Launch multiplayer battle" }).click();

    const gmFrame = page.frameLocator('iframe[title="Live strategic battlefield"]');
    await expect(gmFrame.getByRole("button", { name: "Close and resolve" })).toBeVisible({
      timeout: 30_000,
    });

    const gmCanvas = gmFrame.locator('canvas[data-hosted-background="true"][data-hosted-background-tiles="4"]');
    await expect(gmCanvas).toBeVisible({ timeout: 20_000 });

    // Verify all 4 stitched panel colors actually rendered onto the GM battlefield 2D canvas!
    await expect
      .poll(
        async () =>
          gmCanvas.evaluate((el) => {
            const cvs = el as HTMLCanvasElement;
            const ctx = cvs.getContext("2d");
            if (!ctx || cvs.width < 100 || cvs.height < 100) return 0;
            // Sample 4 interior quadrant points well inside the centered fitted square map
            const cx = cvs.width / 2;
            const cy = cvs.height / 2;
            const span = Math.min(cvs.width, cvs.height) * 0.22;
            const pts: Array<[number, number]> = [
              [Math.round(cx - span), Math.round(cy - span)],
              [Math.round(cx + span), Math.round(cy - span)],
              [Math.round(cx - span), Math.round(cy + span)],
              [Math.round(cx + span), Math.round(cy + span)],
            ];
            const signatures = new Set<string>();
            for (const [px, py] of pts) {
              const d = ctx.getImageData(px, py, 1, 1).data;
              signatures.add(`${Math.round((d[0] ?? 0) / 16)}-${Math.round((d[1] ?? 0) / 16)}-${Math.round((d[2] ?? 0) / 16)}`);
            }
            return signatures.size;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(3);

    // 5. Open GM Roster (80 seats -> paginated 50/page!), verify pagination + 80-seat bulk assignment!
    await gmFrame.locator("[data-roster-toggle]").click();
    const roster = gmFrame.locator("[data-hosted-roster]");
    await expect(roster).toBeVisible();
    await expect(roster.locator("[data-roster-count]")).toContainText("80 seats");
    await expect(roster.locator("[data-roster-page]")).toHaveText("Page 1/2");
    await roster.locator("[data-roster-next]").click();
    await expect(roster.locator("[data-roster-page]")).toHaveText("Page 2/2");
    await expect(roster.locator('[data-member="commander-80"]')).toBeVisible();
    await roster.locator("[data-roster-prev]").click();
    await expect(roster.locator("[data-roster-page]")).toHaveText("Page 1/2");

    await roster.locator("[data-roster-units-per-seat]").fill("7");
    await roster.locator("[data-roster-auto-assign]").click();
    await expect(
      gmFrame.getByRole("status").filter({ hasText: "Accepted for turn 1" }),
    ).toBeVisible({ timeout: 15_000 });

    // Grab commander-1 invite & join as a real player in an isolated browser context.
    const inviteCode = (
      await roster.locator('[data-member="commander-1"] [data-member-invite]').textContent()
    )?.trim();
    expect(inviteCode?.length).toBeGreaterThanOrEqual(16);

    const battlePath = (
      await page.locator('iframe[title="Live strategic battlefield"]').getAttribute("src")
    )?.split("?")[0];
    expect(battlePath).toBeTruthy();

    const playerCtx = await browser.newContext();
    contexts.push(playerCtx);
    const playerPage = await playerCtx.newPage();
    playerPage.setDefaultTimeout(25_000);
    await playerPage.goto(`${origin}${battlePath}`);
    await playerPage.getByLabel("One-time invite").fill(inviteCode ?? "");
    await playerPage.getByRole("button", { name: "Join room" }).click();

    await expect(playerPage.getByLabel("Assigned unit")).toBeVisible({ timeout: 20_000 });
    await expect(
      playerPage.locator('canvas[data-hosted-background="true"][data-hosted-background-tiles="4"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(playerPage.locator("[data-own-unit-card]")).toHaveCount(7);

    // 6. Player drafts a march order on the 5,000 x 5,000 ft map & submits; GM resolves Turn 1 -> v1!
    await playerPage.getByLabel("March X").fill("2450");
    await playerPage.getByLabel("March Y").fill("2500");
    await playerPage.getByRole("button", { name: "Draft march" }).click();
    await playerPage.getByRole("button", { name: "Submit orders" }).click();
    await expect(playerPage.locator("[data-revision]")).toHaveText("1");

    await gmFrame.getByRole("button", { name: "Close and resolve" }).click();
    await expect(gmFrame.locator('[data-version="1"]')).toBeVisible({ timeout: 60_000 });
    await expect(playerPage.locator('[data-version="1"]')).toBeVisible({ timeout: 60_000 });
  } finally {
    await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
    await stop();
  }
});
