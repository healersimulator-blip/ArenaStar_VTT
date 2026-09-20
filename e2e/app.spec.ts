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
  test("the role picker's Host a world boots a live shell (D-248 regression)", async ({ page }) => {
    // The production route (no ?e2e): Root boots, THEN mounts App. Mounting App before the
    // boot had an app left a dead shell — status "—", no canvas.
    await page.goto(entry);
    await page.click("#role-host");
    await expect(page.locator("#status")).toContainText("World One", { timeout: 15_000 });
    await expect(page.locator("#status [data-rules-status]")).toHaveText(/strategic rules: built-in/);
    await expect(page.locator("canvas").first()).toBeVisible();
  });

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

  test("canvas toolbar exposes tools and dice formula control", async ({ page }) => {
    await page.goto(entry);
    await page.getByRole("button", { name: "Host a world" }).click();
    await expect(page.locator("[data-canvas-toolbar]")).toBeVisible();
    // D-256: the rail carries Roll20's tool set — select/pan, the drawing tools, measure,
    // dice, and the GM's fog / wall / light / pin placements.
    await expect(page.locator("[data-canvas-tool]")).toHaveCount(10);
    await page.locator('[data-canvas-tool="dice"]').click();
    await expect(page.getByLabel("Dice formula")).toHaveValue("1d20");
    await page.getByLabel("Dice formula").fill("1d20+5");
    await expect(page.getByRole("button", { name: "Roll" })).toBeVisible();
    await page.locator("[data-canvas-toolbar] .collapse").click();
    await expect(page.locator("[data-canvas-toolbar]")).toHaveClass(/collapsed/);
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
