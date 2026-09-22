/**
 * §8 Phase 2 (D-271) — the hexcrawl canvas: the overlay, the empty-ground menu, the `hex` window
 * and the reveal set, driven through both real shells.
 *
 * The unit tests hold the model (which cells a player may hold, what the menu offers whom). This
 * spec holds the parts that only exist when two browsers are involved:
 *
 * 1. the GM's overlay actually paints the grid of the scene the wizard made;
 * 2. a terrain click in the menu creates the cell — *and the create survives the host*, which is
 *    where the missing-`name` bug lived (a `create` without `data.name` is refused, and `cells.ts`
 *    unit tests that only read the op's shape cannot see it);
 * 3. revealing a hex is a **create for the player's session** and closing it is a **delete** —
 *    the player's replica holds that one cell, without the GM's `description` and without the
 *    unrevealed feature, and loses it again when the GM closes the hex;
 * 4. the player's cover is painted from their own replica: the whole map minus the hexes they
 *    have been shown;
 * 5. `gm+party` sight writes the party's ring into the reveal set, and moving the token extends
 *    it.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  entry,
  hostCall,
  manualFragment,
  playerCall,
  solidPng,
  surfaceCall,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

interface Point {
  x: number;
  y: number;
}

/** D-270's `hexcrawl()` readback — the Phase 1 surface, reused here as the scene's vital signs. */
interface HexcrawlReadback {
  sceneId: string | null;
  enabled: boolean;
  width: number;
  height: number;
  cells: number;
  authored: number;
  sight: string | null;
  radiusCells: number | null;
  partyTokenId: string | null;
}

/** D-271's `hexOverlay()` — the plan the layer was handed plus what it painted. */
interface HexOverlayReadback {
  viewer: "gm" | "player";
  cells: number;
  open: number;
  closed: number;
  authored: number;
  terrainCells: number;
  openCells: number;
  cover: boolean;
  coverHoles: number;
  coverWidth: number;
  coverHeight: number;
}

interface HexCellRow {
  key: string;
  name: string;
  terrain: string | null;
  description: string | null;
  playerText: string | null;
  features: number;
  revealedFeatures: number;
  tables: number;
  open: boolean;
}

interface HexProfile {
  revealed: string[];
  sight: string;
  partyTokenId: string | null;
}

/** The window frame that carries one hex's content (`data-window` holds the window *id*). */
const GM_WINDOW_FRAME = (page: Page, key: string) =>
  page
    .locator("[data-window]")
    .filter({ has: page.locator(`[data-hex-window="${key}"]`) });

const gmOverlay = (page: Page) =>
  hostCall<HexOverlayReadback | null>(page, "hexOverlay");
const playerOverlay = (page: Page) =>
  surfaceCall<HexOverlayReadback | null>(page, "playerCanvas", "hexOverlay");
const gmCells = (page: Page) => hostCall<HexCellRow[]>(page, "hexCells");
const playerCells = (page: Page) => playerCall<HexCellRow[]>(page, "hexCells");

/** The GM's own wizard steps (the Phase 1 flow, so this spec starts from a real scene). */
async function makeHexcrawlScene(host: Page): Promise<string> {
  await host.goto(entry + "?e2e=1");
  await waitForSurface(host, "app");
  await host.click("#scene-add");
  await host.click("#scene-new-hexcrawl");
  await host.setInputFiles("[data-hx-map-input]", {
    name: "overland.png",
    mimeType: "image/png",
    buffer: solidPng(1600, 1200),
  });
  await host.click("[data-hx-next]");
  await host.selectOption("[data-hx-grid-type]", "hex");
  await host.selectOption("[data-hx-layout]", "oddQ");
  await host.fill("[data-hx-cell-size]", "100");
  await host.fill("[data-hx-distance]", "6");
  await host.fill("[data-hx-units]", "mi");
  await host.click("[data-hx-next]");
  await host.fill("[data-hx-party-name]", "The Company");
  await host.click("[data-hx-create]");
  await expect
    .poll(() => hostCall<HexcrawlReadback | null>(host, "hexcrawl"), {
      timeout: 20_000,
    })
    .toMatchObject({ enabled: true, width: 1600, height: 1200 });
  const scene = await hostCall<HexcrawlReadback | null>(host, "hexcrawl");
  if (!scene?.sceneId) throw new Error("the wizard made no scene");
  return scene.sceneId;
}

