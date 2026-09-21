/**
 * §2.1 (G-24, D-260) — sight is bounded by light, end to end on the real join.
 *
 * Before this slice the fog loop gated tokens on line of sight alone, so a player could see an
 * orc standing in pitch darkness. Now the scene's ambient darkness and the lights themselves
 * bound what each viewer reveals: the hero's reach is `max(darkvision, min(sight, lit radius))`,
 * and a token inside it is shown only while it is lit (or inside some eye's darkvision).
 *
 * The acceptance shape is the fog spec's: a GM turn of the lights, watched by a joined player,
 * with **no token moving at all**. Every assertion reads the player's own canvas +
 * `visibleTokenIds` readback and the host's replicated `scenes.darkness` — never an internal
 * value — so a broken wiring fails here (the D-255 class of bug).
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  entry,
  gmCall,
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
const drawn = (page: Page): Promise<string[]> =>
  surfaceCall<string[]>(page, "playerCanvas", "drawnTokens");
const pickable = (page: Page): Promise<string[]> =>
  surfaceCall<string[]>(page, "playerCanvas", "pickableTokens");

/**
 * The token gate as the player experiences it: the id set the canvas publishes, the tokens it
 * draws, and the tokens a click can still reach. A hidden token is unselectable too — the same
 * three-way assertion the D-251 fog spec makes.
 */
async function expectSeen(page: Page, ids: string[]): Promise<void> {
  await expect
    .poll(async () => (await playerFog(page)).visibleTokenIds, { timeout: 45_000 })
    .toEqual(ids);
  expect(await drawn(page)).toEqual(ids);
  expect(await pickable(page)).toEqual(ids);
}

