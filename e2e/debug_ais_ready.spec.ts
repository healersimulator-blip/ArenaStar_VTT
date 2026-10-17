import { test, expect } from "@playwright/test";
import { entry, waitForSurface } from "./lib";
import { fileURLToPath } from "node:url";

const integralWorld = fileURLToPath(new URL("../dist/worlds/pf1e-integral-test-1.0.0.zip", import.meta.url));

test("debug ais ready", async ({ page }) => {
  test.setTimeout(120000);
  page.on("console", msg => console.log("console:", msg.text()));
  await page.goto(entry);
  await page.locator("#role-import").setInputFiles(integralWorld);
  const dialog = page.locator("[data-open-dialog]");
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-open-copy]").click();
  await expect(page.locator("#status")).toContainText("PF1e Integral Test", { timeout: 20000 });
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");

  await page.locator("#gm-settings").click();
  for (const modId of ["ais-foundry-v13", "pf1-content", "pf1e-archetypes", "pf1-statblock-library", "pf1"]) {
    const review = page.locator(`[data-ais-module-review="${modId}"]`);
    await expect(review).toBeVisible({ timeout: 15000 });
    console.log(`Found review for ${modId}`);
    const enableBtn = page.locator(`[data-pkg-row][data-pkg-id="${modId}"] [data-ais-enable]`);
    if (await enableBtn.count()) {
      console.log(`Enabling ${modId}`);
      await enableBtn.click();
    }
    const checkboxes = review.locator('fieldset input[type="checkbox"]');
    const count = await checkboxes.count();
    console.log(`${modId} checkboxes ${count}`);
    if (count) {
      for (const cb of await checkboxes.all()) await cb.check();
      await review.locator("[data-ais-approve]").click();
      await expect(review.locator(".ais-source-preview pre")).toBeVisible();
      await review.locator("[data-ais-approve]").click();
    }
    await expect(review.locator("[data-ais-approved]")).toBeVisible({ timeout: 15000 });
    console.log(`${modId} approved`);
  }

  console.log("All approved, reloading");
  await Promise.all([page.waitForEvent("load"), page.locator("[data-ais-reload]").click()]);
  await waitForSurface(page, "app");
  console.log("Reloaded");

  await page.locator("#gm-settings").click();
  for (const modId of ["ais-foundry-v13", "pf1-content", "pf1e-archetypes", "pf1-statblock-library", "pf1"]) {
    const runtime = page.locator(`[data-ais-module-review="${modId}"] [data-ais-runtime]`);
    await expect(runtime).toBeVisible({ timeout: 10000 });
    const val = await runtime.getAttribute("data-ais-runtime");
    console.log(`${modId} runtime attr ${val}`);
    const text = await runtime.innerText();
    console.log(`${modId} runtime text ${text.slice(0,500)}`);
  }

  // Check for errors in AIS
  const errors = page.locator("[data-ais-error], [data-ais-runtime-error]");
  console.log("error count", await errors.count());
  for (const el of await errors.all()) {
    console.log("ais error", await el.innerText());
  }

  await page.screenshot({ path: "test-results/debug-ais-ready.png", fullPage: true });
});
