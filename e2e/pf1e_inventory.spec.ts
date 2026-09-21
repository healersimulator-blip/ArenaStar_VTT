/**
 * Plan §1.3 acceptance (G-03/G-04) — the inventory, items and encumbrance loop in a browser:
 * *"create an actor, import a weapon + a wand from a converted pack, equip, see AC/encumbrance/
 * speed change, make an attack from the item, cast the wand and watch a charge decrement and
 * persist across reload."*
 *
 * Every item document below is a **verbatim copy of the converted pack's row** (the `system`
 * block `tools/convert/mappers.mjs` writes from the pinned `pf1-system` / `pf1e-content`
 * checkouts), so the spec exercises the real converted shape without depending on
 * `dist/content/**` existing at test time:
 *
 * | Item | Source pack row |
 * | --- | --- |
 * | Longsword | `dist/content/pf1e/packs/weapons-ammo.json` → `longsword` |
 * | Chain Shirt | `dist/content/pf1e/packs/armor-shields.json` → `chain-shirt` |
 * | Cloak of Resistance +1 | `dist/content/pf1e/packs/wondrous.json` → `cloak-of-resistance-1` |
 * | Anvil | hand-written (`loot`, 50 lb, `carried: false`) |
 *
 * The wand is **generated in-app from the actor's prepared spell** rather than imported: there
 * is no spell-trigger wand in either vendored corpus to import. A scan of the 28 converted packs
 * finds **24,039 item documents and not one** carrying a spell block (`spell`, `spells`,
 * `spellName`, `spellLevel` or `storedSpell` anywhere under `system`); the only item whose *name*
 * promises a spell-trigger is `Wand of misery` (a 5 gp `loot` cane), and its closest magical
 * cousin `Icicle Wand` is a `consumable` with no spell at all — description only. §1.3's own
 * wording for this half is "consumables (potion/wand/scroll) **generated from a spell** with
 * charges", so generating it is the specified path.
 *
 * The numbers the spec asserts come from the rules modules, not from this file: capacity
 * (Table 7-4 → Str 10 = 33/66/100 lb), Table 7-5 (heavy load → max Dex +1, ACP −6, speed =
 * Table: Armor and Encumbrance for Other Base Speeds), and the AC components (10 + armor 4 +
 * min(Dex +2, max Dex)).
 */
import { expect, test } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";
import { strToU8, zipSync } from "fflate";

/** `weapons-ammo.json` → `longsword`, verbatim. */
const LONGSWORD_SYSTEM = {
  category: "weapon",
  weapon: {
    class: "melee",
    handedness: "one-handed",
    proficiency: "martial",
    damageDice: "1d8",
    damageType: "slashing",
    critThreatMin: 19,
    critMultiplier: 2,
  },
  value: 15,
  weight: 4,
  hardness: 10,
};

/** `armor-shields.json` → `chain-shirt`, verbatim (the mapper's slot/proficiency block). */
const CHAIN_SHIRT_SYSTEM = {
  category: "equipment",
  armor: { slot: "armor", proficiency: "light", armorBonus: 4, maxDexBonus: 4, checkPenalty: 2 },
  value: 100,
  weight: 25,
  hardness: 10,
};

/** `wondrous.json` → `cloak-of-resistance-1`, verbatim — the C1 `changes[]` shape. */
const CLOAK_SYSTEM = {
  category: "equipment",
  description:
    "<h2></b>Description</b></h2></p><p>Flecks of silver or steel are often sown amid the fabric of these magical cloaks. This garment offers magical protection in the form of a +1 to +5 resistance bonus on all saving throws (Fortitude, Reflex, and Will).<br><p><b>Base Item:</b> </p><h3><b>Requirements</b></h3><p>Craft Wondrous Item, resistance, creator's caster level must be at least three times the cloak's bonus</p><h3><b>Source: </b></h3>Ultimate Equipment",
  armor: { armorBonus: 0, maxDexBonus: 0, checkPenalty: 0 },
  uses: { per: null, value: 0, maxFormula: "", autoDeductChargesCost: "1" },
  value: 1000,
  weight: 1,
  hp: 10,
  hardness: 0,
  foundry: {
    changes: [
      {
        _id: "uyhcp1t4",
        formula: "+1",
        operator: "add",
        subTarget: "allSavingThrows",
        modifier: "resist",
        priority: 0,
        value: 1,
      },
    ],
    quantity: 1,
    aura: { custom: true, school: "abjuration" },
    cl: 5,
  },
};

