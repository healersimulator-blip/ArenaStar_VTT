import { expect, test, type Browser } from "@playwright/test";
import { entry, hostCall, manualFragment, playerCall, surfaceCallArg, waitForSurface } from "./lib";

test("GM Revert button restores a trap's PF1e HP and temporary HP, graph history and chat in the built app", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  expect(await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1ePlaceTokens",
    [{ id: "trap-victim", col: 2, row: 2, owner: "all" }])).toMatchObject({ ok: true });
  await expect.poll(() => surfaceCallArg<Record<string, unknown> | null>(page, "app",
    "pf1eActorSystem", "a-trap-victim")).not.toBeNull();
  expect(await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1eAuthorActor",
    { actorId: "a-trap-victim", patch: { hp: 14, hpMax: 20, tempHpSources: { ward: 4 } } }))
    .toMatchObject({ ok: true });
  await expect.poll(() => surfaceCallArg<Record<string, unknown> | null>(page, "app",
    "pf1eActorSystem", "a-trap-victim")).toMatchObject({ hp: 14, tempHpSources: { ward: 4 } });

  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  const zones = page.locator("[data-active-zones]");
  await zones.locator("[data-zone-tile-create] summary").click();
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.getByLabel("Tile name").fill("Reversible trap tile");
  await tile.getByLabel("X", { exact: true }).fill("200");
  await tile.getByLabel("Y", { exact: true }).fill("200");
  await tile.getByLabel("Width").fill("200");
  await tile.getByLabel("Height").fill("200");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Reversible trap tile" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("PF1e damage trap");
  await zones.getByLabel("Origin token").selectOption({ label: "trap-victim" });
  await zones.getByRole("button", { name: "Remove step 2" }).click();
  await zones.getByRole("button", { name: "Remove step 1" }).click();
  await zones.locator('[data-zone-add="hurtHeal"]').click();
  await zones.getByLabel("Hurt / Heal HP change").fill("-7");
  await zones.locator('[data-zone-add="chat"]').click();
  await zones.locator("[data-zone-step]").last().getByLabel("Text").fill("Trap caused damage");
  await zones.locator("[data-zone-save]").click();
  await expect(zones.getByRole("alert")).toHaveCount(0);
  const before = await hostCall<number>(page, "seq");
  await zones.locator("[data-zone-run]").click();
  await expect.poll(() => hostCall<number>(page, "seq")).toBe(before + 1);
  await expect.poll(() => surfaceCallArg<Record<string, unknown> | null>(page, "app",
    "pf1eActorSystem", "a-trap-victim")).toMatchObject({ hp: 11 });
  expect(await surfaceCallArg<Record<string, unknown> | null>(page, "app",
    "pf1eActorSystem", "a-trap-victim")).not.toHaveProperty("tempHpSources");
  await expect(page.locator("#chat-log")).toContainText("Trap caused damage");
  await expect(zones.locator("li").filter({ hasText: "PF1e damage trap" })).toContainText("1 run(s)");
  await page.locator('[data-window="macros"] [data-window-close]').click();

  const action = page.locator('[data-testid="action-revert-card"]').filter({ hasText: "PF1e damage trap" });
  await expect(action).toContainText("ready");
  await action.getByTestId("action-revert").click(); // named GM Revert, not the global Undo control
  await expect(action).toContainText("reverted");
  await expect.poll(() => surfaceCallArg<Record<string, unknown> | null>(page, "app",
    "pf1eActorSystem", "a-trap-victim")).toMatchObject({ hp: 14, tempHpSources: { ward: 4 } });
  await expect(page.locator("#chat-log")).not.toContainText("Trap caused damage");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-zones-tab]").click();
  await expect(zones.locator("li").filter({ hasText: "PF1e damage trap" })).toContainText("0 run(s)");
});

test("GM Revert button reverses a reviewed script's world tags and chat (not only visual FX)", async ({ page }) => {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  const sceneId = await hostCall<string>(page, "activeSceneId");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-script-tab]").click();
  const scripts = page.locator("[data-script-wizard]");
  await scripts.locator("[data-script-name]").fill("World-tag script");
  await scripts.locator("[data-script-source]").fill(
    "await api.tags.addTags([{ coll: 'scenes', id: context.sceneId }], ['script-written']); await api.chat.say('Script wrote a world tag', 'gm'); return true;",
  );
  await scripts.locator(".grants label").filter({ hasText: "tags.write" }).locator("input").check();
  await scripts.locator(".grants label").filter({ hasText: "chat" }).locator("input").check();
  await scripts.getByLabel("I reviewed this exact revision and its host grants").check();
  await scripts.locator("[data-script-save]").click();
  await expect(scripts.getByRole("status")).toContainText("Script revision published");
  await scripts.locator("[data-script-run]").click();
  await expect(scripts.getByRole("status")).toContainText("Script completed");
  await page.locator("[data-macro-tags-tab]").click();
  const tags = page.locator("[data-tagger]");
  await tags.getByLabel("Tag scene").selectOption(sceneId);
  await tags.getByLabel("Placeable type").selectOption("scenes");
  const row = tags.locator(".result").filter({ hasText: `${sceneId}/scenes` });
  await expect(row).toContainText("script-written");
  await expect(page.locator("#chat-log")).toContainText("Script wrote a world tag");
  await page.locator('[data-window="macros"] [data-window-close]').click();

  const action = page.locator('[data-testid="action-revert-card"]').filter({ hasText: "World-tag script" });
  await expect(action).toContainText("2 commits");
  await action.getByTestId("action-revert").click();
  await expect(action).toContainText("reverted");
  await expect(page.locator("#chat-log")).not.toContainText("Script wrote a world tag");
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-tags-tab]").click();
  await tags.getByLabel("Tag scene").selectOption(sceneId);
  await tags.getByLabel("Placeable type").selectOption("scenes");
  await expect(row).not.toContainText("script-written");
  await expect(row).toContainText("(untagged)");
});