test.describe("sight bounded by lighting (§2.1, G-24)", () => {
  test("darkness hides, a torch reveals within its reach, and the GM's light can be taken away", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(240_000); // 2-core sandbox: every lighting change re-encodes the fog PNG
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const runtimeErrors: string[] = [];
    host.on("pageerror", (error) => runtimeErrors.push(error.message));
    player.on("pageerror", (error) => runtimeErrors.push(error.message));

    // ── host: the party's hero, a GM-only orc two squares away, and a farther GM-only scout ──
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "gm");
    const placed = await surfaceCallArg<{ ok: boolean; placed: number; cellSize: number }>(
      host,
      "app",
      "pf1ePlaceTokens",
      [
        { id: "hero", col: 1, row: 1 },
        { id: "orc", col: 3, row: 1, owner: "gm" },
        { id: "scout", col: 9, row: 1, owner: "gm" },
      ],
    );
    expect(placed).toMatchObject({ ok: true, placed: 3, cellSize: 100 });

    // fog on, and a scene-wide sight range of 12 squares — generous on purpose, so the
    // darkness and the torch (not the scene cap) are what the assertions turn on
    await host.click("#gm-settings");
    const settings = host.locator('[data-window="settings"]');
    await expect(settings).toBeVisible();
    const range = settings.locator("[data-scene-fog-range]");
    await range.fill("12");
    await range.press("Enter");
    await expect.poll(() => gmCall<Record<string, unknown>>(host, "sceneCoreFlags")).toEqual({
      fogRange: 12,
    });
    await settings.locator("[data-scene-fog]").check();
    await expect.poll(async () => (await gmCall<{ enabled: boolean }>(host, "fogState")).enabled).toBe(
      true,
    );
    // the world opens in daylight: no darkness authored anywhere yet
    expect(await gmCall<number>(host, "sceneDarkness")).toBe(0);
    await settings.locator("[data-window-close]").click();

    // ── invite → player joins via manual codes ──
    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    await player.goto(`${entry}?e2e=1&join=1#${manualFragment(inviteLink)}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe(
      "",
    );
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
    await host.click("#code-apply");
    await expect
      .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue());
    await player.click("#answer-apply");
    await expect
      .poll(() => playerCall<number>(player, "tokenCount"), { timeout: 20_000 })
      .toBe(3);
    await waitForSurface(player, "playerCanvas");

    // ── daylight (darkness 0): ambient light reaches everywhere, so sight alone decides ──
    // The scout is 40 ft. out, well inside the 12-square sight range.
    await expectSeen(player, ["hero", "orc", "scout"]);
    const litExplored = (await playerFog(player)).explored;
    expect(litExplored).toBeGreaterThan(0.02);
    const pos = await playerCall<{ x: number; y: number } | null>(player, "tokenPos");

    // ── the GM turns the lights down: pitch darkness, and *nothing* moves ──
    await host.click("#gm-settings");
    const reopened = host.locator('[data-window="settings"]');
    const darkness = reopened.locator("[data-scene-darkness]");
    await expect(darkness).toBeVisible();
    await darkness.focus();
    await darkness.press("End"); // a range input's End key: the maximum, through the real editor
    await expect.poll(() => gmCall<number>(host, "sceneDarkness"), { timeout: 20_000 }).toBe(1);
    await expect(reopened.locator("[data-scene-darkness-value]")).toHaveText("100%");
    await reopened.locator("[data-window-close]").click();

    // a torchless hero in the dark has nothing to see with: his own token is all that is left,
    // even though the orc is 10 ft. away and the scout never moved
    await expectSeen(player, ["hero"]);
    expect(await playerCall<{ x: number; y: number } | null>(player, "tokenPos")).toEqual(pos);
    // and the map he already explored stays explored (D-250's memory survives the lights)
    expect((await playerFog(player)).explored).toBeGreaterThanOrEqual(litExplored - 1e-6);

    // ── the GM lights a torch on the map (the real rail: tool, 6-cell radius, click) ──
    const box = await host.locator(".canvas-host canvas").boundingBox();
    if (!box) throw new Error("canvas not mounted");
    const cam = await surfaceCall<{ x: number; y: number; scale: number }>(host, "app", "camera");
    const at = (wx: number, wy: number) => ({
      x: box.x + (wx - cam.x) * cam.scale,
      y: box.y + (wy - cam.y) * cam.scale,
    });
    // the hero's square's upper-left corner — the placement tool snap this app uses
    const torchAt = at(100, 100);
    await host.click('[data-canvas-tool="light"]');
    await host.click('[data-canvas-light-radius="6"]');
    await host.mouse.click(torchAt.x, torchAt.y);
    await expect.poll(() => surfaceCall<Array<{ dim: number }>>(host, "app", "lights")).toHaveLength(
      1,
    );
    expect(
      (await surfaceCall<Array<{ dim: number; bright: number }>>(host, "app", "lights"))[0],
    ).toMatchObject({ dim: 600, bright: 300 });

    // standing in the torch's light the hero sees out to its edge: the orc at 10 ft. appears,
    // the scout at 40 ft. is beyond the light's reach and stays hidden
    await expectSeen(player, ["hero", "orc"]);
    expect(await playerCall<{ x: number; y: number } | null>(player, "tokenPos")).toEqual(pos);

    // ── the GM takes the light away: exactly the acceptance — the visible set shrinks, no
    // token has moved, and the replica still holds all three ──
    const revealsBefore = (await playerFog(player)).reveals;
    await host.click('[data-canvas-action="delete-last-placement"]');
    await expect.poll(() => surfaceCall<unknown[]>(host, "app", "lights")).toHaveLength(0);
    await expectSeen(player, ["hero"]);
    expect(await playerCall<number>(player, "tokenCount")).toBe(3);
    expect(await playerCall<{ x: number; y: number } | null>(player, "tokenPos")).toEqual(pos);
    expect((await playerFog(player)).reveals).toBeGreaterThan(revealsBefore); // the loop re-ran

    // ── daylight again: the whole map is lit, so the same tokens come back with nothing placed ──
    await host.click("#gm-settings");
    const third = host.locator('[data-window="settings"]');
    const slider = third.locator("[data-scene-darkness]");
    await slider.focus();
    await slider.press("Home");
    await expect.poll(() => gmCall<number>(host, "sceneDarkness"), { timeout: 20_000 }).toBe(0);
    await third.locator("[data-window-close]").click();
    await expectSeen(player, ["hero", "orc", "scout"]);
    expect(await playerCall<{ x: number; y: number } | null>(player, "tokenPos")).toEqual(pos);
    expect(runtimeErrors).toEqual([]);

    await hostCtx.close();
    await playerCtx.close();
  });
});
