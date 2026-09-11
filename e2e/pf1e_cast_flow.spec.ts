import { expect, test } from "@playwright/test";
import { entry, waitForSurface, surfaceCallArg } from "./lib";

/**
 * P5/C02 (D-156) — the tactical cast flow through the real bundled chain.
 *
 * The rules layer (DC, natural-1/20 saves, SR with no natural-die cases,
 * severity distinctions, Evasion, ER-after-save order) is pinned by
 * tests/packages/pf1eCasting.test.ts and the flow orchestration by
 * tests/ui/pf1eCastFlow.test.ts with scripted rolls. Only the browser can
 * prove the product path: the Spells tab's cast panel, host-evaluated dice,
 * the resolution card in chat, and the slot/prepared/HP writes landing
 * through Ops.
 *
 * Fixture: an Int 16 prepared wizard whose level-1 ledger is already at its
 * 5-slot budget (4 authored + 1 Table 1-3 bonus), so the very first level-1
 * cast exercises the warn-don't-block overuse path deterministically. The
 * ogre target has Reflex +0, 20 HP.
 */

const wizardSystem = {
  pf1e: {
    abilities: { int: 16 },
    spells: {
      keyAbility: "int",
      mode: "prepared",
      casterLevel: 5,
      slotsPerDay: { 0: 4, 1: 4 },
      slotsUsed: { 1: 5 },
      prepared: [
        { name: "Magic Missile", level: 1 },
        { name: "Shield", level: 1 },
      ],
    },
  },
};

const ogreSystem = {
  pf1e: {
    abilities: { dex: 8, con: 14 },
    hp: 20,
    hpMax: 20,
    saves: { fort: 2, ref: 0, will: 1 },
  },
};

async function importFixture(page: import("@playwright/test").Page) {
  const { strToU8, zipSync } = await import("fflate");
  const manifest = {
    id: "pf-cast-flow-fixture",
    name: "PF Cast Flow Fixture",
    version: "1.0.0",
    type: "data",
    packs: [{ name: "duel", type: "actors", file: "packs/duel.json" }],
  };
  const pack = {
    name: "duel",
    type: "actors",
    entries: [
      {
        id: "pf-wizard",
        name: "PF Wizard",
        data: { type: "actor", name: "PF Wizard", system: wizardSystem },
      },
      {
        id: "pf-ogre",
        name: "PF Ogre",
        data: { type: "actor", name: "PF Ogre", system: ogreSystem },
      },
    ],
  };
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "packs/duel.json": strToU8(JSON.stringify(pack)),
  });
  expect(
    await surfaceCallArg<{ ok: boolean }>(
      page,
      "app",
      "importPackageZip",
      Array.from(zip),
    ),
  ).toMatchObject({ ok: true });
  await page.click('[data-tab="compendia"]');
  await page.locator('[data-entry-id="pf-wizard"] [data-entry-import]').click();
  await page.locator('[data-entry-id="pf-ogre"] [data-entry-import]').click();
  await page.click('[data-tab="actors"]');
  await page
    .locator("#sheet-list .sheet-row")
    .filter({ hasText: "PF Wizard" })
    .click();
}

