/**
 * D-291 — the starter world's overland region, through a real browser.
 *
 * The starter ships **The Hollow Reach**: 28 authored hexes, four encounter tables and a
 * traveller's guide, so a tester can walk before they author anything. `tests/scripts/
 * buildStarterWorlds.test.ts` proves the region *survives* the world file and boots; what only a
 * browser can prove is that it is **usable**: the scene opens, a hex has the description the
 * content gave it, the table attached to that hex rolls, the route the GM draws is priced off the
 * terrain the content set, and a clock advance actually walks the party.
 *
 * Every assertion below is about the *content* being reachable, not about the hexcrawl features
 * themselves — those specs (`hexcrawl_travel.spec.ts`, `hexcrawl_tables.spec.ts`) build their own
 * scenes. This one asks whether the world a new GM opens first is a hexcrawl they can play in.
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { entry, hostCall, surfaceCallArg, waitForSurface } from "./lib";

const distWorlds = fileURLToPath(new URL("../dist/worlds", import.meta.url));
const starterZip = (): string | null => {
  const names = existsSync(distWorlds) ? readdirSync(distWorlds) : [];
  const name = names.find((n) => /^pf1e-mass-battles-starter-.*\.zip$/.test(n));
  return name ? join(distWorlds, name) : null;
};
const NEED = "run `pnpm build:worlds` (or the whole `pnpm test:e2e` chain)";

interface HexcrawlReadback {
  sceneId: string | null;
  sceneName: string | null;
  enabled: boolean;
  width: number;
  height: number;
  cells: number;
  authored: number;
  sight: string | null;
  radiusCells: number | null;
  encounterMode: string | null;
  partyTokenId: string | null;
}

interface Point {
  x: number;
  y: number;
}

/** Road costs open ground: at 24 units a day, one border is one hour (§3.6). */
const HOUR = 3_600;

/** Open the built starter world from the start screen, the way a GM who downloaded it would. */
async function openStarterWorld(page: Page, zipPath: string): Promise<void> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#close-world").click();
  await expect(page.locator("#role-host")).toHaveText(/Host a world|Continue/, {
    timeout: 30_000,
  });
  await page.setInputFiles("#role-import", zipPath);
  const dialog = page.locator("[data-open-dialog]");
  await expect(dialog).toHaveAttribute("data-open-kind", "world");
  await dialog.locator("[data-open-copy]").click();
  await waitForSurface(page, "app");
  // The status line names the world and its seq: the region's documents are what make the seq
  // what it is, so this is also the check that the artifact under dist/ is the current one.
  await expect(page.locator("#status")).toContainText("Pathfinder 1e Mass Battles", {
    timeout: 60_000,
  });
  await expect(page.locator("#status")).toContainText("seq 17");
}

/** The screen point of a hex centre — the app's own geometry, not the spec's arithmetic. */
async function cellAt(page: Page, key: string): Promise<Point> {
  const centre = await surfaceCallArg<Point | null>(page, "app", "hexCellCenter", key);
  if (!centre) throw new Error(`no centre for ${key}`);
  const at = await surfaceCallArg<Point | null>(page, "app", "screenOf", centre);
  if (!at) throw new Error(`no screen point for ${key}`);
  return at;
}

