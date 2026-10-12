/**
 * D-438 on a joined player's canvas. The player's roofs open only for the player's own vision
 * tokens; a GM token standing under a barn opens it for the GM alone. A roof flagged "show
 * through fog" is drawn above the player's opaque fog once the hero's live sight touches it.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { entry, gmCall, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

type RoofStates = Record<string, { alpha: number; under: boolean; reveal: boolean } | null>;
const seedTile = (page: Page, spec: Record<string, unknown>) => surfaceCallArg<string>(page, "gm", "seedTile", spec);

test("player roofs: only own tokens open them, and a roof shows through opaque fog once in sight", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(180_000);
  const host = await (await browser.newContext()).newPage();
  const player = await (await browser.newContext()).newPage();
  await host.goto(entry + "?e2e=1");
  await waitForSurface(host, "gm");
  // The party's hero at (150, 150); a GM-only orc at (850, 150), under the barn.
  await surfaceCallArg(host, "app", "pf1ePlaceTokens", [{ id: "hero", col: 1, row: 1 }, { id: "orc", col: 8, row: 1, owner: "gm" }]);
  await host.click("#gm-settings");
  const settings = host.locator('[data-window="settings"]');
  await settings.locator("[data-scene-fog-range]").fill("6");
  await settings.locator("[data-scene-fog-range]").press("Enter");
  await settings.locator("[data-scene-fog]").check();
  await settings.locator("[data-window-close]").click();
  const barn = await seedTile(host, { name: "Barn", x: 750, y: 50, width: 300, height: 200, above: true, mode: "roof", alpha: 0.3 });
  const tower = await seedTile(host, { name: "Tower", x: 400, y: 50, width: 200, height: 200, above: true, mode: "roof", alpha: 0.5, revealInFog: true });
  const shed = await seedTile(host, { name: "Shed", x: 1500, y: 1100, width: 200, height: 200, above: true, mode: "roof", alpha: 0.5, revealInFog: true });
  await expect.poll(async () => (await gmCall<RoofStates>(host, "roofStates"))[barn]?.under).toBe(true);

  await host.click("#share");
  const fragment = manualFragment(await host.locator("#invite-link").inputValue());
  await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
  await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
  await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
  await host.click("#code-apply");
  await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
  await player.fill("#answer-input", await host.locator("#share-out").inputValue());
  await player.click("#answer-apply");
  await waitForSurface(player, "playerCanvas");
  const roofs = () => surfaceCall<RoofStates>(player, "playerCanvas", "roofStates");
  await expect.poll(async () => {
    const s = await roofs();
    return [s[barn]?.under, s[barn]?.alpha, s[tower]?.reveal, s[shed]?.reveal];
  }, { timeout: 45_000 }).toEqual([false, 1, true, false]);

  // The hero walks under the barn: now it opens for the player too, and the tower stays revealed.
  await surfaceCallArg(host, "app", "pf1eMoveToken", { tokenId: "hero", col: 9, row: 1 });
  await expect.poll(async () => {
    const s = await roofs();
    return [s[barn]?.under, s[barn]?.alpha, s[tower]?.reveal];
  }, { timeout: 45_000 }).toEqual([true, 0.3, true]);
});
