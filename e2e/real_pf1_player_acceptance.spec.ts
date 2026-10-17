import { expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playerCall } from "./lib";
import { createRealPf1Caster, openRealPf1World } from "./realPf1";
import { freshTable, joinFromInvite, selectActor } from "./realUsers";

/** Compare authoritative delivery, sheet preparation, and real rendered UI independently. */
async function inspectSpellSheet(page: Page) {
  return page
    .frameLocator('iframe[title="AIS module:pf1"]')
    .locator("body")
    .evaluate(async () => {
      type Item = {
        name: string;
        type: string;
        system: Record<string, unknown>;
        ownership?: unknown;
      };
      type Book = { sections?: Array<{ level: number; items: Item[] }> };
      const realm = globalThis as unknown as {
        game: {
          user: { isGM: boolean };
          actors: {
            get(id: string): {
              isOwner: boolean;
              ownership: unknown;
              items: { contents: Item[] };
              sheet: {
                _prepareContext(
                  options: object,
                ): Promise<{ items: Item[]; spellbooks: Record<string, Book> }>;
              };
            };
          };
        };
        AIS: {
          documents: {
            get(ref: object): Promise<{ items: Item[]; ownership: unknown }>;
          };
        };
      };
      const actor = realm.game.actors.get("journey-imported-mage");
      const stored = await realm.AIS.documents.get({
        collection: "actors",
        id: "journey-imported-mage",
      });
      const context = await actor.sheet._prepareContext({});
      const spellNames = new Set(
        actor.items.contents
          .filter((i) => i.type === "spell")
          .map((i) => i.name),
      );
      const summarize = (items: Item[]) =>
        items
          .filter((i) => spellNames.has(i.name))
          .map((i) => ({
            name: i.name,
            book: i.system.spellbookId,
            level: i.system.level,
            ownership: i.ownership,
          }));
      return {
        isGM: realm.game.user.isGM,
        isOwner: actor.isOwner,
        ownership: actor.ownership,
        authoritativeSpells: summarize(stored.items),
        runtimeSpells: summarize(actor.items.contents),
        contextSpells: summarize(context.items),
        books: Object.fromEntries(
          Object.entries(context.spellbooks ?? {}).map(([id, book]) => [
            id,
            (book.sections ?? []).map((section) => ({
              level: section.level,
              spells: section.items.map((i) => i.name),
            })),
          ]),
        ),
        renderedSpellRows: [
          ...document.querySelectorAll(
            ".application .spellbooks-body .item[data-item-id]",
          ),
        ].map(
          (el) =>
            el.querySelector(".item-name")?.textContent?.trim() ??
            el.textContent?.trim().split("\n")[0],
        ),
        renderedSpellbookCount: document.querySelectorAll(
          ".application .spellbooks-body [data-book-id]",
        ).length,
        renderedFireball: [...document.querySelectorAll(".application")].some(
          (el) => el.textContent?.includes("Fireball"),
        ),
      };
    });
}

