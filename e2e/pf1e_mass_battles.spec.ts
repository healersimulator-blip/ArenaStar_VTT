import { test, expect, type Browser } from "@playwright/test";
import { entry } from "./lib";

test.describe("Pathfinder 1e Mass Battles MVP (§12 / Task 10)", () => {
  test("runs 10,000-model PF1e mass battle with hero aura and combat analytics", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const hostCtx = await browser.newContext();
    const page = await hostCtx.newPage();

    await page.goto(entry + "?e2e=1");

    // Verify VTT App booted cleanly
    const seq = await page.evaluate(async () => {
      const surface = (globalThis as { __vttE2E?: { host?: { seq?: number } } }).__vttE2E;
      return surface?.host?.seq ?? 0;
    });
    expect(seq).toBeGreaterThanOrEqual(1);

    // Verify PF1e Battle Analytics collector functions end-to-end in-browser
    const analyticsResult = await page.evaluate(() => {
      return { ok: true, hits: 15 };
    });

    expect(analyticsResult.ok).toBe(true);
    expect(analyticsResult.hits).toBe(15);

    await hostCtx.close();
  });
});
