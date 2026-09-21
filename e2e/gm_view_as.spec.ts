/**
 * §2.3 (G-25 remainder, D-262) — **the GM's "view as player X"**, end to end on the real join.
 *
 * The plan's note for this tail: the host already keeps explored fog per user + scene and the
 * mask readbacks exist, so "the slice is a viewer switch in the fog layer, not new state". The
 * acceptance is the strongest form of that claim: with the GM's canvas pointed at a player, the
 * GM's own readbacks must equal **that player's own shell** — the same tokens drawn, the same
 * tokens a click can reach, the same ids published, the same bars, and (behind all of it) the same
 * fog cover and the same explored map, because the preview reads the map that player explored.
 *
 * The scene is built so a wrong answer is visible: fog on, a GM-only orc two squares away, a
 * manual Hide stroke painted over a third token, and a fourth token the host withholds from
 * players entirely (`hidden`). The GM sees all four; the player sees their own hero; the preview
 * must agree with the player — including about the withheld token, which exists only on the GM's
 * replica and must not be resurrected by a gate that runs client-side.
 *
 * Everything is asserted through the real Settings window and the two real shells' own surfaces.
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

interface PreviewState {
  user: string | null;
  followedPlayers: number;
  drawnTokens: string[];
  pickableTokens: string[];
  visibleTokenIds: string[] | null;
  tokenHpBars: string[];
}

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

const preview = (page: Page): Promise<PreviewState> =>
  surfaceCall<PreviewState>(page, "gm", "viewAsState");
const playerFog = (page: Page): Promise<PlayerFogState> =>
  surfaceCall<PlayerFogState>(page, "playerCanvas", "fogState");
const playerBars = (page: Page): Promise<Array<{ id: string }>> =>
  surfaceCall<Array<{ id: string }>>(page, "playerCanvas", "tokenHpBars");

/**
 * Open the GM's Settings window and pick (or leave) a player in the *View as* select, asserting
 * inside the window that the choice took (the note that says what is being previewed appears for
 * a player and disappears for the GM's own view).
 */
async function chooseViewAs(page: Page, userId: string): Promise<void> {
  await page.click("#gm-settings");
  const window = page.locator('[data-window="settings"]');
  await expect(window).toBeVisible();
  const select = window.locator("[data-gm-view-as]");
  await expect(select).toBeVisible();
  await select.selectOption(userId);
  await expect(select).toHaveValue(userId);
  if (userId === "") await expect(window.locator("[data-gm-view-as-note]")).toHaveCount(0);
  else await expect(window.locator("[data-gm-view-as-note]")).toBeVisible();
  await window.locator("[data-window-close]").click();
}

