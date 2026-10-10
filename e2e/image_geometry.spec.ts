import { expect, test, type Page } from "@playwright/test";
import { entry, solidPng, waitForSurface } from "./lib";

// Design §6.3 (GM decision, 2026-10-10): a background placed on an existing scene keeps that scene's
// size and lands at its native size. A new scene from an image either matches the image or keeps the
// chosen size and fits the image into it.

type SceneSnapshot = {
  img: string | null;
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
      img: (scene as unknown as { img?: string | null }).img ?? null,
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
  test("a background on an existing scene keeps the scene size and placeables, lands at native size, and Undo reverts it", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.click("#add-token");
    await expect.poll(async () => (await activeScene(page)).tokens.length).toBe(1);
    const before = await activeScene(page);
    const token = before.tokens[0];
    if (!token) throw new Error("no token");

    await replaceBackgroundFromSidebar(page, 1000, 750);
    const dialog = page.locator("[data-image-import-dialog]");
    // No size choice and no rescale choice: the scene is not resized by a background.
    await expect(dialog.getByLabel("Existing placeables when dimensions change")).toHaveCount(0);
    await expect(dialog.getByText("The scene stays", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "Apply to image" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await activeScene(page)).img).not.toBe(before.img);

    const after = await activeScene(page);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect(after.background?.scale).toBe(1);
    expect(after.background?.offset).toEqual({ x: 0, y: 0 });
    expect(after.tokens[0]?.x).toBeCloseTo(token.x, 3);
    expect(after.tokens[0]?.y).toBeCloseTo(token.y, 3);

    await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
    await expect.poll(async () => (await activeScene(page)).img).toBe(before.img);
    const restored = await activeScene(page);
    expect(restored.width).toBe(before.width);
    expect(restored.tokens[0]?.x).toBeCloseTo(token.x, 3);
  });

  test("a new scene can keep its chosen size and fit the image into it, centred with its aspect kept", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.locator('[data-tab="scenes"]').click();
    await page.locator('[aria-label="Drop one or more images here to create scenes"]').evaluate((target, bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(bytes)], "fit-map.png", { type: "image/png" }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, [...solidPng(1200, 800, [70, 110, 80])]);
    const dialog = page.locator("[data-image-import-dialog]");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("1,200 × 800 px", { exact: false })).toBeVisible({ timeout: 30_000 });

    await dialog.getByLabel("Scene size").selectOption("fitImage");
    await dialog.getByLabel("Width", { exact: true }).fill("1000");
    await dialog.getByLabel("Height", { exact: true }).fill("1000");
    // 1000 / 1200 is the limiting ratio: scale 0.8333…, width fills, height is centred (167 px down).
    await expect(dialog.getByLabel("Background scale")).toHaveValue(/^0\.833/);
    await expect(dialog.getByLabel("Background offset Y (px)")).toHaveValue("167");
    await dialog.getByRole("button", { name: "Apply to image" }).click();
    await expect(dialog).toHaveCount(0, { timeout: 30_000 });

    const created = await page.evaluate(() => {
      type Doc = { name: string; width: number; height: number; background?: { scale?: number; offset?: { x: number; y: number } } };
      const store = (globalThis as unknown as { __vttE2E?: { app?: { gm?: { client?: { store?: { getAll: (c: "scenes") => Doc[] } } } } } })
        .__vttE2E?.app?.gm?.client?.store;
      return store?.getAll("scenes").find((scene) => scene.name.startsWith("fit-map")) ?? null;
    });
    expect(created).not.toBeNull();
    expect(created?.width).toBe(1000);
    expect(created?.height).toBe(1000);
    expect(created?.background?.scale).toBeCloseTo(1000 / 1200, 3);
    expect(created?.background?.offset).toEqual({ x: 0, y: 167 });
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
