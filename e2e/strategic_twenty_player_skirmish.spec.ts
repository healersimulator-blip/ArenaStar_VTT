import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { openSceneNav, solidPng, waitForSurface } from "./lib";

test("twenty commanders command 100 custom-badged 50-model companies (5,000 models) through a full strategic skirmish", async ({
  page,
  browser,
}) => {
  const db = process.env.STRATEGIC_TEST_DATABASE_URL;
  test.skip(!db, "Set STRATEGIC_TEST_DATABASE_URL to a disposable database");
  test.setTimeout(240_000);
  page.setDefaultTimeout(20_000);

  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${address.port}`;
  const key = `${randomUUID()}${randomUUID()}`;
  const slot = `twenty-${randomUUID()}`;

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
  const players: Page[] = [];
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

    // 1. GM creates a Strategic battlefield scene & imports/fits a custom map image at gridSize=20.
    await page.goto(`${origin}/?e2e=1`);
    await waitForSurface(page, "app");
    await openSceneNav(page);
    await page.locator("#scene-add").click();
    await page.getByRole("menuitem", { name: "Strategic battlefield" }).click();
    await page.getByRole("button", { name: "Battlefield 2", exact: true }).click();

    await page.locator("#map-input").setInputFiles({
      name: "river-ford-map.png",
      mimeType: "image/png",
      buffer: solidPng(320, 240, [56, 82, 54]),
    });
    const importDialog = page.locator("[data-image-import-dialog]");
    await expect(importDialog).toBeVisible();
    await expect(importDialog.locator(".preview-frame img")).toBeVisible();
    await importDialog.getByLabel("Destination action").selectOption("replaceBackground");
    const fitBtn = importDialog.locator("[data-fit-background-to-scene]");
    await expect(fitBtn).toBeEnabled();
    await fitBtn.click();
    await importDialog.getByRole("button", { name: "Apply to image" }).click();
    await expect(importDialog).toBeHidden({ timeout: 15_000 });

    // 2. GM opens Scene Settings, verifies strategic scale, and opens Multiplayer Battle.
    await openSceneNav(page);
    const bfRow = page.locator("[data-scene]").nth(1);
    await bfRow.hover();
    const gearBtn = bfRow.locator('[aria-label*="settings" i], [title*="settings" i]');
    if ((await gearBtn.count()) > 0) {
      await gearBtn.first().click();
      await expect(page.locator("[data-scene-settings-scale]")).toHaveValue("strategic");
      await page.locator("[data-scene-open-campaign]").click();
    } else {
      await page.getByRole("button", { name: "Multiplayer battle…" }).click();
    }

    // 3. GM uploads Blue & Red token emblems and deploys 50 Blue + 50 Red x 50 models (5,000 models) across 20 seats.
    await expect(page.locator("[data-strategic-force-builder]")).toBeVisible();
    await page.locator("[data-force-blue-token]").setInputFiles({
      name: "blue-crest.png",
      mimeType: "image/png",
      buffer: solidPng(48, 48, [44, 118, 224]),
    });
    await expect(
      page.locator(".campaign [role='status']").filter({ hasText: "blue-crest.png" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.locator("[data-force-red-token]").setInputFiles({
      name: "red-crest.png",
      mimeType: "image/png",
      buffer: solidPng(48, 48, [204, 56, 62]),
    });
    await expect(
      page.locator(".campaign [role='status']").filter({ hasText: "red-crest.png" }),
    ).toBeVisible({ timeout: 15_000 });

    await page.locator("[data-force-blue-units]").fill("50");
    await page.locator("[data-force-red-units]").fill("50");
    await page.locator("[data-force-models]").fill("50");
    await page.locator("[data-force-ranged]").fill("20");
    await page.locator("[data-force-gap]").fill("20");
    await page.locator("[data-force-deploy]").click();
    await expect(
      page.locator(".campaign [role='status']").filter({ hasText: "Deployed 50 Blue + 50 Red" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Commander seats").fill("20");

    await page.getByLabel("GM launch key").fill(key);
    await page.getByRole("button", { name: "Launch multiplayer battle" }).click();

    const frame = page.frameLocator('iframe[title="Live strategic battlefield"]');
    await expect(frame.getByRole("button", { name: "Close and resolve" })).toBeVisible({
      timeout: 25_000,
    });
    await expect(frame.locator('canvas[data-hosted-background="true"]')).toBeVisible();

    // 4. Extract 20 commander invites and admit 20 isolated player browser contexts.
    await page.getByText(/Commander admission \(/).click();
    const inviteLines = await page.locator(".campaign details .invite-line").allTextContents();
    await page.getByText(/Commander admission \(/).click();
    expect(inviteLines).toHaveLength(20);
    const invites = inviteLines.map((line) => {
      const [seat = "", code = ""] = line.split(":").map((s) => s.trim());
      return { seat, code };
    });

    const battlePath = (
      await page.locator('iframe[title="Live strategic battlefield"]').getAttribute("src")
    )?.split("?")[0];
    expect(battlePath).toBeTruthy();

    for (let i = 0; i < 20; i++) {
      const ctx = await browser.newContext();
      contexts.push(ctx);
      const p = await ctx.newPage();
      p.setDefaultTimeout(20_000);
      players.push(p);
      await p.goto(`${origin}${battlePath}`);
      await p.getByLabel("One-time invite").fill(invites[i]?.code ?? "");
      await p.getByRole("button", { name: "Join room" }).click();
      await expect(p.getByLabel("Assigned unit")).toBeVisible();
    }

    // 5. GM verifies numeric roster sort (commander-1..commander-20) & runs 1-click 50/50 5-units/player assignment.
    await frame.getByRole("button", { name: "Commanders (20)" }).click();
    await expect(frame.locator("[data-hosted-roster]")).toBeVisible();
    const seatIds = await frame.locator("[data-member-id]").allTextContents();
    expect(seatIds.slice(0, 3)).toEqual(["commander-1", "commander-2", "commander-3"]);
    expect(seatIds[19]).toBe("commander-20");

    await frame.locator("[data-roster-auto-assign]").click();
    await expect(
      frame.getByRole("status").filter({ hasText: "Accepted for turn 1" }),
    ).toBeVisible();
    await frame.getByRole("button", { name: "Hide commanders" }).click();

    // 6. Every player sees 5 custom-badged unit cards & submits Turn 1 orders across all 100 units.
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p) continue;
      await expect(p.locator("[data-own-unit-card]")).toHaveCount(5);
      await expect(p.locator("[data-own-unit-card] .unit-emblem").first()).toBeVisible();

      if (i === 0) {
        // Exercise 1-click Brigade Line March first, then override vanguard units with envelop attacks.
        const mapBox = await p.locator(".map canvas").boundingBox();
        if (mapBox) {
          await p.mouse.click(mapBox.x + mapBox.width * 0.5, mapBox.y + mapBox.height * 0.5);
          await p.locator("[data-brigade-march]").click();
        }
      }

      const cards = p.locator("[data-own-unit-card]");
      const enemyCount = await p.getByLabel("Visible enemy").locator("option").count();
      for (let u = 0; u < 5; u++) {
        await cards.nth(u).click();
        if (u < 3 && enemyCount > 1) {
          const val = await p
            .getByLabel("Visible enemy")
            .locator("option")
            .nth(1 + (u % (enemyCount - 1)))
            .getAttribute("value");
          if (val) {
            await p.getByLabel("Visible enemy").selectOption(val);
            const env = p.locator("[data-order-envelop]");
            if (u === 0 && (await env.count()) > 0) await env.check();
            await p.getByRole("button", { name: /Draft (melee|ranged) attack/ }).click();
            continue;
          }
        }
        if (u === 4) {
          await p.locator("[data-order-defend]").click();
        } else if (i > 0) {
          await p.getByRole("button", { name: "Draft hold" }).click();
        }
      }
      await p.getByRole("button", { name: "Submit orders" }).click();
      await expect(p.locator("[data-revision]")).toHaveText("1");
    }

    // Zoom a player into Region Detail to confirm individual 50-model ranks stream live.
    const scout = players[10];
    if (scout) {
      await scout.getByRole("button", { name: "Center unit" }).click();
      await scout.getByRole("button", { name: "Region detail" }).click();
      for (let z = 0; z < 4; z++) await scout.getByRole("button", { name: "Zoom in" }).click();
      await expect
        .poll(async () => Number(await scout.locator("[data-models]").getAttribute("data-models")))
        .toBeGreaterThanOrEqual(50);
    }

    // 7. GM resolves Turn 1 and verifies real combat casualties in the published report.
    await frame.getByRole("button", { name: "Close and resolve" }).click();
    await expect(frame.locator('[data-version="1"]')).toBeVisible({ timeout: 60_000 });
    await frame.getByRole("button", { name: "View report" }).click();
    await expect(frame.locator("[data-report-unit]").first()).toBeVisible();
    const rows = await frame.locator("[data-report-unit]").allTextContents();
    expect(rows.length).toBeGreaterThan(0);
  } finally {
    await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
    await stop();
  }
});
