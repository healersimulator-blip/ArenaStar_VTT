/**
 * §8 Phase 7 (D-276) — the last half-day of the plan: the hexcrawl's own sheet in the help
 * window, a key that opens the party's hex from anywhere on the map, and the one line the
 * travel panel owes a GM who has just committed a route.
 *
 * None of this is model — the model is D-268…D-275 and it is asserted elsewhere. What only a
 * browser can prove here is that a GM who has never read the plan can *find* the feature:
 *
 * 1. the help window carries a hexcrawl sheet, with the keys that drive it (§7.2 promised the
 *    help panel and the rail two hint lines; this is where they are paid off);
 * 2. `Shift+H` opens the hex the party stands in — the plan asked for `H`, and `h` alone is
 *    Roll20's hand tool, so the modifier is what buys the mnemonic;
 * 3. the travel panel says, in words, that its buttons spend the world clock;
 * 4. the same key on a map that is not a hexcrawl one opens nothing at all (a key that opens a
 *    window on the wrong scene is worse than a key that does nothing).
 */
import { expect, test, type Page } from "@playwright/test";
import {
  entry,
  hostCall,
  solidPng,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

/** The same wizard every hexcrawl spec starts from (D-270), party token included. */
async function bootHexcrawl(page: Page): Promise<string> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.click("#scene-add");
  await page.click("#scene-new-hexcrawl");
  await page.setInputFiles("[data-hx-map-input]", {
    name: "overland.png",
    mimeType: "image/png",
    buffer: solidPng(1600, 1200),
  });
  await page.click("[data-hx-next]");
  await page.selectOption("[data-hx-grid-type]", "hex");
  await page.selectOption("[data-hx-layout]", "oddQ");
  await page.fill("[data-hx-cell-size]", "100");
  await page.click("[data-hx-next]");
  await page.fill("[data-hx-party-name]", "The Company");
  await page.click("[data-hx-create]");
  await expect
    .poll(() => hostCall<string | null>(page, "hexPartyKey"), { timeout: 20_000 })
    .not.toBeNull();
  const partyKey = await hostCall<string | null>(page, "hexPartyKey");
  if (!partyKey) throw new Error("the wizard made no party token");
  return partyKey;
}

/** The window frame carrying a piece of content — the close button belongs to it, not to the
 *  content's own markup (the same split every spec that closes a window goes through). */
const frameOf = (page: Page, inner: string) =>
  page.locator("[data-window]").filter({ has: page.locator(inner) });

test.describe("hexcrawl help & keys (§8 Phase 7, D-276)", () => {
  test("the help window carries the hexcrawl sheet, and Shift+H opens the party's hex", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const partyKey = await bootHexcrawl(page);

    // ── 1. the help window's hexcrawl section (plan §7.2's "two hint lines", grown up) ──
    await page.click('[data-canvas-action="help"]');
    const help = page.locator("[data-help-panel]");
    await expect(help).toBeVisible();
    const sheet = help.locator("[data-help-hexcrawl]");
    await expect(sheet).toHaveCount(1);
    // The model in words: the clock walks the party, and a hex keeps the hours spent in it.
    await expect(sheet).toContainText("world clock");
    await expect(sheet).toContainText("A hexcrawl scene is one overland map");
    // …and the keys, each one a row a GM can read off.
    for (const key of ["Right-click a hex", "Shift+H", "Y", "Escape"]) {
      await expect(sheet.locator("dt", { hasText: key })).toHaveCount(1);
    }
    // The window sits over the canvas and would eat the key press (D-272's lesson).
    await frameOf(page, "[data-help-panel]").locator("[data-window-close]").click();
    await expect(help).toBeHidden();

    // ── 2. Shift+H: the hex the party stands in, from anywhere ──
    await page.keyboard.press("Shift+H");
    const win = page.locator(`[data-hex-window="${partyKey}"]`);
    await expect(win).toBeVisible();
    await expect(frameOf(page, `[data-hex-window="${partyKey}"]`)).toContainText(
      `Hex ${partyKey}`,
    );
  });

  test("the travel panel says what its buttons spend, once a route is committed", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const partyKey = await bootHexcrawl(page);

    const panel = page.locator("[data-travel-panel]");
    // No route, no itinerary, no hint: the panel is not on screen at all yet.
    await expect(panel).toHaveCount(0);

    const world = await surfaceCallArg<{ x: number; y: number } | null>(
      page,
      "app",
      "hexCellCenter",
      partyKey,
    );
    if (!world) throw new Error("no world centre for the party's own cell");
    const step = await surfaceCallArg<string | null>(page, "app", "hexCellAt", {
      x: world.x + 150,
      y: world.y,
    });
    if (!step) throw new Error("no cell east of the party");

    await page.click('[data-canvas-tool="path"]');
    const centre = await surfaceCallArg<{ x: number; y: number } | null>(
      page,
      "app",
      "hexCellCenter",
      step,
    );
    if (!centre) throw new Error("no centre for the step");
    const at = await surfaceCallArg<{ x: number; y: number } | null>(
      page,
      "app",
      "screenOf",
      centre,
    );
    if (!at) throw new Error("no screen point for the step");
    await page.mouse.click(at.x, at.y);

    // While the route is a draft, the hint says nothing — there is nothing to spend yet.
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-travel-hint]")).toHaveCount(0);

    // …and the moment it is committed, beside the buttons that spend the clock.
    await page.click("[data-travel-commit]");
    await expect(panel).toHaveAttribute("data-travel-committed", "true");
    await expect(panel.locator("[data-travel-hint]")).toContainText("world clock");
  });

  test("Shift+H on a map that is not a hexcrawl one opens nothing", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    // The default world's first scene is a tactical map; the key must stay quiet on it rather
    // than opening a window about a hex that does not exist.
    await page.keyboard.press("Shift+H");
    await page.waitForTimeout(300);
    await expect(page.locator("[data-hex-window]")).toHaveCount(0);
    // …and the help sheet is still there for a GM who has not made a hexcrawl scene yet.
    await page.click('[data-canvas-action="help"]');
    await expect(
      page.locator("[data-help-panel]").locator("[data-help-hexcrawl]"),
    ).toHaveCount(1);
  });
});
