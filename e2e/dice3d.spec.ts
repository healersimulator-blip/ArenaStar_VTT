import { expect, test, type Page } from "@playwright/test";
import { entry } from "./lib";

/**
 * §11 3D dice: chat rolls drive a lazy-loaded (Blob-URL module) three.js
 * overlay whose dice ALWAYS settle on the already-determined result — the
 * host resolved the roll before the animation started.
 */

const gmCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const surface = (globalThis as { __vttE2E?: { gm?: Record<string, () => T> } }).__vttE2E;
    const fn = surface?.gm?.[m];
    if (typeof fn !== "function") throw new Error(`gm surface missing: ${m}`);
    return fn();
  }, method);

test.describe("3D dice (§11)", () => {
  test("chat roll drives the overlay; dice settle on the determined values", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(entry + "?e2e=1");

    // wait for boot (app surface) — the gm surface follows after canvas setup
    await expect
      .poll(() =>
        page.evaluate(() => {
          const s = (globalThis as { __vttE2E?: { gm?: Record<string, () => unknown> } }).__vttE2E;
          return typeof s?.gm?.["dice3d"] === "function";
        }),
      )
      .toBe(true);

    const before = await gmCall<{ loads: number; rolls: number; settled: number }>(page, "dice3d");
    expect(before.loads).toBe(0); // three.js not parsed before the first roll

    // /roll 2d6 + 1d20 through the chat box (host-crypto resolution)
    await page.fill("#chat-input", "/roll 2d6 + 1d20");
    await page.click("#chat-send");

    // overlay ran: three lazily loaded once, roll recorded
    await expect
      .poll(() => gmCall<{ loads: number; rolls: number }>(page, "dice3d").then((s) => s.loads))
      .toBe(1);
    await expect.poll(() => gmCall<{ rolls: number }>(page, "dice3d").then((s) => s.rolls)).toBe(1);

    // settled values: 2×d6 (1..6) + 1×d20 (1..20), and d6+d6+d20 == total
    const stats = await gmCall<{
      settled: number;
      lastValues: number[];
      lastTotal: number | null;
      disposed: boolean;
    }>(page, "dice3d");
    await expect
      .poll(() => gmCall<{ settled: number }>(page, "dice3d").then((s) => s.settled), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(1);
    const settledStats = await gmCall<{
      lastValues: number[];
      lastTotal: number | null;
    }>(page, "dice3d");
    expect(settledStats.lastValues).toHaveLength(3);
    expect(settledStats.lastValues[0]).toBeGreaterThanOrEqual(1);
    expect(settledStats.lastValues[0]).toBeLessThanOrEqual(6);
    expect(settledStats.lastValues[1]).toBeGreaterThanOrEqual(1);
    expect(settledStats.lastValues[1]).toBeLessThanOrEqual(6);
    expect(settledStats.lastValues[2]).toBeGreaterThanOrEqual(1);
    expect(settledStats.lastValues[2]).toBeLessThanOrEqual(20);
    const sum =
      (settledStats.lastValues[0] ?? 0) +
      (settledStats.lastValues[1] ?? 0) +
      (settledStats.lastValues[2] ?? 0);
    expect(settledStats.lastTotal).toBe(sum);

    // overlay cleans up (canvas removed) after the hold window
    await expect
      .poll(() => gmCall<{ disposed: boolean }>(page, "dice3d").then((s) => s.disposed), {
        timeout: 20_000,
      })
      .toBe(true);
    expect(stats).toBeTruthy();
  });
});
