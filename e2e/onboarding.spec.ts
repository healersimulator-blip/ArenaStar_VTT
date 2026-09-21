/**
 * §2.3 tail (G-41 remainder, D-263) — the first-run checklist, the help window's copy of it, and
 * the rules reference links, through the real UI on both shells.
 *
 * The point of the checklist is that it is *derived*: a step ticks because the world changed, not
 * because somebody recorded that it was done. So this spec does the steps for real — imports a
 * map, places a token, opens an invite, turns fog on, rolls a die — and reads the ticks back from
 * the DOM between each one, on the GM's shell and on a joined player's.
 */
import { expect, test, type Page } from "@playwright/test";
import { entry, gmCall, hostCall, manualFragment, playerCall, waitForSurface } from "./lib";

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** The checklist's tick for one step, read off the GM's own sidebar. */
async function tick(page: Page, step: string): Promise<string | null> {
  return page.locator(`[data-onboarding] [data-onboarding-step="${step}"]`).getAttribute("data-onboarding-done");
}

async function bootHost(page: Page): Promise<void> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await waitForSurface(page, "gm");
}

test.describe("first-run onboarding (§2.3, G-41)", () => {
  test("the GM's checklist ticks off the real steps, survives a reload, and the help window repeats it", async ({
    page: host,
    context,
  }) => {
    await bootHost(host);

    // ── a fresh world: the list is open, and nothing in it is done ──
    const panel = host.locator("[data-onboarding]");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute("data-onboarding-open", "true");
    for (const step of ["map", "tokens", "invite", "fog", "play"]) {
      await expect(host.locator(`[data-onboarding-step="${step}"]`)).toHaveCount(1);
      expect(await tick(host, step)).toBe("false");
    }
    await expect(host.locator("[data-onboarding-toggle]")).toHaveText(/Hide/);

    // ── step 1: a map, through the sidebar's own import control ──
    await host.setInputFiles("#map-input", { name: "map.png", mimeType: "image/png", buffer: TINY_PNG });
    await expect.poll(() => hostCall<string | null>(host, "sceneImg"), { timeout: 20_000 }).not.toBeNull();
    await expect(host.locator('[data-onboarding-step="map"]')).toHaveAttribute("data-onboarding-done", "true");

    // ── step 2: a token ──
    await host.click("#add-token");
    await expect.poll(() => hostCall<number>(host, "tokenCount"), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(host.locator('[data-onboarding-step="tokens"]')).toHaveAttribute("data-onboarding-done", "true");

    // ── step 3: an invite link is outstanding ──
    await host.click("#share");
    await expect.poll(async () => (await host.locator("#invite-link").inputValue()).length).toBeGreaterThan(0);
    await expect(host.locator('[data-onboarding-step="invite"]')).toHaveAttribute("data-onboarding-done", "true");

    // ── step 4: fog of war, from the Settings window the hint names ──
    await host.click("#gm-settings");
    const settings = host.locator('[data-window="settings"]');
    await settings.locator("[data-scene-fog]").check();
    await settings.locator("[data-window-close]").click();
    await expect.poll(async () => (await gmCall<{ enabled: boolean }>(host, "fogState")).enabled).toBe(true);
    await expect(host.locator('[data-onboarding-step="fog"]')).toHaveAttribute("data-onboarding-done", "true");

    // ── step 5: the first roll — the table is playing ──
    await host.click('[data-canvas-tool="dice"]');
    await host.click('[data-canvas-die="20"]');
    await expect.poll(() => host.locator("#chat-log .line").count(), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(host.locator('[data-onboarding-step="play"]')).toHaveAttribute("data-onboarding-done", "true");
    await expect(host.locator("[data-onboarding-complete]")).toBeVisible();

    // nothing was written to the world by any of this: the checklist is a *view* of state that the
    // GM's own actions moved
    const seqAfterSetup = await hostCall<number>(host, "seq");
    await host.click("[data-onboarding-toggle]");
    await expect(panel).toHaveAttribute("data-onboarding-open", "false");
    await expect(host.locator("[data-onboarding-toggle]")).toHaveText(/Done · Show/);
    expect(await hostCall<number>(host, "seq")).toBe(seqAfterSetup);
    expect(await host.evaluate(() => globalThis.localStorage.getItem("vtt-onboarding-gm"))).toBe("0");

    // ── a player joins and gets their *own* list: three steps, none of the GM's ──
    const player = await context.newPage();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.fill("#peer-code", await player.locator("#offer-out").inputValue());
    await host.click("#code-apply");
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.fill("#answer-input", await host.locator("#share-out").inputValue());
    await player.click("#answer-apply");
    await waitForSurface(player, "player");
    await waitForSurface(player, "playerCanvas");

    await expect(player.locator("[data-onboarding]")).toBeVisible();
    for (const step of ["token", "sheet", "chat"]) {
      await expect(player.locator(`[data-onboarding-step="${step}"]`)).toHaveCount(1);
    }
    for (const gmStep of ["map", "tokens", "invite", "fog", "play"]) {
      await expect(player.locator(`[data-onboarding-step="${gmStep}"]`)).toHaveCount(0);
    }
    // the GM's own `Add token` gives every player movement of the token it drops (D-061), so the
    // player's first step is ticked on *their* replica — while their sheet is not, because no
    // character has been linked to them yet
    expect(await playerCall<number>(player, "tokenCount")).toBeGreaterThan(0);
    await expect(player.locator('[data-onboarding-step="token"]')).toHaveAttribute(
      "data-onboarding-done",
      "true",
    );
    await expect(player.locator('[data-onboarding-step="sheet"]')).toHaveAttribute(
      "data-onboarding-done",
      "false",
    );
    // the session is already playing as far as the world is concerned: the GM's roll is in chat
    await expect(player.locator('[data-onboarding-step="chat"]')).toHaveAttribute(
      "data-onboarding-done",
      "true",
    );
    // ── the player's help window shows the player's steps and the same links ──
    await player.click('[data-canvas-action="help"]');
    const playerHelp = player.locator("[data-help-panel]");
    await expect(playerHelp).toBeVisible();
    await expect(playerHelp.locator('[data-help-step="token"]')).toHaveCount(1);
    await expect(playerHelp.locator('[data-help-step="map"]')).toHaveCount(0);
    await expect(playerHelp.locator('[data-help-link="d20pfsrd"]')).toHaveAttribute(
      "href",
      "https://www.d20pfsrd.com/",
    );

    // ── the GM's help window: the same ordered steps under their own heading ──
    await host.click('[data-canvas-action="help"]');
    const help = host.locator("[data-help-panel]");
    await expect(help).toBeVisible();
    for (const step of ["map", "tokens", "invite", "fog", "play"]) {
      await expect(help.locator(`[data-help-step="${step}"]`)).toHaveCount(1);
    }
    for (const id of ["d20pfsrd", "aonprd"]) {
      const link = help.locator(`[data-help-link="${id}"]`);
      await expect(link).toHaveAttribute("href", /^https:\/\//);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", /noopener/);
    }
    await expect(help.locator("[data-help-docs-note]")).toContainText("CREDITS.md");

    // ── a reload reads the fold back: the choice outlived the page it was made on ──
    await host.reload();
    await waitForSurface(host, "app");
    await waitForSurface(host, "gm");
    await expect(host.locator("[data-onboarding]")).toHaveCount(1);
    await expect(host.locator("[data-onboarding]")).toHaveAttribute("data-onboarding-open", "false");
    // the label is the hydration signal: a click before the pane is live would land on nothing
    await expect(host.locator("[data-onboarding-toggle]")).toHaveText(/Show/);
    await host.click("[data-onboarding-toggle]");
    await expect(host.locator("[data-onboarding-toggle]")).toHaveText(/Hide/);
    await expect(host.locator("[data-onboarding]")).toHaveAttribute("data-onboarding-open", "true");
    expect(await host.evaluate(() => globalThis.localStorage.getItem("vtt-onboarding-gm"))).toBe("1");
    // the world it describes came back too: every step survived the reload already ticked
    for (const step of ["map", "tokens", "invite", "fog", "play"]) {
      await expect(host.locator(`[data-onboarding-step="${step}"]`)).toHaveAttribute(
        "data-onboarding-done",
        "true",
      );
    }
    await expect(host.locator("[data-onboarding-complete]")).toBeVisible();

    await player.close();
  });
});
