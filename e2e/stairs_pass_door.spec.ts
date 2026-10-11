import { expect, test } from "@playwright/test";
import { entry, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

/** G-09 + G-11 (D-437): a pass-through trapdoor that only works while its door is open. */
test("a pass-through stairwell linked to a door: walked over while the door is shut, travelled through with the route continuing once it opens", async ({ browser }) => {
  test.setTimeout(180000);
  const hc = await browser.newContext(), pc = await browser.newContext();
  const host = await hc.newPage(), player = await pc.newPage();
  try {
    await host.goto(entry + "?e2e=1"); await waitForSurface(host, "app");
    await surfaceCallArg(host, "app", "pf1ePlaceTokens", [{ id: "hero", col: 1, row: 1 }]);
    const colored = (fill: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${fill}"/></svg>`).toString("base64")}`;
    const tile = (name: string, fill: string) => surfaceCallArg<string>(host, "gm", "seedTile", { name, x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1, img: colored(fill) });
    const red = await tile("Ground RED", "#ff0000"), blue = await tile("Upper BLUE", "#0000ff");
    await host.locator('[data-tab="scenes"]').click(); const editor = host.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
    for (let i = 0; i < 2; i++) await editor.getByRole("button", { name: "Add draft level", exact: true }).click();
    const rows = editor.locator("[data-level-id]");
    for (const [i, id] of [red, blue].entries()) await rows.nth(i).getByLabel(`Floor map tile ${id}`, { exact: true }).check();
    await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status")).toContainText("Draft saved");
    const [base, upper] = await Promise.all([0, 1].map((i) => rows.nth(i).getAttribute("data-level-id")));
    if (!base || !upper) throw new Error("levels missing");
    // A floor scope needs the level collection first (seeded after the draft is applied).
    const gate = await surfaceCallArg<string>(host, "gm", "seedWall", { c: [600, 300, 700, 300], door: 0, everyFloor: true });
    const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
    await bindings.getByLabel("Membership object", { exact: true }).selectOption("hero"); await bindings.getByLabel("Token destination level", { exact: true }).selectOption(base);
    await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");
    const play = editor.locator("[data-level-play]"); await play.locator(":scope > summary").click();
    for (const name of ["Base", "Level 2"]) await play.getByLabel(`Stairwell floor ${name}`, { exact: true }).check();
    await play.getByLabel("Stair label", { exact: true }).fill("Trapdoor");
    await play.getByLabel("Stair trigger on pass-through", { exact: true }).check();
    await play.getByLabel("Stair door", { exact: true }).selectOption(gate);
    await play.getByLabel("Stairs X", { exact: true }).fill("300"); await play.getByLabel("Stairs Y", { exact: true }).fill("100");
    await play.getByLabel("Stairs width", { exact: true }).fill("100"); await play.getByLabel("Stairs height", { exact: true }).fill("100");
    await play.getByRole("button", { name: "Create stairwell", exact: true }).click();
    const row = play.locator("[data-stair-region]"); await expect(row).toHaveCount(1);
    await expect(row).toContainText("pass-through"); await expect(row).toContainText("door closed");
    await expect(play.locator('[data-audit-code="stairs-locked"]')).toContainText("until their door opens");
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
    const heroX = async () => (await surfaceCall<{ x: number } | null>(player, "player", "tokenPos"))?.x;
    await expect.poll(async () => (await floor()).levelId).toBe(base); await expect.poll(pixel).toEqual([255, 0, 0, 255]);
    const canvas = player.locator(".canvas-host canvas"); const rect = await canvas.boundingBox(); if (!rect) throw new Error("canvas");
    const drag = async (fromX: number, toX: number) => {
      const camera = await surfaceCall<{ x: number; y: number; scale: number }>(player, "player", "camera");
      await player.mouse.move(rect.x + (fromX - camera.x) * camera.scale, rect.y + (150 - camera.y) * camera.scale);
      await player.mouse.down(); await player.mouse.move(rect.x + (toX - camera.x) * camera.scale, rect.y + (150 - camera.y) * camera.scale, { steps: 10 }); await player.mouse.up();
    };
    // Door shut: the trapdoor is ordinary floor. The move crosses it without stopping or a notice.
    await drag(150, 550);
    await expect.poll(heroX).toBe(550);
    expect((await floor()).levelId).toBe(base);
    await expect(player.locator("[data-player-move-refused]")).toHaveCount(0);
    // The GM opens the door: crossing again changes floor at the trapdoor and the route continues upstairs.
    await surfaceCallArg(host, "gm", "setDoorState", { id: gate, door: 1 });
    await expect(row).toContainText("door open");
    await drag(550, 150);
    await expect.poll(async () => (await floor()).levelId).toBe(upper); await expect.poll(pixel).toEqual([0, 0, 255, 255]);
    await expect.poll(heroX).toBe(150);
    await expect(player.locator("[data-player-floor-notice]").last()).toContainText("You arrive on Level 2");
  } finally { await pc.close(); await hc.close(); }
});
