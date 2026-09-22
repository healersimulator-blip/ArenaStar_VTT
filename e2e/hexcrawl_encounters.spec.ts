/**
 * §8 Phase 4 (D-273) — the encounter engine, through both real shells.
 *
 * The plan's own acceptance line is this spec's story: *with `prompt` mode, walking the party into
 * a tagged hex posts a GM-only card naming the eligible table; the player shell never receives it;
 * clicking it rolls and produces the results window.*
 *
 * The unit suite (`tests/core/hexcrawlEncounterFlow.test.ts`) holds the arithmetic: which tables
 * are eligible at which phase, what the cooldown does to a second crossing, what a card carries.
 * What only two browsers can prove is the arrangement the feature is built out of:
 *
 * 1. the trigger really fires from a **drag** — the ops listener, not a handler the test called;
 * 2. the pending card is a *whisper*, so it is in the GM's log and **absent from the player's
 *    replica entirely** (not hidden by CSS);
 * 3. answering it writes the ledger (the same `cell.flags.core.encounters` the next crossing
 *    reads) and opens the results window with the roll the table's ladder produced;
 * 4. a second crossing of the same border stays quiet — the cooldown is real play, not a model.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  entry,
  hostCall,
  importShippedCore,
  manualFragment,
  solidPng,
  surfaceCallArg,
  surfaceCallArgs,
  waitForSurface,
} from "./lib";

interface Point {
  x: number;
  y: number;
}

interface HexcrawlReadback {
  sceneId: string | null;
  enabled: boolean;
  width: number;
  height: number;
  partyTokenId: string | null;
}

interface HexCellRow {
  key: string;
  name: string;
  terrain: string | null;
  tables: number;
  open: boolean;
}

interface TableReadback {
  id: string;
  name: string;
  entries: Array<{ weight: number; text: string; count: number }>;
  tags: Record<string, boolean>;
}

const gmCells = (page: Page) => hostCall<HexCellRow[]>(page, "hexCells");

interface SceneChildren {
  id: string;
  name: string;
  active: boolean;
  img: string | null;
  width: number;
  height: number;
  tokens: Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    actorId: string | null;
    disposition: string;
    img: string;
  }>;
  walls: Array<{ id: string; c: [number, number, number, number]; door: number }>;
  counts: Record<string, number>;
}

const sceneChildren = (page: Page, id?: string) =>
  surfaceCallArg<SceneChildren | null>(page, "app", "sceneChildren", id);

/** The only phase-free setup there is: the scene wizard (identical to the Phase 2/3 specs). */
async function makeHexcrawlScene(host: Page): Promise<string> {
  await host.goto(entry + "?e2e=1");
  await waitForSurface(host, "app");
  return createHexcrawlScene(host);
}

/** The wizard alone, for a page that is already booted (and may already hold a scene). */
async function createHexcrawlScene(host: Page): Promise<string> {
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
  await host.click("[data-hx-next]");
  await host.fill("[data-hx-party-name]", "The Company");
  await host.click("[data-hx-create]");
  await expect
    .poll(() => hostCall<HexcrawlReadback | null>(host, "hexcrawl"), { timeout: 20_000 })
    .toMatchObject({ enabled: true, width: 1600, height: 1200 });
  const scene = await hostCall<HexcrawlReadback | null>(host, "hexcrawl");
  if (!scene?.sceneId) throw new Error("the wizard made no scene");
  return scene.sceneId;
}

/** A hex next to the party's, and its screen point (the same scan the Phase 3 spec uses). */
async function hexBesideParty(host: Page): Promise<{ key: string; at: Point; centre: Point }> {
  const partyKey = await hostCall<string | null>(host, "hexPartyKey");
  if (!partyKey) throw new Error("the party token is not on a cell");
  const partyCentre = await surfaceCallArg<Point | null>(
    host,
    "app",
    "hexCellCenter",
    partyKey,
  );
  if (!partyCentre) throw new Error("no centre for the party's cell");
  for (const dx of [150, -150, 200, 100, 75]) {
    const key = await surfaceCallArg<string | null>(host, "app", "hexCellAt", {
      x: partyCentre.x + dx,
      y: partyCentre.y,
    });
    if (key && key !== partyKey) {
      const centre = await surfaceCallArg<Point | null>(host, "app", "hexCellCenter", key);
      const at = centre
        ? await surfaceCallArg<Point | null>(host, "app", "screenOf", centre)
        : null;
      if (centre && at) return { key, at, centre };
    }
  }
  throw new Error("no hex beside the party");
}

