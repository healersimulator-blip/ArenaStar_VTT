/**
 * Plan §3.2 acceptance (G-08, D-267) — *"pasted text → bestiary actor through the existing actor
 * shape"*: the GM pastes a monster stat block into the Sheets panel's Actors tab, reads the report
 * at the place where they ran it, and then **plays the creature** — the sheet shows the printed
 * attack lines and the printed AC and saves, because the import authored the totals the block
 * publishes with `acMode: "published"` and `savesAsTotal` rather than letting the derivation add a
 * Dexterity modifier the block already counted.
 *
 * The block is the SRD's **Goblin Warrior** (Bestiary 1), pasted as a person copies it — section
 * headings, `;`-separated clauses, prose lines — so the spec keeps passing only while the reader
 * reads the *printed format* and not one site's quirks. The refused paste is a paragraph that
 * merely mentions `AC 15`: a stat block is recognised by its labels, and something that is not one
 * must not become an actor.
 */
import { expect, test, type Page } from "@playwright/test";
import { entry, surfaceCallArg, waitForSurface } from "./lib";

const GOBLIN = `Goblin Warrior CR 1/3
XP 135
Goblin warrior 1
NE Small humanoid (goblinoid)
Init +6; Senses darkvision 60 ft.; Perception -1

DEFENSE

AC 16, touch 13, flat-footed 14 (+2 armor, +2 Dex, +1 shield, +1 size)
hp 6 (1d10+1)
Fort +3, Ref +4, Will -1

OFFENSE

Speed 30 ft.
Melee short sword +2 (1d4/19-20)
Ranged short bow +4 (1d4/×3)

STATISTICS

Str 11, Dex 15, Con 12, Int 10, Wis 9, Cha 6
Base Atk +1; CMB +1; CMD 12
Feats Improved Initiative
Skills Ride +6, Stealth +10; Racial Modifiers +4 Ride, +4 Stealth
Languages Goblin
SQ darkvision 60 ft.

ECOLOGY

Environment temperate forest and plains (usually coastal regions)
Organization gang (4–9), warband (10–16 with goblin dogs), or tribe (17+)
Treasure NPC gear (leather armor, light wooden shield, short sword, short bow with 20 arrows)`;

/** Paste text the way a person does: open the panel, type, submit. */
async function paste(page: Page, text: string): Promise<void> {
  await page.locator("[data-import-paste-trigger]").click();
  const box = page.locator("[data-import-paste]");
  await expect(box).toBeVisible();
  await box.fill(text);
  await page.locator("[data-import-paste-run]").click();
  await expect(page.locator("[data-import-report]")).toBeVisible();
}

test("§3.2 acceptance — a pasted stat block becomes a playable bestiary actor", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));

  await page.goto(entry + "?e2e=1");
  await waitForSurface(page, "app");
  await page.click('[data-tab="actors"]');

  const rowsBefore = await page.locator("#sheet-list .sheet-row").count();
  await paste(page, GOBLIN);

  // ── the report the GM reads ─────────────────────────────────────────────────────────────
  const report = page.locator("[data-import-report]");
  await expect(report).toHaveAttribute("data-import-ok", "true");
  await expect(report.locator(".import-head")).toHaveText(
    /Imported Goblin Warrior \(stat block\)/,
  );
  await expect(
    report.locator(".import-line").filter({ hasText: "hit points: 6 (1 Hit Dice)" }),
  ).toHaveCount(1);
  await expect(
    report
      .locator(".import-line")
      .filter({ hasText: "armor class: 16, touch 13, flat-footed 14 (published totals)" }),
  ).toHaveCount(1);
  // What the app derives is refused in the source's own words, and named where the GM can read it.
  const warnings = (await report.locator("[data-import-warning]").allTextContents()).join("\n");
  expect(warnings).toContain('printed attack bonus on "short sword" (+2)');
  expect(warnings).toContain("skill totals were not imported (Ride +6, Stealth +10");
  expect(warnings).toContain("XP was not placed (135)");

  // ── what was authored ───────────────────────────────────────────────────────────────────
  const row = page.locator("#sheet-list .sheet-row").filter({ hasText: "Goblin Warrior" });
  await expect(row).toHaveCount(1);
  const id = await row.getAttribute("data-doc-id");
  if (id === null) throw new Error("the imported row carries no document id");
  const system = await surfaceCallArg<Record<string, unknown> | null>(
    page,
    "app",
    "pf1eActorSystem",
    id,
  );
  expect(system).toMatchObject({
    size: "Small",
    abilities: { str: 11, dex: 15, con: 12, int: 10, wis: 9, cha: 6 },
    acTotals: { normal: 16, touch: 13, flatFooted: 14 },
    acMode: "published",
    saves: { fort: 3, ref: 4, will: -1 },
    savesAsTotal: true,
    hp: 6,
    hpMax: 6,
    hitDice: 1,
    baseAttack: 1,
    cmb: 1,
    cmd: 12,
    speedFt: 30,
    initiative: 4,
    feats: ["Improved Initiative"],
    creature: {
      cr: "1/3",
      alignment: "NE",
      type: "humanoid (goblinoid)",
      senses: "darkvision 60 ft.",
      languages: "Goblin",
    },
  });
  const attacks = (system?.attacks ?? []) as Array<Record<string, unknown>>;
  expect(attacks.map((a) => a.name)).toEqual(["short sword", "short bow"]);
  expect(attacks[0]).toMatchObject({ damageDice: "1d4", critThreatMin: 19 });
  expect(attacks[1]).toMatchObject({ ranged: true, damageDice: "1d4", critMultiplier: 3 });
  // No component was invented from the printed breakdown, and the flat stat-block spelling the
  // shipped profile adapter keys on (`ac`) is not written either — this is a sheet, not a profile.
  expect(system?.armorClass).toBeUndefined();
  expect(system?.ac).toBeUndefined();

  // ── and it is playable in the UI ────────────────────────────────────────────────────────
  await row.click();
  await page.click("[data-open-pf1e-sheet]");
  const sheet = page.locator(".wm-window [data-pf1e-sheet]");
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "summary", exact: true }).click();
  // The printed totals stand: the published AC is not recomposed from components the block never
  // stated, and the saves are the block's own, not Con/Dex-derived ones.
  await expect(sheet.locator("[data-pf1e-ac]")).toHaveText("16 / 13 / 14");
  await expect(sheet.locator("[data-pf1e-saves]")).toHaveText("3 / 4 / -1");
  await sheet.getByRole("button", { name: "combat", exact: true }).click();
  await expect(sheet.locator("[data-pf1e-attack]")).toHaveCount(2);
  await expect(sheet.locator("[data-pf1e-attack]").first()).toContainText("short sword");
  await page
    .locator(".wm-window")
    .filter({ has: page.locator("[data-pf1e-sheet]") })
    .locator("[data-window-close]")
    .click();
  await page.locator("[data-import-dismiss]").click();
  await expect(page.locator("[data-import-report]")).toHaveCount(0);

  // ── prose is not a stat block, and creates nothing ──────────────────────────────────────
  await paste(page, "my notes: the goblin had AC 15 and I rolled a 12 on the stealth check");
  await expect(report).toHaveAttribute("data-import-ok", "false");
  await expect(report.locator(".import-head")).toHaveText(/Could not import/);
  await expect(report.locator("[data-import-warning]")).toContainText(
    "expected a Foundry PF1e actor JSON",
  );
  await expect(page.locator("#sheet-list .sheet-row")).toHaveCount(rowsBefore + 1);

  expect(runtimeErrors).toEqual([]);
});
