import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { entry, waitForSurface } from "./lib";

const worldPath = fileURLToPath(new URL("../dist/worlds/real-pf1-minimal-test-1.0.0.zip", import.meta.url));

async function approve(page, id) {
  const row = page.locator(`[data-pkg-row][data-pkg-id="${id}"]`);
  if (await row.locator("[data-ais-enable]").count()) await row.locator("[data-ais-enable]").click();
  const review = page.locator(`[data-ais-module-review="${id}"]`);
  for (const cb of await review.locator('fieldset input[type="checkbox"]').all()) await cb.check();
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator(".ais-source-preview pre")).toBeVisible({ timeout: 15000 });
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator("[data-ais-approved]")).toBeVisible({ timeout: 15000 });
}

test("Real pf1 minimal boot diagnostics", async ({ page }) => {
  test.setTimeout(180_000);
  if (!existsSync(worldPath)) throw new Error("world missing " + worldPath);
  const logs = [];
  page.on("console", m => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", e => console.log("pageerror", e.message));

  await page.goto(entry);
  await page.locator("#role-import").setInputFiles(worldPath);
  await page.locator("[data-open-copy]").click();
  await expect(page.locator("#status")).toContainText("Real PF1 Minimal", { timeout: 60000 });
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  await approve(page, "ais-foundry-v13");
  await approve(page, "pf1");
  await Promise.all([page.waitForEvent("load"), page.locator("[data-ais-reload]").click()]);
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  // Wait for either ready or failed
  const runtime = page.locator('[data-ais-module-review="pf1"] [data-ais-runtime]');
  await expect(runtime).toBeVisible({ timeout: 30000 });
  // Wait up to 60s for ready or failed
  let state = await runtime.getAttribute("data-ais-runtime");
  for (let i=0; i<60; i++) {
    state = await runtime.getAttribute("data-ais-runtime");
    if (state === "ready" || state === "failed") break;
    await page.waitForTimeout(1000);
  }
  const text = await runtime.innerText();
  const health = await page.locator('[data-ais-health="pf1"]').innerText().catch(()=> "no health");
  console.log("runtime state", state, "text", text.slice(0,5000), "health", health.slice(0,10000));
  console.log("logs", logs.slice(-200).join("\n"));

  // Try to get info via macro invocation (foundry.info) instead of direct frame access (opaque origin)
  try {
    const settingsClose = page.locator('[data-window="settings"] [data-window-close]');
    if (await settingsClose.count()) await settingsClose.click();
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-script-tab]").click();
    const panel = page.locator("[data-script-wizard]");
    await panel.locator("[data-script-name]").fill("pf1 info");
    await panel.locator("[data-script-source]").fill(`return await api.ais.invoke("pf1", "foundry.info", {});`);
    await panel.locator(".grants label").filter({ hasText: "ais.invoke" }).locator("input").check();
    await panel.getByLabel("I reviewed this exact revision and its host grants").check();
    await panel.locator("[data-script-save]").click();
    await expect(panel.getByRole("status")).toContainText("Script revision published");
    await panel.locator("[data-script-run]").click();
    await expect(panel.getByRole("status")).toContainText("Script completed", { timeout: 30000 });
    const parsed = JSON.parse(await panel.locator("details pre").innerText());
    console.log("foundry.info", JSON.stringify(parsed, null, 2).slice(0,20000));
  } catch (e) {
    console.log("info via macro failed", e);
  }

  const frame = page.frameLocator('iframe[title="AIS module:pf1"]');
  const hasFrame = await page.locator('iframe[title="AIS module:pf1"]').count();
  console.log("iframe count", hasFrame);
  try {
    const bodyText = await frame.locator("body").innerText({ timeout: 5000 }).catch(()=> "no body");
    console.log("frame body", bodyText.slice(0,2000));
  } catch (e) { console.log("frame body error", e); }

  expect(state).toBeTruthy();
});
