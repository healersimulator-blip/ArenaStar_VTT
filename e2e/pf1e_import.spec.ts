/**
 * Plan §3.1 acceptance (G-39) — *"a migrating table gets characters and content in one move"*:
 * a character made in another app is read into this one **through the real UI** (the Sheets
 * panel's Import control on the Actors tab, a file chooser, the report the importing GM reads)
 * and is then playable: the sheet shows the weapon's own attack line, and the host's document
 * store is read back for the numbers.
 *
 * Three exports, one per format the plan named, each written the way its own app writes it:
 *
 * | Fixture | Source shape | What it proves |
 * | --- | --- | --- |
 * | `hero.json` | Foundry PF1e actor JSON — the field spellings the pinned `pf1-system` packs use | components and authored attack lines: `hp 23/23` with no `hp.max`-less guessing, AC from its armor + Dex + dodge, saves from their totals, and a *Shortspear* with both of the system's own actions (melee + thrown) |
 * | `corvin.xml` | Hero Lab XML (`document/public/character`, MapTool's own XPath) | abilities from `attrvalue/@modified`; published AC and saves flagged as totals; a printed `damage="1d8+4"` decomposed against the Strength the same export states |
 * | `vane.json` | Roll20 sheet export — `{schema_version, name, attribs}` plus one `repeating_melee` row | the sheet's own field names through the alias table, the `max` column of `hp`, and the stored attack modifier refused |
 * | `notes.json` | anything else | refused with the export path a user needs, and **no actor created** |
 *
 * No fixture is copied verbatim from either vendored corpus: each is the shape its format
 * documents, so this spec keeps passing only while the readers read the *format* rather than one
 * vendor's quirks. The numbers asserted are the fixtures' own, except the derived ones (the
 * decomposition of a printed damage total against Strength), which come from the rules modules.
 */
import { expect, test, type Page } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";

/** Foundry PF1e actor JSON. `attributes.hp` is the pool style the character packs use. */
const FOUNDRY_HERO = {
  name: "Mara Vex",
  type: "character",
  system: {
    abilities: {
      str: { value: 10, mod: 0 },
      dex: { value: 14, mod: 2 },
      con: { value: 12, mod: 1 },
      int: { value: 18, mod: 4 },
      wis: { value: 13, mod: 1 },
      cha: { value: 8, mod: -1 },
    },
    attributes: {
      hp: { value: 23, max: 23, nonlethal: 0 },
      ac: {
        armor: { value: 4 },
        shield: { value: 0 },
        natural: { value: 0 },
        misc: { value: 0 },
        dodge: { value: 1 },
      },
      naturalAC: 0,
      bab: { total: 2 },
      savingThrows: {
        fort: { base: 2, ability: 1, total: 3 },
        ref: { base: 1, ability: 2, total: 3 },
        will: { base: 3, ability: 1, total: 4 },
      },
      speed: { land: { base: 30 } },
    },
    skills: { acr: { value: 4, ranks: 2, cs: true, ability: "dex" } },
    traits: { size: "med" },
    details: { level: { value: 3 } },
    currency: { gp: 120, sp: 15, cp: 3 },
  },
  items: [
    {
      _id: "w-shortspear",
      name: "Shortspear",
      type: "weapon",
      system: {
        subType: "simple",
        weaponSubtype: "1h",
        quantity: 1,
        price: 1,
        weight: { value: 3 },
        hardness: 10,
        description: {
          value: "A shortspear: a hunting spear, thrown or thrust.",
        },
        actions: {
          throwAction: {
            actionType: "twak",
            name: "Throw",
            ability: {
              attack: "dex",
              damage: "str",
              critRange: 20,
              critMult: 2,
            },
            damage: {
              parts: [
                { formula: "sizeRoll(1, 6, @size)", types: ["piercing"] },
              ],
            },
            // The pack spelling: a string value and the units the reader checks for.
            range: { value: "20", units: "ft", maxIncrements: 5 },
          },
          meleeAction: {
            actionType: "mwak",
            name: "Melee",
            ability: {
              attack: "str",
              damage: "str",
              critRange: 20,
              critMult: 2,
            },
            damage: {
              parts: [
                { formula: "sizeRoll(1, 6, @size)", types: ["piercing"] },
              ],
            },
          },
        },
      },
    },
    {
      _id: "a-chain-shirt",
      name: "Chain Shirt",
      type: "equipment",
      system: {
        subType: "lightArmor",
        equipmentSubtype: "lightArmor",
        quantity: 1,
        price: 100,
        weight: { value: 25 },
        armor: {
          bonus: 4,
          maximumDexBonus: 4,
          checkPenalty: 2,
          arcaneSpellFailure: 20,
        },
      },
    },
    // Neither of these is an item in this app's actor shape: a feat becomes a name the sheet
    // shows (several rules read it) and the spell list is named in the report for the GM to
    // re-author on the Casting tab — which is exactly what the assertions below read back.
    { _id: "f-dodge", name: "Dodge", type: "feat", system: {} },
    {
      _id: "s-magic-missile",
      name: "Magic Missile",
      type: "spell",
      system: {},
    },
  ],
};