test.describe("PF1e cast flow: the Spells tab casts through the store (§7/P5 C02)", () => {
  test("a harmless cast expends the slot + prepared row, warns on overuse, and posts a card", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await importFixture(page);

    const sheet = page.locator("#sheets [data-pf1e-sheet]");
    await sheet.getByRole("button", { name: "spells", exact: true }).click();
    const book = sheet.locator("[data-pf1e-spellbook]");

    // The authored ledger already sits at the 5-slot budget for level 1.
    const row1 = book.locator('[data-spell-slot-level="1"]');
    await expect(row1.locator("[data-slot-total]")).toHaveText("5");
    await expect(row1.locator("[data-slot-spent]")).toHaveText("5");

    // Cast the prepared Magic Missile harmlessly (no save, no damage).
    await book.locator('[data-cast-prepared="0"]').click();
    await expect(book.locator("[data-cast-prepared-row]")).toContainText(
      "Magic Missile",
    );
    await book.locator("[data-cast-severity]").selectOption("none");
    await book.locator("[data-cast-damage]").fill("");
    await book.locator("[data-cast-target]").selectOption({ label: "PF Ogre" });
    await book.locator("[data-cast-submit]").click();

    // Overuse is warned, not blocked: spent moves 5 → 6 of 5.
    await expect(book.locator("[data-cast-warning]")).toContainText(
      /over budget/i,
    );
    await expect(row1.locator("[data-slot-spent]")).toHaveText("6");
    // The prepared row is expended and can no longer be picked for a cast.
    await expect(book.locator('[data-prepared-row="0"]')).toContainText(
      "expended",
    );
    await expect(book.locator('[data-cast-prepared="0"]')).toBeDisabled();
    // A resolution card reached chat: the spell name and the no-save line.
    // (#chat-log mounts only while the Chat sidebar tab is active.)
    await page.click('[data-tab="chat"]');
    await expect(page.locator("#chat-log")).toContainText(
      "casts Magic Missile",
    );
    await expect(page.locator("#chat-log")).toContainText(
      "No saving throw is allowed",
    );
    expect(errors).toEqual([]);
  });

  test("a damaging cast rolls host dice and writes the target's HP", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await importFixture(page);

    const sheet = page.locator("#sheets [data-pf1e-sheet]");
    await sheet.getByRole("button", { name: "spells", exact: true }).click();
    const book = sheet.locator("[data-pf1e-spellbook]");

    // Cast Shield as a 2d6 no-save bolt: the roll is random, but its range
    // is not — the ogre (20 HP, no ER) loses 2–12 and the card says by how much.
    await book.locator('[data-cast-prepared="1"]').click();
    await book.locator("[data-cast-severity]").selectOption("none");
    await book.locator("[data-cast-damage]").fill("2d6");
    await book.locator("[data-cast-target]").selectOption({ label: "PF Ogre" });
    await book.locator("[data-cast-submit]").click();

    // The prepared row is expended the moment the cast lands (assert while the
    // sheet is still mounted — a sidebar-tab switch unmounts it).
    await expect(book.locator('[data-prepared-row="1"]')).toContainText(
      "expended",
    );

    // (#chat-log mounts only while the Chat sidebar tab is active.)
    await page.click('[data-tab="chat"]');
    await expect(page.locator("#chat-log")).toContainText("casts Shield");
    await expect
      .poll(async () => {
        const text = (await page.locator("#chat-log").textContent()) ?? "";
        const match = text.match(/PF Ogre 20 → (\d+) HP/);
        return match ? Number(match[1]) : null;
      })
      .not.toBeNull();
    const text = (await page.locator("#chat-log").textContent()) ?? "";
    const match = text.match(/PF Ogre 20 → (\d+) HP/);
    expect(match).not.toBeNull();
    const hpAfter = Number(match?.[1]);
    expect(hpAfter).toBeGreaterThanOrEqual(8); // 20 - max(2d6) = 8
    expect(hpAfter).toBeLessThanOrEqual(18); // 20 - min(2d6) = 18

    // Back to the sheet: the summary readout rides the same persisted ledger
    // (authored 5 + this cast = 6 spent of the 5-slot budget).
    await page.click('[data-tab="actors"]');
    await page
      .locator("#sheet-list .sheet-row")
      .filter({ hasText: "PF Wizard" })
      .click();
    await sheet.getByRole("button", { name: "summary", exact: true }).click();
    await expect(sheet.locator("[data-pf1e-spell-slots]")).toContainText(
      "1st 6/5",
    );
    expect(errors).toEqual([]);
  });

  test("refusals are named and spend nothing: no target, bad dice", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await importFixture(page);

    const sheet = page.locator("#sheets [data-pf1e-sheet]");
    await sheet.getByRole("button", { name: "spells", exact: true }).click();
    const book = sheet.locator("[data-pf1e-spellbook]");

    // Without a target the Cast button never enables.
    await expect(book.locator("[data-cast-submit]")).toBeDisabled();

    // A malformed damage formula is refused before any die rolls.
    await book.locator("[data-cast-name]").fill("Sonic Snap");
    await book.locator("[data-cast-severity]").selectOption("none");
    await book.locator("[data-cast-damage]").fill("3d");
    await book.locator("[data-cast-target]").selectOption({ label: "PF Ogre" });
    await book.locator("[data-cast-submit]").click();
    await expect(book.locator("[data-cast-error]")).toContainText(/NdM/i);
    // Nothing was spent: the ledger still reads its authored 5.
    const row1 = book.locator('[data-spell-slot-level="1"]');
    await expect(row1.locator("[data-slot-spent]")).toHaveText("5");
    expect(errors).toEqual([]);
  });
});
