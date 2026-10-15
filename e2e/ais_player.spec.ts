import { expect, test, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { entry, manualFragment, playerCall, surfaceCallArg, waitForSurface } from "./lib";

/**
 * D-468: the GM shares an approved AIS module with the table; a player gets it over the ops
 * channel, consents on their own device, and runs the real pf1e-torch code against their own
 * token — the host authorises the resulting commits by ownership alone.
 */

/** Same approval dance as e2e/ais_modules.spec.ts (the package ships inside the starter world). */
async function approveExisting(page: Page, id: string): Promise<void> {
  const row = page.locator(`[data-pkg-row][data-pkg-id="${id}"]`);
  if (await row.locator("[data-ais-enable]").count()) await row.locator("[data-ais-enable]").click();
  const review = page.locator(`[data-ais-module-review="${id}"]`);
  for (const checkbox of await review.locator('fieldset input[type="checkbox"]').all()) await checkbox.check();
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator(".ais-source-preview pre")).toContainText("AIS.commands.on");
  await review.locator("[data-ais-approve]").click();
  await expect(review.locator("[data-ais-approved]")).toBeVisible();
  await Promise.all([page.waitForEvent("load"), page.locator("[data-ais-reload]").click()]);
  await waitForSurface(page, "app");
  await page.locator("#gm-settings").click();
  await expect(review.locator("[data-ais-runtime]")).toHaveAttribute("data-ais-runtime", "ready", { timeout: 10_000 });
}

