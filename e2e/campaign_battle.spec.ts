import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { openSceneNav } from "./lib";

// Requires only the two builds, a disposable local PostgreSQL and one Chromium worker.
test("a campaign scene launches, plays, resumes and finishes without a world transfer", async ({
  page,
  browser,
}) => {
  const db = process.env.STRATEGIC_TEST_DATABASE_URL;
  test.skip(!db, "Set STRATEGIC_TEST_DATABASE_URL to a disposable database");
  test.setTimeout(90000);
  page.setDefaultTimeout(12000);
  const portProbe = createServer().listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const addr = portProbe.address();
  if (!addr || typeof addr === "string") throw Error();
  await new Promise<void>((r) => portProbe.close(() => r()));
  const url = `http://127.0.0.1:${addr.port}`,
    key = randomUUID(),
    slot = randomUUID();
  const start = () =>
    spawn(
      process.execPath,
      ["services/strategic-room/dist/server/main.mjs", "campaign"],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          DATABASE_URL: db,
          PORT: String(addr.port),
          STRATEGIC_ROOM: slot,
          STRATEGIC_ORIGINS: url,
          STRATEGIC_LAUNCH_KEY: key,
        },
      },
    );
  let child = start();
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill("SIGTERM");
      await done;
    }
  };
  const ready = () =>
    expect
      .poll(
        async () => {
          try {
            return (await fetch(url, { method: "GET" })).status;
          } catch {
            return 0;
          }
        },
        { timeout: 8000 },
      )
      .toBe(200);
  try {
    await ready();
    await page.goto(url + "/?e2e=1");
    await openSceneNav(page);
    await page.click("#scene-add");
    await page.getByRole("menuitem", { name: "Strategic battlefield" }).click();
    await page
      .getByRole("button", { name: "Battlefield 2", exact: true })
      .click();
    await openSceneNav(page);
    await page.getByRole("button", { name: "Multiplayer battle…" }).click();
    await page.getByLabel("GM launch key").fill("wrong");
    await page
      .getByRole("button", { name: "Launch multiplayer battle" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "not authorized" }),
    ).toBeVisible();
    // Lose the response AFTER the database accepted the scene. Retry must recover its invites.
    let launchedId = "";
    await page.route(
      "**/api/campaign/launch",
      async (route) => {
        const accepted = await route.fetch();
        expect(accepted.status()).toBe(200);
        launchedId = (await accepted.json()).id;
        await route.abort();
      },
      { times: 1 },
    );
    await page.getByLabel("GM launch key").fill(key);
    await page
      .getByRole("button", { name: "Launch multiplayer battle" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: /fetch|network/i }),
    ).toBeVisible();
    await page.getByLabel("GM launch key").fill(key);
    await page
      .getByRole("button", { name: "Recover invites / retry launch" })
      .click();
    const frame = page.frameLocator(
      'iframe[title="Live strategic battlefield"]',
    );
    await expect(
      frame.getByRole("button", { name: "Close and resolve" }),
    ).toBeVisible({ timeout: 10000 });
    const path = (
      await page
        .locator('iframe[title="Live strategic battlefield"]')
        .getAttribute("src")
    )?.split("?")[0];
    expect(path).toBe(`/battle/${launchedId}/`);
    await page.getByText(/Commander admission \(/).click();
    const codes = await page
      .locator(".campaign details code")
      .allTextContents();
    expect(codes).toHaveLength(2);
    const commanders = [];
    for (const code of codes) {
      const p = await browser.newPage();
      commanders.push(p);
      await p.goto(url + path);
      await p.getByLabel("One-time invite").fill(code);
      await p.getByRole("button", { name: "Join room" }).click();
      await p.getByRole("button", { name: "Draft hold" }).click();
      await p.getByRole("button", { name: "Submit orders" }).click();
      await expect(p.locator("[data-revision]")).toHaveText("1");
      await p.reload();
      await expect(p.locator("[data-revision]")).toHaveText("1");
    }
    await frame.getByRole("button", { name: "Close and resolve" }).click();
    await expect(frame.locator('[data-version="1"]')).toBeVisible();
    for (const p of commanders) {
      await expect(p.locator('[data-version="1"]')).toBeVisible();
      await p.close();
    }
    await openSceneNav(page);
    await page.locator('[data-scene="scene-1"]').click();
    await expect(
      page.locator('iframe[title="Live strategic battlefield"]'),
    ).toHaveCount(0);
    await stop();
    child = start();
    await ready();
    await page.reload();
    await openSceneNav(page);
    await page
      .getByRole("button", { name: "Battlefield 2", exact: true })
      .click();
    await openSceneNav(page);
    await page
      .getByRole("button", { name: "Resume multiplayer battle" })
      .click();
    await expect(frame.locator('[data-version="1"]')).toBeVisible();
    await page.getByLabel("GM launch key").fill(key);
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Finish battle" }).click();
    await expect(
      page.getByLabel("Multiplayer strategic battle", { exact: true }),
    ).toHaveCount(0);
    expect((await page.request.get(url + path)).status()).toBe(404);
    await openSceneNav(page);
    await page.getByRole("button", { name: "Multiplayer battle…" }).click();
    await expect(
      page.getByText(/Previous battle ended at published version 1/),
    ).toContainText("2 models survived");
  } finally {
    await stop();
  }
});
