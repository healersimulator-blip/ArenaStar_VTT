import { expect, test } from "@playwright/test";
import { entry, gmCall, hostCall, importShippedCore, manualFragment, playerCall,
  surfaceCallArg, waitForSurface } from "./lib";

test("GM publishes a source actor, previews/cancels map crosshair, places, reloads and dismisses linked instance", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await waitForSurface(page, "gm");
  // Only fixture setup uses the test surface. Wizard save/place/dismiss all
  // travel through the real ClientSync → HostSync → DocumentStore path.
  expect(await surfaceCallArg<{ ok: boolean; placed: number }>(page, "app", "pf1ePlaceTokens",
    [{ id: "summon-source", col: 2, row: 2, owner: "gm" }])).toMatchObject({ ok: true, placed: 1 });
  await expect.poll(() => gmCall<number>(page, "actorCount")).toBe(1);
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-summons-tab]").click();
  const panel = page.locator("[data-summons-panel]");
  await expect(panel.locator("[data-summon-source] option").filter({ hasText: "summon-source (actor)" })).toHaveCount(1);
  await panel.locator("[data-summon-show-world]").uncheck();
  await expect(panel.locator("[data-summon-source] option").filter({ hasText: "summon-source (actor)" })).toHaveCount(0);
  await panel.locator("[data-summon-show-world]").check();
  await panel.locator("[data-summon-size-filter]").selectOption("Medium");
  await panel.locator("[data-summon-cr-min]").fill("1");
  await expect(panel.locator("[data-summon-source] option").filter({ hasText: "summon-source (actor)" })).toHaveCount(0);
  await panel.locator("[data-summon-cr-min]").fill(""); // unindexed CR is not silently treated as 0
  await panel.locator("[data-summon-name]").fill("Call a summoned wolf");
  await panel.locator("[data-summon-source]").selectOption({ label: "World · summon-source (actor)" });
  await expect(panel.locator("[data-summon-source-info]")).toContainText("Medium");
  const selectedBefore = await hostCall<number>(page, "seq");
  await panel.locator("[data-summon-select-only]").click();
  expect(JSON.parse(await panel.locator("[data-summon-selected-ref]").inputValue())).toMatchObject({
    kind: "world", actorId: "a-summon-source",
  });
  expect(await hostCall<number>(page, "seq")).toBe(selectedBefore); // selection does not import/place
  await panel.locator("[data-summon-publish]").check();
  const initial = await hostCall<number>(page, "seq");
  await panel.locator("[data-summon-save]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(initial + 1);
  await expect(panel.locator("[data-summon-preset] option").filter({ hasText: "Call a summoned wolf" })).toHaveCount(1);

  const before = await hostCall<number>(page, "seq");
  await panel.locator("[data-summon-pick]").click();
  const picker = page.locator("[data-summon-crosshair]");
  await expect(picker).toBeVisible();
  await picker.locator("[data-summon-cancel]").click();
  await expect(picker).toHaveCount(0);
  expect(await hostCall<number>(page, "seq")).toBe(before); // cancellation is never a summon

  await panel.locator("[data-summon-pick]").click();
  await expect(picker).toBeVisible();
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("Canvas unavailable");
  const camera = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");
  const at = { x: box.x + (350 - camera.x) * camera.scale,
    y: box.y + (350 - camera.y) * camera.scale };
  await page.mouse.move(at.x, at.y);
  await expect(picker.locator(".footprint")).toBeVisible();
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect(panel.locator("[data-summon-instance]")).toHaveCount(1);
  await expect.poll(() => gmCall<number>(page, "actorCount")).toBe(2);
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(2);
  await hostCall<number>(page, "drainOps");

  await page.reload();
  await waitForSurface(page, "app");
  await waitForSurface(page, "gm");
  await expect.poll(() => gmCall<number>(page, "actorCount")).toBe(2);
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-summons-tab]").click();
  const recovered = page.locator("[data-summons-panel]");
  await expect(recovered.locator("[data-summon-instance]")).toHaveCount(1);
  page.once("dialog", (dialog) => void dialog.accept());
  await recovered.locator("[data-summon-instance] button").click();
  await expect(recovered.locator("[data-summon-instance]")).toHaveCount(0);
  await expect.poll(() => gmCall<number>(page, "actorCount")).toBe(1);
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
});

