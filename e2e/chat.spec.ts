import { test, expect } from "@playwright/test";
import { entry, hostCall, waitForSurface, manualFragment } from "./lib";

test.setTimeout(90_000);

test.describe("chat (§10/§11 M1)", () => {
  test("inline rolls resolve host-side; /roll cards reach the other side", async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();

    // join, as in join.spec
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
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

    // ── GM sends a chat line with an INLINE roll; the host resolves it ──
    await host.fill("#chat-input", "attack [[1d20+3]]!");
    await host.click("#chat-send");
    await expect
      .poll(() => player.locator("#chat-log").textContent(), { timeout: 20_000 })
      .toContain("attack");
    const withChip = await player.locator("#chat-log").textContent();
    expect(withChip).toMatch(/attack \d+!/); // chip text = the host's total
    // the chip renders as a styled span on both sides
    await expect(player.locator("#chat-log .chip")).toHaveCount(1);
    await expect(host.locator("#chat-log .chip")).toHaveCount(1);

    // ── player /roll → roll card committed by the host; the GM sees it too ──
    await player.fill("#chat-input", "/roll 1d6+2");
    await player.click("#chat-send");
    await expect
      .poll(() => host.locator("#chat-log .rollcard").count(), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);
    const card = await host.locator("#chat-log .rollcard").first().textContent();
    expect(card).toContain("1d6+2");
    expect(card).toMatch(/[3-8]/); // total in [3,8]
    await expect(player.locator("#chat-log .rollcard")).toHaveCount(1);

    // seq advanced on the authoritative store (roll + message committed)
    await expect.poll(() => hostCall<number>(host, "seq")).toBeGreaterThanOrEqual(4);

    await hostCtx.close();
    await playerCtx.close();
  });
});
