// Checklist: G-45 — the compendium reader at scale: windowed rows, facets, sorts, detail pane.
import { expect, test, type Page } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { entry, gmCall } from "./lib";

/**
 * G-45 acceptance (closure plan §1.4): a compendium that holds hundreds (here) or the converted
 * tester world's 25,376 entries (e2e/content_world.spec.ts) must be *browsable*, not just present:
 *
 *  - the DOM holds a window of rows, not the whole result list, while the stats line still reports
 *    the true match count, and scrolling reaches the far end of the corpus;
 *  - facet chips (pack / kind / school / level) narrow the result set and clear again;
 *  - the sort control reorders (level sort puts the lowest level first, level-less rows last);
 *  - a row opens a detail pane that shows the document's own fields, and the detail pane imports
 *    with the same create-op semantics as the row buttons.
 *
 * The corpus is generated here rather than taken from the converted world: the 262 MB vendor
 * checkout is not in CI, and the scale properties under test do not depend on real content.
 */

const SCHOOLS = ["Abjuration", "Conjuration", "Evocation", "Illusion", "Necromancy", "Transmutation"];
const SPELLS = 300;
const FEATS = 40;

const spellEntry = (i: number): unknown => {
  const id = `scale-spell-${String(i).padStart(3, "0")}`;
  const level = 1 + (i % 9);
  const school = SCHOOLS[i % SCHOOLS.length];
  const name = `Scale Spell ${String(i).padStart(3, "0")}`;
  return {
    id,
    name,
    keywords: ["spell", String(school).toLowerCase()],
    data: {
      type: "item",
      name,
      system: { school, level: { sorcererWizard: level }, descriptors: ["test"] },
      effects: [],
    },
  };
};

const featEntry = (i: number): unknown => {
  const id = `scale-feat-${String(i).padStart(2, "0")}`;
  const name = `Scale Feat ${String(i).padStart(2, "0")}`;
  return {
    id,
    name,
    keywords: ["feat", "combat"],
    data: { type: "item", name, system: { category: "combat" }, effects: [] },
  };
};

const MANIFEST = {
  id: "scale-compendium",
  name: "Scale Compendium",
  version: "1.0.0",
  type: "data",
  packs: [
    { name: "Scale Spells", type: "items", file: "packs/spells.json" },
    { name: "Scale Feats", type: "items", file: "packs/feats.json" },
  ],
};

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

/** App-surface call (the `appCall` helper packages.spec.ts also keeps locally). */
const appCall = <T>(page: Page, method: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ({ m, a }) => {
      const surface = (
        globalThis as { __vttE2E?: { app?: Record<string, (...x: unknown[]) => T> } }
      ).__vttE2E;
      const fn = surface?.app?.[m];
      if (typeof fn !== "function") throw new Error(`app surface missing: ${m}`);
      return fn(...a);
    },
    { m: method, a: args },
  );

const stats = (page: Page) => page.locator("[data-compendium-stats]");
const rows = (page: Page) => page.locator("[data-compendium-row]");

const waitForApp = (page: Page): Promise<void> =>
  expect
    .poll(
      () =>
        page.evaluate(() => {
          const app = (globalThis as { __vttE2E?: { app?: { rulesBoot?: unknown } } }).__vttE2E?.app;
          return typeof app?.rulesBoot === "function";
        }),
      { timeout: 60_000 },
    )
    .toBe(true);

const waitForCompendium = (page: Page, expected: number): Promise<void> =>
  expect
    .poll(() => gmCall<{ packs: number; entries: number }>(page, "compendiumStats"), {
      timeout: 60_000,
    })
    .toEqual({ packs: 2, entries: expected });