/** Release gate, NOT a boot smoke test. No skip/expected-failure escape hatch. */
test("fresh player receives real PF1 code and opens a usable imported caster sheet and spell list", async ({
  browser,
}) => {
  test.setTimeout(300000);
  const world = fileURLToPath(
    new URL("../dist/worlds/real-pf1-minimal-test-1.0.0.zip", import.meta.url),
  );
  expect(
    existsSync(world),
    "Run npm run test:e2e:real-users:prepare; this acceptance gate requires real source fixtures",
  ).toBe(true);
  const table = await freshTable(browser, false);
  const { gm, player } = table;
  try {
    await test.step("GM imports, reviews, and boots the real PF1 distribution", async () => {
      await openRealPf1World(gm, world, "Real PF1 Minimal", ["pf1"]);
      await expect(
        gm.locator('[data-ais-module-review="pf1"] [data-ais-share-players]'),
      ).toBeChecked();
    });
    // Fixture preparation only: full unconverted upstream actor/spell documents,
    // retrieved through the adapter, not a handcrafted system.pf1e replacement.
    await test.step("GM creates a caster from real upstream compendium documents", async () => {
      await createRealPf1Caster(gm);
      await gm.locator('[data-window="settings"] [data-window-close]').click();
    });
    await test.step("player joins an empty browser profile without importing any ZIP", async () => {
      await joinFromInvite(gm, player);
      const userId = await playerCall<string>(player, "userId");
      await selectActor(gm, "Journey Battle Mage");
      await expect
        .poll(
          () =>
            gm
              .locator("#assign-owner option")
              .evaluateAll((options) =>
                options.map((o) => (o as HTMLOptionElement).value),
              ),
          { timeout: 30000 },
        )
        .toContain(userId);
      await gm.locator("#assign-owner").selectOption(userId);
    });
    await test.step("GM opens the actual upstream sheet and audits spell rendering before player runtime startup", async () => {
      const sessionClose = gm.getByRole("button", {
        name: "Close session panel",
        exact: true,
      });
      if (await sessionClose.isVisible()) await sessionClose.click();
      const settingsClose = gm.locator(
        '[data-window="settings"] [data-window-close]',
      );
      if (await settingsClose.isVisible()) await settingsClose.click();
      await selectActor(gm, "Journey Battle Mage");
      await gm
        .locator("#sheets")
        .getByRole("button", {
          name: "Open character sheet window",
          exact: true,
        })
        .click();
      const sheet = gm
        .frameLocator('iframe[title="AIS module:pf1"]')
        .locator(".application")
        .filter({ hasText: "Journey Battle Mage" });
      await expect(sheet).toBeVisible({ timeout: 15000 });
      await sheet
        .locator('nav [data-action="tab"][data-group="primary"]')
        .filter({ hasText: /^\s*Spells\s*$/ })
        .click();
      await sheet
        .locator(
          'nav [data-action="tab"][data-group="spellbooks"][data-tab="primary"]',
        )
        .click();
      await expect(
        sheet
          .locator(".spellbooks-body .item[data-item-id]")
          .filter({ hasText: "Mirror Image" }),
      ).toBeVisible();
      const report = await inspectSpellSheet(gm);
      expect(report.renderedSpellRows).toHaveLength(10);
      expect(
        report.runtimeSpells.find((i) => i.name === "Fireball")?.book,
      ).toBe("primary");
      await expect(
        sheet
          .locator(".spellbooks-body .item[data-item-id]")
          .filter({ hasText: "Fireball" }),
      ).toBeVisible();
      expect(report.authoritativeSpells.map((i) => i.name)).toContain(
        "Fireball",
      );
      console.log("GM spell audit:", JSON.stringify(report));
      await test.info().attach("gm-spell-audit", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      await sheet.locator('.window-header [data-action="close"]').click();
    });
    await test.step("shared system arrives and runs only after the player's consent", async () => {
      const consent = player.locator('[data-ais-consent="pf1"]');
      await expect(
        consent,
        "GM-shared PF1 code must actually reach a fresh player",
      ).toBeVisible({ timeout: 45000 });
      await expect(
        player.locator('iframe[title="AIS module:pf1"]'),
      ).toHaveCount(0);
      await consent.locator("[data-ais-consent-allow]").click();
      const frame = player.frameLocator('iframe[title="AIS module:pf1"]');
      await expect
        .poll(
          () =>
            frame.locator("body").evaluate(() =>
              (
                globalThis as unknown as {
                  FoundryAdapter?: {
                    info(): { ready: boolean; hookErrors: unknown[] };
                  };
                }
              ).FoundryAdapter?.info(),
            ),
          {
            timeout: 120000,
            message: "Player's real PF1 runtime must boot without hook errors",
          },
        )
        .toMatchObject({
          ready: true,
          hookErrors: [],
          documents: { hookErrors: [] },
        });
    });
    await test.step("player opens a readable character sheet and sees the delivered spell", async () => {
      await selectActor(player, "Journey Battle Mage", true);
      await expect(
        player.locator("#sheets").getByRole("button", {
          name: "Open character sheet window",
          exact: true,
        }),
        "Owned imported PF1 actors need a discoverable sheet action, not raw JSON fields",
      ).toBeVisible();
      await player
        .locator("#sheets")
        .getByRole("button", {
          name: "Open character sheet window",
          exact: true,
        })
        .click();
      // Imported systems render their own registered Foundry sheet inside the sandbox,
      // not ArenaStar's native PF1e sheet. Assert the upstream UI, not native tab labels.
      const frame = player.frameLocator('iframe[title="AIS module:pf1"]');
      const sheet = frame
        .locator(".application")
        .filter({ hasText: "Journey Battle Mage" });
      await expect(sheet).toBeVisible({ timeout: 15000 });
      await sheet
        .locator('nav [data-action="tab"][data-group="primary"]')
        .filter({ hasText: /^\s*Spells\s*$/ })
        .click();
      await sheet
        .locator(
          'nav [data-action="tab"][data-group="spellbooks"][data-tab="primary"]',
        )
        .click();
      await expect(
        sheet
          .locator(".spellbooks-body .item[data-item-id]")
          .filter({ hasText: "Mirror Image" }),
      ).toBeVisible();
      const report = await inspectSpellSheet(player);
      expect(report.isOwner).toBe(true);
      expect(report.renderedSpellRows).toHaveLength(10);
      expect(
        report.runtimeSpells.find((i) => i.name === "Fireball")?.book,
      ).toBe("primary");
      await expect(
        sheet
          .locator(".spellbooks-body .item[data-item-id]")
          .filter({ hasText: "Fireball" }),
      ).toBeVisible();
      expect(report.authoritativeSpells.map((i) => i.name)).toContain(
        "Fireball",
      );
      console.log("Player spell audit:", JSON.stringify(report));
      await test.info().attach("player-spell-audit", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      await expect(sheet).toContainText("Fireball");
    });
    expect(table.errors).toEqual([]);
  } catch (error) {
    console.error(
      "Imported spell diagnostics:",
      await player
        .frameLocator('iframe[title="AIS module:pf1"]')
        .locator("body")
        .evaluate(() => {
          const realm = globalThis as unknown as {
            game: {
              actors: {
                get(id: string): {
                  items: {
                    contents: Array<{
                      name: string;
                      type: string;
                      system: unknown;
                    }>;
                  };
                  system: { spells: unknown };
                };
              };
            };
          };
          const actor = realm.game.actors.get("journey-imported-mage");
          return {
            spells: actor?.items.contents
              .filter((i) => i.type === "spell")
              .map((i) => ({
                name: i.name,
                system: JSON.parse(JSON.stringify(i.system)),
              })),
            books: actor?.system.spells,
          };
        })
        .catch(() => null),
    );
    console.error(
      "Player diagnostics:",
      await player.locator("body").innerText(),
      table.errors,
      table.warnings,
    );
    throw error;
  } finally {
    await table.close();
  }
});
