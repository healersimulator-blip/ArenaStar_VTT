import { expect, test } from "@playwright/test";
import { entry, hostCall, surfaceCallArg, waitForSurface } from "./lib";

/**
 * MATT §5.4 Move — end-to-end: the wizard authors a movement-automation graph
 * whose Move step repositions the token collection, and the committed move is
 * host-authoritative (the e2e host hook reads the host store, not the canvas).
 *
 * The destination is chosen outside the anchor tile so the committed move's
 * own movement-trigger dispatch has no sibling to cascade into; the bounded
 * cascade (ping-pong depth cap) is covered by the host fixtures in
 * tests/host/sync.test.ts.
 */
test("wizard: Move action relocates the current token collection on the host", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  // Token lands at world (550, 550): col 5, Medium footprint (1 cell), grid 100.
  expect(await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1ePlaceTokens", [
    { id: "mover-runner", col: 5, row: 5, size: "Medium" },
  ])).toMatchObject({ ok: true, placed: 1 });
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);

  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  // Anchor tile covering the token: 450..650 on both axes.
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Mover staging tile");
  await tile.getByLabel("X", { exact: true }).fill("450");
  await tile.getByLabel("Y", { exact: true }).fill("450");
  await tile.getByLabel("Width").fill("200");
  await tile.getByLabel("Height").fill("200");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Mover staging tile" })).toHaveCount(1);

  await zones.locator("[data-zone-name]").fill("Mover");
  await zones.locator('[data-zone-step="select"]').getByLabel("Current collection").selectOption("inside");
  await zones.locator('[data-zone-add="move"]').click();
  const moveStep = zones.locator("[data-zone-step]").nth(2);
  await moveStep.getByLabel("Move X").fill("300");
  await moveStep.getByLabel("Move Y").fill("400");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Moved to the point");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Mover" })).toHaveCount(1);
  await expect(zones.getByRole("alert")).toHaveCount(0);

  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(before);
  await expect(page.locator("#chat-log").getByText("Moved to the point")).toHaveCount(1);
  await expect.poll(() => hostCall<{ x: number; y: number } | null>(page, "tokenPos"))
    .toMatchObject({ x: 300, y: 400 });
});
