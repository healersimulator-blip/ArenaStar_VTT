import { expect, test } from "@playwright/test";
import { entry, waitForSurface } from "./lib";

async function controlMetrics(
  locator: import("@playwright/test").Locator,
): Promise<{ fontSize: number; height: number }> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontSize: Number.parseFloat(style.fontSize),
      height: element.getBoundingClientRect().height,
    };
  });
}

test.describe("readable, keyboard-friendly UI surfaces", () => {
  test("role picker keeps primary actions readable and easy to activate", async ({
    page,
  }) => {
    await page.goto(entry);
    await expect(page.locator("h1")).toHaveText("VTT");

    for (const selector of ["#role-host", "#role-join", ".picker .btn"]) {
      const button = page.locator(selector);
      await expect(button).toBeVisible();
      const metrics = await controlMetrics(button);
      expect(metrics.fontSize).toBeGreaterThanOrEqual(16);
      expect(metrics.height).toBeGreaterThanOrEqual(48);
    }

    await page.locator("#role-join").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#invite-input")).toBeVisible();
  });

  test("player code exchange renders at a readable size and remains functional", async ({
    page,
  }) => {
    // A syntactically valid invite is enough to create the local offer. No
    // host is needed for this UI check; the answer field remains available for
    // the manual exchange step.
    await page.goto(`${entry}?join=1#room=test-room&k=test-secret`);
    await expect(page.locator("#offer-out")).toHaveValue(/.+/, {
      timeout: 20_000,
    });

    for (const selector of [
      "#offer-out",
      "#answer-input",
      "#copy-offer-out",
      "#answer-apply",
    ]) {
      const control = page.locator(selector);
      const metrics = await controlMetrics(control);
      expect(metrics.fontSize).toBeGreaterThanOrEqual(16);
      expect(metrics.height).toBeGreaterThanOrEqual(42);
    }

    await page.fill("#answer-input", "not-a-valid-host-code");
    await page.click("#answer-apply");
    await expect(page.locator("#answer-input")).toHaveValue("");
  });

  test("GM workspace gives the board room and retains accessible, compact actions", async ({
    page,
  }) => {
    await page.goto(`${entry}?e2e=1`);
    await waitForSurface(page, "app");
    await expect(page.locator("#status")).toContainText("World One");

    const board = await page.locator(".canvas-host").boundingBox();
    const rail = await page.locator("[data-canvas-toolbar]").boundingBox();
    expect(board?.y).toBeLessThan(155);
    expect(board?.width).toBeGreaterThan(700);
    expect(rail?.width).toBeLessThanOrEqual(60);
    expect(await page.evaluate(() => document.body.scrollHeight)).toBeLessThanOrEqual(960);

    for (const selector of ["#add-token", "#gm-perms", "#gm-settings", "#gm-undo", "#gm-redo"]) {
      const control = page.locator(selector);
      await expect(control).toBeVisible();
      await expect(control).toHaveAttribute("aria-label", /.+/);
      await expect(control).toHaveAttribute("title", /.+/);
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(32);
      expect(box?.height).toBeLessThanOrEqual(42);
    }
    const invite = page.locator("#share");
    await expect(invite).toBeVisible();
    expect((await controlMetrics(invite)).fontSize).toBeGreaterThanOrEqual(14);

    await page.click("#gm-settings");
    await expect(page.locator('[data-window="settings"]')).toBeVisible();
    await expect(page.locator('[data-window="settings"] [data-window-close]')).toBeVisible();
  });
});
