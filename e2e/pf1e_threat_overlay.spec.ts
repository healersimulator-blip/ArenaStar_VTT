import { expect, test } from "@playwright/test";
import { entry, gmCall, hostCall, waitForSurface } from "./lib";

/**
 * P02/D-197 — threatened-square highlighting on the canvas, through the real
 * selection path. Clicking a token drives `CanvasController`'s own
 * pointerdown selection (not a surface call), which triggers
 * `syncPF1eThreatOverlay` — so these tests assert that the layer drew the
 * *model's own* draw list (`pf1eThreat`'s `threatRects` count), that the
 * selection ring is on the threatening footprint, that empty space clears,
 * and that a Tiny creature (Table 8-4: threatens nothing) draws no cells.
 *
 * The default scene's grid is `{ size: 100, distance: 5, units: "ft" }`, so
 * cell (10, 8)'s centre is world (1050, 850).
 */

interface ThreatEntry {
  tokenId: string;
  size: string;
  threatKeys: string[];
  threatRects: number;
  reachFt: number;
  threatensNothing: boolean;
}

interface ThreatResult {
  ok: boolean;
  entries: ThreatEntry[];
  issues: Array<{ field: string; message: string }>;
}

interface ThreatOverlayState {
  tokenId: string | null;
  rectsDrawn: number;
  originDrawn: boolean;
}

type Placed = Array<{ id: string; col: number; row: number; size?: string }>;

const place = (page: import("@playwright/test").Page, tokens: Placed) =>
  page.evaluate((t) => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | { pf1ePlaceTokens: (x: unknown) => { ok: boolean; placed: number } }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1ePlaceTokens(t);
  }, tokens);

const threat = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const e2e = (globalThis as { __vttE2E?: Record<string, unknown> }).__vttE2E;
    const app = e2e?.app as
      | { pf1eThreat: () => ThreatResult }
      | undefined;
    if (!app) throw new Error("app surface missing");
    return app.pf1eThreat();
  });

const entryOf = (res: ThreatResult, id: string): ThreatEntry => {
  const found = res.entries.find((e) => e.tokenId === id);
  if (!found) throw new Error(`no threat entry for ${id}`);
  return found;
};

/** Click a world point through the real canvas (camera = the stage's own fit). */
async function clickWorld(
  page: import("@playwright/test").Page,
  x: number,
  y: number,
): Promise<void> {
  const canvas = page.locator(".canvas-host canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("no canvas box");
  const viewport = await canvas.evaluate((el) => ({
    width: el.clientWidth,
    height: el.clientHeight,
  }));
  const { fitRect, worldToScreen } = await import("../src/canvas/camera");
  const camera = fitRect(
    { x: 0, y: 0, width: 2000, height: 1500 },
    viewport,
    24,
  );
  const p = worldToScreen(camera, x, y);
  await page.mouse.click(box.x + p.x, box.y + p.y);
}

async function sceneWith(
  page: import("@playwright/test").Page,
  tokens: Placed,
): Promise<void> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  const placed = await place(page, tokens);
  expect(placed.ok).toBe(true);
  await expect
    .poll(async () => hostCall<number>(page, "tokenCount"))
    .toBe(tokens.length);
}

test.describe("PF1e threatened-square overlay (P02)", () => {
  test("selecting a token draws its own threatened squares and footprint ring", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await sceneWith(page, [
      { id: "fighter", col: 10, row: 8 },
      { id: "goblin", col: 13, row: 8 },
    ]);

    // Nothing selected yet: the layer is clear.
    await expect
      .poll(async () => gmCall<ThreatOverlayState>(page, "pf1eThreatOverlayState"))
      .toEqual({ tokenId: null, rectsDrawn: 0, originDrawn: false });

    // The model's own word, for cross-checking the layer against it.
    const model = await threat(page);
    expect(model.ok).toBe(true);
    const fighter = entryOf(model, "fighter");
    expect(fighter.threatRects).toBe(8); // AoN 102: the eight neighbours

    // A real pointer click on the fighter's centre selects it — the overlay
    // must draw exactly the model's draw list, plus the footprint ring.
    await clickWorld(page, 1050, 850);
    await expect
      .poll(async () => gmCall<ThreatOverlayState>(page, "pf1eThreatOverlayState"))
      .toEqual({ tokenId: "fighter", rectsDrawn: 8, originDrawn: true });

    // Clicking the goblin instead switches the overlay to its own list.
    await clickWorld(page, 1350, 850);
    await expect
      .poll(async () => gmCall<ThreatOverlayState>(page, "pf1eThreatOverlayState"))
      .toEqual({ tokenId: "goblin", rectsDrawn: 8, originDrawn: true });

    // Clicking empty space clears the selection and the overlay.
    await clickWorld(page, 150, 150);
    await expect
      .poll(async () => gmCall<ThreatOverlayState>(page, "pf1eThreatOverlayState"))
      .toEqual({ tokenId: null, rectsDrawn: 0, originDrawn: false });

    expect(errors).toEqual([]);
  });

  test("a Large tall creature's 10-ft reach and a Tiny creature's nothing, from the same model", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await sceneWith(page, [
      { id: "ogre", col: 10, row: 8, size: "Large" },
      { id: "cat", col: 14, row: 10, size: "Tiny" },
    ]);

    const model = await threat(page);
    expect(model.ok).toBe(true);
    const ogre = entryOf(model, "ogre");
    const cat = entryOf(model, "cat");
    // Table 8-4 through the real derivation: Large tall reaches 10 ft, Tiny
    // threatens nothing.
    expect(ogre.reachFt).toBe(10);
    expect(ogre.threatRects).toBeGreaterThan(8);
    expect(cat.threatensNothing).toBe(true);
    expect(cat.threatRects).toBe(0);

    // The ogre's footprint is 2×2 cells; its centre is world (1100, 900).
    await clickWorld(page, 1100, 900);
    await expect
      .poll(async () => gmCall<ThreatOverlayState>(page, "pf1eThreatOverlayState"))
      .toEqual({
        tokenId: "ogre",
        rectsDrawn: ogre.threatRects,
        originDrawn: true,
      });

    // The cat is selected but draws no threat cells — the ring alone shows
    // what Table 8-4 says it cannot do.
    await clickWorld(page, 1450, 1050);
    await expect
      .poll(async () => gmCall<ThreatOverlayState>(page, "pf1eThreatOverlayState"))
      .toEqual({ tokenId: "cat", rectsDrawn: 0, originDrawn: true });

    expect(errors).toEqual([]);
  });
});
