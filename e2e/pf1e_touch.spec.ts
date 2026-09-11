import { expect, test } from "@playwright/test";
import { entry, waitForSurface, surfaceCallArg } from "./lib";

/**
 * P5/C03 touch spells and held charges (D-158) through the real bundled
 * chain. The touch attack die is random in e2e, so the touch cast test
 * branches on the card's own narration; the dissipation test is fully
 * deterministic. Rules arithmetic is pinned by tests/ui/pf1eTouchFlow.test.ts
 * and the pure layer by tests/packages/pf1eTouchSpell.test.ts.
 *
 * Fixture: the D-156 wizard (level-1 ledger at its 5-slot budget) gains a
 * prepared Shocking Grasp and an authored held Chill Touch charge; the ogre's
 * Dex 8 gives it touch AC 9.
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
        { name: "Shocking Grasp", level: 1 },
      ],
    },
    heldCharge: {
      name: "Chill Touch",
      level: 1,
      damageFormula: "",
      saveType: "ref",
      severity: "none",
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
    id: "pf-touch-fixture",
    name: "PF Touch Fixture",
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

test.describe("PF1e touch spells: held charges ride the actor document (§7/P5 C03, D-158)", () => {
  test("casting another spell dissipates the held charge", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await importFixture(page);

    const sheet = page.locator("#sheets [data-pf1e-sheet]");
    await sheet.getByRole("button", { name: "spells", exact: true }).click();
    const book = sheet.locator("[data-pf1e-spellbook]");

    // The authored charge is visible before the cast.
    await expect(book.locator("[data-held-charge]")).toContainText(
      "Chill Touch",
    );

    // A normal (non-touch) cast dissipates it: "If you cast another spell,
    // the touch spell dissipates."
    await book.locator('[data-cast-prepared="0"]').click();
    await book.locator("[data-cast-severity]").selectOption("none");
    await book.locator("[data-cast-damage]").fill("");
    await book.locator("[data-cast-target]").selectOption({ label: "PF Ogre" });
    await book.locator("[data-cast-submit]").click();

    await expect(book.locator("[data-cast-warning]")).toContainText(
      /dissipates/i,
    );
    await expect(book.locator("[data-held-charge]")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a touch cast spends the slot, then holds or delivers the charge", async ({
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
    const row1 = book.locator('[data-spell-slot-level="1"]');

    // The authored Chill Touch charge is held first; the touch cast below
    // replaces it either way (dissipation + possible new charge).
    await expect(book.locator("[data-held-charge]")).toContainText(
      "Chill Touch",
    );

    // Cast Shocking Grasp as a melee touch spell (harmless payload, so the
    // only die in play is the touch attack itself).
    await book.locator('[data-cast-prepared="1"]').click();
    await book.locator("[data-cast-touch]").selectOption("melee");
    await book.locator("[data-cast-severity]").selectOption("none");
    await book.locator("[data-cast-damage]").fill("");
    await book.locator("[data-cast-target]").selectOption({ label: "PF Ogre" });
    await book.locator("[data-cast-submit]").click();

    // Spent either way: the slot was consumed with the casting (5 → 6 of 5).
    await expect(row1.locator("[data-slot-spent]")).toHaveText("6");
    await expect(book.locator('[data-prepared-row="1"]')).toContainText(
      "expended",
    );

    // The card narrates the touch attack; which branch landed is random.
    await page.click('[data-tab="chat"]');
    const chat = await page.locator("#chat-log").textContent();
    expect(chat).toContain("casts Shocking Grasp");
    expect(chat).toMatch(/Melee touch attack \d+ vs touch AC 9/);
    const held = chat?.includes("The charge is held");

    // Back to the sheet: the held-charge panel matches the card.
    await page.click('[data-tab="actors"]');
    await page
      .locator("#sheet-list .sheet-row")
      .filter({ hasText: "PF Wizard" })
      .click();
    await sheet.getByRole("button", { name: "spells", exact: true }).click();
    if (held) {
      await expect(book.locator("[data-held-charge]")).toContainText(
        "Shocking Grasp",
      );
      // Deliver it: hit or miss, the panel state follows the card.
      await book
        .locator("[data-cast-target]")
        .selectOption({ label: "PF Ogre" });
      await book.locator("[data-held-deliver]").click();
      await page.click('[data-tab="chat"]');
      const delivery = await page.locator("#chat-log").textContent();
      const delivered = delivery?.includes("delivers the held Shocking Grasp");
      expect(delivery).toMatch(/delivers the held Shocking Grasp|still held/);
      await page.click('[data-tab="actors"]');
      await page
        .locator("#sheet-list .sheet-row")
        .filter({ hasText: "PF Wizard" })
        .click();
      await sheet.getByRole("button", { name: "spells", exact: true }).click();
      await expect(book.locator("[data-held-charge]")).toHaveCount(
        delivered ? 0 : 1,
      );
      // Whatever remains, the GM can dissipate it.
      if (!delivered) {
        await book.locator("[data-held-dismiss]").click();
        await expect(book.locator("[data-held-charge]")).toHaveCount(0);
      }
    } else {
      await expect(book.locator("[data-held-charge]")).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
});
