import { expect, test } from "@playwright/test";
import { entry, gmCall, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

/**
 * G-20 (D-445): from the edge of a traced stairwell, the player's hero sees the goblin standing
 * in the well on the floor below, drawn dimmed beneath the floor's art. The goblin under the
 * solid floor stays unseen. The GM's isolated view shows both. Stepping away from the edge loses
 * sight of the goblin.
 */
test("a player sees a token on the floor below through a traced opening, and only through it", async ({ browser }) => {
  test.setTimeout(150_000);
  const hc = await browser.newContext(), pc = await browser.newContext();
  const host = await hc.newPage(), player = await pc.newPage();
  type Lower = { tiles: Array<{ id: string; depth: number }>; backgroundDepth: number | null; tokens: Array<{ id: string; depth: number }> };
  try {
    await host.goto(entry + "?e2e=1"); await waitForSurface(host, "app");
    // The hero at the stairwell's edge (350, 550); goblins in the well (550, 550) and under the floor (850, 850).
    await surfaceCallArg(host, "app", "pf1ePlaceTokens", [{ id: "hero", col: 3, row: 5 }, { id: "goblinWell", col: 5, row: 5, owner: "gm" }, { id: "goblinFar", col: 8, row: 8, owner: "gm" }]);
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
    // G-21: Floor 2's solid floor comes from its art, stairwell included.
    const surface = rows.nth(1).locator("[data-level-surface]");
    await surface.getByRole("button", { name: "Trace from floor art", exact: true }).click();
    await expect(surface.locator("[data-surface-status]")).toHaveText("1 solid area · 1 opening");
    await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status").first()).toContainText("Draft saved");
    const ground = await rows.nth(0).getAttribute("data-level-id"), upper = await rows.nth(1).getAttribute("data-level-id");
    if (!ground || !upper) throw new Error("levels missing");
    const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
    for (const [id, level] of [["hero", upper], ["goblinWell", ground], ["goblinFar", ground]] as const) {
      await bindings.getByLabel("Membership object", { exact: true }).selectOption(id); await bindings.getByLabel("Token destination level", { exact: true }).selectOption(level);
      await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");
    }

    // The GM's isolated view of Floor 2: every token down there, beneath the art.
    const floorView = host.locator("[data-gm-floor-view]");
    await floorView.getByLabel("GM level perception preview", { exact: true }).selectOption(upper);
    await floorView.getByLabel("GM floor display", { exact: true }).selectOption("only");
    await expect.poll(async () => (await gmCall<Lower>(host, "lowerFloors")).tokens).toEqual([{ id: "goblinFar", depth: 1 }, { id: "goblinWell", depth: 1 }]);

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
    const lower = () => surfaceCall<Lower>(player, "playerCanvas", "lowerFloors");
    const pixel = (x: number, y: number) => surfaceCallArg<number[]>(player, "playerCanvas", "floorMapPixel", { x, y });
    await expect.poll(async () => (await floor()).levelId).toBe(upper);
    // Only the goblin in the well is in the hero's sight, and it is drawn dimmed in the opening.
    await expect.poll(async () => (await lower()).tokens).toEqual([{ id: "goblinWell", depth: 1 }]);
    await expect.poll(async () => { const [r = 0, g = 0, b = 0] = await pixel(550, 550); return Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r > 120 && r < 210; }).toBe(true);
    await expect.poll(() => pixel(850, 850)).toEqual([0, 0, 255, 255]);
    // Away from the edge, the angle through the well no longer reaches the goblin.
    await surfaceCallArg(host, "app", "pf1eMoveToken", { tokenId: "hero", col: 1, row: 8 });
    await expect.poll(async () => (await lower()).tokens).toEqual([]);
    await expect.poll(async () => { const [r = 0, g = 0, b = 0] = await pixel(550, 550); return r > 120 && g < 30 && b < 30; }).toBe(true); // just the ground's dimmed red again
  } finally { await pc.close(); await hc.close(); }
});
