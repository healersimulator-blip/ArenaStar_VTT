import { test, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { openRealPf1World, realPf1Modules } from "./realPf1";

const worldPath = fileURLToPath(new URL("../dist/worlds/pf1e-integral-test-1.0.0.zip", import.meta.url));

test("Real PF1 unified starter: integral rule automation and authoritative persistence", async ({ page }) => {
  test.setTimeout(480000);
  expect(existsSync(worldPath), "Run node scripts/buildPf1eIntegralWorld.mjs").toBe(true);
  page.on("pageerror", (e) => console.log("HOST PAGE ERROR:", e.stack));
  page.on("console", (m) => { if (m.type() === "error") console.log("FRAME ERROR:", m.text()); });
  await openRealPf1World(page, worldPath, "PF1 Unified Starter", realPf1Modules);
  const report = await page.frameLocator('iframe[title="AIS module:pf1"]').locator("body").evaluate(async () => {
    type Roll = { total: number; formula: string; err?: unknown };
    type Item = { id: string; name: string; type: string; uuid: string; toObject(): object; system: { casterLevel: number; preparation: { value: number } }; defaultAction: { getDC(): number; rollDamage(options?: object): Promise<Roll[]> }; use(options: object): Promise<unknown> };
    type Actor = { getRollData(): object; changes: unknown; id: string; name: string; items: Map<string, Item>; system: { abilities: Record<string, { value: number; mod: number }>; skills: Record<string, { mod: number }>; attributes: { hp: { value: number; max: number } } }; sheet: { render(options: object): Promise<unknown> }; createEmbeddedDocuments(type: string, data: object[]): Promise<Item[]>; deleteEmbeddedDocuments(type: string, ids: string[]): Promise<unknown>; applyDamage(value: number): Promise<unknown>; update(data: object): Promise<unknown> };
    const realm = globalThis as unknown as {
      game: { actors: Map<string, Actor>; packs: Map<string, { getIndex(): Promise<{ _id: string; name: string }[]> }> };
      fromUuid(uuid: string): Promise<Item | null>;
      AIS: { documents: { get(query: object): Promise<{ content?: string; system: { attributes: { hp: { value: number } } }; items: { name: string; system: { preparation: { value: number } } }[] }> } };
      RollPF: { safeRollSync(formula: string, data: object): { total: number; err?: unknown } };
      FoundryAdapter: { info(): { hookErrors: unknown[]; documents: { hookErrors: unknown[] } } };
    };
    const wizard = realm.game.actors.get("integral-wizard");
    const target = realm.game.actors.get("integral-orc");
    if (!wizard || !target) throw new Error("Integral scene actors not hydrated");
    const index = async (id: string) => {
      const pack = realm.game.packs.get(id);
      if (!pack) throw new Error(`Shared pack missing: ${id}`);
      return pack.getIndex();
    };
    const acrobatics = () => {
      const skill = wizard.system.skills.acr;
      if (!skill) throw new Error("Acrobatics skill missing");
      return skill.mod;
    };
    const failures: string[] = [];
    const steps: Record<string, unknown> = {};
    const step = async (name: string, run: () => Promise<unknown>) => {
      try { steps[name] = await run(); } catch (e) { failures.push(`${name}: ${String((e as Error).stack ?? e)}`); }
    };
    await step("derived", async () => ({ int: wizard.system.abilities.int, acrobatics: wizard.system.skills.acr, hp: target.system.attributes.hp, changes: wizard.changes, baseRoll: realm.RollPF.safeRollSync("@abilities.int.value", wizard.getRollData()).total }));
    await step("sheet", async () => { await wizard.sheet.render({ force: true }); return true; });
    await step("content", async () => {
      const entries = await index("pf-content.pf-feats");
      const row = entries.find((i) => i.name === "Acrobatic");
      if (!row) throw new Error("Acrobatic missing from shared catalogue");
      const doc = await realm.fromUuid(`Compendium.pf-content.pf-feats.Item.${row._id}`);
      if (!doc) throw new Error("Acrobatic UUID unresolved");
      const before = acrobatics();
      const [created] = await wizard.createEmbeddedDocuments("Item", [doc.toObject()]);
      if (!created) throw new Error("Acrobatic import returned no item");
      const after = acrobatics();
      await wizard.deleteEmbeddedDocuments("Item", [created.id]);
      return { before, after, restored: acrobatics() };
    });
    await step("archetype", async () => {
      const rows = await index("pf1e-archetypes.pf-archetypes");
      const row = rows.find((i) => /^Wizard \(/.test(i.name));
      if (!row) throw new Error("Wizard archetype missing");
      const doc = await realm.fromUuid(`Compendium.pf1e-archetypes.pf-archetypes.Item.${row._id}`);
      if (!doc) throw new Error("Archetype UUID unresolved");
      return { name: doc.name, type: doc.type, uuid: doc.uuid };
    });
    await step("statblock", async () => {
      const rows = await index("statblock-library.sb-bestiaries1-3");
      const row = rows.find((i) => i.name === "Orc (warrior 1)");
      if (!row) throw new Error("Orc statblock missing");
      const doc = await realm.fromUuid(`Compendium.statblock-library.sb-bestiaries1-3.JournalEntry.${row._id}`);
      if (!doc) throw new Error("Statblock UUID unresolved");
      return { name: doc.name, uuid: doc.uuid };
    });
    const fireball = [...wizard.items.values()].find((i) => i.name === "Fireball");
    if (!fireball) throw new Error("Upstream Fireball missing");
    await step("damageRoll", async () => {
      const [roll] = await fireball.defaultAction.rollDamage({ shared: { baseline: { enhancement: 0 }, conditionalPartsCommon: {} } });
      if (!roll) throw new Error("No damage roll produced");
      if (roll.err) throw new Error(String(roll.err));
      return { formula: roll.formula, total: roll.total, cl: fireball.system.casterLevel, dc: fireball.defaultAction.getDC() };
    });
    await step("cast", async () => {
      const before = fireball.system.preparation.value;
      const result = await fireball.use({ skipDialog: true, options: { measureTemplate: false } });
      const stored = await realm.AIS.documents.get({ collection: "actors", id: wizard.id });
      const use = result as { shared: { chatAttacks: { damageRows: { normal: Roll | null }[] }[]; message: { id: string } } };
      const damage = use.shared.chatAttacks.flatMap(attack => attack.damageRows).reduce((sum, row) => sum + (row.normal?.total ?? 0), 0);
      const message = await realm.AIS.documents.get({ collection: "messages", id: use.shared.message.id });
      return { before, after: fireball.system.preparation.value, persisted: stored.items.find((i) => i.name === "Fireball")?.system.preparation.value, returned: result != null, damage, chatPersisted: /Fireball/i.test(message.content ?? "") };
    });
    await step("damageAndRestore", async () => {
      const before = target.system.attributes.hp.value;
      const amount = (steps.cast as { damage: number }).damage;
      if (!Number.isFinite(amount) || amount < 5 || amount > 30) throw new Error("Invalid Fireball cast damage");
      await target.applyDamage(amount);
      const after = (await realm.AIS.documents.get({ collection: "actors", id: target.id })).system.attributes.hp.value;
      await target.applyDamage(-amount);
      const restored = (await realm.AIS.documents.get({ collection: "actors", id: target.id })).system.attributes.hp.value;
      return { before, after, restored, amount };
    });
    steps.hostTargetHP = (await realm.AIS.documents.get({ collection: "actors", id: target.id })).system.attributes.hp;
    return { steps, failures, diagnostics: realm.FoundryAdapter.info() };
  });
  console.log("Integral real PF1:", JSON.stringify(report));
  await test.info().attach("integral-real-pf1", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  expect(report.failures).toEqual([]);
  expect(report.diagnostics.hookErrors).toEqual([]);
  expect(report.diagnostics.documents.hookErrors).toEqual([]);
  expect(report.steps.derived).toMatchObject({ int: { value: 15, total: 17, mod: 3 } });
  const content = report.steps.content as { before: number; after: number; restored: number };
  expect(content.after).toBe(content.before + 2);
  expect(content.restored).toBe(content.before);
  expect(report.steps.damageRoll).toMatchObject({ cl: 5, dc: 16 });
  const damage = report.steps.damageRoll as { total: number };
  expect(damage.total).toBeGreaterThanOrEqual(5);
  expect(damage.total).toBeLessThanOrEqual(30);
  expect(report.steps.cast).toMatchObject({ before: 1, after: 0, persisted: 0, returned: true, chatPersisted: true });
  const hp = report.steps.damageAndRestore as { before: number; after: number; restored: number; amount: number };
  expect(hp.after).toBe(hp.before - hp.amount);
  expect(hp.restored).toBe(hp.before);
  await expect(page.frameLocator('iframe[title="AIS module:pf1"]').locator(".application").filter({ hasText: "Valtiel" })).toBeVisible();
  // Undo/redo the actual AIS healing transaction, not a second inverse API call.
  const readHP = () => page.frameLocator('iframe[title="AIS module:pf1"]').locator("body").evaluate(() => {
    const realm = globalThis as unknown as { game: { actors: Map<string, { system: { attributes: { hp: { value: number } } } }> } };
    return realm.game.actors.get("integral-orc")?.system.attributes.hp.value;
  });
  await page.locator("[data-settings-undo]").click();
  await expect.poll(readHP).toBe(hp.after);
  await page.locator("[data-settings-redo]").click();
  await expect.poll(readHP).toBe(hp.before);

  await page.reload();
  await expect.poll(() => page.frameLocator('iframe[title="AIS module:pf1"]').locator("body").evaluate(() => {
    const realm = globalThis as unknown as { FoundryAdapter?: { info(): { ready: boolean } } };
    return realm.FoundryAdapter?.info().ready ?? false;
  }), { timeout: 120000 }).toBe(true);
  const reloaded = await page.frameLocator('iframe[title="AIS module:pf1"]').locator("body").evaluate(() => {
    const realm = globalThis as unknown as {
      game: { actors: Map<string, { system: { attributes: { hp: { value: number } } }; items: { contents: { name: string; system: { preparation: { value: number } } }[] } }> };
      FoundryAdapter: { info(): { hookErrors: unknown[]; documents: { hookErrors: unknown[] } } };
    };
    return { hp: realm.game.actors.get("integral-orc")?.system.attributes.hp.value,
      prepared: realm.game.actors.get("integral-wizard")?.items.contents.find(item => item.name === "Fireball")?.system.preparation.value,
      diagnostics: realm.FoundryAdapter.info() };
  });
  expect(reloaded.hp).toBe(hp.before);
  expect(reloaded.prepared).toBe(0);
  expect(reloaded.diagnostics.hookErrors).toEqual([]);
  expect(reloaded.diagnostics.documents.hookErrors).toEqual([]);
  await test.info().attach("integral-persistence-undo", { body: JSON.stringify({ undoHP: hp.after, redoHP: hp.before, reloaded }, null, 2), contentType: "application/json" });

});
