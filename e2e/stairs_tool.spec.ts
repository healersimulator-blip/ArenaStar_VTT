import { expect, test } from "@playwright/test";
import { entry, surfaceCall, waitForSurface } from "./lib";

/**
 * G-14 (D-450): the GM drags a stairwell out on the map with the rail's Stairs tool (snapped to the
 * grid, joining the floor in view and the next one up), then renames, re-directs and resizes it in
 * place under Floor play & stairs.
 */
interface Scene {
  levels: Array<{ id: string; name: string }>;
  regions: Array<{ id: string; name: string; x: number; y: number; width: number; height: number; stairs?: { levels: string[]; mode: string; edges?: Array<{ from: string; to: string }>; label?: string } }>;
}

test("the Stairs tool draws a stairwell on the map, and the editor renames, re-directs and resizes it", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await expect(page.locator('[data-canvas-tool="stairs"]')).toHaveCount(0); // no floors yet

  await page.locator('[data-tab="scenes"]').click();
  const editor = page.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
  const generator = editor.locator("[data-level-generator]");
  await generator.getByLabel("Generated floors", { exact: true }).fill("2");
  await generator.getByRole("button", { name: "Generate levels", exact: true }).click();
  await expect(editor.locator("[data-level-id]")).toHaveCount(2);
  await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status").first()).toContainText("Draft saved");
  const before = await surfaceCall<Scene>(page, "app", "sceneChildren");
  const [lower, upper] = before.levels;
  if (!lower || !upper) throw new Error("levels missing");

  const tool = page.locator('[data-canvas-tool="stairs"]');
  await tool.click(); await expect(tool).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("[data-stairs-hint]")).toBeVisible();
  const box = await page.locator(".canvas-host canvas").boundingBox(); if (!box) throw new Error("canvas");
  const cam = await surfaceCall<{ x: number; y: number; scale: number }>(page, "app", "camera");
  const at = (wx: number, wy: number) => ({ x: box.x + (wx - cam.x) * cam.scale, y: box.y + (wy - cam.y) * cam.scale });
  const a = at(312, 288), b = at(488, 512);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 });
  await expect(page.locator('[data-shape-preview="stairs"]')).toBeVisible();
  await page.mouse.up();

  await expect.poll(async () => (await surfaceCall<Scene>(page, "app", "sceneChildren")).regions.filter((r) => r.stairs).length).toBe(1);
  const drawn = (await surfaceCall<Scene>(page, "app", "sceneChildren")).regions.find((r) => r.stairs);
  expect(drawn).toMatchObject({ name: `Stairs ${lower.name} ↔ ${upper.name}`, x: 300, y: 300, width: 200, height: 200, stairs: { levels: [lower.id, upper.id], mode: "auto" } });
  if (!drawn) throw new Error("stairs missing");

  const play = editor.locator("[data-level-play]"); await play.locator(":scope > summary").click();
  const row = play.locator(`[data-stair-region="${drawn.id}"]`);
  await row.getByRole("button", { name: `Edit stairs ${drawn.name}`, exact: true }).click();
  const form = row.locator("[data-stair-edit]");
  await form.getByLabel("Stairs name", { exact: true }).fill("Spiral stair");
  await form.getByLabel("Stairs player label", { exact: true }).fill("Spiral");
  await form.getByLabel("Stairs directions", { exact: true }).selectOption("up");
  await form.getByLabel("Edit stairs width", { exact: true }).fill("300");
  await form.getByRole("button", { name: "Save stairs", exact: true }).click();
  await expect(play.getByRole("status")).toContainText("Stairs updated.");
  await expect.poll(async () => (await surfaceCall<Scene>(page, "app", "sceneChildren")).regions.find((r) => r.id === drawn.id)?.name).toBe("Spiral stair");
  const edited = (await surfaceCall<Scene>(page, "app", "sceneChildren")).regions.find((r) => r.id === drawn.id);
  expect(edited).toMatchObject({ width: 300, height: 200, stairs: { levels: [lower.id, upper.id], label: "Spiral", edges: [{ from: lower.id, to: upper.id }] } });
  await expect(row).toContainText("Spiral");
});