/**
 * The Phase 3 flow, one row: *Attach encounter table…* from the hex menu, a 100 % single-entry
 * table in the wizard, saved (which attaches it), then the hex opened to the table — encounters
 * fire where the players can be, and `isCellOpen` is the gate on the engine's side.
 */
async function attachTable(
  host: Page,
  target: { key: string; at: Point },
  opts: { linkScene?: string; bestiaryRef?: boolean } = {},
): Promise<TableReadback> {
  await host.mouse.click(target.at.x, target.at.y, { button: "right" });
  const menu = host.locator("[data-hex-menu]");
  await expect(menu).toBeVisible();
  // D-273 moved this line: the entry is live, and it opens the hex window (whose rows roll).
  await expect(menu.locator('[data-hex-menu-action="roll"]')).toBeEnabled();
  await menu.locator('[data-hex-menu-action="attach"]').click();
  const tablesWindow = host
    .locator("[data-window]")
    .filter({ has: host.locator("[data-encounter-tables]") });
  await expect(tablesWindow).toBeVisible();
  await tablesWindow.locator("[data-tables-new]").click();
  const wizard = host
    .locator("[data-window]")
    .filter({ has: host.locator("[data-table-wizard]") });
  await expect(wizard).toBeVisible();
  await wizard.locator("[data-table-name]").fill("Goblin scouts");
  await wizard.locator('[data-table-weight="0"]').fill("100");
  await wizard.locator('[data-table-text="0"]').fill("Goblin scouts");
  await wizard.locator('[data-table-count="0"]').fill("2");
  if (opts.bestiaryRef) {
    // A *placeable* row: requirement 5c's second kind of result (a bestiary entity link), picked
    // through the real picker — the shipped mass-battle bestiary's "Dire Wolf Pack".
    await wizard.locator('[data-table-ref-bestiary="0"]').click();
    const picker = wizard.locator("[data-table-picker]");
    await expect(picker).toBeVisible();
    await picker.locator("[data-picker-search]").fill("dire wolf");
    const first = picker.locator("[data-picker-row]").first();
    await expect(first).toContainText("Dire Wolf Pack");
    await first.locator("[data-add-compendium-entry]").click();
    await expect(picker).toBeHidden();
  }
  if (opts.linkScene) await wizard.locator("[data-table-scene]").selectOption({ label: opts.linkScene });
  await wizard.locator("[data-table-save]").click();
  await expect(wizard).toBeHidden();
  await expect(tablesWindow.locator("[data-tables-attach]")).toBeChecked();
  // Then the window has to go: it sits over the canvas, and the party drag lands on the map.
  await tablesWindow.locator("[data-window-close]").click();
  await expect(tablesWindow).toBeHidden();

  const stored = await hostCall<TableReadback[]>(host, "encounterTables");
  expect(stored).toHaveLength(1);
  const table = stored[0];
  if (!table) throw new Error("no table in the world after save");
  // Every tag is on by default (requirement 5), so this table is eligible day *and* night, on
  // every trigger — the specs are free to trigger it by walk, explore or fight.
  expect(table.tags).toMatchObject({
    day: true,
    night: true,
    entering: true,
    moving: true,
    exploring: true,
    fighting: true,
  });

  await host.mouse.click(target.at.x, target.at.y, { button: "right" });
  await menu.locator('[data-hex-menu-action="reveal"]').click();
  await expect
    .poll(async () => (await gmCells(host)).find((c) => c.key === target.key)?.open)
    .toBe(true);
  return table;
}

/** One real drag of the party token; the engine hears it through the ops listener, not a call. */
async function dragParty(host: Page, to: Point): Promise<void> {
  const from = await hostCall<Point | null>(host, "hexPartyPoint");
  if (!from) throw new Error("the party token is not on the map");
  const fromAt = await surfaceCallArg<Point | null>(host, "app", "screenOf", from);
  if (!fromAt) throw new Error("no screen point for the party token");
  await host.mouse.move(fromAt.x, fromAt.y);
  await host.mouse.down();
  await host.mouse.move(to.x, to.y, { steps: 12 });
  await host.mouse.up();
}

