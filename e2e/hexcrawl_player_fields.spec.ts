/**
 * §8 Phase 6/7 tail (D-275, D-276) — **what a player's replica holds of the new fields.**
 *
 * PR #29 left one follow-up open: "player-side assertions for the new feature fields". The
 * GM's half is asserted in `hexcrawl_travel.spec.ts` and `hexcrawl_fog.spec.ts`; this is the
 * other side of the same documents, and the reason it is worth a spec of its own is
 * `core/hexcrawl/features.ts`'s own note — the projection of an unrevealed feature is *the
 * single security-relevant line of the whole hexcrawl feature*. A hidden thing must not be
 * "hidden in the UI": it must not be in the document a player is handed.
 *
 * So this spec authors two features on a hex a player has been shown, one with a picture, and
 * then watches the player's replica across the two ways a feature stops being hidden:
 *
 * 1. **neither revealed** — the player's cell carries no feature rows at all, and the picture
 *    never crossed (the GM's row has an `img`, the player's document does not exist);
 * 2. **the GM's checkbox** — the row arrives *with* its picture, and the player's hex window
 *    draws it;
 * 3. **a rule firing on its own** — an hour spent exploring reveals the `time` feature, the
 *    chat card reaches the table, and the player's ledger gains the hour.
 *
 * That last item settles the other question the new fields raise: `exploredSeconds` is the
 * party's own time, and it rides to the player's replica with the cell. What stays secret is
 * the *rule that reads it*, not the hours.
 *
 * Two contexts and a real join handshake, like `hexcrawl_fog.spec.ts` — this is a slow spec.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  entry,
  hostCall,
  manualFragment,
  playerCall,
  solidPng,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

interface Point {
  x: number;
  y: number;
}

interface CellRow {
  key: string;
  description: string | null;
  playerText: string | null;
  features: number;
  revealedFeatures: number;
  exploredSeconds: number;
  featureRows: Array<{
    id: string;
    name: string;
    rule: string;
    autoReveal: boolean;
    revealed: boolean;
    img: string | null;
  }>;
  open: boolean;
}

const gmCells = (page: Page) => hostCall<CellRow[]>(page, "hexCells");
const playerCells = (page: Page) => playerCall<CellRow[]>(page, "hexCells");

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
    .poll(() => hostCall<{ sceneId?: string } | null>(host, "hexcrawl"), {
      timeout: 20_000,
    })
    .toMatchObject({ enabled: true, width: 1600, height: 1200 });
  const scene = await hostCall<{ sceneId?: string } | null>(host, "hexcrawl");
  if (!scene?.sceneId) throw new Error("the wizard made no scene");
  return scene.sceneId;
}

/** A real manual join: the invite fragment, the offer, the answer, both surfaces up. */
async function joinPlayer(host: Page, player: Page): Promise<void> {
  await host.click("#share");
  const fragment = manualFragment(await host.locator("#invite-link").inputValue());
  await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
  await expect
    .poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 })
    .not.toBe("");
  await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
  await host.click("#code-apply");
  await expect
    .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
    .not.toBe("");
  await player.fill("#answer-input", await host.locator("#share-out").inputValue());
  await player.click("#answer-apply");
  await waitForSurface(player, "playerCanvas");
  await waitForSurface(player, "player");
}

