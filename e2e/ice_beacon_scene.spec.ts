/**
 * D-454 — the starter world's "Ice Beacon — Elevation Test", through a real browser, the way a
 * tester gets it: the GM opens the built starter world, opens the scene from the rail and reads
 * every label from the ground; a player joins as Hosilla, does not see the Ambusher behind the
 * solid crates, climbs them (rising on her own) and reads the labels from her height, then takes
 * the west spiral to the Gallery and sees the Hall's tokens through the opening, labelled from her.
 *
 * `tests/scripts/iceBeaconScene.test.ts` checks the same claims against the pure code; this spec
 * proves the shipped archive delivers them end to end. Screenshots land in the test's output dir
 * for human review (gm-hall, player-entrance, player-crates-10, player-gallery).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { entry, gmCall, hostCall, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

const distWorlds = fileURLToPath(new URL("../dist/worlds", import.meta.url));
const starterZip = (): string | null => {
  const names = existsSync(distWorlds) ? readdirSync(distWorlds) : [];
  const name = names.find((n) => /^pf1e-mass-battles-starter-.*\.zip$/.test(n));
  return name ? join(distWorlds, name) : null;
};

type Cue = { id: string; label: string | null; scale: number };
const short = (id: string) => id.replace("tok-ib-", "");
const ids = (cues: ReadonlyArray<{ id: string }>) => cues.map((c) => short(c.id)).sort();
const labels = (cues: ReadonlyArray<{ id: string; label: string | null }>) =>
  Object.fromEntries(cues.flatMap((c) => (c.label ? [[short(c.id), c.label]] : [])));

async function openStarterWorld(page: Page, zipPath: string): Promise<void> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#close-world").click();
  await expect(page.locator("#role-host")).toHaveText(/Host a world|Continue/, { timeout: 30_000 });
  await page.setInputFiles("#role-import", zipPath);
  const dialog = page.locator("[data-open-dialog]");
  await expect(dialog).toHaveAttribute("data-open-kind", "world");
  await dialog.locator("[data-open-copy]").click();
  await waitForSurface(page, "app");
  await expect(page.locator("#status")).toContainText("Pathfinder 1e Mass Battles", { timeout: 60_000 });
  await waitForSurface(page, "gm");
}

/** Drag on the player's canvas between two world points (the camera fits the whole scene). */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const rect = await page.locator(".canvas-host canvas").boundingBox();
  if (!rect) throw new Error("player canvas not mounted");
  const camera = await surfaceCall<{ x: number; y: number; scale: number }>(page, "player", "camera");
  const screen = (p: { x: number; y: number }) => ({ x: rect.x + (p.x - camera.x) * camera.scale, y: rect.y + (p.y - camera.y) * camera.scale });
  await page.mouse.move(screen(from).x, screen(from).y);
  await page.mouse.down();
  await page.mouse.move(screen(to).x, screen(to).y, { steps: 12 });
  await page.mouse.up();
}

