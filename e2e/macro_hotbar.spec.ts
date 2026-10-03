import { expect, test, type Page } from "@playwright/test";
import { entry, hostCall, manualFragment, playerCall, waitForSurface } from "./lib";

/** Author through the real wizard, including a restricted graph and a GM-only FX entry. */
async function authorHotbar(host: Page): Promise<{ personalId: string; restrictedId: string; graphIds: string[] }> {
  await host.goto(entry + "?e2e=1");
  await waitForSurface(host, "app");
  await host.locator("#gm-macros").click();
  await host.locator("[data-macro-zones-tab]").click();
  const zones = host.locator("[data-active-zones]");
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.locator("summary").click();
  await tile.getByLabel("Tile name").fill("Hotbar plate");
  await tile.locator("[data-zone-create-tile]").click();
  const tileOption = zones.locator("[data-zone-tile] option").filter({ hasText: "Hotbar plate" });
  await expect(tileOption).toHaveCount(1);
  const tileId = await tileOption.getAttribute("value");
  if (!tileId) throw new Error("hotbar tile missing");
  const graphIds: string[] = [];
  for (const name of ["Table bell", "Personal bell", "Restricted bell"]) {
    if (graphIds.length) await zones.getByRole("button", { name: "New", exact: true }).click();
    await zones.locator("[data-zone-tile]").selectOption(tileId);
    await zones.locator("[data-zone-name]").fill(name);
    for (const method of ["enter", "stop"])
      await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) }).locator("input").uncheck();
    await zones.getByLabel("Player canvas triggers (published)").setChecked(name !== "Restricted bell");
    await zones.locator('[data-zone-step="notice"]').getByLabel("Text").fill(`${name} {{method}} {{user}}`);
    await zones.locator("[data-zone-save]").click();
    const graphRow = zones.locator("li").filter({ hasText: name });
    await expect(graphRow).toHaveCount(1);
    const graphId = await graphRow.locator("[data-zone-macro]").getAttribute("data-zone-macro");
    if (!graphId) throw new Error("hotbar graph missing");
    graphIds.push(graphId);
    await graphRow.locator("[data-zone-macro]").click();
    await expect(zones.getByText(`Published automation macro "${name}"`)).toHaveCount(1);
  }
  const macros = host.locator('[data-window="macros"]');
  await macros.locator("[data-macro-automations-tab]").click();
  let personalId = "";
  for (const [name, slot] of [["Table bell", "1"], ["Personal bell", "2"]] as const) {
    const row = macros.locator("[data-automation-macro]").filter({ hasText: name });
    await expect(row).toHaveCount(1);
    await row.locator("[data-macro-slot]").selectOption(slot);
    await expect(row.locator("[data-macro-slot]")).toHaveValue(slot);
    if (name === "Personal bell") personalId = await row.getAttribute("data-automation-macro") ?? "";
  }
  if (!personalId) throw new Error("personal macro missing");
  const restrictedId = await macros.locator("[data-automation-macro]").filter({ hasText: "Restricted bell" })
    .getAttribute("data-automation-macro");
  if (!restrictedId) throw new Error("restricted macro missing");
  // Unlike the shared catalog name of Restricted bell, a GM-only timeline is not delivered at all.
  await macros.locator("[data-macro-fx-tab]").click();
  const wizard = macros.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-name]").fill("Private FX");
  await wizard.getByRole("button", { name: "Text", exact: true }).click();
  await wizard.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill("GM secret");
  await wizard.locator("[data-fx-audience]").selectOption("gm");
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li").filter({ hasText: "Private FX" })).toHaveCount(1);
  await host.locator('[data-window="macros"] [data-window-close]').click();
  await expect(host.locator('[data-macro-hotbar] [data-hotbar-slot="1"]')).toHaveAttribute("title", "Table bell");
  await host.locator("#share").click();
  return { personalId, restrictedId, graphIds };
}

