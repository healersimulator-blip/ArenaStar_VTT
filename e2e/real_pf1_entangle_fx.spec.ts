import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { openRealPf1World, realPf1Modules } from "./realPf1";
import { hostCall } from "./lib";

const worldPath = fileURLToPath(new URL("../dist/worlds/pf1e-integral-test-1.0.0.zip", import.meta.url));

test("Entangle: native FX Wizard follows genuine PF1 condition mechanics and removal", async ({ page }) => {
  test.setTimeout(600000);
  page.setDefaultTimeout(20000);
  page.on("console", m => { if (m.type() === "error" && !m.text().includes("local resource")) console.log("FRAME ERROR", m.text()); });
  await openRealPf1World(page, worldPath, "PF1 Unified Starter", realPf1Modules);

  // Author and bind through the shipped native Wizard, not a fabricated test cue.
  await page.locator("#gm-macros").click();
  await page.locator("[data-macro-fx-tab]").click();
  const wizard = page.locator("[data-fx-wizard]");
  await wizard.locator('[data-fx-macro-id="entangle-native-vines"]').getByRole("button", { name: "Edit", exact: true }).click();
  await wizard.locator("[data-fx-name]").fill("Entangle — Foundry linked vines");
  await wizard.locator("[data-fx-section]").getByLabel("Text", { exact: true }).fill("ENTANGLED • living vines");
  await wizard.locator("[data-fx-section]").getByRole("combobox", { name: /^Anchor/ }).selectOption("target");
  await wizard.locator("[data-fx-persistent]").check();
  await wizard.locator("[data-fx-save]").click();
  await expect(wizard.locator("li").filter({ hasText: "Entangle — Foundry linked vines" })).toBeVisible();
  await wizard.locator("[data-fx-binding-actor]").selectOption("integral-wizard");
  await wizard.locator("[data-fx-binding-item]").selectOption({ label: "Entangle" });
  await wizard.locator("[data-fx-binding-save]").click();
  await expect.poll(async () => {
    const macros = JSON.parse(await hostCall<string>(page, "worldMacros")) as { name: string; fxItem?: { actorId: string } }[];
    return macros.find(m => m.name === "Entangle — Foundry linked vines")?.fxItem?.actorId;
  }).toBe("integral-wizard");
  await page.locator('[data-window="macros"] [data-window-close]').click();

  const runScript = async (id: string) => {
    await page.locator("#gm-macros").click();
    await page.locator("[data-macro-script-tab]").click();
    const panel = page.locator("[data-script-wizard]");
    await panel.locator(`[data-script-pick="${id}"]`).click();
    await panel.getByLabel("I reviewed this exact revision and its host grants").check();
    await panel.locator("[data-script-save]").click();
    await panel.locator("[data-script-run]").click();
    await expect(panel.locator("summary").filter({ hasText: "completed" })).toBeVisible({ timeout: 20000 });
    await page.locator('[data-window="macros"] [data-window-close]').click();
  };
  await runScript("entangle-cast");

  const frame = page.frameLocator('iframe[title="AIS module:pf1"]').locator("body");
  const setup = await frame.evaluate(async () => {
    type Item = { uuid: string; name: string; system: { casterLevel: number; preparation: { value: number } }; defaultAction: { getDC(): number; duration: { value: string; units: string }; getRollData(): object }; use(options: object): Promise<{ shared: { rollData: object } }> };
    type Actor = { id: string; items: { contents: Item[] }; system: { abilities: { dex: { total: number; mod: number; penalty: number } }; attributes: { attack: { general: number } } }; statuses: Set<string>; effects: { contents: { uuid: string; origin: string; duration: { seconds: number } }[] }; setCondition(id: string, value: boolean | object): Promise<unknown>; rollSavingThrow(id: string, options: object): Promise<{ rolls: { total: number; _total: number }[] }> };
    const realm = globalThis as unknown as {
      game: { actors: Map<string, Actor> };
      RollPF: { safeRollSync(formula: string, data: object): { total: number; err?: unknown } };
      FoundryAdapter: { nativeFxIdle(): Promise<void>; info(): { hookErrors: unknown[]; documents: { hookErrors: unknown[] }; nativeFx: { effects: number } } };
    };
    const caster = realm.game.actors.get("integral-wizard"), target = realm.game.actors.get("integral-orc");
    if (!caster || !target) throw new Error("Scene actors missing");
    const spell = caster.items.contents.find(i => i.name === "Entangle");
    if (!spell) throw new Error("Genuine Entangle missing");
    const snapshot = () => ({ dex: target.system.abilities.dex.total, dexMod: target.system.abilities.dex.mod, dexPenalty: target.system.abilities.dex.penalty, attack: target.system.attributes.attack.general, entangled: target.statuses.has("entangled") });
    const before = snapshot();
    const rollData = spell.defaultAction.getRollData();
    const dc = spell.defaultAction.getDC();
    // PF1's documented static-roll option provides a repeatable failed-save demonstration.
    // Bonus derivation and the roll itself still run through the real upstream save API.
    const save = await target.rollSavingThrow("ref", { skipDialog: true, staticRoll: 1, chatMessage: false, dc });
    const total = save.rolls[0]?.total ?? save.rolls[0]?._total;
    if (typeof total !== "number" || !Number.isFinite(total) || total >= dc) throw new Error(`Expected failed Reflex save; ${total} vs ${dc}`);
    const duration = realm.RollPF.safeRollSync(spell.defaultAction.duration.value, rollData);
    if (duration.err || spell.defaultAction.duration.units !== "minute") throw new Error("Invalid source Entangle duration");
    // Upstream PF1 does not automatically apply area-spell conditions. This is
    // the explicit GM resolution step, using its real condition registry/API.
    // The reviewed scene macro applies this only after the failed save below.
    return { before, cl: spell.system.casterLevel, dc, save: total,
      durationSeconds: duration.total * 60, prepared: spell.system.preparation.value,
      };
  });
  await runScript("entangle-failed-save");
  const applied = await frame.evaluate(async () => {
    const r = globalThis as unknown as { game: { actors: Map<string, { system: { abilities: { dex: { total: number; mod: number; penalty: number } }; attributes: { attack: { general: number } } }; statuses: Set<string>; effects: { contents: { uuid: string; origin: string; duration: { seconds: number } }[] } }> }; FoundryAdapter: { nativeFxIdle(): Promise<void>; info(): { hookErrors: unknown[]; documents: { hookErrors: unknown[] }; nativeFx: { effects: number } } } };
    await r.FoundryAdapter.nativeFxIdle();
    const a = r.game.actors.get("integral-orc"); if (!a) throw new Error("Target missing");
    return { applied: { dex: a.system.abilities.dex.total, dexMod: a.system.abilities.dex.mod, dexPenalty: a.system.abilities.dex.penalty, attack: a.system.attributes.attack.general, entangled: a.statuses.has("entangled") },
      effects: a.effects.contents.map(e => ({ uuid: e.uuid, origin: e.origin, seconds: e.duration.seconds })), diagnostics: r.FoundryAdapter.info() };
  });
  const report = { ...setup, ...applied };
  console.log("ENTANGLE", JSON.stringify(report));
  await test.info().attach("entangle-mechanics-and-fx", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  expect(report.cl).toBe(5);
  expect(report.dc).toBe(14);
  expect(report.durationSeconds).toBe(300);
  expect(report.prepared).toBe(0);
  expect(report.applied.dex).toBe(report.before.dex);
  expect(report.applied.dexPenalty).toBe(report.before.dexPenalty - 4);
  expect(report.applied.dexMod).toBe(report.before.dexMod - 2);
  expect(report.applied.attack).toBe(report.before.attack - 2);
  expect(report.applied.entangled).toBe(true);
  expect(report.diagnostics.hookErrors).toEqual([]);
  expect(report.diagnostics.documents.hookErrors).toEqual([]);
  expect(report.diagnostics.nativeFx.effects).toBe(1);
  await expect.poll(() => hostCall<unknown[]>(page, "fxInstances")).toHaveLength(1);
  const [instance] = await hostCall<{ sourceTokenId: string; targetTokenId: string }[]>(page, "fxInstances");
  expect(instance).toMatchObject({ sourceTokenId: "integral-token-0", targetTokenId: "integral-token-1" });
  const settingsClose = page.locator('[data-window="settings"] [data-window-close]');
  if (await settingsClose.isVisible()) await settingsClose.click();
  await expect.poll(async () => (await hostCall<{ stage: { fxVisuals: number } }>(page, "a41RuntimeSnapshot")).stage.fxVisuals).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/entangle-active.png" });

  await runScript("entangle-clear");
  await expect.poll(() => hostCall<unknown[]>(page, "fxInstances")).toHaveLength(0);
  const removed = await frame.evaluate(() => {
    const realm = globalThis as unknown as { game: { actors: Map<string, { system: { abilities: { dex: { total: number; mod: number; penalty: number } }; attributes: { attack: { general: number } } }; statuses: Set<string> }> } };
    const a = realm.game.actors.get("integral-orc");
    return { dex: a?.system.abilities.dex.total, dexMod: a?.system.abilities.dex.mod, dexPenalty: a?.system.abilities.dex.penalty, attack: a?.system.attributes.attack.general, entangled: a?.statuses.has("entangled") };
  });
  expect(removed).toEqual(report.before);
  await expect.poll(async () => (await hostCall<{ stage: { fxVisuals: number } }>(page, "a41RuntimeSnapshot")).stage.fxVisuals).toBe(0);
  // Reapply the same failed-save resolution, then let upstream PF1 decide expiry.
  await runScript("entangle-failed-save");
  await expect.poll(() => hostCall<unknown[]>(page, "fxInstances")).toHaveLength(1);
  await runScript("entangle-expire");
  await expect.poll(() => hostCall<unknown[]>(page, "fxInstances")).toHaveLength(0);
  const expired = await frame.evaluate(() => {
    const r = globalThis as unknown as { game: { actors: Map<string, { statuses: Set<string>; system: { abilities: { dex: { penalty: number } }; attributes: { attack: { general: number } } } }> }; FoundryAdapter: { info(): { hookErrors: unknown[]; documents: { hookErrors: unknown[] } } } };
    const a = r.game.actors.get("integral-orc");
    return { entangled: a?.statuses.has("entangled"), dexPenalty: a?.system.abilities.dex.penalty, attack: a?.system.attributes.attack.general, diagnostics: r.FoundryAdapter.info() };
  });
  expect(expired.entangled).toBe(false);
  expect(expired.dexPenalty).toBe(report.before.dexPenalty);
  expect(expired.attack).toBe(report.before.attack);
  expect(expired.diagnostics.hookErrors).toEqual([]);
  expect(expired.diagnostics.documents.hookErrors).toEqual([]);
  await test.info().attach("entangle-expiry", { body: JSON.stringify(expired, null, 2), contentType: "application/json" });

});
