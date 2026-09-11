import { expect, test } from "@playwright/test";
import { entry, hostCall, waitForSurface } from "./lib";

/**
 * P5/C01 — PF1e grid targeting through the real bundled scene.
 *
 * The default scene (hostBoot) is 2000×1500 with `grid { size: 100, distance: 5,
 * units: "ft", diagonals: "555" }`, and `#add-token` drops a 100×100 token at
 * the scene centre (1000, 750) — i.e. covering cells (9,7)…(10,8). A 5-ft. burst
 * centred on the intersection (10, 8) is therefore exactly that 2×2, which is
 * what makes these assertions exact rather than approximate.
 */

interface AreaResult {
  ok: boolean;
  cellSize: number;
  feetPerCell: number;
  diagonals: string;
  cells: number;
  cellKeys: string[];
  affectedTokenIds: string[];
  previewRects: number;
  issues: Array<{ field: string; message: string }>;
}

const area = (
  page: import("@playwright/test").Page,
  spec: Record<string, unknown>,
) =>
  page.evaluate(
    (s) => {
      const e2e = (globalThis as { __vttE2E?: Record<string, unknown> })
        .__vttE2E;
      const app = e2e?.app as
        { pf1eArea: (x: unknown) => AreaResult } | undefined;
      if (!app) throw new Error("app surface missing");
      return app.pf1eArea(s);
    },
    { kind: "burst", originCol: 10, originRow: 8, radiusFt: 5, ...spec },
  );

interface PreviewResult {
  ok: boolean;
  issues: Array<{ field: string; message: string }>;
  cells: number;
  affectedTokenIds: string[];
  label: string;
}

interface PreviewState {
  visible: boolean;
  rectsDrawn: number;
  highlights: number;
}

/** The preview surfaces live on the gm object (installed with the app shell). */
const gmPreview = <T>(
  page: import("@playwright/test").Page,
  method:
    "pf1eAreaPreviewShow" | "pf1eAreaPreviewClear" | "pf1eAreaPreviewState",
  arg?: unknown,
): Promise<T> =>
  page.evaluate(
    ({ m, a }) => {
      const e2e = (globalThis as { __vttE2E?: Record<string, unknown> })
        .__vttE2E;
      const gm = e2e?.gm as
        Record<string, (...x: unknown[]) => unknown> | undefined;
      if (!gm) throw new Error("gm surface missing");
      const fn = gm[m];
      if (typeof fn !== "function") throw new Error(`gm surface missing: ${m}`);
      return fn(a) as T;
    },
    { m: method, a: arg },
  );

