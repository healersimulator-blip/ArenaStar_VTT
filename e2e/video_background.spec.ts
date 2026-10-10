import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { entry, waitForSurface } from "./lib";

/**
 * Phase 4 video backgrounds: a WebM dropped into the map picker is stored as its original container,
 * and the GM's stage plays it as a looping, muted background. The dialog offers only the
 * scene-background actions for a video.
 */

const clipPath = fileURLToPath(new URL("../Assets/VisualEffects/Attack_Ranged_Arrow_01_Physical_Medium_Blue_Fast_60ft.webm", import.meta.url));
const clip = readFileSync(clipPath);

type StoreSurface = {
  app?: { gm?: { client?: { store?: {
    getAll: (collection: "scenes") => Array<{ img: string | null; width: number; height: number }>;
    world?: { assetManifest?: Record<string, { mime: string; name: string }> };
  } } } };
};

async function scene(page: Page): Promise<{ img: string | null; width: number; height: number } | null> {
  return page.evaluate(() => {
    const store = (globalThis as { __vttE2E?: StoreSurface }).__vttE2E?.app?.gm?.client?.store;
    const first = store?.getAll("scenes")[0];
    return first ? { img: first.img, width: first.width, height: first.height } : null;
  });
}

async function manifestEntry(page: Page, hash: string): Promise<{ mime: string; name: string } | null> {
  return page.evaluate((id) => {
    const store = (globalThis as { __vttE2E?: StoreSurface }).__vttE2E?.app?.gm?.client?.store;
    return store?.world?.assetManifest?.[id] ?? null;
  }, hash);
}

async function backgroundMedia(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const stage = (globalThis as { __stage?: { backgroundMedia?: () => string | null } }).__stage;
    return stage?.backgroundMedia?.() ?? null;
  });
}

test.describe("video backgrounds (Phase 4)", () => {
  test("a WebM map becomes a looping video background, stored as its original container", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    await page.setInputFiles("#map-input", { name: "arrow-loop.webm", mimeType: "video/webm", buffer: clip });
    const dialog = page.locator("[data-image-import-dialog]");
    await expect(dialog).toBeVisible();
    // A video preview is a <video>, not an <img>, and its metadata names the container.
    await expect(dialog.locator(".preview-frame video")).toBeVisible();
    await expect(dialog.locator(".metadata")).toContainText("video/webm");
    // Only the scene-background action is available for a video.
    await expect(dialog.getByRole("button", { name: "Apply to image" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Apply to image" }).click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(async () => (await scene(page))?.img ?? null).not.toBeNull();
    const stored = (await scene(page)) as { img: string; width: number; height: number };
    expect(stored.width).toBeGreaterThan(0);
    expect(stored.height).toBeGreaterThan(0);
    expect(await manifestEntry(page, stored.img)).toMatchObject({ mime: "video/webm", name: "arrow-loop.webm" });
    // Video stores the original bytes only: no thumbnail or mid-size copy hangs off it.
    const thumbs = await page.evaluate((id) => {
      const store = (globalThis as { __vttE2E?: { app?: { gm?: { client?: { store?: { world?: { assetManifest?: Record<string, { thumb?: unknown; mid?: unknown }> } } } } } } }).__vttE2E?.app?.gm?.client?.store;
      const e = store?.world?.assetManifest?.[id];
      return { thumb: e?.thumb ?? null, mid: e?.mid ?? null };
    }, stored.img);
    expect(thumbs).toEqual({ thumb: null, mid: null });

    await expect.poll(() => backgroundMedia(page), { timeout: 15_000 }).toBe("video");
  });
});
