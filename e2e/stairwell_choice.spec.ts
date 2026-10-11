import { expect, test } from "@playwright/test";
import { entry, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

test("one stairwell serves three floors: the player picks up or down, takes the stairs again while standing, and locked stairs explain themselves", async ({ browser }) => {
  test.setTimeout(180000);
  const hc = await browser.newContext(), pc = await browser.newContext();
  const host = await hc.newPage(), player = await pc.newPage();
  try {
    await host.goto(entry + "?e2e=1"); await waitForSurface(host, "app");
    await surfaceCallArg(host, "app", "pf1ePlaceTokens", [{ id: "hero", col: 1, row: 1 }]);
    const colored = (fill: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${fill}"/></svg>`).toString("base64")}`;
    const tile = (name: string, fill: string) => surfaceCallArg<string>(host, "gm", "seedTile", { name, x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1, img: colored(fill) });
    const red = await tile("Ground RED", "#ff0000"), blue = await tile("Middle BLUE", "#0000ff"), green = await tile("Top GREEN", "#00ff00");
    await host.locator('[data-tab="scenes"]').click(); const editor = host.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
    for (let i = 0; i < 3; i++) await editor.getByRole("button", { name: "Add draft level", exact: true }).click();
    const rows = editor.locator("[data-level-id]");
    for (const [i, id] of [red, blue, green].entries()) await rows.nth(i).getByLabel(`Floor map tile ${id}`, { exact: true }).check();
    await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status")).toContainText("Draft saved");
    const [base, middle, top] = await Promise.all([0, 1, 2].map((i) => rows.nth(i).getAttribute("data-level-id")));
    if (!base || !middle || !top) throw new Error("levels missing");
    const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
    await bindings.getByLabel("Membership object", { exact: true }).selectOption("hero"); await bindings.getByLabel("Token destination level", { exact: true }).selectOption(middle);
    await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");
    const play = editor.locator("[data-level-play]"); await play.locator(":scope > summary").click();
    for (const name of ["Base", "Level 2", "Level 3"]) await play.getByLabel(`Stairwell floor ${name}`, { exact: true }).check();
    await play.getByLabel("Stair label", { exact: true }).fill("Spiral stair");
    await play.getByLabel("Stairs X", { exact: true }).fill("300"); await play.getByLabel("Stairs Y", { exact: true }).fill("100");
    await play.getByLabel("Stairs width", { exact: true }).fill("100"); await play.getByLabel("Stairs height", { exact: true }).fill("100");
    await play.getByRole("button", { name: "Create stairwell", exact: true }).click(); await expect(play.locator("[data-stair-region]")).toHaveCount(1);
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
    const floor = () => surfaceCall<{ levelId: string }>(player, "playerCanvas", "floorPresentation");
    const pixel = () => surfaceCallArg<number[]>(player, "playerCanvas", "floorMapPixel", { x: 500, y: 500 });
    await expect.poll(async () => (await floor()).levelId).toBe(middle); await expect.poll(pixel).toEqual([0, 0, 255, 255]);
    await expect.poll(() => surfaceCall<string[]>(player, "playerCanvas", "stairMarkers")).toHaveLength(1); // G-10: the stairwell is marked
    const canvas = player.locator(".canvas-host canvas"); const rect = await canvas.boundingBox(); if (!rect) throw new Error("canvas");
    const drag = async (fromX: number, toX: number) => {
      const camera = await surfaceCall<{ x: number; y: number; scale: number }>(player, "player", "camera");
      await player.mouse.move(rect.x + (fromX - camera.x) * camera.scale, rect.y + (150 - camera.y) * camera.scale);
      await player.mouse.down(); await player.mouse.move(rect.x + (toX - camera.x) * camera.scale, rect.y + (150 - camera.y) * camera.scale, { steps: 10 }); await player.mouse.up();
    };
    // Walk into the stairwell on the middle floor: the player is asked, up first.
    await drag(150, 350);
    const chooser = player.locator("[data-stair-chooser]"); await expect(chooser).toBeVisible();
    await expect(chooser).toContainText("Spiral stair");
    await expect(chooser.locator("[data-stair-choice]")).toHaveCount(2);
    expect(await chooser.locator("[data-stair-choice]").nth(0).getAttribute("data-stair-choice")).toBe(top);
    await chooser.locator(`[data-stair-choice="${base}"]`).click();
    await expect.poll(async () => (await floor()).levelId).toBe(base); await expect.poll(pixel).toEqual([255, 0, 0, 255]);
    await expect(player.locator("[data-player-floor-notice]").last()).toContainText("You arrive on Base");
    // Standing on the stairs: "Take stairs" asks again (G-08); Escape stays put.
    const take = player.locator("[data-take-stairs]"); await expect(take).toBeVisible(); await take.click();
    await expect(chooser.locator("[data-stair-choice]")).toHaveCount(2);
    await player.keyboard.press("Escape"); await expect(chooser).toBeHidden();
    expect((await floor()).levelId).toBe(base);
    await take.click(); await expect(chooser).toBeVisible();
    await player.keyboard.press("1"); // the highest floor is listed first
    await expect.poll(async () => (await floor()).levelId).toBe(top); await expect.poll(pixel).toEqual([0, 255, 0, 255]);
    // The GM locks the stairwell: walking in again is explained, not silently ignored (G-11/G-02).
    await play.getByRole("button", { name: "Lock stairs Spiral stair", exact: true }).click();
    await expect(play.locator("[data-stair-region]")).toContainText("locked");
    await surfaceCallArg(host, "app", "pf1eMoveToken", { tokenId: "hero", col: 5, row: 1 });
    await expect.poll(async () => (await surfaceCall<{ x: number } | null>(player, "player", "tokenPos"))?.x).toBe(550);
    await drag(550, 350);
    await expect(player.locator("[data-player-move-refused]").last()).toContainText("These stairs are locked.");
    expect((await floor()).levelId).toBe(top);
  } finally { await pc.close(); await hc.close(); }
});
