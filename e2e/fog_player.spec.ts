/**
 * §9 fog of war hides tokens from players (D-251), end to end over the real manual
 * signaling join (§14): the host places the party's hero and a GM-only orc, bounds sight
 * and switches fog on; the joined player's canvas draws only the hero until the hero walks
 * into the orc's reach, drops the orc again when the GM moves it out of sight (the hero
 * never moved — a replica change alone must re-gate), and shows both once fog is off.
 * The GM's own canvas is never gated.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { entry, gmCall, manualFragment, surfaceCall, surfaceCallArg, waitForSurface } from "./lib";

interface PlayerFogState {
  sceneId: string | null;
  enabled: boolean;
  restored: boolean;
  reveals: number;
  explored: number;
  shown: boolean | null;
  style: string | null;
  visibleTokenIds: string[] | null;
}

const playerFog = (page: Page): Promise<PlayerFogState> =>
  surfaceCall<PlayerFogState>(page, "playerCanvas", "fogState");
const drawn = (page: Page): Promise<string[]> => surfaceCall<string[]>(page, "playerCanvas", "drawnTokens");
const pickable = (page: Page): Promise<string[]> =>
  surfaceCall<string[]>(page, "playerCanvas", "pickableTokens");

test.describe("fog of war hides tokens from players (§9, D-251)", () => {
  test("player sees own token always, others only in sight; GM sees all under a translucent cover", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(120_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    // ── host: the party's hero (everyone owns it) and a GM-only orc far away ──
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "gm");
    const placed = await surfaceCallArg<{ ok: boolean; placed: number }>(host, "app", "pf1ePlaceTokens", [
      { id: "hero", col: 1, row: 1 },
      { id: "orc", col: 15, row: 10, owner: "gm" },
    ]);
    expect(placed).toMatchObject({ ok: true, placed: 2 });

    // sight 6 squares, then fog on — through the real Settings editor
    await host.click("#gm-settings");
    const settings = host.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    const range = settings.locator("[data-scene-fog-range]");
    await range.fill("6");
    await range.press("Enter");
    await expect.poll(() => gmCall<Record<string, unknown>>(host, "sceneCoreFlags")).toEqual({ fogRange: 6 });
    await settings.locator("[data-scene-fog]").check();
    await expect.poll(async () => (await gmCall<{ enabled: boolean }>(host, "fogState")).enabled).toBe(true);
    // the GM's cover is translucent and every token stays on the GM's canvas
    const gmState = await gmCall<{ style: string | null; shown: boolean | null }>(host, "fogState");
    expect(gmState).toMatchObject({ shown: true, style: "translucent" });
    await settings.locator("[data-window-close]").click();

    // ── invite → player joins via manual codes ──
    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    const fragment = manualFragment(inviteLink);
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    const offerCode = await player.locator("#offer-out").inputValue();
    await host.fill("#peer-code", offerCode);
    await host.click("#code-apply");
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    const answerCode = await host.locator("#share-out").inputValue();
    await player.fill("#answer-input", answerCode);
    await player.click("#answer-apply");

    // the replica holds both tokens (the orc is not `hidden`, only unowned)…
    await expect.poll(() => surfaceCall<number>(player, "player", "tokenCount"), { timeout: 20_000 }).toBe(2);
    await waitForSurface(player, "playerCanvas");

    // …but the canvas draws only the hero: the orc stands 14 squares away, outside sight
    await expect.poll(async () => (await playerFog(player)).visibleTokenIds, { timeout: 20_000 }).toEqual([
      "hero",
    ]);
    const entered = await playerFog(player);
    expect(entered).toMatchObject({ sceneId: "scene-1", enabled: true, shown: true, style: "opaque" });
    expect(entered.restored).toBe(true);
    expect(entered.reveals).toBeGreaterThan(0);
    expect(entered.explored).toBeGreaterThan(0.02);
    expect(await drawn(player)).toEqual(["hero"]);
    expect(await pickable(player)).toEqual(["hero"]); // no select / sheet / menu through fog

    // ── the hero walks next to the orc → the orc appears ──
    await surfaceCallArg(host, "app", "pf1eMoveToken", { tokenId: "hero", col: 14, row: 10 });
    await expect.poll(async () => (await playerFog(player)).visibleTokenIds, { timeout: 20_000 }).toEqual([
      "hero",
      "orc",
    ]);
    expect(await drawn(player)).toEqual(["hero", "orc"]);
    expect(await pickable(player)).toEqual(["hero", "orc"]);

    // ── the GM moves the orc back to the start; the hero did not move → re-gated anyway ──
    const revealsBefore = (await playerFog(player)).reveals;
    await surfaceCallArg(host, "app", "pf1eMoveToken", { tokenId: "orc", col: 1, row: 1 });
    await expect.poll(async () => (await playerFog(player)).visibleTokenIds, { timeout: 20_000 }).toEqual([
      "hero",
    ]);
    expect(await drawn(player)).toEqual(["hero"]);
    expect((await playerFog(player)).reveals).toBe(revealsBefore); // no eye moved: nothing recomputed
    // the corner is remembered (explored) yet the orc standing there is not shown
    expect(await surfaceCallArg<boolean | null>(host, "gm", "fogExploredAt", { x: 150, y: 150 })).toBe(true);

    // ── fog off for the scene → everything is drawn again ──
    await host.click("#gm-settings");
    const reopened = host.locator('[data-window="settings"]');
    await reopened.locator("[data-scene-fog]").uncheck();
    await expect.poll(async () => (await playerFog(player)).enabled, { timeout: 20_000 }).toBe(false);
    expect((await playerFog(player)).visibleTokenIds).toBeNull();
    expect(await drawn(player)).toEqual(["hero", "orc"]);
    expect(await pickable(player)).toEqual(["hero", "orc"]);

    await hostCtx.close();
    await playerCtx.close();
  });
});
