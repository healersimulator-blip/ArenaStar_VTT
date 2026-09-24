import { expect, test } from "@playwright/test";
import { entry, hostCall, manualFragment, playerCall, waitForSurface } from "./lib";

test("a saved FX timeline is host-approved, renders below fog and removes its view after playback", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-name]").fill("Arcane signal");
  await wizard.getByRole("button", { name: "Text", exact: true }).click();
  await wizard.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill("A timed signal");
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li")).toContainText(["Arcane signal"]);
  await wizard.locator("[data-fx-run]").click();
  // Read from the real Pixi stage, not from an editor draft or an FX socket echo.
  const active = () => page.evaluate(() => (
    globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
  ).__stage?.getFxLayer().count ?? 0);
  await expect.poll(active, { timeout: 5_000, intervals: [50, 100, 100] }).toBeGreaterThan(0);
  await expect.poll(active, { timeout: 5_000 }).toBe(0);
});

test("destination, easing and repeat controls survive host save and edit, then play", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-name]").fill("Moving signal");
  await wizard.getByRole("button", { name: "Text", exact: true }).click();
  const section = wizard.locator("[data-fx-section]");
  await section.getByLabel("Text", { exact: true }).fill("Across the map");
  await section.getByLabel("X", { exact: true }).fill("100");
  await section.getByLabel("Y", { exact: true }).fill("100");
  await section.getByLabel("Duration ms").fill("2000");
  await section.getByLabel("Destination").selectOption("point");
  await section.getByLabel("To X").fill("300");
  await section.getByLabel("To Y").fill("200");
  await section.getByLabel("Easing").selectOption("easeInOut");
  await section.getByLabel("Motion cycles").fill("2");
  await section.getByLabel("Layer").selectOption("belowTokens");
  await section.getByLabel("Fade in").fill("100");
  await wizard.locator("[data-fx-save]").click();
  const saved = wizard.locator("li").filter({ hasText: "Moving signal" });
  await expect(saved).toContainText("1 sections");
  await wizard.getByRole("button", { name: "New", exact: true }).click();
  await saved.getByRole("button", { name: "Edit" }).click();
  await expect(section.getByLabel("Destination")).toHaveValue("point");
  await expect(section.getByLabel("To X")).toHaveValue("300");
  await expect(section.getByLabel("To Y")).toHaveValue("200");
  await expect(section.getByLabel("Easing")).toHaveValue("easeInOut");
  await expect(section.getByLabel("Motion cycles")).toHaveValue("2");
  await expect(section.getByLabel("Layer")).toHaveValue("belowTokens");
  await expect(section.getByLabel("Fade in")).toHaveValue("100");
  await wizard.locator("[data-fx-run]").click();
  const active = () => page.evaluate(() => (
    globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
  ).__stage?.getFxLayer().count ?? 0);
  await expect.poll(active, { timeout: 5_000, intervals: [50, 100, 100] }).toBeGreaterThan(0);
  await expect.poll(active, { timeout: 5_000 }).toBe(0);
});

test("media import separates player playback from world-export rights and reapproval", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  expect(await wizard.locator("[data-fx-share]").isChecked()).toBe(false);
  expect(await wizard.locator("[data-fx-export]").isChecked()).toBe(false);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Sq9hX8AAAAASUVORK5CYII=", "base64");
  await wizard.locator('input[type="file"]').setInputFiles({ name: "licensed-effect.png",
    mimeType: "image/png", buffer: png });
  await expect(wizard.getByRole("status")).toContainText("GM-only playback");
  await wizard.locator("[data-fx-rights] summary").click();
  await expect(wizard.locator("[data-fx-rights]")).toContainText("licensed-effect.png");
  expect(await wizard.locator("[data-fx-rights-share]").isChecked()).toBe(false);
  expect(await wizard.locator("[data-fx-rights-export]").isChecked()).toBe(false);
  await page.locator("[data-macro-assets-tab]").click();
  const browser = page.locator("[data-fx-assets]");
  await browser.locator("[data-fx-asset-search]").fill("licensed-effect");
  await expect(browser.locator("[data-fx-asset]")).toHaveCount(1);
  await browser.getByRole("button", { name: "Compare" }).click();
  await expect(browser.locator("[data-fx-preview]")).toHaveCount(1);
  const hash = await browser.locator("[data-fx-asset]").getAttribute("data-fx-asset");
  await browser.getByRole("button", { name: "Use in timeline" }).click();
  await expect(wizard.locator("[data-fx-section]")).toHaveCount(1);
  await expect(wizard.locator("[data-fx-section]").getByRole("combobox", { name: "Media" }))
    .toHaveValue(hash ?? "missing-hash");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  await page.locator("#export-world").click();
  await expect(page.locator(".error")).toContainText("world-export rights");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  await wizard.locator("[data-fx-rights] summary").click();
  await wizard.locator("[data-fx-rights-export]").check();
  await wizard.locator("[data-fx-update-rights]").click();
  await expect(wizard.getByRole("status")).toContainText("Media permissions updated");
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#export-world").click()]);
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
});

