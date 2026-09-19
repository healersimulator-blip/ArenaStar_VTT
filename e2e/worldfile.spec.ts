import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

const appCall = <T>(page: Page, method: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ({ m, a }) => {
      const surface = (
        globalThis as { __vttE2E?: { app: Record<string, (...x: unknown[]) => T> | null } }
      ).__vttE2E;
      const fn = surface?.app?.[m];
      if (typeof fn !== "function") throw new Error(`app surface missing: ${m}`);
      return fn(...a) as T;
    },
    { m: method, a: args },
  );

/** A minimal §12 strategic ruleset the SimWorker accepts (shape as in packages.spec.ts). */
const RULES_JS = [
  "export default {",
  "  schema: { version: '9.9.9', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] },",
  "  validateOrder() { return { ok: true }; },",
  "  resolveTurn() {},",
  "  detection() { return 5; },",
  "};",
].join("\n");
const RULESET_MANIFEST = {
  id: "probe-rules",
  name: "Probe Rules",
  version: "9.9.9",
  type: "system",
  rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
};
const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const waitForApp = (page: Page): Promise<void> =>
  expect
    .poll(() =>
      page.evaluate(() => (globalThis as { __vttE2E?: { app: unknown } }).__vttE2E?.app != null),
    )
    .toBe(true);