/** Also used after a page reload: identity is retained, and the new answer must replace the old one. */
async function joinPlayer(host: Page, player: Page): Promise<void> {
  const fragment = manualFragment(await host.locator("#invite-link").inputValue());
  const oldAnswer = await host.locator("#share-out").inputValue();
  const url = `${entry}?e2e=1&join=1#${fragment}`;
  if (player.url() === url) await player.reload();
  else await player.goto(url);
  await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
  await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
  await host.locator("#code-apply").click();
  await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe(oldAnswer);
  const answer = await host.locator("#share-out").inputValue();
  expect(answer).not.toBe("");
  await player.locator("#answer-input").fill(answer);
  await player.locator("#answer-apply").click();
  await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
  await waitForSurface(player, "playerCanvas");
  const seq = await hostCall<number>(host, "seq");
  await expect.poll(() => playerCall<number>(player, "seq")).toBeGreaterThanOrEqual(seq);
}

const slot = (page: Page, index: number) => page.locator(`[data-macro-hotbar] [data-hotbar-slot="${index}"]`);
const prefs = (page: Page) => page.locator("[data-player-hotbar-prefs]");
const binding = (page: Page, index: number) => prefs(page).getByLabel(`Macro hotbar slot ${index}`);
const runs = async (host: Page, name: string, userId: string) =>
  (await host.locator("#chat-log").innerText()).split(`${name} manual ${userId}`).length - 1;

async function arrange(player: Page): Promise<void> {
  await player.getByRole("button", { name: "Arrange hotbar", exact: true }).click();
  await expect(prefs(player)).toBeVisible();
  await expect(binding(player, 1)).toBeFocused();
}