test.describe("encounter engine (§8 Phase 4, D-273)", () => {
  test("prompt mode: the GM's card, the player's silence, the roll and the results window", async ({
    browser,
  }) => {
    // The scene wizard, a real peer join and a whole encounter cycle: three slow things in a row.
    test.setTimeout(300_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    await makeHexcrawlScene(host);
    const startKey = await hostCall<string | null>(host, "hexPartyKey");
    if (!startKey) throw new Error("the party token is not on a cell");
    const startCentre = await surfaceCallArg<Point | null>(
      host,
      "app",
      "hexCellCenter",
      startKey,
    );
    if (!startCentre) throw new Error("no centre for the party's own cell");
    const startAt = await surfaceCallArg<Point | null>(host, "app", "screenOf", startCentre);
    if (!startAt) throw new Error("no screen point for the party's own cell");
    // Move the world clock off zero **before** anything fires: a ledger stamp of 0 would prove
    // only that the reading existed, and the plan's cooldown arithmetic (`rest of the phase`) is
    // anchored on real readings. One hour is enough to tell the stamp from the default.
    await host.click("#gm-settings");
    const settings = host.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    await settings.locator("[data-clock-hour]").click();
    await expect(settings.locator("[data-clock-readout]")).toContainText("01:00");
    // …and it has to go again: a window over the canvas eats the right-click (D-272's lesson).
    await settings.locator("[data-window-close]").click();
    await expect(settings).toBeHidden();

    const target = await hexBesideParty(host);

    // ── 1. a table on that hex, authored from the hex menu, and the hex opened to the table ──
    const table = await attachTable(host, target);
    const tableId = table.id;

    // ── 3. the player joins **before** the crossing, so the whisper has a real victim ──
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
    await expect(player.locator("#chat-log")).toBeVisible();

    // ── 4. the crossing: one real drag, and the engine is the ops listener's business ──
    await dragParty(host, target.at);
    await expect
      .poll(() => hostCall<string | null>(host, "hexPartyKey"), { timeout: 20_000 })
      .toBe(target.key);

    // The GM's card: a *pending* message naming the eligible table, in the log where the table
    // already looks.
    const card = host.locator('[data-encounter-card="prompt"]').first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toHaveAttribute("data-encounter-gm-only", "true");
    await expect(card).toHaveAttribute("data-encounter-cell", target.key);
    await expect(card.locator("[data-encounter-candidates-count]")).toHaveText("1 eligible");
    await expect(card.locator("[data-encounter-candidate]").first()).toContainText(
      "Goblin scouts",
    );

    // …and the player's replica never held it: not hidden, absent (the projection rule).
    await expect(player.locator("[data-encounter-card]")).toHaveCount(0);
    await expect(player.locator("#chat-log")).not.toContainText("Encounter check");

    // ── 5. answering it: the roll, the ledger, and the results window (§8's own sentence) ──
    await card.locator(`[data-encounter-roll="${tableId}"]`).click();

    const result = host
      .locator("[data-window]")
      .filter({ has: host.locator("[data-encounter-result]") });
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result.locator("[data-result-table]")).toHaveText("Goblin scouts");
    await expect(result.locator("[data-result-cell]")).toHaveText(`hex ${target.key}`);
    // The ladder is a single-entry 100 % table, so the draw is the only entry — and the roll is
    // shown as the formula's own reading.
    await expect(result.locator("[data-result-roll]")).toContainText("1d100 →");
    await expect(result.locator("[data-result-text]")).toHaveText("Goblin scouts");

    // The card that asked is answered, and the GM's own result card is in the log (GM-only: the
    // prompt was, and the players have not been told what is standing in the hex yet).
    await expect(card).toHaveAttribute("data-encounter-answered", "true");
    const gmResult = host.locator('[data-encounter-card="result"]').first();
    await expect(gmResult).toBeVisible();
    await expect(gmResult).toHaveAttribute("data-encounter-gm-only", "true");
    await expect(player.locator('[data-encounter-card="result"]')).toHaveCount(0);

    // The ledger is the cell's own flags — the reason the next crossing is quiet.
    await result.locator("[data-result-close]").click();
    await expect(result).toBeHidden();

    const ledger = await hostCall<
      Array<{ cellKey: string; tableId: string; atClock: number }>
    >(host, "hexEncounterLedger");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.cellKey).toBe(target.key);
    expect(ledger[0]?.tableId).toBe(tableId);
    // The stamp is the world clock's own reading (the scene was made at zero, the spec advanced
    // one hour before the crossing): the cooldown is anchored in game time, not in wall time.
    expect(ledger[0]?.atClock).toBe(3600);

    // ── 6. the cooldown, in real play: leave and come back, and nothing new is posted ──
    await dragParty(host, startAt);
    await expect
      .poll(() => hostCall<string | null>(host, "hexPartyKey"), { timeout: 20_000 })
      .toBe(startKey);
    const cardsBefore = await host.locator('[data-encounter-card="prompt"]').count();

    await dragParty(host, target.at);
    await expect
      .poll(() => hostCall<string | null>(host, "hexPartyKey"), { timeout: 20_000 })
      .toBe(target.key);
    // The same border, crossed again inside the table's cooldown: no second card — and the ledger
    // is still the one entry the answering wrote.
    await host.waitForTimeout(1_500);
    await expect(host.locator('[data-encounter-card="prompt"]')).toHaveCount(cardsBefore);
    expect(
      await hostCall<Array<{ cellKey: string }>>(host, "hexEncounterLedger"),
    ).toHaveLength(1);

    await hostCtx.close();
    await playerCtx.close();
  });

  /**
   * The other half of requirement 5a: in `manual` mode the engine does **nothing on its own**
   * (plan §6 rule 6) — the hex window's rows are the trigger. Two claims, one scene: walking into
   * the hex posts no card at all, and a row rolls the table with the same ledger write the `auto`
   * path uses, so the same hex cannot then fire a second time.
   */
  test("manual mode: walking in stays quiet, and the hex window's row is the trigger", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await makeHexcrawlScene(page);

    // The scene says how it plays: *Encounters → the GM rolls by hand*.
    await page.click("#gm-settings");
    const settings = page.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    await settings.locator("[data-hex-encounter-mode]").selectOption("manual");
    await settings.locator("[data-window-close]").click();
    await expect(settings).toBeHidden();

    const target = await hexBesideParty(page);
    const table = await attachTable(page, target);

    // ── the canvas menu's *Roll from a table…* leads to the window whose rows roll ──
    await page.mouse.click(target.at.x, target.at.y, { button: "right" });
    const menu = page.locator("[data-hex-menu]");
    await expect(menu).toBeVisible();
    await menu.locator('[data-hex-menu-action="roll"]').click();
    const hexWindow = page
      .locator("[data-window]")
      .filter({ has: page.locator(`[data-hex-window="${target.key}"]`) });
    await expect(hexWindow).toBeVisible();
    await expect(hexWindow.locator("[data-hex-encounter-mode]")).toHaveAttribute(
      "data-hex-encounter-mode",
      "manual",
    );
    await expect(hexWindow.locator("[data-hex-roll]")).toBeEnabled();

    await hexWindow.locator(`[data-hex-roll="${table.id}"]`).click();
    const result = page
      .locator("[data-window]")
      .filter({ has: page.locator("[data-encounter-result]") });
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result.locator("[data-result-table]")).toHaveText("Goblin scouts");
    await expect(result.locator("[data-result-cell]")).toHaveText(`hex ${target.key}`);

    // A manual roll is the GM's own, so its card is a *public* one — as public as `auto`'s, with
    // the creature names revealed by the scene's default flag.
    const card = page.locator('[data-encounter-card="result"]').first();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-encounter-gm-only", "false");
    await expect(card.locator("[data-encounter-table]")).toHaveText("Goblin scouts");
    await expect(card.locator("[data-encounter-text]")).toHaveText("Goblin scouts");

    const ledger = await hostCall<Array<{ cellKey: string; tableId: string; atClock: number }>>(
      page,
      "hexEncounterLedger",
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.cellKey).toBe(target.key);
    expect(ledger[0]?.tableId).toBe(table.id);

    // ── and now the walk: manual mode posts nothing, even though the table is right there ──
    await result.locator("[data-result-close]").click();
    await expect(result).toBeHidden();
    await hexWindow.locator("[data-window-close]").click();
    await expect(hexWindow).toBeHidden();
    await dragParty(page, target.at);
    await expect
      .poll(() => hostCall<string | null>(page, "hexPartyKey"), { timeout: 20_000 })
      .toBe(target.key);
    await page.waitForTimeout(1_500);
    await expect(page.locator('[data-encounter-card="prompt"]')).toHaveCount(0);
    expect(
      await hostCall<Array<{ cellKey: string }>>(page, "hexEncounterLedger"),
    ).toHaveLength(1);
  });

  /**
   * Requirement 5c/5d, plan §8 Phase 5's own acceptance line: *roll a two-entry table, `Place all`,
   * assert both tokens exist and are not co-located (distance ≥ one cell), then create the battle
   * scene and assert the copy has the original's walls and the new tokens.*
   *
   * The unit suite holds the geometry (`placeEncounterTokens`' spiral, `duplicateSceneOps`'
   * re-keying). What only the browser can prove is that the *gestures* reach it: the window's button
   * to the shell's op envelope, the copy becoming the active scene, and the origin hex remembering
   * where the fight went.
   */
  test("place all and the linked battle scene: tokens on the map, a copy with walls and creatures", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    // The pack the roll's row points at (the same import a GM does from the compendia tab).
    await importShippedCore(page);

    // ── the battle scene to link: the default scene, with a wall drawn on it ──
    // (Drawn first, the way `canvas_rail.spec.ts` does it: the wall tool's listeners belong to the
    // stage the boot built, and the wizard's scene swap is not what this assertion is about.)
    const box = await page.locator(".canvas-host canvas").boundingBox();
    if (!box) throw new Error("canvas not mounted");
    await page.locator('[data-canvas-tool="wall"]').click();
    await page.locator('[data-canvas-wall-kind="wall"]').click();
    await page.mouse.move(box.x + 240, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 420, box.y + 200, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => hostCall<Array<{ id: string }>>(page, "walls")).toHaveLength(1);
    // Put the wall tool away again: a right-click on the map is the hex menu only while nothing is
    // armed (the rail's own rule, and D-272's lesson about a window eating the next gesture).
    await page.locator('[data-canvas-tool="select"]').click();
    const battleSceneId = (await sceneChildren(page))?.id ?? "";
    const battleName = (await sceneChildren(page, battleSceneId))?.name ?? "";
    expect(battleSceneId).not.toBe("");
    expect(battleName).not.toBe("");

    // ── the hexcrawl map, and a table on one of its hexes that links that scene ──
    const hexcrawlId = await createHexcrawlScene(page);
    expect(hexcrawlId).not.toBe(battleSceneId);
    // ── back to the hexcrawl map, with a table that links that scene ──
    await expect
      .poll(() => hostCall<HexcrawlReadback | null>(page, "hexcrawl"))
      .toMatchObject({ enabled: true });
    const target = await hexBesideParty(page);
    const table = await attachTable(page, target, { linkScene: battleName, bestiaryRef: true });

    // ── roll it by hand from the hex window (the Phase 4 path, one click) ──
    await page.mouse.click(target.at.x, target.at.y, { button: "right" });
    const menu = page.locator("[data-hex-menu]");
    await expect(menu).toBeVisible();
    await menu.locator('[data-hex-menu-action="roll"]').click();
    const hexWindow = page
      .locator("[data-window]")
      .filter({ has: page.locator(`[data-hex-window="${target.key}"]`) });
    await expect(hexWindow).toBeVisible();
    await hexWindow.locator(`[data-hex-roll="${table.id}"]`).click();
    const result = page
      .locator("[data-window]")
      .filter({ has: page.locator("[data-encounter-result]") });
    await expect(result).toBeVisible({ timeout: 20_000 });

    // ── Place all: two creatures (count 2), one token each, at least a cell apart ──
    const before = await sceneChildren(page);
    const placed = await result.locator("[data-result-place-all]");
    await expect(placed).toBeEnabled();
    await placed.click();
    await expect
      .poll(async () => (await sceneChildren(page))?.tokens.length ?? 0, { timeout: 20_000 })
      .toBe((before?.tokens.length ?? 0) + 2);
    const after = await sceneChildren(page);
    const fresh = (after?.tokens ?? []).filter((t) => !(before?.tokens ?? []).some((b) => b.id === t.id));
    // The row is a bestiary link, so each token is a *real actor* the sheet opens from (§5.5's
    // "the same create path a compendium drag uses") — not a picture of one.
    expect(fresh.map((t) => t.name)).toEqual(["Dire Wolf Pack", "Dire Wolf Pack"]);
    expect(fresh.every((t) => t.disposition === "hostile")).toBe(true);
    expect(fresh.every((t) => t.actorId !== null)).toBe(true);
    const [a, b] = fresh;
    if (!a || !b) throw new Error("expected two placed tokens");
    // The requirement's "not in one spot": at least one grid cell (100 px here) apart.
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(100);

    // ── Create battle scene: the copy carries the wall and the creatures ──
    const sceneIdsNow = (): Promise<string[]> =>
      page
        .locator(".scenenav [data-scene]")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-scene") ?? ""));
    const sceneCountBefore = await page.locator(".scenenav [data-scene]").count();
    const sceneIdsBefore = await sceneIdsNow();
    const battle = result.locator("[data-result-battle-scene]");
    await expect(battle).toBeEnabled();
    await battle.click();
    await expect(result.locator("[data-result-battle-confirm]")).toBeVisible();
    await result.locator("[data-result-battle-yes]").click();

    await expect
      .poll(async () => (await page.locator(".scenenav [data-scene]").count()), {
        timeout: 20_000,
      })
      .toBe(sceneCountBefore + 1);
    const copyId = (await sceneIdsNow()).find((id) => !sceneIdsBefore.includes(id));
    if (!copyId) throw new Error("no copied battle scene appeared");
    const copy = await sceneChildren(page, copyId);
    expect(copy?.name).toBe("Goblin scouts — encounter");
    expect(copy?.active).toBe(true);
    // The original's wall travelled, re-keyed, and so did the map image (by asset hash — a copy
    // shares the bytes rather than duplicating them, which is the one thing §5.6 is emphatic about).
    expect(copy?.walls).toHaveLength(1);
    expect(copy?.walls[0]?.c).toEqual((await sceneChildren(page, battleSceneId))?.walls[0]?.c);
    expect(copy?.walls[0]?.id).not.toBe((await sceneChildren(page, battleSceneId))?.walls[0]?.id);
    expect(copy?.img).toBe((await sceneChildren(page, battleSceneId))?.img ?? null);
    // …and the encounter's own creatures are in it, at least a cell apart, as in the original.
    const copyEncounter = (copy?.tokens ?? []).filter((t) => t.name === "Dire Wolf Pack");
    expect(copyEncounter).toHaveLength(2);
    expect(
      Math.hypot(
        (copyEncounter[0]?.x ?? 0) - (copyEncounter[1]?.x ?? 0),
        (copyEncounter[0]?.y ?? 0) - (copyEncounter[1]?.y ?? 0),
      ),
    ).toBeGreaterThanOrEqual(100);

    // The origin hex remembers the fight, so the return trip is one click (§5.6's own note).
    const log = await surfaceCallArgs<Array<{ sceneId: string | null; text: string }>>(
      page,
      "app",
      "hexEncounterLog",
      [target.key, hexcrawlId],
    );
    expect(log.at(-1)?.sceneId).toBe(copyId);
    // The row's own line, as it was written when the encounter happened — not the entity's name.
    expect(log.at(-1)?.text).toBe("Goblin scouts");

    // ── And the click back: the hex window lists the log, and its scene row opens the copy ──
    // Put the results window away — it sits over the hex window. The hex window itself is still
    // open from the roll, and it already knows: the log refreshes off the ops bus, so the battle
    // scene's row is there without reopening anything.
    await result.locator("[data-result-close]").click();
    await expect(result).toBeHidden();
    const logRow = hexWindow.locator("[data-hex-encounter-row]").last();
    await expect(logRow).toContainText("Goblin scouts");
    await logRow.locator("[data-hex-encounter-open]").click();
    await expect
      .poll(() => sceneChildren(page).then((sc) => sc?.id ?? ""))
      .toBe(copyId);
    await expect
      .poll(async () => (await sceneChildren(page, hexcrawlId))?.active)
      .toBe(false);
  });
});