/** Hand-written: 50 lb of loot, stowed in the wagon until the test carries it. */
const ANVIL_SYSTEM = { category: "loot", value: 5, weight: 50, hardness: 10, carried: false };

const HERO_SYSTEM = {
  pf1e: {
    abilities: { str: 10, dex: 14, con: 10, int: 10, wis: 10, cha: 10 },
    baseAttack: 1,
    hp: 10,
    hpMax: 10,
    landSpeedFt: 30,
    // A prepared 1st-level spell, so the Items tab can generate a wand from it. The actor
    // authors *no* spell slots and no caster level: casting from an item must not need any
    // (that is what a wand is for — its own caster level and its own save DC). The spell is
    // *bless* — no save and no damage — because the cast pipeline's damage grammar is bare
    // `NdM` (`pf1eCastFlow.ts` `DAMAGE_FORMULA`), so a formula like magic missile's `1d4+1`
    // is refused before any charge is spent. That is a pre-existing limit of the cast flow,
    // not of the item path this spec covers: the charge spend, the card and the persistence
    // are identical either way.
    spells: {
      mode: "prepared",
      prepared: [{ name: "Bless", level: 1 }],
    },
  },
};

const HERO_NAME = "Inventory Hero";

const ITEM_PACK_ENTRIES = [
  { id: "item-longsword", name: "Longsword", system: LONGSWORD_SYSTEM },
  { id: "item-chain-shirt", name: "Chain Shirt", system: CHAIN_SHIRT_SYSTEM },
  { id: "item-cloak", name: "Cloak of Resistance +1", system: CLOAK_SYSTEM },
  { id: "item-anvil", name: "Anvil", system: ANVIL_SYSTEM },
].map((e) => ({
  id: e.id,
  name: e.name,
  data: { type: "item", name: e.name, system: e.system, effects: [] },
}));