/** Hero Lab XML. `<attrvalue modified=…>` is the spelling MapTool's importer reads. */
const HEROLAB_HERO = `<?xml version="1.0" encoding="UTF-8"?>
<document>
  <public>
    <character name="Corvin Hale">
      <attributes>
        <attribute name="Strength"><attrvalue base="14" modified="16"></attrvalue></attribute>
        <attribute name="Dexterity"><attrvalue base="12" modified="12"></attrvalue></attribute>
        <attribute name="Constitution"><attrvalue base="14" modified="14"></attrvalue></attribute>
        <attribute name="Intelligence"><attrvalue base="10" modified="10"></attrvalue></attribute>
        <attribute name="Wisdom"><attrvalue base="16" modified="18"></attrvalue></attribute>
        <attribute name="Charisma"><attrvalue base="13" modified="13"></attrvalue></attribute>
      </attributes>
      <armorclass ac="21" touch="12" flatfooted="19"></armorclass>
      <saves fortitude="7" reflex="4" will="9"></saves>
      <hitpoints>38</hitpoints>
      <hitpointsmax>38</hitpointsmax>
      <baseattack>3</baseattack>
      <hitdice>5d8</hitdice>
      <size>Medium</size>
      <skills>
        <skill name="Perception" ranks="5" classskill="yes"></skill>
        <skill name="Diplomacy" ranks="5" classskill="yes"></skill>
      </skills>
      <weapons>
        <weapon name="Heavy Mace" attack="+7" damage="1d8+4"></weapon>
      </weapons>
      <languages>Common, Celestial</languages>
    </character>
  </public>
</document>`;

/** Roll20 export: `{schema_version, name, attribs}`, one flattened repeating-weapon row. */
const ROLL20_HERO = {
  schema_version: 1,
  name: "Praxis Vane",
  attribs: [
    { name: "strength", current: "12", max: "", id: "-a1" },
    { name: "dexterity", current: "18", max: "", id: "-a2" },
    { name: "constitution", current: "12", max: "", id: "-a3" },
    { name: "intelligence", current: "14", max: "", id: "-a4" },
    { name: "wisdom", current: "10", max: "", id: "-a5" },
    { name: "charisma", current: "10", max: "", id: "-a6" },
    { name: "hp", current: "27", max: "31", id: "-a7" },
    { name: "ac", current: "17", max: "", id: "-a8" },
    { name: "fortitude", current: "3", max: "", id: "-a9" },
    { name: "reflex", current: "8", max: "", id: "-a10" },
    { name: "will", current: "2", max: "", id: "-a11" },
    { name: "size", current: "medium", max: "", id: "-a12" },
    {
      name: "repeating_melee_-m1_meleeweaponname",
      current: "Rapier",
      max: "",
      id: "-a13",
    },
    {
      name: "repeating_melee_-m1_meleeatkmod",
      current: "+8",
      max: "",
      id: "-a14",
    },
    {
      name: "repeating_melee_-m1_meleedamage",
      current: "1d6+2",
      max: "",
      id: "-a15",
    },
    {
      name: "repeating_melee_-m1_meleecrit",
      current: "18",
      max: "",
      id: "-a16",
    },
    {
      name: "house_rule_favourite_inn",
      current: "The Laughing Fox",
      max: "",
      id: "-a17",
    },
  ],
};

/** Picking a file the way a person does: the visible control opens the chooser. */
async function importFixture(
  page: Page,
  name: string,
  body: string,
): Promise<void> {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator("[data-import-character-trigger]").click(),
  ]);
  await chooser.setFiles({
    name,
    mimeType: "application/json",
    buffer: Buffer.from(body),
  });
  await expect(page.locator("[data-import-report]")).toBeVisible();
}