test("persistent aura follows the projected token after a real move and a reload", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#add-token").click();
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-name]").fill("Following light");
  await wizard.getByRole("button", { name: "Text", exact: true }).click();
  const section = wizard.locator("[data-fx-section]");
  await section.getByLabel("Text", { exact: true }).fill("Follow me");
  await section.getByLabel("Anchor").selectOption("source");
  await section.locator("[data-fx-follow]").check();
  await wizard.getByRole("combobox", { name: "Source", exact: true }).selectOption({ label: "Token 1" });
  await wizard.locator("[data-fx-persistent]").check();
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li")).toContainText(["Following light"]);
  await wizard.locator("[data-fx-run]").click();
  const visual = () => page.evaluate(() => {
    const stage = (globalThis as unknown as { __stage?: { root: {
      getChildByLabel: (label: string) => { children: Array<{ x: number; y: number; visible: boolean }> } | null;
    } } }).__stage;
    const child = stage?.root.getChildByLabel("fxAboveTokens")?.children[0];
    return child ? { x: child.x, y: child.y, visible: child.visible } : null;
  });
  await expect.poll(visual, { timeout: 5_000 }).toMatchObject({ visible: true });
  const before = await hostCall<{ x: number; y: number }>(page, "tokenPos");
  const initial = await visual();
  expect(Math.abs((initial?.x ?? 0) - (before.x))).toBeLessThan(5);
  await page.locator('[data-window="macros"] [data-window-close]').click();
  await page.locator('[data-canvas-layer="tokens"]').click();
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("Canvas missing");
  const camera = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");
  const from = { x: box.x + (before.x - camera.x) * camera.scale,
    y: box.y + (before.y - camera.y) * camera.scale };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 90, from.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await hostCall<{ x: number; y: number }>(page, "tokenPos")).x)
    .not.toBe(before.x);
  await expect.poll(async () => {
    const pos = await hostCall<{ x: number; y: number }>(page, "tokenPos");
    const fx = await visual();
    return fx?.visible && Math.abs(fx.x - (pos.x)) < 5 && Math.abs(fx.y - (pos.y)) < 5;
  }, { timeout: 5_000 }).toBe(true);
  await page.reload();
  await waitForSurface(page, "app");
  await expect.poll(async () => {
    const pos = await hostCall<{ x: number; y: number }>(page, "tokenPos");
    const fx = await visual();
    return fx?.visible && Math.abs(fx.x - (pos.x)) < 5 && Math.abs(fx.y - (pos.y)) < 5;
  }, { timeout: 10_000 }).toBe(true);
});

// The host's durable instance (not the editor draft) must resurrect the cue
// after a full file:// reload, then stop every local visual without a ghost copy.
test("live FX manager restores a persistent cue after reload and stops it", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-name]").fill("Evergreen ward");
  await wizard.getByRole("button", { name: "Text", exact: true }).click();
  await wizard.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill("Still here");
  await wizard.locator("[data-fx-section]").getByLabel("Duration ms").fill("600");
  await wizard.locator("[data-fx-persistent]").check();
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li")).toContainText(["Evergreen ward"]);
  await wizard.locator("[data-fx-run]").click();
  const active = () => page.evaluate(() => (
    globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
  ).__stage?.getFxLayer().count ?? 0);
  await expect.poll(active, { timeout: 5_000 }).toBe(1);
  await page.waitForTimeout(1300); // past two full loops, not merely a long one-shot
  expect(await active()).toBe(1);
  // A client-rendered cue is not a durable IDB acknowledgement. Explicitly
  // wait for the host oplog append before tearing down its tab.
  expect(await hostCall<number>(page, "drainOps")).toBe(await hostCall<number>(page, "seq"));
  await page.reload();
  await waitForSurface(page, "app");
  await expect.poll(active, { timeout: 10_000 }).toBe(1);
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-manager-tab]").click();
  const manager = page.locator("[data-fx-manager]");
  await expect(manager.locator("[data-fx-instance]")).toHaveCount(1);
  await expect(manager.locator("[data-fx-instance]")).toContainText("Evergreen ward");
  await manager.getByRole("button", { name: "Stop Evergreen ward" }).click();
  await expect(manager.locator("[data-fx-instance]")).toHaveCount(0);
  await expect.poll(active, { timeout: 5_000 }).toBe(0);
  expect(await hostCall<number>(page, "drainOps")).toBe(await hostCall<number>(page, "seq"));
  await page.reload();
  await waitForSurface(page, "app");
  await expect.poll(active, { timeout: 5_000 }).toBe(0);
});

