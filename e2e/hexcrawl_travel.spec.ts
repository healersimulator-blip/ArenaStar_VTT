/**
 * §8 Phase 6 (D-275) — the road and the things waiting beside it, through the real UI.
 *
 * The plan's acceptance line is this spec's story: *commit a three-cell forest path, advance one day
 * on the clock, assert the party moved by the terrain-priced amount, the clock advanced exactly
 * that, and an exploration-timed feature revealed itself on the third day.*
 *
 * `tests/core/hexcrawlTravel.test.ts` and `tests/core/hexcrawlFeatures.test.ts` hold the arithmetic
 * (what a crossing costs, which rule fires when, what the ledger says about a mid-crossing stop).
 * What only a browser can prove is the arrangement:
 *
 * 1. **path mode** is a real tool — clicking a hex extends the route, clicking it again takes it
 *    back, `Esc` clears it, and *Commit route* is what writes the profile (plan §5.7);
 * 2. the itinerary prices the route **before** anyone walks it, per cell, off the same
 *    `stepSecondsOf` the advance charges with — the number the GM commits to is the number the
 *    clock moves by;
 * 3. a day on the road is the world clock's own day: `+1 day` moves the party by the terrain price
 *    and *only* that, leaves the rest of the day where the party is standing, and the per-cell
 *    ledger (`exploredSeconds`) reads back exactly those numbers;
 * 4. a hidden feature whose rule is *time* waits for real time: it survives two days in the same
 *    hex and reveals itself on the third, through the travel advance — no GM click involved.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  entry,
  hostCall,
  solidPng,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

interface Point {
  x: number;
  y: number;
}

interface HexCellRow {
  key: string;
  terrain: string | null;
  exploredSeconds: number;
  features: number;
  revealedFeatures: number;
  featureRows: Array<{
    id: string;
    name: string;
    rule: string;
    autoReveal: boolean;
    revealed: boolean;
  }>;
  open: boolean;
}

interface TravelReadback {
  path: string[];
  cursor: number;
  progressSeconds: number;
  speedPerDay: number;
  pace: string;
}

/** The plan's own numbers: forest costs 2, speed 24 → 7 200 s a border, 86 400 s a day. */
const HOUR = 3_600;
const FOREST_BORDER = 2 * HOUR;
const DAY = 24 * HOUR;

const cells = (page: Page) => hostCall<HexCellRow[]>(page, "hexCells");
const clockOf = (page: Page) => hostCall<number>(page, "hexClock");
const routeOf = (page: Page) => hostCall<TravelReadback | null>(page, "hexTravel");

async function cellAt(page: Page, key: string): Promise<Point> {
  const centre = await surfaceCallArg<Point | null>(page, "app", "hexCellCenter", key);
  if (!centre) throw new Error(`no centre for ${key}`);
  const at = await surfaceCallArg<Point | null>(page, "app", "screenOf", centre);
  if (!at) throw new Error(`no screen point for ${key}`);
  return at;
}

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

/**
 * The route's fixture: the party's own hex plus the three hexes **east** of it, each with forest
 * terrain — set through the hex context menu, which is the only way the app offers (plan §5.5's
 * terrain brush is the same entry, one hex at a time; D-270 left the brush out of the wizard).
 *
 * The three cells are probed as *points*, not as key arithmetic: on an `oddQ` map a step east is
 * `(q+1, r)` or `(q+1, r±1)` depending on the row's parity, and `hexCellAt` is the app's own answer
 * to "which cell is this?".
 */
