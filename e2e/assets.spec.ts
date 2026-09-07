import { test, expect } from "@playwright/test";
import { entry, hostCall, playerCall, surfaceCallArg, waitForSurface } from "./lib";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test.setTimeout(120_000);

test.describe("assets: thumbnail-first + cache hit on rejoin (§7, §19 M1)", () => {
  test("map streams once (chunks > 0), caches, and re-joins with zero wire chunks", async ({
    browser,
  }, testInfo) => {
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    // GM: import a map, share, join the player (manual exchange as in join.spec)
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await host.setInputFiles("#map-input", {
      name: "map.png",
      mimeType: "image/png",
      buffer: TINY_PNG,
    });
    await expect.poll(() => hostCall<string | null>(host, "sceneImg")).not.toBeNull();
    const mapHash = await hostCall<string | null>(host, "sceneImg");

    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    // manual-only join for this test: strip &h= (nostr is covered in nostr.spec)
    const room = new URLSearchParams(inviteLink.slice(inviteLink.indexOf("#") + 1)).get("room");
    const secret = new URLSearchParams(inviteLink.slice(inviteLink.indexOf("#") + 1)).get("k");
    const fragment = `room=${room}&k=${secret}`;
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect
      .poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
    await host.click("#code-apply");
    await expect
      .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    const firstAnswer = await host.locator("#share-out").inputValue();
    await player.fill("#answer-input", firstAnswer);
    await player.click("#answer-apply");
    await waitForSurface(player, "player");
    await expect
      .poll(() => playerCall<string | null>(player, "sceneImg"), { timeout: 30_000 })
      .toBe(mapHash);

    // streamed over the wire on first join, then resident in the client cache
    await expect
      .poll(() => playerCall<number>(player, "assetChunks"), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(1);
    await expect
      .poll(() => surfaceCallArg<boolean>(player, "player", "cacheHas", mapHash), {
        timeout: 20_000,
      })
      .toBe(true);

    // ── rejoin (same browser profile): manual codes again (fresh session),
    //    then the map renders from CACHE with zero wire chunks ──
    await player.reload();
    await expect
      .poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
    await host.click("#code-apply");
    await expect
      .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    // (wait for the FRESH answer — the pre-reload one may still be shown;
    // webkit regenerates it slower than the old 2s blind drain allowed)
    await expect
      .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
      .not.toBe(firstAnswer);
    const answer = await host.locator("#share-out").inputValue();
    await player.fill("#answer-input", answer);
    await player.click("#answer-apply");
    await waitForSurface(player, "player");
    await expect
      .poll(() => playerCall<string | null>(player, "sceneImg"), { timeout: 30_000 })
      .toBe(mapHash);
    await player.waitForTimeout(1_500); // any lazy fetch would have started
    // WebKit: the Cache API under an opaque file:// origin is memory-only, so
    // the rejoin re-streams one chunk instead of hitting the persistent cache
    // (D-082 — browser constraint, not an app regression; map still renders).
    const allowRestream = testInfo.project.name === "webkit";
    expect(await playerCall<number>(player, "assetChunks")).toBe(allowRestream ? 1 : 0);

    await hostCtx.close();
    await playerCtx.close();
  });
});
