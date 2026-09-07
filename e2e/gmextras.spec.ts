import { expect, test } from "@playwright/test";
import { entry } from "./lib";

interface GmSnapshot {
  armies: number;
  factions: number;
  units: number;
  pendingOrders: number;
  strengths: number[];
  allyLists: Record<string, string[]>;
}

type GmMethod =
  | "armySnapshot"
  | "rectCount"
  | "sceneScale"
  | "godView"
  | "viewAsFaction"
  | "simCount"
  | "turnPhase";

/** Surface methods must run inside evaluate — functions cannot cross the wire. */
async function gmCall<T>(page: import("@playwright/test").Page, method: GmMethod): Promise<T> {
  return page.evaluate((m) => {
    const sfc = (globalThis as unknown as { __vttE2E?: { gm?: unknown } }).__vttE2E;
    const surface = sfc?.gm as Record<string, (() => T) | undefined> | undefined;
    if (!surface) throw new Error("gm e2e surface not installed");
    const fn = surface[m];
    if (!fn) throw new Error("gm surface method missing: " + m);
    return fn();
  }, method);
}

async function gm(page: import("@playwright/test").Page): Promise<GmSnapshot> {
  return gmCall<GmSnapshot>(page, "armySnapshot");
}

test.describe("GM extras + strategic fog (§9A)", () => {
  test("faction editor, mass spawn, casualty, batch orders", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await page.click("#gm-extras");
    const win = page.locator('[data-window="gmextras"]');
    await expect(win).toBeVisible();

    // bootstrap world ships no factions — create two so the ally matrix exists
    const before = await gm(page);
    expect(before.factions).toBe(0);
    await page.fill("#faction-name", "Red Host");
    await page.click("#faction-create");
    await page.fill("#faction-name", "Third Army");
    await page.click("#faction-create");
    await expect.poll(() => gm(page).then((s) => s.factions)).toBe(2);
    const rows = win.locator("[data-faction-rows] tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("Third Army");

    // --- ally toggle: with two factions each row shows one ally checkbox
    const redAllyBox = rows.nth(0).locator("input[type=checkbox]").first();
    await redAllyBox.check();
    await expect(redAllyBox).toBeChecked();
    await expect
      .poll(() => gm(page).then((s) => Object.values(s.allyLists).some((a) => a.length === 1)))
      .toBe(true);
    await redAllyBox.uncheck();
    await expect
      .poll(() => gm(page).then((s) => Object.values(s.allyLists).every((a) => a.length === 0)))
      .toBe(true);

    // --- mass spawn: one army + one unit doc, strength = count
    const factionId = await win.locator("[data-spawn-faction]").inputValue();
    expect(factionId).not.toBe("");
    await page.fill("[data-spawn-name]", "Vanguard Host");
    await page.fill("[data-spawn-count]", "20");
    await page.click("#mass-spawn");
    await expect.poll(() => gm(page).then((s) => s.armies)).toBe(1);
    const afterSpawn = await gm(page);
    expect(afterSpawn.units).toBe(1);
    expect(afterSpawn.strengths).toEqual([20]);

    // --- casualty: apply −3 to the spawned unit (strength 20 → 17)
    await win.locator("[data-adjust-unit]").selectOption({ index: 0 });
    await page.fill("[data-adjust-delta]", "-3");
    await page.click("#apply-adjust");
    await expect.poll(() => gm(page).then((s) => s.strengths)).toEqual([17]);

    // heal back (+3) and confirm the op clamps at zero for oversize hits
    await page.fill("[data-adjust-delta]", "3");
    await page.click("#apply-adjust");
    await expect.poll(() => gm(page).then((s) => s.strengths)).toEqual([20]);
    await page.fill("[data-adjust-delta]", "-999");
    await page.click("#apply-adjust");
    await expect.poll(() => gm(page).then((s) => s.strengths)).toEqual([0]);

    // --- batch orders: templates disabled until a unit is selected, then land
    const templateBtn = win.locator("[data-batch-template]").first();
    await expect(templateBtn).toBeDisabled();
    await win.locator("[data-unit-check]").first().check();
    await expect(templateBtn).toBeEnabled();
    await templateBtn.click();
    await expect.poll(() => gm(page).then((s) => s.pendingOrders)).toBeGreaterThanOrEqual(1);
  });

  test("strategic fog gates: scale flag, god view, faction preview (D-080)", async ({ page }) => {
    await page.goto(entry + "?e2e=1");

    // set the active scene to strategic scale via the settings editor (D-080)
    await page.click("#gm-settings");
    const settings = page.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    await settings.locator("[data-scene-scale]").selectOption("strategic");
    await expect.poll(() => gmCall<string>(page, "sceneScale")).toBe("strategic");

    // drag the settings window clear so it cannot cover the GM extras panel
    const tb = await settings.locator(".wm-title").boundingBox();
    if (!tb) throw new Error("no settings title box");
    await page.mouse.move(tb.x + 60, tb.y + 10);
    await page.mouse.down();
    await page.mouse.move(tb.x + 420, tb.y + 200, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    // open GM extras; create two factions and spawn one army for each
    await page.click("#gm-extras");
    const win = page.locator('[data-window="gmextras"]');
    await expect(win).toBeVisible();
    await page.fill("#faction-name", "Obsidian Pact");
    await page.click("#faction-create");
    await page.fill("#faction-name", "Amber Legion");
    await page.click("#faction-create");
    await expect.poll(() => gm(page).then((s) => s.factions)).toBe(2);

    // one 20-model army per faction (mass spawn creates army+unit docs)
    const spawnFaction = win.locator("[data-spawn-faction]");
    for (let i = 0; i < 2; i++) {
      await spawnFaction.selectOption({ index: i });
      await page.fill("[data-spawn-count]", "20");
      await page.click("#mass-spawn");
    }
    await expect.poll(() => gm(page).then((s) => s.armies)).toBe(2);

    // §8A start (D-081): deployment materializes 40 models + broadcasts the
    // snapshot to the GM client; advance/next drive a full stepwise turn
    await expect(win.locator("#campaign-start")).toBeEnabled();
    await page.click("#campaign-start");
    await expect.poll(() => gmCall<number>(page, "simCount")).toBe(40);
    await expect.poll(() => gmCall<string>(page, "turnPhase")).toBe("orders");
    await page.click("[data-campaign-advance]");
    await expect.poll(() => gmCall<string>(page, "turnPhase")).toBe("report");
    await page.click("[data-campaign-next]");
    await expect.poll(() => gmCall<string>(page, "turnPhase")).toBe("orders");

    // god view is the default: nothing is covered even with models deployed
    await expect.poll(() => gmCall<boolean>(page, "godView")).toBe(true);
    await expect.poll(() => gmCall<number>(page, "rectCount")).toBe(0);

    // switch off god view and preview a faction: deployed enemies + the
    // undetected map go dark (300ms fog timer)
    await win.locator("#god-view").uncheck();
    const factionId = await win.locator("[data-view-faction] option").nth(1).getAttribute("value");
    expect(factionId).toBeTruthy();
    await win.locator("[data-view-faction]").selectOption(factionId as string);
    await expect.poll(() => gmCall<string>(page, "viewAsFaction")).toBe(factionId);
    await expect
      .poll(() => gmCall<number>(page, "rectCount"), { timeout: 10_000 })
      .toBeGreaterThan(0);

    // god view back on clears the cover
    await win.locator("#god-view").check();
    await expect.poll(() => gmCall<number>(page, "rectCount")).toBe(0);

    // scale flag back to tactical (setting persists through the same op path)
    await settings.locator("[data-scene-scale]").selectOption("tactical");
    await expect.poll(() => gmCall<string>(page, "sceneScale")).toBe("tactical");
  });
});
