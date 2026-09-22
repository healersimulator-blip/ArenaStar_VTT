/**
 * §8 Phase 3 (D-272) — encounter tables and their wizard, through the real UI.
 *
 * The unit tests hold the ladder arithmetic (a `%` column that counts faces, a mode switch that
 * refuses to invent weights, a paste that reports what it could not read). What only the browser
 * can prove is the seam the plan asks for at the end of this phase: **a weighted table with a
 * compendium ref, built in the wizard, test-rolled, saved, and read back from the world** — plus
 * the two doors it is reached through (the GM toolbar's *Tables* and a hex's *Attach encounter
 * table…*), and that a save made from a hex also attaches the table to that hex.
 */
import { expect, test } from "@playwright/test";
import {
  entry,
  hostCall,
  importShippedCore,
  solidPng,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

interface TableReadback {
  id: string;
  name: string;
  mode: string;
  formula: string;
  entries: Array<{
    weight: number;
    range: [number, number] | null;
    text: string;
    count: number;
    refs: Array<Record<string, string>>;
  }>;
  tags: Record<string, boolean>;
  sceneId: string | null;
  cooldownSeconds: number | null;
}

interface HexcrawlReadback {
  sceneId: string | null;
  cells: number;
  partyTokenId: string | null;
}

type Point = { x: number; y: number };

// The scene wizard runs the map through the host's asset pipeline before this spec's own work
// starts, and the tables flow is long; the default 30 s is the wizard's alone.
test.setTimeout(180_000);

test.describe("encounter tables (§8 Phase 3, D-272)", () => {
  test("a weighted table with a bestiary ref is authored, test-rolled, saved and read back", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await waitForSurface(page, "gm");
    // The bestiary pack the ref points at — the same import a GM does from the compendia tab.
    await importShippedCore(page);

    // ── a hexcrawl scene, because this phase's second door hangs off a hex ──
    await page.click("#scene-add");
    await page.click("#scene-new-hexcrawl");
    const wizard = page.locator("[data-hexcrawl-wizard]");
    await expect(wizard).toBeVisible();
    await page.setInputFiles("[data-hx-map-input]", {
      name: "overland.png",
      mimeType: "image/png",
      buffer: solidPng(1600, 1200),
    });
    await expect(wizard.locator("[data-hx-map]")).toContainText("1600 × 1200");
    await page.fill("[data-hx-name]", "Table overland");
    await page.click("[data-hx-next]");
    await page.selectOption("[data-hx-grid-type]", "hex");
    await page.selectOption("[data-hx-layout]", "oddQ");
    await page.fill("[data-hx-cell-size]", "100");
    await page.click("[data-hx-next]");
    await page.fill("[data-hx-party-name]", "The Company");
    await page.click("[data-hx-create]");
    await expect(wizard).toBeHidden();
    const hex = await hostCall<HexcrawlReadback | null>(page, "hexcrawl");
    if (!hex) throw new Error("no hexcrawl scene after the wizard");

    // ── door 1: the canvas menu's *Attach encounter table…* opens the tables window for a hex ──
    const partyKey = await hostCall<string | null>(page, "hexPartyKey");
    if (!partyKey) throw new Error("the party token is not on a cell");
    const partyCentre = await surfaceCallArg<Point | null>(
      page,
      "app",
      "hexCellCenter",
      partyKey,
    );
    if (!partyCentre) throw new Error("no centre for the party's cell");
    let targetKey: string | null = null;
    for (const dx of [150, -150, 200, 100, 75]) {
      const candidate = await surfaceCallArg<string | null>(
        page,
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
    if (!targetKey) throw new Error("no hex beside the party");
    const targetCentre = await surfaceCallArg<Point | null>(
      page,
      "app",
      "hexCellCenter",
      targetKey,
    );
    if (!targetCentre) throw new Error("no centre for the target cell");
    const targetAt = await surfaceCallArg<Point | null>(
      page,
      "app",
      "screenOf",
      targetCentre,
    );
    if (!targetAt) throw new Error("no screen point for the target cell");

    await page.mouse.click(targetAt.x, targetAt.y, { button: "right" });
    const menu = page.locator("[data-hex-menu]");
    await expect(menu).toBeVisible();
    await menu.locator('[data-hex-menu-action="attach"]').click();

    const tablesWindow = page
      .locator("[data-window]")
      .filter({ has: page.locator("[data-encounter-tables]") });
    await expect(tablesWindow).toBeVisible();
    await expect(tablesWindow.locator("[data-tables-title]")).toHaveText(
      `Tables for hex ${targetKey}`,
    );
    await expect(tablesWindow.locator("[data-tables-empty]")).toBeVisible();

    // ── the wizard, opened from the hex: saving here must also attach ──
    await tablesWindow.locator("[data-tables-new]").click();
    const tableWizard = page
      .locator("[data-window]")
      .filter({ has: page.locator("[data-table-wizard]") });
    await expect(tableWizard).toBeVisible();
    await tableWizard.locator("[data-table-name]").fill("Forest road — day");
    await expect(tableWizard.locator("[data-table-attach-note]")).toContainText(
      `hex ${targetKey}`,
    );

    // ── two rows, the second pointing at a bestiary entry ──
    await tableWizard.locator('[data-table-weight="0"]').fill("30");
    await tableWizard.locator('[data-table-text="0"]').fill("Goblin bandits");
    await tableWizard.locator('[data-table-count="0"]').fill("3");
    await tableWizard.locator("[data-table-add-row]").click();
    await tableWizard.locator('[data-table-weight="1"]').fill("70");
    await tableWizard
      .locator('[data-table-text="1"]')
      .fill("Dire wolves, hunting");
    await tableWizard.locator('[data-table-count="1"]').fill("2");
    // The `%` column is the compiled ladder, live.
    await expect(tableWizard.locator('[data-table-percent="0"]')).toHaveText(
      "30 %",
    );
    await expect(tableWizard.locator('[data-table-percent="1"]')).toHaveText(
      "70 %",
    );
    await expect(tableWizard.locator("[data-table-total]")).toHaveText(
      "total 100 %",
    );

    await tableWizard.locator('[data-table-ref-bestiary="1"]').click();
    const picker = tableWizard.locator("[data-table-picker]");
    await expect(picker).toBeVisible();
    // The shipped bestiary is a mass-battle bestiary: "dire wolf" is a real entry in it
    // (`dire-wolf` / "Dire Wolf Pack"), which is what the saved ref must name.
    await picker.locator("[data-picker-search]").fill("dire wolf");
    const firstEntry = picker.locator("[data-picker-row]").first();
    await expect(firstEntry).toContainText("Dire Wolf Pack");
    await firstEntry.locator("[data-add-compendium-entry]").click();
    await expect(picker).toBeHidden();
    await expect(
      tableWizard.locator('[data-table-ref-line="1"]'),
    ).toContainText("PF1e Bestiary");

    // ── tags: night off for this table (requirement 5's per-tag opt-out) ──
    await tableWizard.locator('[data-table-tag="night"]').uncheck();
    await expect(
      tableWizard.locator('[data-table-tag="night"]'),
    ).not.toBeChecked();
    await expect(tableWizard.locator('[data-table-tag="day"]')).toBeChecked();

    // ── Test roll: the real engine, the results window in preview, nothing written ──
    await tableWizard.locator("[data-table-test]").click();
    const result = page
      .locator("[data-window]")
      .filter({ has: page.locator("[data-encounter-result]") });
    await expect(result).toBeVisible();
    await expect(result.locator("[data-result-preview]")).toBeVisible();
    await expect(result.locator("[data-result-roll]")).toContainText("1d100 →");
    await expect(result.locator("[data-result-table]")).toHaveText(
      "Forest road — day",
    );
    // Nothing was saved by the test roll.
    expect(
      await hostCall<TableReadback[]>(page, "encounterTables"),
    ).toHaveLength(0);
    // Close it again: it sits over the canvas, and the map's right-click has to land on the map.
    await result.locator("[data-window-close]").click();
    await expect(result).toBeHidden();

    // ── Save: one create, one attach; the wizard closes ──
    await tableWizard.locator("[data-table-save]").click();
    await expect(tableWizard).toBeHidden();
    // The attach half lands in the window that opened the wizard, as a checked row.
    await expect(tablesWindow.locator("[data-tables-attach]")).toHaveCount(1);

    const stored = await hostCall<TableReadback[]>(page, "encounterTables");
    expect(stored).toHaveLength(1);
    const table = stored[0];
    if (!table) throw new Error("no table in the world after save");
    expect(table.name).toBe("Forest road — day");
    expect(table.mode).toBe("weighted");
    expect(table.entries.map((e) => [e.weight, e.text, e.count])).toEqual([
      [30, "Goblin bandits", 3],
      [70, "Dire wolves, hunting", 2],
    ]);
    expect(table.entries[1]?.refs).toEqual([
      { kind: "compendium", packId: "PF1e Bestiary", entryId: "dire-wolf" },
    ]);
    expect(table.tags).toMatchObject({ day: true, night: false });
    expect(table.cooldownSeconds).toBeNull();

    // The attach half of the save crossed too: the hex window lists the table. (The tables
    // window must be closed first — it sits over the canvas where the right-click has to land.)
    await expect(tablesWindow.locator("[data-tables-attach]")).toBeChecked();
    await tablesWindow.locator("[data-window-close]").click();
    await page.mouse.click(targetAt.x, targetAt.y, { button: "right" });
    await menu.locator('[data-hex-menu-action="open"]').click();
    const hexWindow = page
      .locator("[data-window]")
      .filter({ has: page.locator(`[data-hex-window="${targetKey}"]`) });
    await expect(
      hexWindow.locator(`[data-hex-table-row="${table.id}"]`),
    ).toContainText("Forest road — day");
    // The tag chips read the same story in the hex window: night off is *visible*.
    await expect(
      hexWindow.locator(`[data-hex-tag="${table.id}:night"]`),
    ).toHaveClass(/off/);
    await expect(
      hexWindow.locator(`[data-hex-tag="${table.id}:day"]`),
    ).not.toHaveClass(/off/);

    // ── door 2: the GM toolbar's Tables lists the same table, with its summary ──
    await hexWindow.locator("[data-window-close]").click();
    await page.click("#gm-tables");
    const library = page
      .locator("[data-window]")
      .filter({ has: page.locator("[data-encounter-tables]") });
    await expect(library.locator("[data-tables-title]")).toHaveText(
      "Encounter tables",
    );
    await expect(
      library.locator(`[data-tables-summary="${table.id}"]`),
    ).toContainText("weighted %");
    await expect(
      library.locator(`[data-tables-summary="${table.id}"]`),
    ).toContainText("off: night");
  });
});
