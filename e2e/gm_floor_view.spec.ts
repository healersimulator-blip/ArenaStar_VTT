import { expect, test, type Page } from "@playwright/test";
import type { Stage } from "../src/canvas/stage";
import { entry, gmCall, surfaceCallArg, waitForSurface } from "./lib";

const screenOf = (page: Page, x: number, y: number) => page.evaluate(([wx, wy]) => {
  const stage = (globalThis as unknown as { __stage: Stage }).__stage;
  const rect = stage.app.canvas.getBoundingClientRect();
  return { x: rect.left + ((wx ?? 0) - stage.camera.x) * stage.camera.scale, y: rect.top + ((wy ?? 0) - stage.camera.y) * stage.camera.scale };
}, [x, y]);

test("GM floor view: generate a stack, ghost or isolate a floor, build on it, move a token from its menu, step floors", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "hero", col: 1, row: 1 }]);
  const colored = (fill: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${fill}"/></svg>`).toString("base64")}`;
  const tile = (name: string, fill: string) => surfaceCallArg<string>(page, "gm", "seedTile", { name, x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1, img: colored(fill) });
  const red = await tile("Ground RED", "#ff0000"), blue = await tile("Upper BLUE", "#0000ff");
  await page.locator('[data-tab="scenes"]').click();
  const editor = page.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
  // G-28: generate the stack instead of adding levels one by one.
  const generator = editor.locator("[data-level-generator]");
  await generator.getByLabel("Generated floors", { exact: true }).fill("2");
  await generator.getByRole("button", { name: "Generate levels", exact: true }).click();
  const rows = editor.locator("[data-level-id]"); await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByLabel("Level name", { exact: true })).toHaveValue("Ground");
  await rows.nth(0).getByLabel(`Floor map tile ${red}`, { exact: true }).check(); await rows.nth(1).getByLabel(`Floor map tile ${blue}`, { exact: true }).check();
  await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status")).toContainText("Draft saved");
  const ground = await rows.nth(0).getAttribute("data-level-id"), upper = await rows.nth(1).getAttribute("data-level-id");
  if (!ground || !upper) throw new Error("levels missing");
  const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
  await bindings.getByLabel("Membership object", { exact: true }).selectOption("hero"); await bindings.getByLabel("Token destination level", { exact: true }).selectOption(ground);
  await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");
  // G-12: pick a floor — other floors are drawn faintly by default, or not at all.
  const floorView = page.locator("[data-gm-floor-view]");
  const alphas = () => gmCall<Record<string, number | null>>(page, "tileAlphas");
  await floorView.getByLabel("GM level perception preview", { exact: true }).selectOption(upper);
  await expect.poll(async () => (await alphas())[red]).toBeCloseTo(0.25, 5);
  expect((await alphas())[blue]).toBe(1);
  await floorView.getByLabel("GM floor display", { exact: true }).selectOption("only");
  await expect.poll(async () => (await alphas())[red] ?? null).toBeNull();
  // G-13: build mode stamps what the GM creates — a new tile joins this floor's art.
  await floorView.getByLabel("GM build mode", { exact: true }).check();
  await expect(floorView.locator("[data-gm-build-hint]")).toBeVisible();
  const prop = await tile("Upper PROP", "#00ff00");
  await expect(rows.nth(1).getByLabel(`Floor map tile ${prop}`, { exact: true })).toBeChecked();
  await expect(rows.nth(0).getByLabel(`Floor map tile ${prop}`, { exact: true })).not.toBeChecked();
  // G-17: who is where; G-16: move the hero from its token menu (all floors drawn and pickable again).
  await floorView.getByLabel("GM build mode", { exact: true }).uncheck();
  await expect(floorView.locator(`[data-floor-roster="${ground}"]`)).toContainText("· 1");
  await floorView.getByLabel("GM level perception preview", { exact: true }).selectOption("");
  const at = await screenOf(page, 150, 150);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.locator('[data-token-menu="hero"]'); await expect(menu).toBeVisible();
  await menu.locator(`[data-token-menu-floor="${upper}"]`).click();
  await expect(floorView.locator(`[data-floor-roster="${upper}"]`)).toContainText("· 1");
  await expect(floorView.locator(`[data-floor-roster="${ground}"]`)).toContainText("· 0");
  // Elevation that lands on another floor offers to move it there.
  await page.mouse.click(at.x, at.y, { button: "right" }); await expect(menu).toBeVisible();
  await menu.getByLabel("Token feet elevation", { exact: true }).fill("3"); await menu.getByLabel("Token feet elevation", { exact: true }).press("Tab");
  await expect(menu.locator("[data-token-elevation-offer]")).toContainText("That height is on Ground");
  await menu.getByRole("menuitem", { name: "Move to Ground", exact: true }).click();
  await expect(floorView.locator(`[data-floor-roster="${ground}"]`)).toContainText("· 1");
  // PageUp/PageDown step through floors.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("PageUp");
  await expect(floorView.getByLabel("GM level perception preview", { exact: true })).toHaveValue(ground);
  await page.keyboard.press("PageUp");
  await expect(floorView.getByLabel("GM level perception preview", { exact: true })).toHaveValue(upper);
});
