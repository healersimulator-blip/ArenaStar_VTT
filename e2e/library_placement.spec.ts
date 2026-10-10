import { expect, test, type Page } from "@playwright/test";
import { applySidebarMap, entry, solidPng, waitForSurface } from "./lib";

/**
 * Phase 4, IN-5: a stored original in the GM library can become the scene background or a tile.
 * Placement goes through the import dialog, so it uses the same plan as an import, and the stored
 * hash is kept as it is (no second copy).
 */

const mapA = Buffer.from(solidPng(16, 8, [200, 60, 60]));
const mapB = Buffer.from(solidPng(16, 8, [60, 200, 60]));

type SceneRow = { img: string | null; tiles: Array<{ img: string }> };
type StoreSurface = {
  app?: { gm?: { client?: { store?: { getAll: (collection: "scenes") => SceneRow[] } } } };
};

async function scene(page: Page): Promise<SceneRow | null> {
  return page.evaluate(() => {
    const store = (globalThis as { __vttE2E?: StoreSurface }).__vttE2E?.app?.gm?.client?.store;
    const first = store?.getAll("scenes")[0];
    return first ? { img: first.img, tiles: first.tiles.map((tile) => ({ img: tile.img })) } : null;
  });
}

async function importMap(page: Page, buffer: Buffer, name: string): Promise<void> {
  await page.setInputFiles("#map-input", { name, mimeType: "image/png", buffer });
  await applySidebarMap(page);
}

test.describe("placing a stored image from the library (Phase 4, IN-5)", () => {
  test("Use as background and Place as tile both reuse the stored original", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    await importMap(page, mapA, "place-a.png");
    await expect.poll(async () => (await scene(page))?.img ?? null).not.toBeNull();
    const hashA = (await scene(page))?.img as string;
    await importMap(page, mapB, "place-b.png");
    await expect.poll(async () => (await scene(page))?.img ?? null).not.toBe(hashA);
    expect((await scene(page))?.tiles ?? []).toHaveLength(0);

    await page.locator('[data-tab="images"]').click();
    await page.getByRole("button", { name: "Load library" }).click();
    const itemA = page.locator("[data-library-item]").filter({ has: page.locator(`.name[title="${hashA}"]`) });
    await expect(itemA).toHaveCount(1);

    // Use as background: the scene's background goes back to the stored hash A.
    await itemA.getByRole("button", { name: "Use as background" }).click();
    const dialog = page.locator("[data-image-import-dialog]");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Apply to image" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await scene(page))?.img ?? null).toBe(hashA);

    // Place as tile: a new tile at natural size, pointing at the same stored hash.
    await page.locator('[data-tab="images"]').click();
    await page.getByRole("button", { name: /^(Load library|Refresh)$/ }).click();
    await page.locator("[data-library-item]").filter({ has: page.locator(`.name[title="${hashA}"]`) })
      .getByRole("button", { name: "Place as tile" }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Apply to image" }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await scene(page))?.tiles.length ?? 0).toBe(1);
    expect((await scene(page))?.tiles[0]?.img).toBe(hashA);
  });
});
