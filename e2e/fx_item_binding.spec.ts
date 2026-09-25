/**
 * D-311 (parity spec A09 / SQ-12's last clause) — **an authored sequence bound to an item, and
 * the cue a *committed* use of that item plays.**
 *
 * The whole loop is a real one, in the real UI, on one page:
 *
 * 1. two PF1e tokens (a caster and a target) and a prepared spell on the caster;
 * 2. the caster's own Items tab generates a wand from that spell (the product's own
 *    "make a consumable" verb — no fixture document is injected into the world);
 * 3. the FX wizard authors two timelines and binds one to the wand, with the other as its
 *    failure cue;
 * 4. the item window casts out of the wand and the bound timeline runs on the Pixi stage.
 *
 * What the assertions are *for*: (a) an unbound item plays nothing at all — no cue, no
 * "requested" sentence; (b) a committed cast plays the bound cue, watched on `__stage` rather
 * than in a socket echo; (c) the author's manual disable stops it, and the note says so;
 * (d) the recognition override sends a *successful* cast to the failure cue — the branch
 * follows the authored recognition, which is the only way to pin a branch deterministically
 * from a browser (the natural failure paths — a miss, a save, spell resistance — are covered
 * by `tests/ui/fxItemCue.test.ts`, where the die is part of the fixture).
 */
import { expect, test } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";

/** The Pixi stage's live FX instance count — the fact under test, not an echo of our request. */
function activeFx(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() =>
    (
      globalThis as unknown as { __stage?: { getFxLayer: () => { count: number } } }
    ).__stage?.getFxLayer().count ?? 0,
  );
}

