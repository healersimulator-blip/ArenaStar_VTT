import { test, expect, type Browser, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { manualFragment } from "./lib";

const entry = "file://" + fileURLToPath(new URL("../dist/index.html", import.meta.url));

const hostCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const surface = (globalThis as { __vttE2E?: { app: Record<string, () => T> | null } }).__vttE2E;
    const fn = surface?.app?.[m];
    if (typeof fn !== "function") throw new Error(`app surface missing: ${m}`);
    return fn() as T;
  }, method);

const playerCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const surface = (globalThis as { __vttE2E?: { player: Record<string, () => T> | null } })
      .__vttE2E;
    const fn = surface?.player?.[m];
    if (typeof fn !== "function") throw new Error(`player surface missing: ${m}`);
    return fn() as T;
  }, method);

const waitForHost = (page: Page): Promise<void> =>
  expect
    .poll(() =>
      page.evaluate(() => (globalThis as { __vttE2E?: { app: unknown } }).__vttE2E?.app != null),
    )
    .toBe(true);

test.describe("join scenario (§2/§6/§14)", () => {
  test("player joins via manual signaling: snapshot, ownership, GM sees the move", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    // ── host side: world + token + share invite ──
    await host.goto(entry + "?e2e=1");
    await waitForHost(host);
    await host.click("#add-token");
    await expect.poll(() => hostCall<number>(host, "tokenCount")).toBe(1);
    const hostSeq = await hostCall<number>(host, "seq");

    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    expect(inviteLink).toContain("#room=");
    const fragment = manualFragment(inviteLink);

    // ── player side: auto-join from the fragment, offer code appears ──
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect
      .poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    const offerCode = await player.locator("#offer-out").inputValue();

    // ── host: apply the player's code → answer code appears ──
    await host.fill("#peer-code", offerCode);
    await host.click("#code-apply");
    await expect
      .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    const answerCode = await host.locator("#share-out").inputValue();

    // ── player: apply the host's answer → WebRTC connects ──
    await player.fill("#answer-input", answerCode);
    await player.click("#answer-apply");

    // welcome + projected snapshot (§5): the late join sees current state
    await expect
      .poll(() => playerCall<number>(player, "seq"), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(hostSeq + 1); // + the join user-create op
    expect(await playerCall<string>(player, "role")).toBe("PLAYER");
    await expect.poll(() => playerCall<number>(player, "tokenCount")).toBe(1);
    expect(await playerCall<string>(player, "worldName")).toBe("World One");
    await expect(player.locator("#pstatus")).toContainText("World One", { timeout: 20_000 });

    // ── player drags the owned token; the GM sees the move (§14) ──
    const before = await hostCall<{ x: number; y: number } | null>(host, "tokenPos");
    expect(before).not.toBeNull();
    const canvas = player.locator(".canvas-host canvas");
    await expect.poll(() => canvas.count(), { timeout: 20_000 }).toBe(1);
    const box = await canvas.boundingBox();
    if (!box) throw new Error("player canvas not mounted");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await player.mouse.move(cx, cy);
    await player.mouse.down();
    await player.mouse.move(cx + 120, cy + 80, { steps: 6 });
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

    await hostCtx.close();
    await playerCtx.close();
  });
});