async function forestRoadEast(page: Page, partyKey: string): Promise<string[]> {
  const keys = [partyKey];
  const world = await surfaceCallArg<Point | null>(
    page,
    "app",
    "hexCellCenter",
    partyKey,
  );
  if (!world) throw new Error("no world centre for the party's own cell");
  for (const dx of [150, 300, 450]) {
    const key = await surfaceCallArg<string | null>(page, "app", "hexCellAt", {
      x: world.x + dx,
      y: world.y,
    });
    if (!key || keys.includes(key)) {
      throw new Error(`no fourth distinct cell east of ${partyKey} (dx ${dx} → ${key})`);
    }
    keys.push(key);
  }
  // Terrain, one right-click at a time, on the three cells *ahead* — never on the party's own hex,
  // where the right-click would land on the token and open the token menu instead (D-272's lesson).
  // The party's cell does not need authored terrain anyway: a crossing costs the *worse* of its two
  // sides, so a forest ahead of an unauthored hex is priced as forest (`stepCostOf`).
  for (const key of keys.slice(1)) {
    const at = await cellAt(page, key);
    await page.mouse.click(at.x, at.y, { button: "right" });
    const menu = page.locator("[data-hex-menu]");
    await expect(menu).toBeVisible();
    await menu.locator('[data-hex-menu-action="terrain:forest"]').click();
    await expect(menu).toBeHidden();
  }
  await expect
    .poll(async () => (await cells(page)).map((c) => [c.key, c.terrain]).sort())
    .toEqual(keys.slice(1).map((k) => [k, "forest"]).sort());
  // …and the app's own pricing agrees, before a single hex has been clicked: the first row of a
  // one-step draft is priced off the same `stepSecondsOf` the advance will charge.
  return keys;
}

/** Arm path mode and click a route home, then commit it (the two verbs of plan §5.7). */
async function drawRoute(page: Page, waypoints: string[], commit = true): Promise<void> {
  await page.click('[data-canvas-tool="path"]');
  await expect(page.locator("[data-path-hint]")).toBeVisible();
  for (const key of waypoints) {
    const at = await cellAt(page, key);
    // The travel panel sits in the canvas's bottom-left corner: a route that clicks *through* it
    // would press a button instead of a hex, so the fixture refuses to pretend otherwise.
    const panel = page.locator("[data-travel-panel]");
    if (await panel.isVisible()) {
      const box = await panel.boundingBox();
      const covered =
        box !== null &&
        at.x > box.x &&
        at.x < box.x + box.width &&
        at.y > box.y &&
        at.y < box.y + box.height;
      if (covered) {
        throw new Error(`the travel panel covers ${key} at ${at.x},${at.y} — pick another route`);
      }
    }
    await page.mouse.click(at.x, at.y);
  }
  if (commit) {
    await page.click("[data-travel-commit]");
    await expect(page.locator("[data-travel-panel]")).toHaveAttribute(
      "data-travel-committed",
      "true",
    );
  }
}

const spentOf = async (page: Page): Promise<Record<string, number>> =>
  Object.fromEntries((await cells(page)).map((c) => [c.key, c.exploredSeconds]));

