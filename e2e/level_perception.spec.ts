import { expect, test } from "@playwright/test";
import { entry, gmCall, surfaceCallArg, waitForSurface } from "./lib";
import type { Stage } from "../src/canvas/stage";

test("GM diagnostic isolates floor exploration and carried-light rendering, then restores stored floor fog", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "scout", col: 1, row: 1, lightCells: 3 }]);
  await page.locator('[data-tab="scenes"]').click();
  const editor = page.locator('[data-level-drafts]').first(); await editor.locator(":scope > summary").click();
  await editor.getByRole("button", { name: "Add draft level", exact: true }).click(); await editor.getByRole("button", { name: "Add draft level", exact: true }).click();
  await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click();
  await expect(editor.getByRole("status")).toContainText("Draft saved");
  const ids = await editor.locator("[data-level-id]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-level-id")));
  const a = ids[0], b = ids[1]; if (!a || !b) throw new Error("levels missing");
  const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
  await bindings.getByLabel("Membership object", { exact: true }).selectOption({ index: 1 });
  await bindings.getByLabel("Token destination level", { exact: true }).selectOption(a);
  await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click();
  await expect(bindings.getByRole("status")).toContainText("Assignment saved");
  await page.locator("#gm-settings").click();
  const settings = page.locator('[data-window="settings"]');
  await settings.locator("[data-scene-fog-range]").fill("3"); await settings.locator("[data-scene-fog-range]").press("Enter");
  await settings.locator("[data-scene-fog]").check();
  // Close the floating window, preserving the saved fog setting.
  await page.locator("[data-window-close]").last().click();
  const selector = page.getByLabel("GM level perception preview", { exact: true });
  const state = () => gmCall<{ levelId: string | null; explored: number; stored: number; restoredBytes: number }>(page, "fogState");
  const lights = () => page.evaluate(() => {
    const stage = (globalThis as unknown as { __stage: Stage }).__stage;
    return stage.getLightingLayer().container.getChildByLabel("lights")?.children.length ?? 0;
  });
  await selector.selectOption(a);
  await expect.poll(async () => (await state()).levelId).toBe(a);
  await expect.poll(async () => (await state()).explored).toBeGreaterThan(0);
  await expect.poll(lights).toBe(1);
  await gmCall(page, "fogFlush"); await expect.poll(async () => (await state()).stored).toBeGreaterThan(0);
  await selector.selectOption(b);
  await expect.poll(async () => (await state()).levelId).toBe(b);
  await expect.poll(async () => (await state()).explored).toBe(0);
  await expect.poll(lights).toBe(0);
  expect((await state()).stored).toBe(0);
  await selector.selectOption(a);
  await expect.poll(async () => (await state()).restoredBytes).toBeGreaterThan(0);
  await expect.poll(lights).toBe(1);
  await selector.selectOption(""); await expect.poll(async () => (await state()).levelId).toBeNull();
  await expect.poll(lights).toBe(1);
});