test.describe("hexcrawl canvas (§8 Phase 2, D-271)", () => {
  test("the GM's overlay, hex menu and hex window; the player gets the revealed hex and nothing else", async ({
    browser,
  }) => {
    // Two contexts, a real join handshake and a fog-style PNG-free map: this is the slow spec.
    test.setTimeout(240_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    await makeHexcrawlScene(host);
    const scene = await hostCall<HexcrawlReadback>(host, "hexcrawl");
    expect(scene.cells).toBeGreaterThan(50);

    // ── 1. the GM's overlay painted the grid the wizard promised ──
    await expect
      .poll(() => gmOverlay(host))
      .toMatchObject({
        viewer: "gm",
        cover: false,
        coverHoles: 0,
      });
    const painted = await gmOverlay(host);
    if (!painted) throw new Error("no overlay on the GM's canvas");
    expect(painted.cells).toBe(scene.cells);
    expect(painted.open).toBe(0); // nothing revealed yet

    // ── 2. right-click a hex: the menu, and terrain through it ──
    // The target is the hex east of the party, so the right-click never lands on the party token
    // (which would open the *token* menu — a different control entirely).
    const partyKey = await hostCall<string | null>(host, "hexPartyKey");
    if (!partyKey) throw new Error("the party token is not on a cell");
    const partyCentre = await surfaceCallArg<Point | null>(
      host,
      "app",
      "hexCellCenter",
      partyKey,
    );
    if (!partyCentre) throw new Error("no centre for the party's cell");
    let targetKey: string | null = null;
    for (const dx of [150, -150, 200, 100, 75]) {
      const candidate = await surfaceCallArg<string | null>(
        host,
        "app",
        "hexCellAt",
        {
          x: partyCentre.x + dx,
          y: partyCentre.y,
        },
      );
      if (candidate && candidate !== partyKey) {
        targetKey = candidate;
        break;
      }
    }
    if (!targetKey) throw new Error("no hex east of the party");
    const targetCentre = await surfaceCallArg<Point | null>(
      host,
      "app",
      "hexCellCenter",
      targetKey,
    );
    if (!targetCentre) throw new Error("no centre for the target cell");
    const targetAt = await surfaceCallArg<Point | null>(
      host,
      "app",
      "screenOf",
      targetCentre,
    );
    if (!targetAt) throw new Error("no screen point for the target cell");

    await host.mouse.click(targetAt.x, targetAt.y, { button: "right" });
    const menu = host.locator("[data-hex-menu]");
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("data-hex-menu", targetKey);
    // The Phase 2 behaviour is all here; the entries that belong to later phases are present and
    // say so, which is the only honest way to ship a menu whose other half is not written yet.
    await expect(menu.locator('[data-hex-menu-action="open"]')).toBeEnabled();
    await expect(menu.locator('[data-hex-menu-action="reveal"]')).toBeEnabled();
    // D-272 moved the first of these lines: *Attach encounter table…* is live. D-273 moved the
    // second: *Roll from a table…* opens the hex window, whose rows are the manual trigger, and
    // *Explore this hex* spends real time and asks the `exploring` trigger. D-275 moved the last
    // three — the feature editor lives in the hex window, the party moves with one position op
    // (this scene has the wizard's party token, so the row is live), and a path click is the
    // shell's own draft. Nothing in this menu waits any more; the Phase 6 spec travels with it.
    await expect(menu.locator('[data-hex-menu-action="attach"]')).toBeEnabled();
    await expect(menu.locator('[data-hex-menu-action="roll"]')).toBeEnabled();
    await expect(menu.locator('[data-hex-menu-action="explore"]')).toBeEnabled();
    await expect(menu.locator('[data-hex-menu-action="feature"]')).toBeEnabled();
    await expect(menu.locator('[data-hex-menu-action="move-party"]')).toBeEnabled();
    await expect(menu.locator('[data-hex-menu-action="add-path"]')).toBeEnabled();
    await menu.locator('[data-hex-menu-action="terrain:forest"]').click();

    // The create crossed the host: a cell exists, named after its key, tinted forest. (Before the
    // D-271 fix the whole envelope was refused here — `create: data.name required`.)
    await expect
      .poll(async () =>
        (await gmCells(host)).map((c) => [c.key, c.terrain, c.name]),
      )
      .toEqual([[targetKey, "forest", targetKey]]);
    await expect
      .poll(() => gmOverlay(host))
      .toMatchObject({ authored: 1, terrainCells: 1 });

    // ── 3. the hex window: two texts, a hidden feature, and the reveal switch ──
    await host.mouse.click(targetAt.x, targetAt.y, { button: "right" });
    await menu.locator('[data-hex-menu-action="open"]').click();
    const win = host.locator(`[data-hex-window="${targetKey}"]`);
    await expect(win).toBeVisible();
    await win
      .locator("[data-hex-gm-text]")
      .fill("The barrow gate is sealed with cold iron.");
    await win.locator("[data-hex-gm-text]").blur();
    await win
      .locator("[data-hex-player-text]")
      .fill("A mossy stone gate stands open.");
    await win.locator("[data-hex-player-text]").blur();
    await win.locator("[data-hex-feature-name]").fill("a hidden cache");
    await win.locator("[data-hex-feature-add]").click();
    await expect(win.locator("[data-hex-feature-row]")).toHaveCount(1);
    await expect
      .poll(async () => {
        const cell = (await gmCells(host))[0];
        return [cell?.description, cell?.playerText, cell?.features];
      })
      .toEqual([
        "The barrow gate is sealed with cold iron.",
        "A mossy stone gate stands open.",
        1,
      ]);

    // ── 4. invite → the player joins, and gets exactly the revealed hex ──
    await win.locator("[data-hex-reveal]").click();
    await expect.poll(async () => (await gmCells(host))[0]?.open).toBe(true);

    await host.click("#share");
    const fragment = manualFragment(
      await host.locator("#invite-link").inputValue(),
    );
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect
      .poll(() => player.locator("#offer-out").inputValue(), {
        timeout: 20_000,
      })
      .not.toBe("");
    await host.fill(
      "#peer-code",
      await player.locator("#offer-out").inputValue(),
    );
    await host.click("#code-apply");
    await expect
      .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    await player.fill(
      "#answer-input",
      await host.locator("#share-out").inputValue(),
    );
    await player.click("#answer-apply");
    await waitForSurface(player, "playerCanvas");
    await waitForSurface(player, "player");

    await expect
      .poll(() => playerCall<string[]>(player, "hexCellKeys"), {
        timeout: 45_000,
      })
      .toEqual([targetKey]);
    const crossed = await playerCells(player);
    expect(crossed[0]).toMatchObject({
      key: targetKey,
      name: targetKey,
      terrain: "forest",
      // The projection rule, on the wire: the GM's text never leaves the GM's machine, and the
      // feature that is not revealed is not "hidden in the UI" — it is not in the document.
      description: null,
      playerText: "A mossy stone gate stands open.",
      features: 0,
      revealedFeatures: 0,
      open: true,
    });

    // ── 5. the player's cover: the whole map, minus the one hex they were shown ──
    await expect
      .poll(() => playerOverlay(player), { timeout: 45_000 })
      .toMatchObject({
        viewer: "player",
        cover: true,
        coverHoles: 1,
        cells: scene.cells,
      });
    const covered = await playerOverlay(player);
    if (!covered) throw new Error("the player has no overlay");
    expect(covered.coverWidth).toBeGreaterThan(1600);
    expect(covered.coverHeight).toBeGreaterThan(1200);

    // ── 6. the player's own menu: one entry, and the window they get is read-only ──
    const playerCentre = await surfaceCallArg<Point | null>(
      player,
      "player",
      "hexCellCenter",
      targetKey,
    );
    if (!playerCentre)
      throw new Error("the player holds no centre for the revealed cell");
    const playerAt = await surfaceCallArg<Point | null>(
      player,
      "playerCanvas",
      "screenOf",
      playerCentre,
    );
    if (!playerAt) throw new Error("no screen point on the player's canvas");
    await player.mouse.click(playerAt.x, playerAt.y, { button: "right" });
    const playerMenu = player.locator("[data-hex-menu]");
    await expect(playerMenu).toBeVisible();
    await expect(
      playerMenu.locator('[data-hex-menu-action="open"]'),
    ).toBeVisible();
    await expect(
      playerMenu.locator('[data-hex-menu-action="reveal"]'),
    ).toHaveCount(0);
    await expect(
      playerMenu.locator('[data-hex-menu-action^="terrain:"]'),
    ).toHaveCount(0);
    await playerMenu.locator('[data-hex-menu-action="open"]').click();
    const playerWin = player.locator(`[data-hex-window="${targetKey}"]`);
    await expect(playerWin).toBeVisible();
    await expect(playerWin.locator("[data-hex-player-text]")).toHaveValue(
      "A mossy stone gate stands open.",
    );
    await expect(playerWin.locator("[data-hex-gm-text]")).toHaveCount(0);

    // ── 7. closing the hex takes the document away again (the delete half of the crossing) ──
    // The window sits over the canvas; close it so the right-click reaches the map. The close
    // button lives on the window *frame* (`data-window={id}`), so it is found by containment.
    await GM_WINDOW_FRAME(host, targetKey).locator("[data-window-close]").click();
    await expect(win).toBeHidden();
    await host.mouse.click(targetAt.x, targetAt.y, { button: "right" });
    await host.locator('[data-hex-menu-action="hide"]').click();
    await expect
      .poll(() => playerCall<string[]>(player, "hexCellKeys"), {
        timeout: 45_000,
      })
      .toEqual([]);
    await expect
      .poll(() => playerOverlay(player), { timeout: 45_000 })
      .toMatchObject({ cover: true, coverHoles: 0 });

    // ── 8. `gm+party` sight: the ring is written, and moving the party extends it ──
    await host.mouse.click(targetAt.x, targetAt.y, { button: "right" });
    await host.locator('[data-hex-menu-action="reveal"]').click();
    await host.click("#gm-settings");
    const settings = host.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    await settings.locator("[data-hex-sight-mode]").selectOption("gm+party");
    await settings.locator("[data-hex-radius]").fill("1");
    await settings.locator("[data-hex-radius]").blur();
    await expect
      .poll(() => hostCall<HexcrawlReadback>(host, "hexcrawl"))
      .toMatchObject({ sight: "gm+party", radiusCells: 1 });
    // The ring around the party: its own hex plus six neighbours — written by the GM's own client
    // from the `sightReconcileOps` hook, not by the Settings form.
    await expect
      .poll(
        async () =>
          (await playerCall<HexProfile>(player, "hexProfile")).revealed.length,
        {
          timeout: 45_000,
        },
      )
      .toBe(7);
    const ring = (await playerCall<HexProfile>(player, "hexProfile")).revealed;
    expect(ring).toContain(partyKey);

    // Move the party one hex east: the ring follows the token.
    let destination: string | null = null;
    for (const dx of [150, -150, 200, 100, 75]) {
      const candidate = await surfaceCallArg<string | null>(
        host,
        "app",
        "hexCellAt",
        {
          x: partyCentre.x + dx,
          y: partyCentre.y,
        },
      );
      if (candidate && candidate !== partyKey) {
        destination = candidate;
        break;
      }
    }
    if (!destination) throw new Error("no destination hex");
    const destinationCentre = await surfaceCallArg<Point | null>(
      host,
      "app",
      "hexCellCenter",
      destination,
    );
    const partyPoint = await hostCall<Point | null>(host, "hexPartyPoint");
    if (!destinationCentre || !partyPoint) throw new Error("no drag geometry");
    const dragFrom = await surfaceCallArg<Point | null>(
      host,
      "app",
      "screenOf",
      partyPoint,
    );
    const dragTo = await surfaceCallArg<Point | null>(
      host,
      "app",
      "screenOf",
      destinationCentre,
    );
    if (!dragFrom || !dragTo)
      throw new Error("no screen geometry for the drag");
    // A real drag, because "the party token moved" is the trigger the sight reconcile hangs off
    // (the plan's own words: the ring adds to the open set every time the party moves).
    await host.mouse.move(dragFrom.x, dragFrom.y);
    await host.mouse.down();
    await host.mouse.move(dragTo.x, dragTo.y, { steps: 12 });
    await host.mouse.up();
    await expect
      .poll(() => hostCall<string | null>(host, "hexPartyKey"), {
        timeout: 20_000,
      })
      .toBe(destination);
    await expect
      .poll(
        async () =>
          (await playerCall<HexProfile>(player, "hexProfile")).revealed.length,
        { timeout: 45_000 },
      )
      .toBeGreaterThan(ring.length);
    const grown = (await playerCall<HexProfile>(player, "hexProfile")).revealed;
    expect(grown).toContain(destination);
    // …and the cover still cuts out exactly the open cells the player's own plan painted.
    await expect
      .poll(
        async () => {
          const layer = await playerOverlay(player);
          return layer
            ? layer.coverHoles === layer.openCells && layer.coverHoles > 1
            : false;
        },
        { timeout: 45_000 },
      )
      .toBe(true);

    // A two-peer spec has to give its contexts back: a leaked context leaves a page open behind
    // the next test, and Chromium throttles a page nobody is looking at — which starves the peer
    // link, and is why this spec's propagation step used to fail in a long run and pass alone.
    await hostCtx.close();
    await playerCtx.close();
  });
});