test.describe("the GM's view as player X (§2.3, G-25)", () => {
  test("a previewed player's canvas, gate and bars are what that player actually has", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    test.setTimeout(240_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const runtimeErrors: string[] = [];
    for (const page of [host, player]) page.on("pageerror", (e) => runtimeErrors.push(e.message));

    // ── host: the hero (the player's), an orc the GM keeps to themselves, a masked sentry, and
    //    a token the host withholds from players outright ──
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "gm");
    const placed = await surfaceCallArg<{ ok: boolean; placed: number }>(
      host,
      "app",
      "pf1ePlaceTokens",
      [
        { id: "hero", col: 1, row: 1 },
        { id: "orc", col: 3, row: 1, owner: "gm" },
        { id: "sentry", col: 5, row: 1, owner: "gm" },
        { id: "vault", col: 7, row: 1, owner: "gm", hidden: true },
      ],
    );
    expect(placed).toMatchObject({ ok: true, placed: 4 });
    for (const actorId of ["a-hero", "a-orc", "a-sentry", "a-vault"]) {
      const authored = await surfaceCallArg<{ ok: boolean }>(host, "app", "pf1eAuthorActor", {
        actorId,
        patch: { hp: 12, hpMax: 12 },
      });
      expect(authored.ok).toBe(true);
    }
    // the GM's own view: everything the replica holds, bars included (the `"gm"` default)
    const gm = await preview(host);
    expect(gm.user).toBeNull();
    expect([...gm.drawnTokens].sort()).toEqual(["hero", "orc", "sentry", "vault"]);
    expect(gm.tokenHpBars).toEqual(["hero", "orc", "sentry", "vault"]);

    // fog on — the gate a preview runs must be a real one
    await host.click("#gm-settings");
    const settings = host.locator('[data-window="settings"]');
    await settings.locator("[data-scene-fog]").check();
    await settings.locator("[data-window-close]").click();
    await expect.poll(async () => (await gmCall<{ enabled: boolean }>(host, "fogState")).enabled).toBe(
      true,
    );

    // a manual Hide stroke over the sentry's square (columns 5–6, rows 1–2 of the grid):
    // Roll20's static mask, which a preview must respect exactly as the player's shell does
    const canvas = host.locator(".canvas-host canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no host canvas");
    const camera = await surfaceCall<{ x: number; y: number; scale: number } | null>(
      host,
      "app",
      "camera",
    );
    if (!camera) throw new Error("no camera");
    const at = (x: number, y: number) => ({
      x: box.x + (x - camera.x) * camera.scale,
      y: box.y + (y - camera.y) * camera.scale,
    });
    await host.locator('[data-canvas-tool="fog"]').click();
    await expect(host.locator('[data-canvas-tool="fog"]')).toHaveAttribute("aria-pressed", "true");
    await host.locator('[data-canvas-fog-shape="rect"]').click();
    await host.locator('[data-canvas-fog-brush="hide"]').click();
    await expect(host.locator('[data-canvas-fog-brush="hide"]')).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const a = at(500, 100);
    const b = at(700, 300);
    await host.mouse.move(a.x, a.y);
    await host.mouse.down();
    await host.mouse.move(b.x, b.y, { steps: 6 });
    await host.mouse.up();
    await expect.poll(() => hostCall<number>(host, "fogMaskStrokes"), { timeout: 20_000 }).toBe(1);

    // ── the player joins and sees the gate for real: their hero, the unmasked orc 10 ft. away,
    //    and neither the masked sentry nor the withheld vault ──
    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    await player.goto(`${entry}?e2e=1&join=1#${manualFragment(inviteLink)}`);
    await expect
      .poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
    await host.click("#code-apply");
    await expect
      .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue());
    await player.click("#answer-apply");
    // three, not four: `vault` is `hidden`, so §5 never puts it in the player's replica at all —
    // which is exactly why the GM's client-side preview has to withhold it too (core/viewAs)
    await expect.poll(() => playerCall<number>(player, "tokenCount"), { timeout: 20_000 }).toBe(3);
    await waitForSurface(player, "playerCanvas");
    await expect
      .poll(async () => (await playerFog(player)).visibleTokenIds, { timeout: 45_000 })
      .toEqual(["hero", "orc"]);
    // the player explores a little, so the preview has a map to restore (the fog loop's own save)
    await expect.poll(async () => (await playerFog(player)).explored, { timeout: 45_000 }).toBeGreaterThan(0);

    // ── the GM picks that player in the Settings window: the preview ──
    const playerId = await playerCall<string>(player, "userId");
    await chooseViewAs(host, playerId);
    await expect
      .poll(async () => (await preview(host)).user, { timeout: 20_000 })
      .toBe(playerId);

    // the preview is the player's table, read back from the GM's own canvas: the same ids
    // published, the same tokens drawn and reachable — the masked sentry and the withheld vault
    // are both gone, exactly as they are on the player's shell (the GM's own view shows all four)
    await expect
      .poll(async () => (await preview(host)).visibleTokenIds, { timeout: 45_000 })
      .toEqual(["hero", "orc"]);
    const playerCanvas = {
      drawn: await surfaceCall<string[]>(player, "playerCanvas", "drawnTokens"),
      pickable: await surfaceCall<string[]>(player, "playerCanvas", "pickableTokens"),
    };
    expect(playerCanvas.drawn).toEqual(["hero", "orc"]);
    const gmPreview = await preview(host);
    expect(gmPreview.drawnTokens).toEqual(playerCanvas.drawn);
    expect(gmPreview.pickableTokens).toEqual(playerCanvas.pickable);
    // and the bars: the default `"gm"` setting gives a *player* none — so the preview has none,
    // where the GM's own view had four
    expect(gmPreview.tokenHpBars).toEqual([]);
    expect((await playerBars(player)).map((bar) => bar.id)).toEqual([]);

    // the cover: a preview is opaque (a see-through preview is not what a player sees), and its
    // explored map is the player's own — the preview *read* it and never wrote it
    const hostFog = await surfaceCall<{ style: string | null; explored: number; restoredBytes: number }>(
      host,
      "gm",
      "fogState",
    );
    expect(hostFog.style).toBe("opaque");
    expect(hostFog.explored).toBeGreaterThan(0);
    const sceneId = (await surfaceCall<{ sceneId: string | null }>(host, "gm", "fogState")).sceneId;
    if (sceneId === null) throw new Error("no GM fog scene");
    const beforeStored = await surfaceCallArg<number>(host, "gm", "fogStoredBytesFor", {
      sceneId,
      userId: playerId,
    });
    await surfaceCall<number>(host, "gm", "fogFlush"); // flush the preview: nothing may be written
    expect(
      await surfaceCallArg<number>(host, "gm", "fogStoredBytesFor", { sceneId, userId: playerId }),
    ).toBe(beforeStored);

    // ── the GM turns the preview off: the table is theirs again, with nothing placed ──
    await chooseViewAs(host, "");
    await expect.poll(async () => (await preview(host)).user, { timeout: 20_000 }).toBeNull();
    await expect
      .poll(async () => [...(await preview(host)).drawnTokens].sort(), { timeout: 45_000 })
      .toEqual(["hero", "orc", "sentry", "vault"]);
    const restored = await preview(host);
    // the GM's own gate names every token (which is how the shell knows to release the stage's
    // filter — `drawnTokens` above is the ungated proof) and the bars come back with it
    expect([...(restored.visibleTokenIds ?? [])].sort()).toEqual([
      "hero",
      "orc",
      "sentry",
      "vault",
    ]);
    expect(restored.tokenHpBars).toEqual(["hero", "orc", "sentry", "vault"]);
    // the player is untouched by all of it: same gate, same map, same tokens
    expect((await playerFog(player)).visibleTokenIds).toEqual(["hero", "orc"]);
    expect(await playerCall<number>(player, "tokenCount")).toBe(3);
    expect(runtimeErrors).toEqual([]);

    await hostCtx.close();
    await playerCtx.close();
  });
});
