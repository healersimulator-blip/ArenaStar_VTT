import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("Armies tab + Army Management Window (§10)", () => {
  test("cards render, AMW opens, template order lands, roster virtualizes", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    const result = await page.evaluate(async () => {
      const surface = (
        globalThis as unknown as {
          __vttE2E?: { armiesSmoke: () => Promise<unknown> };
        }
      ).__vttE2E;
      if (!surface) throw new Error("e2e hook not installed");
      return (await surface.armiesSmoke()) as {
        ok: boolean;
        cards: number;
        treeUnits: number;
        rosterTotal: number;
        rosterRendered: number;
        orderLanded: boolean;
        orderPending: number;
        error?: string;
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.cards).toBe(2);
    expect(result.treeUnits).toBe(2);
    expect(result.orderLanded).toBe(true);
    expect(result.rosterTotal).toBe(120);
    expect(result.rosterRendered).toBeLessThan(60);
  });
});
