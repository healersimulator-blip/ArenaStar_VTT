/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { expect, test } from "@playwright/test";
import { entry, hostCall, importShippedCore, surfaceCallArg, waitForSurface } from "./lib";

test("a world-compendium spell outside the tactical catalogue binds FX and works on the quickbar", async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await importShippedCore(page);

  const placed = await surfaceCallArg<{ ok: boolean; placed: number }>(page, "app", "pf1ePlaceTokens", [
    { id: "hero", col: 1, row: 1 },
    { id: "ogre", col: 2, row: 1, owner: "gm" },
  ]);
  expect(placed).toMatchObject({ ok: true, placed: 2 });
  expect(await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1eAuthorActor", {
    actorId: "a-hero",
    patch: { abilities: { int: 16 }, spells: { keyAbility: "int", mode: "prepared",
      casterLevel: 5, slotsPerDay: { 1: 3 }, prepared: [] } },
  })).toMatchObject({ ok: true });
  expect(await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1eAuthorActor", {
    actorId: "a-ogre", patch: { hp: 40, hpMax: 40 },
  })).toMatchObject({ ok: true });

  // Author one reusable sequence in the world's FX library, then bind it from the actual
  // compendium-created prepared row. Mage Armor is in pf1e-core's spell pack but not the
  // tactical-effect catalogue, so this proves the binding uses the normalized spell name.
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator("[data-fx-name]").fill("Mage Armor shimmer");
  await wizard.getByRole("button", { name: "Text", exact: true }).click();
  await wizard.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill("Arcane sparks");
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li").filter({ hasText: "Mage Armor shimmer" })).toContainText("1 sections");
  const authored = JSON.parse(await hostCall<string>(page, "worldMacros")) as Array<{ _id: string; name: string }>;
  const cue = authored.find((macro) => macro.name === "Mage Armor shimmer");
  expect(cue?._id).toBeTruthy();
  await page.locator('[data-window="macros"] [data-window-close]').click();

  await page.click('[data-tab="actors"]');
  await page.locator("#sheet-list .sheet-row").filter({ hasText: "hero (actor)" }).click();
  await page.click("[data-open-pf1e-sheet]");
  const sheet = page.locator(".wm-window [data-pf1e-sheet]");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "spells", exact: true }).click();
  const book = sheet.locator("[data-pf1e-spellbook]");
  await book.locator("[data-browse-compendium-spells]").click();
  const compendium = page.locator(".compendium-picker-window");
  await compendium.locator("[data-picker-search]").fill("Mage Armor");
  const mageArmor = compendium.locator("[data-picker-row]").filter({ hasText: "Mage Armor" }).first();
  await expect(mageArmor).toBeVisible();
  await mageArmor.locator("[data-add-compendium-entry]").click();
  await expect(book.locator('[data-prepared-row="0"]')).toContainText("Mage Armor");
  // The compendium stores structured component flags; the spellbook converts them to the
  // standard abbreviations consumed by the shared cast gate.
  await expect(book.locator('[data-prepared-row="0"]')).toContainText("V, S, M");

  await book.locator('[data-pf1e-prepared-fx="0"]').click();
  const picker = page.locator("[data-fx-binding-picker]");
  await expect(picker).toBeVisible();
  await picker.locator(`[data-fx-binding-option="${cue!._id}"]`).click();
  await picker.locator('input[name="fx-binding-share"][value="all"]').check();
  await picker.locator("[data-fx-binding-callable]").check();
  await picker.locator("[data-fx-binding-attach]").click();
  await expect(picker.locator("[data-fx-binding-status]")).toContainText("all-player");
  await expect.poll(async () => {
    const macros = JSON.parse(await hostCall<string>(page, "worldMacros")) as Array<{
      _id: string; ownership: { default: number }; flags?: { core?: { playerCallable?: boolean } };
      fxSpell?: { spellId: string; spellName?: string };
    }>;
    return macros.find((macro) => macro._id === cue!._id) ?? null;
  }).toMatchObject({ ownership: { default: 2 },
    flags: { core: { playerCallable: true } }, fxSpell: { spellId: "mage-armor", spellName: "Mage Armor" } });
  await expect(book.locator('[data-pf1e-prepared-fx="0"]')).toContainText("Mage Armor shimmer");
  await picker.locator("[data-fx-binding-close]").click();

  // The prepared-sheet cast invokes the exact normalized-name binding after resolution.
  await book.locator('[data-cast-prepared="0"]').click();
  await book.locator("[data-cast-severity]").selectOption("none");
  await book.locator("[data-cast-damage]").fill("");
  await book.locator("[data-cast-target]").selectOption({ label: "ogre (actor)" });
  await book.locator("[data-cast-submit]").click();
  await expect.poll(() => hostCall(page, "lastFxCue"), { timeout: 10_000 })
    .toMatchObject({ macroId: cue!._id });
  // Reset the prepared row and slot ledger so the next assertion exercises a fresh cast through
  // the quickbar rather than attempting to cast an already-expended preparation.
  expect(await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1eAuthorActor", {
    actorId: "a-hero", patch: { spells: { keyAbility: "int", mode: "prepared", casterLevel: 5,
      slotsPerDay: { 1: 3 }, slotsUsed: { 1: 0 }, prepared: [{ name: "Mage Armor", level: 1,
        slotLevel: 1, components: "V, S, M" }] } },
  })).toMatchObject({ ok: true });
  await expect.poll(async () => surfaceCallArg<Record<string, unknown> | null>(
    page, "app", "pf1eActorSystem", "a-hero"), { timeout: 10_000 }).toMatchObject({
      spells: { slotsUsed: { "1": 0 }, prepared: [{ name: "Mage Armor", slotLevel: 1, components: "V, S, M" }] },
    });
  await expect(book.locator('[data-prepared-row="0"]')).not.toContainText("expended");

  // The same non-catalogue spell can be bound to the actor quickbar. Its cast inputs are
  // explicit and stored with the slot; no save or damage behavior is guessed from the name.
  await page.locator(".wm-window").filter({ has: sheet }).locator("[data-window-close]").click();
  const camera = await hostCall<{ x: number; y: number; scale: number }>(page, "camera");
  const box = await page.locator(".canvas-host canvas").boundingBox();
  if (!box) throw new Error("canvas not mounted");
  await page.mouse.click(box.x + (150 - camera.x) * camera.scale, box.y + (150 - camera.y) * camera.scale);
  const quickbar = page.locator("[data-quickbar]");
  await expect(quickbar.locator('[data-quickbar-actor="a-hero"]')).toBeVisible();
  const bind = quickbar.locator("[data-quickbar-bind]");
  await expect.poll(async () => (await bind.locator("option").allTextContents()).join("|"))
    .toContain("Mage Armor (level 1)");
  await bind.selectOption("spell:0");
  const profile = quickbar.locator("[data-quickbar-spell-profile]");
  await expect(profile).toBeVisible();
  await profile.locator("[data-quickbar-spell-save]").selectOption("ref");
  await profile.locator("[data-quickbar-spell-severity]").selectOption("none");
  await profile.locator("[data-quickbar-spell-damage]").fill("");
  await profile.locator("[data-quickbar-spell-profile-confirm]").check();
  await quickbar.locator("[data-quickbar-slot-select]").selectOption("1");
  await quickbar.locator("[data-quickbar-bind-apply]").click();
  await expect.poll(async () => surfaceCallArg<Array<{ slot: number; spellProfile?: unknown }>>(
    page, "app", "pf1eQuickbar", "a-hero"), { timeout: 10_000 }).toMatchObject([
      { slot: 1, spellProfile: { saveType: "ref", severity: "none", damageFormula: "" } },
    ]);
  await quickbar.locator("[data-quickbar-target]").selectOption("a-ogre");
  const previousRun = await hostCall<{ runId: string }>(page, "lastFxCue");
  await quickbar.locator('[data-quickbar-slot="1"]').click();
  await expect(quickbar.locator("[data-quickbar-status]")).toContainText("Mage Armor", { timeout: 20_000 });
  await expect.poll(() => hostCall(page, "lastFxCue"), { timeout: 10_000 })
    .toMatchObject({ macroId: cue!._id });
  await expect.poll(async () => (await hostCall<{ runId: string }>(page, "lastFxCue"))?.runId)
    .not.toBe(previousRun?.runId);
  expect(errors).toEqual([]);
});
