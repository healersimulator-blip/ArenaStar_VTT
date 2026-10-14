/**
 * D-465: the GM manages connected players from Players & permissions — who is connected,
 * their colour, character and token control, and disconnecting them. A real host and a real
 * player over the manual WebRTC join (no relays), the presence read from the live HostSync.
 */
import { expect, test, type Page } from "@playwright/test";
import { chromeAction, entry, hostCall, manualFragment, playerCall, surfaceCallArg, waitForSurface } from "./lib";

test.use({ actionTimeout: 15_000 });
const permissions = (page: Page) => page.locator('[data-window="permissions"]');

async function joinPlayer(host: Page, player: Page): Promise<void> {
  const fragment = manualFragment(await host.locator("#invite-link").inputValue());
  const oldAnswer = await host.locator("#share-out").inputValue();
  await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
  await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
  await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
  await host.locator("#code-apply").click();
  await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe(oldAnswer);
  await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
  await player.locator("#answer-apply").click();
  await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
  await waitForSurface(player, "playerCanvas");
  const seq = await hostCall<number>(host, "seq");
  await expect.poll(() => playerCall<number>(player, "seq")).toBeGreaterThanOrEqual(seq);
}

test.describe("players roster (D-465)", () => {
  test("a connected player shows as online, gets a token, and can be disconnected by the GM", async ({ page, browser }) => {
    test.setTimeout(150_000);
    const player = await browser.newPage();
    try {
      await page.goto(entry + "?e2e=1");
      await waitForSurface(page, "app");
      await page.locator("#share").click();
      await joinPlayer(page, player);
      const playerId = await playerCall<string>(player, "userId");
      // A GM-only token: the "Add token" button makes one open to everyone, which needs no grant.
      await page.evaluate(() => {
        type Surface = { app: { activeSceneId(): string | null; gm: { client: { submit(ops: unknown[]): string } } } | null };
        const app = (globalThis as unknown as { __vttE2E?: Surface }).__vttE2E?.app;
        const sceneId = app?.activeSceneId();
        if (!app || !sceneId) throw new Error("GM E2E app is unavailable");
        app.gm.client.submit([
          { kind: "create", coll: "tokens", parent: { coll: "scenes", id: sceneId }, data: {
            _id: "token-guard", type: "token", name: "Guard", ownership: { default: 0 }, flags: {}, system: {},
            x: 300, y: 300, rotation: 0, width: 100, height: 100, img: "", hidden: false, disposition: "neutral", vision: true,
            light: { radius: 0, color: "#ffffff", alpha: 0.5 },
          } },
        ]);
      });
      await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
      await expect.poll(() => playerCall<number>(player, "tokenCount")).toBe(1);

      await chromeAction(page, "gm-perms");
      const perms = permissions(page);
      const rows = perms.locator("[data-perm-users] tbody tr[data-user]");
      await expect(rows).toHaveCount(2);
      // GM first, then players; both connected right now.
      await expect(rows.first()).not.toHaveAttribute("data-user", playerId);
      await expect(rows.first()).toHaveAttribute("data-online", "true");
      const row = perms.locator(`[data-perm-users] tr[data-user="${playerId}"]`);
      await expect(row).toHaveAttribute("data-online", "true");
      await expect(row.locator("[data-perm-online]")).toHaveAttribute("data-perm-online", "true");
      await expect(row.locator("[data-perm-kick]")).toBeVisible();
      await expect(row.locator("[data-perm-remove]")).toHaveCount(0); // only offline users can be removed

      // Token control reaches the player: the token becomes theirs to move.
      await row.locator("[data-perm-tokens]").click();
      const tokenBox = perms.locator(`[data-perm-tokens-for="${playerId}"] [data-perm-token="token-guard"]`);
      await expect(tokenBox).toHaveAttribute("data-perm-token-via", "none");
      await tokenBox.check();
      await expect
        .poll(() => surfaceCallArg<number | null>(player, "player", "myTokenLevel", "token-guard"))
        .toBe(3);
      await expect(row.locator("[data-perm-tokens]")).toHaveText(/1 of 1/);

      // Disconnect: the player's session drops and the row turns offline.
      await row.locator("[data-perm-kick]").click();
      await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 20_000 }).toBe(false);
      await expect(row).toHaveAttribute("data-online", "false", { timeout: 10_000 });
      await expect(row.locator("[data-perm-kick]")).toHaveCount(0);
      await expect(row.locator("[data-perm-remove]")).toBeVisible();
    } finally {
      await player.close();
    }
  });
});
