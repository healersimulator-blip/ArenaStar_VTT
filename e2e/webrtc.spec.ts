import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

test.describe("WebRTC transport (§6.1, §14)", () => {
  test("bundled WebRTCTransport loops back over the four DataChannels from file://", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    const result = await page.evaluate(async () => {
      const surface = (
        globalThis as unknown as {
          __vttE2E?: { webrtcLoopback: () => Promise<unknown> };
        }
      ).__vttE2E;
      if (!surface) throw new Error("e2e hook not installed");
      return (await surface.webrtcLoopback()) as {
        ok: boolean;
        channels: string[];
        frames: number;
        errors: string[];
      };
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.channels).toEqual(["ops", "ephemeral", "assets", "sim"]);
    expect(result.frames).toBe(8); // one frame per channel per direction
  });
});

test.describe("canvas (§9 M1 subset)", () => {
  test("PixiJS stage boots in the single-file bundle with the §9 layer order", async ({ page }) => {
    await page.goto(entry + "?e2e=1");
    const result = await page.evaluate(async () => {
      const surface = (
        globalThis as unknown as {
          __vttE2E?: { canvasSmoke: () => Promise<unknown> };
        }
      ).__vttE2E;
      if (!surface) throw new Error("e2e hook not installed");
      return (await surface.canvasSmoke()) as {
        ok: boolean;
        layers: string[];
        canvasWidth: number;
        tokenCount: number;
        error?: string;
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.layers).toEqual([
      "background",
      "tilesBelow",
      "grid",
      "drawings",
      "templates",
      "walls",
      "lighting",
      "tokens",
      "models",
      "tilesAbove",
      "fog",
      "effects",
      "notes",
      "controls",
    ]);
    expect(result.canvasWidth).toBe(320);
    expect(result.tokenCount).toBe(1);
  });
});