test("§1.3 acceptance — import, equip, load, attack from the item, cast from the wand, reload", async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  // ── a package holding one actor pack and one converted-shape item pack ──────────────────
  const manifest = {
    id: "e2e-inventory-pack",
    name: "E2E Inventory Pack",
    version: "1.0.0",
    description: "Converted-shape items for the §1.3 acceptance flow",
    type: "data",
    packs: [
      { name: "heroes", type: "actors", file: "packs/heroes.json" },
      { name: "gear", type: "items", file: "packs/gear.json" },
    ],
  };
  const heroes = {
    name: "heroes",
    type: "actors",
    entries: [
      {
        id: "actor-inventory-hero",
        name: HERO_NAME,
        data: {
          type: "actor",
          name: HERO_NAME,
          system: HERO_SYSTEM,
          items: [],
          effects: [],
        },
      },
    ],
  };
  const gear = { name: "gear", type: "items", entries: ITEM_PACK_ENTRIES };
  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "packs/heroes.json": strToU8(JSON.stringify(heroes)),
    "packs/gear.json": strToU8(JSON.stringify(gear)),
  });

  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  expect(
    await surfaceCallArg<{ ok: boolean }>(page, "app", "importPackageZip", Array.from(zip)),
  ).toMatchObject({ ok: true });

  // ── create the actor and import the four converted items into the world ────────────────
  await page.click('[data-tab="compendia"]');
  await page.locator('[data-entry-id="actor-inventory-hero"] [data-entry-import]').click();
  for (const itemEntry of ITEM_PACK_ENTRIES) {
    await page.locator(`[data-entry-id="${itemEntry.id}"] [data-entry-import]`).click();
  }

  await page.click('[data-tab="actors"]');
  const heroRow = page.locator("#sheet-list .sheet-row").filter({ hasText: HERO_NAME });
  const actorId = await heroRow.getAttribute("data-doc-id");
  expect(actorId).toBeTruthy();
  await heroRow.click();
  await page.click("[data-open-pf1e-sheet]");
  const sheet = page.locator(".wm-window [data-pf1e-sheet]");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "items", exact: true }).click();
  const tab = sheet.locator("[data-pf1e-items]");
  await expect(tab).toBeVisible();

  // ── the imported items land on the actor, converted shape intact ───────────────────────
  for (const itemEntry of ITEM_PACK_ENTRIES) {
    const picker = tab.locator(`[data-pf1e-item-world]`).filter({ hasText: itemEntry.name });
    await expect(picker).toHaveCount(1);
    await picker.locator("[data-pf1e-item-add]").click();
  }
  await expect(tab.locator("[data-pf1e-item-count]")).toHaveText("4 item(s)");
  const lsRow = tab.locator('[data-pf1e-item-name="Longsword"]');
  const lsId = await lsRow.getAttribute("data-pf1e-item");
  expect(lsId).toBeTruthy();
  await expect(lsRow.locator("[data-pf1e-item-weight]")).toContainText("4 lb");
  await expect(lsRow.locator("[data-pf1e-item-price]")).toContainText("15 gp");
  await expect(tab.locator("[data-pf1e-item-armor]").first()).toContainText("armor +4");
  // Chain Shirt 25 + Longsword 4 + Cloak 1 = 30 lb; the stowed anvil contributes nothing.
  await expect(tab.locator("[data-pf1e-carried-weight]")).toHaveText("30 lb");
  await expect(tab.locator("[data-pf1e-load]")).toHaveAttribute("data-pf1e-load", "none");

  // ── equip the armor: AC = 10 + armor 4 + Dex 2; no spells, so saves are Dex alone ───────
  const shirtRow = tab.locator('[data-pf1e-item-name="Chain Shirt"]');
  await shirtRow.locator("[data-pf1e-item-equip]").click();
  await expect(shirtRow.locator("[data-pf1e-item-equip]")).toHaveText("Unequip");
  await sheet.getByRole("button", { name: "summary", exact: true }).click();
  await expect(sheet.locator("[data-pf1e-ac]")).toHaveText("16 / 12 / 14");
  await expect(sheet.locator("[data-pf1e-saves]")).toHaveText("0 / 2 / 0");
  await expect(sheet.locator("[data-pf1e-speed]")).toHaveText("30 ft");

  // ── equip the cloak: its converted `changes[]` (+1 resistance on all saves) derives ────
  await sheet.getByRole("button", { name: "items", exact: true }).click();
  const cloakRow = tab.locator('[data-pf1e-item-name="Cloak of Resistance +1"]');
  await cloakRow.locator("[data-pf1e-item-equip]").click();
  await sheet.getByRole("button", { name: "summary", exact: true }).click();
  await expect(sheet.locator("[data-pf1e-saves]")).toHaveText("1 / 3 / 1");
  // …and its all-zero Foundry `armor` block is *not* read as armor (no max-Dex cap on the AC).
  await expect(sheet.locator("[data-pf1e-ac]")).toHaveText("16 / 12 / 14");

  // The item window shows the mapping honestly: the change applied, and no armor properties.
  await sheet.getByRole("button", { name: "items", exact: true }).click();
  await cloakRow.locator("[data-pf1e-item-open]").click();
  const cloakWindow = page.locator(".wm-window [data-pf1e-item-window]");
  await expect(cloakWindow.locator("[data-pf1e-item-window-name]")).toHaveText(
    "Cloak of Resistance +1",
  );
  await expect(cloakWindow.locator("[data-pf1e-item-window-changes]")).toContainText("1 applied");
  await expect(
    cloakWindow.locator("[data-pf1e-item-window-change-target]").first(),
  ).toHaveText("saves");
  await expect(cloakWindow.locator('[data-pf1e-item-window-change="saves"]')).toContainText(
    "resistance +1",
  );
  // Closing through the window chrome (one `.wm-window` per open window).
  await page
    .locator(".wm-window")
    .filter({ has: page.locator("[data-pf1e-item-window]") })
    .locator("[data-window-close]")
    .click();

  // ── carry the anvil: 80 lb is a heavy load for Str 10 — speed 30 → 20 ft., max Dex +1 ───
  await sheet.getByRole("button", { name: "items", exact: true }).click();
  const anvilRow = tab.locator('[data-pf1e-item-name="Anvil"]');
  await anvilRow.locator("[data-pf1e-item-carry]").click();
  await expect(tab.locator("[data-pf1e-carried-weight]")).toHaveText("80 lb");
  await expect(tab.locator("[data-pf1e-load]")).toHaveAttribute("data-pf1e-load", "heavy");
  await expect(tab.locator("[data-pf1e-load-effect]")).toContainText("check penalty −6");
  await expect(tab.locator("[data-pf1e-load-effect]")).toContainText("speed 20 ft");
  await sheet.getByRole("button", { name: "summary", exact: true }).click();
  await expect(sheet.locator("[data-pf1e-speed]")).toHaveText("20 ft");
  // The load caps Dexterity at +1: normal AC 15, touch 11, flat-footed still 14 (armor only).
  await expect(sheet.locator("[data-pf1e-ac]")).toHaveText("15 / 11 / 14");

  // ── make an attack line out of the weapon item (writes the existing PF1eAttackEntry) ────
  await sheet.getByRole("button", { name: "items", exact: true }).click();
  await lsRow.locator("[data-pf1e-item-make-attack]").click();
  await expect(tab.locator("[data-pf1e-items-notice]")).toContainText(
    "attack line created for Longsword",
  );
  const system = await surfaceCallArg<{ attacks?: Array<Record<string, unknown>> } | null>(
    page,
    "app",
    "pf1eActorSystem",
    actorId as string,
  );
  const line = (system?.attacks ?? []).find((a) => a.itemId === lsId);
  expect(line).toBeDefined();
  expect(line).toMatchObject({
    name: "Longsword",
    ranged: false,
    damageDice: "1d8",
    critThreatMin: 19,
    critMultiplier: 2,
  });

  // ── generate a wand from the actor's prepared spell, then cast out of it ────────────────
  await tab.locator('[data-pf1e-make-consumable] select[aria-label="Spell"]').selectOption("Bless");
  await tab.locator('[data-pf1e-make-consumable] select[aria-label="Item kind"]').selectOption("wand");
  await tab.locator("[data-pf1e-make-consumable-apply]").click();
  const wandRow = tab.locator('[data-pf1e-item-name="Wand of Bless"]');
  await expect(wandRow).toHaveCount(1);
  await expect(wandRow.locator("[data-pf1e-item-uses]")).toContainText("50/50");

  await wandRow.locator("[data-pf1e-item-open]").click();
  const itemWindow = page.locator(".wm-window [data-pf1e-item-window]");
  await expect(itemWindow).toBeVisible();
  await expect(itemWindow.locator("[data-pf1e-item-window-name]")).toHaveText(
    "Wand of Bless",
  );
  await expect(itemWindow.locator("[data-pf1e-item-window-cast]")).toContainText(
    "caster level 5",
  );
  await expect(itemWindow.locator("[data-pf1e-item-window-cast]")).toContainText("save DC 11");
  await itemWindow.locator("[data-pf1e-item-window-target]").selectOption({ label: HERO_NAME });
  await itemWindow.locator("[data-pf1e-item-window-cast-apply]").click();
  await expect(itemWindow.locator("[data-pf1e-item-window-note]")).toContainText(
    "charge(s) left",
    { timeout: 20_000 },
  );
  await expect(itemWindow.locator("[data-pf1e-item-window-uses]")).toContainText("49");
  await page
    .locator(".wm-window")
    .filter({ has: page.locator("[data-pf1e-item-window]") })
    .locator("[data-window-close]")
    .click();

  // ── the spent charge (and the equipment state) are persisted, not just in memory ────────
  await page.reload();
  await waitForSurface(page, "app");
  await page.click('[data-tab="actors"]');
  await page.locator("#sheet-list .sheet-row").filter({ hasText: HERO_NAME }).click();
  await page.click("[data-open-pf1e-sheet]");
  const sheet2 = page.locator(".wm-window [data-pf1e-sheet]");
  await expect(sheet2).toBeVisible();
  await sheet2.getByRole("button", { name: "items", exact: true }).click();
  const tab2 = sheet2.locator("[data-pf1e-items]");
  const wandRow2 = tab2.locator('[data-pf1e-item-name="Wand of Bless"]');
  await expect(wandRow2.locator("[data-pf1e-item-uses]")).toContainText("49/50");
  await expect(tab2.locator("[data-pf1e-load]")).toHaveAttribute("data-pf1e-load", "heavy");
  await expect(tab2.locator("[data-pf1e-carried-weight]")).toHaveText("80 lb");
  await sheet2.getByRole("button", { name: "summary", exact: true }).click();
  await expect(sheet2.locator("[data-pf1e-ac]")).toHaveText("15 / 11 / 14");
  await expect(sheet2.locator("[data-pf1e-speed]")).toHaveText("20 ft");
  await expect(sheet2.locator("[data-pf1e-saves]")).toHaveText("1 / 3 / 1");

  expect(runtimeErrors).toEqual([]);
});
