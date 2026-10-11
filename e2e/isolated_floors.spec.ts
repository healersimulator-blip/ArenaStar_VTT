import { expect, test } from "@playwright/test";
import { entry, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

test("stairs are default: overlapping colored floor maps swap, fog stays separate, fallback is collapsed", async ({ browser }) => {
  test.setTimeout(150000);
  const hc = await browser.newContext(), pc = await browser.newContext();
  const host = await hc.newPage(), player = await pc.newPage();
  try {
    await host.goto(entry + "?e2e=1"); await waitForSurface(host, "app");
    await surfaceCallArg(host, "app", "pf1ePlaceTokens", [{ id: "hero", col: 1, row: 1 }]);
    const colored = (fill: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${fill}"/></svg>`).toString("base64")}`;
    const a = await surfaceCallArg<string>(host, "gm", "seedTile", { name: "Ground RED", x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1, img: colored("#ff0000") });
    const b = await surfaceCallArg<string>(host, "gm", "seedTile", { name: "Upper BLUE", x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1, img: colored("#0000ff") });
    await host.locator('[data-tab="scenes"]').click(); const editor = host.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
    await editor.getByRole("button", { name: "Add draft level", exact: true }).click(); await editor.getByRole("button", { name: "Add draft level", exact: true }).click();
    const rows = editor.locator("[data-level-id]");
    await rows.nth(0).getByLabel(`Floor map tile ${a}`, { exact: true }).check(); await rows.nth(1).getByLabel(`Floor map tile ${b}`, { exact: true }).check();
    await rows.nth(1).getByLabel("Inherit scene ambient lighting", { exact: true }).uncheck(); await rows.nth(1).getByLabel("Level ambient darkness", { exact: true }).fill("1");
    await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status")).toContainText("Draft saved");
    const base = await rows.nth(0).getAttribute("data-level-id"), upper = await rows.nth(1).getAttribute("data-level-id"); if (!base || !upper) throw new Error("levels missing");
    const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
    await bindings.getByLabel("Membership object", { exact: true }).selectOption("hero"); await bindings.getByLabel("Token destination level", { exact: true }).selectOption(base);
    await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");
    const play = editor.locator("[data-level-play]"); await play.locator(":scope > summary").click();
    // D-430: one stairwell region serves both directions (no separate return region).
    await play.getByLabel("Stairwell floor Base", { exact: true }).check(); await play.getByLabel("Stairwell floor Level 2", { exact: true }).check();
    await play.getByLabel("Stairs X", { exact: true }).fill("300"); await play.getByLabel("Stairs Y", { exact: true }).fill("100");
    await play.getByLabel("Stairs width", { exact: true }).fill("100"); await play.getByLabel("Stairs height", { exact: true }).fill("100");
    await play.getByRole("button", { name: "Create stairwell", exact: true }).click(); await expect(play.locator("[data-stair-region]")).toHaveCount(1);
    // D-433: activation runs the floor-play check; acknowledged warnings still enable it.
    await play.getByLabel("Enable isolated floor play", { exact: true }).click();
    const preflight = play.locator("[data-level-preflight]");
    await expect(preflight.or(play.getByRole("status").filter({ hasText: "enabled" }))).toBeVisible();
    if (await preflight.isVisible()) await preflight.getByRole("button", { name: "Enable anyway", exact: true }).click();
    await expect(play.getByRole("status")).toContainText("enabled");
    await host.click("#gm-settings"); const settings = host.locator('[data-window="settings"]');
    await settings.locator("[data-scene-fog-range]").fill("3"); await settings.locator("[data-scene-fog-range]").press("Enter"); await settings.locator("[data-scene-fog]").check(); await settings.locator("[data-window-close]").click();
    await host.click("#share"); const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20000 }).not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue()); await host.click("#code-apply");
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20000 }).not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue()); await player.click("#answer-apply"); await waitForSurface(player, "playerCanvas");
    const floor = () => surfaceCall<{ levelId: string; mode: string; tileIds: string[]; darkness: number }>(player, "playerCanvas", "floorPresentation");
    const fog = () => surfaceCall<{ explored: number; restored: boolean }>(player, "playerCanvas", "fogState");
    const pixel = () => surfaceCallArg<number[]>(player, "playerCanvas", "floorMapPixel", { x: 500, y: 500 });
    await expect.poll(async () => (await floor()).levelId).toBe(base); await expect.poll(pixel).toEqual([255,0,0,255]);
    await expect.poll(async () => (await fog()).explored).toBeGreaterThan(0);
    await expect(player.getByLabel("Player floor focus", { exact: true })).not.toBeVisible();
    // Actual player drag into the stairs, not a selector or a GM teleport.
    const canvas = player.locator(".canvas-host canvas"); const rect = await canvas.boundingBox(); if (!rect) throw new Error("canvas");
    // Existing camera hook gives exact coordinates for the live viewport.
    const camera = await surfaceCall<{ x: number; y: number; scale: number }>(player, "player", "camera");
    await player.mouse.move(rect.x + (150 - camera.x) * camera.scale, rect.y + (150 - camera.y) * camera.scale);
    await player.mouse.down(); await player.mouse.move(rect.x + (350 - camera.x) * camera.scale, rect.y + (150 - camera.y) * camera.scale, { steps: 10 }); await player.mouse.up();
    await expect.poll(async () => (await floor()).levelId).toBe(upper); await expect.poll(pixel).toEqual([0,0,255,255]);
    expect((await floor()).mode).toBe("follow"); expect((await floor()).tileIds).toEqual([b]); expect((await floor()).darkness).toBe(1);
    await expect.poll(async () => (await fog()).restored).toBe(true); expect((await fog()).explored).toBe(0);
    // Leave and re-enter the return region using normal host moves: no bouncing while inside.
    await surfaceCallArg(host, "app", "pf1eMoveToken", { tokenId: "hero", col: 4, row: 1 });
    await surfaceCallArg(host, "app", "pf1eMoveToken", { tokenId: "hero", col: 3, row: 1 });
    await expect.poll(async () => (await floor()).levelId).toBe(base); await expect.poll(pixel).toEqual([255,0,0,255]); await expect.poll(async () => (await fog()).explored).toBeGreaterThan(0);
  } finally { await pc.close(); await hc.close(); }
});
