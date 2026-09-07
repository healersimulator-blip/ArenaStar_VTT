import { test, expect, type Page } from "@playwright/test";
import { entry, hostCall } from "./lib";

export interface TileSpec {
  x: number;
  y: number;
  width: number;
  height: number;
  above: boolean;
  mode: "roof" | "fade";
  alpha: number;
}

/** gm surface seedTile through the real client op path. */
function seedTile(page: Page, spec: TileSpec): Promise<string> {
  return page.evaluate((tile: TileSpec) => {
    const sfc = (
      globalThis as unknown as { __vttE2E?: { gm?: { seedTile: (t: TileSpec) => string } } }
    ).__vttE2E;
    const fn = sfc?.gm?.seedTile;
    if (typeof fn !== "function") throw new Error("gm surface missing: seedTile");
    return fn(tile);
  }, spec);
}

const gmCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const sfc = (globalThis as unknown as { __vttE2E?: { gm?: Record<string, () => T> } }).__vttE2E;
    const fn = sfc?.gm?.[m];
    if (typeof fn !== "function") throw new Error(`gm surface missing: ${m}`);
    return fn();
  }, method);

test.describe("canvas ephemera + tiles (§9, D-083)", () => {
  test("alt+click pings; ping expires; ctrl+click ruler with Escape dismiss", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    const canvas = page.locator(".canvas-host canvas");
    await expect.poll(() => canvas.count()).toBe(1);

    // ping: alt+click on empty canvas (far from any token)
    await canvas.click({ modifiers: ["Alt"], position: { x: 200, y: 150 } });
    await expect
      .poll(() => gmCall<{ pings: number; rulers: number }>(page, "effectsSummary"))
      .toEqual({ pings: 1, rulers: 0 });

    // pings fade after their TTL (1.4s) — wait past it
    await page.waitForTimeout(2200);
    await expect
      .poll(() => gmCall<{ pings: number; rulers: number }>(page, "effectsSummary"))
      .toEqual({ pings: 0, rulers: 0 });

    // ruler: ctrl+click two waypoints
    await canvas.click({ modifiers: ["Control"], position: { x: 150, y: 150 } });
    await canvas.click({ modifiers: ["Control"], position: { x: 350, y: 300 } });
    await expect
      .poll(() => gmCall<{ pings: number; rulers: number }>(page, "effectsSummary"))
      .toEqual({ pings: 0, rulers: 1 });

    // Escape clears the ruler
    await page.keyboard.press("Escape");
    await expect
      .poll(() => gmCall<{ pings: number; rulers: number }>(page, "effectsSummary"))
      .toEqual({ pings: 0, rulers: 0 });
  });

  test("roof tile fades over a vision token and restores when it leaves", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await page.click("#add-token");
    await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
    const pos = await hostCall<{ x: number; y: number } | null>(page, "tokenPos");
    expect(pos).not.toBeNull();
    const at = pos as { x: number; y: number };

    // roof over the token → faded; fade tile → always faded; floor tile → opaque
    const roofId = await seedTile(page, {
      x: at.x - 150,
      y: at.y - 150,
      width: 300,
      height: 300,
      above: true,
      mode: "roof",
      alpha: 0.25,
    });
    const fadeId = await seedTile(page, {
      x: at.x - 400,
      y: at.y - 150,
      width: 200,
      height: 200,
      above: true,
      mode: "fade",
      alpha: 0.4,
    });
    const floorId = await seedTile(page, {
      x: at.x + 200,
      y: at.y - 150,
      width: 200,
      height: 200,
      above: false,
      mode: "roof",
      alpha: 0.25,
    });
    expect(roofId).toBeTruthy();

    const alphas = () => gmCall<Record<string, number | null>>(page, "tileAlphas");
    await expect.poll(async () => (await alphas())[roofId]).toBe(0.25); // roof over the token
    expect((await alphas())[fadeId]).toBe(0.4); // fade ignores occupancy
    expect((await alphas())[floorId]).toBe(1); // below is always opaque

    // drag the token off the roof → roof restores to opaque
    const canvas = page.locator(".canvas-host canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no canvas box");
    // token is at scene centre; find its screen point via the camera transform:
    // fit() put the scene rect in view — centre of the canvas ≈ centre of scene
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 260, cy - 180, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await alphas())[roofId]).toBe(1);
  });
});