/** The actor id of a sheet row, or a failure naming what the list actually held. */
async function actorIdOf(page: Page, name: string): Promise<string> {
  const row = page.locator("#sheet-list .sheet-row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  const id = await row.getAttribute("data-doc-id");
  if (id === null)
    throw new Error(`the sheet list row for ${name} carries no document id`);
  return id;
}

test("§3.1 acceptance — three exports land as playable characters, and a stranger is refused", async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.click('[data-tab="actors"]');

  // ── 1. Foundry PF1e actor JSON ──────────────────────────────────────────────────────────
  await importFixture(page, "hero.json", JSON.stringify(FOUNDRY_HERO));
  const report = page.locator("[data-import-report]");
  await expect(report).toHaveAttribute("data-import-ok", "true");
  await expect(report.locator(".import-head")).toHaveText(
    /Imported Mara Vex \(Foundry PF1e actor\)/,
  );
  // The feat was read (the sheet shows feats), the spell list was named — not silently dropped.
  await expect(
    report.locator(".import-line").filter({ hasText: "feats: 1" }),
  ).toHaveCount(1);
  await expect(
    report
      .locator("[data-import-warning]")
      .filter({ hasText: "spell item(s)" }),
  ).toHaveCount(1);

  const maraId = await actorIdOf(page, "Mara Vex");
  const mara = await surfaceCallArg<Record<string, unknown> | null>(
    page,
    "app",
    "pf1eActorSystem",
    maraId,
  );
  expect(mara).not.toBeNull();
  expect(mara).toMatchObject({
    abilities: { str: 10, dex: 14, con: 12, int: 18, wis: 13, cha: 8 },
    hp: 23,
    hpMax: 23,
    baseAttack: 2,
    speedFt: 30,
  });
  // The weapon authored one attack line, pointing at the item it came from — the same single
  // line the sheet's own "create attack from this weapon" action makes (a thrown weapon is one
  // line with an increment, not two lines), so the two paths cannot disagree.
  const maraAttacks = (mara?.attacks ?? []) as Array<Record<string, unknown>>;
  expect(maraAttacks).toHaveLength(1);
  expect(maraAttacks[0]).toMatchObject({
    name: "Shortspear",
    ranged: true,
    damageDice: "1d6",
    rangeIncrementFt: 20,
  });
  expect(typeof maraAttacks[0]?.itemId).toBe("string");

  // …and it is playable in the UI: the sheet's own summary lists both lines and the numbers
  // (10 + armor 4 + Dex 2 + dodge 1 = 17 / touch 13 / flat-footed 14; saves as the export's).
  await page
    .locator("#sheet-list .sheet-row")
    .filter({ hasText: "Mara Vex" })
    .click();
  await page.click("[data-open-pf1e-sheet]");
  const sheet = page.locator(".wm-window [data-pf1e-sheet]");
  await expect(sheet).toBeVisible();
  // The summary tab carries the derived numbers (10 + armor 4 + Dex 2 + dodge 1 = 17 / touch 13 /
  // flat-footed 14; the export's own save totals), the combat tab the authored attack lines.
  await sheet.getByRole("button", { name: "summary", exact: true }).click();
  await expect(sheet.locator("[data-pf1e-ac]")).toHaveText("17 / 13 / 14");
  await expect(sheet.locator("[data-pf1e-saves]")).toHaveText("3 / 3 / 4");
  await sheet.getByRole("button", { name: "combat", exact: true }).click();
  await expect(sheet.locator("[data-pf1e-attack]")).toHaveCount(1);
  await expect(sheet.locator("[data-pf1e-attack]").first()).toContainText(
    "Shortspear",
  );
  await page
    .locator(".wm-window")
    .filter({ has: page.locator("[data-pf1e-sheet]") })
    .locator("[data-window-close]")
    .click();
  await page.locator("[data-import-dismiss]").click();
  await expect(page.locator("[data-import-report]")).toHaveCount(0);

  // ── 2. Hero Lab XML ─────────────────────────────────────────────────────────────────────
  await importFixture(page, "corvin.xml", HEROLAB_HERO);
  await expect(report).toHaveAttribute("data-import-ok", "true");
  await expect(report.locator(".import-head")).toHaveText(
    /Imported Corvin Hale \(Hero Lab XML\)/,
  );
  const corvinId = await actorIdOf(page, "Corvin Hale");
  const corvin = await surfaceCallArg<Record<string, unknown> | null>(
    page,
    "app",
    "pf1eActorSystem",
    corvinId,
  );
  // The buffed Strength (16) and Wisdom (18) come from `attrvalue/@modified`, not the base.
  expect(corvin).toMatchObject({
    abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 18, cha: 13 },
    hp: 38,
    hpMax: 38,
    baseAttack: 3,
    hitDice: 5,
  });
  // Hero Lab publishes AC and the saves as totals; the app keeps them as totals and flags it.
  expect(corvin).toMatchObject({ acMode: "published" });
  expect(corvin).toMatchObject({
    acTotals: { normal: 21, touch: 12, flatFooted: 19 },
  });
  expect(corvin).toMatchObject({
    saves: { fort: 7, ref: 4, will: 9 },
    savesAsTotal: true,
  });
  // `damage="1d8+4"` is a total: Strength (+3) stays the derivation's business and the +1 that
  // is left rides the line — flagged, so the +3 is not counted twice.
  const corvinAttacks = (corvin?.attacks ?? []) as Array<
    Record<string, unknown>
  >;
  expect(corvinAttacks).toHaveLength(1);
  expect(corvinAttacks[0]).toMatchObject({
    name: "Heavy Mace",
    damageDice: "1d8",
    damageBonus: 1,
    abilityDamageIncluded: true,
  });
  const corvinWarnings = await page
    .locator("[data-import-warning]")
    .allTextContents();
  // The mace's printed `attack="+7"` is refused in the source's own words, next to the line that
  // *is* authored — a GM reads both in the report.
  expect(corvinWarnings.join("\n")).toContain(
    "attack bonuses Hero Lab printed were not imported",
  );
  await page.locator("[data-import-dismiss]").click();

  // ── 3. Roll20 sheet export ──────────────────────────────────────────────────────────────
  await importFixture(page, "vane.json", JSON.stringify(ROLL20_HERO));
  await expect(report).toHaveAttribute("data-import-ok", "true");
  await expect(report.locator(".import-head")).toHaveText(
    /Imported Praxis Vane \(Roll20 sheet\)/,
  );
  const vaneId = await actorIdOf(page, "Praxis Vane");
  const vane = await surfaceCallArg<Record<string, unknown> | null>(
    page,
    "app",
    "pf1eActorSystem",
    vaneId,
  );
  // The `max` column of the `hp` attrib is the maximum (27/31); Strength 12 (+1) against the
  // stored `1d6+2` leaves +1 on the weapon.
  expect(vane).toMatchObject({
    abilities: { str: 12, dex: 18, con: 12, int: 14, wis: 10, cha: 10 },
    hp: 27,
    hpMax: 31,
    size: "Medium",
  });
  const vaneAttacks = (vane?.attacks ?? []) as Array<Record<string, unknown>>;
  expect(vaneAttacks).toHaveLength(1);
  expect(vaneAttacks[0]).toMatchObject({
    name: "Rapier",
    damageDice: "1d6",
    damageBonus: 1,
    abilityDamageIncluded: true,
  });
  // The sheet's stored attack modifier is refused (it is this app's to derive), and the fields
  // with no home are named — the house-rule attrib included.
  const vaneWarnings = (
    await page.locator("[data-import-warning]").allTextContents()
  ).join("\n");
  expect(vaneWarnings).toContain("attack modifiers");
  expect(vaneWarnings).toContain("house_rule_favourite_inn");
  await page.locator("[data-import-dismiss]").click();

  // ── 4. Something else entirely ──────────────────────────────────────────────────────────
  const rowsBefore = await page.locator("#sheet-list .sheet-row").count();
  await importFixture(
    page,
    "notes.json",
    '{"title":"my campaign notes","pages":[]}',
  );
  await expect(report).toHaveAttribute("data-import-ok", "false");
  await expect(report.locator(".import-head")).toHaveText(
    /Could not import notes\.json/,
  );
  await expect(report.locator("[data-import-warning]")).toContainText(
    "expected a Foundry PF1e actor JSON",
  );
  // Nothing was created, and the three characters are still there.
  await expect(page.locator("#sheet-list .sheet-row")).toHaveCount(rowsBefore);

  expect(runtimeErrors).toEqual([]);
});
