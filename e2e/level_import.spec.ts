import { expect, test } from "@playwright/test";
import { entry, hostCall, surfaceCallArg, waitForSurface } from "./lib";

/** G-29 (D-441): import another scene's map, walls and lights as a new floor, then undo it in one step. */
test("GM imports a scene as a floor with a preview, and undo removes it whole", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "hero", col: 1, row: 1 }]);
  // A second scene drawn on a 50 px grid: a map tile, two walls and a lamp.
  await page.evaluate(() => {
    const app = (globalThis as unknown as { __vttE2E: { app: { gm: { client: { submit(ops: unknown[]): void } } } } }).__vttE2E.app;
    const base = { ownership: { default: 0 }, flags: {}, system: {} };
    const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#884400"/></svg>')}`;
    app.gm.client.submit([{ kind: "create", coll: "scenes", data: { ...base, _id: "scene-cellar", type: "scene", name: "Cellar map", active: false, img: null, width: 500, height: 400,
      grid: { type: "square", size: 50, distance: 5, units: "ft" }, darkness: 0, tokens: [], lights: [{ ...base, _id: "lamp", type: "light", name: "lamp", x: 100, y: 100, dim: 100, bright: 50, color: "#ffaa00", alpha: 0.5 }],
      walls: [{ ...base, _id: "w1", type: "wall", name: "w1", c: [0, 0, 250, 0], door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0 },
        { ...base, _id: "w2", type: "wall", name: "w2", c: [250, 0, 250, 200], door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0 }],
      sounds: [], tiles: [{ ...base, _id: "floorArt", type: "tile", name: "Cellar art", x: 0, y: 0, width: 500, height: 400, img: svg, above: false, occlusion: { mode: "fade", alpha: 0 } }],
      regions: [], drawings: [], templates: [], notes: [] } }]);
  });
  const sceneId = await hostCall<string | null>(page, "activeSceneId");
  if (!sceneId) throw new Error("no active scene");
  await page.locator('[data-tab="scenes"]').click();
  // One draft editor per scene: use the active scene's (the cellar scene would sort first).
  const editor = page.locator(`[data-level-drafts="${sceneId}"]`); await editor.locator(":scope > summary").click();
  const generator = editor.locator("[data-level-generator]");
  await generator.getByLabel("Generated floors", { exact: true }).fill("2");
  await generator.getByRole("button", { name: "Generate levels", exact: true }).click();
  const rows = editor.locator("[data-level-id]"); await expect(rows).toHaveCount(2);
  await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status").first()).toContainText("Draft saved");

  const tools = editor.locator("[data-level-tools]"); await tools.locator(":scope > summary").click();
  const panel = tools.locator("[data-level-import]");
  await panel.getByLabel("Import source scene", { exact: true }).selectOption("scene-cellar");
  await expect(panel.getByLabel("Import into floor", { exact: true })).toHaveValue("");
  await panel.getByLabel("New floor name", { exact: true }).fill("Attic");
  await panel.getByLabel("Import offset x", { exact: true }).fill("2");
  const plan = panel.locator('[data-plan="import"]');
  await expect(plan).toContainText("New floor Attic: Z 20–30, above Floor 2");
  await expect(plan).toContainText("1 map tile, 2 walls, 1 light from Cellar map");
  await expect(plan).toContainText("Scaled ×2 so 50 px cells match this scene's 100 px");
  await expect(rows).toHaveCount(2); // nothing saved yet
  await panel.getByRole("button", { name: "Import as floor", exact: true }).click();
  await expect(tools.locator("[data-level-tools-message]")).toContainText("Undo is available");
  await expect(rows).toHaveCount(3);
  const imported = () => page.evaluate(() => {
    const app = (globalThis as unknown as { __vttE2E: { app: { gm: { client: { store: { getAll(c: string): Array<Record<string, unknown>> } } } } } }).__vttE2E.app;
    const scene = app.gm.client.store.getAll("scenes").find((s) => (s.tokens as Array<{ _id: string }>).some((t) => t._id === "hero")) as {
      levels: Array<{ _id: string; name: string; tileIds?: string[] }>; walls: Array<{ c: number[]; levelScope?: { ids?: string[] } }>;
      lights: Array<{ x: number; dim: number; levelScope?: { ids?: string[] } }>; tiles: Array<{ _id: string; x: number; width: number }> };
    const attic = scene.levels.find((l) => l.name === "Attic");
    return { attic: attic ? { tiles: (attic.tileIds ?? []).map((id) => scene.tiles.find((t) => t._id === id)).map((t) => t && [t.x, t.width]) } : null,
      walls: scene.walls.filter((w) => attic && w.levelScope?.ids?.includes(attic._id)).map((w) => w.c),
      lights: scene.lights.filter((l) => attic && l.levelScope?.ids?.includes(attic._id)).map((l) => [l.x, l.dim]) };
  });
  // Offset 2 cells (200 px), everything doubled to match the 100 px grid, all stamped with Attic.
  expect(await imported()).toEqual({ attic: { tiles: [[200, 1000]] }, walls: [[200, 0, 700, 0], [700, 0, 700, 400]], lights: [[400, 200]] });
  await page.locator("#gm-undo").click();
  await expect(rows).toHaveCount(2);
  expect(await imported()).toEqual({ attic: null, walls: [], lights: [] });
});
