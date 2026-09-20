/**
 * §9 fog of war hides tokens from players (D-251), end to end over the real manual
 * signaling join (§14): the host places the party's hero and a GM-only orc, bounds sight
 * and switches fog on; the joined player's canvas draws only the hero until the hero walks
 * into the orc's reach, drops the orc again when the GM moves it out of sight (the hero
 * never moved — a replica change alone must re-gate), and shows both once fog is off.
 * The GM's own canvas is never gated. D-256 adds the manual Hide/Reveal mask on top: cover the
 * GM paints is static (no sight excuses it), it rides the scene flag, and it never swallows a
 * player's own token.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  entry,
  gmCall,
  hostCall,
  manualFragment,
  playerCall,
  surfaceCall,
  surfaceCallArg,
  waitForSurface,
} from "./lib";

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
    test.setTimeout(180_000); // 2-core sandbox: the fog loop encodes a PNG per reveal
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
    await expect.poll(async () => (await playerFog(player)).visibleTokenIds, { timeout: 45_000 }).toEqual([
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
    // The fog loop recomputes through the vision worker and encodes a PNG per reveal; on a
    // slow/loaded box these assertions need room (this spec runs last in the suite).
    await expect.poll(async () => (await playerFog(player)).visibleTokenIds, { timeout: 45_000 }).toEqual([
      "hero",
      "orc",
    ]);
    expect(await drawn(player)).toEqual(["hero", "orc"]);
    expect(await pickable(player)).toEqual(["hero", "orc"]);

    // ── the GM moves the orc back to the start; the hero did not move → re-gated anyway ──
    const revealsBefore = (await playerFog(player)).reveals;
    await surfaceCallArg(host, "app", "pf1eMoveToken", { tokenId: "orc", col: 1, row: 1 });
    await expect.poll(async () => (await playerFog(player)).visibleTokenIds, { timeout: 45_000 }).toEqual([
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

  test("D-256: the GM's Hide/Reveal mask withholds a token no sight can excuse — and never the player's own", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(180_000); // 2-core sandbox: the fog loop encodes a PNG per reveal
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    // the party's hero and an orc two squares away: in sight from the start, so the mask is
    // the only thing that can hide it
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "gm");
    const placed = await surfaceCallArg<{ ok: boolean; placed: number }>(host, "app", "pf1ePlaceTokens", [
      { id: "hero", col: 1, row: 1 },
      { id: "orc", col: 3, row: 3, owner: "gm" },
    ]);
    expect(placed).toMatchObject({ ok: true, placed: 2 });

    await host.click("#gm-settings");
    const settings = host.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    await settings.locator("[data-scene-fog]").check();
    await expect.poll(async () => (await gmCall<{ enabled: boolean }>(host, "fogState")).enabled).toBe(true);
    await settings.locator("[data-window-close]").click();

    // ── invite → join over the manual codes ──
    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    await player.goto(`${entry}?e2e=1&join=1#${manualFragment(inviteLink)}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
    await host.click("#code-apply");
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue());
    await player.click("#answer-apply");
    await waitForSurface(player, "playerCanvas");
    // both tokens are in sight (and therefore in the player's replica) before any mask
    await expect.poll(async () => (await playerFog(player)).visibleTokenIds, { timeout: 45_000 }).toEqual([
      "hero",
      "orc",
    ]);

    // ── the GM paints cover over the orc AND over the hero's own square ──
    const box = await host.locator(".canvas-host canvas").boundingBox();
    if (!box) throw new Error("canvas not mounted");
    const cam = await surfaceCall<{ x: number; y: number; scale: number }>(host, "app", "camera");
    const at = (wx: number, wy: number) => ({
      x: box.x + (wx - cam.x) * cam.scale,
      y: box.y + (wy - cam.y) * cam.scale,
    });
    const stroke = async (x1: number, y1: number, x2: number, y2: number) => {
      const a = at(x1, y1);
      const b = at(x2, y2);
      await host.mouse.move(a.x, a.y);
      await host.mouse.down();
      await host.mouse.move(b.x, b.y, { steps: 6 });
      await host.mouse.up();
    };
    // arm the brush and prove it is armed before dragging: a rail that is still re-rendering
    // would otherwise swallow the pick and the drag would land as a plain canvas gesture
    await host.locator('[data-canvas-tool="fog"]').click();
    await expect(host.locator('[data-canvas-tool="fog"]')).toHaveAttribute("aria-pressed", "true");
    await host.locator('[data-canvas-fog-shape="rect"]').click();
    await host.locator('[data-canvas-fog-brush="hide"]').click();
    await expect(host.locator('[data-canvas-fog-brush="hide"]')).toHaveAttribute("aria-pressed", "true");
    await stroke(300, 300, 400, 400); // the orc's square
    await stroke(100, 100, 200, 200); // the hero's own square
    // the GM's own replica first (a stuck drag must not be blamed on replication) …
    await expect.poll(() => hostCall<number>(host, "fogMaskStrokes"), { timeout: 45_000 }).toBe(2);
    // … then the player's, which only ever learns about it through the scene flag
    await expect.poll(() => playerCall<number>(player, "fogMaskStrokes"), { timeout: 45_000 }).toBe(2);

    // the mask is static cover: the orc is withheld although it stands in plain sight, while
    // the hero — the player's own token — is never swallowed by it
    await expect.poll(async () => (await playerFog(player)).visibleTokenIds, { timeout: 45_000 }).toEqual(["hero"]);
    expect(await drawn(player)).toEqual(["hero"]);
    expect(await pickable(player)).toEqual(["hero"]);

    // ── the GM paints the orc's square away again → it comes back ──
    await host.locator('[data-canvas-fog-brush="reveal"]').click();
    await expect(host.locator('[data-canvas-fog-brush="reveal"]')).toHaveAttribute("aria-pressed", "true");
    await stroke(300, 300, 400, 400);
    await expect.poll(() => hostCall<number>(host, "fogMaskStrokes"), { timeout: 45_000 }).toBe(3);
    await expect.poll(async () => (await playerFog(player)).visibleTokenIds, { timeout: 45_000 }).toEqual([
      "hero",
      "orc",
    ]);

    await hostCtx.close();
    await playerCtx.close();
  });
});