test("GM live FX manager stops a named wildcard batch atomically and undo restores playback", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  const author = async (name: string, text: string, copies: number) => {
    await wizard.locator("[data-fx-name]").fill(name);
    await wizard.getByRole("button", { name: "Text", exact: true }).click();
    await wizard.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill(text);
    await wizard.locator("[data-fx-persistent]").check();
    await wizard.locator("[data-fx-save]").click();
    await expect(wizard.locator("li").filter({ hasText: name })).toHaveCount(1);
    for (let i = 0; i < copies; i++) await wizard.locator("[data-fx-run]").click();
  };
  await author("Ward Loop", "Ward active", 2);
  await wizard.getByRole("button", { name: "New", exact: true }).click();
  await author("Neutral Loop", "Neutral active", 1);
  await page.locator("[data-macro-fx-manager-tab]").click();
  const manager = page.locator("[data-fx-manager]");
  const active = () => page.evaluate(() => (
    globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
  ).__stage?.getFxLayer().count ?? 0);
  await expect(manager.locator("[data-fx-instance]")).toHaveCount(3);
  await expect.poll(active).toBe(3);
  await manager.locator("[data-fx-stop-bulk]").click();
  await expect(manager.getByRole("alert")).toContainText("filter needs a bounded");
  await manager.getByLabel("Stop name pattern").fill("ward*");
  const before = await hostCall<number>(page, "seq");
  await manager.locator("[data-fx-stop-bulk]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(manager.locator("[data-fx-instance]")).toHaveCount(1);
  await expect(manager.locator("[data-fx-instance]")).toContainText("Neutral Loop");
  await expect.poll(active).toBe(1);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect(manager.locator("[data-fx-instance]")).toHaveCount(3);
  await expect.poll(active).toBe(3);
});

