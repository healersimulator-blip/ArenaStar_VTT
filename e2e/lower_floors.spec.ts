import { expect, test } from "@playwright/test";
import { entry, gmCall, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

/**
 * G-19 (D-443): a floor that "sees" the floor below shows that floor's art, dimmed, through the
 * transparent parts of its own art — for the player standing on it and in the GM's isolated view.
 * Turning it off seals the floor again.
 */
test("the upper floor shows the ground floor's art through its opening, dimmed, until the GM seals it", async ({ browser }) => {
  test.setTimeout(150_000);
  const hc = await browser.newContext(), pc = await browser.newContext();
  const host = await hc.newPage(), player = await pc.newPage();
  try {
    await host.goto(entry + "?e2e=1"); await waitForSurface(host, "app");
    await surfaceCallArg(host, "app", "pf1ePlaceTokens", [{ id: "hero", col: 1, row: 1 }]);
    const svg = (body: string) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${body}</svg>`).toString("base64")}`;
    const red = await surfaceCallArg<string>(host, "gm", "seedTile", { name: "Ground RED", x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1,
      img: svg('<rect width="100" height="100" fill="#ff0000"/>') });
    // The upper floor is blue with a transparent square opening in the middle (40–60).
    const blue = await surfaceCallArg<string>(host, "gm", "seedTile", { name: "Upper BLUE", x: 0, y: 0, width: 1000, height: 1000, above: false, mode: "fade", alpha: 1,
      img: svg('<path fill="#0000ff" fill-rule="evenodd" d="M0 0H100V100H0Z M40 40V60H60V40Z"/>') });
    await host.locator('[data-tab="scenes"]').click();
    const editor = host.locator("[data-level-drafts]").first(); await editor.locator(":scope > summary").click();
    const generator = editor.locator("[data-level-generator]");
    await generator.getByLabel("Generated floors", { exact: true }).fill("2");
    await generator.getByRole("button", { name: "Generate levels", exact: true }).click();
    const rows = editor.locator("[data-level-id]"); await expect(rows).toHaveCount(2);
    await rows.nth(0).getByLabel(`Floor map tile ${red}`, { exact: true }).check(); await rows.nth(1).getByLabel(`Floor map tile ${blue}`, { exact: true }).check();
    // G-19: the preset makes Floor 2 see the Ground; the row's checkbox reflects it.
    await editor.locator("[data-level-visibility-presets]").getByRole("button", { name: "Down to ground", exact: true }).click();
    await expect(rows.nth(1).getByLabel("Floor 2 sees Ground", { exact: true })).toBeChecked();
    await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status").first()).toContainText("Draft saved");
    const ground = await rows.nth(0).getAttribute("data-level-id"), upper = await rows.nth(1).getAttribute("data-level-id");
    if (!ground || !upper) throw new Error("levels missing");
    const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
    await bindings.getByLabel("Membership object", { exact: true }).selectOption("hero"); await bindings.getByLabel("Token destination level", { exact: true }).selectOption(upper);
    await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");

    // The GM's isolated view of Floor 2 shows what the player will see.
    const floorView = host.locator("[data-gm-floor-view]");
    await floorView.getByLabel("GM level perception preview", { exact: true }).selectOption(upper);
    await floorView.getByLabel("GM floor display", { exact: true }).selectOption("only");
    await expect.poll(() => gmCall<{ tiles: Array<{ id: string; depth: number }> }>(host, "lowerFloors")).toMatchObject({ tiles: [{ id: red, depth: 1 }] });

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
    const lower = () => surfaceCall<{ tiles: Array<{ id: string; depth: number }>; backgroundDepth: number | null }>(player, "playerCanvas", "lowerFloors");
    const pixel = (x: number, y: number) => surfaceCallArg<number[]>(player, "playerCanvas", "floorMapPixel", { x, y });
    await expect.poll(async () => (await floor()).levelId).toBe(upper);
    await expect.poll(lower).toEqual({ tiles: [{ id: red, depth: 1 }], backgroundDepth: null });
    // Through the opening: the ground's red, dimmed. Elsewhere: the upper floor's own blue.
    await expect.poll(async () => { const [r = 0, g = 0, b = 0, a = 0] = await pixel(500, 500); return r > 120 && r < 210 && g < 30 && b < 30 && a === 255; }).toBe(true);
    await expect.poll(() => pixel(150, 150)).toEqual([0, 0, 255, 255]);
    // D-443: the hero stands on Floor 2 (Z 10), so it has no height badge, although the player's
    // replica has no levels to look that up in: the floor's Z comes with the presentation.
    await expect.poll(() => surfaceCall(player, "playerCanvas", "tokenElevationCues")).toEqual([{ id: "hero", label: null, scale: 1 }]);

    // The GM seals Floor 2 again: the opening shows nothing underneath.
    await rows.nth(1).getByLabel("Floor 2 sees Ground", { exact: true }).uncheck();
    await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status").first()).toContainText("Draft saved");
    await expect.poll(lower).toEqual({ tiles: [], backgroundDepth: null });
    await expect.poll(async () => (await pixel(500, 500))[0]).toBe(0);
    await expect.poll(() => pixel(150, 150)).toEqual([0, 0, 255, 255]);
  } finally { await pc.close(); await hc.close(); }
});
