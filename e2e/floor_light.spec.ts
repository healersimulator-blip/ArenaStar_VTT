import { expect, test } from "@playwright/test";
import type { CrossFloorLightingState, CrossFloorLightingView, LightView } from "../src/canvas/layers/LightingLayer";
import type { Stage } from "../src/canvas/stage";
import type { LevelSurface } from "../src/core/documents";
import { traceSurface } from "../src/core/floorSurface";
import { entry, gmCall, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

/** A 1000 px floor with a stairwell at 400–600. */
const well = traceSurface((x, y) => x < 1000 && y < 1000 && !(x >= 400 && x < 600 && y >= 400 && y < 600), { x: 0, y: 0, width: 1000, height: 1000 }, { cell: 50 }).surface as LevelSurface;

/**
 * G-22 (D-446): real pixels. Over a white map, a pitch-dark floor shows the lit floor below only
 * inside its stairwell; a lamp down there glows inside the well and nowhere on the solid floor
 * around it, though the same lamp on this floor reaches there. Both renderers clip the masks.
 */
test("light from the floor below shows through the openings only, in real pixels on either renderer", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  const result = await page.evaluate((solid) => {
    const stage = (globalThis as unknown as { __stage: Stage }).__stage;
    stage.app.ticker.stop();
    const layer = stage.getLightingLayer(), holder = layer.container.parent;
    if (!holder) throw new Error("lighting holder");
    const darkness = layer.container.getChildByLabel("darkness");
    if (!darkness) throw new Error("darkness");
    // A white map under the lighting (Graphics, borrowed from the darkness layer's own class).
    const white = new (darkness.constructor as new () => typeof darkness & { rect(x: number, y: number, w: number, h: number): { fill(style: { color: number }): void } })();
    white.rect(0, 0, 1000, 1000).fill({ color: 0xffffff });
    holder.addChildAt(white, 0);
    const frame = holder.getLocalBounds().rectangle.clone();
    frame.x = 0; frame.y = 0; frame.width = 1000; frame.height = 1000;
    const at = (x: number, y: number): number => {
      stage.render();
      const { pixels, width } = stage.app.renderer.extract.pixels({ target: holder, frame, resolution: 1 });
      const i = (y * width + x) * 4;
      return Math.round(((pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0)) / 3);
    };
    const camera = { x: 0, y: 0, scale: 1 }, viewport = { width: 1000, height: 1000 };
    const night = { darkness: 1, color: "#000000" };
    const lamp: LightView = { light: { _id: "lamp", x: 500, y: 500, dim: 300, bright: 300, color: "#ffffff", alpha: 1 }, poly: null };
    // The floor below is lit (darkness 0); this one is pitch dark.
    const lit: CrossFloorLightingView = { solid, belowDarkness: 0, groups: [] };
    layer.sync([], night, camera, viewport, lit);
    const ambient = { opening: at(500, 500), solid: at(300, 500), outside: at(990, 990) };
    // Both floors dark; the lamp is downstairs.
    const lamped: CrossFloorLightingView = { solid, belowDarkness: 1, groups: [{ key: "below:ground", masks: [solid], views: [lamp] }] };
    layer.sync([], night, camera, viewport, lamped);
    const below = { opening: at(450, 450), solid: at(300, 500), state: layer.crossFloorState() };
    // The same lamp on this floor reaches the solid floor around the well.
    layer.sync([lamp], night, camera, viewport, null);
    const here = { solid: at(300, 500) };
    layer.sync([], { darkness: 0, color: "#000000" }, camera, viewport, null);
    white.destroy();
    return { renderer: stage.rendererName, ambient, below, here };
  }, well);
  expect(result.ambient.opening).toBeGreaterThan(240);
  expect(result.ambient.solid).toBeLessThan(15);
  expect(result.below.opening).toBeGreaterThan(200);
  expect(result.below.solid).toBeLessThan(15);
  expect(result.here.solid).toBeGreaterThan(200);
  expect(result.below.state).toEqual({ split: true, belowDarkness: 1, groups: [{ key: "below:ground", masks: 1, lights: ["lamp"] }] });
  expect(["webgl", "webgpu", "canvas"]).toContain(result.renderer);
});

/**
 * G-22 (D-446): the journey. A dark keep: Floor 2 has a traced stairwell over the dark ground,
 * where a lamp burns. The GM's isolated view of Floor 2 and the player standing there both get
 * the ground's darkness and its lamp inside the well; from the ground, a lamp upstairs falls
 * through the well. Making Floor 2 solid again closes it all.
 */