// D-293/D-296: the wizard can place anchors by clicking the map — through the
// shared SQ-10 crosshair — and it renders an unsaved draft locally. Neither
// gesture is a host request: the first answers authored data (now with shapes,
// a name and reuse) and the second commits nothing, so both are checked against
// the draft and the host's sequence number, not against a saved macro.
test("wizard places named anchors through the shared crosshair, reuses one, and a cancel changes nothing", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.getByRole("button", { name: "Text", exact: true }).click();
  const section = wizard.locator("[data-fx-section]");
  const x = section.getByLabel("X", { exact: true });
  const y = section.getByLabel("Y", { exact: true });
  await expect(x).toHaveValue("1000"); // the wizard's own default (scene centre)
  await expect(y).toHaveValue("750");

  const camera = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");

  // Point picking: the square grid's 100 px cell means (274, 231) resolves to the
  // centre (250, 250) — a token-style cell centre, not a corner intersection.
  await section.locator('[data-fx-pick="at"]').click();
  const overlay = page.locator("[data-crosshair]");
  await expect(overlay).toBeVisible();
  // The picker maps the cursor against ITS OWN rect (it spans the app, not the
  // canvas element), so the world→screen helper has to do the same thing.
  const overlayBox = await overlay.boundingBox();
  if (!overlayBox) throw new Error("Picker overlay missing");
  const screenOf = (world: { x: number; y: number }) => ({
    x: overlayBox.x + (world.x - camera.x) * camera.scale,
    y: overlayBox.y + (world.y - camera.y) * camera.scale,
  });
  const at = screenOf({ x: 274, y: 231 });
  await page.mouse.move(at.x, at.y);
  await expect(page.locator("[data-crosshair-readout]")).toContainText("250, 250");
  await page.mouse.click(at.x, at.y);
  await expect(overlay).toHaveCount(0);
  await expect(x).toHaveValue("250");
  await expect(y).toHaveValue("250");

  // Cancelling a second gesture is not a half-edit: Esc returns the draft as it was.
  await section.locator('[data-fx-pick="at"]').click();
  await expect(overlay).toBeVisible();
  await page.mouse.move(screenOf({ x: 900, y: 1200 }).x, screenOf({ x: 900, y: 1200 }).y);
  await page.keyboard.press("Escape");
  await expect(overlay).toHaveCount(0);
  await expect(x).toHaveValue("250");
  await expect(y).toHaveValue("250");

  // A committed placement is named and kept: the panel lists it, and the next
  // gesture offers it for reuse instead of making the author re-aim.
  await expect(wizard.locator('[data-fx-placement="Placement 1"]')).toHaveCount(1);
  await section.locator('[data-fx-pick="at"]').click();
  await expect(overlay).toBeVisible();
  await overlay.locator('[data-crosshair-reuse="Placement 1"]').click();
  await expect(page.locator("[data-crosshair-readout]")).toContainText("250, 250");
  await overlay.locator("[data-crosshair-name]").fill("Wizard's mark");
  await page.mouse.move(screenOf({ x: 274, y: 231 }).x, screenOf({ x: 274, y: 231 }).y);
  await overlay.locator("[data-crosshair-commit]").click();
  await expect(overlay).toHaveCount(0);
  await expect(x).toHaveValue("250");
  await expect(y).toHaveValue("250");
  await expect(wizard.locator('[data-fx-placement="Wizard\'s mark"]')).toHaveCount(1);

  // The destination point uses the same crosshair, and a destination is a
  // direction — so it offers the area shapes, draws the area, and writes its own
  // To X / To Y from the *point* (an area is a measurement, never committed).
  await section.getByLabel("Destination").selectOption("point");
  await section.locator('[data-fx-pick="to"]').click();
  await expect(overlay).toBeVisible();
  const to = screenOf({ x: 174, y: 131 });
  await page.mouse.move(to.x, to.y);
  await overlay.locator('[data-crosshair-shape="ray"]').click();
  await overlay.locator("[data-crosshair-width]").fill("2");
  await expect(page.locator("[data-crosshair-area]")).toHaveCount(1); // the area the author is shown
  await expect(page.locator("[data-crosshair-fault]")).toHaveCount(0);
  await page.mouse.click(to.x, to.y);
  await expect(overlay).toHaveCount(0);
  await expect(section.getByLabel("To X")).toHaveValue("150");
  await expect(section.getByLabel("To Y")).toHaveValue("150");
});

test("preview renders the unsaved draft locally, commits nothing and stops on demand", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.getByRole("button", { name: "Text", exact: true }).click();
  const section = wizard.locator("[data-fx-section]");
  await section.getByLabel("Text", { exact: true }).fill("Preview only");
  await section.getByLabel("Duration ms").fill("4000");
  const active = () => page.evaluate(() => (
    globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
  ).__stage?.getFxLayer().count ?? 0);

  const before = await hostCall<number>(page, "seq");
  await wizard.locator("[data-fx-preview]").click();
  await expect.poll(active, { timeout: 5_000 }).toBe(1);
  // A preview is not a save and not a run: no macro, no instance and no new op.
  await expect(wizard.locator("li")).toHaveCount(0);
  expect(await hostCall<number>(page, "seq")).toBe(before);
  expect(await hostCall<number>(page, "drainOps")).toBe(await hostCall<number>(page, "seq"));

  // Stopping ends exactly the local cue the panel started.
  await wizard.locator("[data-fx-preview-stop]").click();
  await expect.poll(active, { timeout: 5_000 }).toBe(0);
  expect(await hostCall<number>(page, "seq")).toBe(before);

  // The saved path is unchanged: the same authored sections now go through the
  // host, which commits and only then cues its recipients.
  await wizard.locator("[data-fx-name]").fill("Previewed later");
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li")).toContainText(["Previewed later"]);
  await wizard.locator("[data-fx-run]").click();
  await expect.poll(active, { timeout: 5_000 }).toBe(1);
  await expect.poll(() => hostCall<number>(page, "seq")).toBeGreaterThan(before);
});

// D-294: a camera cue is a claim on the viewer's OWN view — the host resolves and
// bounds-checks the destination, and each client moves only its own camera. These
// specs read the same `__stage` handle the game uses, so they measure the rendered
// camera, not an editor draft or a socket echo.
type Camera = { x: number; y: number; scale: number };
const stageView = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const stage = (globalThis as unknown as { __stage?: { camera: Camera;
    viewport: { width: number; height: number } } }).__stage;
  if (!stage) return null;
  const { camera, viewport } = stage;
  return { camera, centre: { x: camera.x + viewport.width / (2 * camera.scale),
    y: camera.y + viewport.height / (2 * camera.scale) } };
});
const near = (a: { x: number; y: number } | null | undefined, b: { x: number; y: number }, slack = 2) =>
  !!a && Math.abs(a.x - b.x) < slack && Math.abs(a.y - b.y) < slack;
