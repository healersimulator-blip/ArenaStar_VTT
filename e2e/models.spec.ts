import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("ModelLayer (§9A)", () => {
  test("13k models render at LOD0/1/2 with density demotion; hit-test + box-select", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    const result = await page.evaluate(async () => {
      const surface = (
        globalThis as unknown as {
          __vttE2E?: { modelsSmoke: () => Promise<unknown> };
        }
      ).__vttE2E;
      if (!surface) throw new Error("e2e hook not installed");
      return (await surface.modelsSmoke()) as {
        ok: boolean;
        lod0: number;
        lod1Units: number;
        lod2Armies: number;
        culled: number;
        hitUnit: string | null;
        boxUnits: string[];
        syncMs: number;
        atlasBound: number;
        atlasFrames: number;
        atlasDropped: number;
        error?: string;
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.hitUnit).toBe("u-r1");
    expect(result.boxUnits).toEqual(["u-r1"]);
    expect(result.lod1Units).toBe(3);
    expect(result.lod2Armies).toBe(2);
    // §7 (D-085): infantry/cavalry/artillery × 2 faction palettes → 1 bound
    // atlas, 3 distinct frames, nothing dropped, marker fallback unused
    expect(result.atlasBound).toBe(1);
    expect(result.atlasFrames).toBe(3);
    expect(result.atlasDropped).toBe(0);
  });
});