test("players on a floor with a stairwell get the lower floor's lamp and darkness inside it; the floor above's lamp falls through", async ({ browser }) => {
  test.setTimeout(150_000);
  const hc = await browser.newContext(), pc = await browser.newContext();
  const host = await hc.newPage(), player = await pc.newPage();
  try {
    await host.goto(entry + "?e2e=1"); await waitForSurface(host, "app");
    await surfaceCallArg(host, "app", "pf1ePlaceTokens", [{ id: "hero", col: 3, row: 5 }]);
    const svg = (body: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${body}</svg>`).toString("base64")}`;
    const red = await surfaceCallArg<string>(host, "gm", "seedTile", { name: "Ground RED", x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1,
      img: svg('<rect width="100" height="100" fill="#ff0000"/>') });
    const blue = await surfaceCallArg<string>(host, "gm", "seedTile", { name: "Upper BLUE", x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1,
      img: svg('<path fill="#0000ff" fill-rule="evenodd" d="M0 0H100V100H0Z M40 40V60H60V40Z"/>') });
    await host.locator('[data-tab="scenes"]').click();
    const editor = host.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
    const generator = editor.locator("[data-level-generator]");
    await generator.getByLabel("Generated floors", { exact: true }).fill("2");
    await generator.getByRole("button", { name: "Generate levels", exact: true }).click();
    const rows = editor.locator("[data-level-id]"); await expect(rows).toHaveCount(2);
    await rows.nth(0).getByLabel(`Floor map tile ${red}`, { exact: true }).check(); await rows.nth(1).getByLabel(`Floor map tile ${blue}`, { exact: true }).check();
    await editor.locator("[data-level-visibility-presets]").getByRole("button", { name: "Down to ground", exact: true }).click();
    for (const i of [0, 1]) {
      await rows.nth(i).getByLabel("Inherit scene ambient lighting", { exact: true }).uncheck();
      await rows.nth(i).getByLabel("Level ambient darkness", { exact: true }).fill("1");
    }
    const surface = rows.nth(1).locator("[data-level-surface]");
    await surface.getByRole("button", { name: "Trace from floor art", exact: true }).click();
    await expect(surface.locator("[data-surface-status]")).toHaveText("1 solid area · 1 opening");
    const apply = editor.getByRole("button", { name: "Apply draft levels", exact: true });
    await apply.click(); await expect(editor.getByRole("status").first()).toContainText("Draft saved");
    const ground = await rows.nth(0).getAttribute("data-level-id"), upper = await rows.nth(1).getAttribute("data-level-id");
    if (!ground || !upper) throw new Error("levels missing");
    const groundLamp = await surfaceCallArg<string>(host, "gm", "seedLight", { x: 500, y: 500, dim: 300, levelId: ground });
    const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
    await bindings.getByLabel("Membership object", { exact: true }).selectOption("hero"); await bindings.getByLabel("Token destination level", { exact: true }).selectOption(upper);
    await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");

    // The GM's isolated view of Floor 2: the ground's darkness and lamp inside the well.
    const gmLighting = () => gmCall<CrossFloorLightingState>(host, "crossFloorLighting");
    const throughWell: CrossFloorLightingState = { split: true, belowDarkness: 1, groups: [{ key: `below:${ground}`, masks: 1, lights: [groundLamp] }] };
    const floorView = host.locator("[data-gm-floor-view]");
    await floorView.getByLabel("GM level perception preview", { exact: true }).selectOption(upper);
    await floorView.getByLabel("GM floor display", { exact: true }).selectOption("only");
    await expect.poll(gmLighting).toEqual(throughWell);
    // From the ground, a lamp upstairs falls through the well (the ground has no openings of its own).
    const upperLamp = await surfaceCallArg<string>(host, "gm", "seedLight", { x: 500, y: 300, dim: 400, levelId: upper });
    await floorView.getByLabel("GM level perception preview", { exact: true }).selectOption(ground);
    await expect.poll(gmLighting).toEqual({ split: false, belowDarkness: null, groups: [{ key: `above:${upper}`, masks: 1, lights: [upperLamp] }] });
    await floorView.getByLabel("GM floor display", { exact: true }).selectOption("ghost");
    await expect.poll(gmLighting).toEqual({ split: false, belowDarkness: null, groups: [] });

    const play = editor.locator("[data-level-play]"); await play.locator(":scope > summary").click();
    await play.getByLabel("Enable isolated floor play", { exact: true }).click();
    const preflight = play.locator("[data-level-preflight]");
    await expect(preflight.or(play.getByRole("status").filter({ hasText: "enabled" }))).toBeVisible();
    if (await preflight.isVisible()) await preflight.getByRole("button", { name: "Enable anyway", exact: true }).click();
    await expect(play.getByRole("status")).toContainText("enabled");

    await host.click("#share"); const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20000 }).not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue()); await host.click("#code-apply");
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20000 }).not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue()); await player.click("#answer-apply"); await waitForSurface(player, "playerCanvas");
    const floor = () => surfaceCall<{ levelId: string | null }>(player, "playerCanvas", "floorPresentation");
    const lighting = () => surfaceCall<CrossFloorLightingState>(player, "playerCanvas", "crossFloorLighting");
    await expect.poll(async () => (await floor()).levelId).toBe(upper);
    // The player holds neither levels nor surfaces: the presentation brings the well and the lamp's floor.
    await expect.poll(lighting).toEqual(throughWell);

    // Solid again: nothing crosses.
    await surface.getByRole("button", { name: "Solid everywhere", exact: true }).click();
    await expect(surface.locator("[data-surface-status]")).toHaveText("Solid everywhere");
    await apply.click(); await expect(editor.getByRole("status").first()).toContainText("Draft saved");
    await expect.poll(lighting).toEqual({ split: false, belowDarkness: null, groups: [] });
  } finally { await pc.close(); await hc.close(); }
});
