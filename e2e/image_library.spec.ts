import { expect, test, type Page } from "@playwright/test";
import { applySidebarMap, entry, solidPng, waitForSurface } from "./lib";

/**
 * §6.8: the GM library lists stored images, and the confirmed clean-up removes only images that no
 * live document uses. Each import also stores a thumbnail; it follows its parent image.
 */

const mapA = Buffer.from(solidPng(16, 8, [200, 60, 60]));
const mapB = Buffer.from(solidPng(16, 8, [60, 200, 60]));

type StoreSurface = {
  app?: { gm?: { client?: { store?: {
    getAll: (collection: "scenes") => Array<{ img: string | null }>;
    world?: { assetManifest?: Record<string, unknown> };
  } } } };
};

async function sceneImage(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const store = (globalThis as { __vttE2E?: StoreSurface }).__vttE2E?.app?.gm?.client?.store;
    return store?.getAll("scenes")[0]?.img ?? null;
  });
}

async function manifestIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = (globalThis as { __vttE2E?: StoreSurface }).__vttE2E?.app?.gm?.client?.store;
    return Object.keys(store?.world?.assetManifest ?? {}).sort();
  });
}

// Distinct names: a second "map.png" would open the folder-collision choice, which is tested elsewhere.
async function importMap(page: Page, buffer: Buffer, name: string): Promise<void> {
  await page.setInputFiles("#map-input", { name, mimeType: "image/png", buffer });
  await applySidebarMap(page);
}

/** Import A, then replace the background with B: A is left behind as an unused image. */
async function replaceBackgroundTwice(page: Page): Promise<{ hashA: string; hashB: string }> {
  await importMap(page, mapA, "map-a.png");
  await expect.poll(() => sceneImage(page)).not.toBeNull();
  const hashA = (await sceneImage(page)) as string;
  await importMap(page, mapB, "map-b.png");
  await expect.poll(() => sceneImage(page)).not.toBe(hashA);
  const hashB = (await sceneImage(page)) as string;
  return { hashA, hashB };
}

test.describe("GM image library and clean-up (§6.8)", () => {
  test("the library marks the replaced image unused and the live image in use", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    const { hashA, hashB } = await replaceBackgroundTwice(page);

    await page.locator('[data-tab="images"]').click();
    await page.getByRole("button", { name: "Load library" }).click();

    // Each import stored an original and a thumbnail: four stored images in total.
    await expect(page.locator("[data-library-item]")).toHaveCount(4);
    await expect(page.locator(`[data-library-item][data-in-use="no"] .name[title="${hashA}"]`)).toBeVisible();
    await expect(page.locator(`[data-library-item][data-in-use="yes"] .name[title="${hashB}"]`)).toBeVisible();
    await expect(page.locator('[data-library-item][data-in-use="no"]')).toHaveCount(2);
    await expect(page.locator('[data-library-item][data-in-use="yes"]')).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Clean up unused images…" })).toBeEnabled();

    // §6.8: the GM can download an image before it is cleaned up.
    await expect(page.getByRole("button", { name: "Download" })).toHaveCount(4);
    const download = page.waitForEvent("download");
    await page.locator('[data-library-item][data-in-use="no"]').first().getByRole("button", { name: "Download" }).click();
    expect((await download).suggestedFilename()).toMatch(/^map-a\.png/);
  });

  test("cancelling the confirmation deletes nothing; confirming removes only the unused images", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    const { hashA, hashB } = await replaceBackgroundTwice(page);

    await page.locator('[data-tab="images"]').click();
    await page.getByRole("button", { name: "Load library" }).click();
    await expect(page.locator("[data-library-item]")).toHaveCount(4);

    await page.getByRole("button", { name: "Clean up unused images…" }).click();
    const confirm = page.getByRole("alertdialog", { name: "Confirm clean-up" });
    await expect(confirm).toContainText("Delete 2 unused images");
    await expect(confirm).toContainText("Undo can no longer bring these images back");
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(await manifestIds(page)).toContain(hashA);

    await page.getByRole("button", { name: "Clean up unused images…" }).click();
    await page.getByRole("button", { name: "Delete unused images" }).click();
    await expect(page.locator('[role="status"]')).toContainText("Removed 2 unused images");

    await expect.poll(() => manifestIds(page)).not.toContain(hashA);
    expect(await manifestIds(page)).toContain(hashB);
    expect(await sceneImage(page)).toBe(hashB);
    await expect(page.locator("[data-library-item]")).toHaveCount(2);
    await expect(page.locator('[data-library-item][data-in-use="no"]')).toHaveCount(0);
  });
});