test.describe("§12 compendium reader scale UX (G-45)", () => {
  test("windowing, facets, sorts and the detail pane over a 340-entry package", async ({
    browser,
  }) => {
    // A 340-entry zip import + five searches through the UI: give it room (the whole file:// boot
    // with the worker gate is seconds on its own).
    test.setTimeout(120_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(entry + "?e2e=1");
      await waitForApp(page);

      const zip = Array.from(
        zipOf({
          "manifest.json": JSON.stringify(MANIFEST),
          "packs/spells.json": JSON.stringify({
            name: "Scale Spells",
            type: "items",
            entries: Array.from({ length: SPELLS }, (_, i) => spellEntry(i)),
          }),
          "packs/feats.json": JSON.stringify({
            name: "Scale Feats",
            type: "items",
            entries: Array.from({ length: FEATS }, (_, i) => featEntry(i)),
          }),
        }),
      );
      const imported = await appCall<{ ok: boolean; error?: string }>(
        page,
        "importPackageZip",
        zip,
      );
      expect(imported.ok).toBe(true);
      await waitForCompendium(page, SPELLS + FEATS);

      await page.click('[data-tab="compendia"]');
      await expect(stats(page)).toContainText("2 pack(s)", { timeout: 20_000 });
      await expect(stats(page)).toContainText(`${SPELLS + FEATS} entries`);
      await expect(stats(page)).toContainText(`${SPELLS + FEATS} shown`);

      // ── the DOM holds a window, the stats hold the truth ──
      // Browse order is the round-robin interleave, so the very first row is the first spell.
      await page.waitForSelector('[data-entry-id="scale-spell-000"]', { timeout: 20_000 });
      const rendered = await rows(page).count();
      expect(rendered).toBeGreaterThan(0);
      expect(rendered).toBeLessThan(60);
      // A row far outside the viewport is not in the document at all — that is the scale fix.
      await expect(page.locator('[data-entry-id="scale-spell-299"]')).toHaveCount(0);

      // ── scrolling reaches the far end (and the DOM stays a window there too) ──
      const list = page.locator("[data-compendium-rows]");
      // The scroll range must be the whole corpus, not one window's worth: this is the assertion
      // that caught the flex-shrink collapse of the spacer divs (scrollHeight was 848 px for a
      // 340-row list, so nothing past the first window was reachable).
      await expect
        .poll(() => list.evaluate((el) => el.scrollHeight))
        .toBeGreaterThan((SPELLS + FEATS) * 26);
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForSelector('[data-entry-id="scale-spell-299"]', { timeout: 20_000 });
      expect(await rows(page).count()).toBeLessThan(80);

      // ── facets: kind Feat narrows to the feat pack, and clearing restores everything ──
      await page.click("[data-compendium-filters-toggle]");
      await page.click('[data-compendium-facet="kinds:Feat"]');
      await expect(stats(page)).toContainText(`${FEATS} shown`);
      await expect(page.locator('[data-entry-id="scale-feat-00"]')).toBeVisible();
      await expect(page.locator('[data-entry-id="scale-spell-000"]')).toHaveCount(0);
      await page.click('[data-compendium-clear-filters]');
      await expect(stats(page)).toContainText(`${SPELLS + FEATS} shown`);

      // ── search through the index, then an explicit sort ──
      await page.fill("#compendium-search", "Scale Spell 037");
      await expect(rows(page)).toHaveCount(1, { timeout: 20_000 });
      await expect(page.locator('[data-entry-id="scale-spell-037"]')).toBeVisible();
      await page.fill("#compendium-search", "");
      await page.selectOption("[data-compendium-sort]", "level");
      await expect(stats(page)).toContainText(`${SPELLS + FEATS} shown`);
      // Lowest level first (ids are authored so that level 1 is every ninth spell, 000 first);
      // the level-less feats sort last.
      await expect(rows(page).first()).toHaveAttribute("data-entry-id", "scale-spell-000");

      // ── detail pane: the document's own fields, and an import ──
      await page.selectOption("[data-compendium-sort]", "relevance");
      await page.click('[data-entry-id="scale-spell-012"]');
      const detail = page.locator("[data-compendium-detail]");
      await expect(detail).toBeVisible({ timeout: 20_000 });
      await expect(detail.locator("[data-compendium-detail-name]")).toHaveText("Scale Spell 012");
      // Expectations derived from the generator, not hardcoded: entry 012 is level 1 + (12 % 9)
      // in school SCHOOLS[12 % 6] — both read out of the same formulas the fixture uses.
      await expect(detail).toContainText("School");
      await expect(detail).toContainText(SCHOOLS[12 % SCHOOLS.length] ?? "");
      await expect(detail).toContainText(String(1 + (12 % 9)));
      await expect(detail).toContainText("Keywords");
      await detail.locator("[data-compendium-detail-import]").click();
      await expect.poll(() => gmCall<number>(page, "itemCount")).toBe(1);

      // The row button still imports too (the pre-G-45 contract), and still exactly once.
      await page.fill("#compendium-search", "Scale Feat 01");
      await page.locator('[data-entry-id="scale-feat-01"] [data-entry-import]').click();
      await expect.poll(() => gmCall<number>(page, "itemCount")).toBe(2);
    } finally {
      await ctx.close();
    }
  });
});