const sameCamera = (a: Camera | null | undefined, b: Camera | null | undefined) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.scale === b.scale;

/** Author one camera section into a fresh draft and save it under `name`. */
const authorCamera = async (
  page: import("@playwright/test").Page,
  name: string,
  fields: { mode?: "pan" | "shake"; x?: number; y?: number; intensity?: number; ms: number },
) => {
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.getByRole("button", { name: "New", exact: true }).click();
  await wizard.getByRole("button", { name: "Camera", exact: true }).click();
  const section = wizard.locator("[data-fx-section]");
  if (fields.mode === "shake") await section.locator("[data-fx-camera-mode]").selectOption("shake");
  if (fields.x !== undefined) await section.locator("[data-fx-camera-x]").fill(String(fields.x));
  if (fields.y !== undefined) await section.locator("[data-fx-camera-y]").fill(String(fields.y));
  if (fields.intensity !== undefined) await section.locator("[data-fx-camera-intensity]").fill(String(fields.intensity));
  await section.getByLabel("Duration ms").fill(String(fields.ms));
  await wizard.locator("[data-fx-name]").fill(name);
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li")).toContainText([name]);
};

test("a camera pan parks on the host-resolved destination and a real drag takes the view back", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  const gated = { x: 1500, y: 600 };
  const away = { x: 300, y: 1300 };

  // 1. A quick pan ends centred on the destination the host resolved.
  expect(await near((await stageView(page))?.centre, gated)).toBe(false); // the scene opens on a fitted view
  await authorCamera(page, "Look at the gate", { x: gated.x, y: gated.y, ms: 600 });
  const before = await hostCall<number>(page, "seq");
  await wizard.locator("[data-fx-run]").click();
  await expect.poll(async () => near((await stageView(page))?.centre, gated), { timeout: 5_000 }).toBe(true);
  // A camera cue is a view effect: nothing was committed, and Undo has no entry.
  expect(await hostCall<number>(page, "seq")).toBe(before);
  expect(await hostCall<number>(page, "drainOps")).toBe(before);

  // 2. A slow pan; the viewer drags the map mid-flight and the timeline yields.
  await authorCamera(page, "Slow sweep", { x: away.x, y: away.y, ms: 2_000 });
  await wizard.locator("[data-fx-run]").click();
  await expect.poll(async () => {
    const centre = (await stageView(page))?.centre;
    return !!centre && Math.hypot(centre.x - gated.x, centre.y - gated.y) > 40;
  }, { timeout: 5_000 }).toBe(true); // the sweep is really running before we interrupt it
  await page.locator('[data-window="macros"] [data-window-close]').click(); // free the canvas
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("Canvas missing");
  const grab = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const preGrab = (await stageView(page))?.camera ?? null;
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(grab.x + 140, grab.y + 90, { steps: 8 });
  await page.mouse.up({ button: "middle" });
  const held = (await stageView(page))?.camera ?? null;
  // The drag itself moved the view — and *against* the sweep, which is pulling the
  // centre the other way, so this can only be the viewer's own gesture.
  expect(held?.y ?? 0).toBeLessThan((preGrab?.y ?? 0) - 50);
  // Well past the end of the sweep: a cue that ignored the gesture would be parked on
  // the destination by now, and one that kept running would still be moving.
  await page.waitForTimeout(2_400);
  const settled = (await stageView(page))?.camera ?? null;
  expect(await near((await stageView(page))?.centre, away)).toBe(false);
  expect(sameCamera(settled, held)).toBe(true);
});

