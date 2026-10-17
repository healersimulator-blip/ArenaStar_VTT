/** Shared setup for optional, externally built real-PF1 fixtures. No production test globals. */
import { expect, type Page } from "@playwright/test";
import { entry, waitForSurface } from "./lib";

export async function approveFoundryPackage(
  page: Page,
  id: string,
): Promise<void> {
  const row = page.locator(`[data-pkg-row][data-pkg-id="${id}"]`);
  if (await row.locator("[data-ais-enable]").count())
    await row.locator("[data-ais-enable]").click();
  const review = page.locator(`[data-ais-module-review="${id}"]`);
  await expect(
    review.locator('fieldset input[type="checkbox"]').first(),
  ).toBeVisible({ timeout: 20000 });
  for (const cb of await review
    .locator('fieldset input[type="checkbox"]')
    .all())
    await cb.check();
  await expect(
    review.locator('fieldset input[type="checkbox"]:not(:checked)'),
  ).toHaveCount(0);
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator(".ais-source-preview pre")).toBeVisible({
    timeout: 60000,
  });
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator("[data-ais-approved]")).toContainText(
    "runtime.execute",
    {
      timeout: 60000,
    },
  );
}

export async function openRealPf1World(
  page: Page,
  path: string,
  title: string,
  modules: readonly string[],
): Promise<void> {
  await page.goto(entry);
  await page.locator("#role-import").setInputFiles(path);
  await page.locator("[data-open-copy]").click();
  await expect(page.locator("#status")).toContainText(title, {
    timeout: 60000,
  });
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  for (const id of ["ais-foundry-v13", ...modules])
    await approveFoundryPackage(page, id);
  await Promise.all([
    page.waitForEvent("load"),
    page.locator("[data-ais-reload]").click(),
  ]);
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  for (const id of modules) {
    const runtime = page.locator(
      `[data-ais-module-review="${id}"] [data-ais-runtime]`,
    );
    await expect(runtime).toHaveAttribute(
      "data-ais-runtime",
      /^(ready|failed)$/,
      {
        timeout: 120000,
      },
    );
    await expect(
      runtime,
      (await runtime.textContent()) ?? "PF1 runtime startup",
    ).toHaveAttribute("data-ais-runtime", "ready", { timeout: 1000 });
    const info = await page
      .frameLocator(`iframe[title="AIS module:${id}"]`)
      .locator("body")
      .evaluate(() => {
        const adapter = (
          globalThis as unknown as {
            FoundryAdapter: {
              info(): { ready: boolean; hookErrors: unknown[] };
            };
          }
        ).FoundryAdapter;
        return adapter.info();
      });
    expect(info.ready).toBe(true);
    expect(info.hookErrors).toEqual([]);
  }
}

export const realPf1Modules = [
  "pf1",
  "pf-content",
  "pf1e-archetypes",
  "statblock-library",
] as const;

/** Real unconverted character fixture; returns enough source data to assert lossless import. */
export async function createRealPf1Caster(page: Page) {
  const result = await page
    .frameLocator('iframe[title="AIS module:pf1"]')
    .locator("body")
    .evaluate(async () => {
      type Doc = { toObject(): Record<string, unknown> };
      type Pack = {
        getIndex(): Promise<Array<{ _id: string; name: string }>>;
        getDocument(id: string): Promise<Doc | null>;
      };
      const realm = globalThis as unknown as {
        game: { packs: Map<string, Pack> };
        FoundryAdapter: { info(): { documents?: { hookErrors?: unknown[] } } };
        Actor: { create(data: Record<string, unknown>): Promise<Doc | null> };
        AIS: {
          documents: {
            get(ref: {
              collection: string;
              id: string;
            }): Promise<Record<string, unknown> | null>;
          };
        };
      };
      const actors = realm.game.packs.get("pf1.basic-monsters");
      const spells = realm.game.packs.get("pf1.spells");
      if (!actors || !spells) throw new Error("Upstream fixture packs missing");
      const mageRow = (await actors.getIndex()).find(
        (row) => row.name === "Battle Mage",
      );
      const spellRow = (await spells.getIndex()).find(
        (row) => row.name === "Fireball",
      );
      if (!mageRow || !spellRow)
        throw new Error("Upstream Battle Mage/Fireball missing");
      const mage = await actors.getDocument(mageRow._id);
      const spell = await spells.getDocument(spellRow._id);
      if (!mage || !spell) throw new Error("Upstream fixture hydration failed");
      const data = mage.toObject();
      // Compendium spells are unassigned. Importing into a character's book is
      // an explicit user/setup choice, not a permission or adapter default.
      const spellData = spell.toObject();
      const system = data.system as { spells?: Record<string, unknown> };
      if (!system.spells?.primary)
        throw new Error("Battle Mage primary spellbook missing");
      const assignedSpell = {
        ...spellData,
        system: {
          ...(spellData.system as Record<string, unknown>),
          spellbook: "primary",
        },
      };
      const items = [
        ...(Array.isArray(data.items) ? data.items : []),
        assignedSpell,
      ] as Array<Record<string, unknown>>;
      const createData = {
        ...data,
        _id: "journey-imported-mage",
        name: "Journey Battle Mage",
        ownership: { default: 0 },
        items,
      };
      const created = await realm.Actor.create(createData);
      if (!created) throw new Error("Actor.create returned no character");
      // Read through the real kernel RPC, not the adapter's optimistic/local instance.
      const stored = await realm.AIS.documents.get({
        collection: "actors",
        id: createData._id,
      });
      if (!stored || !Array.isArray(stored.items))
        throw new Error("Created character was not committed");
      const summarize = (rows: Array<Record<string, unknown>>) =>
        rows.map((row) => ({ name: row.name, system: row.system }));
      return {
        preparationErrors:
          realm.FoundryAdapter.info().documents?.hookErrors ?? [],
        requestDataBytes: new TextEncoder().encode(JSON.stringify(createData))
          .length,
        expected: { system: data.system, items: summarize(items) },
        actual: {
          system: stored.system,
          items: summarize(stored.items as Array<Record<string, unknown>>),
        },
        name: stored.name,
      };
    });
  expect(result.preparationErrors).toEqual([]);
  expect(result.requestDataBytes).toBeGreaterThan(64 * 1024);
  expect(result.name).toBe("Journey Battle Mage");
  expect(result.actual).toEqual(result.expected);
  expect(result.actual.items.some((item) => item.name === "Fireball")).toBe(
    true,
  );
}
