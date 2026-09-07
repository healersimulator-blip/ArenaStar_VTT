import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("tabletop parity (§7/§10)", () => {
  test("clock sync, audio loop, journal secrets, table draws", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    const result = await page.evaluate(async () => {
      const surface = (
        globalThis as unknown as {
          __vttE2E?: { paritySmoke: () => Promise<unknown> };
        }
      ).__vttE2E;
      if (!surface) throw new Error("e2e hook not installed");
      return (await surface.paritySmoke()) as {
        ok: boolean;
        clockOffsetMs: number | null;
        rttMs: number | null;
        audioLanded: boolean;
        scheduledDelayMs: number | null;
        soundState: string | null;
        secretVisible: boolean;
        tablePosted: boolean;
        error?: string;
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.audioLanded).toBe(true);
    expect(result.secretVisible).toBe(true);
    expect(result.tablePosted).toBe(true);
    expect(Math.abs(result.clockOffsetMs ?? 9999)).toBeLessThan(5000);
  });

  test("sidebar tabs: journals panel renders markdown + secret for GM", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    await page.click('[data-tab="journals"]');
    await page.click("#journal-create");
    await expect(page.locator(".journals .page")).toBeVisible();
    // the default page seeds a <secret> block — GM sees it highlighted
    await expect(page.locator(".journals [data-secret]")).toHaveCount(1);
  });
});
