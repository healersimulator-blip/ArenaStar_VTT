import { expect, test } from "@playwright/test";
import { entry, waitForSurface } from "./lib";

/** The app shell is a game table, not a permanent setup form. */
test.describe("play workspace", () => {
  test("new world opens Session & world, dismissed setup stays available on return", async ({
    page,
  }) => {
    await page.goto(entry);
    await page.click("#new-world");
    await page.locator("#wizard-name").fill("A Quiet Table");
    await page.locator("#wizard-create").click();
    await expect(page.locator("#status")).toContainText("A Quiet Table", {
      timeout: 20_000,
    });
    await expect(page.locator("[data-session-panel]")).toBeVisible();
    await expect(
      page.locator("[data-session-panel] [data-world-name]"),
    ).toHaveText("A Quiet Table");
    await expect(page.locator("[data-onboarding]")).toBeVisible();
    await expect(page.locator(".canvas-host canvas")).toBeVisible();
    // Setup is nonmodal: the dock remains actionable during code exchange.
    await page.locator('[data-tab="combat"]').click();
    await expect(page.locator('[data-gm-dock] [data-active-tab="combat"]')).toBeVisible();
    await expect(page.locator("[data-session-panel]")).toBeVisible();
    await page.locator('[data-tab="chat"]').click();

    await page.getByRole("button", { name: "Close session panel" }).click();
    await expect(page.locator("[data-session-panel]")).toHaveCount(0);
    await page.click("#session-open");
    await expect(page.locator("[data-session-panel]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-session-panel]")).toHaveCount(0);

    await page.click("#close-world");
    await expect(page.locator("[data-world-row]")).toHaveCount(1);
    await page.locator("[data-world-row] [data-world-open]").click();
    await expect(page.locator("#status")).toContainText("A Quiet Table", {
      timeout: 20_000,
    });
    await expect(page.locator("[data-session-panel]")).toHaveCount(0);
    await page.click("#session-open");
    await expect(page.locator("[data-session-panel]")).toBeVisible();
  });

  test("icon rail stays narrow; relevant options float without shifting the map", async ({
    page,
  }) => {
    await page.goto(`${entry}?e2e=1`);
    await waitForSurface(page, "app");
    const rail = page.locator("[data-canvas-toolbar]");
    const canvas = page.locator(".canvas-host canvas");
    await expect(rail).toBeVisible();
    const before = await canvas.boundingBox();
    expect((await rail.boundingBox())?.width).toBeLessThanOrEqual(60);
    const draw = rail.locator('[data-canvas-tool="draw"]');
    await expect(draw).toHaveAttribute("title", /Draw.*D/);
    await expect(draw).toHaveAttribute("aria-label", "Draw");
    await expect(page.locator("[data-tool-options]")).toHaveCount(0);

    await draw.click();
    await expect(page.locator('[data-tool-options="draw"]')).toBeVisible();
    const after = await canvas.boundingBox();
    expect(after?.x).toBe(before?.x);
    expect(after?.width).toBe(before?.width);
    await page.getByRole("button", { name: "Close tool options" }).click();
    await expect(page.locator("[data-tool-options]")).toHaveCount(0);
    await rail.locator('[data-canvas-tool="pan"]').click();
    await expect(page.locator("[data-tool-options]")).toHaveCount(0);

    // Switching back to map work dismisses setup so its options are not covered.
    await page.locator("#session-open").click();
    await rail.locator('[data-canvas-tool="draw"]').click();
    await expect(page.locator("[data-session-panel]")).toHaveCount(0);
    await expect(page.locator('[data-tool-options="draw"]')).toBeVisible();
  });

  test("small viewport keeps the board above a usable content dock", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${entry}?e2e=1`);
    await waitForSurface(page, "app");
    const board = await page.locator(".canvas-host").boundingBox();
    const dock = await page.locator("[data-gm-dock]").boundingBox();
    expect(board?.height).toBeGreaterThan(370);
    expect(board?.y).toBeLessThan(dock?.y ?? 0);
    expect(
      await page.evaluate(() => document.body.scrollHeight),
    ).toBeLessThanOrEqual(844);
    await page.locator("#session-open").click();
    await expect(page.locator("[data-session-panel]")).toBeVisible();
  });
});