test("a camera shake returns the view exactly, and a wheel takes the view back with the zoom kept", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");

  // A shake: sample every frame *inside* the page — a shake is a moving target for a
  // poll, and "it moved and then came back exactly" is the whole contract.
  const base = (await stageView(page))?.camera ?? null;
  await authorCamera(page, "Impact tremor", { mode: "shake", intensity: 0.8, ms: 1_200 });
  await wizard.locator("[data-fx-run]").click();
  const peak = await page.evaluate(async () => {
    const stage = (globalThis as unknown as { __stage?: { camera: { x: number; y: number } } }).__stage;
    const start = stage ? { ...stage.camera } : null;
    if (!stage || !start) return 0;
    let worst = 0;
    const until = performance.now() + 1_600;
    while (performance.now() < until) {
      worst = Math.max(worst, Math.hypot(stage.camera.x - start.x, stage.camera.y - start.y));
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    return worst;
  });
  expect(peak).toBeGreaterThan(1); // the shake was visible
  await expect.poll(async () => sameCamera((await stageView(page))?.camera, base), { timeout: 5_000 }).toBe(true);

  // A wheel is a viewer gesture too: the pan yields, and the zoom the wheel applied
  // survives instead of being overwritten by the next cue frame.
  await page.locator('[data-window="macros"] [data-window-close]').click();
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const from = (await stageView(page))?.centre ?? null;
  const destination = { x: 300, y: 1300 };
  await authorCamera(page, "Roll away", { x: destination.x, y: destination.y, ms: 2_000 });
  await wizard.locator("[data-fx-run]").click();
  await expect.poll(async () => {
    const centre = (await stageView(page))?.centre;
    return !!centre && !!from && Math.hypot(centre.x - from.x, centre.y - from.y) > 40;
  }, { timeout: 5_000 }).toBe(true);
  await page.locator('[data-window="macros"] [data-window-close]').click();
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("Canvas missing");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  const zoomed = (await stageView(page))?.camera ?? null;
  expect(zoomed?.scale ?? 0).toBeGreaterThan(base?.scale ?? 0);
  await page.waitForTimeout(2_400); // the timeline is over by now
  const settled = (await stageView(page))?.camera ?? null;
  expect(sameCamera(settled, zoomed)).toBe(true);
  expect(await near((await stageView(page))?.centre, destination)).toBe(false);
});

test("a GM-cued pan animates each viewer's own camera, and only the player's own drag takes theirs back", async ({ browser }) => {
  test.setTimeout(120_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-fx-tab]").click();
    const destination = { x: 1400, y: 500 };
    await authorCamera(host, "Table sweep", { x: destination.x, y: destination.y, ms: 4_000 });

    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");

    /** Each viewer's own stage: the canvas is the viewport, so the centre is camera + half of it. */
    const view = async (page: import("@playwright/test").Page) => {
      // The GM shell publishes `__stage`; the player shell publishes `__canvasStage`.
      const camera = await page.evaluate(() => {
        const g = globalThis as unknown as { __stage?: { camera: Camera };
          __canvasStage?: { camera: Camera } };
        return g.__stage?.camera ?? g.__canvasStage?.camera ?? null;
      });
      const box = await page.locator(".canvas-host canvas").boundingBox();
      if (!camera || !box) return null;
      return { camera, centre: { x: camera.x + box.width / (2 * camera.scale),
        y: camera.y + box.height / (2 * camera.scale) } };
    };
    const before = { host: await view(host), player: await view(player) };
    const moved = (now: Awaited<ReturnType<typeof view>>, base: Awaited<ReturnType<typeof view>>) =>
      !!now && !!base && Math.hypot(now.centre.x - base.centre.x, now.centre.y - base.centre.y) > 40;

    const seqBefore = await hostCall<number>(host, "seq");
    await host.locator("[data-fx-run]").click();
    // One cue, two viewers: each client animates its OWN camera (and no world op).
    await expect.poll(async () => moved(await view(player), before.player), { timeout: 6_000 }).toBe(true);
    await expect.poll(async () => moved(await view(host), before.host), { timeout: 6_000 }).toBe(true);
    expect(await hostCall<number>(host, "seq")).toBe(seqBefore);

    // The player takes their own view back: their camera jumps by the drag's own
    // distance, and then the cue leaves their view alone while the GM's completes.
    const box = await player.locator(".canvas-host canvas").boundingBox();
    if (!box) throw new Error("player canvas not mounted");
    const grab = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const preDrag = await view(player);
    await player.mouse.move(grab.x, grab.y);
    await player.mouse.down({ button: "middle" });
    await player.mouse.move(grab.x + 140, grab.y + 90, { steps: 8 });
    await player.mouse.up({ button: "middle" });
    const afterDrag = await view(player);
    expect(Math.hypot((afterDrag?.camera.x ?? 0) - (preDrag?.camera.x ?? 0),
      (afterDrag?.camera.y ?? 0) - (preDrag?.camera.y ?? 0))).toBeGreaterThan(200);
    // The GM's own cue completes normally (same cue, different viewer)…
    await expect.poll(async () => near((await view(host))?.centre, destination, 4), { timeout: 8_000 }).toBe(true);
    // …while the player's view stayed where their gesture left it and never moved again.
    const playerSettled = await view(player);
    expect(await near(playerSettled?.centre, destination, 4)).toBe(false);
    expect(sameCamera(playerSettled?.camera, afterDrag?.camera)).toBe(true);
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});