test("D-454: the Ice Beacon elevation test, as a tester opens it", async ({ browser }: { browser: Browser }) => {
  const zip = starterZip();
  test.skip(!zip, "run `pnpm build:systems && pnpm build:worlds` first");
  test.setTimeout(420_000);
  const hc = await browser.newContext(), pc = await browser.newContext();
  const host = await hc.newPage(), player = await pc.newPage();
  const errors: string[] = [];
  for (const page of [host, player]) page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await openStarterWorld(host, zip as string);
    const rail = host.locator('[data-scene="scene-ice-beacon"]');
    await expect(rail).toContainText("Ice Beacon");
    await rail.click();
    await expect.poll(() => hostCall<string | null>(host, "activeSceneId"), { timeout: 30_000 }).toBe("scene-ice-beacon");

    // ── GM: four traced/untraced floors, and every label read from the ground ──
    await expect.poll(async () => (await hostCall<Array<{ name: string; surface: { openings: number } | null }>>(host, "levelSurfaces"))
      .map((l) => [l.name, l.surface?.openings ?? null])).toEqual([["Ground Hall", null], ["Gallery", 3], ["Crystal Ring", 2], ["Beacon", 0]]);
    const gmCues = () => gmCall<Cue[]>(host, "tokenElevationCues");
    await expect.poll(async () => labels(await gmCues()), { timeout: 30_000 }).toMatchObject({ lookout: "+15 ft", sentry: "+5 ft", archer: "+10 ft" });
    expect(labels(await gmCues())).not.toHaveProperty("hosilla");

    // ── a player joins: Hosilla is theirs, on the Ground Hall ──
    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    await player.goto(`${entry}?e2e=1&join=1#${manualFragment(inviteLink)}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
    await host.click("#code-apply");
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue());
    await player.click("#answer-apply");
    await waitForSurface(player, "playerCanvas");
    const floor = async () => (await surfaceCall<{ levelId: string | null }>(player, "playerCanvas", "floorPresentation")).levelId;
    await expect.poll(floor, { timeout: 30_000 }).toBe("lvl-ib-hall");

    // From the entrance: the solid 15-ft stack hides the Ambusher; the open scaffold hides nothing.
    const playerCues = () => surfaceCall<Cue[]>(player, "playerCanvas", "tokenElevationCues");
    await expect.poll(async () => ids(await playerCues()), { timeout: 30_000 }).toEqual(["archer", "hosilla", "lookout", "orc", "sentry"]);
    expect(labels(await playerCues())).toEqual({ lookout: "+15 ft", sentry: "+5 ft", archer: "+10 ft" });
    // What she sees is the hall, not black: the GM's empty manual fog mask used to cover the whole
    // scene in opaque black for every player (D-454). Then wait for the art itself (a headless
    // 2-core run streams it slowly) so the screenshot shows the real map.
    const scenePixel = (p: { x: number; y: number }) => surfaceCallArg<number[]>(player, "playerCanvas", "scenePixel", p);
    await expect.poll(async () => (await scenePixel({ x: 1150, y: 1650 })).slice(0, 3).reduce((a, b) => a + b, 0), { timeout: 30_000 }).toBeGreaterThan(60);
    await expect.poll(async () => (await surfaceCallArg<number[]>(player, "playerCanvas", "floorMapPixel", { x: 1100, y: 1100 }))[3], { timeout: 150_000 }).toBe(255);
    await player.screenshot({ path: test.info().outputPath("player-entrance.png") });

    // Onto the 5-ft crates: she rises by herself and the labels now read from her.
    await drag(player, { x: 1150, y: 1750 }, { x: 750, y: 1550 });
    await expect.poll(async () => labels(await playerCues()), { timeout: 20_000 }).toEqual({ lookout: "+10 ft", archer: "+5 ft", orc: "-5 ft" });
    expect(ids(await playerCues())).not.toContain("ambusher");

    // Onto the 10-ft crates' north edge: over the stack, the Ambusher appears 10 ft below her.
    await drag(player, { x: 750, y: 1550 }, { x: 750, y: 1250 });
    await expect.poll(async () => labels(await playerCues()), { timeout: 20_000 }).toMatchObject({ ambusher: "-10 ft", lookout: "+5 ft", sentry: "-5 ft" });
    await player.screenshot({ path: test.info().outputPath("player-crates-10.png") });

    // Down to the north-west, around the Ambusher (PF1e refuses a walk through an enemy's square,
    // and one drag is one 30-ft move action), then into the west spiral: up to the Gallery (20 ft).
    // The Troll is level with her, the Vrock flies 10 ft above, and the Hall's tokens show through
    // the opening, labelled from her.
    await drag(player, { x: 750, y: 1250 }, { x: 650, y: 1150 });
    await expect.poll(async () => labels(await playerCues()), { timeout: 20_000 }).toMatchObject({ archer: "+10 ft" }); // back on the ground
    await drag(player, { x: 650, y: 1150 }, { x: 650, y: 650 });
    await expect.poll(floor, { timeout: 20_000 }).toBe("lvl-ib-gallery");
    await expect.poll(async () => labels(await playerCues()), { timeout: 20_000 }).toEqual({ vrock: "+10 ft" });
    expect(ids(await playerCues())).toEqual(["hosilla", "troll", "vrock"]);
    const below = () => surfaceCall<Array<{ id: string; label: string }>>(player, "playerCanvas", "lowerTokenLabels");
    await expect.poll(async () => labels(await below()), { timeout: 20_000 }).toMatchObject({ lookout: "-5 ft", archer: "-10 ft", orc: "-20 ft" });
    await player.screenshot({ path: test.info().outputPath("player-gallery.png") });
    // For the reviewer: the GM's own view of the Ground Hall alone, labels read from the ground.
    await host.click('[aria-label="Close session panel"]');
    const floorView = host.locator("[data-gm-floor-view]");
    await floorView.getByLabel("GM level perception preview", { exact: true }).selectOption("lvl-ib-hall");
    await floorView.getByLabel("GM floor display", { exact: true }).selectOption("only");
    await expect.poll(async () => (await gmCall<Record<string, number | null>>(host, "tileAlphas"))["tile-ib-gallery"] ?? null).toBeNull();
    await host.screenshot({ path: test.info().outputPath("gm-hall.png") });

    expect(errors).toEqual([]);
  } finally {
    await pc.close();
    await hc.close();
  }
});
