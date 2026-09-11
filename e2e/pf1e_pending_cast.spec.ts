import { expect, test } from "@playwright/test";
import { entry, waitForSurface, surfaceCallArg } from "./lib";

/**
 * P5/C03 multi-round casting (D-161) through the real bundled chain.
 * Every cast here is severity-none with no damage dice, so the whole test is
 * deterministic — the only die a longer casting can provoke is the
 * disruption check, which the 100-damage declaration makes unwinnable
 * (DC 111 vs a best-case +8). Rules arithmetic is pinned by
 * tests/ui/pf1ePendingCastFlow.test.ts and the pure layer by
 * tests/packages/pf1ePendingCast.test.ts.
 *
 * Fixture: the D-156 wizard (level-1 ledger at its 4-slot budget) prepares
 * Magic Missile (V, S) and Shield; the ogre is a harmless target.
 */

const wizardSystem = {
  pf1e: {
    abilities: { int: 16 },
    spells: {
      keyAbility: "int",
      mode: "prepared",
      casterLevel: 5,
      slotsPerDay: { 1: 4 },
      prepared: [
        { name: "Magic Missile", level: 1, components: "V, S" },
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
    id: "pf-pending-fixture",
    name: "PF Pending Fixture",
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

test.describe("PF1e multi-round casting: begin, disrupt, complete (§7/P5 C03, D-161)", () => {
  test("a longer casting defers the effect, loses to disruption, and completes on demand", async ({
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

    // 1. Begin: the slot and prepared row are spent, the effect is deferred.
    await book.locator('[data-cast-prepared="0"]').click();
    await book.locator("[data-cast-time]").selectOption("longer");
    await book.locator("[data-cast-severity]").selectOption("none");
    await book.locator("[data-cast-damage]").fill("");
    await book.locator("[data-cast-target]").selectOption({ label: "PF Ogre" });
    await book.locator("[data-cast-submit]").click();

    await expect(row1.locator("[data-slot-spent]")).toHaveText("1");
    await expect(book.locator('[data-prepared-row="0"]')).toContainText(
      "expended",
    );
    await expect(book.locator("[data-pending-cast]")).toContainText(
      "Magic Missile",
    );
    await expect(book.locator("[data-cast-warning]")).toContainText(
      /casting has begun/i,
    );

    await page.click('[data-tab="chat"]');
    let chat = await page.locator("#chat-log").textContent();
    expect(chat).toContain("begins casting Magic Missile");
    expect(chat).toMatch(/just before their next turn/);
    expect(chat).not.toContain("casts Magic Missile");

    // 2. Disrupt: 100 damage → DC 111, unwinnable for +8. The spell is lost
    //    but the slot stays spent.
    await page.click('[data-tab="actors"]');
    await page
      .locator("#sheet-list .sheet-row")
      .filter({ hasText: "PF Wizard" })
      .click();
    await sheet.getByRole("button", { name: "spells", exact: true }).click();
    await expect(book.locator("[data-pending-cast]")).toContainText(
      "Magic Missile",
    );
    await book.locator("[data-pending-disrupt-damage]").fill("100");
    await book.locator("[data-pending-disrupt]").click();
    await expect(book.locator("[data-pending-cast]")).toHaveCount(0);
    await expect(book.locator("[data-cast-warning]")).toContainText(
      /concentration check failed/,
    );
    await expect(row1.locator("[data-slot-spent]")).toHaveText("1");

    // 3. Begin again (Shield, no components — the gate is skipped but the
    //    longer casting time still defers the effect)…
    await book.locator('[data-cast-prepared="1"]').click();
    await book.locator("[data-cast-time]").selectOption("longer");
    await book.locator("[data-cast-severity]").selectOption("none");
    await book.locator("[data-cast-damage]").fill("");
    await book.locator("[data-cast-target]").selectOption({ label: "PF Ogre" });
    await book.locator("[data-cast-submit]").click();
    await expect(row1.locator("[data-slot-spent]")).toHaveText("2");
    await expect(book.locator("[data-pending-cast]")).toContainText("Shield");

    // …and complete it: the effect lands at the original target.
    await book.locator("[data-pending-complete]").click();
    await expect(book.locator("[data-pending-cast]")).toHaveCount(0);

    await page.click('[data-tab="chat"]');
    chat = await page.locator("#chat-log").textContent();
    expect(chat).toContain("loses Magic Missile");
    expect(chat).toMatch(/DC 111/);
    expect(chat).toMatch(
      /completes Shield \(level 1\) at PF Ogre — the casting began before this turn/,
    );
    expect(errors).toEqual([]);
  });
});