test.describe("what a player holds of a hex (§8 Phase 6 tail, D-275)", () => {
  test("an unrevealed feature never crosses, a revealed one arrives with its picture, and the hour a rule spent is the party's own", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(300_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    await makeHexcrawlScene(host);

    // ── the hex: one east of the party, so no right-click lands on the party token ──
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
      const candidate = await surfaceCallArg<string | null>(host, "app", "hexCellAt", {
        x: partyCentre.x + dx,
        y: partyCentre.y,
      });
      if (candidate && candidate !== partyKey) {
        targetKey = candidate;
        break;
      }
    }
    if (!targetKey) throw new Error("no hex beside the party");
    const targetCentre = await surfaceCallArg<Point | null>(
      host,
      "app",
      "hexCellCenter",
      targetKey,
    );
    if (!targetCentre) throw new Error("no centre for the target cell");
    const targetAt = await surfaceCallArg<Point | null>(host, "app", "screenOf", targetCentre);
    if (!targetAt) throw new Error("no screen point for the target cell");

    const menu = host.locator("[data-hex-menu]");
    const rightClick = async () => {
      await host.mouse.click(targetAt.x, targetAt.y, { button: "right" });
      await expect(menu).toBeVisible();
    };

    // ── 1. the hex window: two texts and two features, one of them with a picture ──
    await rightClick();
    await menu.locator('[data-hex-menu-action="open"]').click();
    const win = host.locator(`[data-hex-window="${targetKey}"]`);
    await expect(win).toBeVisible();
    await win.locator("[data-hex-gm-text]").fill("The barrow gate is sealed with cold iron.");
    await win.locator("[data-hex-gm-text]").blur();
    await win.locator("[data-hex-player-text]").fill("A mossy stone gate stands open.");
    await win.locator("[data-hex-player-text]").blur();

    // Feature A — manual, and it is the GM's checkbox that reveals it.
    await win.locator("[data-hex-feature-name]").fill("a hidden cache");
    await win.locator("[data-hex-feature-add]").click();
    await expect(win.locator("[data-hex-feature-row]")).toHaveCount(1);
    const cacheId = await win
      .locator("[data-hex-feature-row]")
      .first()
      .getAttribute("data-hex-feature-row");
    if (!cacheId) throw new Error("the cache row has no id");
    // The picture goes through the world's asset pipeline, the same import the map wizard uses.
    await win.locator(`[data-hex-feature-image="${cacheId}"]`).setInputFiles({
      name: "cache.png",
      mimeType: "image/png",
      buffer: solidPng(64, 64),
    });
    // The picture only exists once the asset round-trip lands (hash → `resolveAsset` → bytes),
    // so give it a real allowance: on a loaded machine that fetch is slower than the default 5 s.
    await expect(win.locator(`[data-hex-feature-art="${cacheId}"]`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(win.locator("[data-hex-feature-error]")).toHaveCount(0);

    // Feature B — ruled by time: an hour in this hex and it gives itself up.
    await win.locator("[data-hex-feature-name]").fill("the old well");
    await win.locator("[data-hex-feature-rule-input]").selectOption("time");
    await win.locator("[data-hex-feature-seconds]").fill("3600");
    await win.locator("[data-hex-feature-auto-new]").check();
    await win.locator("[data-hex-feature-add]").click();
    await expect(win.locator("[data-hex-feature-row]")).toHaveCount(2);
    const wellId = await win
      .locator("[data-hex-feature-row]")
      .nth(1)
      .getAttribute("data-hex-feature-row");
    if (!wellId) throw new Error("the well row has no id");
    await expect(win.locator(`[data-hex-feature-rule="${wellId}"]`)).toHaveText("1 h spent here");

    // The GM holds both, with the picture on one of them.
    await expect
      .poll(async () => (await gmCells(host))[0]?.featureRows.length)
      .toBe(2);
    const authored = (await gmCells(host))[0];
    expect(authored?.features).toBe(2);
    expect(authored?.revealedFeatures).toBe(0);
    expect(authored?.featureRows.find((f) => f.id === cacheId)?.img).not.toBeNull();
    expect(authored?.exploredSeconds).toBe(0);

    // ── 2. the hex is opened, the player joins ──
    await win.locator("[data-hex-reveal]").click();
    await expect.poll(async () => (await gmCells(host))[0]?.open).toBe(true);
    await joinPlayer(host, player);

    // ── 3. neither feature is revealed: the player's document has no rows at all ──
    // Not "rows the UI hides" — rows that were never sent. The picture is on the GM's machine
    // only, and so is the GM's text.
    await expect
      .poll(async () => (await playerCells(player)).length, { timeout: 90_000 })
      .toBe(1);
    const held = (await playerCells(player))[0];
    expect(held).toMatchObject({
      key: targetKey,
      playerText: "A mossy stone gate stands open.",
      description: null,
      features: 0,
      revealedFeatures: 0,
      exploredSeconds: 0,
      open: true,
    });
    expect(held?.featureRows).toEqual([]);

    // …and the player's own hex window says so, in words.
    const playerCentre = await surfaceCallArg<Point | null>(
      player,
      "player",
      "hexCellCenter",
      targetKey,
    );
    if (!playerCentre) throw new Error("no centre on the player's replica");
    const playerAt = await surfaceCallArg<Point | null>(
      player,
      "playerCanvas",
      "screenOf",
      playerCentre,
    );
    if (!playerAt) throw new Error("no screen point on the player's canvas");
    await player.mouse.click(playerAt.x, playerAt.y, { button: "right" });
    await player.locator('[data-hex-menu-action="open"]').click();
    const playerWin = player.locator(`[data-hex-window="${targetKey}"]`);
    await expect(playerWin).toBeVisible();
    await expect(playerWin.locator("[data-hex-features-empty]")).toBeVisible();

    // ── 4. the GM's checkbox: the row arrives *with* its picture ──
    await host.locator(`[data-hex-feature-reveal="${cacheId}"]`).check();
    // Authored first, delivered second: these are two different bugs, and a failure should say
    // which one it is. (The checkbox is the whole D-275 surface, so it is worth its own wait.)
    await expect(host.locator(`[data-hex-feature-reveal="${cacheId}"]`)).toBeChecked();
    await expect
      .poll(async () => (await gmCells(host))[0]?.revealedFeatures, { timeout: 30_000 })
      .toBe(1);
    // Still open on both sides: a cell the GM closes is not sent to a player at all, so a
    // delivery failure would be indistinguishable from a concealment without this.
    await expect.poll(async () => (await playerCells(player)).length).toBe(1);
    await expect
      .poll(async () => (await playerCells(player))[0]?.features, { timeout: 90_000 })
      .toBe(1);
    const withCache = (await playerCells(player))[0];
    expect(withCache?.revealedFeatures).toBe(1);
    const cacheRow = withCache?.featureRows.find((f) => f.id === cacheId);
    expect(cacheRow).toMatchObject({
      name: "a hidden cache",
      revealed: true,
      rule: "the GM reveals it",
    });
    // The picture crossed with the row: a revealed feature's art is the players' to look at.
    expect(cacheRow?.img).not.toBeNull();
    // …and the player's window draws it: the hash crossed the wire, and the player's own client
    // fetched the bytes behind it (D-276 — the player shell had no resolver at all before).
    await expect(
      playerWin.locator(`[data-hex-feature-art="${cacheId}"]`),
    ).toBeVisible({ timeout: 30_000 });
    // …and the one still hidden is still not in the document.
    expect(withCache?.featureRows.find((f) => f.id === wellId)).toBeUndefined();

    // ── 5. a rule firing on its own: an hour spent here reveals the well, at the table ──
    await rightClick();
    await menu.locator('[data-hex-menu-action="explore"]').click();
    await expect
      .poll(async () => (await gmCells(host))[0]?.revealedFeatures, { timeout: 90_000 })
      .toBe(2);

    // The card is public: a feature the players may hold is not a secret.
    await expect(player.locator("#chat-log")).toContainText(
      `Found at ${targetKey}: the old well`,
    );
    // The player's replica gains the row, and the hour the party spent here rides with the cell.
    await expect
      .poll(async () => (await playerCells(player))[0]?.features, { timeout: 90_000 })
      .toBe(2);
    const both = (await playerCells(player))[0];
    expect(both?.revealedFeatures).toBe(2);
    expect(both?.featureRows.find((f) => f.id === wellId)).toMatchObject({
      name: "the old well",
      revealed: true,
      autoReveal: true,
      rule: "1 h spent here",
    });
    // The ledger is the party's own time — the players were standing there — and it reads the
    // same on both sides of the wire. What stays secret was the rule that was waiting for it.
    expect(both?.exploredSeconds).toBe(3600);
    expect((await gmCells(host))[0]?.exploredSeconds).toBe(3600);

    // A two-peer spec has to give its contexts back: a leaked context leaves a page open behind
    // the next test, and Chromium throttles a page nobody is looking at — which starves the peer
    // link, and is why this spec's propagation step used to fail in a long run and pass alone.
    await hostCtx.close();
    await playerCtx.close();
  });
});
