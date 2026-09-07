import { test, expect, type Page } from "@playwright/test";
import { entry, hostCall, playerCall, waitForSurface, manualFragment } from "./lib";

test.setTimeout(150_000);

/** Push a code into a page's manual adapter through the e2e surface. */
const receiveCode = (page: Page, surface: "share" | "player", code: string): Promise<void> =>
  page.evaluate(
    ({ surface, code }) => {
      const e2e = (
        globalThis as {
          __vttE2E?: Record<string, { receiveCode(c: string): Promise<void> } | undefined>;
        }
      ).__vttE2E;
      const target = e2e?.[surface];
      if (!target) throw new Error(`${surface} surface missing`);
      return target.receiveCode(code);
    },
    { surface, code },
  );

/** Drain a page's manual outbox through the e2e surface. */
const takeOutbox = (page: Page, surface: "share" | "player"): Promise<string[]> =>
  page.evaluate((surface) => {
    const e2e = (
      globalThis as {
        __vttE2E?: Record<string, { takeOutbox(): string[] } | undefined>;
      }
    ).__vttE2E;
    const target = e2e?.[surface];
    if (!target) throw new Error(`${surface} surface missing`);
    return target.takeOutbox();
  }, surface);

test.describe("GM crash & recovery (§6.5, §14)", () => {
  test("host tab dies → player notified → host reopens the world → codes re-exchanged → converges", async ({
    browser,
  }) => {
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    // ── initial join (manual signaling), as in join.spec ──
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await host.click("#add-token");
    await expect.poll(() => hostCall<number>(host, "tokenCount")).toBe(1);

    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    const fragment = manualFragment(inviteLink);

    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
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
    await waitForSurface(player, "player");
    await expect
      .poll(() => playerCall<number>(player, "seq"), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(2);
    const worldId = await hostCall<string>(host, "worldId");

    // ── HOST TAB DIES (the context — and its IDB — survives) ──
    await host.close();
    await expect
      .poll(() => player.locator("#disconnect-notice").isVisible(), { timeout: 20_000 })
      .toBe(true);
    await expect(player.locator("#disconnect-notice")).toContainText("Host disconnected");

    // ── host reopens the app: same world from IDB + oplog (§8) ──
    const host2 = await hostCtx.newPage();
    await host2.goto(entry + "?e2e=1");
    await waitForSurface(host2, "app");
    await expect.poll(() => hostCall<string>(host2, "worldId")).toBe(worldId);

    // ── re-exchange: player outbox → host, host answer → player (direct,
    //    atomic surface calls; manual answers take ~1–2 s of ICE gathering) ──
    await host2.click("#share");
    await expect
      .poll(() => host2.locator("#invite-link").inputValue(), { timeout: 20_000 })
      .toContain("#room=");
    await waitForSurface(host2, "app"); // surfaces ready after share click

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const offers = await takeOutbox(player, "player");
      const offer = offers.at(-1) ?? "";
      if (offer) {
        await receiveCode(host2, "share", offer);
        let answer = "";
        for (let i = 0; i < 40 && !answer; i += 1) {
          await host2.waitForTimeout(250);
          answer = (await takeOutbox(host2, "share")).at(-1) ?? "";
        }
        if (answer) await receiveCode(player, "player", answer);
      }
      for (let i = 0; i < 10 && !(await playerCall<boolean>(player, "connected")); i += 1) {
        await player.waitForTimeout(500);
      }
      if (await playerCall<boolean>(player, "connected")) break;
    }
    await expect
      .poll(() => playerCall<boolean>(player, "connected"), { timeout: 60_000 })
      .toBe(true);
    await expect(player.locator("#pstatus")).toContainText("World One", { timeout: 20_000 });

    // ── convergence: host adds a token post-recovery; the player sees it ──
    await host2.click("#add-token");
    await expect.poll(() => playerCall<number>(player, "tokenCount"), { timeout: 20_000 }).toBe(2);
    await expect
      .poll(() => playerCall<number>(player, "seq"), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(3);

    await hostCtx.close();
    await playerCtx.close();
  });
});
