import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { entry, surfaceCall, waitForSurface } from "./lib";

/**
 * G-30 (D-449): the GM picks a Foundry scene export made with the Levels module, reads the report
 * (floors, counts, what is skipped, which images need a file), links the map image by picking it,
 * creates the scene, opens it, and turns floor play on through the usual check.
 */
const tower = readFileSync(new URL("../tests/fixtures/foundry/levels-tower.json", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Sq9hX8AAAAASUVORK5CYII=", "base64");

interface Imported {
  id: string; name: string; img: string | null; levelMode: string | null;
  levels: Array<{ id: string; name: string; bottom: number | null; top: number | null; tileIds: string[]; visibleLevelIds: string[] }>;
  wallScopes: Array<{ mode: string; ids?: string[] } | null>;
  tokenLevels: Array<string | null>;
  regions: Array<{ name: string; stairs?: { levels: string[]; mode: string } }>;
}

test("a Levels scene from Foundry imports with its floors, stairs and map, and floor play turns on", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await page.locator('[data-tab="scenes"]').click();
  const panel = page.locator("[data-foundry-import]");
  await panel.locator(":scope > summary").click();
  await panel.locator("[data-foundry-file]").setInputFiles({ name: "fvtt-Scene-tower.json", mimeType: "application/json", buffer: tower });

  const report = panel.locator("[data-foundry-report]");
  await expect(report.locator("[data-foundry-source]")).toHaveText("Levels module floors");
  await expect(report.locator("[data-foundry-counts]")).toHaveText("5 walls · 3 lights · 3 tiles · 2 tokens · 3 stairs");
  await expect(report.locator('[data-foundry-floor="Ground"]')).toContainText("0 to 10");
  await expect(report.locator('[data-foundry-floor="Upper"]')).toContainText("10 to 19");
  await expect(report.locator("[data-foundry-skipped]")).toContainText("1 switched-off lights");
  await expect(report.locator("[data-foundry-linked]")).toHaveText("0 of 6 have a file");

  // The map image arrives by picking the file with the same name; files the scene does not use are ignored.
  await report.locator("[data-foundry-image-files]").setInputFiles([
    { name: "Tower Ground.png", mimeType: "image/png", buffer: png },
    { name: "unrelated.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(panel.locator("[data-foundry-status]")).toHaveText("1 image(s) linked; 1 file(s) are not used by this scene.");
  await expect(report.locator('[data-foundry-image="tower ground.png"]')).toHaveAttribute("data-linked", "true");
  await expect(report.locator("[data-foundry-linked]")).toHaveText("1 of 6 have a file");

  await report.locator("[data-foundry-create]").click();
  const status = panel.locator("[data-foundry-status]");
  await expect(status).toContainText("Created “Tower”. Undo removes it.");
  await status.getByRole("button", { name: "Open it", exact: true }).click();
  await expect.poll(async () => (await surfaceCall<Imported | null>(page, "app", "sceneChildren"))?.name).toBe("Tower");
  const scene = await surfaceCall<Imported>(page, "app", "sceneChildren");
  expect(scene.img).toMatch(/^[0-9a-f]{64}$/);
  expect(scene.levels.map((l) => [l.name, l.bottom, l.top])).toEqual([["Ground", 0, 10], ["Upper", 10, 19]]);
  const [ground, upper] = scene.levels.map((l) => l.id);
  expect(scene.levels[1]?.visibleLevelIds).toEqual([ground]);
  expect(scene.wallScopes).toEqual([{ mode: "all" }, { mode: "levels", ids: [ground] }, { mode: "levels", ids: [upper] }, { mode: "all" }, { mode: "all" }]);
  expect(scene.tokenLevels).toEqual([upper, ground]);
  expect(scene.regions.map((r) => [r.name, r.stairs?.levels])).toEqual([["Main stairs", [ground, upper]], ["Stairs", [ground, upper]], ["Lift", [ground, upper]]]);
  expect(scene.levelMode).toBeNull();

  // Floor play: the usual check, then on.
  const editor = page.locator(`[data-scene-card="${scene.id}"] ~ [data-level-drafts]`).first();
  await editor.locator(":scope > summary").click();
  await expect(editor.locator("[data-level-id]")).toHaveCount(2);
  const play = editor.locator("[data-level-play]"); await play.locator(":scope > summary").click();
  await play.getByLabel("Enable isolated floor play", { exact: true }).click();
  const preflight = play.locator("[data-level-preflight]");
  await expect(preflight.or(play.getByRole("status").filter({ hasText: "enabled" }))).toBeVisible();
  if (await preflight.isVisible()) await preflight.getByRole("button", { name: "Enable anyway", exact: true }).click();
  await expect(play.getByRole("status")).toContainText("enabled");
  await expect.poll(async () => (await surfaceCall<Imported>(page, "app", "sceneChildren")).levelMode).toBe("isolated");
});
