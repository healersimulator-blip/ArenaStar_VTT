import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("grids + templates + drawings (§9)", () => {
  test("hex snap in-page; template/drawing layers draw; cone hit-test", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    const result = await page.evaluate(async () => {
      const surface = (
        globalThis as unknown as {
          __vttE2E?: { gridsSmoke: () => Promise<unknown> };
        }
      ).__vttE2E;
      if (!surface) throw new Error("e2e hook not installed");
      return (await surface.gridsSmoke()) as {
        ok: boolean;
        snapped: { x: number; y: number };
        isCenter: boolean;
        error?: string;
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.isCenter).toBe(true);
  });
});
