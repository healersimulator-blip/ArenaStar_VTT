import { test, expect } from "@playwright/test";
import { startNostrRelay } from "./nostrRelay";
import { NOSTR_KIND } from "../src/net/signaling/nostr/index";
import { entry, hostCall, playerCall, waitForSurface } from "./lib";

test.setTimeout(120_000);

test.describe("join via Nostr signaling (§6.2, §19 M1)", () => {
  test("player auto-joins through relays from an &h= invite; GM sees the move", async ({
    browser,
  }) => {
    const relay = await startNostrRelay(NOSTR_KIND);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    try {
      // ── host: local relay + share (invite carries &h=<nostr pubkey>) ──
      await host.goto(`${entry}?e2e=1&relay=${encodeURIComponent(relay.url)}`);
      await waitForSurface(host, "app");
      await host.click("#add-token");
      await expect.poll(() => hostCall<number>(host, "tokenCount")).toBe(1);
      await host.click("#share");
      const inviteLink = await host.locator("#invite-link").inputValue();
      expect(inviteLink).toContain("&h="); // nostr pubkey signaled (§6.2)
      const fragment = inviteLink.slice(inviteLink.indexOf("#") + 1);

      // ── player: same relay; NO manual code exchange anywhere ──
      await player.goto(`${entry}?e2e=1&join=1&relay=${encodeURIComponent(relay.url)}#${fragment}`);
      await waitForSurface(player, "player");
      // (ephemeral offers sent before the host subscribed are lost; the §6.5
      // backoff re-offers — local relay connects within a few seconds)
      await expect
        .poll(() => playerCall<string>(player, "transport"), { timeout: 30_000 })
        .toBe("nostr");
      await expect
        .poll(() => playerCall<number>(player, "seq"), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(2);
      await expect.poll(() => playerCall<number>(player, "tokenCount")).toBe(1);
      expect(await playerCall<string>(player, "role")).toBe("PLAYER");
      await expect(player.locator("#pstatus")).toContainText("World One", { timeout: 20_000 });

      // ── the player moves the owned token; the GM sees it (§14) ──
      const before = await hostCall<{ x: number; y: number } | null>(host, "tokenPos");
      const canvas = player.locator(".canvas-host canvas");
      await expect.poll(() => canvas.count(), { timeout: 20_000 }).toBe(1);
      const box = await canvas.boundingBox();
      if (!box) throw new Error("player canvas not mounted");
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await player.mouse.move(cx, cy);
      await player.mouse.down();
      await player.mouse.move(cx + 130, cy + 90, { steps: 6 });
      await player.mouse.up();
      await expect
        .poll(
          async () => {
            const pos = await hostCall<{ x: number; y: number } | null>(host, "tokenPos");
            return pos !== null && (pos.x !== before?.x || pos.y !== before?.y);
          },
          { timeout: 20_000 },
        )
        .toBe(true);
    } finally {
      await hostCtx.close();
      await playerCtx.close();
      await relay.close();
    }
  });
});