test("a real connected player's tile click damages an owned token; the GM Revert button restores it without exposing receipts", async ({ browser }: { browser: Browser }) => {
  test.setTimeout(90_000);
  const gmCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const gm = await gmCtx.newPage();
    const player = await playerCtx.newPage();
    await gm.goto(entry + "?e2e=1");
    await waitForSurface(gm, "app");
    expect(await surfaceCallArg<{ ok: boolean }>(gm, "app", "pf1ePlaceTokens",
      [{ id: "public-victim", col: 4, row: 4, owner: "all" }])).toMatchObject({ ok: true });
    await expect.poll(() => surfaceCallArg<Record<string, unknown> | null>(gm, "app",
      "pf1eActorSystem", "a-public-victim")).not.toBeNull();
    expect(await surfaceCallArg<{ ok: boolean }>(gm, "app", "pf1eAuthorActor",
      { actorId: "a-public-victim", patch: { hp: 14, hpMax: 20, tempHpSources: { ward: 3 } } }))
      .toMatchObject({ ok: true });
    await expect.poll(() => surfaceCallArg<Record<string, unknown> | null>(gm, "app",
      "pf1eActorSystem", "a-public-victim")).toMatchObject({ hp: 14 });
    await gm.locator("#gm-macros").click();
    await gm.locator("[data-macro-zones-tab]").click();
    const zones = gm.locator("[data-active-zones]");
    await zones.locator("[data-zone-tile-create] summary").click();
    const tile = zones.locator("[data-zone-tile-create]");
    await tile.getByLabel("Tile name").fill("Player trap");
    await tile.getByLabel("X", { exact: true }).fill("350");
    await tile.getByLabel("Y", { exact: true }).fill("400");
    await tile.getByLabel("Width").fill("200");
    await tile.getByLabel("Height").fill("160");
    await tile.locator("[data-zone-create-tile]").click();
    await zones.locator("[data-zone-name]").fill("Player damage trap");
    await zones.locator(".methods label").filter({ hasText: "click" }).locator("input").check();
    await zones.getByLabel("Player click (published)").check();
    await zones.getByRole("button", { name: "Remove step 2" }).click();
    await zones.getByRole("button", { name: "Remove step 1" }).click();
    await zones.locator('[data-zone-add="hurtHeal"]').click();
    await zones.getByLabel("Hurt / Heal HP change").fill("-6");
    await zones.locator("[data-zone-save]").click();
    await expect(zones.getByRole("alert")).toHaveCount(0);
    await gm.locator('[data-window="macros"] [data-window-close]').click();

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
    const before = await hostCall<number>(gm, "seq");
    await expect.poll(() => playerCall<number>(player, "seq")).toBeGreaterThanOrEqual(before);
    const screen = (p: { x: number; y: number }) => surfaceCallArg<{ x: number; y: number } | null>(
      player, "playerCanvas", "screenOf", p);
    const selected = await screen({ x: 450, y: 450 });
    if (!selected) throw new Error("player token point unavailable");
    await player.mouse.click(selected.x, selected.y);
    const trapPoint = await screen({ x: 540, y: 480 });
    if (!trapPoint) throw new Error("player trap point unavailable");
    await player.mouse.click(trapPoint.x, trapPoint.y);
    await expect.poll(() => hostCall<number>(gm, "seq"), { timeout: 20_000 }).toBeGreaterThan(before);
    await expect.poll(() => surfaceCallArg<Record<string, unknown> | null>(gm, "app",
      "pf1eActorSystem", "a-public-victim")).toMatchObject({ hp: 11 });
    await expect(player.locator('[data-testid="action-revert-history"]')).toHaveCount(0);
    const action = gm.locator('[data-testid="action-revert-card"]').filter({ hasText: "Player damage trap" });
    await expect(action).toContainText("ready");
    await action.getByTestId("action-revert").click();
    await expect(action).toContainText("reverted");
    await expect.poll(() => surfaceCallArg<Record<string, unknown> | null>(gm, "app",
      "pf1eActorSystem", "a-public-victim")).toMatchObject({ hp: 14, tempHpSources: { ward: 3 } });
  } finally {
    await playerCtx.close();
    await gmCtx.close();
  }
});