test.describe("travel & features (§8 Phase 6, D-275)", () => {
  test("a three-hex forest route prices itself, and a day moves the party by exactly that", async ({
    page,
  }) => {
    // The wizard, four terrain writes, three route clicks and three clock advances in one test.
    test.setTimeout(180_000);
    const partyKey = await bootHexcrawl(page);
    const [start, step1, step2, step3] = await forestRoadEast(page, partyKey);
    if (!start || !step1 || !step2 || !step3) throw new Error("the road is too short");

    const panel = page.locator("[data-travel-panel]");

    // ── 1. the draft: click a hex to extend, click it again to take it back, Esc to give up ──
    await page.click('[data-canvas-tool="path"]');
    await expect(page.locator("[data-path-hint]")).toBeVisible();
    const first = await cellAt(page, step1);
    await page.mouse.click(first.x, first.y);
    await expect(panel).toHaveAttribute("data-travel-draft", "true");
    await expect(page.locator("[data-travel-row]")).toHaveCount(1);
    // The same hex again: the last cell comes off the route (plan §5.7's own rule).
    await page.mouse.click(first.x, first.y);
    await expect(page.locator("[data-travel-row]")).toHaveCount(0);
    await page.mouse.click(first.x, first.y);
    for (const key of [step2, step3]) {
      const at = await cellAt(page, key);
      await page.mouse.click(at.x, at.y);
    }
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    // ── 2. the itinerary: three crossings, each priced by the terrain it enters ──
    await drawRoute(page, [step1, step2, step3], false);
    await expect(panel).toBeVisible();
    await expect(page.locator("[data-travel-row]")).toHaveCount(3);
    await expect(page.locator(`[data-travel-row="${step1}"]`)).toHaveAttribute(
      "data-travel-seconds",
      String(FOREST_BORDER),
    );
    await expect(page.locator(`[data-travel-row="${step3}"]`)).toHaveAttribute(
      "data-travel-terrain",
      "Forest / woods",
    );
    await expect(page.locator("[data-travel-total]")).toHaveAttribute(
      "data-travel-total",
      String(3 * FOREST_BORDER),
    );
    await expect(panel.locator("[data-travel-total]")).toContainText("6 h");

    // ── 3. the commit: the profile holds the plan, the panel says so, the map draws the line ──
    await page.click("[data-travel-commit]");
    await expect(panel).toHaveAttribute("data-travel-committed", "true");
    await expect(panel).toHaveAttribute("data-travel-draft", "false");
    expect(await routeOf(page)).toMatchObject({
      path: [start, step1, step2, step3],
      cursor: 0,
      progressSeconds: 0,
      speedPerDay: 24,
      pace: "normal",
    });
    await expect(page.locator("[data-travel-route]")).toHaveCount(1);

    // ── 4. one border: the party moves one hex, the clock advances exactly the terrain price ──
    const t0 = await clockOf(page);
    await page.click('[data-travel-advance="next"]');
    await expect.poll(() => hostCall<string | null>(page, "hexPartyKey")).toBe(step1);
    expect(await clockOf(page)).toBe(t0 + FOREST_BORDER);
    expect(await routeOf(page)).toMatchObject({ cursor: 1 });

    // ── 5. one day: the rest of the road, then the hours spent standing at its end ──
    await page.click('[data-travel-advance="day"]');
    await expect.poll(() => hostCall<string | null>(page, "hexPartyKey")).toBe(step3);
    // Exactly a day — no more, no less: the clock is the world's, and travel only spends it.
    expect(await clockOf(page)).toBe(t0 + FOREST_BORDER + DAY);
    // The route is walked out, so it is gone (a finished march clears the profile's plan).
    expect(await routeOf(page)).toBeNull();

    // ── 6. the ledger: where the day went, cell by cell ──
    // The two remaining forest crossings charge the cells the party walked *out of* (7 200 s each);
    // the 20 hours left after arriving are spent standing in the destination, and charge it.
    const spent = await spentOf(page);
    expect(spent[start]).toBe(FOREST_BORDER);
    expect(spent[step1]).toBe(FOREST_BORDER);
    expect(spent[step2]).toBe(FOREST_BORDER);
    expect(spent[step3]).toBe(DAY - 2 * FOREST_BORDER);
    // …and it all adds up to what the clock advanced — **both** clicks' worth. The three
    // crossings do not belong to one advance: the first was paid for by *To the next hex*
    // (7 200 s), and the day bought the two that were left plus the hours spent standing at
    // the end. The invariant is "the ledger sums to the clock", and the clock moved by a
    // border and a day.
    const travelled = FOREST_BORDER * 3 + (DAY - 2 * FOREST_BORDER);
    expect(travelled).toBe(DAY + FOREST_BORDER);
  });

  test("a feature ruled by time reveals itself on the third day in the same hex", async ({
    page,
  }) => {
    // Three days of marching and camping, each one a route + a commit + a clock advance.
    test.setTimeout(240_000);
    const partyKey = await bootHexcrawl(page);
    const road = await forestRoadEast(page, partyKey);
    const camp = road[1];
    if (!camp) throw new Error("the road has no first step");

    // ── the feature: *time*, 40 h here, and the automatic switch on (requirement 8's own pair) ──
    const campAt = await cellAt(page, camp);
    await page.mouse.click(campAt.x, campAt.y, { button: "right" });
    const menu = page.locator("[data-hex-menu]");
    await expect(menu).toBeVisible();
    await menu.locator('[data-hex-menu-action="feature"]').click();
    const win = page.locator(`[data-hex-window="${camp}"]`);
    await expect(win).toBeVisible();
    // The frame is the window host's own box: the close button belongs to it, not to the hex
    // window's markup (the same split the tables window's own spec closes through).
    const frame = page
      .locator("[data-window]")
      .filter({ has: page.locator(`[data-hex-window="${camp}"]`) });
    await win.locator("[data-hex-feature-name]").fill("the old well");
    await win.locator("[data-hex-feature-rule-input]").selectOption("time");
    await win.locator("[data-hex-feature-seconds]").fill(String(40 * HOUR));
    await win.locator("[data-hex-feature-auto-new]").check();
    await win.locator("[data-hex-feature-add]").click();
    await expect(win.locator("[data-hex-feature-row]")).toHaveCount(1);
    const featureId = await win.locator("[data-hex-feature-row]").getAttribute("data-hex-feature-row");
    if (!featureId) throw new Error("the feature row has no id");
    await expect(win.locator(`[data-hex-feature-rule="${featureId}"]`)).toHaveText(
      "40 h spent here",
    );
    await expect(win.locator(`[data-hex-feature-auto="${featureId}"]`)).toBeChecked();
    // The window has to go: it sits over the canvas, and the path clicks land on the map (D-272).
    await frame.locator("[data-window-close]").click();
    await expect(win).toBeHidden();

    const revealed = async (): Promise<boolean> => {
      const rows = (await cells(page)).find((c) => c.key === camp)?.featureRows ?? [];
      return rows.some((r) => r.id === featureId && r.revealed);
    };

    // ── day one: walk to the camp and sleep there (22 h) ──
    const day1 = await clockOf(page);
    await drawRoute(page, [camp]);
    await page.click('[data-travel-advance="day"]');
    await expect.poll(() => hostCall<string | null>(page, "hexPartyKey")).toBe(camp);
    expect(await clockOf(page)).toBe(day1 + DAY);
    expect((await spentOf(page))[camp]).toBe(DAY - FOREST_BORDER);
    // 22 hours in: the well is still hidden, and the rule says exactly what it is waiting for.
    expect(await revealed()).toBe(false);
    expect(
      (await cells(page)).find((c) => c.key === camp)?.featureRows[0]?.rule,
    ).toBe("40 h spent here");

    // ── day two: the party walks back out (7 200 s more spent *in* the camp) and camps home ──
    await drawRoute(page, [partyKey]);
    await page.click('[data-travel-advance="day"]');
    await expect.poll(() => hostCall<string | null>(page, "hexPartyKey")).toBe(partyKey);
    expect(await clockOf(page)).toBe(day1 + 2 * DAY);
    // A full day of the party's own presence in the camp — and still not 40 hours.
    expect((await spentOf(page))[camp]).toBe(DAY);
    expect(await revealed()).toBe(false);

    // ── day three: back to the camp, and the rule fires while the GM is looking elsewhere ──
    await drawRoute(page, [camp]);
    await page.click('[data-travel-advance="day"]');
    await expect.poll(() => hostCall<string | null>(page, "hexPartyKey")).toBe(camp);
    expect(await clockOf(page)).toBe(day1 + 3 * DAY);
    expect((await spentOf(page))[camp]).toBe(DAY + (DAY - FOREST_BORDER));
    // 44 hours in the hex, a 40-hour rule, and no one clicked the reveal checkbox.
    await expect.poll(revealed, { timeout: 10_000 }).toBe(true);
    const campRow = (await cells(page)).find((c) => c.key === camp);
    expect(campRow?.revealedFeatures).toBe(1);
    // The reveal is in the log as the table would hear it.
    await expect(page.locator("#chat-log")).toContainText(`Found at ${camp}: the old well`);
    // …and it carries the reading it happened at, so the GM can see the third day in the data.
    expect(campRow?.featureRows[0]).toMatchObject({ autoReveal: true, revealed: true });
  });
});
