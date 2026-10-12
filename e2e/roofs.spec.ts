/* eslint-disable @typescript-eslint/no-non-null-assertion -- explicit fixtures and required renderer readbacks; absence fails the test */
import { expect, test, type Page } from "@playwright/test";
import type { Stage } from "../src/canvas/stage";
import type { TileDocument } from "../src/core/documents";
import { entry, gmCall, surfaceCallArg, waitForSurface } from "./lib";

type RoofStates = Record<string, {
  alpha: number; holes: "none" | "circles" | "vision"; openings: number; holeAlpha: number;
  under: boolean; linked: boolean; reveal: boolean; art: boolean;
} | null>;
const roofs = (page: Page) => gmCall<RoofStates>(page, "roofStates");
interface SeedTile {
  name: string; x: number; y: number; width: number; height: number; above: boolean;
  mode: "roof" | "fade" | "radial" | "vision"; alpha: number; radius?: number; img?: string;
  roofGroup?: { id: string; role: "source" | "follower" }; revealInFog?: boolean;
}
const seedTile = (page: Page, spec: SeedTile) => surfaceCallArg<string>(page, "gm", "seedTile", spec);

test("roof openings clip real pixels on WebGL, Canvas2D fades whole roofs, and fog reveal draws above the fog", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  const result = await page.evaluate(() => {
    const stage = (globalThis as unknown as { __stage: Stage }).__stage;
    stage.app.ticker.stop();
    const base: Omit<TileDocument, "_id" | "occlusion"> = {
      type: "tile", name: "Roof", ownership: { default: 0 }, flags: {}, system: {},
      x: 100, y: 100, width: 200, height: 200, img: "", above: true,
    };
    const radial: TileDocument = { ...base, _id: "px-radial", occlusion: { mode: "radial", alpha: 0.4, radius: 0.5 } };
    const vision: TileDocument = { ...base, _id: "px-vision", x: 400, occlusion: { mode: "vision", alpha: 0 } };
    const reveal: TileDocument = { ...base, _id: "px-reveal", x: 700, occlusion: { mode: "roof", alpha: 0.5 }, revealInFog: true };
    const layer = stage.getTilesLayer();
    const above = stage.root.getChildByLabel("tilesAbove")!;
    const overFog = stage.root.getChildByLabel("roofsOverFog")!;
    const frame = above.getLocalBounds().rectangle.clone();
    frame.x = 0; frame.y = 0; frame.width = 1000; frame.height = 400;
    const alphaIn = (target: typeof above, x: number, y: number): number => {
      stage.render();
      const { pixels, width } = stage.app.renderer.extract.pixels({ target, frame, resolution: 1 });
      return pixels[(y * width + x) * 4 + 3]!;
    };
    // A viewer at (200, 200) under the radial roof (radius 0.5 cells × 100 px) and one at (500, 200) under the vision roof.
    layer.sync([radial, vision, reveal], [{ x: 190, y: 190, width: 20, height: 20 }, { x: 490, y: 190, width: 20, height: 20 }], [], { gridSize: 100 });
    layer.setVision([new Float32Array([450, 150, 550, 150, 550, 250, 450, 250]), new Float32Array([600, 150, 720, 150, 720, 250, 600, 250])]);
    const out = {
      renderer: stage.rendererName,
      radial: { centre: alphaIn(above, 200, 200), rim: alphaIn(above, 240, 200), outside: alphaIn(above, 270, 200) },
      vision: { seen: alphaIn(above, 500, 200), unseen: alphaIn(above, 580, 280) },
      states: { radial: layer.roofStateOf("px-radial"), vision: layer.roofStateOf("px-vision"), reveal: layer.roofStateOf("px-reveal") },
      overFog: { roof: alphaIn(overFog, 800, 200), beside: alphaIn(overFog, 650, 200) },
    };
    layer.setVision([]);
    const cleared = { overFog: alphaIn(overFog, 800, 200), copies: overFog.children.length };
    layer.sync([], []);
    return { ...out, cleared, leftovers: above.children.filter((child) => child.label.startsWith("roof")).length };
  });
  const full = Math.round(0.85 * 255); // the placeholder fill
  if (result.renderer === "canvas") {
    // No inverse masks: whole-roof fades, never a hole that could not be clipped.
    expect(result.states.radial).toMatchObject({ holes: "none", alpha: 0.4 });
    expect(Math.abs(result.radial.centre - result.radial.outside)).toBeLessThanOrEqual(2);
    expect(result.radial.outside).toBeLessThan(full - 40);
    expect(result.states.vision).toMatchObject({ holes: "none", alpha: 0 });
    expect(result.vision.unseen).toBe(0);
  } else {
    expect(result.states.radial).toMatchObject({ holes: "circles", openings: 1, alpha: 1, holeAlpha: 0.4 });
    expect(Math.abs(result.radial.centre - Math.round(0.4 * full))).toBeLessThanOrEqual(3);
    expect(Math.abs(result.radial.rim - result.radial.centre)).toBeLessThanOrEqual(3);
    expect(result.radial.outside).toBeGreaterThanOrEqual(full - 3);
    expect(result.states.vision).toMatchObject({ holes: "vision", openings: 2, alpha: 1 });
    expect(result.vision.seen).toBe(0);
    expect(result.vision.unseen).toBeGreaterThanOrEqual(full - 3);
  }
  // G-24 needs no masks: the copy above the fog is drawn on both renderers.
  expect(result.states.reveal).toMatchObject({ reveal: true, under: false });
  expect(result.overFog.roof).toBeGreaterThanOrEqual(full - 3);
  expect(result.overFog.beside).toBe(0);
  expect(result.cleared).toEqual({ overFog: 0, copies: 0 });
  expect(result.leftovers).toBe(0);
});

