import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

const appCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const surface = (globalThis as { __vttE2E?: { app: Record<string, () => T> | null } }).__vttE2E;
    const fn = surface?.app?.[m];
    if (typeof fn !== "function") throw new Error(`app surface missing: ${m}`);
    return fn() as T;
  }, method);

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
    };
    expect(meta.format).toBe(1);
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
});
