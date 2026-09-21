import { test, expect, type Page } from "@playwright/test";
import { entry, hostCall, waitForSurface } from "./lib";

/**
 * D-255 — the left canvas toolbar, driven through real pointer gestures.
 *
 * PR #27 shipped the toolbar with its gestures wired to nothing (the tool controller was
 * never activated and `onDestroy` after an `await` aborted the boot wiring), so these tests
 * exist to keep the *product* path honest: every assertion below goes through a real
 * `page.mouse` gesture on the canvas and reads state back from the host replica.
 */

test.setTimeout(90_000);

const canvasBox = async (page: Page) => {
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("canvas not mounted");
  return box;
};

const bootHost = async (page: Page): Promise<void> => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#status").filter({ hasText: "seq" }).waitFor();
  // The camera only exists once the stage is up — the tool wiring follows it.
  await expect.poll(() => hostCall<unknown>(page, "camera")).not.toBeNull();
};

test.describe("canvas toolbar (§10, D-255)", () => {
  test("draw tool paints one freehand drawing and never drags the token under the stroke", async ({
    page,
  }) => {
    await bootHost(page);
    await page.click("#add-token");
    await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
    const box = await canvasBox(page);
    const before = await hostCall<{ x: number; y: number } | null>(page, "tokenPos");
    if (!before) throw new Error("token position unavailable");
    const camera = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");
    const tokenScreen = {
      x: box.x + (before.x - camera.x) * camera.scale,
      y: box.y + (before.y - camera.y) * camera.scale,
    };

    await page.locator('[data-canvas-tool="draw"]').click();
    // drag straight across the token: the stroke must win, the token must stay put
    await page.mouse.move(tokenScreen.x - 60, tokenScreen.y);
    await page.mouse.down();
    await page.mouse.move(tokenScreen.x + 60, tokenScreen.y + 40, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(() => hostCall<Array<{ kind: string }>>(page, "drawings"))
      .toHaveLength(1);
    const [drawing] = await hostCall<
      Array<{ kind: string; createdBy: string | null; points: number }>
    >(page, "drawings");
    expect(drawing?.kind).toBe("freehand");
    expect(drawing?.points).toBeGreaterThan(1);
    expect(drawing?.createdBy).toBeTruthy();
    const after = await hostCall<{ x: number; y: number } | null>(page, "tokenPos");
    expect(after).toEqual(before);
  });

  test("text tool writes a labelled drawing at the clicked point", async ({ page }) => {
    await bootHost(page);
    const box = await canvasBox(page);
    await page.locator('[data-canvas-tool="text"]').click();
    await page.mouse.click(box.x + 220, box.y + 180);
    // D-256: the text tool types in place (Roll20), so the editor is an overlay in the board
    const editor = page.locator("[data-text-editor]");
    await expect(editor).toBeVisible();
    await editor.fill("Objective marker");
    await page.locator("[data-text-commit]").click();
    await expect
      .poll(() => hostCall<Array<{ kind: string; text: string | null }>>(page, "drawings"))
      .toHaveLength(1);
    const [drawing] = await hostCall<Array<{ kind: string; text: string | null }>>(
      page,
      "drawings",
    );
    expect(drawing?.kind).toBe("text");
    expect(drawing?.text).toBe("Objective marker");
  });

  test("measure tool previews along the pointer in grid units and commits nothing", async ({
    page,
  }) => {
    await bootHost(page);
    const box = await canvasBox(page);
    const camera = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");
    const from = { x: box.x + 240, y: box.y + 200 };
    const to = { x: from.x + 160, y: from.y + 80 };

    await page.locator('[data-canvas-tool="measure"]').click();
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();

    const svg = page.locator("svg.measure-preview");
    await expect(svg).toBeVisible();
    const points = (await svg.locator("polyline").getAttribute("points")) ?? "";
    const parsed = points.split(" ").map((pair) => pair.split(",").map(Number)) as Array<
      [number, number]
    >;
    // canvas-local screen space: the preview must sit under the pointer, not offset by
    // half the viewport (the pre-D-255 bug added rect.width/2)
    const first = parsed[0];
    const last = parsed[parsed.length - 1];
    if (!first || !last) throw new Error("measure preview polyline is empty");
    expect(first[0]).toBeCloseTo(from.x - box.x, 0);
    expect(first[1]).toBeCloseTo(from.y - box.y, 0);
    expect(last[0]).toBeCloseTo(to.x - box.x, 0);
    expect(last[1]).toBeCloseTo(to.y - box.y, 0);

    // the label is the grid's own distance (scene: 100 px cell = 5 ft), never raw pixels, and
    // it follows the scene's diagonal rule — the default 5E 555 grid counts a diagonal as one
    // cell, so a mostly-horizontal drag reads max(|dx|,|dy|) rather than the hypotenuse.
    const cells = (px: number) => px / camera.scale / 100;
    const expectedFeet = Math.round(Math.max(cells(to.x - from.x), cells(to.y - from.y)) * 5);
    await expect(svg.locator("text")).toHaveText(`${expectedFeet} ft`);
    expect(expectedFeet).toBeGreaterThan(0);

    // measuring is a read-only gesture
    expect(await hostCall<unknown[]>(page, "drawings")).toHaveLength(0);
    expect(await hostCall<number>(page, "tokenCount")).toBe(0);
  });

  test("pan mode drags the map with the left button; select mode does not", async ({ page }) => {
    await bootHost(page);
    const box = await canvasBox(page);
    const start = { x: box.x + 420, y: box.y + 320 };
    const before = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");

    await page.locator('[data-canvas-tool="select"]').click();
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 70, start.y + 40, { steps: 6 });
    await page.mouse.up();
    expect(await hostCall<{ x: number; y: number }>(page, "camera")).toMatchObject({
      x: before.x,
      y: before.y,
    });

    await page.locator('[data-canvas-tool="pan"]').click();
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 70, start.y + 40, { steps: 6 });
    await page.mouse.up();
    const panned = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");
    expect(panned.x).toBeCloseTo(before.x - 70 / before.scale, 1);
    expect(panned.y).toBeCloseTo(before.y - 40 / before.scale, 1);
  });

  test("dice tool rolls through the chat path", async ({ page }) => {
    await bootHost(page);
    await page.locator('[data-canvas-tool="dice"]').click();
    await page.getByLabel("Dice formula").fill("1d20+5");
    await page.getByRole("button", { name: "Roll" }).click();
    await expect(page.locator("#chat-log .rollcard").first()).toContainText("1d20+5");
    await expect(page.locator("#chat-log .rollcard").first()).toContainText(/\d+/);
  });

  test("GM erase-all clears every drawing on the scene", async ({ page }) => {
    await bootHost(page);
    page.on("dialog", (dialog) => void dialog.accept());
    const box = await canvasBox(page);
    await page.locator('[data-canvas-tool="draw"]').click();
    for (const dy of [0, 40]) {
      await page.mouse.move(box.x + 200, box.y + 200 + dy);
      await page.mouse.down();
      await page.mouse.move(box.x + 300, box.y + 240 + dy, { steps: 6 });
      await page.mouse.up();
    }
    await expect.poll(() => hostCall<unknown[]>(page, "drawings")).toHaveLength(2);
    await page.locator('[data-canvas-toolbar] button', { hasText: "Erase drawings" }).click();
    await expect.poll(() => hostCall<unknown[]>(page, "drawings")).toHaveLength(0);
  });
});
