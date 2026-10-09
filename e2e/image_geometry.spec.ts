import { expect, test, type Page } from "@playwright/test";
import { entry, solidPng, waitForSurface } from "./lib";

// Phase 3 (design §6.2, SZ-3/4/11): a background replacement that changes the scene size keeps
// placeables by default; the GM may rescale them instead, as one undoable step.

type SceneSnapshot = {
  width: number;
  height: number;
  background: { offset?: { x: number; y: number }; scale?: number; padding?: number; color?: string } | null;
  tokens: Array<{ id: string; x: number; y: number }>;
};

async function activeScene(page: Page): Promise<SceneSnapshot> {
  return page.evaluate(() => {
    type Doc = { active?: boolean; width: number; height: number; background?: SceneSnapshot["background"];
      tokens: Array<{ _id?: string; id?: string; x: number; y: number }> };
    const store = (globalThis as unknown as { __vttE2E?: { app?: { gm?: { client?: { store?: { getAll: (c: "scenes") => Doc[] } } } } } })
      .__vttE2E?.app?.gm?.client?.store;
    const scenes = store?.getAll("scenes") ?? [];
    const scene = scenes.find((entry) => entry.active) ?? scenes[0];
    if (!scene) throw new Error("no scene");
    return {
      width: scene.width,
      height: scene.height,
      background: scene.background ?? null,
      tokens: scene.tokens.map((token) => ({ id: String(token._id ?? token.id), x: token.x, y: token.y })),
    };
  });
}

async function replaceBackgroundFromSidebar(page: Page, width: number, height: number): Promise<void> {
  await page.setInputFiles("#map-input", {
    name: "geometry.png",
    mimeType: "image/png",
    buffer: solidPng(width, height, [70, 110, 80]),
  });
  const dialog = page.locator("[data-image-import-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".preview-frame img")).toBeVisible();
}

test.describe("image geometry (design §6.2, Phase 3)", () => {
  test("a background that changes the scene size keeps placeables unless the GM rescales them, and Undo reverts it", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.click("#add-token");
    await expect.poll(async () => (await activeScene(page)).tokens.length).toBe(1);
    const before = await activeScene(page);
    const token = before.tokens[0];
    if (!token) throw new Error("no token");

    await replaceBackgroundFromSidebar(page, 1000, 750);
    const dialog = page.locator("[data-image-import-dialog]");
    // Default: keep positions.
    await expect(dialog.getByLabel("Existing placeables when dimensions change")).toHaveValue("keep");
    await dialog.getByLabel("Existing placeables when dimensions change").selectOption("rescale");
    await dialog.getByRole("button", { name: "Apply to image" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await activeScene(page)).width).toBe(1000);

    const rescaled = await activeScene(page);
    expect(rescaled.height).toBe(750);
    expect(rescaled.tokens[0]?.x).toBeCloseTo(token.x * 0.5, 3);
    expect(rescaled.tokens[0]?.y).toBeCloseTo(token.y * 0.5, 3);

    // The size change and the placeable move are one undo step.
    await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    await expect.poll(async () => (await activeScene(page)).width).toBe(before.width);
    const restored = await activeScene(page);
    expect(restored.height).toBe(before.height);
    expect(restored.tokens[0]?.x).toBeCloseTo(token.x, 3);
    expect(restored.tokens[0]?.y).toBeCloseTo(token.y, 3);
  });

  test("background offset and scale are stored with the scene, and keeping positions leaves the token alone", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.click("#add-token");
    await expect.poll(async () => (await activeScene(page)).tokens.length).toBe(1);
    const before = await activeScene(page);
    const token = before.tokens[0];
    if (!token) throw new Error("no token");

    await replaceBackgroundFromSidebar(page, 1000, 750);
    const dialog = page.locator("[data-image-import-dialog]");
    await dialog.getByLabel("Background offset X (px)").fill("40");
    await dialog.getByLabel("Background offset Y (px)").fill("-20");
    await dialog.getByLabel("Background scale").fill("1.5");
    await dialog.getByRole("button", { name: "Apply to image" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await activeScene(page)).background?.scale).toBe(1.5);

    const after = await activeScene(page);
    expect(after.background?.offset).toEqual({ x: 40, y: -20 });
    expect(after.tokens[0]?.x).toBeCloseTo(token.x, 3);
    expect(after.tokens[0]?.y).toBeCloseTo(token.y, 3);
  });
});
