import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { openRealPf1World, realPf1Modules } from "./realPf1";

const worldPath = fileURLToPath(
  new URL("../dist/worlds/real-pf1-full-1.0.0.zip", import.meta.url),
);
test("Real PF1 content runtimes boot and expose their own pack indexes", async ({
  page,
}) => {
  test.setTimeout(400000);
  test.skip(
    !existsSync(worldPath),
    "Build the external real-PF1 fixture first",
  );
  await openRealPf1World(page, worldPath, "Real PF1 Full", realPf1Modules);
  for (const id of realPf1Modules) {
    const packs = await page
      .frameLocator(`iframe[title="AIS module:${id}"]`)
      .locator("body")
      .evaluate(async (_body, packageId) => {
        const game = (
          globalThis as unknown as {
            game: {
              packs: Map<
                string,
                {
                  index: Map<string, unknown>;
                  getIndex(): Promise<Array<{ name: string }>>;
                }
              >;
            };
          }
        ).game;
        const summaries = [];
        for (const [key, pack] of game.packs.entries()) {
          if (!key.startsWith(packageId + ".")) continue;
          const entries = await pack.getIndex();
          summaries.push({
            key,
            count: entries.length,
            indexSize: pack.index.size,
            fireball: entries.some((e) => e.name === "Fireball"),
            ogre: entries.some((e) =>
              /^Ogre(?: \(CR [0-9/]+\))?$/.test(e.name),
            ),
          });
        }
        return summaries;
      }, id);
    const diagnostics = await page
      .frameLocator(`iframe[title="AIS module:${id}"]`)
      .locator("body")
      .evaluate(() =>
        (
          globalThis as unknown as { FoundryAdapter: { info(): unknown } }
        ).FoundryAdapter.info(),
      );
    expect(
      packs.length,
      `${id}: ${JSON.stringify(diagnostics)}`,
    ).toBeGreaterThan(0);
    expect(
      packs.every((pack) => pack.count > 0 && pack.indexSize === pack.count),
    ).toBe(true);
    if (id === "pf1") expect(packs.some((pack) => pack.fireball)).toBe(true);
    if (id === "statblock-library")
      expect(packs.some((pack) => pack.ogre)).toBe(true);
  }
});