test.describe("world.zip export/import (§8)", () => {
  test("export downloads a zip; importing it restores the export point", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await waitForApp(page);

    await page.click("#add-token");
    await page.click("#add-token");
    await expect.poll(() => appCall<number>(page, "tokenCount")).toBe(2);

    // ── export: browser download of the world zip ──
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#export-world"),
    ]);
    expect(download.suggestedFilename()).toMatch(/^world-.*\.zip$/);
    const zipPath = (await download.path()) as string;
    const archive = new Uint8Array(await readFile(zipPath));
    const files = unzipSync(archive);
    const meta = JSON.parse(strFromU8(files["world.json"] as Uint8Array)) as {
      worldId: string;
      seq: number;
      format: number;
      rules: { active: string | null };
    };
    // D-248: format 2 carries the strategic ruleset pin + package index (empty here: built-in)
    expect(meta.format).toBe(2);
    expect(meta.rules).toEqual({ active: null });
    expect(JSON.parse(strFromU8(files["packages.json"] as Uint8Array))).toEqual([]);
    expect(files["documents.json"]).toBeDefined();
    const worldId = meta.worldId;
    const seqAtExport = meta.seq;

    // ── drift past the export point ──
    await page.click("#add-token");
    await expect.poll(() => appCall<number>(page, "tokenCount")).toBe(3);

    // ── import the archive through the UI; the app reboots into it ──
    const reloaded = page.waitForEvent("load", { timeout: 15_000 }); // the reload() after import
    await page.setInputFiles("#import-world", zipPath);
    await reloaded;
    await waitForApp(page);
    await expect.poll(() => appCall<number>(page, "tokenCount")).toBe(2); // restored to the export point
    expect(await appCall<string>(page, "worldId")).toBe(worldId);
    await expect.poll(() => appCall<number>(page, "seq")).toBe(seqAtExport);
  });

  test("D-248: one importer sorts zips by kind, and the world file carries its strategic ruleset to another browser", async ({
    page,
    browser,
  }: {
    page: Page;
    browser: Browser;
  }) => {
    test.skip(
      test.info().project.name === "webkit",
      "WebKit workers cannot import packages (D-086)",
    );
    test.setTimeout(120_000);
    const dir = join(tmpdir(), `vtt-worldpkg-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const rulesetPath = join(dir, "probe-rules.zip");
    writeFileSync(
      rulesetPath,
      zipOf({ "manifest.json": JSON.stringify(RULESET_MANIFEST), "rules.js": RULES_JS }),
    );
    const junkPath = join(dir, "junk.zip");
    writeFileSync(junkPath, zipOf({ "readme.txt": "not a world, not a package" }));

    try {
      await page.goto(entry + "?e2e=1");
      await waitForApp(page);
      await expect(page.locator("#status [data-rules-status]")).toHaveText(
        /strategic rules: built-in/,
      );

      // ── the sidebar importer takes a RULESET: added to this world, no reboot ──
      await page.setInputFiles("#import-world", rulesetPath);
      await expect(page.locator("[data-notify]").last()).toContainText(
        "Probe Rules v9.9.9 (strategic ruleset) added",
      );
      await expect
        .poll(() => appCall<Array<{ id: string }>>(page, "packages"))
        .toEqual([expect.objectContaining({ id: "probe-rules", active: false })]);
      expect(await appCall<string>(page, "worldId")).toBeTruthy(); // same page, same world

      // ── junk is named, not failed with a zip-internal message ──
      await page.setInputFiles("#import-world", junkPath);
      await expect(page.locator("p.error")).toContainText("neither a world file");

      // ── the Extras section talks about strategic scenes, and refuses a WORLD file ──
      await page.click("#gm-extras");
      const extras = page.locator('[data-window="gmextras"]');
      await expect(extras.locator("[data-pkg-section] h4")).toHaveText(
        "Strategic ruleset & content (§12)",
      );
      const row = extras.locator('[data-pkg-row][data-pkg-id="probe-rules"]');
      await expect(row).toContainText("strategic ruleset");
      await row.locator("[data-pkg-activate]").click();
      await expect(row.locator("[data-pkg-active]")).toHaveCount(1);
      await expect(extras.locator("[data-pkg-reload]")).toBeVisible();

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.click("#export-world"),
      ]);
      const worldPath = (await download.path()) as string;
      const archive = new Uint8Array(await readFile(worldPath));
      const files = unzipSync(archive);
      const meta = JSON.parse(strFromU8(files["world.json"] as Uint8Array)) as {
        format: number;
        name: string;
        system: string;
        rules: { active: string | null };
      };
      expect(meta.format).toBe(2);
      expect(meta.rules).toEqual({ active: "probe-rules" });
      expect(meta.system).toBe("probe-rules");
      expect(
        JSON.parse(strFromU8(files["packages.json"] as Uint8Array)) as Array<{ id: string }>,
      ).toEqual([expect.objectContaining({ id: "probe-rules", type: "system" })]);
      expect(strFromU8(files["packages/probe-rules/rules.js"] as Uint8Array)).toBe(RULES_JS);

      await extras.locator("#pkg-file").setInputFiles(worldPath);
      await expect(extras.locator("[data-pkg-error]")).toContainText("is a world file");

      // ── reload: the package now runs the strategic slot, and the status says so ──
      await page.reload();
      await waitForApp(page);
      await expect
        .poll(() => appCall<{ source: string; packageId: string | null }>(page, "rulesBoot"))
        .toEqual(expect.objectContaining({ source: "package", packageId: "probe-rules" }));
      await expect(page.locator("#status [data-rules-status]")).toHaveText(
        "strategic rules: probe-rules v9.9.9",
      );
      await expect(page.locator("[data-rules-boot-error]")).toHaveCount(0);

      // ── "another GM's machine": a fresh browser context has no packages at all ──
      const other = await browser.newContext();
      try {
        const picker = await other.newPage();
        await picker.goto(entry);
        await expect(picker.locator("#role-host")).toBeVisible();
        // the picker names a package for what it is
        await picker.setInputFiles("#role-import", rulesetPath);
        await expect(picker.locator("[data-import-error]")).toContainText(
          "Probe Rules v9.9.9 (strategic ruleset) is not a world",
        );
        // …and boots a world file on the ruleset it carries
        await picker.setInputFiles("#role-import", worldPath);
        // the picker route mounts the shell only once the boot has an app (status + canvas live)
        await expect(picker.locator("#status")).toContainText(meta.name, { timeout: 20_000 });
        await expect(picker.locator("canvas").first()).toBeVisible();
        await expect(picker.locator("#status [data-rules-status]")).toHaveText(
          "strategic rules: probe-rules v9.9.9",
        );
        await expect(picker.locator("[data-rules-boot-error]")).toHaveCount(0);
        await picker.click("#gm-extras");
        const otherExtras = picker.locator('[data-window="gmextras"]');
        await expect(
          otherExtras.locator('[data-pkg-row][data-pkg-id="probe-rules"] [data-pkg-active]'),
        ).toHaveCount(1);
      } finally {
        await other.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
