import { test, expect, type Page } from "@playwright/test";
import { entry, hostCall, surfaceCallArg, waitForSurface } from "./lib";

type Wall = { id: string; c: number[]; door: number; sight: number; move: number };
const walls = (page: Page): Promise<Wall[]> => hostCall<Wall[]>(page, "walls");
async function point(page: Page, x: number, y: number) {
  const at = await surfaceCallArg<{ x: number; y: number } | null>(page, "app", "screenOf", { x, y });
  if (!at) throw new Error("canvas camera unavailable");
  return at;
}
async function drag(page: Page, from: number[], to: number[]) {
  const a = await point(page, from[0] ?? 0, from[1] ?? 0), b = await point(page, to[0] ?? 0, to[1] ?? 0);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
}

test("native wall corners and splits preview locally, undo atomically and preserve doors/windows", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#status").filter({ hasText: "seq" }).waitFor();
  await expect.poll(() => hostCall<unknown>(page, "camera")).not.toBeNull();
  await page.locator('[data-canvas-layer="gm"]').click();
  await page.locator('[data-canvas-tool="wall"]').click();
  await drag(page, [500, 400], [800, 400]);
  await expect.poll(async () => (await walls(page)).length).toBe(1);
  await drag(page, [800, 400], [800, 700]);
  await expect.poll(async () => (await walls(page)).length).toBe(2);
  const original = await walls(page);
  await page.locator('[data-wall-edit-mode="corner"]').click();
  const start = await point(page, 800, 400), end = await point(page, 900, 500);
  await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 5 });
  expect(await walls(page)).toEqual(original);
  await expect(page.locator(".shape-preview line")).toHaveCount(2);
  await page.mouse.up();
  await expect.poll(async () => (await walls(page)).map((w) => w.c)).toEqual([[500, 400, 900, 500], [900, 500, 800, 700]]);
  const moved = await walls(page);
  await page.locator('#gm-undo').click();
  await expect.poll(() => walls(page)).toEqual(original);
  await page.locator('#gm-redo').click();
  await expect.poll(() => walls(page)).toEqual(moved);
  // Escape cancels even if release happens after the keypress.
  await page.mouse.move(end.x, end.y); await page.mouse.down(); await page.mouse.move(end.x + 30, end.y + 20);
  await page.keyboard.press("Escape"); await page.mouse.up();
  expect(await walls(page)).toEqual(moved);
  await page.locator('[data-wall-edit-mode="split"]').click();
  const mid = await point(page, 700, 450); await page.mouse.click(mid.x, mid.y);
  await expect.poll(async () => (await walls(page)).length).toBe(3);
  const split = await walls(page), first = split.find((w) => w.id === original[0]?.id), added = split.find((w) => !original.some((o) => o.id === w.id));
  expect(first?.c.slice(2)).toEqual(added?.c.slice(0, 2));
  expect(added?.c.slice(2)).toEqual([900, 500]);
  await page.locator('#gm-undo').click();
  await expect.poll(() => walls(page)).toEqual(moved);
  for (const kind of ["door", "window"] as const) {
    await page.locator('[data-wall-edit-mode="draw"]').click();
    await page.locator(`[data-canvas-wall-kind="${kind}"]`).click();
    const y = kind === "door" ? 900 : 1100, count = (await walls(page)).length;
    await drag(page, [1000, y], [1300, y]);
    await expect.poll(async () => (await walls(page)).length).toBe(count + 1);
    const before = await walls(page);
    await page.locator('[data-wall-edit-mode="split"]').click();
    const center = await point(page, 1150, y); await page.mouse.click(center.x, center.y);
    await expect(page.locator('.notify[data-notify-level="warn"]').last()).toContainText("cannot be split");
    expect(await walls(page)).toEqual(before);
  }
});

test("wall pointer capture supports outside release and cancellation clears detached previews", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#status").filter({ hasText: "seq" }).waitFor();
  await expect.poll(() => hostCall<unknown>(page, "camera")).not.toBeNull();
  await page.locator('[data-canvas-layer="gm"]').click();
  await page.locator('[data-canvas-tool="wall"]').click();
  await drag(page, [500, 400], [800, 400]);
  await expect.poll(async () => (await walls(page)).length).toBe(1);
  const original = await walls(page);
  await page.locator('[data-wall-edit-mode="corner"]').click();
  const at = await point(page, 800, 400);
  for (const event of ["blur", "pointercancel"] as const) {
    await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x + 30, at.y + 30);
    await expect(page.locator(".shape-preview line")).toHaveCount(1);
    if (event === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    else await page.locator(".canvas-host canvas").dispatchEvent("pointercancel", { bubbles: true, pointerId: 1, pointerType: "mouse" });
    await expect(page.locator(".shape-preview line"), event).toHaveCount(0);
    await page.mouse.up();
    expect(await walls(page)).toEqual(original);
  }
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("canvas");
  await page.mouse.move(at.x, at.y); await page.mouse.down();
  await page.mouse.move(box.x + box.width + 5, at.y + 40, { steps: 4 }); await page.mouse.up();
  await expect.poll(async () => (await walls(page))[0]?.c).not.toEqual(original[0]?.c);
  await expect(page.locator(".shape-preview line")).toHaveCount(0);
  await page.locator("#gm-undo").click();
  await expect.poll(() => walls(page)).toEqual(original);
});
