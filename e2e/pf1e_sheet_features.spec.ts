import { test, expect } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";
import { strToU8, zipSync } from "fflate";

test("PF1e character sheet: Skills tab, Character Builder, and Compendium Picker are functional and usable", async ({
  page,
}) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  const manifest = {
    id: "e2e-pf1e-pack",
    name: "E2E PF1e Pack",
    version: "1.0.0",
    description: "Compendium pack for e2e testing",
    type: "data",
    packs: [
      {
        name: "heroes",
        type: "actors",
        file: "packs/heroes.json",
      },
      {
        name: "feats",
        type: "items",
        file: "packs/feats.json",
      },
      {
        name: "spells",
        type: "items",
        file: "packs/spells.json",
      },
    ],
  };

  const featPack = {
    name: "feats",
    type: "items",
    entries: [
      {
        id: "feat-power-attack",
        name: "Power Attack",
        data: {
          type: "item",
          name: "Power Attack",
          system: {
            pf1e: {
              category: "feat",
              summary: "Trade melee attack bonus for damage.",
            },
          },
        },
      },
      {
        id: "feat-cleave",
        name: "Cleave",
        data: {
          type: "item",
          name: "Cleave",
          system: {
            pf1e: {
              category: "feat",
              summary: "Make an extra attack when you fell a foe.",
            },
          },
        },
      },
    ],
  };

  const spellPack = {
    name: "spells",
    type: "items",
    entries: [
      {
        id: "spell-magic-missile",
        name: "Magic Missile",
        data: {
          type: "item",
          name: "Magic Missile",
          system: {
            pf1e: {
              category: "spell",
              school: "evocation",
              level: 1,
              summary: "Fires unerring darts of magical energy.",
            },
          },
        },
      },
    ],
  };

  const heroPack = {
    name: "heroes",
    type: "actors",
    entries: [
      {
        id: "actor-valeros",
        name: "Valeros",
        data: {
          type: "actor",
          name: "Valeros",
          system: {
            pf1e: {
              abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
              hp: 12,
              hpMax: 12,
              skills: {
                perception: { ranks: 1, classSkill: true },
                climb: { ranks: 2, classSkill: true },
                stealth: { ranks: 0, classSkill: false },
              },
            },
          },
          items: [],
          effects: [],
        },
      },
    ],
  };

  const zip = zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "packs/feats.json": strToU8(JSON.stringify(featPack)),
    "packs/spells.json": strToU8(JSON.stringify(spellPack)),
    "packs/heroes.json": strToU8(JSON.stringify(heroPack)),
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

  // Import actor from compendium
  await page.click('[data-tab="compendia"]');
  await page.locator('[data-entry-id="actor-valeros"] [data-entry-import]').click();
  await page.click('[data-tab="actors"]');
  await page
    .locator("#sheet-list .sheet-row")
    .filter({ hasText: "Valeros" })
    .click();

  // Open character sheet in floating window so it stays mounted while viewing chat
  await page.click("[data-open-pf1e-sheet]");
  const sheet = page.locator(".wm-window [data-pf1e-sheet]");
  await expect(sheet).toBeVisible();

  // 1. Verify Character Builder Modal (Standard + Free-Form Modes + Search)
  await sheet.locator('[data-open-builder]').click();
  const builderModal = page.locator('.builder-modal');
  await expect(builderModal).toBeVisible();

  // Select race and class
  await builderModal.locator('label:has-text("Race") select').selectOption("elf");
  await builderModal.locator('label:has-text("Class") select').selectOption("fighter");

  // Verify point-buy points calculate with starting 10s
  await expect(builderModal.locator('.pointbuy-status')).toContainText("Spent: 0 / 15 pts");

  // Adjust an ability (increase STR input to 14)
  const strInput = builderModal.locator('.ability-card').first().locator('input[type="number"]');
  await strInput.fill("14");
  await expect(builderModal.locator('.pointbuy-status')).toContainText("Spent: 5 / 15 pts");

  // Verify search for feats/spells inside builder
  const searchInput = builderModal.locator('[data-builder-search]');
  await searchInput.fill("Cleave");
  await expect(builderModal.locator('.compendium-hit-row')).toContainText("Cleave");
  // Add Cleave feat
  await builderModal.locator('[data-add-hit]').first().click();
  await expect(builderModal.locator('.selected-col').first()).toContainText("Cleave");

  // Test Free-Form Mode tab
  await builderModal.locator('[data-freeform-tab]').click();
  await expect(builderModal).toContainText("Free-Form Character Details");
  // Set custom race and class
  await builderModal.locator('input[placeholder*="Aasimar"]').fill("Tiefling Custom");
  await builderModal.locator('input[placeholder*="Magus"]').fill("Eldritch Knight");

  // Take screenshot of character builder with free-form and search results
  await page.screenshot({ path: "test-results/character-builder-screenshot.png" });

  // Apply build
  await builderModal.locator('button.apply-btn').click();
  await expect(builderModal).not.toBeVisible();

  // Verify sheet updated with changes
  await expect(sheet.locator('header span')).toContainText("HD 1");

  // 2. Verify Skills Tab functionality
  await sheet.locator('nav button:has-text("skills")').click();
  const skillsTab = sheet.locator('[data-pf1e-skills-tab]');
  await expect(skillsTab).toBeVisible();

  // Check Perception row (trained + class skill)
  const perceptionRow = skillsTab.locator('[data-skill-row="perception"]');
  await expect(perceptionRow).toBeVisible();
  // Perception with 1 rank, class skill (+3), wis mod (+0 from 10 WIS) = +4
  await expect(perceptionRow.locator('[data-skill-total="perception"]')).toContainText("+4");

  // Test skill filter search
  const skillSearch = skillsTab.locator('input[type="search"]');
  await skillSearch.fill("Perception");
  await expect(perceptionRow).toBeVisible();
  await expect(skillsTab.locator('[data-skill-row="acrobatics"]')).not.toBeVisible();
  await skillSearch.fill(""); // Clear search filter
  await expect(skillsTab.locator('[data-skill-row="acrobatics"]')).toBeVisible();

  // Test skill filter tabs: 'Trained' filter should show perception but not untrained acrobatics
  await skillsTab.locator('.filter-buttons button:has-text("Trained")').click();
  await expect(perceptionRow).toBeVisible();
  await expect(skillsTab.locator('[data-skill-row="acrobatics"]')).not.toBeVisible();
  await skillsTab.locator('.filter-buttons button:has-text("All")').click();

  // Switch sidebar to chat
  await page.click('[data-tab="chat"]');
  const chat = page.locator("#chat-log .rollcard");

  // Test skill roll action
  await perceptionRow.locator('[data-skill-roll="perception"]').click();

  // Verify chat received skill roll card with flavor
  await expect(chat).toHaveCount(1);
  await expect(chat.first().locator(".flavor")).toContainText("Perception");

  // Switch back to actors tab and sheet
  await page.click('[data-tab="actors"]');

  // 3. Verify Compendium Feat Picker Modal with search
  await sheet.locator('nav button:has-text("features")').click();
  // Verify Cleave added from builder is present
  await expect(sheet.locator('[data-pf1e-detail="feats"]')).toHaveValue(/Cleave/);

  await sheet.locator('[data-browse-compendium-feats]').click();
  const pickerModal = page.locator('.compendium-picker-window');
  await expect(pickerModal).toBeVisible();
  await expect(pickerModal.locator('.picker-header')).toContainText("feat");

  // Test search in compendium picker
  const pickerSearch = pickerModal.locator('[data-picker-search]');
  await pickerSearch.fill("Power");
  await expect(pickerModal.locator('.result-row')).toHaveCount(1);
  await expect(pickerModal.locator('.result-row')).toContainText("Power Attack");

  // Add Power Attack
  await pickerModal.locator('[data-add-compendium-entry]').click();
  await expect(pickerModal).not.toBeVisible();

  // Verify Power Attack was added to feats
  await expect(sheet.locator('[data-pf1e-detail="feats"]')).toHaveValue(/Power Attack/);

  expect(runtimeErrors).toEqual([]);
});