test("GM authors roofs: group fade, reveal through live fog, radial setup in the editor, and Peek under roofs", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "gm");
  // A vision token at (150, 150) with sight bounded to 6 squares, fog on for the scene.
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "scout", col: 1, row: 1 }]);
  await page.click("#gm-settings");
  const settings = page.locator('[data-window="settings"]');
  await expect(settings).toBeVisible();
  const range = settings.locator("[data-scene-fog-range]");
  await range.fill("6");
  await range.press("Enter");
  await settings.locator("[data-scene-fog]").check();
  await page.locator('[data-window="settings"] [data-window-close]').click();

  // The scout stands under the hall; the porch follows the hall's group. The tower shows through
  // fog within sight; the far shed is out of sight; the inn sits in the middle of the scene.
  const hall = await seedTile(page, { name: "Hall", x: 50, y: 50, width: 200, height: 200, above: true, mode: "roof", alpha: 0.3, roofGroup: { id: "keep", role: "source" } });
  const porch = await seedTile(page, { name: "Porch", x: 250, y: 50, width: 100, height: 200, above: true, mode: "roof", alpha: 0.3, roofGroup: { id: "keep", role: "follower" } });
  const tower = await seedTile(page, { name: "Tower", x: 450, y: 50, width: 200, height: 200, above: true, mode: "roof", alpha: 0.5, revealInFog: true });
  const shed = await seedTile(page, { name: "Shed", x: 1500, y: 1100, width: 200, height: 200, above: true, mode: "roof", alpha: 0.5, revealInFog: true });
  const inn = await seedTile(page, { name: "Inn roof", x: 850, y: 600, width: 300, height: 300, above: false, mode: "roof", alpha: 0.5 });
  await expect.poll(async () => {
    const s = await roofs(page);
    return [s[hall]?.under, s[porch]?.linked, s[porch]?.alpha, s[tower]?.reveal, s[shed]?.reveal, s[inn]?.alpha];
  }).toEqual([true, true, 0.3, true, false, 1]);

  // The scout walks under the tower: it opens and is no longer copied above the fog; the keep closes.
  await surfaceCallArg(page, "app", "pf1eMoveToken", { tokenId: "scout", col: 5, row: 1 });
  await expect.poll(async () => {
    const s = await roofs(page);
    return [s[tower]?.under, s[tower]?.reveal, s[tower]?.alpha, s[hall]?.alpha, s[porch]?.alpha];
  }).toEqual([true, false, 0.5, 1, 1]);

  // The editor turns the floor tile into a radial roof that also shows through fog.
  await page.locator('[data-tab="scenes"]').click();
  const editor = page.locator("[data-roof-editor]").first();
  await editor.locator(":scope > summary").click();
  const row = editor.locator(`[data-roof-row="${inn}"]`);
  await row.getByLabel("Roof Inn roof", { exact: true }).check();
  await expect(row.locator("[data-roof-summary]")).toHaveText("roof · fades to 50% with a token beneath");
  await row.getByLabel("Roof fade Inn roof", { exact: true }).selectOption("radial");
  await expect(row.locator("[data-roof-summary]")).toContainText("opens 2 cells around tokens");
  await row.getByLabel("Roof radius Inn roof", { exact: true }).fill("1");
  await row.getByLabel("Roof radius Inn roof", { exact: true }).press("Tab");
  await row.getByLabel("Roof group Inn roof", { exact: true }).fill("bad id!");
  await row.getByLabel("Roof group Inn roof", { exact: true }).press("Tab");
  await expect(editor.locator("[data-roof-message]")).toContainText("roof group id");
  await row.getByLabel("Roof group Inn roof", { exact: true }).fill("inn");
  await row.getByLabel("Roof group Inn roof", { exact: true }).press("Tab");
  await row.getByLabel("Roof role Inn roof", { exact: true }).selectOption("follower");
  await row.getByLabel("Roof shows through fog Inn roof", { exact: true }).check();
  await expect(row.locator("[data-roof-summary]")).toHaveText("roof · opens 1 cells around tokens (50%) · group inn (follower) · shows through fog");

  // Peek under roofs: the GM's pointer opens the roof it is over, on this screen only.
  const peek = page.getByLabel("Peek under roofs", { exact: true });
  await peek.check();
  const box = (await page.locator(".canvas-host canvas").boundingBox())!;
  await expect.poll(async () => {
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    return (await roofs(page))[inn]?.under;
  }).toBe(true);
  const peeking = (await roofs(page))[inn]!;
  expect(peeking.alpha).toBe(peeking.holes === "circles" ? 1 : 0.5); // WebGL opens a circle; Canvas2D fades it whole
  await peek.uncheck();
  await expect.poll(async () => (await roofs(page))[inn]?.under).toBe(false);
});

test("a roof's own art decides who is under it: transparent pixels do not open it", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "gm");
  // A real image: left half opaque, right half transparent.
  const img = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 64;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#a33";
    context.fillRect(0, 0, 32, 64);
    return canvas.toDataURL("image/png");
  });
  await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "scout", col: 2, row: 1 }]);
  const leanTo = await seedTile(page, { name: "Lean-to", x: 100, y: 50, width: 200, height: 200, above: true, mode: "roof", alpha: 0.2, img });
  // The scout's centre (250, 150) is inside the tile rectangle but on the transparent half.
  await expect.poll(async () => (await roofs(page))[leanTo]).toMatchObject({ art: true, under: false, alpha: 1 });
  await surfaceCallArg(page, "app", "pf1eMoveToken", { tokenId: "scout", col: 1, row: 1 });
  await expect.poll(async () => (await roofs(page))[leanTo]).toMatchObject({ art: true, under: true, alpha: 0.2 });
});
