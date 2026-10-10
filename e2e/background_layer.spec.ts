import { expect, test, type Page } from "@playwright/test";
import { entry, rgbPng, solidPng, waitForSurface } from "./lib";

// Map & background layer (Shift+M): the background is its own editable object. Its frame, handles,
// numeric fields and arrow keys only act in that layer; each gesture is one scene update (one undo).
// Grid detection measures the map's own squares, then the GM aligns the map to the scene grid.

type Snapshot = {
  img: string | null;
  width: number;
  height: number;
  grid: { type: string; size: number };
  background: {
    offset?: { x: number; y: number };
    scale?: number;
    scaleX?: number;
    scaleY?: number;
    locked?: boolean;
    mapGrid?: { image: string; sizeX: number; sizeY: number; offsetX: number; offsetY: number } | null;
  } | null;
};

async function activeScene(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    type Doc = Snapshot & { active?: boolean };
    const store = (globalThis as unknown as {
      __vttE2E?: { app?: { gm?: { client?: { store?: { getAll: (c: "scenes") => Doc[] } } } } };
    }).__vttE2E?.app?.gm?.client?.store;
    const scenes = store?.getAll("scenes") ?? [];
    const scene = scenes.find((entry) => entry.active) ?? scenes[0];
    if (!scene) throw new Error("no scene");
    return {
      img: scene.img ?? null,
      width: scene.width,
      height: scene.height,
      grid: { type: scene.grid.type, size: scene.grid.size },
      background: scene.background ?? null,
    };
  });
}

/** Screen position of a scene point on the GM canvas, from the live camera. */
async function screenOf(page: Page, point: { x: number; y: number }): Promise<{ x: number; y: number }> {
  return page.evaluate((p) => {
    const stage = (globalThis as unknown as {
      __stage?: { app: { canvas: HTMLCanvasElement }; camera: { x: number; y: number; scale: number } };
    }).__stage;
    if (!stage) throw new Error("no GM stage");
    const rect = stage.app.canvas.getBoundingClientRect();
    const { camera } = stage;
    return { x: rect.left + (p.x - camera.x) * camera.scale, y: rect.top + (p.y - camera.y) * camera.scale };
  }, point);
}

async function dragScreen(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
}

