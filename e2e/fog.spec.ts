import { expect, test } from "@playwright/test";
import { entry, gmCall, surfaceCallArg, waitForSurface } from "./lib";

interface FogState {
  sceneId: string | null;
  enabled: boolean;
  restored: boolean;
  restoredBytes: number;
  reveals: number;
  saves: number;
  lastSaveBytes: number;
  explored: number;
  shown: boolean | null;
  stored: number;
}

const fog = (page: Parameters<typeof gmCall>[0]): Promise<FogState> => gmCall<FogState>(page, "fogState");
const exploredAt = (page: Parameters<typeof gmCall>[0], x: number, y: number): Promise<boolean | null> =>
  surfaceCallArg<boolean | null>(page, "gm", "fogExploredAt", { x, y });

test.describe("explored fog of war (§9, D-250)", () => {
  test("Settings switch → tokens uncover → god view only hides → the map survives a reload", async ({
    page,
  }) => {
    await page.goto(entry + "?e2e=1");
    await waitForSurface(page, "gm");

    // off by default: no scene changes until the GM asks for it
    expect((await fog(page)).enabled).toBe(false);

    // one vision token near the top-left corner (cell 1,1 of a 100 px grid → centre 150,150)
    await surfaceCallArg(page, "app", "pf1ePlaceTokens", [{ id: "scout", col: 1, row: 1 }]);

    // ── bound sight to 6 squares, then switch fog on for the scene, through the real editor ──
    // (the range first: with no walls an unbounded first reveal would uncover the whole scene)
    await page.click("#gm-settings");
    const settings = page.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    const range = settings.locator("[data-scene-fog-range]");
    await range.fill("6");
    await range.press("Enter");
    await expect.poll(() => gmCall<Record<string, unknown>>(page, "sceneCoreFlags")).toEqual({
      fogRange: 6,
    });
    await settings.locator("[data-scene-fog]").check();
    await expect.poll(async () => (await fog(page)).enabled).toBe(true);

    // the scout uncovers its surroundings; god view (on by default) keeps the cover hidden
    await expect.poll(async () => (await fog(page)).explored).toBeGreaterThan(0.02);
    const first = await fog(page);
    expect(first.sceneId).toBe("scene-1");
    expect(first.restored).toBe(true);
    expect(first.restoredBytes).toBe(0); // nothing was stored before
    expect(first.shown).toBe(false);
    expect(first.explored).toBeLessThan(0.5); // the range clips the reveal well short of the scene
    expect(await exploredAt(page, 150, 150)).toBe(true);
    expect(await exploredAt(page, 1000, 750)).toBe(false);
    expect(await exploredAt(page, 1750, 1250)).toBe(false);

    // god view off → the cover is drawn (the same texture, nothing recomputed)
    await settings.locator("[data-gm-god-view]").uncheck();
    await expect.poll(async () => (await fog(page)).shown).toBe(true);

    // ── move the scout to the far corner: the first area stays uncovered (memory) ──
    await surfaceCallArg(page, "app", "pf1eMoveToken", { tokenId: "scout", col: 17, row: 12 });
    await expect.poll(async () => (await fog(page)).explored).toBeGreaterThan(first.explored + 0.02);
    const both = await fog(page);
    expect(await exploredAt(page, 150, 150)).toBe(true);
    expect(await exploredAt(page, 1750, 1250)).toBe(true);
    expect(await exploredAt(page, 1000, 750)).toBe(false);

    // ── persist: the flush uploads the map and the host's fog store holds it ──
    const saves = await gmCall<number>(page, "fogFlush");
    expect(saves).toBeGreaterThanOrEqual(1);
    const saved = await fog(page);
    expect(saved.lastSaveBytes).toBeGreaterThan(100);
    expect(saved.stored).toBe(saved.lastSaveBytes);

    // ── reload: the scout only sees the far corner now, yet the first area is still uncovered ──
    await page.reload();
    await waitForSurface(page, "gm");
    await expect.poll(async () => (await fog(page)).restored).toBe(true);
    await expect.poll(async () => (await fog(page)).reveals).toBeGreaterThan(0);
    const restored = await fog(page);
    expect(restored.restoredBytes).toBe(saved.lastSaveBytes);
    expect(restored.explored).toBeGreaterThan(both.explored - 0.02);
    expect(await exploredAt(page, 150, 150)).toBe(true); // ← came back from the store
    expect(await exploredAt(page, 1750, 1250)).toBe(true);
    expect(await exploredAt(page, 1000, 750)).toBe(false);

    // ── switch fog off again: the cover goes away, the scene is back to normal ──
    await page.click("#gm-settings");
    const reopened = page.locator('[data-window="settings"]');
    await expect(reopened.locator("[data-scene-fog]")).toBeChecked();
    await reopened.locator("[data-scene-fog]").uncheck();
    await expect.poll(async () => (await fog(page)).enabled).toBe(false);
    expect((await fog(page)).shown).toBe(false);
  });
});
