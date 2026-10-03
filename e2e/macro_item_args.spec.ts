/** MC-02/D-393 — real authoring and execution on the production file:// artifact.
 * No macro, schema, item-selection state or invocation is injected through a test hook.
 * Existing PF1e table/spell setup is the fixture; inventory creation, item-window focus,
 * input declaration, picker, directory, chat and hotbar are all ordinary product UI.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { entry, hostCall, manualFragment, playerCall, surfaceCallArg, waitForSurface } from "./lib";

test.use({ actionTimeout: 15_000 });

const macros = (page: Page) => page.locator('[data-window="macros"]');
const macroRow = (page: Page) => macros(page).locator("[data-automation-macro]").filter({ hasText: "Item bell" });
const runEditor = (page: Page) => macros(page).locator("[data-automation-run-editor]");
const itemShell = (page: Page, itemId: string) => page.locator(`[data-window="pf1e-item:a-hero:${itemId}"]`);
const slot = (page: Page) => page.locator('[data-macro-hotbar] [data-hotbar-slot="1"]');

async function actorSheet(page: Page, actor = "hero", player = false): Promise<Locator> {
  await page.locator(player ? '[data-player-tab="actors"]' : '[data-tab="actors"]').click();
  await page.getByRole("region", { name: "Sheets", exact: true }).getByRole("button", { name: "Actors", exact: true }).click();
  await page.locator("#sheet-list .sheet-row").filter({ hasText: `${actor} (actor)` }).click();
  await page.locator("[data-open-pf1e-sheet]").click();
  const sheet = page.locator(".wm-window [data-pf1e-sheet]");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "items", exact: true }).click();
  return sheet;
}

async function closeSheet(page: Page): Promise<void> {
  await page.locator(".wm-window").filter({ has: page.locator("[data-pf1e-sheet]") }).locator("[data-window-close]").click();
}

async function makeItem(page: Page, kind: "wand" | "scroll", actor = "hero"): Promise<string> {
  const sheet = await actorSheet(page, actor);
  const inventory = sheet.locator("[data-pf1e-items]");
  await inventory.getByLabel("Spell", { exact: true }).selectOption("Magic Missile");
  await inventory.getByLabel("Item kind").selectOption(kind);
  await inventory.locator("[data-pf1e-make-consumable-apply]").click();
  const name = kind === "wand" ? "Wand of Magic Missile" : "Scroll of Magic Missile";
  const row = inventory.locator(`[data-pf1e-item-name="${name}"]`);
  await expect(row).toHaveCount(1);
  const id = await row.getAttribute("data-pf1e-item");
  if (!id) throw new Error("the inventory's committed item is missing");
  await closeSheet(page);
  return id;
}

async function prepareItems(page: Page): Promise<{ wand: string; world: string }> {
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  expect(await surfaceCallArg(page, "app", "pf1ePlaceTokens", [
    { id: "hero", col: 1, row: 1 }, { id: "vault", col: 3, row: 1, owner: "gm" },
  ])).toMatchObject({ ok: true, placed: 2 });
  for (const actor of ["hero", "vault"])
    expect(await surfaceCallArg(page, "app", "pf1eAuthorActor", { actorId: `a-${actor}`,
      patch: { spells: { prepared: [{ name: "Magic Missile", level: 1 }] } } })).toMatchObject({ ok: true });
  const wand = await makeItem(page, "wand");
  await makeItem(page, "wand", "vault"); // private parent/item must never enter the player's picker
  await page.getByRole("region", { name: "Sheets", exact: true }).getByRole("button", { name: "Items", exact: true }).click();
  await page.locator("#new-doc").click();
  await page.locator("#sheet-name").fill("World focus");
  await page.locator("#sheet-name").dispatchEvent("change");
  const row = page.locator("#sheet-list .sheet-row").filter({ hasText: "World focus" });
  await expect(row).toHaveCount(1);
  const world = await row.getAttribute("data-doc-id");
  if (!world) throw new Error("the world item is missing");
  return { wand, world };
}

async function authorItemMacro(host: Page, checkIndependentFlags = false): Promise<void> {
  await host.locator("#gm-macros").click();
  await macros(host).locator("[data-macro-zones-tab]").click();
  const zones = macros(host).locator("[data-active-zones]");
  const tile = zones.locator("[data-zone-tile-create]");
  await tile.locator("summary").click();
  await tile.getByLabel("Tile name").fill("Item plate");
  await tile.getByLabel("X", { exact: true }).fill("700");
  await tile.getByLabel("Y", { exact: true }).fill("700");
  await tile.locator("[data-zone-create-tile]").click();
  await expect(zones.locator("[data-zone-tile] option").filter({ hasText: "Item plate" })).toHaveCount(1);
  await zones.locator("[data-zone-name]").fill("Item bell");
  for (const method of ["enter", "stop"])
    await zones.locator(".methods label").filter({ hasText: new RegExp(`^${method}$`) }).locator("input").uncheck();
  await zones.getByLabel("Player canvas triggers (published)").check();
  const notice = zones.locator('[data-zone-step="notice"]');
  await notice.getByLabel("Text", { exact: true }).fill("using {{arg.tool}}");
  await notice.getByLabel("Audience").selectOption("gm");
  await zones.locator("[data-zone-save]").click();
  const graph = zones.locator("li").filter({ hasText: "Item bell" });
  await expect(graph).toHaveCount(1);
  await graph.locator("[data-zone-macro]").click();
  await expect(zones.getByText('Published automation macro "Item bell"')).toHaveCount(1);
  await macros(host).locator("[data-macro-automations-tab]").click();
  await macroRow(host).locator("[data-automation-inputs]").click();
  const editor = macros(host).locator("[data-automation-inputs-editor]");
  await editor.locator("[data-automation-input-add]").click();
  await editor.getByLabel("Input 1 name").fill("tool");
  await editor.getByLabel("Input 1 type").selectOption("item");
  const required = editor.getByLabel("Input 1 required");
  const selected = editor.getByLabel("Input 1 from selection");
  await selected.check();
  await required.check();
  if (checkIndependentFlags) {
    await required.uncheck();
    await expect(selected).toBeChecked();
    await required.check();
    await selected.uncheck();
    await expect(required).toBeChecked();
    await selected.check();
    await editor.getByLabel("Input 1 type").selectOption("string");
    await expect(selected).not.toBeChecked();
    await expect(selected).toBeDisabled();
    await expect(required).toBeChecked();
    await editor.getByLabel("Input 1 type").selectOption("item");
    await expect(selected).not.toBeChecked();
    await selected.check();
  }
  await editor.locator("[data-automation-input-save]").click();
  await expect(macroRow(host).locator("[data-automation-inputs]")).toContainText("Inputs (1)");
  await macroRow(host).locator("[data-macro-slot]").selectOption("1");
  await expect(slot(host)).toHaveAttribute("title", "Item bell");
  await macros(host).locator("[data-window-close]").click();
}

async function openRun(page: Page, player = false): Promise<void> {
  await page.locator(player ? "[data-player-macros]" : "#gm-macros").click();
  await macros(page).locator("[data-macro-automations-tab]").click();
  await macroRow(page).locator("[data-automation-macro-run]").click();
  await expect(runEditor(page)).toBeVisible();
}

async function openItem(page: Page, itemId: string, player = false, titleY = 270): Promise<void> {
  const sheet = await actorSheet(page, "hero", player);
  await sheet.locator(`[data-pf1e-item="${itemId}"] [data-pf1e-item-open]`).click();
  const shell = itemShell(page, itemId);
  await expect(shell.locator("[data-pf1e-item-window]")).toBeVisible();
  // Real pointer drag leaves both item title bars reachable for ordinary focus clicks.
  const title = await shell.locator(".wm-title").boundingBox();
  if (!title) throw new Error("item window chrome is missing");
  await page.mouse.move(title.x + 30, title.y + 20);
  await page.mouse.down();
  await page.mouse.move(460, titleY, { steps: 5 });
  await page.mouse.up();
  await closeSheet(page);
}

async function commitLine(host: Page, reference: string, action: () => Promise<unknown>): Promise<void> {
  const line = `using ${reference}`;
  const before = (await hostCall<string[]>(host, "chatLines")).filter((entry) => entry === line).length;
  const seq = await hostCall<number>(host, "seq");
  await action();
  await expect.poll(async () => (await hostCall<string[]>(host, "chatLines")).filter((entry) => entry === line).length)
    .toBe(before + 1);
  expect(await hostCall<number>(host, "seq")).toBe(seq + 1);
}

async function chatRun(page: Page, args = "", player = false): Promise<void> {
  await page.locator(player ? '[data-player-tab="chat"]' : '[data-tab="chat"]').click();
  await page.locator("#chat-input").fill(`/run "Item bell"${args ? ` ${args}` : ""}`);
  await page.locator("#chat-send").click();
}

async function joinPlayer(host: Page, player: Page): Promise<void> {
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
  const seq = await hostCall<number>(host, "seq");
  await expect.poll(() => playerCall<number>(player, "seq")).toBeGreaterThanOrEqual(seq);
}

test("the GM authors an item input and uses the readable picker or focused item window in directory, chat and hotbar", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { wand, world } = await prepareItems(page);
  const scroll = await makeItem(page, "scroll");
  // A selected token WITH an inventory is not an item selection.
  const hero = await surfaceCallArg<{ x: number; y: number }>(page, "app", "screenOf", { x: 150, y: 150 });
  await page.locator('[data-canvas-tool="select"]').click();
  await page.mouse.click(hero.x, hero.y);
  await authorItemMacro(page, true);
  await openRun(page);
  await expect(runEditor(page).locator("[data-automation-run-item-selected]")).toContainText("none — open an item window");
  const seq = await hostCall<number>(page, "seq");
  await runEditor(page).locator("[data-automation-run-with]").click();
  await expect(runEditor(page).locator("[data-automation-run-error]")).toHaveText("select an item for tool");
  expect(await hostCall<number>(page, "seq")).toBe(seq);
  const picker = runEditor(page).getByLabel("tool", { exact: true });
  await expect(picker.locator(`option[value="${world}"]`)).toHaveText("World focus — world item");
  await expect(picker.locator(`option[value="a-hero/${wand}"]`)).toHaveText("Wand of Magic Missile — hero (actor)");
  await picker.selectOption(world);
  await commitLine(page, world, () => runEditor(page).locator("[data-automation-run-with]").click());
  await macros(page).locator("[data-window-close]").click();

  await openItem(page, wand, false, 270);
  await openItem(page, scroll, false, 380);
  await openRun(page);
  await expect(runEditor(page).locator("[data-automation-run-item-selected]")).toContainText("Scroll of Magic Missile — hero (actor)");
  await commitLine(page, `a-hero/${scroll}`, () => runEditor(page).locator("[data-automation-run-with]").click());
  // A successful run collapses the form; reopen it for an explicit override.
  await macroRow(page).locator("[data-automation-macro-run]").click();
  // Explicit picker value wins over the still-open selected item window.
  await runEditor(page).getByLabel("tool", { exact: true }).selectOption(world);
  await commitLine(page, world, () => runEditor(page).locator("[data-automation-run-with]").click());
  await macros(page).locator("[data-window-close]").click();
  await itemShell(page, wand).locator(".wm-name").click();
  await commitLine(page, `a-hero/${wand}`, () => chatRun(page));
  await commitLine(page, `a-hero/${wand}`, () => slot(page).click());
  await page.locator("#chat-input").blur();
  await commitLine(page, `a-hero/${wand}`, () => page.keyboard.press("1"));
  await itemShell(page, wand).locator("[data-window-close]").click();
  await commitLine(page, `a-hero/${scroll}`, () => chatRun(page)); // closing exposes the other open item
  await itemShell(page, scroll).locator("[data-window-min]").click();
  const minimizedAt = await hostCall<number>(page, "seq");
  await chatRun(page);
  await expect(page.locator("[data-chat-command-status]")).toHaveText("select an item for tool");
  expect(await hostCall<number>(page, "seq")).toBe(minimizedAt);
  await commitLine(page, `a-hero/${wand}`, () => chatRun(page, `tool=a-hero/${wand}`));
  expect(errors).toEqual([]);
});

test("the player sees only readable item choices, shares the selected-item defaults, and a deleted top window cannot fall back or run", async ({ browser }) => {
  test.setTimeout(180_000);
  const hostCtx = await browser.newContext();
  const playerCtx = await browser.newContext();
  try {
    const host = await hostCtx.newPage();
    const player = await playerCtx.newPage();
    const errors: string[] = [];
    for (const view of [host, player]) view.on("pageerror", (error) => errors.push(error.message));
    const { wand, world } = await prepareItems(host);
    await authorItemMacro(host);
    await joinPlayer(host, player);
    const userId = await playerCall<string>(player, "userId");
    // Publish this WORLD item to that player through the actual directory ownership control.
    await host.locator('[data-tab="actors"]').click();
    await host.getByRole("region", { name: "Sheets", exact: true }).getByRole("button", { name: "Items", exact: true }).click();
    await host.locator(`#sheet-list [data-doc-id="${world}"]`).click();
    await host.locator("#assign-owner").selectOption(userId);
    await expect(slot(player)).toHaveAttribute("title", "Item bell");
    await openRun(player, true);
    const picker = runEditor(player).getByLabel("tool", { exact: true });
    await expect(picker.locator("option").filter({ hasText: "vault" })).toHaveCount(0);
    await expect(picker.locator(`option[value="${world}"]`)).toHaveText("World focus — world item");
    await expect(picker.locator(`option[value="a-hero/${wand}"]`)).toHaveCount(1);
    await runEditor(player).locator("[data-automation-run-with]").click();
    await expect(runEditor(player).locator("[data-automation-run-error]")).toHaveText("select an item for tool");
    await picker.selectOption(world);
    await commitLine(host, world, () => runEditor(player).locator("[data-automation-run-with]").click());
    // Store refresh must keep the player's public automation directory, not reset it to Scripts.
    await expect(macroRow(player)).toBeVisible();
    await expect(macros(player).locator("[data-macro-automations-tab]")).toHaveAttribute("aria-pressed", "true");
    const callable = JSON.parse(await playerCall<string>(player, "macroCallable")) as { automation: unknown };
    expect(callable.automation).toEqual({ inputs: [{ name: "tool", type: "item", required: true, from: "selected" }] });
    await macros(player).locator("[data-window-close]").click();
    await openItem(player, wand, true, 270);
    await commitLine(host, `a-hero/${wand}`, () => chatRun(player, "", true));
    await commitLine(host, `a-hero/${wand}`, () => slot(player).click());
    await player.locator("#chat-input").blur();
    await commitLine(host, `a-hero/${wand}`, () => player.keyboard.press("1"));

    // Create the new top item AFTER joining and earlier runs: the next two ordinary Undo
    // commands remove the coming invocation, then this item. The old item stays open.
    const scroll = await makeItem(host, "scroll");
    await openItem(player, scroll, true, 380);
    await openRun(player, true);
    await expect(runEditor(player).locator("[data-automation-run-item-selected]")).toContainText("Scroll of Magic Missile — hero (actor)");
    await commitLine(host, `a-hero/${scroll}`, () => runEditor(player).locator("[data-automation-run-with]").click());
    await macroRow(player).locator("[data-automation-macro-run]").click();
    await expect(runEditor(player)).toBeVisible();
    await host.locator("#gm-undo").click();
    await expect.poll(() => hostCall<string[]>(host, "chatLines")).not.toContain(`using a-hero/${scroll}`);
    await host.locator("#gm-undo").click();
    await expect(runEditor(player).getByLabel("tool", { exact: true }).locator(`option[value="a-hero/${scroll}"]`)).toHaveCount(0);
    await expect(runEditor(player).locator("[data-automation-run-item-selected]")).toContainText("none — open an item window");
    await expect(runEditor(player).getByLabel("tool", { exact: true }).locator(`option[value="a-hero/${wand}"]`)).toHaveCount(1);
    const staleAt = await hostCall<number>(host, "seq");
    await runEditor(player).locator("[data-automation-run-with]").click();
    await expect(runEditor(player).locator("[data-automation-run-error]")).toHaveText("select an item for tool");
    expect(await hostCall<number>(host, "seq")).toBe(staleAt); // no silent older-item fallback
    // An explicit readable ref remains usable, even while the stale top window is open.
    await runEditor(player).getByLabel("tool", { exact: true }).selectOption(`a-hero/${wand}`);
    await commitLine(host, `a-hero/${wand}`, () => runEditor(player).locator("[data-automation-run-with]").click());
    await macros(player).locator("[data-window-close]").click();
    await itemShell(player, scroll).locator("[data-window-close]").click();
    await commitLine(host, `a-hero/${wand}`, () => chatRun(player, "", true)); // explicitly closing exposes older item
    await expect(player.locator("#chat-log .chat-empty")).toBeVisible(); // authored GM audience is retained
    expect(await player.content()).not.toContain("vault (actor)");
    expect(errors).toEqual([]);
  } finally {
    await hostCtx.close();
    await playerCtx.close();
  }
});
