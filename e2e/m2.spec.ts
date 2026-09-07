import { test, expect, type Browser, type Page } from "@playwright/test";
import { entry, manualFragment, playerCall } from "./lib";

/**
 * M2 acceptance (§19): 10,000 models, 2 players (GM tab + joined player over
 * the real manual-signaling WebRTC path), one full stepwise turn — deployment,
 * per-faction projected snapshots, advance → report, next → orders — inside
 * the §9 wall-clock budgets.
 */

interface GmSnapshot {
  armies: number;
  factions: number;
  units: number;
  pendingOrders: number;
  strengths: number[];
  allyLists: Record<string, string[]>;
}

const gmCall = <T>(page: Page, method: string): Promise<T> =>
  page.evaluate((m) => {
    const surface = (globalThis as { __vttE2E?: { gm?: Record<string, () => T> } }).__vttE2E;
    const fn = surface?.gm?.[m];
    if (typeof fn !== "function") throw new Error(`gm surface missing: ${m}`);
    return fn();
  }, method);

test.describe("M2 acceptance (§19)", () => {
  test("10k models, 2 players, full stepwise turn E2E", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const hostCtx = await browser.newContext();
    const playerCtx = await browser.newContext();
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    test.setTimeout(180_000);

    // ── join: manual signaling exchange (same flow as join.spec) ──────────
    await host.goto(entry + "?e2e=1");
    await host.click("#share");
    const inviteLink = await host.locator("#invite-link").inputValue();
    const fragment = manualFragment(inviteLink);
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect
      .poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    const offerCode = await player.locator("#offer-out").inputValue();
    await host.fill("#peer-code", offerCode);
    await host.click("#code-apply");
    await expect
      .poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 })
      .not.toBe("");
    const answerCode = await host.locator("#share-out").inputValue();
    await player.fill("#answer-input", answerCode);
    await player.click("#answer-apply");
    await expect
      .poll(() => playerCall<string>(player, "connState"), { timeout: 20_000 })
      .toBe("connected");
    const playerUserId = await playerCall<string>(player, "userId");
    expect(playerUserId).toBeTruthy();

    // ── GM: two factions, four armies of 2,500 (10,000 models) ────────────
    await host.click("#gm-extras");
    const win = host.locator('[data-window="gmextras"]');
    await expect(win).toBeVisible();
    await host.fill("#faction-name", "Ironhost");
    await host.click("#faction-create");
    await host.fill("#faction-name", "Emberwatch");
    await host.click("#faction-create");
    await expect
      .poll(() => gmCall<GmSnapshot>(host, "armySnapshot").then((s) => s.factions))
      .toBe(2);

    // two armies per faction; each unit strength 2,500
    const spawnFaction = win.locator("[data-spawn-faction]");
    for (let f = 0; f < 2; f++) {
      await spawnFaction.selectOption({ index: f });
      for (let i = 0; i < 2; i++) {
        await host.fill("[data-spawn-name]", `Host ${f}.${i}`);
        await host.fill("[data-spawn-count]", "2500");
        await host.click("#mass-spawn");
      }
    }
    await expect.poll(() => gmCall<GmSnapshot>(host, "armySnapshot").then((s) => s.armies)).toBe(4);
    await expect.poll(() => gmCall<GmSnapshot>(host, "armySnapshot").then((s) => s.units)).toBe(4);
    const snap = await gmCall<GmSnapshot>(host, "armySnapshot");
    expect(snap.units).toBe(4);
    expect(snap.strengths.reduce((a: number, b: number) => a + b, 0)).toBe(10_000);

    // ── grant the player OBSERVER on faction 0 via the permissions window ─
    await host.click("#gm-perms");
    const perms = host.locator('[data-window="permissions"]');
    await expect(perms).toBeVisible();
    await perms.locator("[data-perm-coll]").selectOption("factions");
    // faction docs are named; pick the first option after the placeholder
    const docOptions = perms.locator("[data-perm-doc] option");
    const factionDocId = await docOptions.nth(1).getAttribute("value");
    expect(factionDocId).toBeTruthy();
    await perms.locator("[data-perm-doc]").selectOption(factionDocId as string);
    // the override must land on the PLAYER's row (the GM is listed too)
    const playerRow = perms.locator(`[data-perm-users] tr[data-user="${playerUserId}"]`);
    await expect(playerRow).toHaveCount(1);
    const playerName = ((await playerRow.locator("td").first().textContent()) ?? "").trim();
    expect(playerName).not.toBe("");
    await perms
      .locator(`.overrides select[aria-label="Ownership for ${playerName}"]`)
      .selectOption("2"); // OBSERVER → §5A strategic frames for this faction

    // the override op must land in the store before the campaign runs
    await expect
      .poll(() =>
        gmCall<Record<string, Record<string, number>>>(host, "factionOwnership").then(
          (o) => o[factionDocId as string]?.[playerUserId] ?? 0,
        ),
      )
      .toBe(2);

    // close permissions: it opened on top of the GM extras window and would
    // intercept the campaign controls (D-079 overlap trap)
    await perms.locator("[data-window-close]").click();
    await expect(perms).toHaveCount(0);
    await expect(win).toBeVisible();

    // ── start the campaign: §8A deploy of 10,000 models (budget: 15s) ─────
    const t0 = Date.now();
    await expect(win.locator("#campaign-start")).toBeEnabled();
    await host.click("#campaign-start");
    await expect.poll(() => gmCall<number>(host, "simCount"), { timeout: 20_000 }).toBe(10_000);
    const deployMs = Date.now() - t0;
    expect(deployMs).toBeLessThan(15_000);

    // GM sees orders; the joined player gets the projected snapshot + phase
    await expect.poll(() => gmCall<string>(host, "turnPhase"), { timeout: 10_000 }).toBe("orders");
    await expect
      .poll(() => playerCall<number>(player, "simCount"), { timeout: 20_000 })
      .toBe(10_000); // hidden slots preserve indices (§5A projection)
    await expect
      .poll(() => playerCall<string>(player, "turnPhase"), { timeout: 10_000 })
      .toBe("orders");

    // issue one move order (batch template) so the turn report is non-empty
    // (no orders + supply 5 → zero events; movement always emits)
    await win.locator("[data-unit-check]").first().check();
    await win.locator("[data-batch-template]").first().click();
    await expect
      .poll(() => gmCall<GmSnapshot>(host, "armySnapshot").then((s) => s.pendingOrders))
      .toBeGreaterThanOrEqual(1);

    // ── advance: resolve 10k models + per-faction projection (budget 15s) ─
    const t1 = Date.now();
    await host.click("[data-campaign-advance]");
    await expect.poll(() => gmCall<string>(host, "turnPhase"), { timeout: 30_000 }).toBe("report");
    const advanceMs = Date.now() - t1;
    expect(advanceMs).toBeLessThan(15_000);

    // player: projected report arrived (attrition guarantees ≥1 event), and
    // the delta bumped the replica version
    await expect
      .poll(() => playerCall<number>(player, "reportEvents"), { timeout: 20_000 })
      .toBeGreaterThan(0);
    // §11: the projected report carries aggregated distributions (move orders
    // emit type "arrive" events)
    const byType = await playerCall<Record<string, number> | null>(player, "reportByType");
    expect(byType?.arrive ?? 0).toBeGreaterThanOrEqual(1);
    expect(await playerCall<number>(player, "simVersion")).toBeGreaterThan(0);
    await expect
      .poll(() => playerCall<string>(player, "turnPhase"), { timeout: 10_000 })
      .toBe("report");

    // ── next: both sides reopen orders for turn 2 ──────────────────────────
    await host.click("[data-campaign-next]");
    await expect.poll(() => gmCall<string>(host, "turnPhase"), { timeout: 10_000 }).toBe("orders");
    await expect
      .poll(() => playerCall<string>(player, "turnPhase"), { timeout: 10_000 })
      .toBe("orders");

    await hostCtx.close();
    await playerCtx.close();
  });
});
