import { expect, test } from "@playwright/test";
import { entry, gmCall, surfaceCallArg, waitForSurface } from "./lib";

test("level ambient override controls real exploration, inherits explicitly and survives undo/reopen", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "scout", col: 1, row: 1 }]);
  await page.locator('[data-tab="scenes"]').click();
  const editor = page.locator('[data-level-drafts]').first(); await editor.locator(":scope > summary").click();
  await editor.getByRole("button", { name: "Add draft level", exact: true }).click();
  const row = editor.locator("[data-level-id]").first(), inherit = row.getByLabel("Inherit scene ambient lighting", { exact: true });
  await expect(inherit).toBeChecked(); await inherit.uncheck();
  const darkness = row.getByLabel("Level ambient darkness", { exact: true }); await darkness.fill("2");
  const apply = editor.getByRole("button", { name: "Apply draft levels", exact: true });
  await expect(apply).toBeDisabled(); await darkness.fill("1"); await apply.click();
  await expect(editor.getByRole("status")).toContainText("Draft saved");
  const id = await row.getAttribute("data-level-id"); if (!id) throw new Error("level missing");
  const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
  await bindings.getByLabel("Membership object", { exact: true }).selectOption({ index: 1 });
  await bindings.getByLabel("Token destination level", { exact: true }).selectOption(id);
  await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");
  await page.locator("#gm-settings").click(); const settings = page.locator('[data-window="settings"]');
  await settings.locator("[data-scene-fog-range]").fill("3"); await settings.locator("[data-scene-fog-range]").press("Enter");
  await settings.locator("[data-scene-fog]").check(); await page.locator("[data-window-close]").last().click();
  await page.getByLabel("GM level perception preview", { exact: true }).selectOption(id);
  const fog = () => gmCall<{ levelId: string | null; explored: number; restored: boolean }>(page, "fogState");
  await expect.poll(async () => (await fog()).levelId).toBe(id); await expect.poll(async () => (await fog()).restored).toBe(true);
  expect((await fog()).explored).toBe(0); // Total darkness, no torch or darkvision.
  await inherit.check(); await apply.click(); await expect(apply).toBeDisabled();
  await expect.poll(async () => (await fog()).explored).toBeGreaterThan(0); // Scene is lit.
  await page.locator("#gm-undo").click(); await expect(inherit).not.toBeChecked(); await expect(darkness).toHaveValue("1");
  // Ambient changes must not erase remembered exploration.
  expect((await fog()).explored).toBeGreaterThan(0);
  await page.locator("#gm-redo").click(); await expect(inherit).toBeChecked();
  await page.locator("#gm-undo").click(); await expect(inherit).not.toBeChecked();
  // The reset clears remembered fog, not current sight. This floor is now dark.
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("[data-level-fog-reset]").click();
  expect((await fog()).explored).toBeGreaterThan(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("[data-level-fog-reset]").click();
  await expect.poll(async () => (await fog()).explored).toBe(0);
  await page.getByRole("button", { name: "Close world", exact: true }).click();
  await page.getByRole("button", { name: /^Open$/, exact: false }).first().click(); await waitForSurface(page, "app");
  await page.locator('[data-tab="scenes"]').click(); await editor.locator(":scope > summary").click();
  await expect(inherit).not.toBeChecked(); await expect(darkness).toHaveValue("1");
  await page.getByLabel("GM level perception preview", { exact: true }).selectOption(id);
  await expect.poll(async () => (await fog()).levelId).toBe(id);
  await expect.poll(async () => (await fog()).restored).toBe(true);
  expect((await fog()).explored).toBe(0);
});
