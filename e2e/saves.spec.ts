import { test, expect, type Page } from "@playwright/test";
import { entry, hostCall, waitForSurface } from "./lib";

test.setTimeout(90_000);
async function boot(page: Page) {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await expect.poll(() => hostCall(page, "camera")).not.toBeNull();
}
async function diskSequence(page: Page, worldId: string): Promise<number> {
  return page.evaluate(id => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open("vtt");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("worlds", "readonly");
      const request = tx.objectStore("worlds").get(id);
      request.onsuccess = () => { resolve(request.result?.flushedSeq ?? -1); db.close(); };
      request.onerror = () => { reject(request.error); db.close(); };
    };
  }), worldId);
}

test("quiet autosave, explicit save in Settings, reload and backup download", async ({ page }) => {
  await boot(page);
  const worldId = await hostCall<string>(page, "worldId");
  await page.click("#add-token");
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  const seq = await hostCall<number>(page, "seq");
  await expect.poll(() => diskSequence(page, worldId)).toBeGreaterThanOrEqual(seq);
  await expect(page.locator("[data-save-warning]")).toHaveCount(0);
  await page.click("#gm-settings");
  const settings = page.locator('[data-window="settings"]');
  await settings.locator("[data-save-now]").click();
  await expect(settings.getByRole("status")).toContainText("Saved on this device");
  await expect(settings.locator("[data-save-status]")).toContainText("Last saved");
  await settings.getByText("Backups & portability", { exact: true }).click();
  const downloading = page.waitForEvent("download");
  await settings.getByRole("button", { name: "Download world backup" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  expect(await download.failure()).toBeNull();
  await page.reload();
  await waitForSurface(page, "app");
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
});

test("save failure is persistent but non-modal; close stays on table until retry succeeds", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    Object.defineProperty(globalThis, "__restoreSaveStorage", {
      configurable: true, value: () => { IDBDatabase.prototype.transaction = original; },
    });
    IDBDatabase.prototype.transaction = function(this: IDBDatabase, ...args: Parameters<typeof original>) {
      if (this.name === "vtt" && args[1] === "readwrite") throw new DOMException("Test storage quota exhausted", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await page.click("#add-token");
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  await expect(page.locator("[data-save-warning]")).toContainText("Saving needs attention");
  await page.click("#close-world");
  await expect(page.locator('[aria-label="Game table"]')).toBeVisible();
  await expect(page.locator("[data-save-warning]")).toBeVisible();
  await page.evaluate(() => {
    (globalThis as typeof globalThis & { __restoreSaveStorage: () => void }).__restoreSaveStorage();
  });
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.locator("[data-save-warning]")).toHaveCount(0);
  await page.click("#close-world");
  await expect(page.locator('[aria-label="Game table"]')).toHaveCount(0);
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
});

test("a second GM tab cannot concurrently open the same world", async ({ page, context }) => {
  await boot(page);
  test.skip(!(await page.evaluate(() => !!navigator.locks)), "Origin does not provide Web Locks");
  const second = await context.newPage();
  await second.goto(entry + "?e2e=1");
  await expect(second.getByRole("alert")).toContainText("already open in another GM tab");
  await page.click("#close-world");
  await expect(page.locator('[aria-label="Game table"]')).toHaveCount(0);
  await second.reload();
  await waitForSurface(second, "app");
  await expect(second.locator('[aria-label="Game table"]')).toBeVisible();
  await second.close();
});