/** Content is data-only: PF1 must discover and resolve it through the shared AIS catalogue. */
test("PF1 Content item is hydrated and imported by the real PF1 system", async ({
  page,
}) => {
  test.setTimeout(400000);
  expect(existsSync(worldPath), "Build the real full fixture first").toBe(true);
  await openRealPf1World(page, worldPath, "Real PF1 Full", [
    "pf1",
    "pf-content",
  ]);
  const { createRealPf1Caster } = await import("./realPf1");
  await createRealPf1Caster(page);
  const source = await page
    .frameLocator('iframe[title="AIS module:pf-content"]')
    .locator("body")
    .evaluate(async () => {
      type Item = { toObject(): Record<string, unknown> };
      const realm = globalThis as unknown as {
        game: {
          packs: Map<
            string,
            {
              getIndex(): Promise<Array<{ _id: string; name: string }>>;
              getDocument(id: string): Promise<Item>;
            }
          >;
        };
      };
      const pack = realm.game.packs.get("pf-content.pf-feats");
      if (!pack) throw new Error("PF1 Content feats pack missing");
      const index = await pack.getIndex();
      const row = index.find((i) => i.name === "Acrobatic");
      if (!row) throw new Error("Real Acrobatic feat missing");
      return {
        count: index.length,
        document: (await pack.getDocument(row._id)).toObject(),
      };
    });
  expect(source.count).toBeGreaterThan(0);
  const report = await page
    .frameLocator('iframe[title="AIS module:pf1"]')
    .locator("body")
    .evaluate(async () => {
      type Item = {
        name: string;
        uuid: string;
        system: {
          description: { value: string };
          constructor: { name: string };
        };
        toObject(): Record<string, unknown>;
      };
      const realm = globalThis as unknown as {
        game: {
          packs: Map<
            string,
            {
              getIndex(): Promise<Array<{ _id: string; name: string }>>;
              getDocument(id: string): Promise<Item>;
            }
          >;
          actors: {
            get(id: string): {
              system: { skills: Record<string, unknown> };
              createEmbeddedDocuments(
                type: string,
                data: unknown[],
              ): Promise<Item[]>;
              sheet: { render(options: object): Promise<unknown> };
            };
          };
        };
        fromUuid(uuid: string): Promise<Item | null>;
        fromUuidSync(uuid: string): Item | null;
        FoundryAdapter: { info(): unknown };
        AIS: {
          documents: {
            get(ref: object): Promise<{
              items: Array<{
                name: string;
                system: { description: { value: string } };
              }>;
            }>;
          };
        };
      };
      const pack = realm.game.packs.get("pf-content.pf-feats");
      if (!pack) throw new Error("Shared content pack not visible to PF1");
      const row = (await pack.getIndex()).find((i) => i.name === "Acrobatic");
      if (!row) throw new Error("Shared Acrobatic index entry missing");
      const uuid = `Compendium.pf-content.pf-feats.Item.${row._id}`;
      const resolved = await realm.fromUuid(uuid);
      if (!resolved) throw new Error("Cross-module UUID did not resolve");
      const cachedUUID = realm.fromUuidSync(uuid) === resolved;
      const data = resolved.toObject();
      const actor = realm.game.actors.get("journey-imported-mage");
      const [created] = await actor.createEmbeddedDocuments("Item", [data]);
      if (!created) throw new Error("Content import produced no item");
      const stored = await realm.AIS.documents.get({
        collection: "actors",
        id: "journey-imported-mage",
      });
      await actor.sheet.render({ force: true });
      return {
        uuid,
        resolvedUUID: resolved.uuid,
        cachedUUID,
        systemCanSeeContentPacks: [...realm.game.packs.keys()].filter((id) =>
          id.startsWith("pf-content."),
        ),
        name: created.name,
        model: created.system.constructor.name,
        description: created.system.description.value,
        storedDescription: stored.items.find((i) => i.name === "Acrobatic")
          ?.system.description.value,
        storedChanges: (
          stored.items.find((i) => i.name === "Acrobatic")
            ?.system as unknown as Record<string, unknown>
        )?.changes,
        diagnostics: realm.FoundryAdapter.info(),
      };
    });
  console.log("PF1 Content conjunction:", JSON.stringify(report));
  await test.info().attach("pf1-content-conjunction", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  expect(report.systemCanSeeContentPacks).toContain("pf-content.pf-feats");
  expect(report.cachedUUID).toBe(true);
  expect(report.resolvedUUID).toBe(report.uuid);
  expect(report.name).toBe("Acrobatic");
  expect(report.model).toBe("FeatModel");
  expect(report.storedDescription).toBe(report.description);
  const expectedSystem = source.document.system as {
    description: { value: string };
    changes: unknown;
  };
  expect(report.description).toBe(expectedSystem.description.value);
  expect(report.storedChanges).toEqual(expectedSystem.changes);
  expect(report.description).toContain("Acrobatics");
  const sheet = page
    .frameLocator('iframe[title="AIS module:pf1"]')
    .locator(".application")
    .filter({ hasText: "Journey Battle Mage" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText("Acrobatic");
});

test("fresh player catalogue follows shared provider consent and removal", async ({
  browser,
}) => {
  test.setTimeout(400000);
  expect(existsSync(worldPath)).toBe(true);
  const { freshTable, joinFromInvite } = await import("./realUsers");
  const table = await freshTable(browser, false);
  const { gm, player } = table;
  try {
    await openRealPf1World(gm, worldPath, "Real PF1 Full", [
      "pf1",
      "pf-content",
    ]);
    await gm
      .locator('[data-ais-module-review="pf-content"] [data-ais-share-players]')
      .uncheck();
    await gm.locator('[data-window="settings"] [data-window-close]').click();
    await joinFromInvite(gm, player);
    const frame = player.frameLocator('iframe[title="AIS module:pf1"]');
    await expect(player.locator('[data-ais-consent="pf1"]')).toBeVisible({
      timeout: 60000,
    });
    await player
      .locator('[data-ais-consent="pf1"] [data-ais-consent-allow]')
      .click();
    await expect
      .poll(
        () =>
          frame
            .locator("body")
            .evaluate(
              () =>
                (
                  globalThis as unknown as {
                    FoundryAdapter?: { info(): { ready: boolean } };
                  }
                ).FoundryAdapter?.info().ready,
            ),
        { timeout: 120000 },
      )
      .toBe(true);
    const catalogueIds = () =>
      frame
        .locator("body")
        .evaluate(() =>
          [
            ...(
              globalThis as unknown as { game: { packs: Map<string, unknown> } }
            ).game.packs.keys(),
          ].filter((id) => id.startsWith("pf-content.")),
        );
    expect(await catalogueIds()).toEqual([]);
    const sessionClose = gm.getByRole("button", {
      name: "Close session panel",
      exact: true,
    });
    if (await sessionClose.isVisible()) await sessionClose.click();
    await gm.locator("#gm-settings").click();
    await expect(
      gm.locator(
        '[data-ais-module-review="pf-content"] [data-ais-share-players]',
      ),
    ).toBeVisible({ timeout: 60000 });
    await gm
      .locator('[data-ais-module-review="pf-content"] [data-ais-share-players]')
      .check();
    await expect(player.locator('[data-ais-consent="pf-content"]')).toBeVisible(
      { timeout: 60000 },
    );
    expect(await catalogueIds()).toEqual([]);
    await player
      .locator('[data-ais-consent="pf-content"] [data-ais-consent-allow]')
      .click();
    await expect
      .poll(catalogueIds, { timeout: 60000 })
      .toContain("pf-content.pf-feats");
    const resolved = await frame.locator("body").evaluate(async () => {
      const realm = globalThis as unknown as {
        game: {
          packs: Map<
            string,
            { getIndex(): Promise<Array<{ _id: string; name: string }>> }
          >;
        };
        fromUuid(
          uuid: string,
        ): Promise<{ name: string; system: { constructor: { name: string } } }>;
      };
      const pack = realm.game.packs.get("pf-content.pf-feats");
      if (!pack) throw new Error("Shared feats pack missing");
      const row = (await pack.getIndex()).find(i => i.name === "Acrobatic");
      if (!row) throw new Error("Acrobatic entry missing");
      const doc = await realm.fromUuid(
        `Compendium.pf-content.pf-feats.Item.${row._id}`,
      );
      return {
        id: row._id,
        name: doc.name,
        model: doc.system.constructor.name,
      };
    });
    expect(resolved.name).toBe("Acrobatic");
    expect(resolved.model).toBe("FeatModel");
    await gm
      .locator('[data-ais-module-review="pf-content"] [data-ais-share-players]')
      .uncheck();
    await expect.poll(catalogueIds, { timeout: 60000 }).toEqual([]);
    const denied = await frame
      .locator("body")
      .evaluate(async (_body, entryId) => {
        const realm = globalThis as unknown as {
          AIS: {
            compendium: {
              get(packId: string, entryId: string): Promise<unknown>;
            };
          };
        };
        try {
          await realm.AIS.compendium.get(
            "pf-content/packs/pf-feats.db",
            entryId,
          );
          return false;
        } catch (error) {
          return String(error).includes("Unknown compendium pack");
        }
      }, resolved.id);
    expect(denied).toBe(true);
    expect(table.errors).toEqual([]);
  } catch (error) {
    console.error(
      "Catalogue GM diagnostics:",
      await gm.locator("body").innerText(),
    );
    console.error(
      "Catalogue player diagnostics:",
      await player.locator("body").innerText(),
      table.errors,
      table.warnings,
    );
    throw error;
  } finally {
    await table.close();
  }
});
