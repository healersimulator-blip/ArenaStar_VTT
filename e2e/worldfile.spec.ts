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

    // ── D-249: importing happens on the start screen — Close world, Open file, Restore ──
    await page.click("#close-world");
    const list = page.locator("[data-world-list]");
    await expect(list.locator(`[data-world-row][data-world-id="${worldId}"]`)).toBeVisible();
    await expect.poll(() => appCall<string>(page, "worldId").catch(() => null)).toBeNull(); // surface detached
    await page.setInputFiles("#role-import", zipPath);
    const dialog = page.locator("[data-open-dialog]");
    await expect(dialog).toHaveAttribute("data-open-kind", "world");
    await expect(dialog.locator("[data-open-contents]")).toContainText("built-in strategic rules");
    await expect(dialog.locator("[data-open-replace]")).toContainText("Restore over");
    await dialog.locator("[data-open-replace]").click();
    await waitForApp(page); // Root re-attaches the e2e surface to the rebooted world
    await expect.poll(() => appCall<number>(page, "tokenCount")).toBe(2); // restored to the export point
    expect(await appCall<string>(page, "worldId")).toBe(worldId);
    await expect.poll(() => appCall<number>(page, "seq")).toBe(seqAtExport);
  });

  test("D-248/D-249: Settings sorts zips by kind, and the world file carries its strategic ruleset to another browser", async ({
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

      // ── D-249: the sidebar no longer imports; packages live under Settings ──
      await expect(page.locator("#import-world")).toHaveCount(0);
      await page.click("#gm-settings");
      const extras = page.locator('[data-window="settings"]');
      await expect(extras.locator("[data-pkg-section] h4")).toHaveText(
        "Strategic ruleset & content (§12)",
      );
      await expect(extras.locator("[data-pkg-status-ruleset]")).toContainText("built-in");
      await expect(extras.locator("[data-pkg-pinned]")).toHaveCount(0); // fresh campaign: switchable

      // ── Settings takes a RULESET: added to this world, no reboot ──
      await extras.locator("#pkg-file").setInputFiles(rulesetPath);
      const row = extras.locator('[data-pkg-row][data-pkg-id="probe-rules"]');
      await expect(row).toContainText("strategic ruleset");
      await expect
        .poll(() => appCall<Array<{ id: string }>>(page, "packages"))
        .toEqual([expect.objectContaining({ id: "probe-rules", active: false })]);
      expect(await appCall<string>(page, "worldId")).toBeTruthy(); // same page, same world

      // ── junk is named, not failed with a zip-internal message ──
      await extras.locator("#pkg-file").setInputFiles(junkPath);
      await expect(extras.locator("[data-pkg-error]")).toContainText("neither a world file");

      // ── activate: the section talks about strategic scenes and offers the reload ──
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
        worldId: string;
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

      // …and refuses a WORLD file, pointing at the start screen
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
      await page.click("#gm-settings");
      await expect(extras.locator("[data-pkg-status-ruleset]")).toContainText("Probe Rules v9.9.9 (package)");

      // ── "another GM's machine": a fresh browser context has no packages at all ──
      const other = await browser.newContext();
      try {
        const picker = await other.newPage();
        await picker.goto(entry);
        await expect(picker.locator("#role-host")).toBeVisible();
        await expect(picker.locator("[data-world-empty]")).toBeVisible();
        // Open file names a package for what it is and offers the wizard instead of failing
        await picker.setInputFiles("#role-import", rulesetPath);
        const pkgDialog = picker.locator("[data-open-dialog]");
        await expect(pkgDialog).toHaveAttribute("data-open-kind", "package");
        await expect(pkgDialog).toContainText("Probe Rules v9.9.9 (strategic ruleset)");
        await expect(pkgDialog.locator("[data-open-wizard]")).toBeVisible();
        await pkgDialog.locator("[data-open-cancel]").click();
        await expect(pkgDialog).toHaveCount(0);
        // …and a world file is described (ruleset it carries) and opened as a copy
        await picker.setInputFiles("#role-import", worldPath);
        await expect(pkgDialog).toHaveAttribute("data-open-kind", "world");
        await expect(pkgDialog.locator("[data-open-contents]")).toContainText(
          "strategic ruleset Probe Rules v9.9.9",
        );
        await expect(pkgDialog.locator("#open-copy-name")).toHaveValue(`${meta.name} (copy)`);
        await expect(pkgDialog.locator("[data-open-replace]")).toContainText("Restore (keep its id)");
        await pkgDialog.locator("[data-open-copy]").click();
        // the picker route mounts the shell only once the boot has an app (status + canvas live)
        await expect(picker.locator("#status")).toContainText(`${meta.name} (copy)`, { timeout: 20_000 });
        await expect(picker.locator("canvas").first()).toBeVisible();
        await expect(picker.locator("#status [data-rules-status]")).toHaveText(
          "strategic rules: probe-rules v9.9.9",
        );
        await expect(picker.locator("[data-rules-boot-error]")).toHaveCount(0);
        await picker.click("#gm-settings");
        const otherSettings = picker.locator('[data-window="settings"]');
        await expect(
          otherSettings.locator('[data-pkg-row][data-pkg-id="probe-rules"] [data-pkg-active]'),
        ).toHaveCount(1);

        // ── back on the start screen the copy is listed under its own id; Export + Delete work ──
        await picker.click("#close-world");
        const rows = picker.locator("[data-world-list] [data-world-row]");
        await expect(rows).toHaveCount(1);
        await expect(rows.first().locator("[data-world-name]")).toHaveText(`${meta.name} (copy)`);
        await expect(rows.first()).toContainText("probe-rules v9.9.9");
        const copyId = await rows.first().getAttribute("data-world-id");
        expect(copyId).toBeTruthy();
        expect(copyId).not.toBe(meta.worldId);
        const [listDownload] = await Promise.all([
          picker.waitForEvent("download"),
          rows.first().locator("[data-world-export]").click(),
        ]);
        const listed = unzipSync(new Uint8Array(await readFile((await listDownload.path()) as string)));
        const listedMeta = JSON.parse(strFromU8(listed["world.json"] as Uint8Array)) as {
          worldId: string;
          rules: { active: string | null };
        };
        expect(listedMeta.worldId).toBe(copyId);
        expect(listedMeta.rules).toEqual({ active: "probe-rules" });
        // delete is two-step: the first click arms, the second removes the world
        await rows.first().locator("[data-world-delete]").click();
        await expect(rows.first().locator("[data-world-delete]")).toHaveAttribute("data-world-delete-armed", "true");
        await rows.first().locator("[data-world-delete]").click();
        await expect(picker.locator("[data-world-empty]")).toBeVisible();
        await expect(picker.locator("[data-start-notice]")).toContainText("Deleted");
      } finally {
        await other.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