test("a player lights and puts out the torch on their own token through the GM-shared module", async ({ browser }) => {
  test.setTimeout(150_000);
  const gmContext = await browser.newContext();
  const playerContext = await browser.newContext();
  const gm = await gmContext.newPage();
  const player = await playerContext.newPage();
  try {
    await gm.goto(entry);
    await gm.locator("#role-import").setInputFiles(fileURLToPath(new URL("../dist/worlds/pf1e-mass-battles-starter-1.0.0.zip", import.meta.url)));
    await gm.locator("[data-open-copy]").click();
    await expect(gm.locator("#status")).toContainText("Pathfinder 1e Mass Battles");
    await gm.goto(entry + "?e2e=1");
    await waitForSurface(gm, "app");
    await gm.locator("#gm-settings").click();
    await approveExisting(gm, "pf1e-torch");
    const share = gm.locator('[data-ais-module-review="pf1e-torch"] [data-ais-share-players]');
    await expect(share).toBeChecked(); // sharing is the default; the GM opts out per module

    // Fixture: the first actor-linked token becomes the player's (default OWNER on token and
    // actor, as the tabletop default already makes it) and carries two torches, unlit.
    const target = await gm.evaluate(async () => {
      const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
      const scene = client.store.getAll("scenes").find((row) => row.active);
      const token = scene?.tokens.find((row) => row.actorId);
      const actor = token?.actorId ? client.store.get("actors", token.actorId) : undefined;
      if (!scene || !token || !actor) throw new Error("starter world needs a token linked to an actor");
      await client.submitAndWait([
        { kind: "update", ref: { coll: "actors", id: actor._id }, diff: { "ownership.default": 3 } },
        { kind: "create", coll: "items", parent: { coll: "actors", id: actor._id }, data: {
          _id: "ais-player-torch", name: "Torch", type: "loot", ownership: { default: 0 }, flags: {}, system: { quantity: 2 },
        } },
        { kind: "update", ref: { coll: "tokens", id: token._id, parent: { coll: "scenes", id: scene._id } }, diff: {
          "ownership.default": 3, light: { radius: 0, bright: 0, color: "#ffffff", alpha: 0.8, angle: 360 },
        } },
      ]);
      return {
        sceneId: scene._id, tokenId: token._id, actorId: actor._id,
        centre: { x: token.x, y: token.y }, // token x/y is the centre (src/canvas/tokens.ts tokenRect)
      };
    });
    const readLight = () => gm.evaluate(({ sceneId, tokenId, actorId }) => {
      const client = (globalThis as unknown as { __vttE2E: { app: { gm: { client: import("../src/client/sync").ClientSync } } } }).__vttE2E.app.gm.client;
      const token = client.store.get("scenes", sceneId)?.tokens.find((row) => row._id === tokenId);
      const item = client.store.get("actors", actorId)?.items.find((row) => row._id === "ais-player-torch");
      if (!token || !item) throw new Error("fixture token or inventory is missing");
      // The module's token state (src/packages/aisModuleHandlers.ts light.apply): sourceItemId + active.
      const flags = (token.flags as { ais?: Record<string, { sourceItemId?: string; active?: boolean }> }).ais;
      const state = flags?.["pf1e-torch"];
      return { radius: token.light.radius, quantity: item.system.quantity, source: state?.sourceItemId ?? null, active: state?.active ?? null };
    }, target);
    await gm.locator('[data-window="settings"] [data-window-close]').click();

    // Manual signalling, as in e2e/join.spec.ts.
    await gm.locator("#share").click();
    const fragment = manualFragment(await gm.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await gm.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await gm.locator("#code-apply").click();
    await expect.poll(() => gm.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await gm.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");

    // The profile arrives with the welcome; nothing runs until this player agrees on this device.
    const consent = player.locator('[data-ais-consent="pf1e-torch"]');
    await expect(consent).toBeVisible({ timeout: 20_000 });
    await expect(consent).toContainText("change the light carried by your tokens");
    await expect(player.locator('iframe[title="AIS module:pf1e-torch"]')).toHaveCount(0);
    await consent.locator("[data-ais-consent-allow]").click();
    await expect(player.locator('iframe[title="AIS module:pf1e-torch"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(consent).toHaveCount(0);

    // Right-click the owned token on the player's canvas: the light entries come from the module.
    // The point is re-read on every attempt: the consent banner leaving changes the layout and the
    // player's camera can re-fit between a cached point and the click.
    const openMenu = async () => {
      await expect(async () => {
        const screen = await surfaceCallArg<{ x: number; y: number } | null>(player, "playerCanvas", "screenOf", target.centre);
        if (!screen) throw new Error("player token point unavailable");
        await player.mouse.click(screen.x, screen.y, { button: "right" });
        await expect(player.locator(`[data-token-menu="${target.tokenId}"]`)).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 15_000 });
    };
    await openMenu();
    const toggle = player.locator('[data-token-menu-action="token-light-toggle"]');
    await expect(toggle).toHaveText("Turn carried light on");
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect.poll(readLight, { timeout: 20_000 }).toMatchObject({ source: "ais-player-torch", active: true, quantity: 1 });
    expect((await readLight()).radius).toBeGreaterThan(0);
    await expect.poll(() => playerCall<{ txId: string } | null>(player, "lastRejected")).toBeNull();

    // And out again — the same ownership check, the other direction.
    await openMenu();
    await expect(player.locator('[data-token-menu-action="token-light-toggle"]')).toContainText("Turn carried light off");
    await player.locator('[data-token-menu-action="token-light-off"]').click();
    await expect.poll(readLight, { timeout: 20_000 }).toMatchObject({ radius: 0, active: false, quantity: 1 }); // putting out does not consume

    // The GM un-shares: the player's copy stops without a reload, and the entries explain why.
    await gm.locator("#gm-settings").click();
    await share.uncheck();
    await expect(player.locator('iframe[title="AIS module:pf1e-torch"]')).toHaveCount(0, { timeout: 15_000 });
    await openMenu();
    await expect(player.locator('[data-token-menu-action="token-light-toggle"]')).toHaveCount(0);
    await expect(player.locator('[data-token-menu-action="open-sheet"]')).toBeVisible();
  } finally {
    await playerContext.close();
    await gmContext.close();
  }
});