// D-295 (SQ-13/A10): what the viewer's own device does with a cue — prefetch ahead,
// tell them when a cue was late, and honour local mute / reduced-motion settings
// without touching anyone else's effects.
test("a viewer's own FX settings mute sound, cut camera motion, and say so once", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  const prefs = page.locator("[data-fx-prefs]");
  await expect(prefs).toBeVisible();

  // Mute FX sound on this device only.
  await prefs.locator("[data-fx-pref-mute-sound]").check();
  await expect(prefs.locator("[data-fx-pref-mute-sound]")).toBeChecked();
  await page.locator('[data-window="settings"] [data-window-close]').click();

  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  // A text section plus a real imported sound: the visual must still play while the
  // sound is skipped, which is the "does not turn off other people's effects" half.
  const wav = Buffer.from(
    "UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=", "base64");
  await wizard.locator('input[type="file"]').setInputFiles({ name: "hush.wav",
    mimeType: "audio/wav", buffer: wav });
  await expect(wizard.getByRole("status")).toContainText("GM-only playback");
  await wizard.locator("[data-fx-name]").fill("Hushed ward");
  await wizard.getByRole("button", { name: "Text", exact: true }).click();
  await wizard.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill("Ward");
  await wizard.getByRole("button", { name: "Sound", exact: true }).click();
  await wizard.locator("[data-fx-section]").nth(1).getByRole("combobox", { name: "Media" })
    .selectOption({ index: 1 });
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li")).toContainText(["Hushed ward"]);
  await wizard.locator("[data-fx-run]").click();
  const active = () => page.evaluate(() => (
    globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
  ).__stage?.getFxLayer().count ?? 0);
  await expect.poll(active, { timeout: 5_000 }).toBeGreaterThan(0); // the text cue rendered
  const notes = page.locator("[data-notify]");
  await expect(notes.filter({ hasText: "muted on this device" })).toHaveCount(1);

  // Reduce motion: a pan cuts to the destination instead of animating across it.
  await page.locator("#gm-settings").click();
  await prefs.locator("[data-fx-pref-reduced-motion]").check();
  await page.locator('[data-window="settings"] [data-window-close]').click();
  const destination = { x: 1_450, y: 550 };
  await authorCamera(page, "Still look", { x: destination.x, y: destination.y, ms: 3_000 });
  await expect(wizard.locator("li")).toContainText(["Still look"]);
  await wizard.locator("[data-fx-run]").click();
  // Within a couple of frames the view is already centred on the destination: no
  // interpolation happened, so the screen never moved through the map.
  await expect.poll(async () => near((await stageView(page))?.centre, destination, 4),
    { timeout: 2_000 }).toBe(true);
  const settled = (await stageView(page))?.camera ?? null;
  await page.waitForTimeout(600); // the pan "duration" has not even elapsed yet
  expect(sameCamera((await stageView(page))?.camera ?? null, settled)).toBe(true);
  await expect(page.locator("[data-notify]").filter({ hasText: "cut by reduced motion" })).toHaveCount(1);
});

test("a GM-audience cue tells the requesting GM it reached fewer viewers than the scene", async ({ browser }) => {
  test.setTimeout(120_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-fx-tab]").click();
    const wizard = host.locator("[data-fx-wizard]");
    await authorCamera(host, "GM only look", { x: 900, y: 400, ms: 300 });
    // Narrow the saved timeline to the GM's own audience.
    await wizard.locator("li").filter({ hasText: "GM only look" }).getByRole("button", { name: "Edit" }).click();
    await wizard.locator("[data-fx-audience]").selectOption("gm");
    await wizard.locator("[data-fx-save]").click();
    await expect(wizard.locator("li")).toContainText(["GM only look"]);

    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");

    await host.locator('[data-window="macros"] [data-window-close]').click();
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-fx-tab]").click();
    await host.locator("[data-fx-wizard] li").filter({ hasText: "GM only look" })
      .getByRole("button", { name: "Run" }).click();
    const notice = host.locator("[data-notify]").filter({ hasText: "GM only look" });
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText("reached 1 viewer(s)");
    await expect(notice).toContainText("outside its audience");
    // The player heard nothing: a GM-only cue names no one and shows nothing there.
    await expect(player.locator("[data-player-notify]")).toHaveCount(0);
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});

