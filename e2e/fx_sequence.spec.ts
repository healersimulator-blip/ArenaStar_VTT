import { expect, test } from "@playwright/test";
import { entry, hostCall, waitForSurface } from "./lib";

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
