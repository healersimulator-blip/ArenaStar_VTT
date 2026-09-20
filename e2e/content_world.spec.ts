/**
 * G-44 (plan §1.1) — the converted content is reachable *and usable*, end to end.
 *
 * This spec boots the **real** `pf1e-mass-battles-tester` world zip (28 packs / 25k entries,
 * ~8 MB) through the start screen exactly as a GM would, then works the converted compendium
 * through the UI: search a spell that exists only in the converted content, import it, and check
 * the world actually holds it.
 *
 * The artifact is a build product, so the spec skips (with the commands) when it has not been
 * produced: `pnpm content:fetch && pnpm build:systems && pnpm content:convert && pnpm build:worlds`.
 * A machine that has run those runs the spec — that is the gate, and it is why the converted
 * content may never be claimed as "available" from a fresh clone alone.
 */
import { expect, test } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { entry, gmCall, waitForSurface } from "./lib";

const distWorlds = fileURLToPath(new URL("../dist/worlds", import.meta.url));
const testerZip = (): string | null => {
  const names = existsSync(distWorlds) ? readdirSync(distWorlds) : [];
  const name = names.find((n) => /^pf1e-mass-battles-tester-.*\.zip$/.test(n));
  return name ? join(distWorlds, name) : null;
};

const NEED = "run `pnpm content:fetch && pnpm build:systems && pnpm content:convert && pnpm build:worlds`";

test.describe("converted content world (G-44)", () => {
  test("the full-content world opens from the start screen and its converted packs are usable", async ({
    page,
  }) => {
    const zipPath = testerZip();
    test.skip(zipPath === null, `no tester world under dist/worlds — ${NEED}`);
    test.setTimeout(180_000); // an 8 MB world: import + boot + a 25k-entry index on 2 cores

    // `?e2e=1` installs the readback surface and boots a world straight away (the specs' shared
    // convention); closing it lands on the real start screen, which is where a GM opens the
    // downloaded zip. Every step below is the taster's own path: import → dialog → open.
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.locator("#close-world").click();
    // the button becomes "Continue “<world>”" while a local world exists — either state means the
    // start screen is up, which is what matters here
    await expect(page.locator("#role-host")).toHaveText(/Host a world|Continue/, { timeout: 30_000 });

    // ── open the artifact the pipeline produced, as a new world ──
    await page.setInputFiles("#role-import", zipPath as string);
    const dialog = page.locator("[data-open-dialog]");
    await expect(dialog).toHaveAttribute("data-open-kind", "world");
    // the dialog names what is inside before anything is opened: the ruleset, both content
    // packs (pf1e-core + the converted pf1e-content) and the archive format
    await expect(dialog.locator("[data-open-contents]")).toContainText(
      /strategic ruleset .*Mass Battles.*· 2 content packs · format 2/,
    );
    await dialog.locator("[data-open-copy]").click();
    await waitForSurface(page, "app");
    await expect(page.locator("#status")).toContainText("tester", { timeout: 120_000 });
    await expect.poll(() => page.evaluate(() => typeof (globalThis as { __vttE2E?: { gm?: unknown } }).__vttE2E?.gm), { timeout: 120_000 }).toBe("object");

    // ── the converted packs are indexed in the compendium reader ──
    // 28 converted packs plus the hand-authored ones that ship inside pf1e-core.
    const stats = await gmCall<{ packs: number; entries: number }>(page, "compendiumStats");
    expect(stats.packs).toBeGreaterThanOrEqual(28);
    expect(stats.entries).toBeGreaterThanOrEqual(25_376);


    // ── a spell that exists ONLY in the converted content, found through real search ──
    await page.click('[data-tab="compendia"]');
    await page.fill("#compendium-search", "aboleth");
    const hit = page.locator("[data-entry-id]").first();
    await expect(hit).toBeVisible({ timeout: 30_000 });
    await expect(hit).toContainText(/aboleth/i);
    await hit.locator("[data-entry-import]").click();
    await expect.poll(() => gmCall<number>(page, "itemCount"), { timeout: 60_000 }).toBe(1);

    // and a feat from the expanded pack, searched by keyword rather than exact name
    await page.fill("#compendium-search", "weapon focus");
    await expect(page.locator("[data-entry-id]").first()).toBeVisible({ timeout: 30_000 });
    await page.locator("[data-entry-id]").first().locator("[data-entry-import]").click();
    await expect.poll(() => gmCall<number>(page, "itemCount"), { timeout: 60_000 }).toBe(2);
  });
});
