import { expect, test } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";

/** G-31 (D-439): merge, reorder and rescale floors from the level editor, each undone in one step. */
test("GM merges, reorders and rescales floors with a preview, and each is one undo", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "hero", col: 1, row: 1 }]);
  await page.locator('[data-tab="scenes"]').click();
  const editor = page.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
  const generator = editor.locator("[data-level-generator]");
  await generator.getByLabel("Generated floors", { exact: true }).fill("3");
  await generator.getByRole("button", { name: "Generate levels", exact: true }).click();
  const rows = editor.locator("[data-level-id]"); await expect(rows).toHaveCount(3);
  await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status").first()).toContainText("Draft saved");
  const [ground, second, third] = await Promise.all([0, 1, 2].map((i) => rows.nth(i).getAttribute("data-level-id")));
  if (!ground || !second || !third) throw new Error("levels missing");
  // Put the hero on Floor 2, 3 units above its floor.
  const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
  await bindings.getByLabel("Membership object", { exact: true }).selectOption("hero"); await bindings.getByLabel("Token destination level", { exact: true }).selectOption(second);
  await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");
  const floorView = page.locator("[data-gm-floor-view]");
  await expect(floorView.locator(`[data-floor-roster="${second}"]`)).toContainText("· 1");

  const tools = editor.locator("[data-level-tools]"); await tools.locator(":scope > summary").click();
  // Merge Floor 2 into Ground: the preview says what will happen before anything is saved.
  const merge = tools.locator("[data-level-merge]");
  await merge.getByLabel("Merge floor", { exact: true }).selectOption(second);
  await merge.getByLabel("Merge into floor", { exact: true }).selectOption(ground);
  const plan = merge.locator('[data-plan="merge"]');
  await expect(plan).toContainText("Moves 1 token from Floor 2 to Ground, keeping their height above the floor.");
  await expect(plan).toContainText("Ground's band grows to 0–20, covering Floor 2's.");
  await expect(rows).toHaveCount(3); // nothing saved yet
  await merge.getByRole("button", { name: "Merge floors", exact: true }).click();
  await expect(tools.locator("[data-level-tools-message]")).toContainText("Deletes Floor 2");
  await expect(rows).toHaveCount(2);
  await expect(floorView.locator(`[data-floor-roster="${ground}"]`)).toContainText("· 1");
  await expect(rows.nth(0).getByLabel("top", { exact: true })).toHaveValue("20");
  await page.locator("#gm-undo").click();
  await expect(rows).toHaveCount(3);
  await expect(floorView.locator(`[data-floor-roster="${second}"]`)).toContainText("· 1");

  // Reorder: Floor 3 moves down below Floor 2, carrying the bands' contents; the list follows.
  const move = tools.locator("[data-level-move]");
  await move.getByLabel("Floor to move", { exact: true }).selectOption(third);
  await expect(move.getByRole("button", { name: "Move up", exact: true })).toBeDisabled();
  await move.getByRole("button", { name: "Move down", exact: true }).click();
  await expect(tools.locator("[data-level-tools-message]")).toContainText("Floor 3 moves below Floor 2");
  await expect(rows.nth(1).getByLabel("Level name", { exact: true })).toHaveValue("Floor 3");
  await expect(rows.nth(1).getByLabel("bottom", { exact: true })).toHaveValue("10");
  await expect(rows.nth(2).getByLabel("bottom", { exact: true })).toHaveValue("20");
  await expect(floorView.locator(`[data-floor-roster="${second}"]`)).toContainText("· 1"); // the hero moved up with its floor
  await page.locator("#gm-undo").click();
  await expect(rows.nth(1).getByLabel("Level name", { exact: true })).toHaveValue("Floor 2");

  // Rescale: 5 ft cells become 1.5 m.
  const rescale = tools.locator("[data-level-rescale]");
  await rescale.getByLabel("Elevation scale factor", { exact: true }).fill("0.3");
  await rescale.getByLabel("Also scale the grid distance", { exact: true }).check();
  await expect(rescale.locator('[data-plan="rescale"]')).toContainText("3 floor bands ×0.3.");
  await rescale.getByRole("button", { name: "Rescale elevations", exact: true }).click();
  await expect(tools.locator("[data-level-tools-message]")).toContainText("Grid distance 5 → 1.5");
  await expect(rows.nth(2).getByLabel("top", { exact: true })).toHaveValue("9");
  await page.locator("#gm-undo").click();
  await expect(rows.nth(2).getByLabel("top", { exact: true })).toHaveValue("30");
});