/** Upload an image through the sidebar and apply it as the scene background (native size). */
async function replaceBackground(page: Page, name: string, buffer: Buffer): Promise<void> {
  await page.setInputFiles("#map-input", { name, mimeType: "image/png", buffer });
  const dialog = page.locator("[data-image-import-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".preview-frame img")).toBeVisible();
  await dialog.getByRole("button", { name: "Apply to image" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
}

/** Grid fixture: dark 1 px lines at columns/rows floor(o + k·pitch) on a light map. */
function gridMap(width: number, height: number, pitch: number, ox: number, oy: number): Buffer {
  const onLine = (v: number, o: number, span: number): boolean => {
    for (let k = -1; k <= span / pitch + 1; k++) if (Math.floor(o + k * pitch) === v) return true;
    return false;
  };
  return rgbPng(width, height, (x, y) =>
    onLine(x, ox, width) || onLine(y, oy, height) ? [40, 40, 40] : [236, 232, 220],
  );
}

async function openLayer(page: Page, key: "Shift+M" | "O"): Promise<void> {
  await page.keyboard.press(key);
}

test.describe("map & background layer", () => {
  test("numeric fields move and scale the background, and each change is one undo step", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await replaceBackground(page, "layer-fields.png", solidPng(960, 720, [70, 110, 80]));
    await openLayer(page, "Shift+M");
    await expect(page.locator("[data-background-panel]")).toBeVisible();

    const x = page.locator('[data-bg-field="x"]');
    await x.fill("120");
    await x.press("Tab");
    await expect.poll(async () => (await activeScene(page)).background?.offset?.x).toBe(120);

    const scaleX = page.locator('[data-bg-field="scale-x"]');
    await scaleX.fill("150");
    await scaleX.press("Tab");
    // Keep aspect is on by default, so the vertical scale follows.
    await expect.poll(async () => (await activeScene(page)).background?.scaleX).toBeCloseTo(1.5, 3);
    expect((await activeScene(page)).background?.scaleY).toBeCloseTo(1.5, 3);

    await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    await expect.poll(async () => (await activeScene(page)).background?.scaleX).toBeCloseTo(1, 3);
    expect((await activeScene(page)).background?.offset?.x).toBe(120);
    await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    await expect.poll(async () => (await activeScene(page)).background?.offset?.x).toBe(0);
  });

  test("dragging the frame moves the background only in the Map & background layer", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await replaceBackground(page, "layer-drag.png", solidPng(960, 720, [70, 110, 80]));
    const start = await activeScene(page);
    const centre = { x: 480, y: 360 };

    // Objects & tokens layer: the same gesture is a marquee, never a background move.
    await openLayer(page, "O");
    await dragScreen(page, await screenOf(page, centre), await screenOf(page, { x: centre.x + 80, y: centre.y + 40 }));
    await page.waitForTimeout(300);
    expect((await activeScene(page)).background?.offset ?? { x: 0, y: 0 }).toEqual(start.background?.offset ?? { x: 0, y: 0 });

    // Map & background layer: the image follows the pointer by the same amount in scene pixels.
    // screenOf() maps scene points to screen, so the gesture covers (80, 40) scene px at any zoom.
    await openLayer(page, "Shift+M");
    await expect(page.locator("[data-background-panel]")).toBeVisible();
    await dragScreen(page, await screenOf(page, centre), await screenOf(page, { x: centre.x + 80, y: centre.y + 40 }));
    await expect.poll(async () => (await activeScene(page)).background?.offset?.x ?? 0).toBeCloseTo(80, 1);
    expect((await activeScene(page)).background?.offset?.y ?? 0).toBeCloseTo(40, 1);
  });

  test("a corner handle keeps the aspect ratio with the opposite corner fixed; an edge stretches one axis when the lock is off", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await replaceBackground(page, "layer-handles.png", solidPng(960, 720, [70, 110, 80]));
    await openLayer(page, "Shift+M");
    await expect(page.locator("[data-background-panel]")).toBeVisible();

    // South-east corner (960, 720) → (1200, 900): both axes ×1.25, top-left stays at the origin.
    await dragScreen(page, await screenOf(page, { x: 960, y: 720 }), await screenOf(page, { x: 1200, y: 900 }));
    await expect.poll(async () => (await activeScene(page)).background?.scaleX).toBeCloseTo(1.25, 2);
    const corner = await activeScene(page);
    expect(corner.background?.scaleY).toBeCloseTo(1.25, 2);
    expect(corner.background?.offset ?? { x: 0, y: 0 }).toEqual({ x: 0, y: 0 });

    // Turn the lock off: the east edge (now at 1200, 450) stretches horizontally only.
    await page.getByLabel("Keep aspect").uncheck();
    const east = { x: 1200, y: 450 };
    await dragScreen(page, await screenOf(page, east), await screenOf(page, { x: 1440, y: 450 }));
    await expect.poll(async () => (await activeScene(page)).background?.scaleX).toBeCloseTo(1.5, 2);
    expect((await activeScene(page)).background?.scaleY).toBeCloseTo(1.25, 2);
  });

  test("arrow keys nudge 1 px, Shift 10 px; each pause ends one undo step", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await replaceBackground(page, "layer-keys.png", solidPng(960, 720, [70, 110, 80]));
    await openLayer(page, "Shift+M");
    await expect(page.locator("[data-background-panel]")).toBeVisible();

    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    await expect.poll(async () => (await activeScene(page)).background?.offset?.x).toBe(3);
    await page.waitForTimeout(600);
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(async () => (await activeScene(page)).background?.offset?.y).toBe(10);
    await page.waitForTimeout(600);

    await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    await expect.poll(async () => (await activeScene(page)).background?.offset?.y).toBe(0);
    expect((await activeScene(page)).background?.offset?.x).toBe(3);
  });

  test("the lock stops handles, drags and fields until it is released", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await replaceBackground(page, "layer-lock.png", solidPng(960, 720, [70, 110, 80]));
    await openLayer(page, "Shift+M");
    await page.locator("[data-bg-lock]").check();
    await expect.poll(async () => (await activeScene(page)).background?.locked).toBe(true);
    await expect(page.locator('[data-bg-field="x"]')).toBeDisabled();

    await dragScreen(page, await screenOf(page, { x: 480, y: 360 }), await screenOf(page, { x: 560, y: 400 }));
    await page.waitForTimeout(300);
    expect((await activeScene(page)).background?.offset ?? { x: 0, y: 0 }).toEqual({ x: 0, y: 0 });

    await page.locator("[data-bg-lock]").uncheck();
    await expect(page.locator('[data-bg-field="x"]')).toBeEnabled();
  });

  test("grid detection measures a 64 px map grid, and Match map to grid lines its squares up with the scene grid", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await replaceBackground(page, "grid-match.png", gridMap(960, 720, 64, 10, 6));
    await openLayer(page, "Shift+M");
    await expect(page.locator("[data-background-panel]")).toBeVisible();
    expect((await activeScene(page)).grid.type).toBe("square");

    await page.locator("[data-bg-detect]").click();
    await expect(page.locator("[data-bg-map-grid]")).toContainText("Map squares: 64 × 64", { timeout: 30_000 });
    const measured = (await activeScene(page)).background?.mapGrid;
    expect(measured?.sizeX).toBeCloseTo(64, 1);
    expect(measured?.sizeY).toBeCloseTo(64, 1);
    // Lines are drawn in pixel column 10 (+ k·64): their centre is at boundary 10.5.
    expect(Math.abs((measured?.offsetX ?? 0) - 10.5)).toBeLessThan(0.75);

    await page.locator("[data-bg-align]").click();
    await expect(page.locator("[data-bg-alignment]")).toContainText("Map lines sit on the grid.", { timeout: 15_000 });
    const scene = await activeScene(page);
    const grid = scene.grid.size;
    const scaleX = scene.background?.scaleX ?? 1;
    expect(scaleX).toBeCloseTo(grid / 64, 3);
    // Every map line lands on a scene grid line: (offset + scale·lineOffset) is a multiple of the grid.
    const origin = (scene.background?.offset?.x ?? 0) + scaleX * (measured?.offsetX ?? 0);
    const residual = ((origin % grid) + grid) % grid;
    expect(Math.min(residual, grid - residual)).toBeLessThan(0.01);
  });

  test("Use map squares as grid changes the scene grid to the square size and keeps the image scale", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await replaceBackground(page, "grid-squares.png", gridMap(960, 720, 64, 0, 0));
    await openLayer(page, "Shift+M");
    await page.locator("[data-bg-detect]").click();
    await expect(page.locator("[data-bg-map-grid]")).toContainText("Map squares: 64 × 64", { timeout: 30_000 });

    await page.locator("[data-bg-squares]").click();
    await expect.poll(async () => (await activeScene(page)).grid.size).toBe(64);
    const scene = await activeScene(page);
    expect(scene.background?.scale ?? 1).toBe(1);
    await expect(page.locator("[data-bg-alignment]")).toContainText("Map lines sit on the grid.");
  });

  test("a map without a grid reports that no square grid was found", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await replaceBackground(page, "plain-map.png", solidPng(960, 720, [120, 150, 110]));
    await openLayer(page, "Shift+M");
    await page.locator("[data-bg-detect]").click();
    await expect(page.locator("[data-bg-detect-message]")).toContainText("No square grid found", { timeout: 30_000 });
    expect((await activeScene(page)).background?.mapGrid ?? null).toBeNull();
  });
});
