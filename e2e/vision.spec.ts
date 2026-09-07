import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("vision stack (§9)", () => {
  test("walls → vision.worker polygon → lighting/fog layers → fog.put lands on host", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    const result = await page.evaluate(async () => {
      const surface = (
        globalThis as unknown as {
          __vttE2E?: { visionSmoke: () => Promise<unknown> };
        }
      ).__vttE2E;
      if (!surface) throw new Error("e2e hook not installed");
      return (await surface.visionSmoke()) as {
        ok: boolean;
        workerPoly: number;
        wallSegments: number;
        fogReadbackBytes: number;
        fogPutLanded: boolean;
        error?: string;
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.workerPoly).toBeGreaterThan(8);
    expect(result.wallSegments).toBe(5); // the open doorway drops out of sight geometry
    expect(result.fogReadbackBytes).toBeGreaterThan(100);
    expect(result.fogPutLanded).toBe(true);
  });
});
