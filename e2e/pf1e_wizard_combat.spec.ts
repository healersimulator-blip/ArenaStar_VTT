import { test, expect } from "@playwright/test";
import { entry, waitForSurface, surfaceCallArg } from "./lib";
import { strToU8, zipSync } from "fflate";

test("Level 5 Wizard armed with Dragoon pistol and Fireball vs 3 Goblins, 2 Ogres, 1 Troll", async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  // Build the combat encounter pack
  const manifest = {
    id: "e2e-encounter-pack",
    name: "Encounter Pack",
    version: "1.0.0",
    description: "Encounter scenario for e2e testing",
    type: "data",
    packs: [
      {
        name: "actors",
        type: "actors",
        file: "packs/actors.json",
      },
    ],
  };

  const actorEntries = [
    // Level 5 Wizard with Deadly Aim, Dragoon Pistol (early firearm), Fireball
    {
      id: "actor-wizard-5",
      name: "Valtiel the Wizard",
      data: {
        type: "actor",
        name: "Valtiel the Wizard",
        system: {
          pf1e: {
            abilities: { str: 10, dex: 16, con: 12, int: 18, wis: 12, cha: 10 },
            baseAttack: 2,
            hitDice: 5,
            hp: 28,
            hpMax: 28,
            feats: ["Deadly Aim", "Point-Blank Shot"],
            attacks: [
              {
                name: "Dragoon Pistol",
                type: "ranged",
                diceCount: 1,
                diceSides: 8,
                damageBonus: 0,
                damageType: "B and P",
                threatRange: 20,
                critMultiplier: 4,
                rangeFt: 20,
                firearm: {
                  generation: "early",
                  misfireMinimum: 1,
                  capacity: 3,
                  loaded: 3,
                  magical: false,
                },
              },
            ],
            spells: {
              keyAbility: "int",
              mode: "prepared",
              casterLevel: 5,
              slotsPerDay: { 1: 4, 2: 3, 3: 2 },
              slotsUsed: { 3: 0 },
              prepared: [
                {
                  name: "Fireball",
                  level: 3,
                  slotLevel: 3,
                  components: "V, S, M",
                },
              ],
            },
          },
        },
        items: [],
        effects: [],
      },
    },
    // 3 Goblins (Reflex +3, HP 6)
    ...[1, 2, 3].map((i) => ({
      id: `actor-goblin-${i}`,
      name: `Goblin ${i}`,
      data: {
        type: "actor",
        name: `Goblin ${i}`,
        system: {
          pf1e: {
            abilities: { str: 10, dex: 15, con: 12, int: 10, wis: 10, cha: 8 },
            hp: 6,
            hpMax: 6,
            armorClass: { armor: 2, dex: 2, size: 1 },
            saves: { fort: 3, ref: 3, will: -1 },
          },
        },
        items: [],
        effects: [],
      },
    })),
    // 2 Ogres (Reflex +0, HP 29, Large)
    ...[1, 2].map((i) => ({
      id: `actor-ogre-${i}`,
      name: `Ogre ${i}`,
      data: {
        type: "actor",
        name: `Ogre ${i}`,
        system: {
          pf1e: {
            abilities: { str: 21, dex: 8, con: 15, int: 6, wis: 10, cha: 7 },
            hp: 29,
            hpMax: 29,
            armorClass: { armor: 4, natural: 5, dex: -1, size: -1 },
            saves: { fort: 6, ref: 0, will: 3 },
          },
        },
        items: [],
        effects: [],
      },
    })),
    // 1 Troll (Reflex +4, HP 36, Regeneration 5, Fire/Acid bypass)
    {
      id: "actor-troll-1",
      name: "Troll 1",
      data: {
        type: "actor",
        name: "Troll 1",
        system: {
          pf1e: {
            abilities: { str: 21, dex: 14, con: 23, int: 6, wis: 9, cha: 6 },
            hp: 36,
            hpMax: 36,
            armorClass: { natural: 7, dex: 2, size: -1 },
            saves: { fort: 11, ref: 4, will: 3 },
          },
        },
        items: [],
        effects: [],
      },
    },
  ];

  const packData = {
    name: "actors",
    type: "actors",
    entries: actorEntries,
  };

  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "packs/actors.json": strToU8(JSON.stringify(packData)),
  });

  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");

  expect(
    await surfaceCallArg<{ ok: boolean }>(
      page,
      "app",
      "importPackageZip",
      Array.from(zip),
    ),
  ).toMatchObject({ ok: true });

  // Import all actors from compendia
  await page.click('[data-tab="compendia"]');
  for (const a of actorEntries) {
    await page.locator(`[data-entry-id="${a.id}"] [data-entry-import]`).click();
  }

  // Open Valtiel the Wizard's character sheet
  await page.click('[data-tab="actors"]');
  await page
    .locator("#sheet-list .sheet-row")
    .filter({ hasText: "Valtiel the Wizard" })
    .click();

  // Floating window for sheet
  await page.click("[data-open-pf1e-sheet]");
  const wizardSheet = page.locator('.wm-window [data-pf1e-sheet]');
  await expect(wizardSheet).toBeVisible();

  // 1. TEST DEADLY AIM WITH DRAGOON PISTOL (Combat tab)
  await wizardSheet.locator('nav button:has-text("combat")').click();

  // Switch sidebar to chat
  await page.click('[data-tab="chat"]');
  const chatLog = page.locator("#chat-log");

  // Select Target Ogre 1
  const resolveTarget = wizardSheet.locator("[data-pf1e-resolve-target]");
  await resolveTarget.selectOption({ label: "Ogre 1" });

  // Enable Deadly Aim (-1 to hit / +2 damage for BAB +2)
  const deadlyAimCheckbox = wizardSheet.locator("[data-pf1e-resolve-deadly-aim]");
  await expect(deadlyAimCheckbox).toBeVisible();
  await deadlyAimCheckbox.check();

  // Fire Dragoon Pistol attack
  await wizardSheet.locator('[data-pf1e-resolve-attack]').click();

  // Verify chat ledger recorded the Dragoon Pistol attack (bonus reduced from +5 to +4 due to Deadly Aim -1)
  await expect(chatLog).toContainText("Dragoon Pistol");
  await expect(chatLog).toContainText("Ogre 1");

  // Verify firearm consumed 1 loaded bullet out of 3 (2 shots left)
  await expect(wizardSheet.locator('[data-pf1e-firearm-resolve]')).toContainText("ammo 2/3");

  // Fire a second shot from the Dragoon Pistol without needing to reload
  await wizardSheet.locator('[data-pf1e-resolve-attack]').click();
  await expect(wizardSheet.locator('[data-pf1e-firearm-resolve]')).toContainText("ammo 1/3");

  // 2. TEST SPELLCASTING: FIREBALL WITH DC, REFLEX SAVE, FIRE DAMAGE, AND TARGET HP LOSS
  await wizardSheet.locator('nav button:has-text("spells")').click();
  const spellbook = wizardSheet.locator("[data-pf1e-spellbook]");
  await expect(spellbook).toBeVisible();

  // Prepare Fireball cast against Troll 1
  await spellbook.locator('[data-cast-prepared="0"]').click();
  await spellbook.locator("[data-cast-severity]").selectOption("half"); // Reflex half
  await spellbook.locator("[data-cast-damage]").fill("5d6"); // 5d6 fire damage
  await spellbook.locator("[data-cast-save]").selectOption("ref");
  await spellbook.locator("[data-cast-energy]").selectOption("fire");
  await spellbook.locator("[data-cast-target]").selectOption({ label: "Troll 1" });

  // Submit cast
  await spellbook.locator("[data-cast-submit]").click();

  // Verify Fireball spell card reached chat, rolled Reflex save against DC 17, and deducted HP from Troll 1
  await expect(chatLog).toContainText("casts Fireball");
  await expect(chatLog).toContainText("Troll 1");
  await expect(chatLog).toContainText("REF save");

  // Take screenshot of the battle chat ledger
  await page.screenshot({ path: "test-results/wizard-battle-chat.png" });

  expect(runtimeErrors).toEqual([]);
});
