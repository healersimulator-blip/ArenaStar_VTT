import { expect, test, type Page } from "@playwright/test";
import { entry, manualFragment, waitForSurface } from "./lib";

/**
 * §11 commit-reveal rolls: an explicit /roll commits H(seed_c) up front, the
 * host answers with seed_h, the client reveals seed_c, and the recorded chat
 * roll carries all three values — reproducible via verifyCommitRoll.
 */

const gmCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const surface = (globalThis as { __vttE2E?: { gm?: Record<string, () => T> } }).__vttE2E;
    const fn = surface?.gm?.[m];
    if (typeof fn !== "function") throw new Error(`gm surface missing: ${m}`);
    return fn();
  }, method);

test.describe("commit-reveal rolls (§11)", () => {
  test("player /roll records seeds + commitment; verifyCommitRoll reproduces the total", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    // join flow (as chat.spec)
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    // the gm surface (with committedRoll) appears after canvas setup
    await expect
      .poll(() =>
        host.evaluate(() => {
          const s = (
            globalThis as { __vttE2E?: { gm?: Record<string, () => unknown> } }
          ).__vttE2E;
          return typeof s?.gm?.["committedRoll"] === "function";
        }),
      )
      .toBe(true);
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
    await expect
      .poll(() => player.locator("#pstatus").textContent(), { timeout: 20_000 })
      .toContain("World One");

    // player rolls with the commit-reveal path (explicit /roll)
    await player.fill("#chat-input", "/roll 2d6+3");
    await player.click("#chat-send");

    // the host records the roll with seeds + commitment and it verifies
    interface Committed {
      formula: string;
      total: number;
      seedClient: string | null;
      seedHost: string | null;
      commit: string | null;
      verified: boolean;
      verifyError: string | null;
    }
    const committed = async (): Promise<Committed> => {
      for (;;) {
        const rec = await gmCall<Committed | null>(host, "committedRoll");
        if (rec) return rec;
        await host.waitForTimeout(250);
      }
    };
    const rec = await committed();
    expect(rec.formula).toBe("2d6+3");
    expect(rec.total).toBeGreaterThanOrEqual(5);
    expect(rec.total).toBeLessThanOrEqual(15);
    expect(rec.seedClient).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.seedHost).toMatch(/^[0-9a-f]{32}$/);
    expect(rec.commit).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.verified).toBe(true);
    expect(rec.verifyError).toBeNull();

    // the player sees the roll card too
    await expect(player.locator("#chat-log .rollcard")).toHaveCount(1);

    await hostCtx.close();
    await playerCtx.close();
  });
});