test("connected player sees only a published summon and their own instance; host keeps source private", async ({ browser }: { browser: import("@playwright/test").Browser }) => {
  test.setTimeout(90_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    await host.goto(entry + "?e2e=1");
    await waitForSurface(host, "app");
    await waitForSurface(host, "gm");
    expect(await surfaceCallArg<{ ok: boolean; placed: number }>(host, "app", "pf1ePlaceTokens", [
      { id: "secret-wolf", col: 2, row: 2, owner: "gm" },
      { id: "caster", col: 4, row: 4, owner: "all" },
    ])).toMatchObject({ ok: true, placed: 2 });
    await expect.poll(() => gmCall<number>(host, "actorCount")).toBe(2);
    await host.locator("#gm-macros").click();
    await host.locator("[data-macro-summons-tab]").click();
    const wizard = host.locator("[data-summons-panel]");
    await wizard.locator("[data-summon-name]").fill("Summon private wolf");
    await wizard.locator("[data-summon-source]").selectOption({ label: "World · secret-wolf (actor)" });
    await wizard.locator("[data-summon-publish]").check();
    await wizard.locator("[data-summon-save]").click();
    await expect(wizard.locator("[data-summon-preset] option").filter({ hasText: "Summon private wolf" })).toHaveCount(1);
    await host.locator('[data-window="macros"] [data-window-close]').click();

    await host.locator("#share").click();
    const fragment = manualFragment(await host.locator("#invite-link").inputValue());
    await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
    await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
    await host.locator("#code-apply").click();
    await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe("");
    await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
    await player.locator("#answer-apply").click();
    await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
    await waitForSurface(player, "playerCanvas");
    await player.locator("[data-player-macros]").click();
    await player.locator("[data-macro-summons-tab]").click();
    const catalog = player.locator("[data-summons-panel]");
    await expect(catalog.locator("[data-summon-preset] option").filter({ hasText: "Summon private wolf" })).toHaveCount(1);
    expect(await catalog.locator("[data-summon-name]").count()).toBe(0); // no private GM editor/pack index
    await expect(catalog.locator("[data-summon-caster] option").filter({ hasText: "caster" })).toHaveCount(1);
    const before = await hostCall<number>(host, "seq");
    await catalog.locator("[data-summon-pick]").click();
    const picker = player.locator("[data-summon-crosshair]");
    await expect(picker).toBeVisible();
    const placePoint = await surfaceCallArg<{ x: number; y: number } | null>(player, "playerCanvas", "screenOf", { x: 550, y: 450 });
    if (!placePoint) throw new Error("player map point unavailable");
    await player.mouse.move(placePoint.x, placePoint.y);
    await expect(picker.locator(".footprint.invalid")).toHaveCount(0);
    await player.mouse.click(placePoint.x, placePoint.y);
    await expect.poll(() => hostCall<number>(host, "seq"), { timeout: 20_000 }).toBe(before + 1);
    await expect(catalog.locator("[data-summon-instance]")).toHaveCount(1);
    await expect.poll(() => gmCall<number>(host, "actorCount")).toBe(3);
    // The player's projector contains the new independent actor (no original),
    // and the menu never contains the original actor/pack reference.
    const status = await catalog.locator("[data-summon-instance]").innerText();
    expect(status).toContain("secret-wolf"); // name is visible only AFTER summoning
    const after = await hostCall<number>(host, "seq");
    player.once("dialog", (dialog) => void dialog.accept());
    await catalog.locator("[data-summon-instance] button").click();
    await expect.poll(() => hostCall<number>(host, "seq"), { timeout: 20_000 }).toBe(after + 1);
    await expect(catalog.locator("[data-summon-instance]")).toHaveCount(0);
    await expect.poll(() => gmCall<number>(host, "actorCount")).toBe(2);
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});


test("GM picks a filtered installed actor-pack entry and summons it without importing the source actor", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await waitForSurface(page, "gm");
  expect(await gmCall<number>(page, "actorCount")).toBe(0);
  await importShippedCore(page); // real world-scoped package, not a hardcoded fixture resolver
  expect(await gmCall<number>(page, "actorCount")).toBe(0);
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-summons-tab]").click();
  const menu = page.locator("[data-summons-panel]");
  await expect(menu.locator("[data-summon-pack] option").filter({ hasText: "PF1e Bestiary" })).toHaveCount(1);
  await menu.locator("[data-summon-show-world]").uncheck();
  await menu.locator("[data-summon-pack]").selectOption("pf1e-core:packs/bestiary.json");
  await menu.locator("[data-summon-search]").fill("canine");
  await menu.locator("[data-summon-size-filter]").selectOption("Medium");
  await menu.locator("[data-summon-cr-min]").fill("1");
  await menu.locator("[data-summon-cr-max]").fill("1");
  const found = menu.locator("[data-summon-source] option").filter({ hasText: "War Canine Pack" });
  await expect(found).toHaveCount(1);
  await menu.locator("[data-summon-source]").selectOption({ label: "PF1e Bestiary (pf1e-core) · War Canine Pack" });
  await expect(menu.locator("[data-summon-source-info]")).toContainText("CR 1 · Medium");
  await menu.locator("[data-summon-select-only]").click();
  expect(JSON.parse(await menu.locator("[data-summon-selected-ref]").inputValue())).toMatchObject({
    kind: "compendium", packageId: "pf1e-core", packFile: "packs/bestiary.json", entryId: "guard-dogs",
  });
  expect(await gmCall<number>(page, "actorCount")).toBe(0);
  await menu.locator("[data-summon-name]").fill("Pack wolf summon");
  await menu.locator("[data-summon-save]").click();
  await expect(menu.locator("[data-summon-preset] option").filter({ hasText: "Pack wolf summon" })).toHaveCount(1);
  await menu.locator("[data-summon-x]").fill("350");
  await menu.locator("[data-summon-y]").fill("350");
  await menu.locator("[data-summon-place]").click();
  await expect(menu.locator("[data-summon-instance]")).toHaveCount(1);
  await expect.poll(() => gmCall<number>(page, "actorCount")).toBe(1);
  await expect.poll(() => hostCall<number>(page, "tokenCount")).toBe(1);
  expect(await menu.locator("[data-summon-instance]").innerText()).toContain("War Canine Pack");
});
