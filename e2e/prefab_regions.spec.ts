import { expect, test } from "@playwright/test";
import { entry, hostCall, waitForSurface } from "./lib";

interface RegionRead {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  shape: { kind: "polygon"; points: Array<[number, number]> };
  hidden: boolean;
}

test("GM captures and places a region-root prefab through the wizard", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-source-kind]").selectOption("region");
  await zones.locator("[data-zone-region-create] summary").click();
  const regionEditor = zones.locator("[data-zone-region-create]");
  await regionEditor.getByLabel("Region name").fill("Courtyard trigger");
  await regionEditor.getByLabel("X", { exact: true }).fill("300");
  await regionEditor.getByLabel("Y", { exact: true }).fill("300");
  await regionEditor.getByLabel("Width").fill("200");
  await regionEditor.getByLabel("Height").fill("200");
  await regionEditor.locator("[data-zone-region-shape]").selectOption("diamond");
  await regionEditor.locator("[data-zone-create-region]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Courtyard trigger" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Courtyard crossing graph");
  await zones.locator(".methods label").filter({ hasText: "exit" }).locator("input").check();
  await zones.locator("[data-zone-save]").click();
  await expect(zones.locator("li").filter({ hasText: "Courtyard crossing graph" })).toHaveCount(1);
  await page.locator("[data-macro-tags-tab]").click();
  const tags = page.locator("[data-tagger]");
  await tags.getByLabel("Placeable type").selectOption("regions");
  const regionRow = tags.locator("[data-tag-results] .result").filter({ hasText: "Courtyard trigger" });
  await expect(regionRow).toHaveCount(1);
  await regionRow.locator('input[type="checkbox"]').check();
  await tags.locator("[data-tags-edit]").fill("courtyard-root");
  const beforeTag = await hostCall<number>(page, "seq");
  await tags.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(beforeTag + 1);
  await expect(regionRow).toContainText("courtyard-root");
  const before = await hostCall<{ regions: RegionRead[] }>(page, "sceneChildren");
  const source = before.regions.find((candidate) => candidate.name === "Courtyard trigger");
  expect(source).toBeTruthy();

  await page.locator("[data-macro-prefabs-tab]").click();
  const panel = page.locator("[data-prefab-panel]");
  await panel.locator("[data-prefab-name]").fill("Region-rooted courtyard");
  await panel.locator("[data-prefab-parts]").getByText("Courtyard trigger").click();
  await expect(panel.locator("[data-prefab-root]")).not.toHaveValue("");
  await panel.locator("[data-prefab-save]").click();
  await expect(panel.getByRole("status")).toContainText("1 graphs");
  await expect(panel.locator("[data-prefab-list] option").filter({ hasText: "Region-rooted courtyard" })).toHaveCount(1);
  await panel.getByLabel("X", { exact: true }).fill("700");
  await panel.getByLabel("Y", { exact: true }).fill("700");
  await panel.getByLabel("Rotation °").fill("90");
  await panel.getByLabel("Scale").fill("1");
  await panel.locator("[data-prefab-preview]").click();
  await expect(panel.getByRole("status")).toContainText("Ready: 2 atomic creates");
  const seq = await hostCall<number>(page, "seq");
  await panel.locator("[data-prefab-place]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(seq + 1);
  await expect(panel.getByRole("status")).toContainText("Placed prefab");

  const after = await hostCall<{ regions: RegionRead[] }>(page, "sceneChildren");
  expect(after.regions).toHaveLength(before.regions.length + 1);
  const clone = after.regions.find((candidate) => candidate.id !== source?.id);
  expect(clone).toMatchObject({ x: 600, y: 600, width: 200, height: 200, rotation: 90,
    shape: { kind: "polygon", points: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] }, hidden: false });
  await expect(panel.locator("[data-prefab-instances] summary")).toContainText("1");
});
