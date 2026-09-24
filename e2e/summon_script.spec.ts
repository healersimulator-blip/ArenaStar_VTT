import { expect, test } from "@playwright/test";
import { entry, gmCall, hostCall, manualFragment, playerCall, surfaceCallArg, waitForSurface } from "./lib";

test("a player runs GM-reviewed code to summon a private actor, then dismisses only their new instance", async ({ browser }) => {
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
    const summons = host.locator("[data-summons-panel]");
    await summons.locator("[data-summon-name]").fill("Private wolf for scripts");
    await summons.locator("[data-summon-source]").selectOption({ label: "World · secret-wolf (actor)" });
    await summons.locator("[data-summon-save]").click(); // Leave unpublished (GM only).
    const preset = summons.locator("[data-summon-preset] option").filter({ hasText: "Private wolf for scripts" });
    await expect(preset).toHaveCount(1);
    const presetId = await preset.getAttribute("value");
    if (!presetId) throw new Error("Missing private summon preset");
    await host.locator("[data-macro-script-tab]").click();
    const editor = host.locator("[data-script-wizard]");
    await editor.locator("[data-script-name]").fill("Conjure approved wolf");
    await editor.locator("[data-script-source]").fill(`if (args.target) return await api.summons.dismiss(args.target);
return await api.summons.place('${presetId}', 550, 450, args.caster);`);
    await editor.getByLabel("Allow players to invoke").check();
    await editor.getByLabel("Run as").selectOption("gm");
    await editor.locator(".grants label").filter({ hasText: "summons" }).locator("input").check();
    await editor.locator("[data-script-summon-allowlist] label").filter({ hasText: "Private wolf for scripts" }).locator("input").check();
    await editor.getByRole("button", { name: "Add input" }).click();
    await editor.getByLabel("Input 1 name").fill("caster");
    await editor.getByLabel("Input 1 type").selectOption("token");
    await editor.getByRole("button", { name: "Add input" }).click();
    await editor.getByLabel("Input 2 name").fill("target");
    await editor.getByLabel("Input 2 type").selectOption("token");
    await editor.getByLabel("I reviewed this exact revision and its host grants").check();
    await editor.locator("[data-script-save]").click();
    await expect(editor.getByRole("status")).toContainText("Script revision published");
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
    const catalog = player.locator("[data-script-wizard]");
    expect(await player.locator("[data-summons-panel] [data-summon-preset] option").count()).toBe(1); // placeholder only
    expect(await catalog.locator("[data-script-source]").count()).toBe(0);
    expect(await catalog.locator("[data-script-summon-allowlist]").count()).toBe(0);
    await catalog.getByRole("button", { name: "Conjure approved wolf" }).click();
    await catalog.locator('[data-script-token-arg="caster"]').selectOption({ label: "caster" });
    const before = await hostCall<number>(host, "seq");
    await catalog.locator("[data-script-run]").click();
    await expect(catalog.getByRole("status")).toContainText("Script completed", { timeout: 20_000 });
    await expect.poll(() => hostCall<number>(host, "seq")).toBe(before + 3); // invocation, actor/token + receipt, finalized receipt
    await expect.poll(() => gmCall<number>(host, "actorCount")).toBe(3);
    await player.locator("[data-macro-summons-tab]").click();
    await expect(player.locator("[data-summons-panel] [data-summon-instance]")).toHaveCount(1);
    expect(await player.locator("[data-summons-panel] [data-summon-preset] option").count()).toBe(1);
    await player.locator("[data-macro-script-tab]").click();
    await expect(catalog.locator('[data-script-token-arg="target"] option').filter({ hasText: "secret-wolf (actor)" })).toHaveCount(1);
    await catalog.locator('[data-script-token-arg="target"]').selectOption({ label: "secret-wolf (actor)" });
    const placed = await hostCall<number>(host, "seq");
    await catalog.locator("[data-script-run]").click();
    await expect.poll(() => hostCall<number>(host, "seq")).toBe(placed + 3); // invocation, linked cleanup + receipt, finalized receipt
    await expect.poll(() => gmCall<number>(host, "actorCount")).toBe(2);
    await player.locator("[data-macro-summons-tab]").click();
    await expect(player.locator("[data-summons-panel] [data-summon-instance]")).toHaveCount(0);
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});
