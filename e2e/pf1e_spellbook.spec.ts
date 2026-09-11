import { expect, test } from "@playwright/test";
import { entry, waitForSurface, surfaceCallArg } from "./lib";

/**
 * P5/C04 (D-155) — the persisted slot ledger + prepared list through the real
 * bundled chain.
 *
 * The rules layer (Table 1-3, the `10 + spell level` minimum, over-budget
 * warnings) is pinned by tests/packages/pf1eSpellSlots.test.ts and the edit
 * builders by tests/ui/pf1eSpellbook.test.ts. Only the browser can prove that
 * the sheet's own adapters reach those rules: (1) the `pf1eSpellSlots` surface
 * projects an authored `slotsUsed`/`prepared` block, and (2) the Spells tab's
 * Spend/Restore/Prepare controls round-trip through Ops into the store.
 *
 * Running example: a 5th-level wizard, Intelligence 16 (+3). Table 1-3 grants
 * one bonus spell at every level whose minimum score (10 + level) fits in 16,
 * i.e. levels 1–6. With the authored CRB-style budget 4/4/4/3/2 at levels 0–4,
 * totals read 4 / 5 / 5 / 4 / 3.
 */

const wizardSystem = (spells: Record<string, unknown> = {}) => ({
  pf1e: {
    abilities: { int: 16 },
    spells: {
      keyAbility: "int",
      mode: "prepared",
      casterLevel: 5,
      slotsPerDay: { 0: 4, 1: 4, 2: 4, 3: 3, 4: 2 },
      ...spells,
    },
  },
});

interface SlotsRow {
  level: number;
  text: string;
  over: boolean;
  total: number | null;
  spent: number;
}
interface SlotsResult {
  summary: string;
  rows: SlotsRow[];
  warnings: string[];
}

const slots = (page: import("@playwright/test").Page, system: unknown) =>
  page.evaluate((sys) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      { pf1eSpellSlots: (x: unknown) => SlotsResult } | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eSpellSlots({ system: sys });
  }, system);

