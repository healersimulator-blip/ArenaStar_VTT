import { test, expect } from "@playwright/test";
import { entry, hostCall, playerCall, waitForSurface, manualFragment } from "./lib";

test.setTimeout(90_000);

test.describe("sheets (§10 M1)", () => {
  test("GM creates + assigns an actor; the player edits it; ownership enforced", async ({
    browser,
  }) => {
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
    const playerId = await playerCall<string>(player, "userId");

    // ── GM: create a private actor; the player does NOT see it (§5) ──
    await host.click('[data-tab="actors"]');
    await host.click("#new-doc");
    await expect(host.locator("#sheet-list .sheet-row")).toHaveCount(1);
    await host.fill("#sheet-name", "Hero");
    await host.locator("#sheet-name").dispatchEvent("change");
    await expect
      .poll(() => player.locator("#sheet-list .sheet-row").count(), { timeout: 15_000 })
      .toBe(0); // default:0 → omitted from the player's projection

    // ── GM: assign it to the player (visibility crossing → materializes) ──
    await host.selectOption("#assign-owner", playerId);
    await expect
      .poll(() => player.locator("#sheet-list .sheet-row").count(), { timeout: 15_000 })
      .toBe(1);
    await expect(player.locator("#sheet-list .doc-name")).toHaveText("Hero");

    // ── player: edit the hp system field → reactive op → GM sees it ──
    await player.locator("#sheet-list .sheet-row").first().click();
    const hp = player.locator(".sys-field[data-key='hp']");
    await expect(hp).toBeVisible();
    expect(await hp.isEnabled()).toBe(true); // owned → editable
    await hp.fill("7");
    await hp.dispatchEvent("change");
    await expect
      .poll(() => host.locator(".sys-field[data-key='hp']").inputValue(), { timeout: 15_000 })
      .toBe("7");

    // ── enforcement: a second, unassigned actor never reaches the player ──
    await host.click("#new-doc");
    await expect(host.locator("#sheet-list .sheet-row")).toHaveCount(2);
    await player.waitForTimeout(1_000);
    await expect(player.locator("#sheet-list .sheet-row")).toHaveCount(1);

    // authoritative seq advanced through all of it
    await expect.poll(() => hostCall<number>(host, "seq")).toBeGreaterThanOrEqual(6);

    await hostCtx.close();
    await playerCtx.close();
  });
});