// D-297 (SQ-09/SQ-16): a sound belongs to a *channel*, each device mixes its own,
// and this device can stop what it is playing without touching the table.
test("a sound plays on its channel, fades in, and this device can stop and mix it", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  const wav = Buffer.from("UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=", "base64");
  await wizard.locator('input[type="file"]').setInputFiles({ name: "ward-hum.wav",
    mimeType: "audio/wav", buffer: wav });
  await expect(wizard.getByRole("status")).toContainText("GM-only playback");
  await wizard.locator("[data-fx-name]").fill("Ward hum");
  await wizard.getByRole("button", { name: "Sound", exact: true }).click();
  const section = wizard.locator("[data-fx-section]");
  await section.getByRole("combobox", { name: "Media" }).selectOption({ index: 1 });
  await section.getByLabel("Duration ms").fill("6000");
  await section.locator("[data-fx-sound-channel]").selectOption("music");
  await section.locator("[data-fx-sound-fade-in]").fill("500");
  await section.locator("[data-fx-sound-fade-out]").fill("500");
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li")).toContainText(["Ward hum"]);

  // The channel and the fades are document facts: editing the saved timeline again
  // must show them back, or they were never host-approved.
  await wizard.locator("li").filter({ hasText: "Ward hum" }).getByRole("button", { name: "Edit" }).click();
  await expect(wizard.locator("[data-fx-sound-channel]")).toHaveValue("music");
  await expect(wizard.locator("[data-fx-sound-fade-in]")).toHaveValue("500");
  await expect(wizard.locator("[data-fx-sound-fade-out]")).toHaveValue("500");

  const seqBefore = await hostCall<number>(page, "seq");
  await wizard.locator("[data-fx-run]").click();
  await page.locator('[data-window="macros"] [data-window-close]').click();

  // This device's own list, in the Settings window: the world's name for the sound,
  // its channel, and a gain that climbs as the fade-in does.
  await page.locator("#gm-settings").click();
  const prefs = page.locator("[data-fx-prefs]");
  const row = prefs.locator("[data-fx-playing-sound]").first();
  await expect(row).toContainText("ward-hum.wav");
  await expect(row).toContainText("Music");
  const percent = async () => {
    const text = await row.innerText();
    return Number(/(\d+)%/.exec(text)?.[1] ?? -1);
  };
  await expect.poll(percent, { timeout: 3_000 }).toBeGreaterThan(-1);
  const early = await percent(); // the fade-in is still running
  expect(early).toBeLessThan(100);
  // The fade reaches full, and what the device ends up playing is the *author's*
  // volume (the wizard's default 0.8) — the two are multiplied, not confused.
  await expect.poll(percent, { timeout: 4_000 }).toBe(80);
  // Moving this device's own fader reaches the element while it plays: half the
  // channel, half the gain. Nobody else's mix changes.
  await prefs.locator('[data-fx-mix-channel="music"]').fill("0.5");
  await expect.poll(percent, { timeout: 3_000 }).toBe(40);
  await prefs.locator('[data-fx-mix-channel="music"]').fill("1");
  await expect.poll(percent, { timeout: 3_000 }).toBe(80);

  // Stopping here is a *local* stop: the host run is untouched and the row goes away.
  await row.getByRole("button", { name: "Stop here" }).click();
  await expect(prefs.locator("[data-fx-playing-sound]")).toHaveCount(0);
  await expect(prefs.locator("[data-fx-sound-note]")).toContainText("on this device");
  expect(await hostCall<number>(page, "seq")).toBe(seqBefore);

  // Turning this channel's fader to zero means the next cue is not played *or fetched*
  // — and the one-line delivery notice still tells the viewer why.
  await prefs.locator('[data-fx-mix-channel="music"]').fill("0");
  await expect(prefs.locator('[data-fx-mix-value="music"]')).toHaveText("0%");
  await page.locator('[data-window="settings"] [data-window-close]').click();
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  await wizard.locator("li").filter({ hasText: "Ward hum" }).getByRole("button", { name: "Run" }).click();
  await expect(page.locator("[data-notify]").filter({ hasText: "muted on this device" })).toHaveCount(1);
  await page.locator("#gm-settings").click();
  await expect(prefs.locator("[data-fx-playing-sound]")).toHaveCount(0);
  await prefs.locator('[data-fx-mix-channel="music"]').fill("1"); // leave the device as it was
});
