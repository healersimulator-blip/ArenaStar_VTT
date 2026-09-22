/**
 * §8 Phase 1 (D-270) — making a hexcrawl scene, through the real UI.
 *
 * The unit tests hold the model's arithmetic; this spec holds the *seam*: the `+` chooser asks
 * what kind of scene, the wizard's three steps walk a real map file through the host's asset
 * pipeline, and the submit it produces lands as a scene the Settings panel and the canvas both
 * read. The two things that used to be impossible to do at all — upload a map onto a scene other
 * than scene 1, and start a scene already knowing it is a hexcrawl map — are asserted here rather
 * than trusted.
 */
import { expect, test } from "@playwright/test";
import {
  entry,
  hostCall,
  solidPng,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

/** The app's own readback of the active scene's hexcrawl state (D-270 `hexcrawl()`). */
interface HexcrawlReadback {
  sceneId: string | null;
  sceneName: string | null;
  enabled: boolean;
  grid: {
    type: string;
    size: number;
    distance: number;
    units: string;
    hexLayout: string;
  } | null;
  width: number;
  height: number;
  cells: number;
  authored: number;
  img: string | null;
  sight: string | null;
  radiusCells: number | null;
  encounterMode: string | null;
  daylight: { dawnHour: number; duskHour: number } | null;
  partyTokenId: string | null;
  partyFlagged: string | null;
}

// 30 s is the repo default and this spec runs the map through the host's asset pipeline before its
// own assertions start; on this box that plus the settings panel's terrain section does not fit.
// Same explicit budget the other slow specs carry (D-272 recorded the timeout).
test.setTimeout(90_000);

test.describe("hexcrawl scene (§9 Phase 1, D-270)", () => {
  test("the wizard makes a hexcrawl scene from a real map, and the panel reads it back", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await waitForSurface(page, "gm");

    // ── the chooser: `+` asks which kind of scene, and a blank one is still one click ──
    await page.click("#scene-add");
    await expect(page.locator("[data-scene-menu]")).toBeVisible();
    await page.click("#scene-new-hexcrawl");

    const wizard = page.locator("[data-hexcrawl-wizard]");
    await expect(wizard).toBeVisible();
    await expect(wizard).toHaveAttribute("data-hx-step", "map");

    // ── step 1: the map, through the host's own asset import ──
    await page.setInputFiles("[data-hx-map-input]", {
      name: "overland.png",
      mimeType: "image/png",
      buffer: solidPng(1600, 1200),
    });
    await expect(wizard.locator("[data-hx-map]")).toContainText("1600 × 1200");
    await page.fill("[data-hx-name]", "Marsh overland");

    // ── step 2: the grid and the reference scale, with the cell count read before creating ──
    await page.click("[data-hx-next]");
    await expect(wizard).toHaveAttribute("data-hx-step", "grid");
    await page.selectOption("[data-hx-grid-type]", "hex");
    await page.selectOption("[data-hx-layout]", "oddQ");
    await page.fill("[data-hx-cell-size]", "100");
    await page.fill("[data-hx-distance]", "6");
    await page.fill("[data-hx-units]", "mi");
    await expect(page.locator("[data-hx-scale]")).toHaveText("1 cell = 6 mi");
    const planned = Number(await page.textContent("[data-hx-cells]"));
    expect(planned).toBeGreaterThan(50);

    // ── step 3: the party token, then one submit ──
    await page.click("[data-hx-next]");
    await expect(wizard).toHaveAttribute("data-hx-step", "party");
    await page.fill("[data-hx-party-name]", "The Company");
    await page.click("[data-hx-create]");
    await expect(wizard).toBeHidden();

    // ── what landed: a new, active, enabled hexcrawl scene with the map and the party ──
    const read = (): Promise<HexcrawlReadback | null> =>
      hostCall<HexcrawlReadback | null>(page, "hexcrawl");
    await expect.poll(read, { timeout: 20_000 }).toMatchObject({
      sceneName: "Marsh overland",
      enabled: true,
      width: 1600,
      height: 1200,
      sight: "gm",
      radiusCells: 0,
      encounterMode: "prompt",
    });
    const after = await read();
    if (!after) throw new Error("no active scene after the wizard");
    expect(after.grid).toEqual({
      type: "hex",
      size: 100,
      distance: 6,
      units: "mi",
      hexLayout: "oddQ",
    });
    // The count the wizard promised is the count the scene has (the panel quotes the same one).
    expect(after.cells).toBe(planned);
    expect(after.img).not.toBeNull();
    expect(after.daylight).toEqual({ dawnHour: 6, duskHour: 18 });
    expect(after.partyTokenId).not.toBeNull();
    // The token that walks is the token the flag marks — both halves, from one submit.
    expect(after.partyFlagged).toBe(after.partyTokenId);
    expect(after.sceneId).not.toBe("scene-1");

    // ── the Settings panel shows the same census and scale ──
    await page.click("#gm-settings");
    const settings = page.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    await expect(settings.locator("[data-hex-on]")).toBeVisible();
    await expect(settings.locator("[data-hex-cells]")).toHaveText(
      String(after.cells),
    );
    await expect(settings.locator("[data-hex-scale]")).toHaveText(
      "1 cell = 6 mi",
    );
    await expect(settings.locator("[data-hex-terrain]")).toBeHidden(); // folded away until asked
    await settings.locator("[data-hex-terrain-summary]").click();
    // The road rule is visible where a GM would look for it, and it survived the world setting.
    await expect(
      settings.locator('[data-hex-terrain-row="road"]'),
    ).toContainText("crosses as open ground");

    // ── the panel edits the profile, and the edit is a replicated fact ──
    await settings.locator("[data-hex-sight-mode]").selectOption("gm+party");
    await settings.locator("[data-hex-radius]").fill("1");
    await settings.locator("[data-hex-radius]").blur();
    await expect
      .poll(read)
      .toMatchObject({ sight: "gm+party", radiusCells: 1 });
    await settings.locator("[data-hex-encounter-mode]").selectOption("auto");
    await expect.poll(read).toMatchObject({ encounterMode: "auto" });

    // ── the D-270 fix: a sidebar map import lands on the scene the GM is looking at ──
    await page.setInputFiles("#map-input", {
      name: "second.png",
      mimeType: "image/png",
      buffer: solidPng(800, 600),
    });
    await expect
      .poll(read, { timeout: 20_000 })
      .toMatchObject({ width: 800, height: 600 });
    // …and scene 1 — the scene this used to be hardcoded to — is untouched.
    expect(
      await surfaceCallArg<string | null>(
        page,
        "app",
        "sceneImgById",
        "scene-1",
      ),
    ).toBeNull();

    // ── the app's own "which scene is the table on" agrees: activation landed with the map ──
    expect(await hostCall<string | null>(page, "activeSceneId")).toBe(
      after.sceneId,
    );
  });
});