test("an item cast plays the timeline bound to it, and a disable or a forced miss is honoured", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (event) => errors.push(event.message));

  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");

  // ── the table: a caster and a target, and one prepared spell to build the wand from ─────
  const placed = await surfaceCallArg<{ ok: boolean; placed: number }>(page, "app", "pf1ePlaceTokens", [
    { id: "hero", col: 1, row: 1 },
    { id: "ogre", col: 3, row: 1, owner: "gm" },
  ]);
  expect(placed).toMatchObject({ ok: true, placed: 2 });
  expect(
    await surfaceCallArg<{ ok: boolean }>(page, "app", "pf1eAuthorActor", {
      actorId: "a-hero",
      patch: { abilities: { int: 16 }, spells: { prepared: [{ name: "Magic Missile", level: 1 }] } },
    }),
  ).toMatchObject({ ok: true });

  // ── the item: generated on the caster's own sheet, out of their own prepared spell ──────
  await page.click('[data-tab="actors"]');
  await page.locator("#sheet-list .sheet-row").filter({ hasText: "hero (actor)" }).click();
  await page.click("[data-open-pf1e-sheet]");
  const sheet = page.locator(".wm-window [data-pf1e-sheet]");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "items", exact: true }).click();
  const itemsTab = sheet.locator("[data-pf1e-items]");
  await itemsTab.locator('[data-pf1e-make-consumable] select[aria-label="Spell"]').selectOption("Magic Missile");
  await itemsTab.locator('[data-pf1e-make-consumable] select[aria-label="Item kind"]').selectOption("wand");
  await itemsTab.locator("[data-pf1e-make-consumable-apply]").click();
  const wandRow = itemsTab.locator('[data-pf1e-item-name="Wand of Magic Missile"]');
  await expect(wandRow).toHaveCount(1);

  const openWand = async (): Promise<import("@playwright/test").Locator> => {
    await wandRow.locator("[data-pf1e-item-open]").click();
    const window = page.locator(".wm-window [data-pf1e-item-window]");
    await expect(window).toBeVisible();
    return window;
  };
  const cast = async (window: import("@playwright/test").Locator): Promise<void> => {
    await window.locator("[data-pf1e-item-window-target]").selectOption({ label: "ogre (actor)" });
    await window.locator("[data-pf1e-item-window-cast-apply]").click();
    await expect(window.locator("[data-pf1e-item-window-note]")).toContainText("charge(s) left", {
      timeout: 20_000,
    });
  };

  // ── (a) unbound: the item says nothing about cues, and a cast plays nothing ─────────────
  let itemWindow = await openWand();
  await expect(itemWindow.locator("[data-pf1e-item-window-fx]")).toHaveCount(0);
  await cast(itemWindow);
  await expect(itemWindow.locator("[data-pf1e-item-window-note]")).not.toContainText("requested");
  await page.waitForTimeout(1_500); // the cue's own lead is 300 ms; past that it landed or never will
  expect(await activeFx(page)).toBe(0);
  await page
    .locator(".wm-window")
    .filter({ has: page.locator("[data-pf1e-item-window]") })
    .locator("[data-window-close]")
    .click();

  // ── the timelines, authored in the wizard ───────────────────────────────────────────────
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  const authorText = async (name: string): Promise<void> => {
    await wizard.locator("[data-fx-name]").fill(name);
    await wizard.getByRole("button", { name: "Text", exact: true }).click();
    await wizard.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill(
      name === "Hit sparks" ? "A bright ring of sparks" : "A sad little fizzle",
    );
    await wizard.locator("[data-fx-save]").click();
    await expect(wizard.locator("li").filter({ hasText: name })).toContainText("1 sections");
  };
  await authorText("Hit sparks");
  await wizard.getByRole("button", { name: "New", exact: true }).click();
  await authorText("Fizzle sparks");

  // ── (b) the binding: the timeline knows its item, with a failure cue beside it ───────────
  await wizard.locator("li").filter({ hasText: "Hit sparks" }).getByRole("button", { name: "Edit" }).click();
  const binding = wizard.locator("[data-fx-binding]");
  await binding.locator("[data-fx-binding-actor]").selectOption({ label: "hero (actor)" });
  await binding.locator("[data-fx-binding-item]").selectOption({ label: "Wand of Magic Missile" });
  await binding.locator("[data-fx-binding-failure]").selectOption({ label: "Fizzle sparks" });
  await binding.locator("[data-fx-binding-save]").click();
  await expect(wizard.getByRole("status")).toContainText("Wand of Magic Missile");
  // the host echoed the authored document — the remove verb only exists once it carries the binding
  await expect(binding.locator("[data-fx-binding-remove]")).toHaveCount(1);
  await page.locator('[data-window="macros"] [data-window-close]').click();

  // the item itself now says which timeline travels with it (the projection was never widened:
  // the binding lives on the timeline, the *item* only ever shows a timeline the reader can read)
  itemWindow = await openWand();
  await expect(itemWindow.locator("[data-pf1e-item-window-fx]")).toContainText("Hit sparks");
  await expect(itemWindow.locator("[data-pf1e-item-window-fx]")).toContainText(
    "a failed use plays the bound failure cue",
  );

  // ── a committed cast plays the bound cue, after the charge is spent ──────────────────────
  await cast(itemWindow);
  await expect(itemWindow.locator("[data-pf1e-item-window-note]")).toContainText(
    'bound cue "Hit sparks" requested',
  );
  await expect(itemWindow.locator("[data-pf1e-item-window-uses]")).toContainText("48");
  await expect.poll(() => activeFx(page), { timeout: 5_000, intervals: [50, 100, 100] })
    .toBeGreaterThan(0);
  await expect.poll(() => activeFx(page), { timeout: 5_000 }).toBe(0);
  await page
    .locator(".wm-window")
    .filter({ has: page.locator("[data-pf1e-item-window]") })
    .locator("[data-window-close]")
    .click();

  // ── (c) the author's manual disable wins over everything ────────────────────────────────
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  await wizard.locator("li").filter({ hasText: "Hit sparks" }).getByRole("button", { name: "Edit" }).click();
  await binding.locator("[data-fx-binding-enabled]").uncheck();
  await binding.locator("[data-fx-binding-save]").click();
  await page.locator('[data-window="macros"] [data-window-close]').click();
  itemWindow = await openWand();
  await expect(itemWindow.locator("[data-pf1e-item-window-fx]")).toContainText("disabled");
  await cast(itemWindow);
  await expect(itemWindow.locator("[data-pf1e-item-window-note]")).toContainText(
    "the item's bound cue is disabled",
  );
  await page.waitForTimeout(1_500);
  expect(await activeFx(page)).toBe(0);
  await page
    .locator(".wm-window")
    .filter({ has: page.locator("[data-pf1e-item-window]") })
    .locator("[data-window-close]")
    .click();

  // ── (d) the recognition override: this *successful* cast is read as a failure on purpose ─
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  await wizard.locator("li").filter({ hasText: "Hit sparks" }).getByRole("button", { name: "Edit" }).click();
  await binding.locator("[data-fx-binding-enabled]").check();
  await binding.locator("[data-fx-binding-recognition]").selectOption("failure");
  await binding.locator("[data-fx-binding-save]").click();
  await page.locator('[data-window="macros"] [data-window-close]').click();
  itemWindow = await openWand();
  await expect(itemWindow.locator("[data-pf1e-item-window-fx]")).toContainText("recognition forced to failure");
  await cast(itemWindow);
  await expect(itemWindow.locator("[data-pf1e-item-window-note]")).toContainText(
    'bound failure cue "Fizzle sparks" requested',
  );
  await expect.poll(() => activeFx(page), { timeout: 5_000, intervals: [50, 100, 100] })
    .toBeGreaterThan(0);
  await expect.poll(() => activeFx(page), { timeout: 5_000 }).toBe(0);

  // ── the bound pointer follows the item, and clearing it is a deletion ────────────────────
  await page
    .locator(".wm-window")
    .filter({ has: page.locator("[data-pf1e-item-window]") })
    .locator("[data-window-close]")
    .click();
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  await wizard.locator("li").filter({ hasText: "Hit sparks" }).getByRole("button", { name: "Edit" }).click();
  await binding.locator("[data-fx-binding-remove]").click();
  await expect(wizard.getByRole("status")).toContainText("Binding removed");
  await expect(binding.locator("[data-fx-binding-remove]")).toHaveCount(0);
  await page.locator('[data-window="macros"] [data-window-close]').click();
  itemWindow = await openWand();
  await expect(itemWindow.locator("[data-pf1e-item-window-fx]")).toHaveCount(0);
  await cast(itemWindow);
  await expect(itemWindow.locator("[data-pf1e-item-window-note]")).not.toContainText("requested");
  await page.waitForTimeout(1_500);
  expect(await activeFx(page)).toBe(0);

  expect(errors).toEqual([]);
});