test.describe("PF1e grid targeting (§9/P5 C01)", () => {
  test("resolves an area from the live scene's grid metadata, not hardcoded constants", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");

    const res = await area(page, { originCol: 10, originRow: 8, radiusFt: 15 });
    expect(res.ok).toBe(true);
    expect(res.issues).toEqual([]);
    // Scene metadata flowed through: the scene's own cell size and feet scale.
    expect(res.cellSize).toBe(100);
    expect(res.feetPerCell).toBe(5);
    // The canonical 15-ft.-radius burst is 24 cells (rows of 2/4/6/6/4/2).
    expect(res.cells).toBe(24);
    expect(res.previewRects).toBe(res.cells);
    expect(errors).toEqual([]);
  });

  test("counts spell areas 5-10-5 even though the scene's ruler is set to 555", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    // hostBoot ships the default scene with diagonals "555"; AoN 212 fixes
    // spell-area counting at "every second diagonal counts as 2 squares", so a
    // GM retuning the ruler must not change which squares a fireball covers.
    const gridSize = await hostCall<number | null>(page, "gridSize");
    expect(gridSize).toBe(100);
    const res = await area(page, { originCol: 10, originRow: 8, radiusFt: 15 });
    expect(res.diagonals).toBe("5105");
    expect(res.cells).toBe(24);
  });

  test("selects exactly the tokens whose cells the area touches", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.click("#add-token");
    // The token lands at (1000, 750) covering cells (9,7)..(10,8).
    await expect.poll(async () => hostCall<number>(page, "tokenCount")).toBe(1);

    // A 5-ft. burst on intersection (10, 8) is exactly that 2×2.
    const onToken = await area(page, {
      originCol: 10,
      originRow: 8,
      radiusFt: 5,
    });
    expect(onToken.cells).toBe(4);
    expect(onToken.cellKeys.sort()).toEqual(["10,7", "10,8", "9,7", "9,8"]);
    expect(onToken.affectedTokenIds).toHaveLength(1);

    // The same burst two hundred feet away touches nothing.
    const offToken = await area(page, {
      originCol: 0,
      originRow: 0,
      radiusFt: 5,
    });
    expect(offToken.cells).toBe(4);
    expect(offToken.affectedTokenIds).toEqual([]);
  });

  test("refuses an unsupported shape with a named issue instead of guessing", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    // Cone and line are deferred to C01b: their grid templates are contested and
    // must be transcribed from a canonical figure before being encoded.
    const res = await area(page, {
      kind: "cone",
      originCol: 10,
      originRow: 8,
      radiusFt: 15,
    });
    expect(res.ok).toBe(false);
    expect(res.cells).toBe(0);
    const kind = res.issues.find((i) => i.field === "kind");
    expect(kind?.message).toMatch(/C01b/);
  });

  test("renders the canvas preview overlay and highlights affected tokens (C01)", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "app");
    await page.click("#add-token");
    // The token lands at (1000, 750) covering cells (9,7)..(10,8).
    await expect.poll(async () => hostCall<number>(page, "tokenCount")).toBe(1);

    // Nothing is drawn before a preview is shown.
    expect(await gmPreview<PreviewState>(page, "pf1eAreaPreviewState")).toEqual(
      {
        visible: false,
        rectsDrawn: 0,
        highlights: 0,
      },
    );

    // Show the burst that is exactly the token's 2×2: the overlay layer draws
    // the four cell rects and the one token highlight ring.
    const shown = await gmPreview<PreviewResult>(page, "pf1eAreaPreviewShow", {
      kind: "burst",
      originCol: 10,
      originRow: 8,
      radiusFt: 5,
    });
    expect(shown.ok).toBe(true);
    expect(shown.cells).toBe(4);
    expect(shown.affectedTokenIds).toHaveLength(1);
    expect(shown.label).toBe("5-ft. radius burst");
    expect(await gmPreview<PreviewState>(page, "pf1eAreaPreviewState")).toEqual(
      {
        visible: true,
        rectsDrawn: 4,
        highlights: 1,
      },
    );

    // A refused shape is reported, never drawn.
    const refused = await gmPreview<PreviewResult>(
      page,
      "pf1eAreaPreviewShow",
      {
        kind: "cone",
        originCol: 10,
        originRow: 8,
        radiusFt: 15,
      },
    );
    expect(refused.ok).toBe(false);
    expect(refused.issues.some((i) => /C01b/.test(i.message))).toBe(true);
    expect(await gmPreview<PreviewState>(page, "pf1eAreaPreviewState")).toEqual(
      {
        visible: false,
        rectsDrawn: 0,
        highlights: 0,
      },
    );

    // Re-show, then clear: the overlay empties again.
    await gmPreview<PreviewResult>(page, "pf1eAreaPreviewShow", {
      kind: "burst",
      originCol: 10,
      originRow: 8,
      radiusFt: 5,
    });
    await gmPreview<undefined>(page, "pf1eAreaPreviewClear");
    expect(await gmPreview<PreviewState>(page, "pf1eAreaPreviewState")).toEqual(
      {
        visible: false,
        rectsDrawn: 0,
        highlights: 0,
      },
    );
    expect(errors).toEqual([]);
  });
});