test("a player arranges, clears and resets local hotbar slots without changing the GM or another player; reload and unpublication are safe", async ({ browser }) => {
  test.setTimeout(180_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  const otherCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const other = await otherCtx.newPage();
    const { personalId, restrictedId, graphIds } = await authorHotbar(host);
    await joinPlayer(host, player);
    await joinPlayer(host, other);
    const playerId = await playerCall<string>(player, "userId");
    const otherId = await playerCall<string>(other, "userId");
    expect(otherId).not.toBe(playerId);
    for (const view of [player, other]) {
      await expect(slot(view, 1)).toHaveAttribute("title", "Table bell");
      await expect(slot(view, 2)).toHaveAttribute("title", "Personal bell");
    }
    const beforeArrange = await hostCall<number>(host, "seq");
    await arrange(player);
    await expect(prefs(player)).toContainText("this player and world only");
    await expect(binding(player, 1).locator("option").filter({ hasText: "Private FX" })).toHaveCount(0);
    const personal = binding(player, 1).locator("optgroup option").filter({ hasText: "Personal bell" });
    await expect(personal).toHaveCount(1);
    await binding(player, 1).selectOption(`macro:${personalId}`);
    await binding(player, 2).selectOption("empty");
    await expect(prefs(player).locator("[data-player-hotbar-save-status]")).toHaveText("Saved in this browser for this player and world.");
    expect(await hostCall<number>(host, "seq")).toBe(beforeArrange);
    await expect(slot(host, 1)).toHaveAttribute("title", "Table bell");
    await expect(slot(other, 1)).toHaveAttribute("title", "Table bell");
    await expect(slot(other, 2)).toHaveAttribute("title", "Personal bell");
    for (const id of graphIds) expect(await player.content()).not.toContain(id);

    // A per-slot default and the all-slot reset remain available, using the CURRENT GM defaults.
    await binding(player, 1).selectOption("inherit");
    await expect(slot(player, 1)).toHaveAttribute("title", "Table bell");
    await prefs(player).locator("[data-player-hotbar-reset]").click();
    await expect(binding(player, 2)).toHaveValue("inherit");
    await expect(slot(player, 2)).toHaveAttribute("title", "Personal bell");
    await binding(player, 1).selectOption(`macro:${personalId}`);
    await binding(player, 2).selectOption("empty");
    await binding(player, 4).selectOption(`macro:${restrictedId}`);
    await player.getByRole("button", { name: "Close guide" }).click();
    await expect(player.getByRole("button", { name: "Arrange hotbar", exact: true })).toBeFocused();
    await expect(slot(player, 1)).toHaveAttribute("title", "Personal bell");
    await expect(slot(player, 2)).toBeDisabled();
    expect(await hostCall<number>(host, "seq")).toBe(beforeArrange);

    // A delivered catalog name is NOT a grant: a GM-only graph refuses on the host,
    // without a world op or private graph/anchor details in the player's status.
    await slot(player, 4).click();
    await expect(player.locator("[data-player-hotbar-run-status]")).toHaveText("Refused: automation macro unavailable");
    expect(await hostCall<number>(host, "seq")).toBe(beforeArrange);
    expect(await runs(host, "Restricted bell", playerId)).toBe(0);

    // Click and number keys use the very same overridden slot, not the GM default.
    await slot(player, 1).click();
    await expect.poll(() => runs(host, "Personal bell", playerId)).toBe(1);
    await expect(player.locator("[data-player-hotbar-run-status]")).toHaveText("Automation fired");
    await player.locator("#chat-input").fill("1");
    await player.keyboard.press("1");
    expect(await runs(host, "Personal bell", playerId)).toBe(1); // typing doesn't dispatch
    await player.locator("#chat-input").fill("");
    await player.locator("#chat-input").blur();
    await player.keyboard.press("1");
    await expect.poll(() => runs(host, "Personal bell", playerId)).toBe(2);
    expect(await runs(host, "Table bell", playerId)).toBe(0);
    await slot(other, 1).click();
    await expect.poll(() => runs(host, "Table bell", otherId)).toBe(1);

    // Fresh page and signaling exchange, same browser identity: the arrangement is read back.
    await joinPlayer(host, player);
    expect(await playerCall<string>(player, "userId")).toBe(playerId);
    await expect(slot(player, 1)).toHaveAttribute("title", "Personal bell");
    await expect(slot(player, 2)).toBeDisabled();
    await arrange(player);
    await expect(binding(player, 1)).toHaveValue(`macro:${personalId}`);
    await expect(binding(player, 2)).toHaveValue("empty");
    await player.getByRole("button", { name: "Close guide" }).click();

    // Deleting the assigned entry disables its override immediately. It must NOT fall back
    // to Table bell, which is still the GM's slot 1 and still another player's slot 1.
    await host.locator("#gm-macros").click();
    const macros = host.locator('[data-window="macros"]');
    await macros.locator("[data-macro-automations-tab]").click();
    const row = macros.locator(`[data-automation-macro="${personalId}"]`);
    await row.getByRole("button", { name: "✕", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(slot(player, 1)).toBeDisabled();
    await expect(slot(other, 1)).toHaveAttribute("title", "Table bell");
    const afterDelete = await hostCall<number>(host, "seq");
    await player.keyboard.press("1");
    await player.waitForTimeout(400); // allow an unintended request one real WebRTC round trip
    expect(await hostCall<number>(host, "seq")).toBe(afterDelete);
    expect(await runs(host, "Table bell", playerId)).toBe(0);
    await arrange(player);
    await expect(binding(player, 1).locator("option:checked")).toHaveText("Unavailable macro (not in your catalog)");
    await binding(player, 1).selectOption("inherit");
    await expect(slot(player, 1)).toHaveAttribute("title", "Table bell");
  } finally {
    await otherCtx.close();
    await playerCtx.close();
    await hostCtx.close();
  }
});

test("a storage-denied player can arrange the hotbar for this visit, with honest feedback and no world-write fallback", async ({ browser }) => {
  test.setTimeout(120_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    await playerCtx.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string): void {
        if (key.startsWith("vtt-macro-hotbar:v1:")) throw new DOMException("quota", "QuotaExceededError");
        original.call(this, key, value);
      };
    });
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const { personalId } = await authorHotbar(host);
    await joinPlayer(host, player);
    const playerId = await playerCall<string>(player, "userId");
    const before = await hostCall<number>(host, "seq");
    await arrange(player);
    await binding(player, 1).selectOption(`macro:${personalId}`);
    await expect(prefs(player).locator("[data-player-hotbar-save-status]"))
      .toHaveText("Changed for this visit only — browser storage is unavailable.");
    expect(await hostCall<number>(host, "seq")).toBe(before);
    await player.getByRole("button", { name: "Close guide" }).click();
    await expect(slot(player, 1)).toHaveAttribute("title", "Personal bell");
    await slot(player, 1).click();
    await expect.poll(() => runs(host, "Personal bell", playerId)).toBe(1);
    await joinPlayer(host, player);
    expect(await playerCall<string>(player, "userId")).toBe(playerId);
    await expect(slot(player, 1)).toHaveAttribute("title", "Table bell"); // no false persistence promise
  } finally {
    await playerCtx.close();
    await hostCtx.close();
  }
});
