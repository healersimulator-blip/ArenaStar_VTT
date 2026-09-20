import { test, expect, type Page } from "@playwright/test";
import { entry, hostCall, manualFragment, playerCall, surfaceCallArg, waitForSurface } from "./lib";

/**
 * D-256 — the rail's Roll20 parity features, driven through the real UI: draw shapes and
 * styles, the in-canvas text editor, measure options, the dice tray, layers, the manual fog
 * mask, wall/light placement, map pins and the zoom/window actions.
 *
 * Every assertion reads back a replicated document or the live camera — never a component's
 * internal state — so a broken wiring (the D-255 class of bug) fails here.
 */

test.setTimeout(120_000);

const canvasBox = async (page: Page) => {
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("canvas not mounted");
  return box;
};

const bootHost = async (page: Page): Promise<void> => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#status").filter({ hasText: "seq" }).waitFor();
  await expect.poll(() => hostCall<unknown>(page, "camera")).not.toBeNull();
};

const pick = (page: Page, selector: string) => page.locator(selector).click();

test.describe("canvas rail — tools (§10, D-256)", () => {
  test("draw shapes: rectangle, Alt-ellipse and a snapped drag land as documents", async ({
    page,
  }) => {
    await bootHost(page);
    const box = await canvasBox(page);
    await pick(page, '[data-canvas-tool="draw"]');
    await expect(page.locator('[data-canvas-shape="freehand"]')).toBeVisible();

    // rectangle
    await pick(page, '[data-canvas-shape="rect"]');
    await page.mouse.move(box.x + 200, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 320, box.y + 260, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => hostCall<Array<{ kind: string }>>(page, "drawings")).toHaveLength(1);

    // Alt turns the same drag into an ellipse
    await page.keyboard.down("Alt");
    await page.mouse.move(box.x + 360, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 440, box.y + 240, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    const docs = await hostCall<
      Array<{ kind: string; box: [number, number, number, number] | null; strokeWidth: number }>
    >(page, "drawings");
    expect(docs.map((d) => d.kind)).toEqual(["rect", "ellipse"]);
    const rect = docs[0];
    expect(rect?.box?.[2]).toBeGreaterThan(100); // ~120 world px wide
    expect(rect?.box?.[3]).toBeGreaterThan(80);

    // Shift snaps the drag to grid intersections (scene grid: 100 px cells)
    await pick(page, '[data-canvas-shape="line"]');
    await page.keyboard.down("Shift");
    await page.mouse.move(box.x + 180, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 420, box.y + 300, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    const withLine = await hostCall<Array<{ kind: string; box: unknown }>>(page, "drawings");
    expect(withLine.map((d) => d.kind)).toEqual(["rect", "ellipse", "line"]);
  });

  test("draw styles: the swatches reach the committed document", async ({ page }) => {
    await bootHost(page);
    const box = await canvasBox(page);
    await pick(page, '[data-canvas-tool="draw"]');
    await pick(page, '[data-canvas-shape="rect"]');
    await page.locator("[data-canvas-stroke]").fill("#00ff00");
    await page.locator("[data-canvas-width]").fill("9");
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 280, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(() => hostCall<Array<{ stroke: string; strokeWidth: number }>>(page, "drawings"))
      .toHaveLength(1);
    const [doc] = await hostCall<Array<{ stroke: string; strokeWidth: number }>>(page, "drawings");
    expect(doc?.stroke).toBe("#00ff00");
    expect(doc?.strokeWidth).toBe(9);
  });

  test("measure options: AoE shape previews the template geometry and X recalls it", async ({
    page,
  }) => {
    await bootHost(page);
    const box = await canvasBox(page);
    await pick(page, '[data-canvas-tool="measure"]');
    await pick(page, '[data-canvas-measure-shape="cone"]');
    await page.mouse.move(box.x + 240, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 340, box.y + 260, { steps: 6 });
    const svg = page.locator("svg.measure-preview");
    await expect(svg).toBeVisible();
    // the cone outline is a polygon in the same overlay the ruler uses
    await expect(svg.locator("polygon")).toBeVisible();
    await page.mouse.up();

    // Escape clears the preview; X brings the last measurement back (Roll20's recall)
    await page.keyboard.press("Escape");
    await expect(svg).toBeHidden();
    await page.keyboard.press("x");
    await expect(svg).toBeVisible();
    // measuring is still read-only
    expect(await hostCall<unknown[]>(page, "drawings")).toHaveLength(0);
  });

  test("the dice tray rolls the chosen dice and mode into chat", async ({ page }) => {
    await bootHost(page);
    await pick(page, '[data-canvas-tool="dice"]');
    await pick(page, '[data-canvas-dice-count="3"]');
    await pick(page, '[data-canvas-roll-mode="gmroll"]');
    await pick(page, '[data-canvas-die="6"]');
    const lines = page.locator("#chat-log .line");
    await expect(lines.last()).toContainText("3d6");
    // Roll20's quick tray keeps the last rolls re-rollable
    await expect(page.locator("[data-canvas-reroll]")).toHaveCount(1);
  });

  test("layers: the map layer does not answer a token drag, the tokens layer does", async ({
    page,
  }) => {
    await bootHost(page);
    await page.click("#add-token");
    await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
    const box = await canvasBox(page);
    const before = await hostCall<{ x: number; y: number } | null>(page, "tokenPos");
    if (!before) throw new Error("no token");
    const camera = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");
    const at = {
      x: box.x + (before.x - camera.x) * camera.scale,
      y: box.y + (before.y - camera.y) * camera.scale,
    };

    await pick(page, '[data-canvas-layer="map"]');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 90, at.y + 60, { steps: 6 });
    await page.mouse.up();
    expect(await hostCall<{ x: number; y: number } | null>(page, "tokenPos")).toEqual(before);

    await pick(page, '[data-canvas-layer="tokens"]');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 90, at.y + 60, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(() => hostCall<{ x: number; y: number } | null>(page, "tokenPos"))
      .not.toEqual(before);
  });

  test("the fog mask records hide/reveal strokes and survives in the scene flag", async ({
    page,
  }) => {
    await bootHost(page);
    await pick(page, '[data-canvas-tool="fog"]');
    await pick(page, '[data-canvas-fog-brush="hide"]');
    await pick(page, '[data-canvas-fog-shape="rect"]');
    const box = await canvasBox(page);
    const camera = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");
    const worldAt = (sx: number, sy: number) => ({
      x: (sx - box.x) / camera.scale + camera.x,
      y: (sy - box.y) / camera.scale + camera.y,
    });
    const inside = worldAt(box.x + 260, box.y + 220);
    await page.mouse.move(box.x + 200, box.y + 160);
    await page.mouse.down();
    await expect(page.locator('[data-shape-preview="fog"]')).toBeVisible();
    await page.mouse.move(box.x + 320, box.y + 280, { steps: 6 });
    await page.mouse.up();

    await expect.poll(() => hostCall<number>(page, "fogMaskStrokes")).toBe(1);
    expect(await surfaceCallArg<boolean>(page, "app", "fogMaskAt", inside)).toBe(true);

    // a reveal stroke over the same area wins (later strokes have priority)
    await pick(page, '[data-canvas-fog-brush="reveal"]');
    await page.mouse.move(box.x + 200, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 320, box.y + 280, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => hostCall<number>(page, "fogMaskStrokes")).toBe(2);
    expect(await surfaceCallArg<boolean>(page, "app", "fogMaskAt", inside)).toBe(false);

    // Hide all covers the whole scene, Reveal all clears the log
    // Hide all covers the whole scene (the probe is the middle of the starter map, 2000×1500)
    const middle = { x: 1000, y: 750 };
    await pick(page, '[data-canvas-action="hide-all"]');
    await expect.poll(() => hostCall<number>(page, "fogMaskStrokes")).toBe(3);
    expect(await surfaceCallArg<boolean>(page, "app", "fogMaskAt", middle)).toBe(true);
    await pick(page, '[data-canvas-action="reveal-all"]');
    await expect.poll(() => hostCall<number>(page, "fogMaskStrokes")).toBe(4);
    expect(await surfaceCallArg<boolean>(page, "app", "fogMaskAt", middle)).toBe(false);

    // the log rides the scene flag, so a reload has to come back with the same cover
    const before = await hostCall<number>(page, "fogMaskStrokes");
    await page.reload();
    await bootHost(page);
    await expect.poll(() => hostCall<number>(page, "fogMaskStrokes")).toBe(before);
    expect(await surfaceCallArg<boolean>(page, "app", "fogMaskAt", inside)).toBe(false);
  });

  test("walls, doors and lights are placed with the configured kind", async ({ page }) => {
    await bootHost(page);
    const box = await canvasBox(page);
    await pick(page, '[data-canvas-tool="wall"]');
    await pick(page, '[data-canvas-wall-kind="wall"]');
    await page.mouse.move(box.x + 180, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 380, box.y + 200, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => hostCall<Array<{ door: number }>>(page, "walls")).toHaveLength(1);
    const [wall] = await hostCall<Array<{ c: [number, number, number, number]; door: number }>>(
      page,
      "walls",
    );
    expect(wall?.door).toBe(0);
    expect(Math.abs((wall?.c[3] ?? 0) - (wall?.c[1] ?? 0))).toBeLessThan(1); // horizontal drag

    await pick(page, '[data-canvas-wall-kind="door"]');
    await page.mouse.move(box.x + 180, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(box.x + 320, box.y + 300, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => hostCall<Array<{ door: number }>>(page, "walls")).toHaveLength(2);
    const doors = await hostCall<Array<{ door: number }>>(page, "walls");
    expect(doors[1]?.door).toBe(1);

    // Erase last removes the door again
    await pick(page, '[data-canvas-action="delete-last-placement"]');
    await expect.poll(() => hostCall<Array<{ door: number }>>(page, "walls")).toHaveLength(1);

    // Lighting: a 2-cell light lands with a radius of two grid cells
    await pick(page, '[data-canvas-tool="light"]');
    const cellSize = (await hostCall<number | null>(page, "gridSize")) ?? 100;
    await pick(page, '[data-canvas-light-radius="2"]');
    await page.mouse.click(box.x + 300, box.y + 260);
    await expect.poll(() => hostCall<Array<{ dim: number }>>(page, "lights")).toHaveLength(1);
    const [light] = await hostCall<Array<{ dim: number; color: string }>>(page, "lights");
    expect(light?.dim).toBe(cellSize * 2);
  });

  test("map pins: hidden by default, visible pins lose their ownership gate", async ({ page }) => {
    await bootHost(page);
    const box = await canvasBox(page);
    await pick(page, '[data-canvas-tool="pin"]');
    await page.mouse.click(box.x + 300, box.y + 220);
    await expect.poll(() => hostCall<unknown[]>(page, "notes")).toHaveLength(1);
    const [hidden] = await hostCall<Array<{ visible: boolean; ownershipDefault: number }>>(
      page,
      "notes",
    );
    expect(hidden?.visible).toBe(false);
    expect(hidden?.ownershipDefault).toBe(0); // NONE — the projection withholds it

    const tooltip = page.locator("[data-pin-tooltip]");
    await expect(tooltip).toBeVisible();
    await page.locator('[data-pin-tooltip] input[aria-label="Pin title"]').fill("Old gate");
    await page.locator('[data-pin-tooltip] input[aria-label="Pin title"]').blur();
    await page.locator('[data-pin-visibility]').click();

    await expect
      .poll(() => hostCall<Array<{ visible: boolean; ownershipDefault: number; text: string }>>(page, "notes"))
      .toEqual([
        expect.objectContaining({ visible: true, ownershipDefault: 1, text: "Old gate" }),
      ]);
  });

  test("view actions: zoom in/out moves the camera, fit restores it, windows open", async ({
    page,
  }) => {
    await bootHost(page);
    const before = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");
    await pick(page, '[data-canvas-action="zoom-in"]');
    await expect
      .poll(async () => (await hostCall<{ scale: number }>(page, "camera")).scale)
      .toBeGreaterThan(before.scale);
    await pick(page, '[data-canvas-action="zoom-out"]');
    await expect
      .poll(async () => (await hostCall<{ scale: number }>(page, "camera")).scale)
      .toBeCloseTo(before.scale, 2);

    await pick(page, '[data-canvas-action="turn-order"]');
    await expect(page.locator('[data-window="turn-order"]')).toBeVisible();
    await page.locator('[data-window="turn-order"] [data-window-close]').click();
    await pick(page, '[data-canvas-action="help"]');
    await expect(page.locator('[data-help-panel]')).toBeVisible();
    await page.locator('[data-window="help"] [data-window-close]').click();
    await pick(page, '[data-canvas-action="settings"]');
    await expect(page.locator('[data-window="settings"]')).toBeVisible();
  });

  test("the rail collapses to icons and keeps the armed sub-tool", async ({ page }) => {
    await bootHost(page);
    await pick(page, '[data-canvas-tool="draw"]');
    await pick(page, '[data-canvas-shape="ellipse"]');
    await page.locator(".canvas-toolbar .collapse").click();
    await expect(page.locator(".canvas-toolbar")).toHaveClass(/collapsed/);
    await expect(page.locator('[data-canvas-shape="ellipse"]')).toBeHidden();
    await page.locator(".canvas-toolbar .collapse").click();
    await expect(page.locator('[data-canvas-shape="ellipse"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

test.describe("canvas rail — player shell (§10, D-256)", () => {
  test("a hidden pin never reaches the player; making it visible publishes it", async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    await bootHost(host);
    await host.locator("#share").click();
    const inviteLink = await host.locator("#invite-link").inputValue();
    const fragment = manualFragment(inviteLink);

    // manual signaling, exactly as e2e/join.spec.ts does it
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await waitForSurface(player, "player");
    await expect
      .poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    const offerCode = await player.locator("#offer-out").inputValue();
    await host.fill("#peer-code", offerCode);
    await host.click("#code-apply");
    await expect
      .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    const answerCode = await host.locator("#share-out").inputValue();
    await player.fill("#answer-input", answerCode);
    await player.click("#answer-apply");
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);

    // GM drops a pin on the board (hidden by default)
    const hostBox = await canvasBox(host);
    await pick(host, '[data-canvas-tool="pin"]');
    await host.mouse.click(hostBox.x + 280, hostBox.y + 200);
    await expect.poll(() => hostCall<unknown[]>(host, "notes")).toHaveLength(1);
    // The fence, in both directions. A hidden pin is projected away (it is not merely
    // hidden in the UI), so the player's replica holds nothing; when the GM toggles it
    // visible the same document arrives; toggling it back hidden *retracts* the replica
    // entry rather than leaving a stale one behind.
    expect(await playerCall<unknown[]>(player, "notes")).toHaveLength(0);

    await host.locator("[data-pin-visibility]").click();
    await host
      .locator('[data-pin-tooltip] input[aria-label="Player-facing note"]')
      .fill("Gate is open");
    await host.locator('[data-pin-tooltip] input[aria-label="Player-facing note"]').blur();
    await expect
      .poll(() => playerCall<Array<{ visible: boolean; playerText: string | null }>>(player, "notes"))
      .toHaveLength(1);
    const [pin] = await playerCall<Array<{ visible: boolean; playerText: string | null }>>(
      player,
      "notes",
    );
    expect(pin?.visible).toBe(true);
    expect(pin?.playerText).toBe("Gate is open");

    await host.locator("[data-pin-visibility]").click();
    await expect.poll(() => playerCall<unknown[]>(player, "notes")).toHaveLength(0);
  });
});