test.describe("the starter world's overland region (D-291)", () => {
  test("opens with 28 authored hexes, and a hex, a table, a route and a march work in it", async ({
    page,
  }) => {
    const zipPath = starterZip();
    test.skip(zipPath === null, `no starter world under dist/worlds — ${NEED}`);
    // An import, a boot, a roll, a route and two clock advances.
    test.setTimeout(180_000);

    await openStarterWorld(page, zipPath as string);

    // ── the region is a scene in the rail, and opening it makes it the hexcrawl scene ──
    const rail = page.locator('[data-scene="scene-3"]');
    await expect(rail).toContainText("Hollow Reach");
    await rail.click();

    const read = (): Promise<HexcrawlReadback | null> =>
      hostCall<HexcrawlReadback | null>(page, "hexcrawl");
    await expect.poll(read, { timeout: 30_000 }).toMatchObject({
      sceneName: "Overland — The Hollow Reach",
      enabled: true,
      sight: "gm+party",
      radiusCells: 1,
      encounterMode: "prompt",
    });
    const after = await read();
    if (!after) throw new Error("no active hexcrawl scene");
    // 28 authored hexes on a map that has more than 28: the dark edges are unexplored ground.
    expect(after.authored).toBe(28);
    expect(after.cells).toBeGreaterThan(after.authored);
    expect(after.partyTokenId).not.toBeNull();

    // ── the party starts where the content says it does ──
    expect(await hostCall<string | null>(page, "hexPartyKey")).toBe("1,2");

    // ── a hex has what the content gave it: name, terrain, GM text, and its table ──
    // The Ash Mile (2,2) is road, is open in the profile, and carries the road table.
    const ashMile = await cellAt(page, "2,2");
    await page.mouse.click(ashMile.x, ashMile.y, { button: "right" });
    const menu = page.locator('[data-hex-menu="2,2"]');
    await expect(menu).toBeVisible();
    await menu.locator('[data-hex-menu-action="open"]').click();
    // The window host's frame: the close button belongs to it, not to the hex window's markup.
    const win = page
      .locator("[data-window]")
      .filter({ has: page.locator('[data-hex-window="2,2"]') });
    await expect(win).toBeVisible();
    await expect(win.locator("[data-hex-name]")).toHaveText("The Ash Mile");
    await expect(win.locator("[data-hex-terrain]")).toHaveValue("road");
    await expect(win.locator("[data-hex-gm-text]")).toHaveValue(/King's Road/);
    await expect(win.locator("[data-hex-player-text]")).toHaveValue(/river noise on the left/);
    // the encounter table the content attached to this hex, named where a GM can see it
    await expect(win.locator('[data-hex-table-row="table-road"]')).toContainText(
      "The road out of the Reach",
    );

    // ── the table rolls now, on this hex, and the ledger records the roll ──
    await win.locator('[data-hex-roll="table-road"]').click();
    const result = page
      .locator("[data-window]")
      .filter({ has: page.locator("[data-encounter-result]") });
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result.locator("[data-result-table]")).toHaveText("The road out of the Reach");
    await expect(result.locator("[data-result-cell]")).toHaveText("hex 2,2");
    const ledger = await hostCall<Array<{ cellKey: string; tableId: string }>>(
      page,
      "hexEncounterLedger",
    );
    expect(ledger.map((row) => [row.cellKey, row.tableId])).toEqual([["2,2", "table-road"]]);
    await result.locator("[data-result-close]").click();
    await expect(result).toBeHidden();
    await win.locator("[data-window-close]").click();
    await expect(win).toBeHidden();

    // ── draw the road east and commit it: the route is priced before anyone walks ──
    // The route is drawn with the hex menu's *Add to path*, not with bare clicks: the menu names
    // the hex it opened on, so a click that landed a hex off fails here and says which one —
    // instead of quietly pricing a march through the wrong country. The route starts where the
    // party stands: Gallows Ford (1,2) → the Ash Mile (2,2) → Waystone Cross (3,2).
    for (const key of ["2,2", "3,2"]) {
      const at = await cellAt(page, key);
      await page.mouse.click(at.x, at.y, { button: "right" });
      const stepMenu = page.locator(`[data-hex-menu="${key}"]`);
      await expect(stepMenu).toBeVisible();
      await stepMenu.locator('[data-hex-menu-action="add-path"]').click();
      await expect(stepMenu).toBeHidden();
    }
    await expect(page.locator("[data-travel-row]")).toHaveCount(2);
    // The panel names the terrain the way the catalog does — a GM reads "Highway / road" — and
    // the road rule is what makes a border out of the town cost open ground.
    await expect(page.locator('[data-travel-row="2,2"]')).toHaveAttribute(
      "data-travel-terrain",
      "Highway / road",
    );
    await expect(page.locator('[data-travel-row="3,2"]')).toHaveAttribute(
      "data-travel-terrain",
      "Highway / road",
    );
    await expect(page.locator("[data-travel-total]")).toContainText("2 h");
    await page.click("[data-travel-commit]");
    const panel = page.locator("[data-travel-panel]");
    await expect(panel).toHaveAttribute("data-travel-committed", "true");

    // ── one border at a time: the party walks to Waystone Cross, an hour per border ──
    const before = await hostCall<number>(page, "hexClock");
    await page.click('[data-travel-advance="next"]');
    await expect.poll(() => hostCall<string | null>(page, "hexPartyKey")).toBe("2,2");
    expect(await hostCall<number>(page, "hexClock")).toBe(before + HOUR);
    await page.click('[data-travel-advance="next"]');
    await expect.poll(() => hostCall<string | null>(page, "hexPartyKey")).toBe("3,2");
    expect(await hostCall<number>(page, "hexClock")).toBe(before + 2 * HOUR);
    // The route is walked out, so the plan is gone and the party is standing at the crossroads.
    expect(await hostCall<unknown>(page, "hexTravel")).toBeNull();

    // ── and the hex they arrived in is the one the guide describes ──
    // Shift+H, not a right-click: the party is standing in this hex now, and a right-click there
    // lands on the party token and opens the token's menu instead (the hexcrawl specs' own rule).
    await page.keyboard.press("Shift+H");
    const arrived = page
      .locator("[data-window]")
      .filter({ has: page.locator('[data-hex-window="3,2"]') });
    await expect(arrived).toBeVisible({ timeout: 20_000 });
    await expect(arrived.locator("[data-hex-name]")).toHaveText("Waystone Cross");
    await expect(arrived.locator("[data-hex-gm-text]")).toHaveValue(/crossroads of the Reach/);
  });
});
