/** D-394: production single-file app, real GM/players, signed joins and WebRTC.
 * Authoring, opt-in, review, revocation, deletion and export/restore are product UI.
 * Hooks read committed/projected documents only; none inject macros or authority.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import type { MacroDocument, UserDocument } from "../src/core/documents";
import type { WorldFileDocuments } from "../src/host/worldFile";
import { entry, hostCall, manualFragment, playerCall, waitForSurface } from "./lib";

test.use({ actionTimeout: 15_000 });
const mine = (page: Page) => page.locator("[data-my-world-macros]");
const myRow = (page: Page, name: string) => mine(page).locator("[data-my-macro-id]").filter({ hasText: name });
const scripts = (page: Page) => page.locator("[data-script-wizard]");
const permissions = (page: Page) => page.locator('[data-window="permissions"]');
const docs = async (page: Page, player = false): Promise<MacroDocument[]> =>
  JSON.parse(await (player ? playerCall<string>(page, "worldMacros") : hostCall<string>(page, "worldMacros"))) as MacroDocument[];

async function joinPlayer(host: Page, player: Page): Promise<void> {
  const fragment = manualFragment(await host.locator("#invite-link").inputValue());
  const oldAnswer = await host.locator("#share-out").inputValue();
  await player.goto(`${entry}?e2e=1&join=1#${fragment}`);
  await expect.poll(() => player.locator("#offer-out").inputValue(), { timeout: 20_000 }).not.toBe("");
  await host.locator("#peer-code").fill(await player.locator("#offer-out").inputValue());
  await host.locator("#code-apply").click();
  await expect.poll(() => host.locator("#share-out").inputValue(), { timeout: 20_000 }).not.toBe(oldAnswer);
  await player.locator("#answer-input").fill(await host.locator("#share-out").inputValue());
  await player.locator("#answer-apply").click();
  await expect.poll(() => playerCall<boolean>(player, "connected"), { timeout: 30_000 }).toBe(true);
  await waitForSurface(player, "playerCanvas");
  const seq = await hostCall<number>(host, "seq");
  await expect.poll(() => playerCall<number>(player, "seq")).toBeGreaterThanOrEqual(seq);
}

async function optIn(host: Page, playerId: string, enabled: boolean): Promise<Locator> {
  // Close the reviewed source window through its normal UI so it cannot cover Permissions.
  const macroWindow = host.locator('[data-window="macros"]');
  if (await macroWindow.isVisible()) await macroWindow.locator("[data-window-close]").click();
  await host.locator("#gm-perms").click();
  const checkbox = permissions(host).locator(`[data-perm-users] tr[data-user="${playerId}"] [data-perm-macro-save]`);
  await expect(checkbox).toBeVisible();
  await checkbox.setChecked(enabled);
  await expect(checkbox).toBeChecked({ checked: enabled });
  return checkbox;
}

async function openMine(player: Page): Promise<void> {
  await player.locator("[data-player-macros]").click();
  await player.locator("[data-my-world-macros-tab]").click();
  await expect(mine(player)).toBeVisible();
}

async function saveChat(player: Page, name: string, command: string): Promise<string> {
  await mine(player).locator("[data-my-macro-name]").fill(name);
  await mine(player).locator("[data-my-macro-source]").fill(command);
  await mine(player).locator("[data-my-macro-save]").click();
  await expect(mine(player).getByRole("status")).toContainText("Saved in GM world");
  const row = myRow(player, name);
  await expect(row).toHaveCount(1);
  const id = await row.getAttribute("data-my-macro-id");
  if (!id) throw new Error("saved personal macro has no committed ID");
  return id;
}

test.describe("GM-enabled personal world macro saving", () => {
  test("opt-in is per player, revocation preserves the draft, and the real GM ZIP restores saved content", async ({ page, browser }) => {
    test.setTimeout(150_000);
    const player = await browser.newPage();
    const other = await browser.newPage();
    try {
      await page.goto(entry + "?e2e=1");
      await waitForSurface(page, "app");
      await page.locator("#share").click();
      await joinPlayer(page, player);
      await joinPlayer(page, other);
      const playerId = await playerCall<string>(player, "userId");
      const otherId = await playerCall<string>(other, "userId");
      expect(otherId).not.toBe(playerId);
      await player.locator("[data-player-macros]").click();
      await expect(player.locator("[data-my-world-macros-tab]")).toHaveCount(0);
      await expect(mine(player).locator("[data-my-macro-save]")).toBeDisabled();
      await page.locator("#gm-perms").click();
      const checkbox = permissions(page).locator(`[data-perm-users] tr[data-user="${playerId}"] [data-perm-macro-save]`);
      await expect(checkbox).not.toBeChecked();
      await checkbox.check();
      await expect(player.locator("[data-my-world-macros-tab]")).toBeVisible();
      await player.locator("[data-my-world-macros-tab]").click();
      await expect(mine(player).locator("[data-my-macro-save]")).toBeEnabled();
      const macroId = await saveChat(player, "Personal initiative", "/roll 1d20");
      const saved = (await docs(page)).find((doc) => doc._id === macroId);
      expect(saved?.ownership).toEqual({ default: 0, [playerId]: 3 });
      expect(saved?.playerAuthoring).toEqual({ version: 1, userId: playerId,
        draft: { kind: "chat", name: "Personal initiative", command: "/roll 1d20" } });
      expect(saved?.flags.core?.slot).toBeUndefined();
      expect((await docs(other, true)).find((doc) => doc._id === macroId)).toBeUndefined();
      await other.locator("[data-player-macros]").click();
      await expect(other.locator("[data-my-world-macros-tab]")).toHaveCount(0);
      await expect(permissions(page).locator(`[data-perm-users] tr[data-user="${otherId}"] [data-perm-macro-save]`)).not.toBeChecked();

      await mine(player).locator("[data-my-macro-source]").fill("/roll 2d20");
      await optIn(page, playerId, false);
      await expect(mine(player).locator("[data-my-macro-disabled]")).toBeVisible();
      await expect(mine(player).locator("[data-my-macro-save]")).toBeDisabled();
      await expect(myRow(player, "Personal initiative").locator("[data-my-macro-delete]")).toBeDisabled();
      await expect(mine(player).locator("[data-my-macro-source]")).toHaveValue("/roll 2d20");
      expect((await docs(page)).find((doc) => doc._id === macroId)?.command).toBe("/roll 1d20");
      // Saving permission is not an execution permission: run the saved, not unsaved command.
      await myRow(player, "Personal initiative").locator("[data-my-macro-run]").click();
      await expect.poll(() => hostCall<string[]>(page, "chatLines")).toContain("1d20");
      expect((await hostCall<string[]>(page, "chatLines")).includes("2d20")).toBe(false);
      await optIn(page, playerId, true);
      await expect(mine(player).locator("[data-my-macro-save]")).toBeEnabled();
      await expect(mine(player).locator("[data-my-macro-source]")).toHaveValue("/roll 2d20");
      await mine(player).locator("[data-my-macro-save]").click();
      await expect.poll(async () => (await docs(page)).find((doc) => doc._id === macroId)?.command).toBe("/roll 2d20");
      await expect(mine(player).getByRole("status")).toContainText("Saved in GM world");

      const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#export-world").click()]);
      const zipPath = await download.path();
      if (!zipPath) throw new Error("GM world ZIP download unavailable");
      const files = unzipSync(new Uint8Array(await readFile(zipPath)));
      const documents = JSON.parse(strFromU8(files["documents.json"] as Uint8Array)) as WorldFileDocuments;
      const archived = documents.docs.find((row) => row.coll === "macros" && row.id === macroId)?.doc as MacroDocument;
      expect(archived.command).toBe("/roll 2d20");
      expect(archived.playerAuthoring?.draft.command).toBe("/roll 2d20");
      expect((documents.docs.find((row) => row.coll === "users" && row.id === playerId)?.doc as UserDocument).canSaveMacros).toBe(true);
      const worldId = await hostCall<string>(page, "worldId");
      await myRow(player, "Personal initiative").locator("[data-my-macro-delete]").click();
      await expect(myRow(player, "Personal initiative")).toHaveCount(0);
      await expect.poll(async () => (await docs(page)).some((doc) => doc._id === macroId)).toBe(false);
      await player.close(); await other.close();
      await page.locator("#close-world").click();
      await expect(page.locator("[data-world-list]")).toBeVisible();
      await page.locator("#role-import").setInputFiles(zipPath);
      const dialog = page.locator("[data-open-dialog]");
      await expect(dialog).toHaveAttribute("data-open-kind", "world");
      await dialog.locator("[data-open-replace]").click();
      await waitForSurface(page, "app");
      expect(await hostCall<string>(page, "worldId")).toBe(worldId);
      await expect.poll(async () => (await docs(page)).find((doc) => doc._id === macroId)?.command).toBe("/roll 2d20");
      expect((await docs(page)).find((doc) => doc._id === macroId)?.playerAuthoring).toEqual(archived.playerAuthoring);
      await page.locator("#gm-perms").click();
      await expect(permissions(page).locator(`[data-perm-users] tr[data-user="${playerId}"] [data-perm-macro-save]`)).toBeChecked();
    } finally { if (!player.isClosed()) await player.close(); if (!other.isClosed()) await other.close(); }
  });

  test("script drafts require separate GM review, preserve author ownership, and never reveal later GM source", async ({ page, browser }) => {
    test.setTimeout(150_000);
    const player = await browser.newPage();
    const other = await browser.newPage();
    try {
      await page.goto(entry + "?e2e=1");
      await waitForSurface(page, "app");
      await page.locator("#share").click();
      await joinPlayer(page, player); await joinPlayer(page, other);
      const playerId = await playerCall<string>(player, "userId");
      await optIn(page, playerId, true);
      await openMine(player);
      const original = "// My original draft\nreturn { note: args.note };";
      await mine(player).locator("[data-my-macro-name]").fill("Player script draft");
      await mine(player).locator("[data-my-macro-kind]").selectOption("script");
      await mine(player).locator("[data-my-macro-source]").fill(original);
      await mine(player).locator("[data-my-macro-add-input]").click();
      await mine(player).getByLabel("Input 1 name").fill("note");
      await mine(player).getByLabel("Input 1 name").dispatchEvent("change");
      await mine(player).locator("[data-my-macro-save]").click();
      await expect(mine(player).getByRole("status")).toContainText("Saved in GM world");
      const macroId = await myRow(player, "Player script draft").getAttribute("data-my-macro-id");
      if (!macroId) throw new Error("personal script missing");
      let hostDoc = (await docs(page)).find((doc) => doc._id === macroId);
      expect(hostDoc?.script).toMatchObject({ approvedHash: "0".repeat(64), grants: [], runAs: "caller", playerCallable: false });
      const before = await hostCall<number>(page, "seq");
      await player.locator("[data-macro-script-tab]").click();
      await scripts(player).locator(`[data-script-pick="${macroId}"]`).click();
      await expect(scripts(player).locator("[data-script-run]")).toHaveCount(0);
      expect(await hostCall<number>(page, "seq")).toBe(before);
      expect((await docs(other, true)).some((doc) => doc._id === macroId)).toBe(false);

      await page.locator("#gm-macros").click();
      await page.locator("[data-macro-script-tab]").click();
      await scripts(page).locator(`[data-script-pick="${macroId}"]`).click();
      await expect(scripts(page).locator("[data-script-source]")).toHaveValue(original);
      const privateSource = "// GM_ONLY_PRIVATE_394_SOURCE\nawait api.chat.say('Reviewed player greeting', 'scene'); return { secret: 'GM_ONLY_PRIVATE_394_RESULT' };";
      await scripts(page).locator("[data-script-source]").fill(privateSource);
      await scripts(page).getByLabel("Run as").selectOption("gm");
      await scripts(page).getByLabel("Allow players to invoke").check();
      await scripts(page).getByLabel("Hotbar slot").selectOption("2");
      await scripts(page).locator(".grants label").filter({ hasText: "chat" }).locator("input").check();
      await scripts(page).getByLabel("I reviewed this exact revision and its host grants").check();
      await scripts(page).locator("[data-script-save]").click();
      await expect(scripts(page).getByRole("status")).toContainText("Script revision published");
      hostDoc = (await docs(page)).find((doc) => doc._id === macroId);
      expect(hostDoc?.command).toBe(privateSource);
      expect(hostDoc?.ownership).toEqual({ default: 1, [playerId]: 3 });
      expect(hostDoc?.playerAuthoring?.draft.command).toBe(original);
      const owned = (await docs(player, true)).find((doc) => doc._id === macroId);
      expect(owned?.command).toBe("");
      expect(owned?.playerAuthoring?.draft.command).toBe(original);
      expect(JSON.stringify(owned)).not.toContain("GM_ONLY_PRIVATE");
      await expect.poll(async () => (await docs(other, true)).some((doc) => doc._id === macroId)).toBe(true);
      const publishedToOther = (await docs(other, true)).find((doc) => doc._id === macroId);
      expect(publishedToOther?.command).toBe("");
      expect(publishedToOther?.playerAuthoring).toBeUndefined();
      expect(JSON.stringify(publishedToOther)).not.toMatch(/GM_ONLY_PRIVATE|My original draft/);

      await player.locator("[data-my-world-macros-tab]").click();
      await myRow(player, "Player script draft").locator("[data-my-macro-edit]").click();
      await expect(mine(player).locator("[data-my-macro-source]")).toHaveValue(original);
      const revision = "return { revisedByPlayer: true };";
      await mine(player).locator("[data-my-macro-source]").fill(revision);
      await optIn(page, playerId, false);
      await expect(mine(player).locator("[data-my-macro-save]")).toBeDisabled();
      await expect(mine(player).locator("[data-my-macro-source]")).toHaveValue(revision);
      await player.locator("[data-macro-script-tab]").click();
      await scripts(player).locator(`[data-script-pick="${macroId}"]`).click();
      await scripts(player).locator("[data-script-run]").click();
      await expect(scripts(player).getByRole("status")).toContainText("Script completed");
      await expect.poll(() => hostCall<string[]>(page, "chatLines")).toContain("Reviewed player greeting");
      await expect(scripts(player).locator("details")).toHaveCount(0);
      const history = (await docs(page)).find((doc) => doc._id === macroId)?.scriptState;
      expect(history?.recent).toHaveLength(1);
      await optIn(page, playerId, true);
      await player.locator("[data-my-world-macros-tab]").click();
      await expect(mine(player).locator("[data-my-macro-source]")).toHaveValue(revision);
      await mine(player).locator("[data-my-macro-save]").click();
      await expect(mine(player).getByRole("status")).toContainText("Saved in GM world");
      hostDoc = (await docs(page)).find((doc) => doc._id === macroId);
      expect(hostDoc?.command).toBe(revision);
      expect(hostDoc?.script).toMatchObject({ approvedHash: "0".repeat(64), runAs: "caller", playerCallable: false, grants: [] });
      expect(hostDoc?.ownership).toEqual({ default: 0, [playerId]: 3 });
      expect(hostDoc?.flags.core).toEqual({ slot: 2, playerCallable: false });
      expect(hostDoc?.scriptState).toEqual(history);
      expect((await docs(other, true)).some((doc) => doc._id === macroId)).toBe(false);
      await player.locator("[data-macro-script-tab]").click();
      await scripts(player).locator(`[data-script-pick="${macroId}"]`).click();
      await expect(scripts(player).locator("[data-script-run]")).toHaveCount(0);
    } finally { await player.close(); await other.close(); }
  });

  test("GM can revoke document ownership independently, retaining the unsaved editor buffer without granting management", async ({ page, browser }) => {
    test.setTimeout(100_000);
    const player = await browser.newPage();
    try {
      await page.goto(entry + "?e2e=1"); await waitForSurface(page, "app");
      await page.locator("#share").click(); await joinPlayer(page, player);
      const playerId = await playerCall<string>(player, "userId");
      await optIn(page, playerId, true); await openMine(player);
      const macroId = await saveChat(player, "Ownership test", "/me waves");
      await mine(player).locator("[data-my-macro-source]").fill("/me preserves this unsaved draft");
      await permissions(page).locator("[data-perm-coll]").selectOption("macros");
      await permissions(page).locator("[data-perm-doc]").selectOption(macroId);
      await permissions(page).locator("[data-perm-default]").selectOption("1");
      const owner = permissions(page).locator(`[data-perm-owner="${playerId}"]`);
      await expect(owner).toHaveValue("3");
      await owner.selectOption("0");
      await expect(owner).toHaveValue("0");
      await expect(mine(player).locator("[data-my-macro-save]")).toBeDisabled();
      await expect(mine(player).locator("[data-my-macro-source]")).toHaveValue("/me preserves this unsaved draft");
      await expect(mine(player).locator("[data-my-macro-unavailable]")).toBeVisible();
      expect((await docs(player, true)).find((doc) => doc._id === macroId)?.playerAuthoring).toBeNull();
      expect((await docs(page)).find((doc) => doc._id === macroId)?.command).toBe("/me waves");
      await owner.selectOption("3");
      await expect(mine(player).locator("[data-my-macro-save]")).toBeEnabled();
      await expect(mine(player).locator("[data-my-macro-source]")).toHaveValue("/me preserves this unsaved draft");
      await mine(player).locator("[data-my-macro-save]").click();
      await expect.poll(async () => (await docs(page)).find((doc) => doc._id === macroId)?.command).toBe("/me preserves this unsaved draft");
    } finally { await player.close(); }
  });
});
