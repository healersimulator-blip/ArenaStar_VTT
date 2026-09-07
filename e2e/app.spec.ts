import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

/** 1×1 PNG (deterministic bytes for the import-map flow). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// evaluate() structured-clones results, so the surface is accessed via
// per-call expressions instead of shipping methods across the wire.
const appCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const surface = (globalThis as { __vttE2E?: { app: Record<string, () => T> | null } }).__vttE2E;
    const fn = surface?.app?.[m];
    if (typeof fn !== "function") throw new Error(`app surface missing: ${m}`);
    return fn() as T;
  }, method);

const waitForApp = (page: Page): Promise<void> =>
  expect
    .poll(() =>
      page.evaluate(() => (globalThis as { __vttE2E?: { app: unknown } }).__vttE2E?.app != null),
    )
    .toBe(true);

test.describe("GM tab app shell (§2, §14 M1)", () => {
  test("boots a fresh world with the loopback GM session", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForApp(page);
    await expect.poll(() => appCall<number>(page, "seq")).toBeGreaterThanOrEqual(1);
    expect(await appCall<string>(page, "worldId")).toMatch(/^w-/);
    // status sidebar reflects the live replica
    await expect(page.locator("#status")).toContainText("World One");
  });

  test("add token → canvas drag moves it → persists across reload", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForApp(page);
    await page.click("#add-token");
    await expect.poll(() => appCall<number>(page, "tokenCount")).toBe(1);
    const before = await appCall<{ x: number; y: number } | null>(page, "tokenPos");
    expect(before).not.toBeNull();

    // The token spawns at the scene center; stage.fit centers the scene →
    // the token sits at the canvas center. Drag from there.
    const canvas = page.locator(".canvas-host canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas not mounted");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 90, cy + 60, { steps: 6 });
    await page.mouse.up();

    await expect
      .poll(async () => {
        const pos = await appCall<{ x: number; y: number } | null>(page, "tokenPos");
        return pos !== null && (pos.x !== before?.x || pos.y !== before?.y);
      })
      .toBe(true);
    const moved = await appCall<{ x: number; y: number } | null>(page, "tokenPos");
    const worldId = await appCall<string>(page, "worldId");
    const seq = await appCall<number>(page, "seq");

    // §14/M1: persist across reload (IDB + oplog replay)
    await page.reload();
    await waitForApp(page);
    expect(await appCall<string>(page, "worldId")).toBe(worldId);
    await expect.poll(() => appCall<number>(page, "tokenCount")).toBe(1);
    expect(await appCall<{ x: number; y: number } | null>(page, "tokenPos")).toEqual(moved);
    expect(await appCall<number>(page, "seq")).toBeGreaterThanOrEqual(seq);
  });

  test("import map: thumbnail pipeline + scene.img streamed by hash (§7)", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForApp(page);
    await page.setInputFiles("#map-input", {
      name: "map.png",
      mimeType: "image/png",
      buffer: TINY_PNG,
    });
    await expect.poll(() => appCall<string | null>(page, "sceneImg")).not.toBeNull();
    const hash = await appCall<string | null>(page, "sceneImg");
    expect(hash).toMatch(/^[0-9a-f]{64}$/); // sha256 content-addressed (§7)
  });
});
