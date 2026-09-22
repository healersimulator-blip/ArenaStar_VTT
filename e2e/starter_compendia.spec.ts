// Checklist: G-45 — the *hand-authored* starter world's compendia browse like the converted ones.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { entry, gmCall, waitForSurface } from "./lib";

/**
 * The companion of `content_world.spec.ts`: that spec proves the *converted* 25,376-entry corpus
 * (D-253's pipeline) is usable, this one proves the world a GM gets out of the box is.
 * `dist/worlds/pf1e-mass-battles-starter-1.0.0.zip` is hand-authored by `scripts/buildStarterWorlds.mjs`
 * and its pack shapes are **not** the converter's: its 75 spells carry `system.school` and no
 * `spell` keyword, and its 8 roll tables live inside the *equipment* pack with `system.table` as a
 * **string** and `rows` as an **object**. Those are exactly the shapes that misclassified entries
 * when the reader first met them, so they get a browser run, not only the index-level unit test
 * (`tests/scripts/buildStarterWorlds.test.ts`).
 *
 * Every expectation is derived from the shipped zip — pack count, entry count, the spell and the
 * table it searches for — so the spec does not break when the starter corpus is edited, and it
 * fails if the artifact and the reader disagree.
 */

const distWorlds = fileURLToPath(new URL("../dist/worlds", import.meta.url));
const NEED = "run `pnpm build && pnpm build:systems && pnpm build:worlds`";

interface PackFile {
  entries?: { id: string; name: string; data?: { system?: Record<string, unknown> } }[];
}

type Entry = { id: string; name: string; system: Record<string, unknown> };

const starterZip = (): string | null => {
  const names = existsSync(distWorlds) ? readdirSync(distWorlds) : [];
  const name = names.find((n) => /^pf1e-mass-battles-starter-.*\.zip$/.test(n));
  return name ? join(distWorlds, name) : null;
};

/** The starter world's compendium packs, read out of the shipped artifact itself. */
const readStarter = (zipPath: string) => {
  const files = unzipSync(new Uint8Array(readFileSync(zipPath)));
  const text = (name: string): string | null => {
    const file = files[name];
    return file ? strFromU8(file) : null;
  };
  const packFiles: string[] = [];
  for (const name of Object.keys(files)) {
    const manifest = /^packages\/([^/]+)\/manifest\.json$/.exec(name);
    if (!manifest) continue;
    const parsed = JSON.parse(text(name) ?? "{}") as { packs?: { file?: string }[] };
    for (const pack of parsed.packs ?? []) {
      if (typeof pack.file === "string") packFiles.push(`packages/${manifest[1]}/${pack.file}`);
    }
  }
  const entries: Entry[] = packFiles.flatMap((file) =>
    ((JSON.parse(text(file) ?? "{}") as PackFile).entries ?? []).map((e) => ({
      id: e.id,
      name: e.name,
      system: e.data?.system ?? {},
    })),
  );
  return {
    packs: packFiles.length,
    entries,
    spells: entries.filter((e) => typeof e.system.school === "string" && e.system.school.length > 0),
    tables: entries.filter((e) => typeof e.system.table === "string"),
  };
};

const stats = (page: Page) => page.locator("[data-compendium-stats]");

test.describe("shipped starter world compendia (G-45)", () => {
  test("the hand-authored starter corpus indexes, opens a detail pane and imports through the UI", async ({
    page,
  }) => {
    const zipPath = starterZip();
    test.skip(zipPath === null, `no starter world under dist/worlds — ${NEED}`);
    test.setTimeout(120_000);
    const { packs, entries, spells, tables } = readStarter(zipPath as string);
    expect(packs, "the shipped starter world carries compendium packs").toBeGreaterThan(0);
    expect(spells.length, "the starter corpus has spells with a system.school").toBeGreaterThan(0);
    expect(tables.length, "the starter corpus has tables authored as a string").toBeGreaterThan(0);

    // A Svelte runtime error (a duplicate key, a bad each-block) is not an assertion failure in
    // Playwright — it is a console message and a dead panel. Any page error fails this spec.
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(String(err)));

    // `?e2e=1` installs the readback surface and boots a world at once; closing it lands on the
    // real start screen, which is where a GM opens the shipped zip. From there every step is the
    // taster's own path: import → dialog → open as a copy.
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.locator("#close-world").click();
    await expect(page.locator("#role-host")).toHaveText(/Host a world|Continue/, { timeout: 30_000 });
    await page.setInputFiles("#role-import", zipPath as string);
    const dialog = page.locator("[data-open-dialog]");
    await expect(dialog).toHaveAttribute("data-open-kind", "world");
    await dialog.locator("[data-open-copy]").click();
    await waitForSurface(page, "app");
    await expect(page.locator("#status")).toContainText("Mass Battles", { timeout: 60_000 });

    // The reader sees the whole starter corpus, counted from the zip rather than hardcoded.
    await page.click('[data-tab="compendia"]');
    await expect(stats(page)).toContainText(`${packs} pack(s)`, { timeout: 30_000 });
    await expect(stats(page)).toContainText(`${entries.length} entries`);
    await expect(stats(page)).toContainText(`${entries.length} shown`);

    // The kinds the hand-authored shapes must land in: spells classified from `system.school`
    // (there is no `spell` keyword in this corpus) and the equipment pack's rules tables from a
    // string `system.table` — these are *items*, so they read as `Table`, not as the `Roll table`
    // documents the converted corpus ships.
    await page.click("[data-compendium-filters-toggle]");
    await expect(page.locator('[data-compendium-facet^="kinds:Spell"]')).toBeVisible();
    await expect(page.locator('[data-compendium-facet^="kinds:Table"]')).toBeVisible();

    // A spell: the detail pane reads the document's own fields, and the row imports a copy.
    const spell = spells[0] as Entry;
    await page.fill("#compendium-search", spell.name);
    const spellRow = page.locator(`[data-entry-id="${spell.id}"]`);
    await expect(spellRow).toBeVisible({ timeout: 30_000 });
    await spellRow.click();
    const detail = page.locator("[data-compendium-detail]");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(spell.name);
    await expect(detail).toContainText("School");
    await expect(detail).toContainText("Level");
    await spellRow.locator("[data-entry-import]").click();
    await expect.poll(() => gmCall<number>(page, "itemCount"), { timeout: 30_000 }).toBe(1);

    // A roll table: `system.table` is a string here, so it must still classify as a Roll table
    // and open without tripping the pane's field rendering.
    const table = tables[0] as Entry;
    await page.fill("#compendium-search", table.name);
    const tableRow = page.locator(`[data-entry-id="${table.id}"]`);
    await expect(tableRow).toBeVisible({ timeout: 30_000 });
    await tableRow.click();
    await expect(detail).toContainText("Table");

    expect(errors, "no Svelte runtime error while browsing the starter corpus").toEqual([]);
  });
});
