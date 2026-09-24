import { expect, test } from "@playwright/test";
import { entry, gmCall, hostCall, surfaceCallArg, waitForSurface } from "./lib";

test("a saved tile graph summons an independent actor at its center through the real host action", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await waitForSurface(page, "gm");
  expect(await surfaceCallArg<{ ok: boolean; placed: number }>(page, "app", "pf1ePlaceTokens",
    [{ id: "wolf-source", col: 2, row: 2, owner: "gm" }])).toMatchObject({ ok: true, placed: 1 });
  await expect.poll(() => gmCall<number>(page, "actorCount")).toBe(1);
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-summons-tab]").click();
  const summons = page.locator("[data-summons-panel]");
  await summons.locator("[data-summon-name]").fill("A privately approved wolf");
  await summons.locator("[data-summon-source]").selectOption({ label: "World · wolf-source (actor)" });
  await summons.locator("[data-summon-save]").click();
  await expect(summons.locator("[data-summon-preset] option").filter({ hasText: "A privately approved wolf" })).toHaveCount(1);
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Conjuring circle");
  await tile.getByLabel("X", { exact: true }).fill("350");
  await tile.getByLabel("Y", { exact: true }).fill("400");
  await tile.getByLabel("Width").fill("200");
  await tile.getByLabel("Height").fill("160");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Conjuring circle" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Call a real wolf");
  await zones.locator(".methods label").filter({ hasText: "click" }).locator("input").check();
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.getByRole("button", { name: "Remove step 1" }).click();
  await zones.locator('[data-zone-add="summon"]').click();
  await zones.locator("[data-zone-summon-preset]").selectOption({ label: "A privately approved wolf · GM-only" });
  await zones.locator("[data-zone-summon-anchor]").selectOption("tile");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Call a real wolf" })).toHaveCount(1);
  const beforeDryRun = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-dry-run]").click();
  await expect(zones.locator("details").filter({ hasText: "Host trace" })).toContainText("1 summons (not executed)");
  expect(await hostCall<number>(page, "seq")).toBe(beforeDryRun);
  await page.locator('[data-window="macros"] [data-window-close]').click();
  await page.locator('[data-canvas-layer="map"]').click();
  const point = await page.evaluate(() => {
    const stage = (globalThis as unknown as { __stage?: {
      app: { canvas: HTMLCanvasElement }; camera: { x: number; y: number; scale: number };
    } }).__stage;
    if (!stage) throw new Error("GM canvas missing");
    const rect = stage.app.canvas.getBoundingClientRect();
    return { x: rect.left + (450 - stage.camera.x) * stage.camera.scale,
      y: rect.top + (480 - stage.camera.y) * stage.camera.scale };
  });
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeDryRun + 3); // graph, summon + receipt, finalized receipt
  await expect.poll(() => gmCall<number>(page, "actorCount")).toBe(2);
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-summons-tab]").click();
  await expect(page.locator("[data-summons-panel] [data-summon-instance]")).toHaveCount(1);
});
