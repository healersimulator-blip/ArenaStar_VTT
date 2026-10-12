import { expect, test } from "@playwright/test";
import { entry, gmCall, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

/**
 * G-23 (D-448): nothing to stand on in an opening. The player cannot walk the hero into Floor 2's
 * traced stairwell (the host says why); the GM can put a goblin there, and the floor-play check
 * then offers to drop it to the ground floor, where the GM's isolated view of Floor 2 shows it below.
 */
test("players cannot walk into an opening; the GM's goblin there is dropped to the floor below by the check", async ({ browser }) => {
  test.setTimeout(150_000);
  const hc = await browser.newContext(), pc = await browser.newContext();
  const host = await hc.newPage(), player = await pc.newPage();
  try {
    await host.goto(entry + "?e2e=1"); await waitForSurface(host, "app");
    // The hero beside the stairwell (250, 550); the goblin far from it (750, 750).
    await surfaceCallArg(host, "app", "pf1ePlaceTokens", [{ id: "hero", col: 2, row: 5 }, { id: "goblin", col: 7, row: 7, owner: "gm" }]);
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
    const surface = rows.nth(1).locator("[data-level-surface]");
    await surface.getByRole("button", { name: "Trace from floor art", exact: true }).click();
    await expect(surface.locator("[data-surface-status]")).toHaveText("1 solid area · 1 opening");
    await editor.getByRole("button", { name: "Apply draft levels", exact: true }).click(); await expect(editor.getByRole("status").first()).toContainText("Draft saved");
    const ground = await rows.nth(0).getAttribute("data-level-id"), upper = await rows.nth(1).getAttribute("data-level-id");
    if (!ground || !upper) throw new Error("levels missing");
    const bindings = editor.locator("[data-level-bindings]"); await bindings.locator(":scope > summary").click();
    for (const id of ["hero", "goblin"]) {
      await bindings.getByLabel("Membership object", { exact: true }).selectOption(id); await bindings.getByLabel("Token destination level", { exact: true }).selectOption(upper);
      await bindings.getByRole("button", { name: "Apply assignment", exact: true }).click(); await expect(bindings.getByRole("status")).toContainText("Assignment saved");
    }
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
    await expect.poll(async () => (await surfaceCall<{ levelId: string | null }>(player, "playerCanvas", "floorPresentation")).levelId).toBe(upper);

    // The hero walks to the stairwell's edge, then tries to step in: refused, with the reason.
    const canvas = player.locator(".canvas-host canvas"); const rect = await canvas.boundingBox(); if (!rect) throw new Error("canvas");
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const camera = await surfaceCall<{ x: number; y: number; scale: number }>(player, "player", "camera");
      const screen = (p: { x: number; y: number }) => ({ x: rect.x + (p.x - camera.x) * camera.scale, y: rect.y + (p.y - camera.y) * camera.scale });
      await player.mouse.move(screen(from).x, screen(from).y);
      await player.mouse.down(); await player.mouse.move(screen(to).x, screen(to).y, { steps: 10 }); await player.mouse.up();
    };
    await drag({ x: 250, y: 550 }, { x: 550, y: 550 });
    await expect(player.locator("[data-player-move-refused]").last()).toContainText("No floor there");
    await expect(player.locator("[data-player-move-refused]").last()).toContainText("would step into an opening on Floor 2");

    // The GM puts the goblin in the well; the floor-play check offers the fall, and it lands below.
    await surfaceCallArg(host, "app", "pf1eMoveToken", { tokenId: "goblin", col: 5, row: 5 });
    const finding = play.locator('[data-level-audit] [data-audit-code="token-over-opening"]');
    await expect(finding).toContainText("1 token stands over an opening");
    await finding.getByRole("button", { name: "Drop them to the floor below", exact: true }).click();
    await expect(finding).toHaveCount(0);
    const floorView = host.locator("[data-gm-floor-view]");
    await floorView.getByLabel("GM level perception preview", { exact: true }).selectOption(upper);
    await floorView.getByLabel("GM floor display", { exact: true }).selectOption("only");
    await expect.poll(async () => (await gmCall<{ tokens: Array<{ id: string; depth: number }> }>(host, "lowerFloors")).tokens).toEqual([{ id: "goblin", depth: 1 }]);
  } finally { await pc.close(); await hc.close(); }
});
