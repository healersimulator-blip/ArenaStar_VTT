import { expect, test } from "@playwright/test";
import { entry, waitForSurface, wavSilence } from "./lib";

// Real host/manager/Undo/renderer path, with only the first browser decode held back.
// This models a decoder finishing after Stop, not a forged cue or a mocked host.
for (const kind of ["image", "sound"] as const) test(`a stopped ${kind} start cannot warn about or disturb the persistent effect restored by Undo`, async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
  await page.locator("#gm-macros").click(); await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-share]").check();
  await wizard.locator('input[type="file"]').setInputFiles({ name: kind === "image" ? "pending-ward.png" : "pending-ward.wav", mimeType: kind === "image" ? "image/png" : "audio/wav",
    buffer: kind === "sound" ? wavSilence() : Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Sq9hX8AAAAASUVORK5CYII=", "base64") });
  await expect(wizard.getByRole("status")).toContainText("Imported");
  await wizard.locator("[data-fx-name]").fill("Pending ward");
  await wizard.getByRole("button", { name: kind === "image" ? "Image / video" : "Sound", exact: true }).click();
  await wizard.locator("[data-fx-section]").getByRole("combobox", { name: "Media" }).selectOption({ index: 1 });
  await wizard.locator("[data-fx-persistent]").check();
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li")).toContainText(["Pending ward"]);
  await page.evaluate((kind) => {
    const pending: { reject?: (reason: Error) => void; audio?: HTMLMediaElement } = {};
    (globalThis as unknown as { __pendingWard: typeof pending }).__pendingWard = pending;
    if (kind === "image") {
      const original = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function () {
        HTMLImageElement.prototype.decode = original;
        return new Promise<void>((_resolve, reject) => { pending.reject = reject; });
      };
    } else {
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!pending.reject) return new Promise<void>((_resolve, reject) => { pending.reject = reject; });
        HTMLMediaElement.prototype.play = original;
        pending.audio = this; // observe the real replacement element; do not mock its playback
        return original.call(this);
      };
    }
  }, kind);
  await wizard.locator("[data-fx-run]").click();
  await expect.poll(() => page.evaluate(() => !!(globalThis as unknown as {
    __pendingWard?: { reject?: unknown };
  }).__pendingWard?.reject)).toBe(true);
  await page.locator("[data-macro-fx-manager-tab]").click();
  const manager = page.locator("[data-fx-manager]");
  await expect(manager.locator("[data-fx-instance]")).toHaveCount(1);
  await manager.getByRole("button", { name: "Stop Pending ward" }).click();
  await expect(manager.locator("[data-fx-instance]")).toHaveCount(0);
  await page.getByRole("button", { name: /Undo \(Ctrl\+Z\)/ }).click();
  await expect(manager.locator("[data-fx-instance]")).toHaveCount(1);
  const count = () => page.evaluate((kind) => {
    const globals = globalThis as unknown as {
      __stage?: { getFxLayer(): { count: number } };
      __pendingWard?: { audio?: HTMLMediaElement };
    };
    if (kind === "image") return globals.__stage?.getFxLayer().count ?? 0;
    const audio = globals.__pendingWard?.audio;
    return audio && !audio.paused && audio.getAttribute("src") ? 1 : 0;
  }, kind);
  await expect.poll(count).toBe(1);
  await page.evaluate(async () => {
    const pending = (globalThis as unknown as { __pendingWard: { reject: (reason: Error) => void } }).__pendingWard;
    pending.reject(new Error("cancelled ward decode unsupported"));
    // Drain promise handlers and let both the renderer and Svelte publish their result.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  expect(await count()).toBe(1);
  await expect(page.locator("[data-notify]").filter({ hasText: "cancelled ward" })).toHaveCount(0);
  await manager.getByRole("button", { name: "Stop Pending ward" }).click();
  await expect.poll(count).toBe(0);
});