test.describe("PF1e spellbook: persisted ledger + prepared list (§7/P5 C04)", () => {
  test("the readout adapter projects authored slotsUsed and prepared counts", async ({
    page,
  }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (e) => runtimeErrors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    const res = await slots(
      page,
      wizardSystem({
        slotsUsed: { 1: 2 },
        prepared: [
          { name: "Magic Missile", level: 1 },
          { name: "Magic Missile", level: 1 },
          { name: "Invisibility", level: 2 },
        ],
      }),
    );
    // Int 16: bonus spells at levels 1–6 → 1st-level total is 4 + 1 = 5.
    expect(res.summary).toContain("1st 2/5");
    const first = res.rows.find((r) => r.level === 1);
    expect(first).toMatchObject({ total: 5, spent: 2 });
    expect(first?.text).toBe("2/5 · 2 prepared");
    expect(res.warnings).toEqual([]);
    expect(runtimeErrors).toEqual([]);
  });

  test("an over-budget ledger projects as a warning, never as a refusal", async ({
    page,
  }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (e) => runtimeErrors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    const res = await slots(page, wizardSystem({ slotsUsed: { 1: 6 } }));
    const first = res.rows.find((r) => r.level === 1);
    expect(first).toMatchObject({ total: 5, spent: 6, over: true });
    expect(res.warnings.join(" ")).toMatch(/over budget/i);
    expect(runtimeErrors).toEqual([]);
  });

  test("the Spells tab spends, restores, prepares and expends through the store", async ({
    page,
  }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (e) => runtimeErrors.push(e.message));
    const { strToU8, zipSync } = await import("fflate");
    const manifest = {
      id: "pf-spellbook-fixture",
      name: "PF Spellbook Fixture",
      version: "1.0.0",
      type: "data",
      packs: [{ name: "casters", type: "actors", file: "packs/casters.json" }],
    };
    const pack = {
      name: "casters",
      type: "actors",
      entries: [
        {
          id: "pf-wizard",
          name: "PF Wizard",
          data: {
            type: "actor",
            name: "PF Wizard",
            system: wizardSystem({
              prepared: [{ name: "Shield", level: 1 }],
            }),
          },
        },
      ],
    };
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "packs/casters.json": strToU8(JSON.stringify(pack)),
    });
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    expect(
      await surfaceCallArg<{ ok: boolean }>(
        page,
        "app",
        "importPackageZip",
        Array.from(zip),
      ),
    ).toMatchObject({ ok: true });
    await page.click('[data-tab="compendia"]');
    await page
      .locator('[data-entry-id="pf-wizard"] [data-entry-import]')
      .click();
    await page.click('[data-tab="actors"]');
    await page
      .locator("#sheet-list .sheet-row")
      .filter({ hasText: "PF Wizard" })
      .click();

    const sheet = page.locator("#sheets [data-pf1e-sheet]");
    // The tab only exists for casters.
    await expect(
      sheet.getByRole("button", { name: "spells", exact: true }),
    ).toBeVisible();
    await sheet.getByRole("button", { name: "spells", exact: true }).click();
    const book = sheet.locator("[data-pf1e-spellbook]");

    // Int 16 bonus math surfaces in the tab: 1st level totals 5 (4 + 1).
    const row1 = book.locator('[data-spell-slot-level="1"]');
    await expect(row1.locator("[data-slot-total]")).toHaveText("5");
    await expect(row1.locator("[data-slot-spent]")).toHaveText("0");
    await expect(row1.locator("[data-slot-remaining]")).toHaveText("5");

    // Spend twice, restore once — all round-trip through Ops.
    await row1.locator("[data-slot-spend]").click();
    await expect(row1.locator("[data-slot-spent]")).toHaveText("1");
    await row1.locator("[data-slot-spend]").click();
    await expect(row1.locator("[data-slot-spent]")).toHaveText("2");
    await row1.locator("[data-slot-restore]").click();
    await expect(row1.locator("[data-slot-spent]")).toHaveText("1");

    // Overuse is warned, not blocked: spend up to and past the budget of 5.
    for (let i = 0; i < 4; i += 1) {
      await row1.locator("[data-slot-spend]").click();
    }
    await expect(row1.locator("[data-slot-spent]")).toHaveText("5");
    await row1.locator("[data-slot-spend]").click();
    await expect(row1.locator("[data-slot-spent]")).toHaveText("6");
    await expect(book.locator("[data-spellbook-warning]")).toContainText(
      /over budget/i,
    );

    // The authored preparation is present; prepare one more, expend, remove.
    await expect(book.locator("[data-prepared-row]")).toHaveCount(1);
    await expect(book.locator('[data-prepared-row="0"]')).toContainText(
      "Shield",
    );
    await book.locator("[data-prepare-name]").fill("Magic Missile");
    await book.locator("[data-prepare-level]").selectOption("1");
    await book.locator("[data-prepare-submit]").click();
    await expect(book.locator("[data-prepared-row]")).toHaveCount(2);
    await expect(book.locator('[data-prepared-row="1"]')).toContainText(
      "Magic Missile",
    );

    await book.locator('[data-prepared-expended="1"]').check();
    await expect(book.locator('[data-prepared-row="1"]')).toContainText(
      "expended",
    );
    await book.locator('[data-prepared-remove="1"]').click();
    await expect(book.locator("[data-prepared-row]")).toHaveCount(1);
    await expect(book.locator('[data-prepared-row="0"]')).toContainText(
      "Shield",
    );

    // The summary tab's readout rides the same persisted ledger.
    await sheet.getByRole("button", { name: "summary", exact: true }).click();
    await expect(sheet.locator("[data-pf1e-spell-slots]")).toContainText(
      "1st 6/5",
    );

    expect(runtimeErrors).toEqual([]);
  });

  test("a non-caster has no Spells tab", async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on("pageerror", (e) => runtimeErrors.push(e.message));
    const { strToU8, zipSync } = await import("fflate");
    const manifest = {
      id: "pf-mundane-fixture",
      name: "PF Mundane Fixture",
      version: "1.0.0",
      type: "data",
      packs: [{ name: "folk", type: "actors", file: "packs/folk.json" }],
    };
    const pack = {
      name: "folk",
      type: "actors",
      entries: [
        {
          id: "pf-commoner",
          name: "PF Commoner",
          data: {
            type: "actor",
            name: "PF Commoner",
            system: { pf1e: { abilities: { str: 12 } } },
          },
        },
      ],
    };
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
      "packs/folk.json": strToU8(JSON.stringify(pack)),
    });
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    expect(
      await surfaceCallArg<{ ok: boolean }>(
        page,
        "app",
        "importPackageZip",
        Array.from(zip),
      ),
    ).toMatchObject({ ok: true });
    await page.click('[data-tab="compendia"]');
    await page
      .locator('[data-entry-id="pf-commoner"] [data-entry-import]')
      .click();
    await page.click('[data-tab="actors"]');
    await page
      .locator("#sheet-list .sheet-row")
      .filter({ hasText: "PF Commoner" })
      .click();
    const sheet = page.locator("#sheets [data-pf1e-sheet]");
    await expect(sheet.locator("[data-pf1e-ac]")).toBeVisible();
    await expect(
      sheet.getByRole("button", { name: "spells", exact: true }),
    ).toHaveCount(0);
    expect(runtimeErrors).toEqual([]);
  });
});
